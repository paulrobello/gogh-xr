/**
 * Runs the quality governor (`governor.ts`) for a stroke batch while an XR session presents, and
 * applies its changes through adapters: band density and size on the batch, framebuffer scale
 * through `XRView.requestViewportScale` (ruling R4), fixed foveation through three's
 * `WebXRManager.setFoveation` (which sets the projection layer's `fixedFoveation` live), and the
 * 72 Hz fallback through `XRSession.updateTargetFrameRate`. A 'no-gain' undo, a 'recover' and a
 * 'recover-back' go through the same adapters. `xr/session.ts` sets foveation 0 after an awaited
 * frame-rate request at session start, which can land after a governor shed, so every judged frame
 * re-asserts the governor's foveation when three reports another. Desktop frames are not judged:
 * the page's own refresh rate says nothing about the headset budget.
 *
 * Quest Browser ignores `requestViewportScale` on the projection-layer path three 0.186 takes there
 * (`fbScaleApplied` reads 1 at a requested 0.85), so the fb-scale step buys nothing on the headset
 * and the no-gain rule holds it.
 *
 * The machine's budget follows the session's reported `frameRate`, read every judged frame (so it
 * picks up the rate once session settings apply) and on `frameratechange`. The requested rate is
 * the fallback while the session reports none. Frames are not judged while the session is not
 * 'visible'.
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
  densityBand,
  type Governor,
  type GovernorEvent,
  type GovernorMode,
  type GovernorSnapshot,
  RATE_NOTICE,
} from './governor';
import { addAfterRender, addBeforeRender } from './scene-hooks';
import { STROKE_BANDS } from './strokes/bands';
import type { StrokeBatch } from './strokes/batch';

/** The parts of an `XRSession` the runtime uses. `updateTargetFrameRate` may be missing. */
export type GovernorSession = Partial<Pick<XRSession, 'updateTargetFrameRate'>> &
  Pick<XRSession, 'frameRate' | 'visibilityState'> & {
    addEventListener(type: 'visibilitychange' | 'frameratechange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange' | 'frameratechange', listener: () => void): void;
  };

/** The parts of three's `WebXRManager` the runtime uses. */
export interface GovernorXr {
  readonly isPresenting: boolean;
  addEventListener(type: 'sessionstart' | 'sessionend', listener: () => void): void;
  removeEventListener(type: 'sessionstart' | 'sessionend', listener: () => void): void;
  getSession(): GovernorSession | null;
  getBaseLayer(): unknown;
  getBinding(): unknown;
  setFoveation(value: number): void;
  /** undefined outside a session. */
  getFoveation(): number | undefined;
}

export interface GovernorRenderer {
  readonly xr: GovernorXr;
  getContext(): unknown;
}

export type GovernedBatch = Pick<StrokeBatch, 'setDensity' | 'setSizeMultiplier' | 'visibleByBand'>;

export interface GovernorRuntimeDeps {
  renderer: GovernorRenderer;
  /** GPU timing hooks on its `onBeforeRender` and `onAfterRender`, through `scene-hooks.ts`. */
  scene: Scene;
  batch: GovernedBatch;
  mode: GovernorMode;
  /** The requested target; the budget uses the session's reported rate when it has one. */
  targetHz: number;
  /** Shows the 72 Hz notice to the user. */
  notify?: (message: string) => void;
}

/** The `governor` diag key. `fbScale` reads 'unavailable' when the adapter cannot apply it. */
export interface GovernorDiag extends Omit<GovernorSnapshot, 'fbScale'> {
  fbScale: number | 'unavailable';
  /**
   * The scale the runtime applied, measured from the returned viewport widths. For reporting only:
   * the governor counts the fb-scale step as taken either way. null until measured.
   */
  fbScaleApplied: number | null;
  /** Which viewport query the framebuffer-scale adapter wraps; null outside a session. */
  fbScalePath: ViewportScalePath | null;
  gpuTimer: 'available' | 'unavailable';
  /** Frames are judged: an XR session presents and is visible. Desktop frames never are. */
  judging: boolean;
}

export interface GovernorRuntime {
  /** Call once per animation frame with the frame timestamp, before rendering. */
  frame(time: number): void;
  diag(): GovernorDiag;
  dispose(): void;
}

