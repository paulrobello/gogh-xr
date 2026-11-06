import { expect, test } from 'vitest';
import {
  defaultWorldMeshes,
  emptyMappedRegions,
  loadRealSource,
  meshStats,
} from '../scripts/scatter-time.ts';
import {
  canvasRay,
  PAINTER_EYE,
  type WorldLayer,
} from '../src/paintings/starry-night/canvas-camera.ts';
import { sampleCanvas } from '../src/paintings/starry-night/canvas-histogram.ts';
import { WORLD_LAYERS } from '../src/render/strokes/scatter.ts';
import { mulberry32 } from '../src/util/prng.ts';

// The real bake rasters (public/paintings/starry-night), decoded with sharp (P2.1 review M5).
const SOURCE = await loadRealSource();

test('every region a world layer maps to has texels in the real bake', () => {
  expect(SOURCE.regions.width).toBe(1024);
  expect(SOURCE.image.width).toBe(1024);
  expect(emptyMappedRegions(SOURCE)).toEqual([]);
});

test('sampleCanvas never throws on the real rasters, in frame or out of it', () => {
  const rand = mulberry32(12);
  for (const layer of WORLD_LAYERS as readonly WorldLayer[]) {
    for (let i = 0; i < 2000; i++) {
      // Half through the frame, half in arbitrary directions behind and around the eye.
      const dir =
        i % 2 === 0
          ? canvasRay(rand() * 1.2 - 0.1, rand() * 1.2 - 0.1)
          : [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
      const r = 1 + rand() * 120;
      const point = [
        PAINTER_EYE[0] + dir[0] * r,
        PAINTER_EYE[1] + dir[1] * r,
        PAINTER_EYE[2] + dir[2] * r,
      ] as const;
      const s = sampleCanvas(SOURCE, point, layer, rand);
      expect(s.rgb.every((c) => c >= 0 && c <= 255)).toBe(true);
      expect(s.flowAngle).toBeGreaterThanOrEqual(0);
      expect(s.flowAngle).toBeLessThan(Math.PI + 1e-9);
    }
  }
});

test('the default world scatters on the real rasters; ridge and sky face the eye', () => {
  const stats = meshStats(defaultWorldMeshes(), SOURCE, 1, 0.05);
  expect(stats.map((s) => s.name)).toEqual([
    'ground',
    'ridge',
    'building',
    'roof',
    'window',
    'church',
    'cypress',
    'sky',
  ]);
  for (const s of stats) expect(s.count).toBeGreaterThan(0);
  const byName = new Map(stats.map((s) => [s.name, s]));
  expect(byName.get('ridge')?.facing).toBeGreaterThan(0.99);
  expect(byName.get('sky')?.facing).toBeGreaterThan(0.99);
  // Ground falling away behind the hills faces away, but most of it faces the spot.
  expect(byName.get('ground')?.facing).toBeGreaterThan(0.6);
});
