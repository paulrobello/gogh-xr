/**
 * The locomotion settings P3.2 needs. No persistence yet: P5.2 adds it, and P3.3-P3.5 add their
 * own fields.
 */
export interface LocomotionSettings {
  /** Smooth movement speed at full stick, m/s, 1.0-3.0. */
  readonly moveSpeed: number;
  /** Seated mode: the rig rises by the calibrated offset so the eye sits at standing height. */
  readonly seated: boolean;
  /** The eye height seated mode raises the viewer to, metres. Calibrated by the user. */
  readonly standingHeight: number;
}

export const MIN_MOVE_SPEED = 1;
export const MAX_MOVE_SPEED = 3;
/** Standing heights outside this range are a mistyped calibration, not a person. */
const MIN_STANDING_HEIGHT = 1;
const MAX_STANDING_HEIGHT = 2.2;

export const DEFAULT_LOCOMOTION_SETTINGS: LocomotionSettings = Object.freeze({
  moveSpeed: 2,
  seated: false,
  standingHeight: 1.6,
});

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Enforces the bounds; a non-finite number falls back to its default. */
export function clampLocomotionSettings(settings: LocomotionSettings): LocomotionSettings {
  return Object.freeze({
    moveSpeed: clamp(
      settings.moveSpeed,
      MIN_MOVE_SPEED,
      MAX_MOVE_SPEED,
      DEFAULT_LOCOMOTION_SETTINGS.moveSpeed,
    ),
    seated: settings.seated,
    standingHeight: clamp(
      settings.standingHeight,
      MIN_STANDING_HEIGHT,
      MAX_STANDING_HEIGHT,
      DEFAULT_LOCOMOTION_SETTINGS.standingHeight,
    ),
  });
}
