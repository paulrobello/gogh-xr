import { ArrayCamera, PerspectiveCamera, type WebGLRenderer } from 'three';
import { expect, test } from 'vitest';
import type { StrokeBatch } from '../src/render/strokes/batch.ts';
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

test('sharp and sharp4 keep alpha-to-coverage and only set their gain, and with no mode the materials stay untouched', () => {
  const renderer = { xr: { cameraAutoUpdate: true } } as unknown as WebGLRenderer;
  const fakeBatch = () => ({
    materials: {
      a: { alphaToCoverage: true, defines: {} as Record<string, unknown>, needsUpdate: false },
    },
    atlas: {},
    setOrderPolicy: () => {},
  });

  for (const [mode, gain] of [
    ['sharp', 2],
    ['sharp4', 4],
  ] as const) {
    const batch = fakeBatch();
    createZdiag(mode, renderer).applyToBatch(batch as unknown as StrokeBatch);
    expect(batch.materials.a.alphaToCoverage).toBe(true);
    expect(batch.materials.a.defines).toEqual({ ZDIAG_SHARP_GAIN: gain });
    expect(batch.materials.a.needsUpdate).toBe(true);
  }

  const off = fakeBatch();
  createZdiag(null, renderer).applyToBatch(off as unknown as StrokeBatch);
  expect(off.materials.a.defines).toEqual({});
  expect(off.materials.a.needsUpdate).toBe(false);
});
