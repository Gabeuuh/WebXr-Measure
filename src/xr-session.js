import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { BufferGeometryUtils } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createCaptureManager } from "./capture";

// Variables globales du moteur
let camera, scene, renderer, controller;
let captureManager = null;
let hitTestSource = null;
let hitTestSourceRequested = false;

// Variables de mesure
let measurements = [];
let reticle;
let currentLine = null;

/**
 * Initialisation principale de l'application XR
 */
export function initXR() {
  const container = document.createElement("div");
  document.body.appendChild(container);

  // 1. Scène et Caméra de base
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.01,
    20
  );

  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  light.position.set(0.5, 1, 0.25);
  scene.add(light);

  // 2. Renderer avec WebXR activé
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  container.appendChild(renderer.domElement);

  // 3. Manager de Capture (Logique Raw Camera Access / PR #31487)
  captureManager = createCaptureManager({ renderer, scene });

  // 4. Interface Utilisateur (DOM Overlay)
  const labelContainer = document.createElement("div");
  labelContainer.id = "container";
  container.appendChild(labelContainer);

  initPhotoButton(labelContainer);

  // 5. Configuration du Bouton AR avec accès caméra obligatoire
  document.body.appendChild(
    ARButton.createButton(renderer, {
      requiredFeatures: ["hit-test", "camera-access"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: labelContainer },
    })
  );

  // 6. Gestionnaires d'événements de session
  renderer.xr.addEventListener("sessionstart", () =>
    captureManager?.onSessionStart()
  );
  renderer.xr.addEventListener("sessionend", () =>
    captureManager?.onSessionEnd()
  );

  // 7. Interactions et Objets AR
  controller = renderer.xr.getController(0);
  controller.addEventListener("select", onSelect);
  scene.add(controller);

  initReticle();
  scene.add(reticle);

  window.addEventListener("resize", onWindowResize, false);

  // Lancement de la boucle de rendu
  renderer.setAnimationLoop(render);
}

/**
 * Boucle de rendu XR
 */
function render(timestamp, frame) {
  if (frame) {
    const session = renderer.xr.getSession();
    const referenceSpace = renderer.xr.getReferenceSpace();

    // Gestion du Hit-Test pour placer les points
    if (!hitTestSourceRequested) {
      session.requestReferenceSpace("viewer").then((space) => {
        session.requestHitTestSource({ space }).then((source) => {
          hitTestSource = source;
        });
      });
      hitTestSourceRequested = true;
    }

    if (hitTestSource) {
      const results = frame.getHitTestResults(hitTestSource);
      if (results.length) {
        const hit = results[0];
        reticle.visible = true;
        reticle.matrix.fromArray(hit.getPose(referenceSpace).transform.matrix);

        // Mise à jour de la ligne en temps réel pendant la mesure
        if (currentLine) updateLine(reticle.matrix);
      } else {
        reticle.visible = false;
      }
    }

    // Gestion de la capture (fusion caméra + 3D) si demandée
    if (captureManager) {
      captureManager.handleFrame(frame);
    }
  }

  renderer.render(scene, camera);
}

/**
 * Initialisation du bouton photo avec protection contre les clics AR
 */
function initPhotoButton(parent) {
  const btn = document.createElement("button");
  btn.id = "photo-btn";
  btn.textContent = " "; // Stylisé par styles.css
  parent.appendChild(btn);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopImmediatePropagation(); // Empêche de poser un point de mesure sous le bouton
    if (captureManager) captureManager.requestCapture();
  });
}

/**
 * Gestion du clic pour mesurer
 */
function onSelect() {
  if (reticle.visible) {
    const position = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
    measurements.push(position);

    if (measurements.length === 2) {
      // Calcul et affichage de la mesure
      const distance = Math.round(
        measurements[0].distanceTo(measurements[1]) * 100
      );
      const sprite = createLabelSprite(`${distance} cm`);

      const center = new THREE.Vector3()
        .addVectors(measurements[0], measurements[1])
        .multiplyScalar(0.5);
      sprite.position.copy(center).add(new THREE.Vector3(0, 0.05, 0)); // Offset vers le haut

      scene.add(sprite);

      measurements = [];
      currentLine = null;
    } else {
      // Début d'une nouvelle ligne
      currentLine = initLine();
      scene.add(currentLine);
    }
  }
}

// --- FONCTIONS HELPERS (Mesures et Visuels) ---

function createLabelSprite(message) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = "64px sans-serif";
  const textWidth = ctx.measureText(message).width;

  canvas.width = textWidth + 64;
  canvas.height = 100;

  ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
  ctx.roundRect(0, 0, canvas.width, canvas.height, 20);
  ctx.fill();

  ctx.fillStyle = "white";
  ctx.font = "64px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(message, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false })
  );
  sprite.scale.set(0.1 * (canvas.width / canvas.height), 0.1, 1);
  return sprite;
}

function initLine() {
  const geometry = new THREE.CylinderGeometry(0.003, 0.003, 1, 8);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const cylinder = new THREE.Mesh(geometry, material);
  return cylinder;
}

function updateLine(matrix) {
  if (!currentLine || measurements.length === 0) return;
  const start = measurements[0];
  const end = new THREE.Vector3().setFromMatrixPosition(matrix);
  const dir = new THREE.Vector3().subVectors(end, start);
  const length = dir.length();

  currentLine.position.copy(start).add(dir.clone().multiplyScalar(0.5));
  currentLine.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize()
  );
  currentLine.scale.set(1, length, 1);
}

function initReticle() {
  const ring = new THREE.RingGeometry(0.045, 0.05, 32).rotateX(-Math.PI / 2);
  const dot = new THREE.CircleGeometry(0.005, 32).rotateX(-Math.PI / 2);
  reticle = new THREE.Mesh(
    BufferGeometryUtils.mergeBufferGeometries([ring, dot]),
    new THREE.MeshBasicMaterial()
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
