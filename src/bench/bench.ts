import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { registerDiag, unregisterDiag } from '../diag/diag';
import { flags } from '../diag/flags';
import { resolveTargetFrameRate, type XrState } from '../xr/session';
import { type BenchConfig, resolveBenchConfig, stepCount } from './config';
import { buildStrokeField, type StrokeField } from './field';
import { GpuTimer, type TimerGl } from './gpu-timer';
import { type BenchSnapshot, createHud, formatHudLines, HUD_INTERVAL_MS } from './hud';
import { lastEyeViewport } from './material';
import { FrameStats } from './stats';
import { leftStickX, stickStep } from './stick';

export interface BenchDeps {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  getXrState: () => XrState;
}

export interface BenchHandle {
  setCount(n: number): void;
  snapshot(): BenchSnapshot;
  dispose(): void;
}

/** A HUD redraw disturbs two intervals: the canvas draw, then the texture upload next frame. */
export const HUD_EXCLUDED_INTERVALS = 2;

export function startBench(deps: BenchDeps, config?: BenchConfig): BenchHandle | null {
  const resolved = config ?? resolveBenchConfig(flags);
  if (!resolved) return null;
  const { renderer, scene, camera } = deps;
  const { mode, order, sizePx, seed } = resolved;
  const targetFrameRate = resolveTargetFrameRate(flags.hz);
  let n = resolved.n;
  let field: StrokeField = buildStrokeField({ n, mode, order, sizePx, seed });
  scene.add(field.group);

  const stats = new FrameStats();
  const timer = new GpuTimer(renderer.getContext() as unknown as TimerGl);
  // Camera children only render when the camera is in the scene graph.
  if (camera.parent === null) scene.add(camera);
  const hud = createHud(camera);
  let armed = true;
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

  function setCount(next: number): void {
    const clamped = Math.max(0, Math.floor(next));
    if (clamped === n) return;
    field.dispose();
    n = clamped;
    field = buildStrokeField({ n, mode, order, sizePx, seed });
    scene.add(field.group);
    stats.reset();
    timer.reset();
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
      const result = stickStep(armed, leftStickX(renderer.xr.getSession()?.inputSources));
      armed = result.armed;
      if (result.step !== 0) setCount(stepCount(n, result.step));
    }
    drawHud(performance.now());
  };

  registerDiag('bench', snapshot);

  return {
    setCount,
    snapshot,
    dispose: () => {
      scene.onBeforeRender = prevBefore;
      scene.onAfterRender = prevAfter;
      unregisterDiag('bench');
      field.dispose();
      hud.dispose();
      timer.dispose();
    },
  };
}
