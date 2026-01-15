import * as THREE from "three";

// Shader optimisé pour gérer la matrice de transformation de la caméra
const vertexSource = `#version 300 es
  in vec2 a_position;
  in vec2 a_texCoord;
  uniform mat3 u_uvMatrix;
  out vec2 v_texCoord;
  void main() {
    // On applique la matrice de transformation aux UV pour gérer l'orientation
    v_texCoord = (u_uvMatrix * vec3(a_texCoord, 1.0)).xy;
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

function createProgram(gl, vsSource, fsSource) {
  const loadShader = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, loadShader(gl.VERTEX_SHADER, vsSource));
  gl.attachShader(program, loadShader(gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(program);
  return program;
}

export function createCaptureManager({ renderer, scene, baseCamera }) {
  const gl = renderer.getContext();
  let pipeline = null;
  let xrBinding = null;
  let captureRequested = false;

  function initPipeline() {
    const program = createProgram(gl, vertexSource, fragmentSource);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // On définit un carré plein (Quad)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    pipeline = {
      program,
      buffer,
      attribs: {
        pos: gl.getAttribLocation(program, "a_position"),
        uv: gl.getAttribLocation(program, "a_texCoord"),
      },
      uniforms: {
        camera: gl.getUniformLocation(program, "u_camera"),
        uvMatrix: gl.getUniformLocation(program, "u_uvMatrix"),
      },
    };
  }

  function captureComposite(frame) {
    const session = frame.session;
    const baseLayer = session.renderState.baseLayer;
    const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());

    if (!pose || !xrBinding || !pipeline) return;

    // On récupère la vue et la caméra XR
    const view = pose.views[0];
    const camera = view.camera;
    if (!camera) return;

    const cameraTexture = xrBinding.getCameraImage(camera);
    const width = baseLayer.framebufferWidth;
    const height = baseLayer.framebufferHeight;

    // 1. Préparer le rendu sur le framebuffer de l'XR
    gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
    gl.viewport(0, 0, width, height);

    // 2. Dessiner le flux vidéo (Background)
    gl.useProgram(pipeline.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, pipeline.buffer);

    gl.enableVertexAttribArray(pipeline.attribs.pos);
    gl.vertexAttribPointer(pipeline.attribs.pos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(pipeline.attribs.uv);
    gl.vertexAttribPointer(pipeline.attribs.uv, 2, gl.FLOAT, false, 16, 8);

    // Récupération de la matrice de texture (essentiel pour l'orientation)
    const textureMatrix =
      frame.fillHorizontalRectangularViewportSecondaryVideoTransform
        ? frame.fillHorizontalRectangularViewportSecondaryVideoTransform
        : new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    // Note: Dans les versions récentes, on utilise souvent une matrice identité
    // ou on la calcule via les camera.width/height.
    // Pour WebXR Raw Camera, la matrice est souvent passée via WebGL.
    gl.uniformMatrix3fv(
      pipeline.uniforms.uvMatrix,
      false,
      [1, 0, 0, 0, 1, 0, 0, 0, 1]
    );

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_EXTERNAL_OES, cameraTexture);
    gl.uniform1i(pipeline.uniforms.camera, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3. Dessiner la scène Three.js par-dessus
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, baseCamera);
    renderer.autoClear = prevAutoClear;

    // 4. Lecture des pixels
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // 5. Conversion et téléchargement
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = new ImageData(
      new Uint8ClampedArray(pixels),
      width,
      height
    );

    // Inverser verticalement (WebGL -> Canvas)
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = width;
    tempCanvas.height = height;
    tempCanvas.getContext("2d").putImageData(imageData, 0, 0);

    ctx.scale(1, -1);
    ctx.drawImage(tempCanvas, 0, -height);

    const link = document.createElement("a");
    link.download = `mesure-${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
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
