/**
 * The locomotion settings. No persistence yet: P5.2 adds it, and P3.4-P3.5 add their own fields.
 */
export type TurnMode = 'snap' | 'smooth';
export type SnapAngleDeg = 30 | 45;

export interface LocomotionSettings {
  /** Smooth movement speed at full stick, m/s, 1.0-3.0. */
  readonly moveSpeed: number;
  /** Seated mode: the rig rises by the calibrated offset so the eye sits at standing height. */
  readonly seated: boolean;
  /** The eye height seated mode raises the viewer to, metres. Calibrated by the user. */
  readonly standingHeight: number;
  /** Right stick X: a snap per push (`snap`), or a continuous turn (`smooth`). */
  readonly turnMode: TurnMode;
  /** The snap turn step, degrees. */
  readonly snapAngleDeg: SnapAngleDeg;
  /** Smooth turn rate at full stick, degrees per second, 30-180. */
  readonly smoothTurnDegPerSec: number;
  /** Tunnel vignette strength, 0-1: its alpha at full comfort factor. 0 turns it off. */
  readonly vignette: number;
}

export const MIN_MOVE_SPEED = 1;
export const MAX_MOVE_SPEED = 3;
export const MIN_SMOOTH_TURN_DEG_PER_SEC = 30;
export const MAX_SMOOTH_TURN_DEG_PER_SEC = 180;
/** Standing heights outside this range are a mistyped calibration, not a person. */
const MIN_STANDING_HEIGHT = 1;
const MAX_STANDING_HEIGHT = 2.2;

export const DEFAULT_LOCOMOTION_SETTINGS: LocomotionSettings = Object.freeze({
  moveSpeed: 2,
  seated: false,
  standingHeight: 1.6,
  turnMode: 'snap',
  snapAngleDeg: 30,
  smoothTurnDegPerSec: 90,
  vignette: 0.6,
});

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Enforces the bounds; a non-finite number or an unknown choice falls back to its default. */
export function clampLocomotionSettings(settings: LocomotionSettings): LocomotionSettings {
  const defaults = DEFAULT_LOCOMOTION_SETTINGS;
  return Object.freeze({
    moveSpeed: clamp(settings.moveSpeed, MIN_MOVE_SPEED, MAX_MOVE_SPEED, defaults.moveSpeed),
    seated: settings.seated,
    standingHeight: clamp(
      settings.standingHeight,
      MIN_STANDING_HEIGHT,
      MAX_STANDING_HEIGHT,
      defaults.standingHeight,
    ),
    turnMode: settings.turnMode === 'smooth' ? 'smooth' : 'snap',
    snapAngleDeg: settings.snapAngleDeg === 45 ? 45 : 30,
    smoothTurnDegPerSec: clamp(
      settings.smoothTurnDegPerSec,
      MIN_SMOOTH_TURN_DEG_PER_SEC,
      MAX_SMOOTH_TURN_DEG_PER_SEC,
      defaults.smoothTurnDegPerSec,
    ),
    vignette: clamp(settings.vignette, 0, 1, defaults.vignette),
  });
}
