/**
 * The teleport core (P3.4), pure like step.ts: a ballistic arc from an aim ray, its first landing
 * on the ground, whether that landing is valid, the jump itself and the blink that hides it.
 * `traceArc` runs every frame while the aim is held. It writes into a reused `ArcResult` and keeps its
 * working state in the module-level `T`, so it allocates nothing.
 *
 * World: metres, +Y up. The aim ray is in world space; locomotion.ts turns the right controller's
 * target ray (XR) or the camera's view (desktop) into it.
 */
import type { Vec3 } from '../render/strokes/frame';
import type { LocomotionSettings } from './settings';
import { effectiveOffset, type HeadPose, type LocomotionState } from './step';

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
/**
 * A landing is valid on ground whose normal is less than this far off +Y, degrees. Ground follow
 * walks any slope, and the painter's hill climbs to about 41° at the default seed, so the limit
 * sits above that.
 */
export const MAX_SLOPE_DEG = 45;
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

/** Bisection steps that refine where an arc enters a building volume, between two samples. */
export const CUT_BISECT_STEPS = 16;

/**
 * Why a landing is or is not valid. `building`: the arc entered a building's volume and was cut
 * there. `footprint`: the landing is on or beside a wall (a world with no volume query). `tree`:
 * the landing is inside a tree crown. `none`: the arc reached no ground.
 */
export type LandingReason =
  | 'slope'
  | 'boundary'
  | 'building'
  | 'footprint'
  | 'tree'
  | 'none'
  | 'ok';

export interface LandingGround {
  heightAt(x: number, z: number): number;
  /** Unit upward normal at (x, z). */
  normalAt(x: number, z: number): Vec3;
}

