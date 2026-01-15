import * as THREE from "three";

// Shaders pour dessiner la texture externe de la caméra
const vertexShader = `#version 300 es
  in vec2 position;
  in vec2 uv;
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }`;

const fragmentShader = `#version 300 es
  #extension GL_OES_EGL_image_external_essl3 : require
  precision mediump float;
  uniform samplerExternalOES uCameraTexture;
  in vec2 vUv;
  out vec4 outColor;
  void main() {
    // Note: On inverse l'axe Y car les textures WebXR sont souvent inversées
    outColor = texture(uCameraTexture, vec2(vUv.x, 1.0 - vUv.y));
  }`;

export function createCaptureManager({ renderer, scene, baseCamera }) {
  const gl = renderer.getContext();
  let xrBinding = null;
  let captureRequested = false;
  let pipeline = null;

  // Initialisation du programme de rendu "fond de caméra"
  function initPipeline() {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vertexShader);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragmentShader);
    gl.compileShader(fs);

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    const vertices = new Float32Array([
      -1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1,
    ]);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    pipeline = { program, buffer };
  }

  function captureComposite(frame) {
    const session = frame.session;
    const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
    if (!pose || !xrBinding || !pipeline) return;

    const view = pose.views[0];
    const cameraTexture = xrBinding.getCameraImage(view.camera);
    if (!cameraTexture) return;

    const baseLayer = session.renderState.baseLayer;
    const width = baseLayer.framebufferWidth;
    const height = baseLayer.framebufferHeight;

    // Étape A : Dessiner la caméra dans le framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.useProgram(pipeline.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, pipeline.buffer);

    const posLoc = gl.getAttribLocation(pipeline.program, "position");
    const uvLoc = gl.getAttribLocation(pipeline.program, "uv");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_EXTERNAL_OES, cameraTexture);
    gl.uniform1i(gl.getUniformLocation(pipeline.program, "uCameraTexture"), 0);

    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Étape B : Dessiner les annotations Three.js par-dessus
    const autoClear = renderer.autoClear;
    renderer.autoClear = false; // Ne pas effacer la vidéo qu'on vient de dessiner
    renderer.clearDepth(); // Effacer seulement la profondeur
    renderer.render(scene, baseCamera);
    renderer.autoClear = autoClear;

    // Étape C : Lire les pixels fusionnés
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // Conversion et téléchargement
    saveImage(pixels, width, height);
  }

  function saveImage(pixels, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);

    // Correction de l'inversion verticale WebGL
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const j = ((height - 1 - y) * width + x) * 4;
        imageData.data[i] = pixels[j];
        imageData.data[i + 1] = pixels[j + 1];
        imageData.data[i + 2] = pixels[j + 2];
        imageData.data[i + 3] = pixels[j + 3];
      }
    }
    ctx.putImageData(imageData, 0, 0);
    const link = document.createElement("a");
    link.download = `mesure-${Date.now()}.png`;
    link.href = canvas.toDataURL();
    link.click();
  }

  return {
    onSessionStart: () => {
      initPipeline();
      const session = renderer.xr.getSession();
      if (session) xrBinding = new XRWebGLBinding(session, gl);
    },
    onSessionEnd: () => {
      xrBinding = null;
    },
    requestCapture: () => {
      captureRequested = true;
    },
    handleFrame: (frame) => {
      if (captureRequested) {
        captureComposite(frame);
        captureRequested = false;
      }
    },
  };
}
