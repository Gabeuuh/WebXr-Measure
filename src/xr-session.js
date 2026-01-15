import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { createCaptureManager } from "./capture";

let camera,
  scene,
  renderer,
  reticle,
  hitTestSource = null;
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
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  captureManager = createCaptureManager({ renderer, scene });

  // UI (Overlay)
  const ui = document.createElement("div");
  ui.id = "ui-overlay";
  ui.style.cssText =
    "position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none;";
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
      } else {
        reticle.visible = false;
      }
    }
    captureManager.handleFrame(frame);
  }
  renderer.render(scene, camera);
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
