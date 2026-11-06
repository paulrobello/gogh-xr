import { DataTexture, PerspectiveCamera, RGBAFormat } from 'three';
import { expect, test } from 'vitest';
import { createStrokeBatch } from '../src/render/strokes/batch.ts';
import { unpackInstance } from '../src/render/strokes/instance.ts';
import {
  buildStrokesTestBuffers,
  STROKES_TEST_CELL_SIZE,
  STROKES_TEST_COUNT,
} from '../src/render/strokes/test-scene.ts';

test('the test scene is deterministic and mixes brushes and layers', () => {
  const a = buildStrokesTestBuffers();
  const b = buildStrokesTestBuffers();
  expect(a.count).toBe(STROKES_TEST_COUNT);
  expect(a).toEqual(b);
  const brushes = new Set<number>();
  const layers = new Set<number>();
  for (let i = 0; i < a.count; i++) {
    const s = unpackInstance(a, i);
    brushes.add(s.brush);
    layers.add(s.layer);
  }
  expect(brushes.size).toBe(16);
  expect(layers.size).toBeGreaterThanOrEqual(5);
});

test('from the XR start pose some chunks draw and the wall behind culls', () => {
  const batch = createStrokeBatch(buildStrokesTestBuffers(), {
    cellSize: STROKES_TEST_CELL_SIZE,
    createAtlas: () => new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat),
  });
  const camera = new PerspectiveCamera(70, 1, 0.05, 1000);
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld();
  batch.update(camera);
  const stats = batch.stats();
  expect(stats.chunks).toBeGreaterThan(8);
  expect(stats.visible).toBeGreaterThan(0);
  expect(stats.visibleChunks).toBeLessThan(stats.chunks);
  batch.dispose();
});
