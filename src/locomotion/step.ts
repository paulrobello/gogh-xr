/**
 * The pure locomotion core (P3.2): smooth movement, ground follow and the seated offset, applied
 * to the rig, the camera's parent. It allocates nothing, so it can run every frame.
 *
 * Conventions match src/paintings/world-module.ts: yaw 0 faces -Z and positive yaw turns left.
 * The rig carries a position and a yaw. The head pose is relative to the rig, as WebXR's
 * local-floor viewer pose (or the desktop eye) sits inside it.
 */
import { MAX_DT } from '../xr/input';
import { type LocomotionSettings, MAX_MOVE_SPEED, MIN_MOVE_SPEED } from './settings';

/** Ground follow's exponential time constant, seconds. */
export const GROUND_FOLLOW_TAU = 0.08;
/** The desktop Shift multiplier. The result is still capped at `MAX_MOVE_SPEED`. */
export const SPRINT_MULTIPLIER = 2;
/** Leaving flight (P3.5) eases the rig down onto the ground over exactly this long, seconds. */
export const EXIT_DROP_DURATION = 0.5;
/** Absorbs float error when summing frame dts toward the drop's end. */
const DROP_EPSILON = 1e-9;

/** Walking on the ground, or flying (src/locomotion/flight.ts). */
export type LocomotionMode = 'walk' | 'fly';

/** The head relative to the rig: local position, and yaw about the rig's up axis. */
export interface HeadPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

export interface Ground {
  heightAt(x: number, z: number): number;
}

/** No world bound (bare scene, `?demo`, `?strokesTest`): the floor is y = 0. */
export const FLAT_GROUND: Ground = Object.freeze({ heightAt: () => 0 });

/** The part of a P3.1 `Actions` frame movement reads. */
export interface MoveInput {
  /** Head-relative: x right, y forward, magnitude ≤ 1. */
  readonly move: { readonly x: number; readonly y: number };
  readonly sprint: boolean;
}

export interface LocomotionState {
  /** The rig's world position. y includes the seated offset. */
  readonly position: [number, number, number];
  yaw: number;
  /** The smoothed ground height under the head, without the seated offset. */
  groundY: number;
  /** Standing height minus the measured seated head height; applied only while seated. */
  seatedOffset: number;
  /** A placed rig (`placeRig`) ignores the ground until the next movement input. */
  held: boolean;
  /** True while ground follow drives the rig's y. */
  grounded: boolean;
  /** Horizontal stick speed of the last step, m/s. */
  speed: number;
  /** Smooth turn rate of the last turn, rad/s, positive left. Snap turns leave it 0. */
  turnRate: number;
  /** Seconds since the last snap turn (src/locomotion/turn.ts). Infinity: none yet. */
  sinceSnap: number;
  mode: LocomotionMode;
  /** True while the exit drop eases a walking rig from its flight height onto the ground. */
  dropping: boolean;
  /** The rig's y when the drop started. */
  dropFrom: number;
  /** Seconds into the drop. */
  dropElapsed: number;
  /** The head's height above the ground under it, metres, as of the last step. */
  altitude: number;
  /** The radial boundary factor at the head of the last flight step, 0 in walk mode. */
  boundary: number;
  /** Speed of the last flight step's boundary push, m/s, 0 in walk mode. */
  pushSpeed: number;
}

export function createLocomotionState(): LocomotionState {
  return {
    position: [0, 0, 0],
    yaw: 0,
    groundY: 0,
    seatedOffset: 0,
    held: false,
    grounded: true,
    speed: 0,
    turnRate: 0,
    sinceSnap: Number.POSITIVE_INFINITY,
    mode: 'walk',
    dropping: false,
    dropFrom: 0,
    dropElapsed: 0,
    altitude: 0,
    boundary: 0,
    pushSpeed: 0,
  };
}

/**
 * Stands the rig on (x, y, z) facing `yaw` in walk mode, with ground follow on, no exit drop and
 * no smoothing from before.
 */
export function spawnAt(
  state: LocomotionState,
  x: number,
  y: number,
  z: number,
  yaw: number,
): void {
  state.position[0] = x;
  state.position[1] = y;
  state.position[2] = z;
  state.yaw = yaw;
  state.groundY = y;
  state.held = false;
  state.grounded = true;
  state.speed = 0;
  state.turnRate = 0;
  state.sinceSnap = Number.POSITIVE_INFINITY;
  state.mode = 'walk';
  state.dropping = false;
  state.boundary = 0;
  state.pushSpeed = 0;
}

/**
 * Puts the rig exactly at (x, y, z) facing `yaw` and holds it there: ground follow stays off until
 * the next movement input, then resumes smoothly from y. The `?diag` pose hook uses it.
 */
