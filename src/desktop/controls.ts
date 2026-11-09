import type { PerspectiveCamera } from 'three';
import { applyLook, EYE_HEIGHT, type Look } from './walk';

/** Pointer lock is optional: keyboard walking works without it, so refusals are ignored. */
export function requestLock(canvas: HTMLCanvasElement): void {
  try {
    const result: unknown = canvas.requestPointerLock();
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // lock refused synchronously
  }
}

/** Frees the mouse when an XR session starts: a held lock would keep the desktop cursor hidden. */
export function releaseLock(doc: Pick<Document, 'pointerLockElement' | 'exitPointerLock'>): void {
  if (doc.pointerLockElement) doc.exitPointerLock();
}

/**
 * Desktop mouse look. The camera sits in the locomotion rig (src/locomotion/), which carries the
 * position and the rig yaw, so these controls only write the camera's local transform: the eye
 * EYE_HEIGHT above the rig, turned by the look yaw and pitch. Movement keys reach locomotion
 * through the input action layer (src/xr/input.ts).
 */
export interface DesktopControls {
  /** Writes the look onto the camera. Call once per desktop frame, before locomotion reads it. */
  update(): void;
  /** Sets the look exactly: pitch is not clamped, so ±π/2 looks straight up or down. */
  setLook(yaw: number, pitch: number): void;
}

export function installDesktopControls(
  canvas: HTMLCanvasElement,
  camera: PerspectiveCamera,
): DesktopControls {
  let look: Look = { yaw: 0, pitch: 0 };
  camera.rotation.order = 'YXZ';

  canvas.addEventListener('click', () => {
    if (document.pointerLockElement !== canvas) requestLock(canvas);
  });
  document.addEventListener('mousemove', (event) => {
    if (document.pointerLockElement === canvas) {
      look = applyLook(look, event.movementX, event.movementY);
    }
  });

  return {
    update(): void {
      camera.position.set(0, EYE_HEIGHT, 0);
      camera.rotation.set(look.pitch, look.yaw, 0);
    },
    setLook(yaw: number, pitch: number): void {
      look = { yaw, pitch };
    },
  };
}
