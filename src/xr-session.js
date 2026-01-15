import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { BufferGeometryUtils } from "three/examples/jsm/utils/BufferGeometryUtils.js";

let container, labelContainer;
let camera, scene, renderer, light;
let controller;
let xrSession = null;
let xrBinding = null;
let gl = null;

let hitTestSource = null;
let hitTestSourceRequested = false;

let measurements = [];
let labels = [];

let reticle;
let currentLine = null;

let width, height;
let captureRequested = false;
let capturePipeline = null;
let cameraCaptureCanvas = null;
let cameraCaptureCtx = null;
let overlayTarget = null;
let overlayCaptureCanvas = null;
let overlayCaptureCtx = null;
let compositeCanvas = null;
let compositeCtx = null;

function toScreenPosition(point, camera) {
  var vector = new THREE.Vector3();

  vector.copy(point);
  vector.project(camera);

  vector.x = ((vector.x + 1) * width) / 2;
  vector.y = ((-vector.y + 1) * height) / 2;
  vector.z = 0;

  return vector;
}

function getCenterPoint(points) {
  let line = new THREE.Line3(...points);
  return line.getCenter();
}

function matrixToVector(matrix) {
  let vector = new THREE.Vector3();
  vector.setFromMatrixPosition(matrix);
  return vector;
}

function createLabelSprite(message) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  const fontSize = 64;
  ctx.font = `${fontSize}px sans-serif`;
  const textWidth = ctx.measureText(message).width;

  canvas.width = textWidth + fontSize;
  canvas.height = fontSize * 1.6;

  ctx.font = `${fontSize}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  const radius = fontSize * 0.4;
  const w = canvas.width;
  const h = canvas.height;

  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(w - radius, 0);
  ctx.quadraticCurveTo(w, 0, w, radius);
  ctx.lineTo(w, h - radius);
  ctx.quadraticCurveTo(w, h, w - radius, h);
  ctx.lineTo(radius, h);
  ctx.quadraticCurveTo(0, h, 0, h - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "white";
  ctx.fillText(message, w / 2, h / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
  });

  const sprite = new THREE.Sprite(material);

  const scale = 0.06;
  const aspect = w / h;
  sprite.scale.set(scale * aspect, scale, 1);

  return sprite;
}

function initLine(point) {
  const radius = 0.003;
  const height = 1;

  const geometry = new THREE.CylinderBufferGeometry(radius, radius, height, 8);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });

  const cylinder = new THREE.Mesh(geometry, material);

  cylinder.visible = true;

  return cylinder;
}

function updateLine(matrix) {
  if (!currentLine || measurements.length === 0) return;

  const start = measurements[0];

  const end = new THREE.Vector3(
    matrix.elements[12],
    matrix.elements[13],
    matrix.elements[14]
  );

  const dir = new THREE.Vector3().subVectors(end, start);
  const length = dir.length();
  if (length === 0) return;

  const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  currentLine.position.copy(mid);

  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(
    up,
    dir.clone().normalize()
  );
  currentLine.setRotationFromQuaternion(quat);

  currentLine.scale.set(1, length, 1);

  currentLine.updateMatrixWorld();
}

function initReticle() {
  let ring = new THREE.RingBufferGeometry(0.045, 0.05, 32).rotateX(
    -Math.PI / 2
  );
  let dot = new THREE.CircleBufferGeometry(0.005, 32).rotateX(-Math.PI / 2);
  reticle = new THREE.Mesh(
    BufferGeometryUtils.mergeBufferGeometries([ring, dot]),
    new THREE.MeshBasicMaterial()
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
}

function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.setClearColor(0x000000, 0);
  gl = renderer.getContext();
}

function initLabelContainer() {
  labelContainer = document.createElement("div");
  labelContainer.style.position = "absolute";
  labelContainer.style.top = "0px";
  labelContainer.style.pointerEvents = "auto";
  labelContainer.setAttribute("id", "container");
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(info || "Shader compile failed");
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
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

function createCapturePipeline(gl) {
  const isWebGL2 =
    typeof WebGL2RenderingContext !== "undefined" &&
    gl instanceof WebGL2RenderingContext;
  const externalExt = gl.getExtension(
    isWebGL2 ? "OES_EGL_image_external_essl3" : "OES_EGL_image_external"
  );
  const useExternal = Boolean(externalExt);
  const externalTarget =
    gl.TEXTURE_EXTERNAL_OES ||
    (externalExt && externalExt.TEXTURE_EXTERNAL_OES);

  const quadData = new Float32Array([
    -1, -1, 0, 0,
    1, -1, 1, 0,
    -1, 1, 0, 1,
    1, 1, 1, 1,
  ]);

  const vertexSource = isWebGL2
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

  const fragmentSource = isWebGL2
    ? `#version 300 es
