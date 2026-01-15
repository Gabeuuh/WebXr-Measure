import * as THREE from "three";

export function createCaptureManager({ renderer, scene }) {
  let captureRequested = false;
  let renderTarget = null;

  // Création d'un plan qui couvrira tout l'écran pour la photo
  const fsQuadGeometry = new THREE.PlaneGeometry(2, 2);
  const fsQuadMaterial = new THREE.MeshBasicMaterial({
    depthWrite: false,
    depthTest: false,
  });
  const fsQuad = new THREE.Mesh(fsQuadGeometry, fsQuadMaterial);

  function captureComposite(frame) {
    const session = frame.session;
    const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
    if (!pose) return;

    // 1. Récupérer la vue et la caméra XR spécifique
    const view = pose.views[0];
    const xrCamera = renderer.xr.getCamera();
    const cameraView = xrCamera.cameras[0]; // La vue de l'oeil gauche/unique

    // 2. LA NOUVEAUTÉ (PR #31487) : Récupérer la texture nativement
    // Cette texture est automatiquement alignée et orientée par Three.js
    const cameraTexture = renderer.xr.getCameraTexture(cameraView);
    if (!cameraTexture) return;

    const { width, height } = view.viewport;

    // 3. Préparer le buffer de capture
    if (!renderTarget || renderTarget.width !== width) {
      renderTarget = new THREE.WebGLRenderTarget(width, height);
    }

    // 4. Composition de la photo
    fsQuadMaterial.map = cameraTexture;

    // On sauvegarde l'état actuel de la scène
    const oldAutoClear = renderer.autoClear;
    renderer.setRenderTarget(renderTarget);
    renderer.autoClear = false;
    renderer.clear();

    // A. Dessiner le fond (Caméra)
    // On utilise une scène temporaire pour le quad de fond
    const bgScene = new THREE.Scene();
    bgScene.add(fsQuad);
    renderer.render(bgScene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));

    // B. Dessiner vos mesures par-dessus
    renderer.render(scene, xrCamera);

    // 5. Lecture des pixels et sauvegarde
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);

    // Reset de l'état du renderer
    renderer.setRenderTarget(null);
    renderer.autoClear = oldAutoClear;

    saveImage(pixels, width, height);
  }

  function saveImage(pixels, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);

    // WebGL est inversé verticalement, on corrige ici
    for (let y = 0; y < height; y++) {
      const line = pixels.slice(
        (height - 1 - y) * width * 4,
        (height - y) * width * 4
      );
      imageData.data.set(line, y * width * 4);
    }

    ctx.putImageData(imageData, 0, 0);

    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = `mesure-ar-${Date.now()}.png`;
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  }

  return {
    onSessionStart: () => {
      /* Plus besoin d'init de pipeline shader ! */
    },
    onSessionEnd: () => {
      renderTarget?.dispose();
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
