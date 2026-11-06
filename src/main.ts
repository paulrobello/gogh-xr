import { PerspectiveCamera, WebGLRenderer } from 'three';
import { installDesktopControls } from './desktop/controls';
import { installDiag, installShot, registerDiag } from './diag/diag';
import { flags } from './diag/flags';
import type { GovernorRuntime } from './render/governor-runtime';
import type { StrokeBatch } from './render/strokes/batch';
import { createEnterVrButton } from './ui/enter-vr';
import { clearNotices, showNotice } from './ui/notice';
import type { PerfHud } from './ui/perf-hud';
import { busyWait } from './util/busy-wait';
import { version } from './version';
import { createBareScene } from './world/bare-scene';
import { createInputCounter } from './xr/input-counter';
import { createSessionController, isVrSupported, resolveTargetFrameRate } from './xr/session';

// Must run before any WebXR code reads navigator.xr. The MODE guard keeps IWER out of production.
if (import.meta.env.MODE === 'e2e' && flags.iwer) {
  (await import('./xr/iwer-install')).installIwer();
}

// three r186 always requests `alpha: true` itself, which lets the partial alpha-to-coverage alpha at
// stroke rims show the page through the canvas. These are three's own defaults with alpha off.
const canvas = document.createElement('canvas');
const context = canvas.getContext('webgl2', {
  alpha: false,
  depth: true,
  stencil: false,
  antialias: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: flags.diag && flags.shot,
  powerPreference: 'default',
  failIfMajorPerformanceCaveat: false,
});
if (!context) throw new Error('WebGL2 is not available');
const renderer = new WebGLRenderer({ canvas, context });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = createBareScene();
const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 1000);
// The test canvas stands in front of the XR origin, so the desktop viewer starts there too.
const desktop = installDesktopControls(
  renderer.domElement,
  camera,
  flags.demo === 'canvas' ? { x: 0, z: 0 } : undefined,
);
// Max beauty forces 72 Hz over `?hz`; the bench keeps its own frame-rate controls.
const beauty = flags.beauty && flags.bench === null;
const targetFrameRate = resolveTargetFrameRate(flags.hz, beauty);
const session = createSessionController({
  renderer,
  xr: navigator.xr,
  notify: (message) => showNotice(message),
  clearNotices: () => clearNotices(),
  targetFrameRate,
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let governor: GovernorRuntime | null = null;
let hud: PerfHud | null = null;
/** The batch the HUD counts visible strokes from: the first to load, as with the governor. */
let hudBatch: StrokeBatch | null = null;
let lastTime = 0;
function renderFrame(time: number): void {
  const dt = lastTime === 0 ? 0 : (time - lastTime) / 1000;
  lastTime = time;
  if (flags.slow > 0) busyWait(flags.slow);
  governor?.frame(time);
  if (!renderer.xr.isPresenting) desktop.update(dt);
  renderer.render(scene, camera);
  hud?.frame(time);
}
renderer.setAnimationLoop(renderFrame);

if (flags.diag) {
  installDiag({
    build: version,
    renderer,
    camera,
    getXrState: () => session.state,
    targetFrameRate,
  });
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

// The bench keeps its own HUD, so `?hud` does nothing there.
if (flags.hud && flags.bench === null) {
  import('./ui/perf-hud')
    .then(({ startPerfHud }) => {
      hud = startPerfHud({
        camera,
        scene,
        xr: renderer.xr,
        targetHz: targetFrameRate,
        getGovernor: () => governor?.diag() ?? null,
        getVisible: () => hudBatch?.visibleCount() ?? null,
      });
    })
    .catch((error: unknown) => console.warn('perf HUD failed to start', error));
}

let governed = false;
/**
 * Every scene with a stroke batch runs the governor, except the bench and `?nogov`. With two
 * stroke scenes at once, the first batch to load is the one governed.
 */
async function governStrokes(batch: StrokeBatch): Promise<void> {
  hudBatch ??= batch;
  if (flags.nogov || flags.bench !== null || governed) return;
  governed = true;
  try {
    const { startGovernor } = await import('./render/governor-runtime');
    governor = startGovernor({
      renderer,
      scene,
      batch,
      mode: beauty ? 'beauty' : 'default',
      targetHz: targetFrameRate,
      notify: (message) => showNotice(message),
    });
  } catch (error) {
    console.warn('quality governor failed to start', error);
  }
}

if (flags.strokesTest) {
  import('./render/strokes/test-scene')
    .then(({ startStrokesTest }) => governStrokes(startStrokesTest({ scene }).batch))
    .catch((error: unknown) => console.warn('strokes test failed to start', error));
}

if (flags.demo === 'canvas') {
  import('./demo/canvas/demo')
    .then(async ({ startCanvasDemo }) =>
      governStrokes((await startCanvasDemo({ scene, seed: flags.seed })).batch),
    )
    .catch((error: unknown) => console.warn('canvas demo failed to start', error));
}

void isVrSupported(navigator.xr).then((supported) => {
  session.state.supported = supported;
  createEnterVrButton(supported, () => void session.enter());
});
