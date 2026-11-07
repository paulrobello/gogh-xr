/**
 * The right controller's target-ray space, the teleport aim source in XR (P3.4).
 *
 * three assigns a new input source only to a controller slot that already exists, so both slots
 * are created here, before any session. Their spaces go under the rig, not the scene (parked note
 * M8): the target-ray pose is in the local-floor space the rig carries, so it moves with smooth
 * movement and turns. A space's -Z is its ray (src/xr/input.ts, ray convention).
 */
import type { Group, Object3D, WebXRSpaceEventMap } from 'three';

/** Controller slots to create: one per hand. */
export const CONTROLLER_SLOTS = 2;

/** The part of three's `WebXRManager` this reads. */
export interface ControllerSpaces {
  getController(index: number): Group<WebXRSpaceEventMap>;
}

/**
 * Creates the slots, parents their target-ray spaces under `parent`, and returns a getter for the
 * right hand's space: null until a right-handed source connects, and on any frame three found no
 * pose for it (it hides the space then).
 */
export function trackRightController(
  xr: ControllerSpaces,
  parent: Object3D,
): () => Object3D | null {
  const spaces: Object3D[] = [];
  const right: boolean[] = [];
  for (let i = 0; i < CONTROLLER_SLOTS; i += 1) {
    const space = xr.getController(i);
    parent.add(space);
    spaces.push(space);
    right.push(false);
    space.addEventListener('connected', (event) => {
      right[i] = event.data?.handedness === 'right';
    });
    space.addEventListener('disconnected', () => {
      right[i] = false;
    });
  }
  return () => {
    for (let i = 0; i < CONTROLLER_SLOTS; i += 1) {
      const space = spaces[i] as Object3D;
      if (right[i] && space.visible) return space;
    }
    return null;
  };
}
