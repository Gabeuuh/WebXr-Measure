import * as THREE from "three";

export function createCaptureManager({ renderer, scene }) {
  let captureRequested = false;
  let renderTarget = null;
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false })
  );
  const bgScene = new THREE.Scene().add(quad);
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function capture(frame) {
    const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
    if (!pose) return;

    const xrCamera = renderer.xr.getCamera();
    const cameraTexture = renderer.xr.getCameraTexture(xrCamera.cameras[0]);
    if (!cameraTexture) return;

    const { width, height } = pose.views[0].viewport;
    if (!renderTarget || renderTarget.width !== width) {
      renderTarget = new THREE.WebGLRenderTarget(width, height);
    }

    quad.material.map = cameraTexture;

    // --- ÉTAPE CRUCIALE : ESCAPER LE MODE XR ---
    const wasXREnabled = renderer.xr.enabled;
    renderer.xr.enabled = false; // Désactive temporairement le traitement XR

    renderer.setRenderTarget(renderTarget);
    renderer.clear();

    // Rendu de la vidéo
    renderer.render(bgScene, orthoCam);
    // Rendu des mesures
    renderer.render(scene, xrCamera);

    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);

    // --- RESTAURATION TOTALE ---
    renderer.setRenderTarget(null);
    renderer.xr.enabled = wasXREnabled; // Réactive XR
    renderer.state.reset(); // Nettoie le cache WebGL

    save(pixels, width, height);
  }

  function save(pixels, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imgData = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const srcIdx = (height - 1 - y) * width * 4;
      imgData.data.set(pixels.slice(srcIdx, srcIdx + width * 4), y * width * 4);
    }
    ctx.putImageData(imgData, 0, 0);
    canvas.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `mesure-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  }

  return {
    requestCapture: () => {
      captureRequested = true;
    },
    handleFrame: (frame) => {
      if (captureRequested) {
        capture(frame);
        captureRequested = false;
      }
    },
  };
}
