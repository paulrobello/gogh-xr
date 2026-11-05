import { Quaternion, Vector3 } from 'three';
import { afterEach, expect, test } from 'vitest';
import {
  buildDiagPayload,
  type DiagRenderer,
  registerDiag,
  unregisterDiag,
} from '../src/diag/diag.ts';
import { createXrState } from '../src/xr/session.ts';

function fakeRenderer(withExt = true): DiagRenderer {
  return {
    info: {
      render: { calls: 3, triangles: 100, points: 0, lines: 2, frame: 9 },
      memory: { geometries: 4, textures: 1 },
      programs: [{}, {}],
    },
    getContext: () => ({
      getExtension: (name: string) =>
        withExt && name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37446 } : null,
      getParameter: (p: number) => (p === 37446 ? 'ANGLE Metal Renderer: Fake' : null),
    }),
    xr: { isPresenting: false, getFoveation: () => 0.5 },
  };
}

const camera = { position: new Vector3(1, 1.6, 2), quaternion: new Quaternion(0, 0, 0, 1) };

afterEach(() => {
  unregisterDiag('strokes');
  unregisterDiag('bad');
});

test('payload has build, renderer, xr and camera sections', () => {
  const xr = { ...createXrState(), supported: true, frameRate: 90, supportedFrameRates: [72, 90] };
  const payload = buildDiagPayload({
    build: '0.1.0',
    renderer: fakeRenderer(),
    camera,
    getXrState: () => xr,
  });
  expect(payload).toEqual({
    build: '0.1.0',
    renderer: {
      calls: 3,
      triangles: 100,
      points: 0,
      lines: 2,
      frame: 9,
      geometries: 4,
      textures: 1,
      programs: 2,
      unmaskedRenderer: 'ANGLE Metal Renderer: Fake',
    },
    xr: {
      supported: true,
      presenting: false,
      sessionMode: null,
      frameRate: 90,
      supportedFrameRates: [72, 90],
      foveation: 0.5,
    },
    camera: { position: [1, 1.6, 2], quaternion: [0, 0, 0, 1] },
  });
});

test('unmaskedRenderer is null without the extension; foveation null when unavailable', () => {
  const renderer = fakeRenderer(false);
  renderer.xr = { isPresenting: false };
  const payload = buildDiagPayload({
    build: 'x',
    renderer,
    camera,
    getXrState: createXrState,
  }) as { renderer: { unmaskedRenderer: unknown }; xr: { foveation: unknown } };
  expect(payload.renderer.unmaskedRenderer).toBeNull();
  expect(payload.xr.foveation).toBeNull();
});

test('registered sections are merged; throwing providers are contained', () => {
  registerDiag('strokes', () => ({ count: 7 }));
  registerDiag('bad', () => {
    throw new Error('boom');
  });
  const payload = buildDiagPayload({
    build: 'x',
    renderer: fakeRenderer(),
    camera,
    getXrState: createXrState,
  });
  expect(payload.strokes).toEqual({ count: 7 });
  expect(payload.bad).toEqual({ error: 'boom' });
});

test('built-in keys cannot be registered', () => {
  expect(() => registerDiag('xr', () => 1)).toThrow(/reserved/);
});
