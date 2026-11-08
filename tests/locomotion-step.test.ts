import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCOMOTION_SETTINGS, type LocomotionSettings } from '../src/locomotion/settings';
import {
  calibrateSeated,
  createLocomotionState,
  FLAT_GROUND,
  GROUND_FOLLOW_TAU,
  type Ground,
  type HeadPose,
  type LocomotionState,
  type MoveInput,
  placeRig,
  spawnAt,
  step,
} from '../src/locomotion/step';

const STANDING: HeadPose = { x: 0, y: 1.6, z: 0, yaw: 0 };
const IDLE: MoveInput = { move: { x: 0, y: 0 }, sprint: false };
const FORWARD: MoveInput = { move: { x: 0, y: 1 }, sprint: false };
const SETTINGS: LocomotionSettings = DEFAULT_LOCOMOTION_SETTINGS;
const SEATED: LocomotionSettings = { ...SETTINGS, seated: true };
/** Rises 0.5 m per metre of +x. */
const SLOPE: Ground = { heightAt: (x) => 0.5 * x };

function at(x: number, z: number, yaw = 0): LocomotionState {
  const state = createLocomotionState();
  spawnAt(state, x, 0, z, yaw);
  return state;
}

/** Steps `frames` frames of `dt` with the same input and head. */
function run(
  state: LocomotionState,
  frames: number,
  dt: number,
  input: MoveInput = IDLE,
  ground: Ground = FLAT_GROUND,
  settings: LocomotionSettings = SETTINGS,
  head: HeadPose = STANDING,
): LocomotionState {
  for (let i = 0; i < frames; i += 1) step(state, input, ground, settings, dt, head);
  return state;
}

