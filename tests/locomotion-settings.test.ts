import { expect, test } from 'vitest';
import {
  clampLocomotionSettings,
  DEFAULT_LOCOMOTION_SETTINGS,
  type LocomotionSettings,
  MAX_MOVE_SPEED,
  MAX_SMOOTH_TURN_DEG_PER_SEC,
  MIN_MOVE_SPEED,
  MIN_SMOOTH_TURN_DEG_PER_SEC,
} from '../src/locomotion/settings';

test('the defaults are 2.0 m/s, standing at 1.6 m, 30° snap turn and a 0.6 vignette', () => {
  expect(DEFAULT_LOCOMOTION_SETTINGS).toEqual({
    moveSpeed: 2,
    seated: false,
    standingHeight: 1.6,
    turnMode: 'snap',
    snapAngleDeg: 30,
    smoothTurnDegPerSec: 90,
    vignette: 0.6,
  });
  expect([MIN_MOVE_SPEED, MAX_MOVE_SPEED]).toEqual([1, 3]);
  expect([MIN_SMOOTH_TURN_DEG_PER_SEC, MAX_SMOOTH_TURN_DEG_PER_SEC]).toEqual([30, 180]);
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

test('the clamp keeps the turn mode and the snap angle to their choices', () => {
  // Untyped input, as P5.2's persisted settings will be.
  const clamp = (patch: Record<string, unknown>) =>
    clampLocomotionSettings({ ...DEFAULT_LOCOMOTION_SETTINGS, ...patch } as LocomotionSettings);
  expect(clamp({ turnMode: 'smooth' }).turnMode).toBe('smooth');
  expect(clamp({ turnMode: 'spin' }).turnMode).toBe('snap');
  expect(clamp({ snapAngleDeg: 45 }).snapAngleDeg).toBe(45);
  expect(clamp({ snapAngleDeg: 90 }).snapAngleDeg).toBe(30);
  expect(clamp({ snapAngleDeg: Number.NaN }).snapAngleDeg).toBe(30);
});

test('the clamp holds smooth turn to 30-180°/s and the vignette to 0-1', () => {
  const turn = (smoothTurnDegPerSec: number) =>
    clampLocomotionSettings({ ...DEFAULT_LOCOMOTION_SETTINGS, smoothTurnDegPerSec })
      .smoothTurnDegPerSec;
  expect(turn(10)).toBe(30);
  expect(turn(120)).toBe(120);
  expect(turn(400)).toBe(180);
  expect(turn(Number.NaN)).toBe(90);
  const vignette = (strength: number) =>
    clampLocomotionSettings({ ...DEFAULT_LOCOMOTION_SETTINGS, vignette: strength }).vignette;
  expect(vignette(-0.5)).toBe(0);
  expect(vignette(0)).toBe(0);
  expect(vignette(0.3)).toBe(0.3);
  expect(vignette(2)).toBe(1);
  expect(vignette(Number.NaN)).toBe(0.6);
});