${useExternal ? "#extension GL_OES_EGL_image_external_essl3 : require" : ""}
precision mediump float;
in vec2 v_texCoord;
uniform ${useExternal ? "samplerExternalOES" : "sampler2D"} u_camera;
out vec4 outColor;
void main() {
  outColor = texture(u_camera, v_texCoord);
}`
    : `${useExternal ? "#extension GL_OES_EGL_image_external : require" : ""}
precision mediump float;
varying vec2 v_texCoord;
uniform ${useExternal ? "samplerExternalOES" : "sampler2D"} u_camera;
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
    framebuffer: gl.createFramebuffer(),
    outputTexture: gl.createTexture(),
    textureTarget: useExternal && externalTarget ? externalTarget : gl.TEXTURE_2D,
    width: 0,
    height: 0,
  };
}

function ensureCaptureTarget(gl, pipeline, width, height) {
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

function flipPixelData(pixels, width, height) {
  const rowSize = width * 4;
  const flipped = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < height; y++) {
    const src = y * rowSize;
    const dest = (height - 1 - y) * rowSize;
    flipped.set(pixels.subarray(src, src + rowSize), dest);
  }
  return flipped;
}

function getCameraCanvas(width, height, pixels) {
  if (!cameraCaptureCanvas) {
    cameraCaptureCanvas = document.createElement("canvas");
    cameraCaptureCtx = cameraCaptureCanvas.getContext("2d");
  }
  if (
    cameraCaptureCanvas.width !== width ||
    cameraCaptureCanvas.height !== height
  ) {
    cameraCaptureCanvas.width = width;
    cameraCaptureCanvas.height = height;
  }

  const imageData = new ImageData(
    flipPixelData(pixels, width, height),
    width,
    height
  );
  cameraCaptureCtx.putImageData(imageData, 0, 0);
  return cameraCaptureCanvas;
}

function ensureOverlayTarget(width, height) {
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
}

