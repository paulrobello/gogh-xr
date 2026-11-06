import { PerspectiveCamera } from 'three';
import { expect, test, vi } from 'vitest';
import { installDesktopControls, requestLock } from '../src/desktop/controls.ts';
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

test('the camera sits EYE_HEIGHT above its rig, looking level, until the mouse looks', () => {
  const camera = new PerspectiveCamera();
  installDesktopControls(document.createElement('canvas'), camera).update();
  expect(camera.position.toArray()).toEqual([0, EYE_HEIGHT, 0]);
  expect(camera.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
});

test('setLook sets yaw and pitch exactly, straight down and up included', () => {
  const camera = new PerspectiveCamera();
  const controls = installDesktopControls(document.createElement('canvas'), camera);
  controls.setLook(0.5, -Math.PI / 2);
  controls.update();
  expect(camera.position.toArray()).toEqual([0, EYE_HEIGHT, 0]);
  expect(camera.rotation.x).toBe(-Math.PI / 2);
  expect(camera.rotation.y).toBe(0.5);
  expect(camera.rotation.order).toBe('YXZ');
  controls.setLook(0, Math.PI / 2);
  controls.update();
  expect(camera.rotation.x).toBe(Math.PI / 2);
  expect(camera.rotation.y).toBe(0);
});
