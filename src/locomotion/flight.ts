/**
 * Flight (P3.5), pure like step.ts, which it replaces for the frame while the rig flies. Ground
 * follow is off. The left stick moves along the head's full 3D forward, pitch included, and the
 * right stick Y (`vertical`) moves straight up or down. The head stays between the walk floor and
 * a 40 m altitude cap, and inside a 55 m radius pushed back from the world's edge.
 *
 * Altitude is the head's height above the ground under the head's world XZ. The floor is on the
 * rig: the ground plus the seated offset, where walk mode stands it, so a standing eye never goes
 * below its 1.6 m standing height over the terrain, and a physical crouch does not lift the rig.
 *
 * Conventions match step.ts: yaw 0 faces -Z, positive yaw turns left, positive pitch looks up.
 */
import type { Vec3 } from '../render/strokes/frame';
import { MAX_DT } from '../xr/input';
import { type LocomotionSettings, MAX_MOVE_SPEED, MIN_MOVE_SPEED } from './settings';
import {
  type Ground,
  type HeadPose,
  type LocomotionState,
  type MoveInput,
  SPRINT_MULTIPLIER,
} from './step';

/** The head's altitude cap above the ground under it, metres. Never exceeded. */
export const MAX_ALTITUDE = 40;
/** Upward speed scales down by the remaining fraction over this last stretch below the cap, m. */
export const ALTITUDE_SOFT_BAND = 5;
/** Vertical flight speed at full `vertical`, m/s. */
export const VERTICAL_SPEED = 2;
/** The radial boundary factor above which flight is pushed back toward the world origin. */
export const BOUNDARY_PUSH_START = 0.8;
/** The inward push at boundary factor 1, m/s. It grows linearly from 0 at `BOUNDARY_PUSH_START`. */
export const BOUNDARY_PUSH_SPEED = 3;
/** The head's horizontal distance from the world origin never exceeds this in flight, metres. */
export const MAX_FLIGHT_RADIUS = 55;

/** The part of a P3.1 `Actions` frame flight reads. */
export interface FlightInput extends MoveInput {
  /** Up positive, −1..1. */
  readonly vertical: number;
}

/** The world's edge, as a painting's `WorldHandle` carries it. Omitted: no boundary. */
export interface FlightBoundary {
  boundaryFactor?(position: Vec3): number;
}

const probe: [number, number, number] = [0, 0, 0];

/**
 * The world's boundary factor for the head's horizontal radius alone: the factor at (x, 0, z).
 * Starry Night's factor also rises with altitude above the painter's spot, which the altitude cap
 * already handles, so it would push a high flight sideways even over the origin.
 */
export function radialBoundary(world: FlightBoundary, x: number, z: number): number {
  if (!world.boundaryFactor) return 0;
  probe[0] = x;
  probe[1] = 0;
  probe[2] = z;
  return world.boundaryFactor(probe);
}

/** The haze thickening for a boundary factor, 0-1: 0 up to `BOUNDARY_PUSH_START`, 1 at 1. */
export function boundaryExcess(factor: number): number {
  return Math.min(1, Math.max(0, (factor - BOUNDARY_PUSH_START) / (1 - BOUNDARY_PUSH_START)));
}

/** Starts flying from where the rig is: ground follow and any exit drop stop. */
export function enterFlight(state: LocomotionState): void {
  state.mode = 'fly';
  state.held = false;
  state.grounded = false;
  state.dropping = false;
}

/** Stops flying: step.ts eases the rig from its current y onto the ground over 0.5 s. */
export function exitFlight(state: LocomotionState): void {
  state.mode = 'walk';
  state.held = false;
  state.grounded = false;
  state.dropping = true;
  state.dropFrom = state.position[1];
  state.dropElapsed = 0;
  state.boundary = 0;
  state.pushSpeed = 0;
}