export function placeRig(
  state: LocomotionState,
  x: number,
  y: number,
  z: number,
  yaw: number,
): void {
  spawnAt(state, x, y, z, yaw);
  state.held = true;
  state.grounded = false;
}

/** The eye never drops below this height above the ground, metres. */
export const MIN_EYE_HEIGHT = 0.3;

/**
 * The rig offset in force this frame: the calibrated seated offset while seated, else 0. It may be
 * negative (a low standing height lowers the eye), but never lets the eye (offset plus the head's
 * rig-local y) sit below `MIN_EYE_HEIGHT` above the ground.
 */
export function effectiveOffset(
  state: LocomotionState,
  settings: LocomotionSettings,
  headY: number,
): number {
  return settings.seated ? Math.max(state.seatedOffset, MIN_EYE_HEIGHT - headY) : 0;
}

/**
 * Captures the seated offset from the seated head height (rig-local y). It is negative when the
 * standing height is below the head, so lowering the slider lowers the eye. The standing height is
 * at least 1 m, so the eye floor binds only through `effectiveOffset`, on a live head drop.
 */
export function calibrateSeated(
  state: LocomotionState,
  settings: LocomotionSettings,
  headY: number,
): void {
  state.seatedOffset = settings.standingHeight - headY;
}

/** Smoothstep on [0, 1]. */
export function smoothstep01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/**
 * One walk frame. Moves the rig along the head's ground-projected yaw (rig yaw plus head yaw),
 * then eases its y toward the ground under the head's world XZ, plus the seated offset. The offset
 * only translates the rig, so physical head movement maps one to one into the world.
 *
 * During the exit drop the y instead follows a smoothstep from the flight height to that target,
 * re-sampled every frame, and lands on it exactly `EXIT_DROP_DURATION` after the drop began.
 */
export function step(
  state: LocomotionState,
  actions: MoveInput,
  /** null while a world's ground is still loading: y holds and the rig is not grounded. */
  ground: Ground | null,
  settings: LocomotionSettings,
  dt: number,
  head: HeadPose,
  constrain?: () => void,
): void {
  const t = dt > 0 ? Math.min(dt, MAX_DT) : 0;
  const position = state.position;
  const mx = actions.move.x;
  const my = actions.move.y;
  const length = Math.hypot(mx, my);

  state.speed = 0;
  state.pushSpeed = 0;
  if (length > 0) {
    state.held = false;
    const moveSpeed = Math.min(MAX_MOVE_SPEED, Math.max(MIN_MOVE_SPEED, settings.moveSpeed));
    const sprint = actions.sprint ? SPRINT_MULTIPLIER : 1;
    const speed = Math.min(MAX_MOVE_SPEED, moveSpeed * sprint) * Math.min(1, length);
    state.speed = speed;
    const yaw = state.yaw + head.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const k = (speed * t) / length;
    position[0] += (cos * mx - sin * my) * k;
    position[2] += (-sin * mx - cos * my) * k;
  }

  if (!state.held) constrain?.();
  // The head's world XZ: the rig position plus the head offset turned by the rig yaw.
  const sin = Math.sin(state.yaw);
  const cos = Math.cos(state.yaw);
  const hx = position[0] + cos * head.x + sin * head.z;
  const hz = position[2] - sin * head.x + cos * head.z;
  if (state.held || ground === null) {
    state.grounded = false;
    if (ground !== null) state.altitude = position[1] + head.y - ground.heightAt(hx, hz);
    return;
  }
  state.grounded = true;
  const target = ground.heightAt(hx, hz);
  const offset = effectiveOffset(state, settings, head.y);
  if (state.dropping) {
    state.dropElapsed += t;
    state.groundY = target;
    if (state.dropElapsed >= EXIT_DROP_DURATION - DROP_EPSILON) {
      state.dropping = false;
      position[1] = target + offset;
    } else {
      const s = smoothstep01(state.dropElapsed / EXIT_DROP_DURATION);
      position[1] = state.dropFrom + (target + offset - state.dropFrom) * s;
      state.grounded = false;
    }
    state.altitude = position[1] + head.y - target;
    return;
  }
  state.groundY += (target - state.groundY) * (1 - Math.exp(-t / GROUND_FOLLOW_TAU));
  // The eye floor is measured against the true ground under the head, not the eased groundY, so a
  // fast uphill walk cannot dip the eye under it while groundY lags.
  const floorY = settings.seated ? target + MIN_EYE_HEIGHT - head.y : Number.NEGATIVE_INFINITY;
  position[1] = Math.max(state.groundY + offset, floorY);
  state.altitude = position[1] + head.y - target;
}
