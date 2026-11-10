/**
 * When a hand pushes strokes (P4.5's reactive motion), the stroke rustle plays at it. The reactive
 * tracker emits no push event, so this reads its uniforms: a tracked hand (slots 1 and 2, the
 * controllers) that speeds up past `RUSTLE_SPEED` while within `RUSTLE_REACH` of a stroke the
 * world's stroke reach field holds (the ground, the walls and roofs, the cypress, the haze) fires
 * once, then re-arms once it slows below `RUSTLE_REARM_SPEED`. The mixer rate-limits what fires
 * (`RUSTLE_MIN_INTERVAL_S`, `RUSTLE_MAX_VOICES`).
 */
import { HAND_RADIUS } from '../motion/reactive';
import type { StrokeReach } from '../render/strokes/reach-field';
import type { Vec3 } from './placement';

/**
 * Metres: the rustle's reach, a hand's paint reach. The field measures it to each stroke's drawn
 * quad, as the reactive shader does, so the rustle fires exactly where the hand pushes paint.
 */
export const RUSTLE_REACH: number = HAND_RADIUS;

/** Hand speed, m/s, that fires a rustle. */
export const RUSTLE_SPEED = 0.6;
/** Hand speed, m/s, below which a hand that fired can fire again. */
export const RUSTLE_REARM_SPEED = 0.3;
/** The reactive tracker's hand slots: the two controllers (slot 0 is the head). */
export const RUSTLE_HAND_SLOTS: readonly number[] = [1, 2];

interface XyzW {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/** True when a point is within a hand's paint reach of a stroke of the active world. */
export type NearStrokes = (x: number, y: number, z: number) => boolean;

/** A point within `RUSTLE_REACH` of a stroke of `field`. */
export function nearStrokes(field: Pick<StrokeReach, 'distance'>): NearStrokes {
  return (x, y, z) => field.distance(x, y, z) < RUSTLE_REACH;
}

export interface RustleTrigger {
  /**
   * One frame of the tracker's disturbers (position xyz with strength w, velocity xyz) in slot
   * order. Returns the hand positions that fire this frame.
   */
  frame(positions: readonly XyzW[], velocities: readonly XyzW[], near: NearStrokes): Vec3[];
  reset(): void;
}

export function createRustleTrigger(): RustleTrigger {
  const armed = RUSTLE_HAND_SLOTS.map(() => true);
  return {
    frame(positions, velocities, near) {
      const fired: Vec3[] = [];
      RUSTLE_HAND_SLOTS.forEach((slot, i) => {
        const p = positions[slot];
        const v = velocities[slot];
        if (!p || !v || p.w <= 0) {
          armed[i] = true;
          return;
        }
        const speed = Math.hypot(v.x, v.y, v.z);
        if (!armed[i]) {
          if (speed < RUSTLE_REARM_SPEED) armed[i] = true;
          return;
        }
        if (speed >= RUSTLE_SPEED && near(p.x, p.y, p.z)) {
          armed[i] = false;
          fired.push([p.x, p.y, p.z]);
        }
      });
      return fired;
    },
    reset() {
      armed.fill(true);
    },
  };
}
