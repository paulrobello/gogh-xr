/**
 * Snap and smooth turn (P3.3), pure like step.ts and run before it each frame. A turn changes the
 * rig yaw about the head's world XZ, not the rig origin: the rig position is re-solved so the head
 * stays where it is, however far the player has walked from the rig origin physically.
 *
 * Positive yaw turns left (src/locomotion/step.ts), so a turn to the right is negative yaw.
 */
import { MAX_DT } from '../xr/input';
import type { LocomotionSettings } from './settings';
import type { HeadPose, LocomotionState } from './step';

/** Minimum time between two snap turns, seconds. A request inside it is dropped. */
export const SNAP_COOLDOWN = 0.25;
/** Absorbs float error when summing frame dts toward the cooldown (25 × 0.01 < 0.25). */
const COOLDOWN_EPSILON = 1e-9;
const DEG = Math.PI / 180;

/** The part of a P3.1 `Actions` frame turning reads. */
export interface TurnInput {
  readonly turn: {
    /** Right stick X plus Q/E, −1..1, right positive. */
    readonly x: number;
    /** Snap request, already edge-detected and re-armed by the input layer. */
    readonly snap: -1 | 0 | 1;
  };
}

/** Turns the rig by `delta` radians about the head's world XZ. */
export function turnAboutHead(state: LocomotionState, head: HeadPose, delta: number): void {
  const position = state.position;
  // The head's world XZ, as step.ts computes it for ground follow.
  let sin = Math.sin(state.yaw);
  let cos = Math.cos(state.yaw);
  const hx = position[0] + cos * head.x + sin * head.z;
  const hz = position[2] - sin * head.x + cos * head.z;
  state.yaw += delta;
  sin = Math.sin(state.yaw);
  cos = Math.cos(state.yaw);
  position[0] = hx - (cos * head.x + sin * head.z);
  position[2] = hz - (-sin * head.x + cos * head.z);
}

/**
 * One frame. Snap mode turns `snapAngleDeg` once per snap request, at most once per 250 ms. Smooth
 * mode turns at `smoothTurnDegPerSec` × `turn.x` and ignores snap requests. True when it snapped.
 */
export function turn(
  state: LocomotionState,
  input: TurnInput,
  settings: LocomotionSettings,
  dt: number,
  head: HeadPose,
): boolean {
  const t = dt > 0 ? Math.min(dt, MAX_DT) : 0;
  state.sinceSnap += t;
  state.turnRate = 0;
  if (settings.turnMode === 'smooth') {
    const x = input.turn.x;
    const rate = x === 0 ? 0 : -settings.smoothTurnDegPerSec * DEG * x;
    state.turnRate = rate;
    if (rate !== 0 && t > 0) turnAboutHead(state, head, rate * t);
    return false;
  }
  const snap = input.turn.snap;
  if (snap !== 0 && state.sinceSnap >= SNAP_COOLDOWN - COOLDOWN_EPSILON) {
    turnAboutHead(state, head, -snap * settings.snapAngleDeg * DEG);
    state.sinceSnap = 0;
    return true;
  }
  return false;
}
