export const EYE_HEIGHT = 1.6;
export const WALK_SPEED = 3;
export const SPRINT_MULTIPLIER = 2;
export const LOOK_SENSITIVITY = 0.0022;
export const MAX_STEP_SECONDS = 0.1;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

export interface WalkInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
}

export interface WalkPose {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
}

export function emptyInput(): WalkInput {
  return { forward: false, back: false, left: false, right: false, sprint: false };
}

/** Yaw 0 faces -Z (three.js camera default); positive yaw turns left. */
export function stepWalk(pose: WalkPose, input: WalkInput, dt: number): WalkPose {
  const step = Math.min(Math.max(dt, 0), MAX_STEP_SECONDS);
  const forwardAxis = Number(input.forward) - Number(input.back);
  const rightAxis = Number(input.right) - Number(input.left);
  if ((forwardAxis === 0 && rightAxis === 0) || step === 0) return { ...pose };
  const length = Math.hypot(forwardAxis, rightAxis);
  const speed = WALK_SPEED * (input.sprint ? SPRINT_MULTIPLIER : 1) * step;
  const sin = Math.sin(pose.yaw);
  const cos = Math.cos(pose.yaw);
  return {
    ...pose,
    x: pose.x + ((-sin * forwardAxis + cos * rightAxis) / length) * speed,
    z: pose.z + ((-cos * forwardAxis - sin * rightAxis) / length) * speed,
  };
}

export function applyLook(
  pose: WalkPose,
  dx: number,
  dy: number,
  sensitivity: number = LOOK_SENSITIVITY,
): WalkPose {
  return {
    ...pose,
    yaw: pose.yaw - dx * sensitivity,
    pitch: Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, pose.pitch - dy * sensitivity)),
  };
}
