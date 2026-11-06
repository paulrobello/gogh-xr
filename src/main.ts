import { PerspectiveCamera, WebGLRenderer } from 'three';
import { installDesktopControls } from './desktop/controls';
import { installDiag, installShot, registerDiag } from './diag/diag';
import { flags } from './diag/flags';
import { createEnterVrButton } from './ui/enter-vr';
import { clearNotices, showNotice } from './ui/notice';
import { version } from './version';
import { createBareScene } from './world/bare-scene';
import { createInputCounter } from './xr/input-counter';
import { createSessionController, isVrSupported, resolveTargetFrameRate } from './xr/session';

// Must run before any WebXR code reads navigator.xr. The MODE guard keeps IWER out of production.
if (import.meta.env.MODE === 'e2e' && flags.iwer) {
  (await import('./xr/iwer-install')).installIwer();
}

const renderer = new WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: flags.diag && flags.shot,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = createBareScene();
const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 1000);
const desktop = installDesktopControls(renderer.domElement, camera);
const session = createSessionController({
  renderer,
  xr: navigator.xr,
  notify: (message) => showNotice(message),
  clearNotices: () => clearNotices(),
  targetFrameRate: resolveTargetFrameRate(flags.hz),
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let lastTime = 0;
function renderFrame(time: number): void {
  const dt = lastTime === 0 ? 0 : (time - lastTime) / 1000;
  lastTime = time;
  if (!renderer.xr.isPresenting) desktop.update(dt);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(renderFrame);

if (flags.diag) {
  installDiag({ build: version, renderer, camera, getXrState: () => session.state });
  const input = createInputCounter(renderer.xr);
  registerDiag('input', () => ({ selectstart: { ...input.selectstart } }));
}
if (flags.diag && flags.shot) {
  installShot(renderer.domElement, () => renderer.render(scene, camera));
}
if (flags.bench !== null) {
  import('./bench/bench')
    .then(({ startBench }) =>
      startBench({ renderer, scene, camera, getXrState: () => session.state }),
    )
    .catch((error: unknown) => console.warn('bench failed to start', error));
}

void isVrSupported(navigator.xr).then((supported) => {
  session.state.supported = supported;
  createEnterVrButton(supported, () => void session.enter());
});
