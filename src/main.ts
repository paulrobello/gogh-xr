import { PerspectiveCamera, WebGLRenderer } from 'three';
import { BUTTON_X, leftButtonPressed } from './bench/stick';
import { installDesktopControls } from './desktop/controls';
import { applyPainterCamera } from './desktop/painter-camera';
import { EYE_HEIGHT } from './desktop/walk';
import { installDiag, installPose, installShot, registerDiag } from './diag/diag';
import { flags } from './diag/flags';
import { livePainting } from './paintings/registry';
import type { PainterCamera, WorldModule } from './paintings/world-module';
import { createStrokeBinding } from './render/stroke-binding';
import type { StrokeBatch } from './render/strokes/batch';
import { createEnterVrButton } from './ui/enter-vr';
import { createHudToggle, type HudToggle, isHudToggleKey } from './ui/hud-toggle';
import { clearNotices, showNotice } from './ui/notice';
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

// An unknown or coming-soon `?painting` warns here and boots the bare scene.
const painting = flags.bench === null ? livePainting(flags.painting) : null;
const scene = createBareScene(painting === null);
const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 1000);
// The test canvas stands in front of the XR origin, so the desktop viewer starts there too. A
// world moves it to the module's `spawnPose()` once the module loads, before it builds.
const desktop = installDesktopControls(
  renderer.domElement,
  camera,
  flags.demo === 'canvas' && !painting ? { x: 0, z: 0 } : undefined,
);
/** `?painter` (fidelity capture): the world's painter camera, applied before the world builds. */
let painterView: PainterCamera | null = null;
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
  camera.aspect = painterView ? painterView.aspect : window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let hud: HudToggle | null = null;
/**
 * The governed batch, which the HUD also counts. Every scene with a stroke batch runs the governor,
 * except the bench and `?nogov`. A world switch rebinds it with `strokes.bind`.
 */
const strokes = createStrokeBinding({
  loadGovernor:
    flags.nogov || flags.bench !== null
      ? null
      : async () => {
          const { startGovernor } = await import('./render/governor-runtime');
          return (batch) =>
            startGovernor({
              renderer,
              scene,
              batch,
              mode: beauty ? 'beauty' : 'default',
              targetHz: targetFrameRate,
              // The DOM notice is invisible in immersive mode, so the HUD carries it there, hidden
              // or not.
              notify: (message) => {
                showNotice(message);
                hud?.setVisible(true);
              },
            });
        },
});
let world: WorldModule | null = null;
let lastTime = 0;
/** Draw calls of the last animation frame's render, read right after it (`draw` diag key). */
let drawCalls = 0;
function renderFrame(time: number): void {
  const dt = lastTime === 0 ? 0 : (time - lastTime) / 1000;
  lastTime = time;
  if (flags.slow > 0) busyWait(flags.slow);
  strokes.frame(time);
  world?.update(time / 1000, dt);
  if (!renderer.xr.isPresenting) desktop.update(dt);
  renderer.render(scene, camera);
  drawCalls = renderer.info.render.calls;
  if (hud) {
    const sources = renderer.xr.isPresenting ? renderer.xr.getSession()?.inputSources : null;
    hud.frame(time, leftButtonPressed(sources, BUTTON_X));
  }
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
  registerDiag('draw', () => ({ calls: drawCalls, visibleChunks: strokes.visibleChunkCount() }));
  installPose((x, y, z, yaw, pitch) => desktop.setPose(x, y, z, yaw, pitch));
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

// `?hud` starts the HUD shown; left X and H toggle it. The bench keeps its own HUD and uses X,
// so no HUD is ever built there.
if (flags.bench === null) {
  const toggle = createHudToggle({
    visible: flags.hud,
    build: async () => {
      const { startPerfHud } = await import('./ui/perf-hud');
      return startPerfHud({
        camera,
        scene,
        xr: renderer.xr,
        targetHz: targetFrameRate,
        getGovernor: () => strokes.governorDiag(),
        getVisible: () => strokes.visibleCount(),
        getVisibleChunks: () => strokes.visibleChunkCount(),
      });
    },
    onError: (error) => console.warn('perf HUD failed to start', error),
  });
  hud = toggle;
  registerDiag('hud', () => toggle.diag());
  window.addEventListener('keydown', (event) => {
    if (isHudToggleKey(event)) toggle.toggle();
  });
}

/** With two stroke scenes at once, the first batch to load is the one bound. */
function governStrokes(batch: StrokeBatch): Promise<void> {
  return strokes.batch ? Promise.resolve() : strokes.bind(batch);
}

// Boot modes are exclusive: a world wins over the test scenes, so only one batch is governed.
if (painting && (flags.strokesTest || flags.demo !== null)) {
  console.warn(`?painting=${painting.id} wins; ignoring ?strokesTest and ?demo`);
}

if (flags.strokesTest && !painting) {
  import('./render/strokes/test-scene')
    .then(({ startStrokesTest }) => governStrokes(startStrokesTest({ scene }).batch))
    .catch((error: unknown) => console.warn('strokes test failed to start', error));
}

if (flags.demo === 'canvas' && !painting) {
  import('./demo/canvas/demo')
    .then(async ({ startCanvasDemo }) =>
      governStrokes((await startCanvasDemo({ scene, seed: flags.seed, count: flags.count })).batch),
    )
    .catch((error: unknown) => console.warn('canvas demo failed to start', error));
}

if (painting?.world) {
  const load = painting.world;
  Promise.all([load(), import('./demo/canvas/demo')])
    .then(async ([module, { loadRaster }]) => {
      // Before build, which registers the `world` diag key that captures wait for.
      if (flags.diag && flags.painter) {
        painterView = module.painterCamera();
        applyPainterCamera(camera, desktop, painterView);
      } else {
        const { position, yaw } = module.spawnPose();
        desktop.setPose(position[0], position[1] + EYE_HEIGHT, position[2], yaw, 0);
      }
      const handle = await module.build({
        scene,
        seed: flags.seed,
        loadRaster,
        nocache: flags.nocache,
        cache: flags.cache,
        debug: flags.diag ? (flags.bare ? 'bare' : flags.coverage ? 'coverage' : null) : null,
      });
      world = module;
      await governStrokes(handle.batch);
    })
    .catch((error: unknown) => console.warn(`painting ${painting.id} failed to start`, error));
}

void isVrSupported(navigator.xr).then((supported) => {
  session.state.supported = supported;
  createEnterVrButton(supported, () => void session.enter());
});
