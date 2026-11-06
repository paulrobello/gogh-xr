import type { PerspectiveCamera } from 'three';
import { applyLook, EYE_HEIGHT, emptyInput, stepWalk, type WalkInput, type WalkPose } from './walk';

const KEY_MAP: Readonly<Record<string, keyof WalkInput>> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
};

/** Pointer lock is optional: keyboard walking works without it, so refusals are ignored. */
export function requestLock(canvas: HTMLCanvasElement): void {
  try {
    const result: unknown = canvas.requestPointerLock();
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // lock refused synchronously
  }
}

export interface DesktopControls {
  update(dt: number): void;
}

/** Where the desktop viewer starts on the floor, facing -z. */
export const DEFAULT_DESKTOP_START: Readonly<{ x: number; z: number }> = { x: 0, z: 4 };

export function installDesktopControls(
  canvas: HTMLCanvasElement,
  camera: PerspectiveCamera,
  start: Readonly<{ x: number; z: number }> = DEFAULT_DESKTOP_START,
): DesktopControls {
  const input = emptyInput();
  let pose: WalkPose = { x: start.x, z: start.z, yaw: 0, pitch: 0 };
  camera.rotation.order = 'YXZ';

  function setKey(event: KeyboardEvent, down: boolean): void {
    const action = KEY_MAP[event.code];
    if (action) input[action] = down;
  }

  window.addEventListener('keydown', (event) => setKey(event, true));
  window.addEventListener('keyup', (event) => setKey(event, false));
  window.addEventListener('blur', () => Object.assign(input, emptyInput()));
  canvas.addEventListener('click', () => {
    if (document.pointerLockElement !== canvas) requestLock(canvas);
  });
  document.addEventListener('mousemove', (event) => {
    if (document.pointerLockElement === canvas) {
      pose = applyLook(pose, event.movementX, event.movementY);
    }
  });

  return {
    update(dt: number): void {
      pose = stepWalk(pose, input, dt);
      camera.position.set(pose.x, EYE_HEIGHT, pose.z);
      camera.rotation.set(pose.pitch, pose.yaw, 0);
    },
  };
}
