/**
 * When a hand pushes strokes (P4.5's reactive motion), the stroke rustle plays at it. The reactive
 * tracker emits no push event, so this reads its uniforms: a tracked hand (slots 1 and 2, the
 * controllers) that speeds up past `RUSTLE_SPEED` while within `RUSTLE_REACH` of a stroke
 * surface (the ground, a wall, or a free-standing mass such as the cypress) fires once, then
 * re-arms once it slows below `RUSTLE_REARM_SPEED`. The mixer rate-limits
 * what fires (`RUSTLE_MIN_INTERVAL_S`, `RUSTLE_MAX_VOICES`).
 */
import type { Capsule, Vec3 } from './placement';

/**
 * Metres: the rustle's reach round a stroke surface. It is the 0.6 m push radius hands had before
 * 2026-11-09, which a hand's push (`HAND_RADIUS`, 0.13 m) no longer matches: the cypress capsules
 * are coarse, so their margin needs it to cover every cypress vertex.
 */
export const RUSTLE_REACH = 0.6;

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

/** True when a point is within the push radius of a stroke surface of the active world. */
export type NearStrokes = (x: number, y: number, z: number) => boolean;

/**
 * Height above the ground, metres, up to which a `blocked` footprint counts as a wall: above the
 * tallest house (8 m) and the steeple (about 10.6 m above the church base).
 */
export const RUSTLE_WALL_TOP = 12;

function capsuleDistance(x: number, y: number, z: number, { a, b }: Capsule): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  const t =
    len2 > 0
      ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / len2))
      : 0;
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t, z - a[2] - dz * t);
}

/**
 * A point near the ground (within `RUSTLE_REACH` above or below it), where the world reports a
 * wall or footprint (`blocked`) below `RUSTLE_WALL_TOP`, or within `RUSTLE_REACH` of a stroke
 * mass (`masses`, such as the cypress).
 */
export function nearSurface(
  heightAt: (x: number, z: number) => number,
  blocked?: (x: number, z: number) => boolean,
  masses: readonly Capsule[] = [],
): NearStrokes {
  return (x, y, z) => {
    const above = y - heightAt(x, z);
    if (Math.abs(above) < RUSTLE_REACH) return true;
    if (above < RUSTLE_WALL_TOP && blocked?.(x, z)) return true;
    return masses.some((m) => capsuleDistance(x, y, z, m) < m.radius + RUSTLE_REACH);
  };
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
