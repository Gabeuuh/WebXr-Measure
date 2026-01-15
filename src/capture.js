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
  const extEssl3 = gl.getExtension("OES_EGL_image_external_essl3");
  const ext = extEssl3 || gl.getExtension("OES_EGL_image_external");
  if (!ext) {
    return null;
  }

  const quadData = new Float32Array([
    -1, -1, 0, 0,
    1, -1, 1, 0,
    -1, 1, 0, 1,
    1, 1, 1, 1,
  ]);

  const vertexSource = extEssl3
    ? `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  v_texCoord = a_texCoord;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`
    : `attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;
void main() {
  v_texCoord = a_texCoord;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

  const fragmentSource = extEssl3
    ? `#version 300 es
#extension GL_OES_EGL_image_external_essl3 : require
precision mediump float;
in vec2 v_texCoord;
uniform samplerExternalOES u_camera;
out vec4 outColor;
void main() {
  outColor = texture(u_camera, v_texCoord);
}`
    : `#extension GL_OES_EGL_image_external : require
precision mediump float;
varying vec2 v_texCoord;
uniform samplerExternalOES u_camera;
void main() {
  gl_FragColor = texture2D(u_camera, v_texCoord);
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
    textureTarget: ext.TEXTURE_EXTERNAL_OES,
  };
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
  let captureRequested = false;

  function captureComposite(frame) {
    if (!pipeline || !xrBinding || !frame) {
      return;
    }

    const session = renderer.xr.getSession();
    const baseLayer = session && session.renderState.baseLayer;
    if (!baseLayer) {
      return;
    }

    const referenceSpace = renderer.xr.getReferenceSpace();
    const pose = frame.getViewerPose(referenceSpace);
    if (!pose || !pose.views.length) {
      return;
    }

    const view = pose.views[0];
    const camera = view.camera;
    if (!camera) {
      return;
    }

    const cameraTexture = xrBinding.getCameraImage(camera);
    if (!cameraTexture) {
      return;
    }

    const width = baseLayer.framebufferWidth;
    const height = baseLayer.framebufferHeight;

    gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
    gl.viewport(0, 0, width, height);
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
    gl.bindTexture(pipeline.textureTarget, cameraTexture);
    gl.uniform1i(pipeline.uniforms.camera, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, baseCamera);
    renderer.autoClear = prevAutoClear;

    gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (renderer.resetState) {
      renderer.resetState();
    }

    const outputCanvas = pixelsToCanvas(pixels, width, height);
    downloadDataUrl(outputCanvas.toDataURL("image/png"));
  }

  function onSessionStart() {
    if (!pipeline) {
      return;
    }
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
