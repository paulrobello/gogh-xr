import { PerspectiveCamera } from 'three';
import { expect, test, vi } from 'vitest';
import {
  DEFAULT_DESKTOP_START,
  installDesktopControls,
  requestLock,
} from '../src/desktop/controls.ts';
import { EYE_HEIGHT } from '../src/desktop/walk.ts';

function canvasWith(requestPointerLock: () => unknown): HTMLCanvasElement {
  return { requestPointerLock } as unknown as HTMLCanvasElement;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('a rejecting requestPointerLock raises no unhandled rejection', async () => {
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  const request = vi.fn(() => Promise.reject(new Error('WrongDocumentError')));
  requestLock(canvasWith(request));
  await settle();
  process.off('unhandledRejection', unhandled);
  expect(request).toHaveBeenCalledOnce();
  expect(unhandled).not.toHaveBeenCalled();
});

test('non-promise and throwing variants are tolerated', () => {
  expect(() => requestLock(canvasWith(() => undefined))).not.toThrow();
  expect(() =>
    requestLock(
      canvasWith(() => {
        throw new Error('refused');
      }),
    ),
  ).not.toThrow();
});

test('the desktop viewer starts at the given floor position, or the default one', () => {
  const at = (start?: { x: number; z: number }): number[] => {
    const camera = new PerspectiveCamera();
    installDesktopControls(document.createElement('canvas'), camera, start).update(0);
    return camera.position.toArray();
  };
  expect(at()).toEqual([DEFAULT_DESKTOP_START.x, EYE_HEIGHT, DEFAULT_DESKTOP_START.z]);
  expect(at({ x: 1, z: -2 })).toEqual([1, EYE_HEIGHT, -2]);
});

test('setPose places the eye exactly, straight down and up included', () => {
  const camera = new PerspectiveCamera();
  const controls = installDesktopControls(document.createElement('canvas'), camera);
  controls.setPose(3, 30, -4, 0.5, -Math.PI / 2);
  controls.update(0.016);
  expect(camera.position.toArray()).toEqual([3, 30, -4]);
  expect(camera.rotation.x).toBe(-Math.PI / 2);
  expect(camera.rotation.y).toBe(0.5);
  controls.setPose(0, 1.6, 0, 0, Math.PI / 2);
  controls.update(0.016);
  expect(camera.rotation.x).toBe(Math.PI / 2);
  expect(camera.position.toArray()).toEqual([0, 1.6, 0]);
});
