import * as THREE from "three";

const vertexShader = `#version 300 es
  layout(location = 0) in vec2 position;
  layout(location = 1) in vec2 uv;
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
    // Note: Pas d'inversion ici, on gère l'orientation dans les vertices
    outColor = texture(uCameraTexture, vUv);
  }`;

export function createCaptureManager({ renderer, scene }) {
  const gl = renderer.getContext();
  let xrBinding = null;
  let pipeline = null;
  let captureRequested = false;
  let renderTarget = null;

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

    // On définit les UVs pour que l'image soit dans le bon sens (WebGL vs Texture)
    const vertices = new Float32Array([
      -1,
      -1,
      0,
      1, // Bas-Gauche (UV inversé en Y)
      1,
      -1,
      1,
      1, // Bas-Droite
      -1,
      1,
      0,
      0, // Haut-Gauche
      1,
      1,
      1,
      0, // Haut-Droite
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
    if (!cameraTexture) {
      console.error("Impossible d'accéder à la texture caméra.");
      return;
    }

    const width = view.viewport.width;
    const height = view.viewport.height;

    // Créer ou redimensionner le Target de capture si besoin
    if (!renderTarget || renderTarget.width !== width) {
      renderTarget = new THREE.WebGLRenderTarget(width, height);
    }

    // --- ÉTAPE 1 : Reset de l'état Three.js ---
    renderer.state.reset();

    // --- ÉTAPE 2 : Dessiner le fond (Caméra) ---
    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      renderer.properties.get(renderTarget).__webglFramebuffer
    );
    gl.viewport(0, 0, width, height);

    gl.useProgram(pipeline.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, pipeline.buffer);

    gl.enableVertexAttribArray(0); // position
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); // uv
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_EXTERNAL_OES, cameraTexture);
    gl.uniform1i(gl.getUniformLocation(pipeline.program, "uCameraTexture"), 0);

    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- ÉTAPE 3 : Dessiner les annotations ---
    // On utilise la caméra XR de Three.js qui contient les bonnes matrices
    const xrCamera = renderer.xr.getCamera();

    renderer.setRenderTarget(renderTarget);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, xrCamera);
    renderer.setRenderTarget(null);

    // --- ÉTAPE 4 : Lecture et Sauvegarde ---
    const pixels = new Uint8Array(width * height * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    saveImage(pixels, width, height);

    // Restaurer l'état pour le rendu normal de la boucle Three.js
    renderer.autoClear = true;
    renderer.state.reset();
  }

  function saveImage(pixels, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);

    const link = document.createElement("a");
    link.download = `mesure-ar-${Date.now()}.png`;
    link.href = canvas.toDataURL();
    link.click();
  }

  return {
    onSessionStart: () => {
      initPipeline();
      const session = renderer.xr.getSession();
      xrBinding = new XRWebGLBinding(session, gl);
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
