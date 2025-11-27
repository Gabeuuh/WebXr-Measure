import * as THREE from "three";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";
import { BufferGeometryUtils } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";

let container, labelContainer;
let camera, scene, renderer, light;
let controller;

let hitTestSource = null;
let hitTestSourceRequested = false;

let measurements = [];
let labels = [];

let reticle;
let currentLine = null;

let width, height;

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
}

function initLabelContainer() {
  labelContainer = document.createElement("div");
  labelContainer.style.position = "absolute";
  labelContainer.style.top = "0px";
  labelContainer.style.pointerEvents = "none";
  labelContainer.setAttribute("id", "container");
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

  document.body.appendChild(
    ARButton.createButton(renderer, {
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: document.querySelector("#container") },
      requiredFeatures: ["hit-test"],
    })
  );

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

      let text = document.createElement("div");
      text.className = "label";
      text.style.color = "rgb(255,255,255)";
      text.textContent = distance + " cm";
      document.querySelector("#container").appendChild(text);

      labels.push({ div: text, point: getCenterPoint(measurements) });

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

    labels.map((label) => {
      let pos = toScreenPosition(label.point, renderer.xr.getCamera(camera));
      let x = pos.x;
      let y = pos.y;
      label.div.style.transform =
        "translate(-50%, -50%) translate(" + x + "px," + y + "px)";
    });
  }
  renderer.render(scene, camera);
}

export { initXR };
