export const EYE_HEIGHT = 1.6;
export const LOOK_SENSITIVITY = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

/** Yaw 0 faces -Z (three.js camera default); positive yaw turns left. */
export interface Look {
  yaw: number;
  pitch: number;
}

export function applyLook(
  look: Look,
  dx: number,
  dy: number,
  sensitivity: number = LOOK_SENSITIVITY,
): Look {
  return {
    yaw: look.yaw - dx * sensitivity,
    pitch: Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, look.pitch - dy * sensitivity)),
  };
}
