import { expect, test } from 'vitest';
import { createLocomotionState, type HeadPose } from '../src/locomotion/step.ts';
import { clampToWalkBounds, type WalkBounds } from '../src/locomotion/walk-bounds.ts';

const BOX: WalkBounds = { minX: -2.7, maxX: 2.7, minZ: -3.7, maxZ: 5.7, maxY: 3.2 };
const CENTRED: HeadPose = { x: 0, y: 1.6, z: 0, yaw: 0 };

function rigAt(x: number, y: number, z: number, yaw = 0) {
  const state = createLocomotionState();
  state.position[0] = x;
  state.position[1] = y;
  state.position[2] = z;
  state.yaw = yaw;
  return state;
}

test('a head inside the box is left alone', () => {
  const state = rigAt(1, 0, 2);
  expect(clampToWalkBounds(state, CENTRED, BOX)).toBe(false);
  expect(state.position).toEqual([1, 0, 2]);
});

test('each wall pushes the head back onto it, one axis at a time', () => {
  const north = rigAt(1, 0, -4);
  expect(clampToWalkBounds(north, CENTRED, BOX)).toBe(true);
  expect(north.position).toEqual([1, 0, -3.7]);

  const east = rigAt(3.5, 0, 0);
  clampToWalkBounds(east, CENTRED, BOX);
  expect(east.position).toEqual([2.7, 0, 0]);

  const corner = rigAt(-9, 0, 9);
  clampToWalkBounds(corner, CENTRED, BOX);
  expect(corner.position).toEqual([-2.7, 0, 5.7]);
});

test('the ceiling caps the head’s height, not the rig’s', () => {
  const state = rigAt(0, 2, 0);
  expect(clampToWalkBounds(state, CENTRED, BOX)).toBe(true);
  expect(state.position[1]).toBeCloseTo(3.2 - 1.6, 12);
  // A head below the ceiling never moves the rig down.
  const low = rigAt(0, 1, 0);
  expect(clampToWalkBounds(low, CENTRED, BOX)).toBe(false);
  expect(low.position[1]).toBe(1);
});

test('the clamp follows the head offset through the rig yaw', () => {
  // Turned left 90°, the rig's right (+x) points to -Z: a head 0.5 m right of the rig sits 0.5 m
  // further toward the north wall than the rig.
  const head: HeadPose = { x: 0.5, y: 1.6, z: 0, yaw: 0 };
  const state = rigAt(0, 0, -3.5, Math.PI / 2);
  expect(clampToWalkBounds(state, head, BOX)).toBe(true);
  expect(state.position[0]).toBeCloseTo(0, 12);
  expect(state.position[2]).toBeCloseTo(-3.2, 12);
  // The rig moved by a pure translation: the head now sits exactly on the wall.
  const headZ = state.position[2] - Math.sin(state.yaw) * head.x + Math.cos(state.yaw) * head.z;
  expect(headZ).toBeCloseTo(BOX.minZ, 12);
  expect(state.yaw).toBe(Math.PI / 2);
});

test('an opening lets the head through its wall only within its span', () => {
  const portal: WalkBounds = { ...BOX, opening: { side: 'minZ', from: -0.6, to: 0.6 } };
  const through = rigAt(0.3, 0, -4.5);
  expect(clampToWalkBounds(through, CENTRED, portal)).toBe(false);
  expect(through.position).toEqual([0.3, 0, -4.5]);

  const beside = rigAt(1, 0, -4.5);
  expect(clampToWalkBounds(beside, CENTRED, portal)).toBe(true);
  expect(beside.position).toEqual([1, 0, -3.7]);

  // Only its own side opens: the opposite wall still holds.
  const south = rigAt(0.3, 0, 6);
  clampToWalkBounds(south, CENTRED, portal);
  expect(south.position[2]).toBeCloseTo(5.7, 12);
});
