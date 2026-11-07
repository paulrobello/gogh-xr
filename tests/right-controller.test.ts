import { Group, Object3D, type WebXRSpaceEventMap } from 'three';
import { describe, expect, it } from 'vitest';
import { CONTROLLER_SLOTS, trackRightController } from '../src/xr/right-controller';

type Space = Group<WebXRSpaceEventMap>;

/** three's WebXRManager.getController: one target-ray Group per slot, created on first ask. */
function fakeXr() {
  const spaces: Space[] = [];
  return {
    spaces,
    getController(index: number): Space {
      spaces[index] ??= new Group<WebXRSpaceEventMap>();
      return spaces[index] as Space;
    },
  };
}

function connect(space: Space, handedness: string): void {
  space.visible = true;
  space.dispatchEvent({ type: 'connected', data: { handedness } as XRInputSource });
}

describe('trackRightController', () => {
  it('creates both controller slots up front and parents them under the rig', () => {
    const xr = fakeXr();
    const rig = new Object3D();
    trackRightController(xr, rig);
    expect(CONTROLLER_SLOTS).toBe(2);
    expect(xr.spaces).toHaveLength(2);
    for (const space of xr.spaces) expect(space.parent).toBe(rig);
  });

  it('returns the slot whose input source is right-handed, whichever slot it got', () => {
    const xr = fakeXr();
    const right = trackRightController(xr, new Object3D());
    expect(right()).toBeNull();
    const [first, second] = xr.spaces as [Space, Space];
    connect(first, 'left');
    expect(right()).toBeNull();
    connect(second, 'right');
    expect(right()).toBe(second);
  });

  it('returns null while the right target ray is untracked, and after it disconnects', () => {
    const xr = fakeXr();
    const right = trackRightController(xr, new Object3D());
    const space = xr.spaces[0] as Space;
    connect(space, 'right');
    // three hides a target-ray space on a frame with no pose.
    space.visible = false;
    expect(right()).toBeNull();
    space.visible = true;
    expect(right()).toBe(space);
    space.dispatchEvent({ type: 'disconnected', data: { handedness: 'right' } as XRInputSource });
    expect(right()).toBeNull();
  });
});
