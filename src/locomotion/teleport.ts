/**
 * The teleport core (P3.4), pure like step.ts: a ballistic arc from an aim ray, its first landing
 * on the ground, whether that landing is valid, the jump itself and the blink that hides it.
 * `traceArc` runs every frame while the aim is held. It writes into a reused `ArcResult`, and its
 * only allocation per call is its small `clearance` closure.
 *
 * World: metres, +Y up. The aim ray is in world space; locomotion.ts turns the right controller's
 * target ray (XR) or the camera's view (desktop) into it.
 */
import type { Vec3 } from '../render/strokes/frame';
import type { LocomotionSettings } from './settings';
import type { HeadPose, LocomotionState } from './step';

/** Launch speed along the aim, m/s. */
export const LAUNCH_SPEED = 8;
/** m/s². */
export const GRAVITY = 9.8;
/** The arc ends this far from its origin horizontally, metres. A landing beyond it is no landing. */
export const MAX_RANGE = 15;
/** Arc samples, origin included. */
export const MAX_SAMPLES = 40;
/** The arc also ends after this long in flight, seconds: it bounds a shot with no horizontal reach. */
export const MAX_FLIGHT_TIME = 3;
/** Bisection steps that refine the hit between the last sample above ground and the first below. */
export const BISECT_STEPS = 24;
/** A landing is valid on ground whose normal is less than this far off +Y, degrees. */
export const MAX_SLOPE_DEG = 35;
/**
 * A landing is rejected where `boundaryFactor` is above this. The factor is exactly 0 inside the
 * 45 m start of its ramp, which is also where the haze shell starts, and P3.5 pushes back from 0.8,
 * so 0 keeps every landing out of the haze and off the ramp. It is also an exact test.
 */
export const BOUNDARY_LIMIT = 0;
/** Seconds of the fade to black before the jump, and of the fade back after it. */
export const BLINK_DOWN = 0.09;
export const BLINK_UP = 0.09;

const COS_MAX_SLOPE = Math.cos((MAX_SLOPE_DEG * Math.PI) / 180);
/** Absorbs float error when summing frame dts toward a blink phase. */
const BLINK_EPSILON = 1e-9;
const UP: Vec3 = Object.freeze([0, 1, 0]) as Vec3;

/** Why a landing is or is not valid. `none`: the arc reached no ground. */
export type LandingReason = 'slope' | 'boundary' | 'footprint' | 'none' | 'ok';

export interface LandingGround {
  heightAt(x: number, z: number): number;
  /** Unit upward normal at (x, z). */
  normalAt(x: number, z: number): Vec3;
}

/** What a landing is tested against. A painting's `WorldHandle` is one. */
export interface LandingWorld {
  readonly ground: LandingGround;
  /** 0 inside the world, rising toward its edge. Omitted: no boundary. */
  boundaryFactor?(position: Vec3): number;
  /** True inside a building footprint. Omitted: no footprints. */
  blocked?(x: number, z: number): boolean;
}

/** No world bound: the flat floor at y = 0, with no boundary and no footprints. */
export const FLAT_WORLD: LandingWorld = Object.freeze({
  ground: Object.freeze({ heightAt: () => 0, normalAt: () => UP }),
});

export interface ArcResult {
  /** Sample positions, xyz interleaved, world metres. The first `count` are live. */
  readonly points: Float64Array;
  /** Live samples: the origin first, and the hit last when there is one. */
  count: number;
  /** The landing, on the ground, or null when the arc reaches none. Always `landing` when set. */
  hit: [number, number, number] | null;
  /** Storage for `hit`, so a trace allocates nothing. Read `hit`, not this. */
  readonly landing: [number, number, number];
  /** The ground normal at the hit; meaningful only while `hit` is set. */
  readonly normal: [number, number, number];
  valid: boolean;
  reason: LandingReason;
}

export function createArcResult(): ArcResult {
  return {
    points: new Float64Array(MAX_SAMPLES * 3),
    count: 0,
    hit: null,
    landing: [0, 0, 0],
    normal: [0, 1, 0],
    valid: false,
    reason: 'none',
  };
}

function noLanding(out: ArcResult): void {
  out.hit = null;
  out.valid = false;
  out.reason = 'none';
}

/** The landing's validity: the boundary first, then a footprint, then the slope. */
function landingReason(world: LandingWorld, hit: Vec3, normal: Vec3): LandingReason {
  if (world.boundaryFactor && world.boundaryFactor(hit) > BOUNDARY_LIMIT) return 'boundary';
  if (world.blocked?.(hit[0], hit[2])) return 'footprint';
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(normal[1] > COS_MAX_SLOPE * length)) return 'slope';
  return 'ok';
}

/**
 * Traces the arc launched from `origin` along `direction` (any length) at `LAUNCH_SPEED` into
 * `out`. The search samples evenly in time over the flight to the range cap, or to
 * `MAX_FLIGHT_TIME` when the cap is further. The first sample at or below the ground ends the arc:
 * the time between it and the sample before is bisected, and the hit is that point dropped exactly
 * onto the ground. A landed arc is then resampled evenly over its flight to the hit, so a short or
 * steep-down arc still has `MAX_SAMPLES` points to draw.
 */