function captureOverlayPixels(width, height) {
  ensureOverlayTarget(width, height);

  const xrCamera = renderer.xr.getCamera(camera);
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

function getOverlayCanvas(width, height, pixels) {
  if (!overlayCaptureCanvas) {
    overlayCaptureCanvas = document.createElement("canvas");
    overlayCaptureCtx = overlayCaptureCanvas.getContext("2d");
  }
  if (
    overlayCaptureCanvas.width !== width ||
    overlayCaptureCanvas.height !== height
  ) {
    overlayCaptureCanvas.width = width;
    overlayCaptureCanvas.height = height;
  }

  const imageData = new ImageData(
    flipPixelData(pixels, width, height),
    width,
    height
  );
  overlayCaptureCtx.putImageData(imageData, 0, 0);
  return overlayCaptureCanvas;
}

function getCompositeCanvas(width, height) {
  if (!compositeCanvas) {
    compositeCanvas = document.createElement("canvas");
    compositeCtx = compositeCanvas.getContext("2d");
  }
  if (compositeCanvas.width !== width || compositeCanvas.height !== height) {
    compositeCanvas.width = width;
    compositeCanvas.height = height;
  }
  return compositeCanvas;
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

function fallbackCapture() {
  const canvas = renderer.domElement;
  const dataUrl = canvas.toDataURL("image/png");
  downloadDataUrl(dataUrl);
}

function captureComposite(frame) {
  if (!frame || !xrBinding) {
    fallbackCapture();
    return;
  }

  const referenceSpace = renderer.xr.getReferenceSpace();
  const pose = frame.getViewerPose(referenceSpace);
  if (!pose || !pose.views.length || !pose.views[0].camera) {
    fallbackCapture();
    return;
  }

  const xrCamera = pose.views[0].camera;
  const cameraWidth = xrCamera.width;
  const cameraHeight = xrCamera.height;

  if (!cameraWidth || !cameraHeight) {
    fallbackCapture();
    return;
  }

  try {
    if (!capturePipeline) {
      capturePipeline = createCapturePipeline(gl);
    }
    ensureCaptureTarget(gl, capturePipeline, cameraWidth, cameraHeight);

    const cameraTexture = xrBinding.getCameraImage(xrCamera);
    if (!cameraTexture) {
      fallbackCapture();
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, capturePipeline.framebuffer);
    gl.viewport(0, 0, capturePipeline.width, capturePipeline.height);
    gl.useProgram(capturePipeline.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, capturePipeline.buffer);

    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(capturePipeline.attribs.position);
    gl.vertexAttribPointer(
      capturePipeline.attribs.position,
      2,
      gl.FLOAT,
      false,
      stride,
      0
    );
    gl.enableVertexAttribArray(capturePipeline.attribs.texCoord);
    gl.vertexAttribPointer(
      capturePipeline.attribs.texCoord,
      2,
      gl.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT
    );

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(capturePipeline.textureTarget, cameraTexture);
    gl.uniform1i(capturePipeline.uniforms.camera, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const pixels = new Uint8Array(
      capturePipeline.width * capturePipeline.height * 4
    );
    gl.readPixels(
      0,
      0,
      capturePipeline.width,
      capturePipeline.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels
    );

    gl.bindTexture(capturePipeline.textureTarget, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (renderer.resetState) {
      renderer.resetState();
    }

    const cameraCanvas = getCameraCanvas(
      capturePipeline.width,
      capturePipeline.height,
      pixels
    );

    let overlayCanvas = null;
    try {
      const overlayPixels = captureOverlayPixels(
        capturePipeline.width,
        capturePipeline.height
      );
      overlayCanvas = getOverlayCanvas(
        capturePipeline.width,
        capturePipeline.height,
        overlayPixels
      );
    } catch (err) {
      console.warn("Overlay capture failed, using canvas only.", err);
      overlayCanvas = renderer.domElement;
    }

    const outputCanvas = getCompositeCanvas(
      renderer.domElement.width,
      renderer.domElement.height
    );
    compositeCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
    compositeCtx.drawImage(
      cameraCanvas,
      0,
      0,
      outputCanvas.width,
      outputCanvas.height
    );
    if (overlayCanvas) {
      compositeCtx.drawImage(
        overlayCanvas,
        0,
        0,
        outputCanvas.width,
        outputCanvas.height
      );
    }

    downloadDataUrl(outputCanvas.toDataURL("image/png"));
  } catch (err) {
    console.error("AR capture failed, falling back to WebGL only.", err);
    fallbackCapture();
  }
}

function requestCapture() {
  if (captureRequested) return;
  captureRequested = true;
}

function initPhotoButton() {
  const btn = document.createElement("button");
  btn.id = "photo-btn";
  btn.type = "button";
  btn.textContent = " ";

  labelContainer.appendChild(btn);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();

    if (!renderer) return;

    requestCapture();
  });
  ["pointerdown", "touchstart"].forEach((evtName) => {
    btn.addEventListener(evtName, (e) => {
      e.stopPropagation();
    });
  });
}

function initCamera() {
  camera = new THREE.PerspectiveCamera(70, width / height, 0.01, 20);
}

function initLight() {
  light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  light.position.set(0.5, 1, 0.25);
}

function initScene() {
  scene = new THREE.Scene();
}

function getDistance(points) {
  if (points.length == 2) return points[0].distanceTo(points[1]);
}

function initXR() {
  container = document.createElement("div");
  document.body.appendChild(container);

  width = window.innerWidth;
  height = window.innerHeight;

  initScene();

  initCamera();

  initLight();
  scene.add(light);

  initRenderer();
  container.appendChild(renderer.domElement);

  initLabelContainer();
  container.appendChild(labelContainer);

  initPhotoButton();

  document.body.appendChild(
    ARButton.createButton(renderer, {
      optionalFeatures: ["dom-overlay", "camera-access"],
      domOverlay: { root: document.querySelector("#container") },
      requiredFeatures: ["hit-test"],
    })
  );

  renderer.xr.addEventListener("sessionstart", () => {
    xrSession = renderer.xr.getSession();
    if (typeof XRWebGLBinding !== "undefined" && gl) {
      xrBinding = new XRWebGLBinding(xrSession, gl);
    } else {
      xrBinding = null;
    }
  });

  renderer.xr.addEventListener("sessionend", () => {
    xrSession = null;
    xrBinding = null;
  });

  controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  scene.add(controller);

  initReticle();
  scene.add(reticle);

  window.addEventListener("resize", onWindowResize, false);
  animate();
}

function onSelect() {
  if (reticle.visible) {
    measurements.push(matrixToVector(reticle.matrix));
    if (measurements.length == 2) {
      let distance = Math.round(getDistance(measurements) * 100);
      const message = distance + " cm";

      const sprite = createLabelSprite(message);

      const center = getCenterPoint(measurements);

      const upOffset = new THREE.Vector3(0, 0.05, 0); // 5 cm au-dessus

      const cameraOffset = new THREE.Vector3();
      renderer.xr.getCamera(camera).getWorldDirection(cameraOffset);
      cameraOffset.multiplyScalar(-0.015); // 1.5 cm vers la camÃ©ra

      sprite.position.copy(center.clone().add(upOffset).add(cameraOffset));

      scene.add(sprite);
      labels.push(sprite);

      measurements = [];
      currentLine = null;
    } else {
      currentLine = initLine(measurements[0]);
      scene.add(currentLine);
    }
  }
}

function onWindowResize() {
  width = window.innerWidth;
  height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

function animate() {
  renderer.setAnimationLoop(render);
}

function render(timestamp, frame) {
  if (frame) {
    let referenceSpace = renderer.xr.getReferenceSpace();
    let session = renderer.xr.getSession();
    if (hitTestSourceRequested === false) {
      session.requestReferenceSpace("viewer").then(function (referenceSpace) {
        session
          .requestHitTestSource({ space: referenceSpace })
          .then(function (source) {
            hitTestSource = source;
          });
      });
      session.addEventListener("end", function () {
        hitTestSourceRequested = false;
        hitTestSource = null;
      });
      hitTestSourceRequested = true;
    }

    if (hitTestSource) {
      let hitTestResults = frame.getHitTestResults(hitTestSource);
      if (hitTestResults.length) {
        let hit = hitTestResults[0];
        reticle.visible = true;
        reticle.matrix.fromArray(hit.getPose(referenceSpace).transform.matrix);
      } else {
        reticle.visible = false;
      }

      if (currentLine) {
        updateLine(reticle.matrix);
      }
    }
  }
  renderer.render(scene, camera);
  if (captureRequested) {
    captureRequested = false;
    captureComposite(frame);
  }
}

export { initXR };

