import {
  ArrayCamera,
  BufferGeometry,
  type Mesh,
  PerspectiveCamera,
  type WebGLRenderer,
} from 'three';
import { expect, test } from 'vitest';
import { ZDIAG_MODES } from '../src/diag/flags.ts';
import { DEFAULT_ORDER_POLICY, type StrokeBatch } from '../src/render/strokes/batch.ts';
import { createZdiag, ZDIAG_STROKES_AFTER_BASE } from '../src/render/zdiag.ts';

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

/** three's LessEqualDepth and AlwaysDepth, LinearFilter and LinearMipmapLinearFilter. */
const LESS_EQUAL = 3;
const ALWAYS = 1;
const LINEAR = 1006;
const TRILINEAR = 1008;

/** A batch whose materials and atlas start at the stroke defaults. */
function realishBatch() {
  const material = () => ({
    depthWrite: true,
    depthFunc: LESS_EQUAL,
    alphaToCoverage: true,
    defines: { BRUSH_COUNT: 8 } as Record<string, unknown>,
    needsUpdate: false,
  });
  const policies: unknown[] = [];
  return {
    materials: { near: material(), mid: material(), far: material() },
    atlas: { minFilter: TRILINEAR, generateMipmaps: true, anisotropy: 1, needsUpdate: false },
    chunks: [{ geometry: new BufferGeometry() }],
    policies,
    setOrderPolicy: (policy: unknown) => policies.push(policy),
  };
}

function snapshot(batch: ReturnType<typeof realishBatch>) {
  return structuredClone({
    materials: Object.values(batch.materials).map(({ needsUpdate: _, ...rest }) => rest),
    atlas: { ...batch.atlas, needsUpdate: undefined },
  });
}

const fakeRenderer = () =>
  ({
    xr: { cameraAutoUpdate: true, isPresenting: false },
    capabilities: { getMaxAnisotropy: () => 16 },
  }) as unknown as WebGLRenderer;

test('setMode switches through every mode and base restores the exact default state', () => {
  const renderer = fakeRenderer();
  const zdiag = createZdiag(null, renderer);
  const batch = realishBatch();
  zdiag.applyToBatch(batch as unknown as StrokeBatch);
  const base = snapshot(batch);
  expect(batch.policies).toEqual([]);
  expect(batch.materials.near.needsUpdate).toBe(false);

  for (const mode of ZDIAG_MODES) {
    zdiag.setMode(mode);
    zdiag.setMode(null);
    expect(snapshot(batch), mode).toEqual(base);
    expect(batch.materials.near.defines).not.toHaveProperty('ZDIAG_ALPHA_TEST');
    expect(batch.materials.near.defines).not.toHaveProperty('ZDIAG_SHARP_GAIN');
    expect(renderer.xr.cameraAutoUpdate).toBe(true);
  }
  // Every policy change went back to the batch default.
  expect(batch.policies.at(-1)).toEqual(DEFAULT_ORDER_POLICY);
  expect(zdiag.diag().state?.order).toEqual(DEFAULT_ORDER_POLICY);
  expect(zdiag.diag()).toMatchObject({ mode: null, applied: false });
});

test('setMode applies each mode on top of the defaults, never on top of the last mode', () => {
  const zdiag = createZdiag(null, fakeRenderer());
  const batch = realishBatch();
  zdiag.applyToBatch(batch as unknown as StrokeBatch);

  zdiag.setMode('noa2c');
  expect(batch.materials.far).toMatchObject({ alphaToCoverage: false, needsUpdate: true });
  expect(batch.materials.far.defines).toEqual({ BRUSH_COUNT: 8, ZDIAG_ALPHA_TEST: 1 });

  zdiag.setMode('sharp');
  expect(batch.materials.far.alphaToCoverage).toBe(true);
  expect(batch.materials.far.defines).toEqual({ BRUSH_COUNT: 8, ZDIAG_SHARP_GAIN: 2 });

  zdiag.setMode('nowrite');
  expect(batch.materials.near).toMatchObject({ depthWrite: false, depthFunc: LESS_EQUAL });
  expect(batch.materials.near.defines).toEqual({ BRUSH_COUNT: 8 });
  expect(batch.policies.at(-1)).toEqual({
    base: ZDIAG_STROKES_AFTER_BASE,
    reverse: true,
    freeze: false,
  });

  zdiag.setMode('strokeorder');
  expect(batch.materials.mid).toMatchObject({ depthWrite: true, depthFunc: ALWAYS });
  expect(batch.policies.at(-1)).toEqual(DEFAULT_ORDER_POLICY);

  zdiag.setMode('nomip');
  expect(batch.materials.mid.depthFunc).toBe(LESS_EQUAL);
  expect(batch.atlas).toMatchObject({
    minFilter: LINEAR,
    generateMipmaps: false,
    needsUpdate: true,
  });
  batch.atlas.needsUpdate = false;
  zdiag.setMode('mip');
  expect(batch.atlas).toMatchObject({
    minFilter: TRILINEAR,
    generateMipmaps: true,
    anisotropy: 16,
    needsUpdate: true,
  });
  expect(zdiag.diag()).toMatchObject({ mode: 'mip', applied: true });
});

