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
  };
}

/** Stands the rig on (x, y, z) facing `yaw`, with ground follow on and no smoothing from before. */
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

/** Captures the seated offset from the seated head height (rig-local y). Never negative. */
export function calibrateSeated(
  state: LocomotionState,
  settings: LocomotionSettings,
  headY: number,
): void {
  state.seatedOffset = Math.max(0, settings.standingHeight - headY);
}

/**
 * One frame. Moves the rig along the head's ground-projected yaw (rig yaw plus head yaw), then
 * eases its y toward the ground under the head's world XZ, plus the seated offset. The offset only
 * translates the rig, so physical head movement maps one to one into the world.
 */
export function step(
  state: LocomotionState,
  actions: MoveInput,
  /** null while a world's ground is still loading: y holds and the rig is not grounded. */
  ground: Ground | null,
  settings: LocomotionSettings,
  dt: number,
  head: HeadPose,
): void {
  const t = dt > 0 ? Math.min(dt, MAX_DT) : 0;
  const position = state.position;
  const mx = actions.move.x;
  const my = actions.move.y;
  const length = Math.hypot(mx, my);

  state.speed = 0;
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

  if (state.held || ground === null) {
    state.grounded = false;
    return;
  }
  state.grounded = true;
  // The head's world XZ: the rig position plus the head offset turned by the rig yaw.
  const sin = Math.sin(state.yaw);
  const cos = Math.cos(state.yaw);
  const hx = position[0] + cos * head.x + sin * head.z;
  const hz = position[2] - sin * head.x + cos * head.z;
  const target = ground.heightAt(hx, hz);
  state.groundY += (target - state.groundY) * (1 - Math.exp(-t / GROUND_FOLLOW_TAU));
  position[1] = state.groundY + (settings.seated ? state.seatedOffset : 0);
}
