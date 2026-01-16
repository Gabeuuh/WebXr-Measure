import * as THREE from "three";

export function createCaptureManager({ renderer, scene }) {
  let captureRequested = false;
  let renderTarget = null;
  let warnedMissingCamera = false;

  // On garde une ExternalTexture réutilisable
  let externalCameraTexture = null;

  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false })
  );
  quad.frustumCulled = false;
  quad.material.depthTest = false;
  quad.material.depthWrite = false;
  quad.material.side = THREE.DoubleSide;
  quad.renderOrder = -999;

  const bgScene = new THREE.Scene();
  bgScene.add(quad);
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const flashOverlay = document.createElement("div");
  flashOverlay.id = "photo-flash";
  flashOverlay.setAttribute("aria-hidden", "true");
  document.body.appendChild(flashOverlay);

  const ensureFlashRoot = () => {
    const overlayRoot =
      document.getElementById("ui-overlay") || document.body;
    if (flashOverlay.parentElement !== overlayRoot) {
      overlayRoot.appendChild(flashOverlay);
    }
  };

  const triggerFlash = () => {
    ensureFlashRoot();
    flashOverlay.classList.remove("flash-active");
    void flashOverlay.offsetWidth;
    flashOverlay.classList.add("flash-active");
  };

  function capture(frame) {
    const refSpace = renderer.xr.getReferenceSpace();
    const pose = frame.getViewerPose(refSpace);
    if (!pose) return;

    const session = renderer.xr.getSession();
    const baseLayer = session.renderState.baseLayer;

    const view = pose.views[0];
    const viewport = baseLayer.getViewport(view);
    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);

    const xrCameraForView = view.camera;
    if (!xrCameraForView) return;

    const binding = renderer.xr.getBinding?.();
    if (!binding?.getCameraImage) return;

    const webglTex = binding.getCameraImage(xrCameraForView);
    if (!webglTex) return;

    if (!externalCameraTexture) {
      externalCameraTexture = new THREE.ExternalTexture(webglTex);
    } else {
      // fallback robuste selon versions/impl
      externalCameraTexture.needsUpdate = true;
    }

    quad.frustumCulled = false;
    quad.material.side = THREE.DoubleSide;
    quad.material.map = externalCameraTexture;
    quad.material.needsUpdate = true;

    if (
      !renderTarget ||
      renderTarget.width !== width ||
      renderTarget.height !== height
    ) {
      renderTarget?.dispose();
      renderTarget = new THREE.WebGLRenderTarget(width, height);
    }

    const xrCamera = renderer.xr.getCamera();
    const wasXREnabled = renderer.xr.enabled;
    const prevRenderTarget = renderer.getRenderTarget();

    const prevAutoClear = renderer.autoClear;
    const prevClearAlpha = renderer.getClearAlpha();

    renderer.xr.enabled = false;

    renderer.setRenderTarget(renderTarget);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissorTest(false);

    renderer.autoClear = false;
    renderer.setClearAlpha(1);
    renderer.clear(true, true, true);

    // 1) Fond caméra
    renderer.render(bgScene, orthoCam);

    // 2) Tes mesures par-dessus (SANS effacer le fond)
    renderer.render(scene, xrCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setClearAlpha(prevClearAlpha);

    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);

    renderer.setRenderTarget(prevRenderTarget);
    renderer.xr.enabled = wasXREnabled;

    triggerFlash();
    save(pixels, width, height);
  }

  function save(pixels, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const imgData = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const srcIdx = (height - 1 - y) * width * 4;
      imgData.data.set(pixels.slice(srcIdx, srcIdx + width * 4), y * width * 4);
    }
    ctx.putImageData(imgData, 0, 0);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `mesure-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  }

  return {
    requestCapture: () => (captureRequested = true),
    handleFrame: (frame) => {
      if (!captureRequested) return;
      capture(frame);
      captureRequested = false;
    },
  };
}
