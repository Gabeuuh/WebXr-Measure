import * as THREE from "three";

export function createCaptureManager({ renderer, scene }) {
  let captureRequested = false;
  let renderTarget = null;

  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false })
  );

  function capture(frame) {
    const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
    if (!pose) return;

    const xrCamera = renderer.xr.getCamera();
    // API r172 : Récupère la texture de la caméra déjà orientée
    const cameraTexture = renderer.xr.getCameraTexture(xrCamera.cameras[0]);
    if (!cameraTexture) return;

    const { width, height } = pose.views[0].viewport;
    if (!renderTarget)
      renderTarget = new THREE.WebGLRenderTarget(width, height);

    quad.material.map = cameraTexture;
    const originalAutoClear = renderer.autoClear;

    renderer.setRenderTarget(renderTarget);
    renderer.autoClear = false;
    renderer.clear();

    // Rendu du fond (Vidéo)
    const bgScene = new THREE.Scene().add(quad);
    renderer.render(bgScene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));

    // Rendu des mesures (3D)
    renderer.render(scene, xrCamera);

    // Lecture sécurisée des pixels
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);

    save(pixels, width, height);

    renderer.setRenderTarget(null);
    renderer.autoClear = originalAutoClear;
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
