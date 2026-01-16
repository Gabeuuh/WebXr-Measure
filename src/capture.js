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
  const bgScene = new THREE.Scene();
  bgScene.add(quad);
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function capture(frame) {
    const refSpace = renderer.xr.getReferenceSpace();
    const pose = frame.getViewerPose(refSpace);
    if (!pose) return;

    const view = pose.views[0];
    const xrCameraForView = view.camera; // <-- Raw Camera Access API
    if (!xrCameraForView) {
      if (!warnedMissingCamera) {
        console.warn(
          "camera-access actif, mais view.camera est null. Browser/device ne supporte pas Raw Camera Access."
        );
        warnedMissingCamera = true;
      }
      return;
    }

    const binding = renderer.xr.getBinding?.();
    if (!binding || typeof binding.getCameraImage !== "function") {
      if (!warnedMissingCamera) {
        console.warn(
          "XRWebGLBinding.getCameraImage indisponible. (Raw Camera Access non supporté / flag / device)."
        );
        warnedMissingCamera = true;
      }
      return;
    }

    const webglTex = binding.getCameraImage(xrCameraForView); // WebGLTexture
    if (!webglTex) return;

    if (!externalCameraTexture) {
      externalCameraTexture = new THREE.ExternalTexture(webglTex);
    } else {
      externalCameraTexture.sourceTexture = webglTex;
      externalCameraTexture.needsUpdate = true;
    }

    // La taille : ton code utilise pose.views[0].viewport, mais viewport n’est pas standard ici.
    // Le plus robuste est de prendre la size caméra (spec) :
    const width = xrCameraForView.width;
    const height = xrCameraForView.height;

    if (
      !renderTarget ||
      renderTarget.width !== width ||
      renderTarget.height !== height
    ) {
      if (renderTarget) renderTarget.dispose();
      renderTarget = new THREE.WebGLRenderTarget(width, height);
    }

    quad.material.map = externalCameraTexture;
    quad.material.needsUpdate = true;

    const xrCamera = renderer.xr.getCamera(); // caméra three (stereo wrapper)
    const wasXREnabled = renderer.xr.enabled;
    const prevRenderTarget = renderer.getRenderTarget();
    const prevViewport = renderer.getViewport(new THREE.Vector4());
    const prevScissor = renderer.getScissor(new THREE.Vector4());
    const prevScissorTest = renderer.getScissorTest();
    const prevAutoClear = renderer.autoClear;

    renderer.xr.enabled = false;
    renderer.autoClear = true;

    renderer.setRenderTarget(renderTarget);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.setScissorTest(false);
    renderer.clear(true, true, true);

    // 1) caméra réelle
    renderer.render(bgScene, orthoCam);
    // 2) tes mesures par-dessus
    renderer.render(scene, xrCamera);

    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);

    renderer.setRenderTarget(prevRenderTarget);
    renderer.setViewport(prevViewport);
    renderer.setScissor(prevScissor);
    renderer.setScissorTest(prevScissorTest);
    renderer.autoClear = prevAutoClear;
    renderer.xr.enabled = wasXREnabled;

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
