import { expect, test } from 'vitest';
import { applyLook } from '../src/desktop/walk.ts';

const level = { yaw: 0, pitch: 0 };

test('mouse right turns right (yaw decreases) and pitch is clamped', () => {
  expect(applyLook(level, 100, 0, 0.01).yaw).toBeCloseTo(-1);
  expect(applyLook(level, 0, -1e6, 0.01).pitch).toBeLessThan(Math.PI / 2);
  expect(applyLook(level, 0, -1e6, 0.01).pitch).toBeGreaterThan(1.5);
  expect(applyLook(level, 0, 1e6, 0.01).pitch).toBeGreaterThan(-Math.PI / 2);
});

test('does not mutate the input look', () => {
  const look = { ...level };
  applyLook(look, 10, 10);
  expect(look).toEqual(level);
});
