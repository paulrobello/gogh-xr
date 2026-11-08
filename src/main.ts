import {
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  type Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { BUTTON_X, leftButtonPressed } from './bench/stick';
import { bootWorld, GALLERY_WORLD, resolveBootMode } from './boot-mode';
import { installDesktopControls } from './desktop/controls';
import { applyPainterCamera } from './desktop/painter-camera';
import {
  type AbController,
  abShowsHudAtBoot,
  createAbController,
  createAbGroup,
  resolveAb,
} from './diag/ab';
import { installDiag, installPose, installShot, registerDiag } from './diag/diag';
import { flags } from './diag/flags';
import { skyWrapStats } from './diag/sky-wrap-stats';
import { type ArcMesh, createArcMesh } from './locomotion/arc-mesh';
import { type ArcTarget, createLocomotion } from './locomotion/locomotion';
import { MOTION_TIME_WRAP_S, motionClock } from './motion/clock';
import { MOTION_LAYER_MASK } from './motion/motion';
import { insideReactiveBox, reactiveTracker } from './motion/reactive';
import { SKY_WAVE_PER_TURN } from './motion/sky-swirl';
import { motionVariants } from './motion/variant-uniforms';
import { livePainting, logRegistryProblems, PAINTINGS } from './paintings/registry';
import type { PainterCamera, WorldDeps, WorldHandle, WorldModule } from './paintings/world-module';
import { createSwitcher, GALLERY_ID, type LiveWorld } from './portal/switcher';
import { createStrokeBinding } from './render/stroke-binding';
import type { StrokeBatch } from './render/strokes/batch';
import { createBrushAtlas } from './render/strokes/brush-atlas';
import { pinMotionPhase } from './render/strokes/material';
import { createZdiag } from './render/zdiag';
import { applySettingsChange, type HudLive } from './settings/apply';
import { loadSettings, type QualityMode, toLocomotionSettings } from './settings/schema';
import { createSettingsStore } from './settings/store';
import { createEnterVrButton } from './ui/enter-vr';
import { createHudToggle, type HudToggle, isHudToggleKey } from './ui/hud-toggle';
import { clearNotices, showNotice } from './ui/notice';
import { clearPanelPose } from './ui/panel-pose';
import {
  createPanelToggle,
  galleryReturnCallback,
  onGalleryReturnChange,
  registerGalleryReturn,
} from './ui/panel-toggle';
import { createVignette } from './ui/vignette';
import { busyWait } from './util/busy-wait';
import { createSlicer } from './util/slicer';
import { version } from './version';
import { createBareScene } from './world/bare-scene';
import { type Actions, createInput } from './xr/input';
import { createInputCounter } from './xr/input-counter';
import { installKeyboardInput } from './xr/input-keyboard';
import { CONTROLLER_SLOTS, trackController, trackRightController } from './xr/right-controller';
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
// The stored settings, with each URL flag laid over its field for this session and never written
// back (P5.2). The settings store is the one live copy: the P5.3 panels write it and it saves.
const { settings: storedSettings, recovered: settingsRecovered } = loadSettings();
const settingsStore = createSettingsStore({ stored: storedSettings, flags });
const settings = settingsStore.effective;
if (settingsRecovered) {
  console.warn(`settings: ${settingsRecovered}; using the defaults`);
}
// `?noanim` freezes the clock.
motionClock.setCalm(settings.calm);
motionClock.setFrozen(flags.noanim);
// `?wrap` sets the sky wrap variant whatever A/B group wins: under another group it stays fixed.
motionVariants.setWrap(flags.wrap ?? 'base');
// `?waveturns` sets the wave wrap's waves per turn, read only under wave.
motionVariants.setWaveTurns(flags.waveTurns ?? SKY_WAVE_PER_TURN);
/**
 * `?motiont` pins the motion time for the e2e (R-P4g). `import.meta.env.MODE` is replaced at build
 * time, so a production build drops this and keeps calling `motionClock.frame`.
 */
let pinnedMotionTime = import.meta.env.MODE === 'e2e' ? flags.motiont : null;
if (pinnedMotionTime !== null) motionClock.uniforms.uTime.value = pinnedMotionTime;
/** `?motionphase`'s pinned stroke phase, e2e builds only, so the `wrap` diag counts what draws. */
const pinnedMotionPhase = import.meta.env.MODE === 'e2e' ? flags.motionphase : null;
// `?motionphase` pins every stroke's phase and installs the swirl's TS prediction, e2e builds only.
if (import.meta.env.MODE === 'e2e') {
  pinMotionPhase(flags.motionphase);
  void import('./diag/swirl-probe').then(
    ({ moonDiscRim, predictHaloGlow, predictRingShift, predictSkyShift }) => {
      window.__goghSkyShift = predictSkyShift;
      window.__goghRingShift = predictRingShift;
      window.__goghHaloGlow = predictHaloGlow;
      window.__goghMoonDisc = moonDiscRim;
    },
  );
  // Moves a `?motiont` pin to another time without a reload (P4.6), so one boot sweeps many.
  window.__goghMotionT = (t: number) => {
    if (pinnedMotionTime === null) throw new Error('__goghMotionT needs a ?motiont pin');
    if (!Number.isFinite(t) || t < 0) throw new RangeError(`motion time ${t} must be at least 0`);
    pinnedMotionTime = t % MOTION_TIME_WRAP_S;
    motionClock.uniforms.uTime.value = pinnedMotionTime;
  };
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

logRegistryProblems();
// An unknown or coming-soon `?painting` warns here and is otherwise ignored, so with no other scene
// flag the gallery boots (src/boot-mode.ts).
const bootMode = resolveBootMode(flags, livePainting);
const painting = bootMode.kind === 'painting' ? bootMode.entry : null;
const worldEntry = bootWorld(bootMode);
const scene = createBareScene(worldEntry === null);
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
/**
 * The portal's veil (P5.5) shares the vignette's full-view fade with the teleport blink: the mesh
 * shows the larger of the two. Unlike the blink it also shows on the desktop.
 */
let portalVeil = 0;
let blinkFade = 0;
const vignetteTarget = vignette && {
  setAlpha: (alpha: number) => vignette.setAlpha(alpha),
  setFade: (fade: number) => {
    blinkFade = fade;
    vignette.setFade(Math.max(blinkFade, portalVeil));
  },
};
function setPortalVeil(alpha: number): void {
  portalVeil = alpha;
  vignette?.setFade(Math.max(blinkFade, portalVeil));
}
/** Frame-budgeted work: a world built behind a portal transition, and the gallery's plaques. */
const slicer = createSlicer(6);
/** The teleport arc's strokes, built once by `buildArc`. */
let arcStrokes: ArcMesh | null = null;
const strokeScene = worldEntry !== null || flags.strokesTest || flags.demo === 'canvas';
/**
 * The app's one brush atlas, built on first need: the worlds' batches (which never dispose it), the
 * arc, the settings panel and the portal's strokes share it, so a world switch never leaves one of
 * them on a disposed atlas. The test scenes' batches own theirs.
 */
let sharedAtlas: Texture | null = null;
function strokeAtlas(): Texture {
  if (!worldEntry) {
    const batchAtlas = reactiveBatch?.atlas;
    if (batchAtlas) return batchAtlas;
  }
  sharedAtlas ??= createBrushAtlas();
  return sharedAtlas;
}
const arc: ArcTarget = {
  show: (aim, eye) => {
    if (!arcStrokes && !strokeScene) buildArc(strokeAtlas());
    arcStrokes?.show(aim, eye);
  },
  hide: () => arcStrokes?.hide(),
};
const locomotion = createLocomotion({
  scene,
  camera,
  look: desktop,
  settings: toLocomotionSettings(settings),
  vignette: vignetteTarget,
  aimSource: () => rightController?.() ?? null,
  arc,
});
/** The XR teleport aim. Its controller slots must exist before a session starts. */
const rightController = runLocomotion ? trackRightController(renderer.xr, locomotion.rig) : null;
/** The settings panel's left laser (P5.3); the right one shares the teleport aim's space. */
const leftController = runLocomotion ? trackController(renderer.xr, locomotion.rig, 'left') : null;
/**
 * The reactive motion's disturbers (P4.5): the head, then both controller slots' target-ray
 * spaces, which trackRightController parented under the rig. The slots are read only while
 * presenting, where three hides an untracked one; on the desktop the eye is the only disturber.
 */
const controllerSpaces = runLocomotion
  ? Array.from({ length: CONTROLLER_SLOTS }, (_, i) => renderer.xr.getController(i))
  : [];
const disturberScratch = new Vector3();
const disturberPositions: ([number, number, number] | null)[] = [null, null, null];
const disturberSlots: [number, number, number][] = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];
/** World position of `object`, after the rig locomotion wrote this frame, into slot `slot`. */
function disturberAt(object: Object3D, slot: number): [number, number, number] {
  object.updateWorldMatrix(true, false);
  disturberScratch.setFromMatrixPosition(object.matrixWorld);
  const out = disturberSlots[slot];
  out[0] = disturberScratch.x;
  out[1] = disturberScratch.y;
  out[2] = disturberScratch.z;
  return out;
}
function trackDisturbers(time: number, presenting: boolean): void {
  disturberPositions[0] = disturberAt(camera, 0);
  for (let i = 0; i < CONTROLLER_SLOTS; i += 1) {
    const space = controllerSpaces[i];
    disturberPositions[i + 1] = presenting && space?.visible ? disturberAt(space, i + 1) : null;
  }
  locomotion.rig.updateWorldMatrix(true, false);
  reactiveTracker.frame(
    time,
    disturberPositions,
    locomotion.discontinuities(),
    locomotion.rig.matrixWorld.elements,
  );
}
// The system recenter resets the reference space, so the head and the controllers jump.
renderer.xr.addEventListener('sessionstart', () => {
  renderer.xr.getReferenceSpace()?.addEventListener('reset', () => locomotion.markDiscontinuity());
});
/** Drawn strokes whose rest centre is inside the reactive box: the strokes that pay its loops. */
let reactiveBatch: StrokeBatch | null = null;
function reactiveBoxStrokes(): number | null {
  const batch = reactiveBatch;
  if (!batch) return null;
  const p: [number, number, number] = [0, 0, 0];
  let n = 0;
  for (const chunk of batch.chunks) {
    const a = chunk.geometry.getAttribute('iPosition').array;
    for (let i = 0; i < chunk.drawCount; i += 1) {
      p[0] = a[3 * i];
      p[1] = a[3 * i + 1];
      p[2] = a[3 * i + 2];
      if (insideReactiveBox(reactiveTracker.uniforms, p)) n += 1;
    }
  }
  return n;
}
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
// The quality picks the rate (72 Hz for adaptive-72 and max beauty, 90 for adaptive-90, `?hz`
// over an adaptive one); the bench ignores the quality and keeps its own frame-rate controls. The
// quality setting applies at the next XR entry: the session request and the governor's reset at
// session start read it then (P5.3).
const benchless = (quality: QualityMode): QualityMode | null =>
  flags.bench === null ? quality : null;
const isBeauty = (quality: QualityMode): boolean => benchless(quality) === 'beauty-72';
const targetFrameRateFor = (quality: QualityMode): number =>
  resolveTargetFrameRate(flags.hz, benchless(quality));
/** The rate the next XR entry requests. */
const nextTargetFrameRate = (): number => targetFrameRateFor(settingsStore.effective.quality);
/** The quality the current or last XR session started with; the boot's until then. */
let sessionQuality: QualityMode = settings.quality;
const session = createSessionController({
  renderer,
  xr: navigator.xr,
  notify: (message) => showNotice(message),
  clearNotices: () => clearNotices(),
  get targetFrameRate() {
    return nextTargetFrameRate();
  },
});

window.addEventListener('resize', () => {
  camera.aspect = painterView ? painterView.aspect : window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/**
 * `?zdiag=<mode>`, honoured in production like `?slow` (src/render/zdiag.ts). Its precompile, for
 * the A/B button, compiles against the desktop camera: a raw shader's program serves XR too.
 */
const zdiag = createZdiag(flags.zdiag, renderer, (object) =>
  renderer.compile(object, camera, scene),
);

/** The halo pass: `?nohalo` clears it, and the `halo` A/B group switches it at runtime. */
let haloOn = !flags.nohalo;
let haloWorld: WorldHandle | null = null;
function setHalo(on: boolean): void {
  haloOn = on;
  haloWorld?.setHalo?.(on);
}

/**
 * The A/B button's group (src/diag/ab.ts): `?ab`, or the group an older A/B flag implies. With
 * neither, no group is built and the frame loop does no A/B work. The bench ignores it.
 */
// `?ab=calm` starts at the session's effective calm, not at 1, so the boot does not change it.
const abResolution = resolveAb({ ...flags, calm: settings.calm });
if (abResolution.warnings.length > 0) console.warn(abResolution.warnings.join(' '));
const abActive = abResolution.activation;
const ab: AbController | null = abActive
  ? createAbController(
      createAbGroup(
        abActive.group,
        {
          zdiag,
          setHalo,
          setCalm: (calm) => motionClock.setCalm(calm),
          setWrap: (wrap) => motionVariants.setWrap(wrap),
        },
        abActive.variants,
      ),
      abActive.start,
    )
  : null;
/** The bound stroke batch, which the `wrap` diag key scans. */
let skyBatch: StrokeBatch | null = null;

/** The last switch's cost on the CPU: its apply, then the rest of that frame (`abSwitch` diag). */
let abSwitch: { variant: string; applyMs: number; frameMs: number | null } | null = null;
let abSwitchStart: number | null = null;

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
              get mode() {
                return isBeauty(settingsStore.effective.quality) ? 'beauty' : 'default';
              },
              get targetHz() {
                return nextTargetFrameRate();
              },
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
/** The world's spawn yaw: recenter turns the view back to it. The bare scene faces -Z. */
let spawnYaw = 0;
/**
 * The HUD's live visibility for the settings panels. Left X and H toggle it for the session only:
 * the panel's HUD toggle is the one owner of the stored setting.
 */
const hudLive: HudLive = {
  visible: () => hud?.visible ?? false,
  setVisible: (visible) => hud?.setVisible(visible),
};
/**
 * Recenter (P5.3), from both stick clicks held 1 s, R, or the panel's button: the view turns to the
 * world's spawn direction about the head, and the panel respawns in front of the head at its usable
 * scale. The turn counts as a discontinuity, so the reactive wake does not trail it.
 */
function recenter(): void {
  // A portal transition holds the rig still, its fly strokes and spawn heading included.
  if (!runLocomotion || switcher.busy) return;
  // A mode switch: the trigger or keys that pressed it report nothing until released, so the
  // panel button's trigger never reaches `select` once the panel resets its hands.
  input.suppressHeld();
  locomotion.faceYaw(spawnYaw);
  panel?.recenter();
}
/** The settings panel: XR while presenting, DOM on the desktop. None in the bench. */
const panel = runLocomotion
  ? createPanelToggle({
      locked: settingsStore.locks,
      clearPose: () => clearPanelPose(),
      onChange: () => input.suppressHeld(),
      onError: (error) => console.warn('settings panel failed to start', error),
      buildXr: async () => {
        const { createSettingsPanel } = await import('./ui/settings-panel');
        return createSettingsPanel({
          rig: locomotion.rig,
          camera,
          controller: (hand) => (hand === 'right' ? rightController : leftController)?.() ?? null,
          store: settingsStore,
          atlas: strokeAtlas(),
          recenter,
          gallery: galleryReturnCallback,
          sessionQuality: () => sessionQuality,
          hud: hudLive,
        });
      },
      buildDom: async () => {
        const { createSettingsDom } = await import('./ui/settings-dom');
        return createSettingsDom({
          store: settingsStore,
          recenter,
          gallery: galleryReturnCallback,
          onGalleryChange: onGalleryReturnChange,
          sessionQuality: () => sessionQuality,
          hud: hudLive,
          onClose: () => input.suppressHeld(),
        });
      },
    })
  : null;
// Live apply (P5.3): every change reaches the code that uses it at once; the store saves later.
settingsStore.subscribe((effective, key) =>
  applySettingsChange(effective, key, {
    setLocomotion: (next) => locomotion.setSettings(next),
    setCalm: (calm) => {
      motionClock.setCalm(calm);
      // The panel's calm moves the calm group's line with it when it lands on a variant.
      if (abActive?.group === 'calm') ab?.follow(String(calm));
    },
    hud: hud ? hudLive : null,
  }),
);
renderer.xr.addEventListener('sessionstart', () => {
  sessionQuality = settingsStore.effective.quality;
  panel?.sessionStart();
});
// XR exit saves the panel's pose against the last XR head pose, before the desktop look moves it.
renderer.xr.addEventListener('sessionend', () => panel?.sessionEnd());
/** A frame with no movement, turn, aim or toggle: what locomotion reads during a transition. */
function frozenActions(a: Actions): Actions {
  return {
    ...a,
    move: { x: 0, y: 0 },
    sprint: false,
    turn: { x: 0, snap: 0 },
    teleportAim: false,
    teleportCommit: false,
    flightToggle: false,
    vertical: 0,
  };
}
const headScratch = new Vector3();
let lastJump: unknown = null;
let lastHeadJumps = 0;
/** The head's world position after locomotion, and this frame's teleport, for the portals. */
function detectPortals(): void {
  camera.updateWorldMatrix(true, false);
  headScratch.setFromMatrixPosition(camera.matrixWorld);
  const rig = locomotion.diag();
  const jump = rig.lastTeleport;
  const teleported = jump !== null && jump !== lastJump;
  lastJump = jump;
  // A turn about the head leaves it in place, so a step on a snap turn's frame still tests.
  const count = locomotion.headJumps();
  const jumped = count !== lastHeadJumps;
  lastHeadJumps = count;
  switcher.detect({
    head: [headScratch.x, headScratch.y, headScratch.z],
    teleportTo: teleported && jump ? jump.to : null,
    jumped,
  });
}
function renderFrame(time: number): void {
  const workStart = performance.now();
  const dt = lastTime === 0 ? 0 : (time - lastTime) / 1000;
  const dtMs = lastTime === 0 ? 0 : time - lastTime;
  lastTime = time;
  slicer.frame();
  const sources = renderer.xr.isPresenting ? renderer.xr.getSession()?.inputSources : null;
  actions = input.read(sources, keyboard, dt);
  if (panel) {
    const presenting = renderer.xr.isPresenting;
    // The desktop toggles on keydown below, so a press between two frames still counts.
    if (actions.menu && presenting) panel.toggle(true);
    const held = panel.frame(presenting, actions, time);
    // A hand the panel holds selects and grips nothing else this frame, and a grabbing hand's stick
    // turns, pitches, rolls or pushes the panel instead of moving the rig.
    input.claim(held.left, held.right);
    input.holdSticks(held.sticks.left, held.sticks.right);
    // The guide's recovery: not while a grip holds anything.
    if (actions.recenter && !actions.grip.down && !held.left && !held.right) recenter();
  }
  // After the panel's claim, which takes back a left stick click that belongs to a panel gesture.
  if (ab && actions.abCycle) {
    abSwitchStart = performance.now();
    ab.cycle();
    abSwitch = {
      variant: ab.diag().variant,
      applyMs: performance.now() - abSwitchStart,
      frameMs: null,
    };
    // The DOM is invisible in immersive mode, so the HUD carries the switch, hidden or not.
    hud?.setVisible(true);
  }
  if (flags.slow > 0) busyWait(flags.slow);
  if (pinnedMotionTime === null) motionClock.frame(time);
  strokes.frame(time);
  world?.update(time / 1000, dt);
  if (!renderer.xr.isPresenting) desktop.update();
  if (runLocomotion) {
    switcher.frame(dtMs);
    const busy = switcher.busy;
    locomotion.frame(busy ? frozenActions(actions) : actions, renderer.xr.isPresenting);
    if (!busy) detectPortals();
    trackDisturbers(time, renderer.xr.isPresenting);
  }
  zdiag.beforeRender(camera);
  const renderStart = performance.now();
  renderer.render(scene, camera);
  const renderMs = performance.now() - renderStart;
  drawCalls = renderer.info.render.calls;
  if (abSwitchStart !== null && abSwitch) {
    abSwitch.frameMs = performance.now() - abSwitchStart;
    abSwitchStart = null;
  }
  hud?.frame(time, leftButtonPressed(sources, BUTTON_X));
  if (runLocomotion) switcher.endFrame(performance.now() - workStart, renderMs);
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
    // The rate the next XR entry requests: the quality setting applies then.
    get targetFrameRate() {
      return nextTargetFrameRate();
    },
  });
  const counter = createInputCounter(renderer.xr);
  registerDiag('input', () => ({
    selectstart: { ...counter.selectstart },
    actions: actions && structuredClone(actions),
  }));
  registerDiag('zdiag', () => zdiag.diag());
  registerDiag('ab', () => ab?.diag() ?? null);
  registerDiag('abSwitch', () => abSwitch && { ...abSwitch });
  registerDiag('draw', () => ({ calls: drawCalls, visibleChunks: strokes.visibleChunkCount() }));
  registerDiag('motion', () => motionClock.diag());
  registerDiag('variants', () => motionVariants.diag());
  if (abActive?.group === 'wrap' || flags.wrap !== null) {
    registerDiag('wrap', () =>
      skyBatch
        ? skyWrapStats(
            skyBatch,
            motionVariants.diag().wrap,
            motionClock.uniforms.uTime.value,
            pinnedMotionPhase,
            motionVariants.waveTurns(),
          )
        : null,
    );
  }
  registerDiag('settings', () => ({
    stored: settingsStore.stored,
    effective: settingsStore.effective,
    recovered: settingsRecovered,
    saves: settingsStore.saves,
    pending: settingsStore.pending,
  }));
  if (panel) registerDiag('panel', () => panel.diag());
  if (runLocomotion) {
    registerDiag('rig', () => locomotion.diag());
    registerDiag('reactive', () => ({
      ...reactiveTracker.diag(),
      boxStrokes: reactiveBoxStrokes(),
    }));
  }
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
// so no HUD is ever built there. A group named by `?ab` also starts it shown, so the HUD's build,
// font fetch and troika program land at boot, not on the first switch, and its line shows at once.
// A group implied by `?zdiag` or `?nohalo` does not: those flags drive byte-compared captures.
if (flags.bench === null) {
  const toggle = createHudToggle({
    visible: settings.hud || abShowsHudAtBoot(abActive, flags.ab),
    build: async () => {
      const { startPerfHud } = await import('./ui/perf-hud');
      return startPerfHud({
        camera,
        scene,
        xr: renderer.xr,
        get targetHz() {
          return targetFrameRateFor(
            renderer.xr.isPresenting ? sessionQuality : settingsStore.effective.quality,
          );
        },
        getGovernor: () => strokes.governorDiag(),
        getVisible: () => strokes.visibleCount(),
        getVisibleChunks: () => strokes.visibleChunkCount(),
        getAb: () => ab?.label() ?? null,
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
// M toggles the desktop DOM panel once per physical press (P5.3); in XR the `menu` action does.
window.addEventListener('keydown', (event) => {
  if (panel && event.code === 'KeyM' && !event.repeat && !renderer.xr.isPresenting) {
    panel.toggle(false);
  }
});

/** With two stroke scenes at once, the first batch to load is the one bound. */
function governStrokes(batch: StrokeBatch): Promise<void> {
  zdiag.applyToBatch(batch);
  skyBatch ??= batch;
  buildArc(batch.atlas);
  reactiveBatch ??= batch;
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

/** The registry's world loader for `id`: the gallery's, or a live painting's. */
function worldLoader(id: string): (() => Promise<WorldModule>) | null {
  if (id === GALLERY_ID) return GALLERY_WORLD.world;
  return PAINTINGS.find((p) => p.id === id)?.world ?? null;
}

/** The deps every world build gets; a transition's build also gets the slicer. */
function worldDeps(sliced: boolean, loadRaster: WorldDeps['loadRaster']): WorldDeps {
  return {
    scene,
    seed: flags.seed,
    loadRaster,
    nocache: flags.nocache,
    cache: flags.cache,
    debug: flags.diag ? (flags.bare ? 'bare' : flags.coverage ? 'coverage' : null) : null,
    halo: haloOn,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    atlas: strokeAtlas(),
    slicer: sliced ? slicer : undefined,
    plaqueFrame: () => slicer.nextFrame(),
  };
}

/** Binds a built world to everything that follows the active world, at boot and on a switch. */
function bindWorld({ id, module, handle }: LiveWorld): void {
  // Only a painting's world moves: the gallery, canvas demo, test scene and bench share its stroke
  // layers (R-P4f). `?motionlayers` (e2e builds only) can close layers, never open one.
  const only = import.meta.env.MODE === 'e2e' ? flags.motionlayers : null;
  const mask = only === null ? MOTION_LAYER_MASK : MOTION_LAYER_MASK & only;
  motionClock.setLayerMask(id === GALLERY_ID ? 0 : mask);
  haloWorld = handle;
  handle.setHalo?.(haloOn);
  if (abActive?.group === 'halo') {
    // A hidden halo has never drawn, so its program would link on the first switch to on.
    if (handle.halo) renderer.compile(handle.halo, camera, scene);
    if (!handle.setHalo) {
      console.warn(`A/B halo: world ${id} has no halo pass, so the halo group does nothing`);
    }
  }
  world = module;
  locomotion.setWorld(handle);
  const { batch } = handle;
  zdiag.applyToBatch(batch);
  skyBatch = batch;
  buildArc(batch.atlas);
  reactiveBatch = batch;
  void strokes.bind(batch);
  registerGalleryReturn(id === GALLERY_ID ? null : () => void switcher.go(GALLERY_ID, 'return'));
}

/** Releases every binding to the active world, before its module disposes it. */
function unbindWorld(): void {
  registerGalleryReturn(null);
  if (strokes.batch) void strokes.bind(null);
  world = null;
  haloWorld = null;
  reactiveBatch = null;
  skyBatch = null;
  // Drops the old world's handle, then holds the rig's height until the next world's ground binds.
  locomotion.setWorld(null);
  locomotion.awaitGround();
}

const switcher = createSwitcher({
  renderer,
  scene,
  camera,
  rig: locomotion.rig,
  slicer,
  atlas: strokeAtlas,
  build: async (id) => {
    const load = worldLoader(id);
    if (!load) throw new Error(`no world for ${id}`);
    const [module, { loadRaster }] = await Promise.all([load(), import('./demo/canvas/demo')]);
    const handle = await module.build(worldDeps(true, loadRaster));
    return { id, module, handle };
  },
  bind: bindWorld,
  unbind: unbindWorld,
  spawn: ({ position, yaw }) => {
    spawnYaw = yaw;
    locomotion.spawn(position[0], position[1], position[2], yaw);
  },
  bare: () => locomotion.setWorld(null),
  suppressInput: () => input.suppressHeld(),
  setVeil: setPortalVeil,
  calm: () => settingsStore.effective.calm,
  loadRaster: async (url) => (await import('./demo/canvas/demo')).loadRaster(url, false),
  now: () => performance.now(),
});
if (flags.diag) {
  registerDiag('painting', () => switcher.active?.id ?? null);
  registerDiag('portal', () => switcher.diag());
  window.__goghPortal = (id: string) => switcher.go(id, 'api');
  if (import.meta.env.MODE === 'e2e') {
    // Lets a spec draw the vignette sphere once, so its geometry uploads before a GPU baseline.
    window.__goghVeil = (alpha: number) => {
      if (!switcher.busy) setPortalVeil(alpha);
    };
  }
}
// G returns to the gallery from a world on the desktop, as the panel's button does (P5.5).
window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyG' && !event.repeat && !renderer.xr.isPresenting) {
    galleryReturnCallback()?.();
  }
});

if (worldEntry) {
  locomotion.awaitGround();
  const load = worldEntry.world;
  Promise.all([load(), import('./demo/canvas/demo')])
    .then(async ([module, { loadRaster }]) => {
      // Before build, which registers the `world` diag key that captures wait for.
      if (flags.diag && flags.painter) {
        painterView = module.painterCamera();
        applyPainterCamera(camera, locomotion.setPose, painterView);
      } else {
        const { position, yaw } = module.spawnPose();
        spawnYaw = yaw;
        locomotion.spawn(position[0], position[1], position[2], yaw);
      }
      const handle = await module.build(worldDeps(false, loadRaster));
      switcher.adopt({ id: worldEntry.id, module, handle });
    })
    .catch((error: unknown) => {
      locomotion.setWorld(null);
      console.warn(`world ${worldEntry.id} failed to start`, error);
    });
}

void isVrSupported(navigator.xr).then((supported) => {
  session.state.supported = supported;
  createEnterVrButton(supported, () => void session.enter());
});
