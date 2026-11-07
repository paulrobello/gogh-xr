import { PerspectiveCamera, Quaternion, type Texture, Vector3, WebGLRenderer } from 'three';
import { BUTTON_X, leftButtonPressed } from './bench/stick';
import { installDesktopControls } from './desktop/controls';
import { applyPainterCamera } from './desktop/painter-camera';
import { installDiag, installPose, installShot, registerDiag } from './diag/diag';
import { flags } from './diag/flags';
import { type ArcMesh, createArcMesh } from './locomotion/arc-mesh';
import { type ArcTarget, createLocomotion } from './locomotion/locomotion';
import { clampLocomotionSettings, DEFAULT_LOCOMOTION_SETTINGS } from './locomotion/settings';
import { livePainting } from './paintings/registry';
import type { PainterCamera, WorldModule } from './paintings/world-module';
import { createStrokeBinding } from './render/stroke-binding';
import type { StrokeBatch } from './render/strokes/batch';
import { createBrushAtlas } from './render/strokes/brush-atlas';
import { createZdiag } from './render/zdiag';
import { createEnterVrButton } from './ui/enter-vr';
import { createHudToggle, type HudToggle, isHudToggleKey } from './ui/hud-toggle';
import { clearNotices, showNotice } from './ui/notice';
import { createVignette } from './ui/vignette';
import { busyWait } from './util/busy-wait';
import { version } from './version';
import { createBareScene } from './world/bare-scene';
import { type Actions, createInput } from './xr/input';
import { createInputCounter } from './xr/input-counter';
import { installKeyboardInput } from './xr/input-keyboard';
import { trackRightController } from './xr/right-controller';
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
// Near 0.1 m, not less: depth precision scales with the near plane, and coarser steps make
// overlapping strokes flicker (docs/verification.md, stroke flicker). XR inherits it as depthNear.
const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
const desktop = installDesktopControls(renderer.domElement, camera);
/**
 * The rig, the camera's parent, which locomotion moves (P3.2). It starts at the XR origin; a world
 * moves it to the module's `spawnPose()` once the module loads, before it builds. The bench never
 * runs locomotion, so its rig stays at the origin and it has no vignette.
 */
const runLocomotion = flags.bench === null;
const vignette = runLocomotion ? createVignette(camera) : undefined;
/** The teleport arc's strokes, built once by `buildArc`. */
let arcStrokes: ArcMesh | null = null;
const strokeScene = Boolean(painting?.world) || flags.strokesTest || flags.demo === 'canvas';
const arc: ArcTarget = {
  show: (aim, eye) => {
    if (!arcStrokes && !strokeScene) buildArc(createBrushAtlas());
    arcStrokes?.show(aim, eye);
  },
  hide: () => arcStrokes?.hide(),
};
const locomotion = createLocomotion({
  scene,
  camera,
  look: desktop,
  settings: clampLocomotionSettings({
    ...DEFAULT_LOCOMOTION_SETTINGS,
    seated: flags.seated,
    turnMode: flags.turn ?? DEFAULT_LOCOMOTION_SETTINGS.turnMode,
  }),
  vignette,
  aimSource: () => rightController?.() ?? null,
  arc,
});
/** The XR teleport aim. Its controller slots must exist before a session starts. */
const rightController = runLocomotion ? trackRightController(renderer.xr, locomotion.rig) : null;
// three compiles a program on its first visible draw, which for the vignette is the first smooth
// move in XR. `compile` also takes hidden meshes, and a raw shader's program does not depend on
// the render target, so the XR draw reuses this one.
if (vignette) renderer.compile(vignette.mesh, camera, scene);

/**
 * Builds the arc once, on `atlas`. A stroke scene's batch already holds the atlas and the stroke
 * program, so the arc shares both. The bare scene has no batch: it builds an atlas of its own on
 * the first aim, so a boot that never aims never pays for the 2048² atlas, its upload or the
 * program, and the first aim does instead.
 */
function buildArc(atlas: Texture): void {
  if (runLocomotion && !arcStrokes) arcStrokes = createArcMesh(scene, atlas);
}
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

/** `?zdiag=<mode>`, honoured in production like `?slow` (src/render/zdiag.ts). */
const zdiag = createZdiag(flags.zdiag, renderer);

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
/** The input action layer; locomotion consumes it. */
const input = createInput();
const keyboard = installKeyboardInput(window, renderer.domElement, document).state;
/** The last frame's actions, one object reused every frame (`input` diag key). */
let actions: Actions | null = null;
let lastTime = 0;
/** Draw calls of the last animation frame's render, read right after it (`draw` diag key). */
let drawCalls = 0;
function renderFrame(time: number): void {
  const dt = lastTime === 0 ? 0 : (time - lastTime) / 1000;
  lastTime = time;
  const sources = renderer.xr.isPresenting ? renderer.xr.getSession()?.inputSources : null;
  actions = input.read(sources, keyboard, dt);
  if (flags.slow > 0) busyWait(flags.slow);
  strokes.frame(time);
  world?.update(time / 1000, dt);
  if (!renderer.xr.isPresenting) desktop.update();
  if (runLocomotion) locomotion.frame(actions, renderer.xr.isPresenting);
  zdiag.beforeRender(camera);
  renderer.render(scene, camera);
  drawCalls = renderer.info.render.calls;
  hud?.frame(time, leftButtonPressed(sources, BUTTON_X));
}
renderer.setAnimationLoop(renderFrame);

if (flags.diag) {
  // The camera that rendered the last frame, in world space: in XR three's XR camera, whose
  // matrices include the rig, and on the desktop the camera itself.
  const view = { position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3() };
  const decomposeView = (): typeof view => {
    const rendered = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    rendered.matrixWorld.decompose(view.position, view.quaternion, view.scale);
    return view;
  };
  installDiag({
    build: version,
    renderer,
    camera: {
      position: { toArray: () => decomposeView().position.toArray() },
      quaternion: { toArray: () => decomposeView().quaternion.toArray() },
    },
    getXrState: () => session.state,
    targetFrameRate,
  });
  const counter = createInputCounter(renderer.xr);
  registerDiag('input', () => ({
    selectstart: { ...counter.selectstart },
    actions: actions && structuredClone(actions),
  }));
  registerDiag('zdiag', () => zdiag.diag());
  registerDiag('draw', () => ({ calls: drawCalls, visibleChunks: strokes.visibleChunkCount() }));
  if (runLocomotion) registerDiag('rig', () => locomotion.diag());
  installPose(locomotion.setPose);
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
  zdiag.applyToBatch(batch);
  buildArc(batch.atlas);
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
  locomotion.awaitGround();
  const load = painting.world;
  Promise.all([load(), import('./demo/canvas/demo')])
    .then(async ([module, { loadRaster }]) => {
      // Before build, which registers the `world` diag key that captures wait for.
      if (flags.diag && flags.painter) {
        painterView = module.painterCamera();
        applyPainterCamera(camera, locomotion.setPose, painterView);
      } else {
        const { position, yaw } = module.spawnPose();
        locomotion.spawn(position[0], position[1], position[2], yaw);
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
      locomotion.setWorld(handle);
      await governStrokes(handle.batch);
    })
    .catch((error: unknown) => {
      locomotion.setWorld(null);
      console.warn(`painting ${painting.id} failed to start`, error);
    });
}

void isVrSupported(navigator.xr).then((supported) => {
  session.state.supported = supported;
  createEnterVrButton(supported, () => void session.enter());
});