/** Building volumes, as indexed solids. Every method must allocate nothing. */
export interface VolumeQuery {
  /** Index of a volume containing the point, or -1. */
  at(x: number, y: number, z: number): number;
  /**
   * Starts a trace. A volume holds the point in its walls when the point is inside the ungrown
   * footprint and at or below the volume's top there (the gable, or the spire for the tower). A
   * volume whose walls hold the point is ignored by `crossing` until `update`
   * sees a point outside them. A volume that holds the point only in its margin is tested at its
   * bare walls (no margin) for the whole trace.
   */
  begin(x: number, y: number, z: number): void;
  /** An ignored volume whose walls no longer hold the point counts again, at its bare walls. */
  update(x: number, y: number, z: number): void;
  /** Index of a volume, not ignored, that the straight segment a to b touches, or -1. */
  crossing(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number;
}

/** What a landing is tested against. A painting's `WorldHandle` is one. */
export interface LandingWorld {
  readonly ground: LandingGround;
  /** 0 inside the world, rising toward its edge. Omitted: no boundary. */
  boundaryFactor?(position: Vec3): number;
  /** True inside a building footprint. Omitted: no footprints. */
  blocked?(x: number, z: number): boolean;
  /**
   * The buildings' volumes (each footprint grown by the margin, up to its wall and roof top): an
   * arc is cut where a segment between two samples enters one. Omitted: arcs pass through
   * buildings.
   */
  readonly volumes?: VolumeQuery;
  /** True where a landing's foot or eye is inside a tree crown. Arcs pass through crowns. */
  treeBlocked?(x: number, z: number): boolean;
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

/** The landing's validity: the boundary first, then a footprint, a tree crown, then the slope. */
export function landingReason(world: LandingWorld, hit: Vec3, normal: Vec3): LandingReason {
  if (world.boundaryFactor && world.boundaryFactor(hit) > BOUNDARY_LIMIT) return 'boundary';
  if (world.blocked?.(hit[0], hit[2])) return 'footprint';
  if (world.treeBlocked?.(hit[0], hit[2])) return 'tree';
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(normal[1] > COS_MAX_SLOPE * length)) return 'slope';
  return 'ok';
}

/** The running trace's launch and world, so the helpers below are module-level, not closures. */
const T = {
  ox: 0,
  oy: 0,
  oz: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  ground: FLAT_WORLD.ground as LandingGround,
  volumes: undefined as VolumeQuery | undefined,
};

const px = (t: number): number => T.ox + T.vx * t;
const py = (t: number): number => T.oy + T.vy * t - (GRAVITY / 2) * t * t;
const pz = (t: number): number => T.oz + T.vz * t;

/** Height above the ground at time t; positive above it. */
function clearance(t: number): number {
  return py(t) - T.ground.heightAt(px(t), pz(t));
}

/** Whether the chord of the parabola from time a to time b touches a volume. */
function touches(a: number, b: number): boolean {
  const v = T.volumes;
  return v !== undefined && v.crossing(px(a), py(a), pz(a), px(b), py(b), pz(b)) >= 0;
}

/** Rewrites the live samples evenly over [0, tEnd] and ends the arc at `endPoint`. */
function finish(out: ArcResult, tEnd: number, endPoint: Vec3): void {
  const points = out.points;
  const step = tEnd / (MAX_SAMPLES - 1);
  for (let j = 1; j < MAX_SAMPLES - 1; j += 1) {
    const tj = j * step;
    points[j * 3] = px(tj);
    points[j * 3 + 1] = py(tj);
    points[j * 3 + 2] = pz(tj);
  }
  const last = (MAX_SAMPLES - 1) * 3;
  points[last] = endPoint[0];
  points[last + 1] = endPoint[1];
  points[last + 2] = endPoint[2];
  out.count = MAX_SAMPLES;
}

/**
 * Ends the arc where the chord from `from` to `to` enters a volume, found by halving it. A graze
 * within the chord's sag (under 1 cm) of a roof can put the hit up to one sample step past it.
 */
function cut(out: ArcResult, from: number, to: number): void {
  let lo = from;
  let hi = to;
  for (let step = 0; step < CUT_BISECT_STEPS; step += 1) {
    const mid = (lo + hi) / 2;
    if (touches(lo, mid)) hi = mid;
    else lo = mid;
  }
  const hit = out.landing;
  hit[0] = px(hi);
  hit[1] = py(hi);
  hit[2] = pz(hi);
  finish(out, hi, hit);
  out.normal[0] = 0;
  out.normal[1] = 1;
  out.normal[2] = 0;
  out.hit = hit;
  out.reason = 'building';
  out.valid = false;
}

/**
 * Traces the arc launched from `origin` along `direction` (any length) at `LAUNCH_SPEED` into
 * `out`. The search samples evenly in time over the flight to the range cap, or to
 * `MAX_FLIGHT_TIME` when the cap is further. The first sample at or below the ground ends the arc:
 * the time between it and the sample before is bisected, and the hit is that point dropped exactly
 * onto the ground. A landed arc is then resampled evenly over its flight to the hit, so a short or
 * steep-down arc still has `MAX_SAMPLES` points to draw.
 *
 * With `world.volumes`, each segment between consecutive samples (and the last one to the
 * landing) is tested against the buildings' volumes, not just the sample points, so a step cannot
 * skip a corner or a ridge. The first segment that touches one ends the arc: the entry inside it
 * is bisected on the parabola, the hit is the point at the entry, and the reason is `building`.
 * A volume whose walls hold the origin is ignored until the arc has left them, and one that holds
 * it only in its margin is tested at its bare walls, so an aim started beside a wall is cut at the
 * wall and an aim away from it is free. A segment is a chord of the parabola
 * and sags under 1 cm at the longest step, so the chord test is effectively exact.
 */
export function traceArc(out: ArcResult, origin: Vec3, direction: Vec3, world: LandingWorld): void {
  trace(out, origin, direction, world);
  // Keep no reference to the last world's terrain or volumes between traces.
  T.ground = FLAT_WORLD.ground;
  T.volumes = undefined;
}

function trace(out: ArcResult, origin: Vec3, direction: Vec3, world: LandingWorld): void {
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
  const vh = Math.hypot(direction[0] * k, direction[2] * k);
  T.ox = ox;
  T.oy = oy;
  T.oz = oz;
  T.vx = direction[0] * k;
  T.vy = direction[1] * k;
  T.vz = direction[2] * k;
  T.ground = ground;
  const volumes = world.volumes;
  T.volumes = volumes;
  const end = vh > 0 ? Math.min(MAX_FLIGHT_TIME, MAX_RANGE / vh) : MAX_FLIGHT_TIME;
  const dt = end / (MAX_SAMPLES - 1);
  // Every volume the origin is inside is ignored until a sample is outside it.
  volumes?.begin(ox, oy, oz);

  for (let i = 1; i < MAX_SAMPLES; i += 1) {
    const t = i * dt;
    const x = px(t);
    const y = py(t);
    const z = pz(t);
    if (y > ground.heightAt(x, z)) {
      if (touches(t - dt, t)) {
        cut(out, t - dt, t);
        return;
      }
      points[i * 3] = x;
      points[i * 3 + 1] = y;
      points[i * 3 + 2] = z;
      out.count = i + 1;
      volumes?.update(x, y, z);
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
    if (touches(t - dt, th)) {
      cut(out, t - dt, th);
      return;
    }
    const hit = out.landing;
    hit[0] = px(th);
    hit[2] = pz(th);
    hit[1] = ground.heightAt(hit[0], hit[2]);
    finish(out, th, hit);
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
  state.position[1] = hit[1] + effectiveOffset(state, settings, head.y);
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
