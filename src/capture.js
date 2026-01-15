import * as THREE from "three";

function createProgram(gl, vertexSource, fragmentSource) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(info || "Shader compile failed");
    }
    return shader;
  };

  const program = gl.createProgram();
  const vertexShader = compile(gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(info || "Program link failed");
  }
  return program;
}

function createCameraPipeline(gl) {
  const isWebGL2 =
    typeof WebGL2RenderingContext !== "undefined" &&
    gl instanceof WebGL2RenderingContext;
  if (!isWebGL2) {
    throw new Error("WebGL2 is required for camera-access capture.");
  }

  const externalExt = gl.getExtension("OES_EGL_image_external_essl3");
  if (!externalExt) {
    throw new Error("OES_EGL_image_external_essl3 is required.");
  }

  const quadData = new Float32Array([
    -1, -1, 0, 0,
    1, -1, 1, 0,
    -1, 1, 0, 1,
    1, 1, 1, 1,
  ]);

  const vertexSource = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  v_texCoord = a_texCoord;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

  const fragmentSource = `#version 300 es
#extension GL_OES_EGL_image_external_essl3 : require
precision mediump float;
in vec2 v_texCoord;
uniform samplerExternalOES u_camera;
out vec4 outColor;
void main() {
  outColor = texture(u_camera, v_texCoord);
}`;

  const program = createProgram(gl, vertexSource, fragmentSource);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);

  return {
    program,
    buffer,
    attribs: {
      position: gl.getAttribLocation(program, "a_position"),
      texCoord: gl.getAttribLocation(program, "a_texCoord"),
    },
    uniforms: {
      camera: gl.getUniformLocation(program, "u_camera"),
    },
    framebuffer: gl.createFramebuffer(),
    outputTexture: gl.createTexture(),
    width: 0,
    height: 0,
  };
}

function ensureCameraTarget(gl, pipeline, width, height) {
  if (pipeline.width === width && pipeline.height === height) {
    return;
  }

  pipeline.width = width;
  pipeline.height = height;

  gl.bindTexture(gl.TEXTURE_2D, pipeline.outputTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );

  gl.bindFramebuffer(gl.FRAMEBUFFER, pipeline.framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    pipeline.outputTexture,
    0
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function pixelsToCanvas(pixels, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const rowSize = width * 4;
  const flipped = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < height; y++) {
    const src = y * rowSize;
    const dest = (height - 1 - y) * rowSize;
    flipped.set(pixels.subarray(src, src + rowSize), dest);
  }

  const imageData = new ImageData(flipped, width, height);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function downloadDataUrl(dataUrl) {
  const a = document.createElement("a");
  const canDownload = "download" in a;

  if (canDownload) {
    a.href = dataUrl;
    a.download = `measure-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } else {
    window.open(dataUrl, "_blank");
  }
}

export function createCaptureManager({ renderer, baseCamera, scene }) {
  const gl = renderer.getContext();
  const pipeline = createCameraPipeline(gl);
  let xrBinding = null;
  let overlayTarget = null;
  let captureRequested = false;

  function captureOverlayPixels(width, height) {
    if (!overlayTarget) {
      overlayTarget = new THREE.WebGLRenderTarget(width, height, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
      });
    }
    if (overlayTarget.width !== width || overlayTarget.height !== height) {
      overlayTarget.setSize(width, height);
    }

    const xrCamera = renderer.xr.getCamera(baseCamera);
    const prevXrEnabled = renderer.xr.enabled;
    const prevAutoClear = renderer.autoClear;

    renderer.xr.enabled = false;
    renderer.autoClear = true;
    renderer.setRenderTarget(overlayTarget);
    renderer.clear(true, true, true);
    renderer.render(scene, xrCamera);
    renderer.setRenderTarget(null);
    renderer.xr.enabled = prevXrEnabled;
    renderer.autoClear = prevAutoClear;

    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(overlayTarget, 0, 0, width, height, pixels);
    return pixels;
  }

  function captureComposite(frame) {
    if (!xrBinding || !frame) {
      return;
    }

    const referenceSpace = renderer.xr.getReferenceSpace();
    const pose = frame.getViewerPose(referenceSpace);
    if (!pose || !pose.views.length || !pose.views[0].camera) {
      return;
    }

    const xrCamera = pose.views[0].camera;
    const cameraWidth = xrCamera.width;
    const cameraHeight = xrCamera.height;
    if (!cameraWidth || !cameraHeight) {
      return;
    }

    ensureCameraTarget(gl, pipeline, cameraWidth, cameraHeight);

    const cameraTexture = xrBinding.getCameraImage(xrCamera);
    if (!cameraTexture) {
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, pipeline.framebuffer);
    gl.viewport(0, 0, pipeline.width, pipeline.height);
    gl.useProgram(pipeline.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, pipeline.buffer);

    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(pipeline.attribs.position);
    gl.vertexAttribPointer(
      pipeline.attribs.position,
      2,
      gl.FLOAT,
      false,
      stride,
      0
    );
    gl.enableVertexAttribArray(pipeline.attribs.texCoord);
    gl.vertexAttribPointer(
      pipeline.attribs.texCoord,
      2,
      gl.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT
    );

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_EXTERNAL_OES, cameraTexture);
    gl.uniform1i(pipeline.uniforms.camera, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const cameraPixels = new Uint8Array(
      pipeline.width * pipeline.height * 4
    );
    gl.readPixels(
      0,
      0,
      pipeline.width,
      pipeline.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      cameraPixels
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (renderer.resetState) {
      renderer.resetState();
    }

    const overlayPixels = captureOverlayPixels(
      pipeline.width,
      pipeline.height
    );
    const cameraCanvas = pixelsToCanvas(
      cameraPixels,
      pipeline.width,
      pipeline.height
    );
    const overlayCanvas = pixelsToCanvas(
      overlayPixels,
      pipeline.width,
      pipeline.height
    );

    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = renderer.domElement.width;
    outputCanvas.height = renderer.domElement.height;
    const outputCtx = outputCanvas.getContext("2d");
    outputCtx.drawImage(
      cameraCanvas,
      0,
      0,
      outputCanvas.width,
      outputCanvas.height
    );
    outputCtx.drawImage(
      overlayCanvas,
      0,
      0,
      outputCanvas.width,
      outputCanvas.height
    );

    downloadDataUrl(outputCanvas.toDataURL("image/png"));
  }

  function onSessionStart() {
    const session = renderer.xr.getSession();
    if (typeof XRWebGLBinding !== "undefined" && session) {
      xrBinding = new XRWebGLBinding(session, gl);
    }
  }

  function onSessionEnd() {
    xrBinding = null;
  }

  function requestCapture() {
    captureRequested = true;
  }

  function handleFrame(frame) {
    if (!captureRequested) return;
    captureRequested = false;
    captureComposite(frame);
  }

  return {
    onSessionStart,
    onSessionEnd,
    requestCapture,
    handleFrame,
  };
}