test('a rebind replaces the bound batch, so a later switch leaves the old one alone', () => {
  const zdiag = createZdiag('noa2c', fakeRenderer());
  const first = realishBatch();
  const second = realishBatch();
  second.materials.near.depthFunc = ALWAYS;
  zdiag.applyToBatch(first as unknown as StrokeBatch);
  zdiag.applyToBatch(second as unknown as StrokeBatch);
  expect(second.materials.near.alphaToCoverage).toBe(false);
  expect(zdiag.diag().state?.depthFunc).toBe(ALWAYS);
  zdiag.setMode(null);
  expect(second.materials.near.alphaToCoverage).toBe(true);
  // The first batch keeps what it last had: it is no longer bound.
  expect(first.materials.near.alphaToCoverage).toBe(false);
});

test('a mode set before any batch binds applies when one does', () => {
  const zdiag = createZdiag(null, fakeRenderer());
  zdiag.setMode('noa2c');
  expect(zdiag.diag()).toMatchObject({ mode: 'noa2c', applied: false, state: null });
  const batch = realishBatch();
  zdiag.applyToBatch(batch as unknown as StrokeBatch);
  expect(batch.materials.near.alphaToCoverage).toBe(false);
  expect(zdiag.diag()).toMatchObject({
    mode: 'noa2c',
    applied: true,
    state: { alphaToCoverage: false, alphaTest: true, sharpGain: null },
  });
});

test('freeze toggles the XR camera auto-update at runtime and drops its poses on the way out', () => {
  const xrCamera = new ArrayCamera([new PerspectiveCamera()]);
  const xr = {
    cameraAutoUpdate: true,
    isPresenting: true,
    updateCamera: () => {},
    getCamera: () => xrCamera,
  };
  const zdiag = createZdiag(null, { xr } as unknown as WebGLRenderer);
  const desktop = new PerspectiveCamera();
  zdiag.setMode('freeze');
  expect(xr.cameraAutoUpdate).toBe(false);
  zdiag.beforeRender(desktop);
  expect(zdiag.diag().frozen).toBe(true);
  zdiag.setMode('noa2c');
  expect(xr.cameraAutoUpdate).toBe(true);
  expect(zdiag.diag().frozen).toBe(false);
  xrCamera.matrixWorld.makeTranslation(4, 5, 6);
  zdiag.beforeRender(desktop);
  expect(xrCamera.matrixWorld.elements[12]).toBe(4);
});

test('prepare compiles each distinct program once per batch, then restores the current mode', () => {
  const compiled: Record<string, unknown>[][] = [];
  const zdiag = createZdiag('nowrite', fakeRenderer(), (object) => {
    const defines: Record<string, unknown>[] = [];
    object.traverse((child) => {
      const material = (child as Mesh).material as { defines?: Record<string, unknown> };
      if (material?.defines) defines.push({ ...material.defines });
    });
    compiled.push(defines);
  });
  zdiag.prepare([null, 'nowrite', 'noa2c', 'sharp', 'sharp4', 'freeze']);
  expect(compiled).toEqual([]);

  const batch = realishBatch();
  zdiag.applyToBatch(batch as unknown as StrokeBatch);
  // base, ZDIAG_ALPHA_TEST, gain 2 and gain 4, each on all three band materials.
  expect(compiled.map((ds) => ds.length)).toEqual([3, 3, 3, 3]);
  expect(compiled.map((ds) => ds[0])).toEqual([
    { BRUSH_COUNT: 8 },
    { BRUSH_COUNT: 8, ZDIAG_ALPHA_TEST: 1 },
    { BRUSH_COUNT: 8, ZDIAG_SHARP_GAIN: 2 },
    { BRUSH_COUNT: 8, ZDIAG_SHARP_GAIN: 4 },
  ]);
  // Back on nowrite's state.
  expect(batch.materials.near).toMatchObject({ depthWrite: false, alphaToCoverage: true });
  expect(batch.materials.near.defines).toEqual({ BRUSH_COUNT: 8 });
  expect(zdiag.diag().precompiled).toBe(4);
});
