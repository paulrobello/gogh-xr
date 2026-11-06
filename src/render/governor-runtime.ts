/**
 * Runs the quality governor (`governor.ts`) for a stroke batch while an XR session presents, and
 * applies its changes through adapters: band density and size on the batch, framebuffer scale
 * through `XRView.requestViewportScale` (ruling R4), foveation on three's XR manager, and the
 * 72 Hz fallback through `XRSession.updateTargetFrameRate`. Desktop frames are not judged: the
 * page's own refresh rate says nothing about the headset budget.
 */
import type { Scene } from 'three';
import { GpuTimer, type TimerGl } from '../bench/gpu-timer';
import { registerDiag, unregisterDiag } from '../diag/diag';
import {
  installViewportScale,
  type ViewportScalePath,
  type ViewportScaler,
} from '../xr/viewport-scale';
import {
  createGovernor,
  type Governor,
  type GovernorEvent,
  type GovernorMode,
  type GovernorSnapshot,
  RATE_NOTICE,
} from './governor';
import { STROKE_BANDS, type StrokeBand } from './strokes/bands';
import type { StrokeBatch } from './strokes/batch';

/** The parts of three's `WebXRManager` the runtime uses. */
export interface GovernorXr {
  readonly isPresenting: boolean;
  addEventListener(type: 'sessionstart' | 'sessionend', listener: () => void): void;
  removeEventListener(type: 'sessionstart' | 'sessionend', listener: () => void): void;
  getSession(): Pick<XRSession, 'updateTargetFrameRate'> | null;
  setFoveation(value: number): void;
  getBaseLayer(): unknown;
  getBinding(): unknown;
}

export interface GovernorRenderer {
  readonly xr: GovernorXr;
  getContext(): unknown;
}

export type GovernedBatch = Pick<StrokeBatch, 'setDensity' | 'setSizeMultiplier' | 'stats'>;

export interface GovernorRuntimeDeps {
  renderer: GovernorRenderer;
  /** GPU timing hooks chain onto its `onBeforeRender` and `onAfterRender`. */
  scene: Scene;
  batch: GovernedBatch;
  mode: GovernorMode;
  targetHz: number;
  /** Shows the 72 Hz notice to the user. */
  notify?: (message: string) => void;
}

/** The `governor` diag key. `fbScale` reads 'unavailable' when the adapter cannot apply it. */
export interface GovernorDiag extends Omit<GovernorSnapshot, 'fbScale'> {
  fbScale: number | 'unavailable';
  /** Which viewport query the framebuffer-scale adapter wraps; null outside a session. */
  fbScalePath: ViewportScalePath | null;
  gpuTimer: 'available' | 'unavailable';
}

export interface GovernorRuntime {
  /** Call once per animation frame with the frame timestamp, before rendering. */
  frame(time: number): void;
  diag(): GovernorDiag;
  dispose(): void;
}

function bandOfStep(step: GovernorEvent['step']): StrokeBand | null {
  for (const band of STROKE_BANDS) if (step === `${band}-density`) return band;
  return null;
}

export function startGovernor(deps: GovernorRuntimeDeps): GovernorRuntime {
  const { renderer, scene, batch } = deps;
  const xr = renderer.xr;
  const config = { mode: deps.mode, targetHz: deps.targetHz };
  let governor: Governor = createGovernor(config);
  let scaler: ViewportScaler | null = null;
  let lastTime: number | null = null;
  const timer = new GpuTimer(renderer.getContext() as TimerGl);

  function applyLevels(): void {
    const { density, size, foveation } = governor.levels;
    for (const band of STROKE_BANDS) {
      batch.setDensity(band, density[band]);
      batch.setSizeMultiplier(band, size[band]);
    }
    if (scaler) scaler.scale = governor.levels.fbScale;
    if (xr.isPresenting) xr.setFoveation(foveation);
  }

  function apply(event: GovernorEvent): void {
    const levels = governor.levels;
    const band = bandOfStep(event.step);
    if (band) {
      batch.setDensity(band, levels.density[band]);
      batch.setSizeMultiplier(band, levels.size[band]);
    } else if (event.step === 'fb-scale') {
      if (scaler) scaler.scale = levels.fbScale;
    } else if (event.step === 'foveation') {
      xr.setFoveation(levels.foveation);
    } else {
      const session = xr.getSession();
      console.info(`[governor] ${RATE_NOTICE} (${event.from} Hz overran at minimum quality)`);
      deps.notify?.(RATE_NOTICE);
      if (session && typeof session.updateTargetFrameRate === 'function') {
        session.updateTargetFrameRate(event.to).catch((error: unknown) => {
          console.warn(`updateTargetFrameRate(${event.to}) failed: ${String(error)}`);
        });
      }
    }
  }

  /** Every session starts from full quality at the configured rate. */
  function reset(): void {
    scaler?.uninstall();
    scaler = xr.isPresenting ? installViewportScale(xr) : null;
    governor = createGovernor(config);
    lastTime = null;
    timer.reset();
    applyLevels();
  }

  const onStart = (): void => reset();
  const onEnd = (): void => reset();
  xr.addEventListener('sessionstart', onStart);
  xr.addEventListener('sessionend', onEnd);
  reset();

  const prevBefore = scene.onBeforeRender;
  const prevAfter = scene.onAfterRender;
  scene.onBeforeRender = function (this: Scene, ...args) {
    prevBefore.apply(this, args);
    if (xr.isPresenting) timer.begin();
  };
  scene.onAfterRender = function (this: Scene, ...args) {
    timer.end();
    prevAfter.apply(this, args);
  };

  function diag(): GovernorDiag {
    const snap = governor.snapshot();
    return {
      ...snap,
      fbScale: scaler?.path === 'unavailable' ? 'unavailable' : snap.fbScale,
      fbScalePath: scaler?.path ?? null,
      gpuTimer: timer.available ? 'available' : 'unavailable',
    };
  }
  registerDiag('governor', diag);

  return {
    frame(time: number) {
      if (!xr.isPresenting) {
        lastTime = null;
        return;
      }
      if (lastTime === null) {
        lastTime = time;
        return;
      }
      const intervalMs = time - lastTime;
      lastTime = time;
      const { bands } = batch.stats();
      const event = governor.sample({
        t: time,
        intervalMs,
        gpuMs: timer.available ? timer.meanMs() : null,
        drawn: { near: bands.near.visible, mid: bands.mid.visible, far: bands.far.visible },
      });
      if (event) apply(event);
    },
    diag,
    dispose() {
      xr.removeEventListener('sessionstart', onStart);
      xr.removeEventListener('sessionend', onEnd);
      scene.onBeforeRender = prevBefore;
      scene.onAfterRender = prevAfter;
      scaler?.uninstall();
      scaler = null;
      timer.dispose();
      unregisterDiag('governor');
    },
  };
}