/**
 * One flight frame. The stick velocity and the boundary push are summed, the upward part of that
 * sum is scaled down over the last `ALTITUDE_SOFT_BAND` below the cap, and after the move the head
 * is hard-clamped to `MAX_FLIGHT_RADIUS` (only with a boundary) and the rig's y to the floor and
 * the cap.
 */
export function fly(
  state: LocomotionState,
  input: FlightInput,
  ground: Ground,
  world: FlightBoundary,
  settings: LocomotionSettings,
  dt: number,
  head: HeadPose,
  /** The head's pitch, radians, positive up. */
  pitch: number,
): void {
  const t = dt > 0 ? Math.min(dt, MAX_DT) : 0;
  const position = state.position;
  const mx = input.move.x;
  const my = input.move.y;
  const length = Math.hypot(mx, my);
  let vx = 0;
  let vy = 0;
  let vz = 0;
  if (length > 0) {
    const moveSpeed = Math.min(MAX_MOVE_SPEED, Math.max(MIN_MOVE_SPEED, settings.moveSpeed));
    const sprint = input.sprint ? SPRINT_MULTIPLIER : 1;
    const speed = Math.min(MAX_MOVE_SPEED, moveSpeed * sprint) * Math.min(1, length);
    const yaw = state.yaw + head.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const k = speed / length;
    // Right (cos, 0, -sin) and forward (-sin·cp, sp, -cos·cp) are orthonormal, so |v| = speed.
    vx = (cos * mx - sin * cp * my) * k;
    vy = sp * my * k;
    vz = (-sin * mx - cos * cp * my) * k;
  }
  vy += VERTICAL_SPEED * Math.min(1, Math.max(-1, input.vertical));
  state.speed = Math.hypot(vx, vy, vz);
  if (state.speed > 0) state.held = false;

  let sin = Math.sin(state.yaw);
  let cos = Math.cos(state.yaw);
  let hx = position[0] + cos * head.x + sin * head.z;
  let hz = position[2] - sin * head.x + cos * head.z;
  const factor = radialBoundary(world, hx, hz);
  state.boundary = factor;
  state.pushSpeed = 0;
  const radius = Math.hypot(hx, hz);
  if (factor > BOUNDARY_PUSH_START && radius > 1e-6) {
    const push = BOUNDARY_PUSH_SPEED * boundaryExcess(factor);
    state.pushSpeed = push;
    vx -= (hx / radius) * push;
    vz -= (hz / radius) * push;
  }
  if (vy > 0) {
    const altitude = position[1] + head.y - ground.heightAt(hx, hz);
    vy *= Math.min(1, Math.max(0, (MAX_ALTITUDE - altitude) / ALTITUDE_SOFT_BAND));
  }

  position[0] += vx * t;
  position[1] += vy * t;
  position[2] += vz * t;

  sin = Math.sin(state.yaw);
  cos = Math.cos(state.yaw);
  hx = position[0] + cos * head.x + sin * head.z;
  hz = position[2] - sin * head.x + cos * head.z;
  const reach = Math.hypot(hx, hz);
  if (world.boundaryFactor && reach > MAX_FLIGHT_RADIUS) {
    const scale = MAX_FLIGHT_RADIUS / reach;
    position[0] += hx * scale - hx;
    position[2] += hz * scale - hz;
    hx *= scale;
    hz *= scale;
  }
  const groundY = ground.heightAt(hx, hz);
  const offset = settings.seated ? state.seatedOffset : 0;
  const floor = groundY + offset;
  // A head below its expected eye height (the standing height, less the seated offset) caps as if
  // at it: before the first XR pose head.y is 0, and the first real pose must not render above.
  const cap = groundY + MAX_ALTITUDE - Math.max(head.y, settings.standingHeight - offset);
  position[1] = Math.min(cap, Math.max(floor, position[1]));
  state.groundY = groundY;
  state.grounded = false;
  state.altitude = position[1] + head.y - groundY;
}
