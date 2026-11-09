import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { registerDiag, unregisterDiag } from '../diag/diag';
import { flags } from '../diag/flags';
import { addAfterRender, addBeforeRender } from '../render/scene-hooks';
import { FOVEATION, resolveTargetFrameRate, type XrState } from '../xr/session';
import {
  type BenchConfig,
  defaultOrder,
  nextFoveation,
  nextFrameRate,
  resolveBenchConfig,
  stepCount,
} from './config';
import { buildStrokeField, type StrokeField } from './field';
import { GpuTimer, type TimerGl } from './gpu-timer';
import { type BenchSnapshot, createHud, formatHudLines, HUD_INTERVAL_MS } from './hud';
import { lastEyeViewport } from './material';
import {
  type BenchResult,
  formatResultLine,
  localResultStore,
  type ResultStore,
  upsertResult,
} from './results';
import { FrameStats } from './stats';
import {
  BUTTON_A,
  BUTTON_X,
  BUTTON_Y,
  buttonEdge,
  buttonPressed,
  leftButtonPressed,
  leftStickX,
  stickStep,
} from './stick';

export interface BenchDeps {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  getXrState: () => XrState;
  /** Where recorded results persist; defaults to localStorage. */
  results?: ResultStore;
}

export interface BenchHandle {
  setCount(n: number): void;
  toggleMode(): void;
  cycleFrameRate(): void;
  targetFrameRate(): number;
  cycleFoveation(): void;
  snapshot(): BenchSnapshot;
  results(): readonly BenchResult[];
  dispose(): void;
}

/** A HUD redraw disturbs two intervals: the canvas draw, then the texture upload next frame. */
export const HUD_EXCLUDED_INTERVALS = 2;
/** Recorded results shown under the live lines, newest last. */
export const HUD_RESULT_LINES = 6;

