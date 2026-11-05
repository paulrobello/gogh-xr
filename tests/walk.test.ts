import { expect, test } from 'vitest';
import {
  applyLook,
  emptyInput,
  MAX_STEP_SECONDS,
  SPRINT_MULTIPLIER,
  stepWalk,
  WALK_SPEED,
} from '../src/desktop/walk.ts';

const origin = { x: 0, z: 0, yaw: 0, pitch: 0 };

test('forward at yaw 0 moves toward -Z', () => {
  const p = stepWalk(origin, { ...emptyInput(), forward: true }, 0.1);
  expect(p.x).toBeCloseTo(0);
  expect(p.z).toBeCloseTo(-WALK_SPEED * 0.1);
});

test('strafe right at yaw 0 moves toward +X', () => {
  const p = stepWalk(origin, { ...emptyInput(), right: true }, 0.1);
  expect(p.x).toBeCloseTo(WALK_SPEED * 0.1);
  expect(p.z).toBeCloseTo(0);
});

test('yaw rotates the movement direction', () => {
  const p = stepWalk({ ...origin, yaw: Math.PI / 2 }, { ...emptyInput(), forward: true }, 0.1);
  expect(p.x).toBeCloseTo(-WALK_SPEED * 0.1);
  expect(p.z).toBeCloseTo(0);
});

test('diagonal movement is not faster than straight', () => {
  const p = stepWalk(origin, { ...emptyInput(), forward: true, right: true }, 0.1);
  expect(Math.hypot(p.x, p.z)).toBeCloseTo(WALK_SPEED * 0.1);
});

test('opposing keys cancel; no input leaves pose unchanged', () => {
  expect(stepWalk(origin, { ...emptyInput(), forward: true, back: true }, 0.1)).toEqual(origin);
  expect(stepWalk(origin, emptyInput(), 0.1)).toEqual(origin);
});

test('sprint multiplies speed and dt is clamped', () => {
  const sprint = stepWalk(origin, { ...emptyInput(), forward: true, sprint: true }, 0.1);
  expect(sprint.z).toBeCloseTo(-WALK_SPEED * SPRINT_MULTIPLIER * 0.1);
  const long = stepWalk(origin, { ...emptyInput(), forward: true }, 5);
  expect(long.z).toBeCloseTo(-WALK_SPEED * MAX_STEP_SECONDS);
  expect(stepWalk(origin, { ...emptyInput(), forward: true }, -1)).toEqual(origin);
});

test('does not mutate the input pose', () => {
  const pose = { ...origin };
  stepWalk(pose, { ...emptyInput(), forward: true }, 0.1);
  expect(pose).toEqual(origin);
});

test('mouse right turns right (yaw decreases) and pitch is clamped', () => {
  expect(applyLook(origin, 100, 0, 0.01).yaw).toBeCloseTo(-1);
  expect(applyLook(origin, 0, -1e6, 0.01).pitch).toBeLessThan(Math.PI / 2);
  expect(applyLook(origin, 0, -1e6, 0.01).pitch).toBeGreaterThan(1.5);
  expect(applyLook(origin, 0, 1e6, 0.01).pitch).toBeGreaterThan(-Math.PI / 2);
});
