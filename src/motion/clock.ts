/**
 * The motion clock (P4.1, PRD D7): the uniforms every stroke motion reads. Motion is computed in
 * the vertex shader from these and each instance's layer and phase, with no stored simulation
 * state. Every stroke material shares one set of uniform objects by reference (`motionClock`), so
 * one write per frame reaches the batch's band materials and the teleport arc alike.
 *
 * Speed scales with calm here, on the CPU: `uTime` advances by `dt × calm`. Scaling the time in the
 * shader (`uTime * uCalm`) would jump every stroke by `t × Δcalm` whenever calm changed. Amplitude
 * scales with calm in the shader, once, where motion.glsl dispatches on the layer.
 */
import { MOTION_LAYER_MASK } from './motion';

/** `uTime` wraps at this many seconds, to keep float precision. Motion periods should divide it. */
export const MOTION_TIME_WRAP_S = 3600;
/** Longest frame step the clock advances by: a stalled tab resumes where it left off. */
export const MAX_MOTION_DT_S = 0.1;

export interface MotionUniforms {
  [name: string]: { value: unknown };
  /** Motion time in seconds: animation-frame time scaled by calm, held while frozen, wrapped. */
  uTime: { value: number };
  /** Calm, 0-1 (1 is full motion): the shader multiplies every motion amplitude by it. */
  uCalm: { value: number };
  /**
   * 1 while frozen (`?noanim`), else 0. No shader reads it: freezing also clears `uMotionLayers`,
   * so frozen strokes sit at rest, which keeps `?noanim` captures identical to the static world.
   */
  uFreeze: { value: number };
  /**
   * The motion gate, one bit per stroke layer (bit `STROKE_LAYER.x`): the layers whose motion
   * runs this frame. 0 when frozen or at calm 0, else `MOTION_LAYER_MASK`. A stroke whose bit is
   * clear pays one AND, compare and branch, and no motion maths.
   */
  uMotionLayers: { value: number };
}

export interface MotionState {
  /** `uTime`, seconds. */
  readonly time: number;
  readonly calm: number;
  readonly frozen: boolean;
}

export interface MotionClock {
  readonly uniforms: MotionUniforms;
  /** Advances the clock to animation-frame time `timeMs` (the `requestAnimationFrame` stamp). */
  frame(timeMs: number): void;
  /** Clamped to 0-1; a non-finite value means 1. */
  setCalm(calm: number): void;
  setFrozen(frozen: boolean): void;
  diag(): MotionState;
}

export interface MotionClockOptions {
  readonly calm?: number;
  readonly frozen?: boolean;
  /** The layers whose motion is live; `MOTION_LAYER_MASK` by default. */
  readonly layerMask?: number;
}

export function clampCalm(calm: number): number {
  return Number.isFinite(calm) ? Math.min(1, Math.max(0, calm)) : 1;
}

export function createMotionClock(options: MotionClockOptions = {}): MotionClock {
  const layerMask = options.layerMask ?? MOTION_LAYER_MASK;
  const uniforms: MotionUniforms = {
    uTime: { value: 0 },
    uCalm: { value: 1 },
    uFreeze: { value: 0 },
    uMotionLayers: { value: 0 },
  };
  let calm = 1;
  let frozen = false;
  let lastMs: number | null = null;
  const sync = (): void => {
    uniforms.uCalm.value = calm;
    uniforms.uFreeze.value = frozen ? 1 : 0;
    uniforms.uMotionLayers.value = frozen || calm <= 0 ? 0 : layerMask;
  };
  const clock: MotionClock = {
    uniforms,
    frame(timeMs) {
      const dt =
        lastMs === null ? 0 : Math.min(MAX_MOTION_DT_S, Math.max(0, (timeMs - lastMs) / 1000));
      lastMs = timeMs;
      if (frozen || dt === 0 || calm <= 0) return;
      uniforms.uTime.value = (uniforms.uTime.value + dt * calm) % MOTION_TIME_WRAP_S;
    },
    setCalm(value) {
      calm = clampCalm(value);
      sync();
    },
    setFrozen(value) {
      frozen = value;
      sync();
    },
    diag: () => ({ time: uniforms.uTime.value, calm, frozen }),
  };
  clock.setCalm(options.calm ?? 1);
  clock.setFrozen(options.frozen ?? false);
  return clock;
}

/** The app's one clock, whose uniforms every stroke material shares. main.ts drives it. */
export const motionClock: MotionClock = createMotionClock();