export function traceArc(out: ArcResult, origin: Vec3, direction: Vec3, world: LandingWorld): void {
  const points = out.points;
  const [ox, oy, oz] = origin;
  points[0] = ox;
  points[1] = oy;
  points[2] = oz;
  out.count = 1;
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  const ground = world.ground;
  if (!(length > 0) || oy < ground.heightAt(ox, oz)) {
    noLanding(out);
    return;
  }
  const k = LAUNCH_SPEED / length;
  const vx = direction[0] * k;
  const vy = direction[1] * k;
  const vz = direction[2] * k;
  const vh = Math.hypot(vx, vz);
  const end = vh > 0 ? Math.min(MAX_FLIGHT_TIME, MAX_RANGE / vh) : MAX_FLIGHT_TIME;
  const dt = end / (MAX_SAMPLES - 1);
  const halfG = GRAVITY / 2;
  /** Height above the ground at time t; positive above it. */
  const clearance = (t: number): number =>
    oy + vy * t - halfG * t * t - ground.heightAt(ox + vx * t, oz + vz * t);

  for (let i = 1; i < MAX_SAMPLES; i += 1) {
    const t = i * dt;
    const x = ox + vx * t;
    const y = oy + vy * t - halfG * t * t;
    const z = oz + vz * t;
    if (y > ground.heightAt(x, z)) {
      points[i * 3] = x;
      points[i * 3 + 1] = y;
      points[i * 3 + 2] = z;
      out.count = i + 1;
      continue;
    }
    let lo = t - dt;
    let hi = t;
    for (let step = 0; step < BISECT_STEPS; step += 1) {
      const mid = (lo + hi) / 2;
      if (clearance(mid) > 0) lo = mid;
      else hi = mid;
    }
    const th = (lo + hi) / 2;
    const hit = out.landing;
    hit[0] = ox + vx * th;
    hit[2] = oz + vz * th;
    hit[1] = ground.heightAt(hit[0], hit[2]);
    const step = th / (MAX_SAMPLES - 1);
    for (let j = 1; j < MAX_SAMPLES - 1; j += 1) {
      const tj = j * step;
      points[j * 3] = ox + vx * tj;
      points[j * 3 + 1] = oy + vy * tj - halfG * tj * tj;
      points[j * 3 + 2] = oz + vz * tj;
    }
    const last = (MAX_SAMPLES - 1) * 3;
    points[last] = hit[0];
    points[last + 1] = hit[1];
    points[last + 2] = hit[2];
    out.count = MAX_SAMPLES;
    const normal = ground.normalAt(hit[0], hit[2]);
    out.normal[0] = normal[0];
    out.normal[1] = normal[1];
    out.normal[2] = normal[2];
    out.hit = hit;
    out.reason = landingReason(world, hit, normal);
    out.valid = out.reason === 'ok';
    return;
  }
  noLanding(out);
}

/**
 * The jump: moves the rig so the head's world XZ lands on `hit`, keeping the yaw, and puts it
 * straight onto the hit's ground. Ground follow restarts from there instead of easing from the old
 * ground, and a held rig is released.
 */
export function teleportRig(
  state: LocomotionState,
  head: HeadPose,
  hit: Vec3,
  settings: LocomotionSettings,
): void {
  const sin = Math.sin(state.yaw);
  const cos = Math.cos(state.yaw);
  // The inverse of the head's world XZ in step.ts: rig = hit − R(yaw)·(head.x, head.z).
  state.position[0] = hit[0] - (cos * head.x + sin * head.z);
  state.position[2] = hit[2] - (-sin * head.x + cos * head.z);
  state.groundY = hit[1];
  state.position[1] = hit[1] + (settings.seated ? state.seatedOffset : 0);
  state.held = false;
  state.grounded = true;
}

/** The blink on a jump: a fade to black, the jump at full black, a fade back. */
export interface Blink {
  /** Full-view black, 0-1, for this frame. */
  fade: number;
  /** False once the fade back has finished. */
  active: boolean;
  /** True while fading down toward the jump. */
  down: boolean;
  /** Seconds into the current phase. */
  elapsed: number;
}

export function createBlink(): Blink {
  return { fade: 0, active: false, down: false, elapsed: 0 };
}

/** Starts a blink from clear. The fade begins on the next `stepBlink`. */
export function startBlink(blink: Blink): void {
  blink.fade = 0;
  blink.active = true;
  blink.down = true;
  blink.elapsed = 0;
}

/**
 * One frame. Returns true on the one frame the jump happens: the first at or past `BLINK_DOWN`,
 * which renders at fade 1. The fade back starts from the next frame.
 */
export function stepBlink(blink: Blink, dt: number): boolean {
  if (!blink.active) {
    blink.fade = 0;
    return false;
  }
  blink.elapsed += dt > 0 ? dt : 0;
  if (blink.down) {
    if (blink.elapsed >= BLINK_DOWN - BLINK_EPSILON) {
      blink.down = false;
      blink.elapsed = 0;
      blink.fade = 1;
      return true;
    }
    blink.fade = blink.elapsed / BLINK_DOWN;
    return false;
  }
  if (blink.elapsed >= BLINK_UP - BLINK_EPSILON) {
    blink.active = false;
    blink.fade = 0;
    return false;
  }
  blink.fade = 1 - blink.elapsed / BLINK_UP;
  return false;
}