export function startBench(deps: BenchDeps, config?: BenchConfig): BenchHandle | null {
  const resolved = config ?? resolveBenchConfig(flags);
  if (!resolved) return null;
  const { renderer, scene, camera } = deps;
  const { sizePx, seed } = resolved;
  let { mode, order } = resolved;
  let targetFrameRate = resolveTargetFrameRate(flags.hz);
  let n = resolved.n;
  let field: StrokeField = buildStrokeField({ n, mode, order, sizePx, seed });
  scene.add(field.group);

  const store = deps.results ?? localResultStore(globalThis.localStorage);
  let results: BenchResult[] = store.load();
  // One record per settings change: set once the first full window after the change completes.
  let recorded = false;

  const stats = new FrameStats();
  const timer = new GpuTimer(renderer.getContext() as unknown as TimerGl);
  // Camera children only render when the camera is in the scene graph.
  const addedCamera = camera.parent === null;
  if (addedCamera) scene.add(camera);
  const hud = createHud(camera);
  let armed = true;
  let xDown = false;
  let yDown = false;
  let aDown = false;
  let foveation = FOVEATION;
  let lastHud = Number.NEGATIVE_INFINITY;

  function snapshot(): BenchSnapshot {
    return {
      n,
      mode,
      order,
      sizePx,
      foveation,
      viewport: lastEyeViewport(),
      chunks: field.meshes.length,
      instances: field.instanceCount(),
      fps: stats.fps(),
      meanMs: stats.meanMs(),
      p95Ms: stats.p95Ms(),
      p99Ms: stats.p99Ms(),
      settling: stats.settling(),
      gpuTimer: timer.available ? 'available' : 'unavailable',
      gpuMs: timer.meanMs(),
    };
  }

  function restartMeasurement(): void {
    stats.reset();
    timer.reset();
    recorded = false;
  }

  function rebuild(): void {
    field.dispose();
    field = buildStrokeField({ n, mode, order, sizePx, seed });
    scene.add(field.group);
    restartMeasurement();
  }

  function setCount(next: number): void {
    const clamped = Math.max(0, Math.floor(next));
    if (clamped === n) return;
    n = clamped;
    rebuild();
  }

  /** Switches a2c and blend; the order resets to the new mode's default, overriding `&order`. */
  function toggleMode(): void {
    mode = mode === 'a2c' ? 'blend' : 'a2c';
    order = defaultOrder(mode);
    rebuild();
  }

  /** Steps the requested rate through the session's supported rates; the HUD's current shows what applied. */
  function cycleFrameRate(): void {
    const session = renderer.xr.getSession();
    const next = nextFrameRate(targetFrameRate, deps.getXrState().supportedFrameRates);
    if (!session || typeof session.updateTargetFrameRate !== 'function' || next === targetFrameRate)
      return;
    targetFrameRate = next;
    restartMeasurement();
    session.updateTargetFrameRate(next).catch((error: unknown) => {
      console.warn(`updateTargetFrameRate(${next}) failed: ${String(error)}`);
    });
  }

  /** Steps fixed foveation 0 -> 0.5 -> 1 and wraps; a lower level costs more fragment work at the edges. */
  function cycleFoveation(): void {
    foveation = nextFoveation(foveation);
    renderer.xr.setFoveation(foveation);
    restartMeasurement();
  }

  /** Headset only: desktop frame timing says nothing about the Quest budget. */
  function recordIfSettled(): void {
    if (recorded || !renderer.xr.isPresenting || stats.settling()) return;
    recorded = true;
    const snap = snapshot();
    results = upsertResult(results, {
      mode: snap.mode,
      order: snap.order,
      n: snap.n,
      sizePx: snap.sizePx,
      targetHz: targetFrameRate,
      foveation,
      currentHz: deps.getXrState().frameRate,
      fps: snap.fps,
      meanMs: snap.meanMs,
      p95Ms: snap.p95Ms,
      p99Ms: snap.p99Ms,
      recordedAt: new Date().toISOString(),
    });
    store.save(results);
  }

  function drawHud(now: number): void {
    if (now - lastHud < HUD_INTERVAL_MS) return;
    lastHud = now;
    stats.exclude(HUD_EXCLUDED_INTERVALS);
    timer.excludeNext();
    const xr = deps.getXrState();
    const live = formatHudLines(snapshot(), {
      target: targetFrameRate,
      current: xr.frameRate,
      supported: xr.supportedFrameRates,
    });
    const recent = results.slice(-HUD_RESULT_LINES).map(formatResultLine);
    hud.draw(recent.length ? [...live, 'recorded (target/actual):', ...recent] : live);
  }

  const removeBefore = addBeforeRender(scene, () => {
    stats.record(performance.now());
    timer.begin();
  });
  const removeAfter = addAfterRender(scene, () => {
    timer.end();
    recordIfSettled();
    if (renderer.xr.isPresenting) {
      const sources = renderer.xr.getSession()?.inputSources;
      const result = stickStep(armed, leftStickX(sources));
      armed = result.armed;
      if (result.step !== 0) setCount(stepCount(n, result.step));
      const x = buttonEdge(xDown, leftButtonPressed(sources, BUTTON_X));
      xDown = x.down;
      if (x.fired) toggleMode();
      const y = buttonEdge(yDown, leftButtonPressed(sources, BUTTON_Y));
      yDown = y.down;
      if (y.fired) cycleFrameRate();
      const a = buttonEdge(aDown, buttonPressed(sources, 'right', BUTTON_A));
      aDown = a.down;
      if (a.fired) cycleFoveation();
    }
    drawHud(performance.now());
  });

  // Desktop stepping of N, as the left stick does in XR: [ lowers it, ] raises it.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'BracketRight') setCount(stepCount(n, 1));
    else if (event.code === 'BracketLeft') setCount(stepCount(n, -1));
  };
  window.addEventListener('keydown', onKeyDown);

  registerDiag('bench', snapshot);
  registerDiag('benchResults', () => results);

  return {
    setCount,
    toggleMode,
    cycleFrameRate,
    targetFrameRate: () => targetFrameRate,
    cycleFoveation,
    snapshot,
    results: () => results,
    dispose: () => {
      removeBefore();
      removeAfter();
      window.removeEventListener('keydown', onKeyDown);
      unregisterDiag('bench');
      unregisterDiag('benchResults');
      field.dispose();
      hud.dispose();
      timer.dispose();
      if (addedCamera && camera.parent === scene) scene.remove(camera);
    },
  };
}
