import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { createCaptureManager } from "./capture";

let camera,
  scene,
  renderer,
  reticle,
  hitTestSource = null;
let measurements = [];
let currentLine = null;
let captureManager;

export function initXR() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.01,
    20
  );

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  captureManager = createCaptureManager({ renderer, scene });

  // UI (Overlay) - pointer-events:none est CRUCIAL pour pouvoir cliquer au sol
  const ui = document.createElement("div");
  ui.id = "ui-overlay";
  ui.style.cssText =
    "position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:10;";
  document.body.appendChild(ui);

  const btn = document.createElement("button");
  btn.id = "photo-btn"; // Styles dans styles.css
  btn.style.pointerEvents = "auto";
  btn.onclick = (e) => {
    e.stopPropagation();
    captureManager.requestCapture();
  };
  ui.appendChild(btn);

  document.body.appendChild(
    ARButton.createButton(renderer, {
      requiredFeatures: ["hit-test", "camera-access"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: ui },
    })
  );

  initObjects();

  // RÉINTÉGRATION : Écouteur pour poser les points
  const controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  scene.add(controller);

  renderer.setAnimationLoop(render);
}

function render(timestamp, frame) {
  if (frame) {
    const session = renderer.xr.getSession();
    const referenceSpace = renderer.xr.getReferenceSpace();

    if (!hitTestSource) {
      session.requestReferenceSpace("viewer").then((space) => {
        session
          .requestHitTestSource({ space })
          .then((src) => (hitTestSource = src));
      });
    } else {
      const results = frame.getHitTestResults(hitTestSource);
      if (results.length) {
        reticle.visible = true;
        reticle.matrix.fromArray(
          results[0].getPose(referenceSpace).transform.matrix
        );
        // Mise à jour de la ligne "en élastique"
        if (currentLine) updateLine(reticle.matrix);
      } else {
        reticle.visible = false;
      }
    }
    captureManager.handleFrame(frame);
  }
  renderer.render(scene, camera);
}

function onSelect() {
  if (!reticle.visible) return;
  const pos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
  measurements.push(pos);

  if (measurements.length === 2) {
    // Calcul de la distance
    const dist = Math.round(measurements[0].distanceTo(measurements[1]) * 100);
    const sprite = createLabel(dist);
    const center = new THREE.Vector3()
      .addVectors(measurements[0], measurements[1])
      .multiplyScalar(0.5);
    sprite.position.copy(center).add(new THREE.Vector3(0, 0.05, 0));
    scene.add(sprite);

    measurements = [];
    currentLine = null;
  } else {
    // Début d'une nouvelle mesure
    currentLine = new THREE.Mesh(
      new THREE.CylinderGeometry(0.003, 0.003, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    scene.add(currentLine);
  }
}

function initObjects() {
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.04, 0.05, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial()
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1));
}

function createLabel(val) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return new THREE.Sprite();
  }

  const drawRoundedRect = (context, x, y, w, h, r) => {
    const radius = Math.min(r, w / 2, h / 2);
    context.beginPath();
    if (context.roundRect) {
      context.roundRect(x, y, w, h, radius);
    } else {
      context.moveTo(x + radius, y);
      context.lineTo(x + w - radius, y);
      context.quadraticCurveTo(x + w, y, x + w, y + radius);
      context.lineTo(x + w, y + h - radius);
      context.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      context.lineTo(x + radius, y + h);
      context.quadraticCurveTo(x, y + h, x, y + h - radius);
      context.lineTo(x, y + radius);
      context.quadraticCurveTo(x, y, x + radius, y);
    }
    context.closePath();
  };

  ctx.fillStyle = "rgba(0,0,0,0.7)";
  drawRoundedRect(ctx, 0, 0, canvas.width, canvas.height, 20);
  ctx.fill();
  ctx.font = "bold 60px Arial";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${val} cm`, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  material.needsUpdate = true;
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.1), material);
  label.onBeforeRender = (_renderer, _scene, cam) => {
    label.quaternion.copy(cam.quaternion);
  };
  return label;
}

function updateLine(matrix) {
  if (!currentLine || measurements.length === 0) return;
  const start = measurements[0];
  const end = new THREE.Vector3().setFromMatrixPosition(matrix);
  const dir = new THREE.Vector3().subVectors(end, start);
  currentLine.position.copy(start).add(dir.clone().multiplyScalar(0.5));
  currentLine.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize()
  );
  currentLine.scale.set(1, dir.length(), 1);
}
