import { expect, test } from 'vitest';
import {
  clampLocomotionSettings,
  DEFAULT_LOCOMOTION_SETTINGS,
  MAX_MOVE_SPEED,
  MIN_MOVE_SPEED,
} from '../src/locomotion/settings';

test('the defaults are 2.0 m/s, standing, with a 1.6 m standing height', () => {
  expect(DEFAULT_LOCOMOTION_SETTINGS).toEqual({ moveSpeed: 2, seated: false, standingHeight: 1.6 });
  expect([MIN_MOVE_SPEED, MAX_MOVE_SPEED]).toEqual([1, 3]);
});

test('the clamp holds the move speed to 1.0-3.0 m/s', () => {
  const at = (moveSpeed: number) =>
    clampLocomotionSettings({ ...DEFAULT_LOCOMOTION_SETTINGS, moveSpeed }).moveSpeed;
  expect(at(0.2)).toBe(1);
  expect(at(2.5)).toBe(2.5);
  expect(at(9)).toBe(3);
  expect(at(Number.NaN)).toBe(DEFAULT_LOCOMOTION_SETTINGS.moveSpeed);
});

test('the clamp keeps the standing height plausible and passes seated through', () => {
  const at = (standingHeight: number) =>
    clampLocomotionSettings({ ...DEFAULT_LOCOMOTION_SETTINGS, standingHeight }).standingHeight;
  expect(at(0)).toBe(1);
  expect(at(1.75)).toBe(1.75);
  expect(at(5)).toBe(2.2);
  expect(at(Number.NaN)).toBe(DEFAULT_LOCOMOTION_SETTINGS.standingHeight);
  expect(clampLocomotionSettings({ ...DEFAULT_LOCOMOTION_SETTINGS, seated: true }).seated).toBe(
    true,
  );
});
