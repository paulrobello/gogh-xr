import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { registerDiag, unregisterDiag } from '../diag/diag';
import { flags } from '../diag/flags';
import { resolveTargetFrameRate, type XrState } from '../xr/session';
import { type BenchConfig, defaultOrder, resolveBenchConfig, stepCount } from './config';
import { buildStrokeField, type StrokeField } from './field';
import { GpuTimer, type TimerGl } from './gpu-timer';
import { type BenchSnapshot, createHud, formatHudLines, HUD_INTERVAL_MS } from './hud';
import { lastEyeViewport } from './material';
import { FrameStats } from './stats';
import { buttonEdge, leftStickX, leftXPressed, stickStep } from './stick';

export interface BenchDeps {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  getXrState: () => XrState;
}

export interface BenchHandle {
  setCount(n: number): void;
  toggleMode(): void;
  snapshot(): BenchSnapshot;
  dispose(): void;
}

/** A HUD redraw disturbs two intervals: the canvas draw, then the texture upload next frame. */
export const HUD_EXCLUDED_INTERVALS = 2;

export function startBench(deps: BenchDeps, config?: BenchConfig): BenchHandle | null {
  const resolved = config ?? resolveBenchConfig(flags);
  if (!resolved) return null;
  const { renderer, scene, camera } = deps;
  const { sizePx, seed } = resolved;
  let { mode, order } = resolved;
  const targetFrameRate = resolveTargetFrameRate(flags.hz);
  let n = resolved.n;
  let field: StrokeField = buildStrokeField({ n, mode, order, sizePx, seed });
  scene.add(field.group);

  const stats = new FrameStats();
  const timer = new GpuTimer(renderer.getContext() as unknown as TimerGl);
  // Camera children only render when the camera is in the scene graph.
  const addedCamera = camera.parent === null;
  if (addedCamera) scene.add(camera);
  const hud = createHud(camera);
  let armed = true;
  let xDown = false;
  let lastHud = Number.NEGATIVE_INFINITY;

  function snapshot(): BenchSnapshot {
    return {
      n,
      mode,
      order,
      sizePx,
      viewport: lastEyeViewport(),
      chunks: field.meshes.length,
      instances: field.instanceCount(),
      fps: stats.fps(),
      meanMs: stats.meanMs(),
      p99Ms: stats.p99Ms(),
      settling: stats.settling(),
      gpuTimer: timer.available ? 'available' : 'unavailable',
      gpuMs: timer.meanMs(),
    };
  }

  function rebuild(): void {
    field.dispose();
    field = buildStrokeField({ n, mode, order, sizePx, seed });
    scene.add(field.group);
    stats.reset();
    timer.reset();
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

  function drawHud(now: number): void {
    if (now - lastHud < HUD_INTERVAL_MS) return;
    lastHud = now;
    stats.exclude(HUD_EXCLUDED_INTERVALS);
    timer.excludeNext();
    const xr = deps.getXrState();
    hud.draw(
      formatHudLines(snapshot(), {
        target: targetFrameRate,
        current: xr.frameRate,
        supported: xr.supportedFrameRates,
      }),
    );
  }

  const prevBefore = scene.onBeforeRender;
  const prevAfter = scene.onAfterRender;
  scene.onBeforeRender = (...args) => {
    prevBefore.apply(scene, args);
    stats.record(performance.now());
    timer.begin();
  };
  scene.onAfterRender = (...args) => {
    timer.end();
    prevAfter.apply(scene, args);
    if (renderer.xr.isPresenting) {
      const sources = renderer.xr.getSession()?.inputSources;
      const result = stickStep(armed, leftStickX(sources));
      armed = result.armed;
      if (result.step !== 0) setCount(stepCount(n, result.step));
      const press = buttonEdge(xDown, leftXPressed(sources));
      xDown = press.down;
      if (press.fired) toggleMode();
    }
    drawHud(performance.now());
  };

  registerDiag('bench', snapshot);

  return {
    setCount,
    toggleMode,
    snapshot,
    dispose: () => {
      scene.onBeforeRender = prevBefore;
      scene.onAfterRender = prevAfter;
      unregisterDiag('bench');
      field.dispose();
      hud.dispose();
      timer.dispose();
      if (addedCamera && camera.parent === scene) scene.remove(camera);
    },
  };
}