export function startGovernor(deps: GovernorRuntimeDeps): GovernorRuntime {
  const { renderer, scene, batch } = deps;
  const xr = renderer.xr;
  const config = { mode: deps.mode, targetHz: deps.targetHz };
  let governor: Governor = createGovernor(config);
  let scaler: ViewportScaler | null = null;
  let session: GovernorSession | null = null;
  let lastTime: number | null = null;
  /** The rate asked of the session, used while it reports no `frameRate`. */
  let requestedHz = deps.targetHz;
  /** A rate request can settle after `dispose`; it must not notify or touch a disposed runtime. */
  let disposed = false;
  const timer = new GpuTimer(renderer.getContext() as TimerGl);

  function applyLevels(): void {
    const { density, size } = governor.levels;
    for (const band of STROKE_BANDS) {
      batch.setDensity(band, density[band]);
      batch.setSizeMultiplier(band, size[band]);
    }
    if (scaler) scaler.scale = governor.levels.fbScale;
    xr.setFoveation(governor.levels.foveation);
  }

  function readFrameRate(): void {
    governor.setFrameRate(session?.frameRate ?? requestedHz);
  }

  /** Commits the 72 Hz budget and notice only once the session accepts the rate. */
  function requestRate(event: GovernorEvent): void {
    const owner = governor;
    const target = session;
    const fail = (reason: string): void => {
      console.warn(`[governor] ${event.to} Hz fallback unavailable: ${reason}`);
      if (!disposed && owner === governor) owner.rateFailed(event.t);
    };
    if (!target || typeof target.updateTargetFrameRate !== 'function') {
      fail('the session has no updateTargetFrameRate');
      return;
    }
    target.updateTargetFrameRate(event.to).then(
      () => {
        if (disposed || owner !== governor) return;
        requestedHz = event.to;
        owner.rateApplied(event.to);
        owner.setFrameRate(target.frameRate ?? event.to);
        console.info(`[governor] ${RATE_NOTICE} (${event.from} Hz overran at minimum quality)`);
        deps.notify?.(RATE_NOTICE);
      },
      (error: unknown) => fail(`updateTargetFrameRate(${event.to}) failed: ${String(error)}`),
    );
  }

  function apply(event: GovernorEvent): void {
    const levels = governor.levels;
    const band = densityBand(event.step);
    if (band) {
      batch.setDensity(band, levels.density[band]);
      batch.setSizeMultiplier(band, levels.size[band]);
    } else if (event.step === 'fb-scale') {
      if (scaler) scaler.scale = levels.fbScale;
    } else if (event.step === 'foveation' || event.step === 'foveation-max') {
      xr.setFoveation(levels.foveation);
    } else if (event.action === 'rate') {
      requestRate(event);
    }
  }

  const onVisibility = (): void => {
    lastTime = null;
    governor.interrupt();
  };
  const onFrameRate = (): void => readFrameRate();

  /** Every session starts from full quality at the configured rate. */
  function reset(): void {
    session?.removeEventListener('visibilitychange', onVisibility);
    session?.removeEventListener('frameratechange', onFrameRate);
    scaler?.uninstall();
    session = xr.isPresenting ? xr.getSession() : null;
    session?.addEventListener('visibilitychange', onVisibility);
    session?.addEventListener('frameratechange', onFrameRate);
    scaler = xr.isPresenting ? installViewportScale(xr) : null;
    governor = createGovernor(config);
    requestedHz = deps.targetHz;
    lastTime = null;
    timer.reset();
    applyLevels();
  }

  const onStart = (): void => reset();
  const onEnd = (): void => reset();
  xr.addEventListener('sessionstart', onStart);
  xr.addEventListener('sessionend', onEnd);
  reset();

  const removeBefore = addBeforeRender(scene, () => {
    if (xr.isPresenting) timer.begin();
  });
  const removeAfter = addAfterRender(scene, () => timer.end());

  function judging(): boolean {
    return xr.isPresenting && (!session || session.visibilityState === 'visible');
  }

  function diag(): GovernorDiag {
    const snap = governor.snapshot();
    return {
      ...snap,
      fbScale: scaler?.path === 'unavailable' ? 'unavailable' : snap.fbScale,
      fbScaleApplied: scaler?.applied ?? null,
      fbScalePath: scaler?.path ?? null,
      gpuTimer: timer.available ? 'available' : 'unavailable',
      judging: judging(),
    };
  }
  registerDiag('governor', diag);

  return {
    frame(time: number) {
      if (!judging()) {
        lastTime = null;
        return;
      }
      if (lastTime === null) {
        lastTime = time;
        return;
      }
      const intervalMs = time - lastTime;
      lastTime = time;
      readFrameRate();
      const foveation = governor.levels.foveation;
      if (xr.getFoveation() !== foveation) xr.setFoveation(foveation);
      const event = governor.sample({
        t: time,
        intervalMs,
        gpuMs: timer.available ? timer.meanMs() : null,
        drawn: batch.visibleByBand(),
      });
      if (event) apply(event);
    },
    diag,
    dispose() {
      disposed = true;
      xr.removeEventListener('sessionstart', onStart);
      xr.removeEventListener('sessionend', onEnd);
      session?.removeEventListener('visibilitychange', onVisibility);
      session?.removeEventListener('frameratechange', onFrameRate);
      session = null;
      removeBefore();
      removeAfter();
      scaler?.uninstall();
      scaler = null;
      timer.dispose();
      unregisterDiag('governor');
    },
  };
}
