import { Group, Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCOMOTION_SETTINGS, type LocomotionSettings } from '../src/locomotion/settings';
import {
  createLocomotionState,
  type HeadPose,
  type LocomotionState,
  spawnAt,
} from '../src/locomotion/step';
import { SNAP_COOLDOWN, type TurnInput, turn } from '../src/locomotion/turn';

const DEG = Math.PI / 180;
const SNAP = DEFAULT_LOCOMOTION_SETTINGS;
const SMOOTH: LocomotionSettings = { ...SNAP, turnMode: 'smooth' };
const STANDING: HeadPose = { x: 0, y: 1.6, z: 0, yaw: 0 };
/** A head 0.4 m right of and 0.3 m ahead of the rig origin, looking 46° left. */
const OFFSET_HEAD: HeadPose = { x: 0.4, y: 1.5, z: -0.3, yaw: 0.8 };
const NONE: TurnInput = { turn: { x: 0, snap: 0 } };
const RIGHT: TurnInput = { turn: { x: 1, snap: 1 } };
const LEFT: TurnInput = { turn: { x: -1, snap: -1 } };

function at(x: number, z: number, yaw = 0): LocomotionState {
  const state = createLocomotionState();
  spawnAt(state, x, 0.5, z, yaw);
  return state;
}

/** Idle frames of 50 ms until the snap cooldown has passed. One long dt would be clamped. */
function wait(state: LocomotionState, settings: LocomotionSettings, head: HeadPose): void {
  for (let s = 0; s < SNAP_COOLDOWN; s += 0.05) turn(state, NONE, settings, 0.05, head);
}

/** The head's world position, through three's own transforms. */
function headWorld(state: LocomotionState, head: HeadPose): Vector3 {
  const rig = new Group();
  rig.position.fromArray(state.position);
  rig.rotation.y = state.yaw;
  const eye = new Object3D();
  eye.position.set(head.x, head.y, head.z);
  rig.add(eye);
  rig.updateMatrixWorld(true);
  return eye.getWorldPosition(new Vector3());
}

describe('snap turn', () => {
  it('turns exactly 30° by default: right is negative yaw (clockwise from above), left positive', () => {
    const state = at(0, 0, 0.3);
    turn(state, RIGHT, SNAP, 0.011, STANDING);
    expect(state.yaw).toBeCloseTo(0.3 - 30 * DEG, 14);
    wait(state, SNAP, STANDING);
    turn(state, LEFT, SNAP, 0.011, STANDING);
    expect(state.yaw).toBeCloseTo(0.3, 14);
    // Snap is instant: it adds no turn rate for the vignette.
    expect(state.turnRate).toBe(0);
  });

  it('turns exactly 45° when set', () => {
    const state = at(0, 0);
    turn(state, RIGHT, { ...SNAP, snapAngleDeg: 45 }, 0.011, STANDING);
    expect(state.yaw).toBeCloseTo(-Math.PI / 4, 14);
  });

  it('twelve 30° snaps add up to exactly one full turn', () => {
    const state = at(0, 0);
    for (let i = 0; i < 12; i += 1) {
      turn(state, RIGHT, SNAP, 0.011, STANDING);
      wait(state, SNAP, STANDING);
    }
    expect(state.yaw).toBeCloseTo(-2 * Math.PI, 12);
  });

  it('drops a request inside the 250 ms cooldown and takes one at 250 ms', () => {
    const state = at(0, 0);
    turn(state, RIGHT, SNAP, 0.01, STANDING);
    expect(state.yaw).toBeCloseTo(-30 * DEG, 14);
    // The 24th frame of 10 ms is 240 ms after the snap. Its request is dropped, not queued.
    for (let i = 0; i < 23; i += 1) turn(state, NONE, SNAP, 0.01, STANDING);
    turn(state, RIGHT, SNAP, 0.01, STANDING);
    expect(state.yaw).toBeCloseTo(-30 * DEG, 14);
    // The 25th frame is 250 ms after it.
    turn(state, LEFT, SNAP, 0.01, STANDING);
    expect(state.yaw).toBeCloseTo(0, 14);
  });

  it('is ready on the first request after a spawn', () => {
    const state = at(0, 0);
    turn(state, RIGHT, SNAP, 0, STANDING);
    expect(state.yaw).toBeCloseTo(-30 * DEG, 14);
  });

  it('ignores the stick axis: snap mode has no smooth component', () => {
    const state = at(0, 0, 0.2);
    for (let i = 0; i < 10; i += 1) turn(state, { turn: { x: 1, snap: 0 } }, SNAP, 0.05, STANDING);
    expect(state.yaw).toBe(0.2);
    expect(state.turnRate).toBe(0);
  });
});

