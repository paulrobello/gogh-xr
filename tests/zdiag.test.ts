import { ArrayCamera, PerspectiveCamera, type WebGLRenderer } from 'three';
import { expect, test } from 'vitest';
import { createZdiag } from '../src/render/zdiag.ts';

test('freeze drops its frozen poses when the XR session ends', () => {
  const xrCamera = new ArrayCamera([new PerspectiveCamera()]);
  const xr = {
    cameraAutoUpdate: true,
    isPresenting: true,
    updateCamera: () => {},
    getCamera: () => xrCamera,
  };
  const zdiag = createZdiag('freeze', { xr } as unknown as WebGLRenderer);
  const desktop = new PerspectiveCamera();

  zdiag.beforeRender(desktop);
  expect(zdiag.diag().frozen).toBe(true);

  xr.isPresenting = false;
  zdiag.beforeRender(desktop);
  expect(zdiag.diag().frozen).toBe(false);

  xr.isPresenting = true;
  xrCamera.matrixWorld.makeTranslation(1, 2, 3);
  zdiag.beforeRender(desktop);
  expect(zdiag.diag().frozen).toBe(true);
  xrCamera.matrixWorld.makeTranslation(9, 9, 9);
  zdiag.beforeRender(desktop);
  expect(xrCamera.matrixWorld.elements[12]).toBe(1);
});