describe('smooth movement', () => {
  it('moves at the 2.0 m/s default toward -Z at yaw 0', () => {
    const state = run(at(0, 0), 10, 0.05, FORWARD);
    expect(state.position[0]).toBeCloseTo(0, 12);
    expect(state.position[2]).toBeCloseTo(-1, 12);
    expect(state.speed).toBe(2);
  });

  it('follows the head yaw plus the rig yaw, projected onto the ground', () => {
    // Rig yaw 30° plus head yaw 60°: facing -X, so forward goes to -X and right to -Z.
    const head = { ...STANDING, yaw: Math.PI / 3 };
    const forward = run(at(0, 0, Math.PI / 6), 1, 0.1, FORWARD, FLAT_GROUND, SETTINGS, head);
    expect(forward.position[0]).toBeCloseTo(-0.2, 12);
    expect(forward.position[2]).toBeCloseTo(0, 12);
    const right = { move: { x: 1, y: 0 }, sprint: false };
    const strafe = run(at(0, 0, Math.PI / 6), 1, 0.1, right, FLAT_GROUND, SETTINGS, head);
    expect(strafe.position[0]).toBeCloseTo(0, 12);
    expect(strafe.position[2]).toBeCloseTo(-0.2, 12);
  });

  it('scales with the stick and the move speed setting', () => {
    const half = run(at(0, 0), 1, 0.1, { move: { x: 0, y: 0.5 }, sprint: false });
    expect(half.position[2]).toBeCloseTo(-0.1, 12);
    expect(half.speed).toBeCloseTo(1, 12);
    const fast = run(at(0, 0), 1, 0.1, FORWARD, FLAT_GROUND, { ...SETTINGS, moveSpeed: 2.5 });
    expect(fast.position[2]).toBeCloseTo(-0.25, 12);
  });

  it('is bounded at 3.0 m/s whatever the input, the setting or the sprint', () => {
    const inputs: MoveInput[] = [
      FORWARD,
      { move: { x: 1, y: 1 }, sprint: true },
      { move: { x: -5, y: 3 }, sprint: true },
    ];
    for (const moveSpeed of [1, 2, 3, 99]) {
      for (const input of inputs) {
        const state = at(0, 0);
        for (const dt of [0.011, 0.1, 5]) {
          const [x0, , z0] = state.position;
          step(state, input, FLAT_GROUND, { ...SETTINGS, moveSpeed }, dt, STANDING);
          const moved = Math.hypot(state.position[0] - x0, state.position[2] - z0);
          expect(moved).toBeLessThanOrEqual(3 * Math.min(dt, 0.1) + 1e-12);
          expect(state.speed).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  it('doubles the speed with sprint, capped at 3.0 m/s', () => {
    const slow = { ...SETTINGS, moveSpeed: 1 };
    const sprint = { move: { x: 0, y: 1 }, sprint: true };
    expect(run(at(0, 0), 1, 0.1, sprint, FLAT_GROUND, slow).speed).toBe(2);
    expect(run(at(0, 0), 1, 0.1, sprint).speed).toBe(3);
  });

  it('does nothing with no input, a zero dt or a negative dt', () => {
    expect(run(at(1, 2), 5, 0.1).position).toEqual([1, 0, 2]);
    expect(run(at(1, 2), 1, 0, FORWARD).position).toEqual([1, 0, 2]);
    expect(run(at(1, 2), 1, -1, FORWARD).position).toEqual([1, 0, 2]);
    expect(run(at(1, 2), 1, 0.1).speed).toBe(0);
  });
});

describe('ground follow', () => {
  it('converges to heightAt of the head on a slope', () => {
    const state = run(at(2, 0), 200, 0.011, IDLE, SLOPE);
    expect(state.position[1]).toBeCloseTo(1, 9);
    expect(state.grounded).toBe(true);
  });

  it('samples the ground under the head, not the rig origin', () => {
    // The head stands 1 m to the rig's local right; rig yaw 90° turns that local +X to world -Z.
    const head = { ...STANDING, x: 1 };
    const sideways = run(at(0, 0, Math.PI / 2), 300, 0.011, IDLE, SLOPE, SETTINGS, head);
    expect(sideways.position[1]).toBeCloseTo(0, 9);
    const ahead = run(at(0, 0, 0), 300, 0.011, IDLE, SLOPE, SETTINGS, head);
    expect(ahead.position[1]).toBeCloseTo(0.5, 9);
  });

  it('smooths with an 80 ms time constant, independent of the frame rate', () => {
    const target = 1;
    const once = run(at(2, 0), 1, GROUND_FOLLOW_TAU, IDLE, SLOPE);
    expect(once.position[1]).toBeCloseTo(target * (1 - Math.exp(-1)), 12);
    // 0.5 s at 72 Hz and at 90 Hz land on the same height.
    const at72 = run(at(2, 0), 36, 1 / 72, IDLE, SLOPE);
    const at90 = run(at(2, 0), 45, 1 / 90, IDLE, SLOPE);
    const expected = target * (1 - Math.exp(-0.5 / GROUND_FOLLOW_TAU));
    expect(at72.position[1]).toBeCloseTo(expected, 12);
    expect(at90.position[1]).toBeCloseTo(expected, 12);
  });

  it('follows the ground while walking up the slope', () => {
    const state = run(at(0, 0, -Math.PI / 2), 50, 0.02, FORWARD, SLOPE);
    // Facing +X for 1 s at 2 m/s: x = 2, so the ground is 1 m up; the 80 ms lag trails by ~0.08 m.
    expect(state.position[0]).toBeCloseTo(2, 9);
    expect(state.position[1]).toBeGreaterThan(0.9);
    expect(state.position[1]).toBeLessThan(1);
    run(state, 100, 0.02, IDLE, SLOPE);
    expect(state.position[1]).toBeCloseTo(1, 6);
  });

  it('keeps y and reports not grounded while the ground is still loading (null)', () => {
    const state = createLocomotionState();
    spawnAt(state, 0, 0.4, 0, 0);
    for (let i = 0; i < 20; i += 1) step(state, FORWARD, null, SETTINGS, 0.05, STANDING);
    expect(state.position[1]).toBe(0.4);
    expect(state.position[2]).toBeCloseTo(-2, 12);
    expect(state.grounded).toBe(false);
    run(state, 1, 0.05, IDLE, FLAT_GROUND);
    expect(state.grounded).toBe(true);
    expect(state.position[1]).toBeLessThan(0.4);
  });

  it('holds a placed rig until the next movement input', () => {
    const state = createLocomotionState();
    placeRig(state, 2, 30, 0, 0.5);
    run(state, 50, 0.02, IDLE, SLOPE);
    expect(state.position).toEqual([2, 30, 0]);
    expect(state.yaw).toBe(0.5);
    expect(state.grounded).toBe(false);
    // Movement releases the hold and the rig settles onto the ground again.
    run(state, 1, 0.02, FORWARD, SLOPE);
    expect(state.grounded).toBe(true);
    run(state, 200, 0.02, IDLE, SLOPE);
    expect(state.position[1]).toBeCloseTo(0.5 * state.position[0], 6);
  });
});

describe('seated mode', () => {
  it('raises the rig by standing height minus the measured seated head height', () => {
    const state = at(0, 0);
    calibrateSeated(state, SEATED, 1.1);
    expect(state.seatedOffset).toBeCloseTo(0.5, 12);
    run(state, 1, 0.011, IDLE, FLAT_GROUND, SEATED, { ...STANDING, y: 1.1 });
    expect(state.position[1]).toBeCloseTo(0.5, 12);
  });

  it('lowers the eye below the seated head height when standing height is lower', () => {
    const state = at(0, 0);
    const low = { ...SEATED, standingHeight: 1.2 };
    calibrateSeated(state, low, 1.5);
    expect(state.seatedOffset).toBeCloseTo(-0.3, 12);
    run(state, 1, 0.011, IDLE, FLAT_GROUND, low, { ...STANDING, y: 1.5 });
    expect(state.position[1]).toBeCloseTo(-0.3, 12);
    // Eye height above ground = rig y + head y = the standing height.
    expect(state.position[1] + 1.5).toBeCloseTo(1.2, 12);
  });

  it('keeps the eye at least 0.3 m above the ground when the head drops', () => {
    const state = at(0, 0);
    const low = { ...SEATED, standingHeight: 1 };
    calibrateSeated(state, low, 1.6);
    // The head crouches to 0.1 m rig-local: the offset cannot take the eye below 0.3 m.
    run(state, 1, 0.011, IDLE, FLAT_GROUND, low, { ...STANDING, y: 0.1 });
    expect(state.position[1] + 0.1).toBeGreaterThanOrEqual(0.3 - 1e-9);
  });

  it('measures the eye floor against the true ground on a fast uphill, not the eased height', () => {
    // 1 m of rise per metre of -z at 2 m/s: the eased ground height lags the true one by 0.16 m.
    const climb: Ground = { heightAt: (_x, z) => -z };
    const state = at(0, 0);
    state.seatedOffset = -0.5;
    const head = { ...STANDING, y: 0.5 };
    let worst = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 200; i += 1) {
      step(state, FORWARD, climb, SEATED, 0.02, head);
      const eye = state.position[1] + head.y - climb.heightAt(state.position[0], state.position[2]);
      worst = Math.min(worst, eye);
    }
    expect(worst).toBeGreaterThanOrEqual(0.3 - 1e-9);
  });

  it('applies the offset only while seated', () => {
    const state = at(0, 0);
    calibrateSeated(state, SEATED, 1.1);
    run(state, 1, 0.011, IDLE, FLAT_GROUND, SETTINGS, { ...STANDING, y: 1.1 });
    expect(state.position[1]).toBe(0);
  });

  it('does not alter physical movement deltas or stick movement', () => {
    // The same physical head walk and stick input, standing and seated, on a slope.
    const walk = (settings: LocomotionSettings): number[][] => {
      const state = at(0, 0, 0.3);
      calibrateSeated(state, settings, 1.1);
      const out: number[][] = [];
      for (let i = 0; i < 40; i += 1) {
        const head = { x: 0.01 * i, y: 1.1, z: -0.02 * i, yaw: 0.2 };
        const input = i < 20 ? FORWARD : IDLE;
        step(state, input, SLOPE, settings, 0.011, head);
        out.push([...state.position]);
      }
      return out;
    };
    const standing = walk(SETTINGS);
    const seated = walk(SEATED);
    for (let i = 0; i < standing.length; i += 1) {
      const [sx, sy, sz] = standing[i] as number[];
      const [tx, ty, tz] = seated[i] as number[];
      expect(tx).toBe(sx);
      expect(tz).toBe(sz);
      expect(ty - sy).toBeCloseTo(0.5, 12);
    }
  });
});