describe('smooth turn', () => {
  it('turns at 90°/s scaled by the stick and dt, right negative', () => {
    const state = at(0, 0);
    for (let i = 0; i < 10; i += 1) turn(state, { turn: { x: 1, snap: 0 } }, SMOOTH, 0.1, STANDING);
    expect(state.yaw).toBeCloseTo(-Math.PI / 2, 12);
    expect(state.turnRate).toBeCloseTo(-90 * DEG, 12);
    // Half stick left for 1 s: 45° the other way.
    for (let i = 0; i < 20; i += 1) {
      turn(state, { turn: { x: -0.5, snap: 0 } }, SMOOTH, 0.05, STANDING);
    }
    expect(state.yaw).toBeCloseTo(-Math.PI / 4, 12);
    expect(state.turnRate).toBeCloseTo(45 * DEG, 12);
  });

  it('follows the rate setting', () => {
    const state = at(0, 0);
    turn(
      state,
      { turn: { x: 1, snap: 0 } },
      { ...SMOOTH, smoothTurnDegPerSec: 180 },
      0.1,
      STANDING,
    );
    expect(state.yaw).toBeCloseTo(-18 * DEG, 12);
  });

  it('never snaps, and clamps dt to 0.1 s', () => {
    const state = at(0, 0);
    turn(state, RIGHT, SMOOTH, 5, STANDING);
    expect(state.yaw).toBeCloseTo(-9 * DEG, 12);
    turn(state, NONE, SMOOTH, 0.1, STANDING);
    expect(state.yaw).toBeCloseTo(-9 * DEG, 12);
    expect(state.turnRate).toBe(0);
  });

  it('does nothing with a zero or negative dt', () => {
    const state = at(0, 0, 0.4);
    turn(state, { turn: { x: 1, snap: 0 } }, SMOOTH, 0, STANDING);
    turn(state, { turn: { x: 1, snap: 0 } }, SMOOTH, -1, STANDING);
    expect(state.yaw).toBe(0.4);
  });
});

describe('the pivot', () => {
  const cases: [string, TurnInput, LocomotionSettings, number][] = [
    ['snap right', RIGHT, SNAP, 0.011],
    ['snap left 45°', LEFT, { ...SNAP, snapAngleDeg: 45 }, 0.011],
    ['smooth right', { turn: { x: 1, snap: 0 } }, SMOOTH, 0.1],
    ['smooth left, half stick', { turn: { x: -0.5, snap: 0 } }, SMOOTH, 0.05],
  ];
  for (const [name, input, settings, dt] of cases) {
    it(`${name} keeps the head's world position, with the head offset from the rig origin`, () => {
      const state = at(2, -1, 0.7);
      const before = headWorld(state, OFFSET_HEAD);
      const yaw = state.yaw;
      for (let i = 0; i < 5; i += 1) {
        turn(state, input, settings, dt, OFFSET_HEAD);
        wait(state, settings, OFFSET_HEAD);
      }
      expect(state.yaw).not.toBeCloseTo(yaw, 3);
      const after = headWorld(state, OFFSET_HEAD);
      expect(after.x).toBeCloseTo(before.x, 12);
      expect(after.y).toBeCloseTo(before.y, 12);
      expect(after.z).toBeCloseTo(before.z, 12);
      // The rig itself moved: a turn about the rig origin would have swung the head.
      expect(Math.hypot(state.position[0] - 2, state.position[2] + 1)).toBeGreaterThan(0.05);
      expect(state.position[1]).toBe(0.5);
    });
  }

  it('with the head over the rig origin, the rig does not move', () => {
    const state = at(2, -1, 0.7);
    turn(state, RIGHT, SNAP, 0.011, STANDING);
    expect(state.position[0]).toBeCloseTo(2, 14);
    expect(state.position[2]).toBeCloseTo(-1, 14);
  });
});
