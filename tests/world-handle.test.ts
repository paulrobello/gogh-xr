/**
 * The Starry Night `WorldHandle` from a real `build()` (P2 review I3): the ground and boundary P3
 * locomotion reads. Rasters are the real bake files decoded with sharp. Vitest is not a production
 * build, so the scatter cache is bypassed.
 */
import { Scene } from 'three';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { decode } from '../scripts/scatter-time.ts';
import * as starryNight from '../src/paintings/starry-night/index.ts';
import type { WorldHandle } from '../src/paintings/world-module.ts';
import { octDecode, STROKE_LAYER } from '../src/render/strokes/instance.ts';
import { BOUNDARY_ALTITUDE, BOUNDARY_RADIUS } from '../src/world/boundary.ts';
import { createTerrain } from '../src/world/terrain.ts';
import { createVillage } from '../src/world/village.ts';

let handle: WorldHandle;

beforeAll(async () => {
  handle = await starryNight.build({
    scene: new Scene(),
    seed: null,
    loadRaster: (url) => decode(url.slice(url.lastIndexOf('/') + 1)),
  });
}, 120_000);

afterAll(() => starryNight.dispose());

test('the handle ground is the seed-1 terrain: same height and normal', () => {
  const terrain = createTerrain(1);
  const points: [number, number][] = [
    [3, -7],
    [-12.5, 20],
    [25, -30],
    [-40, -5.25],
    [10.3, 10.7],
    [0, 0],
  ];
  let raised = 0;
  for (const [x, z] of points) {
    expect(handle.ground.heightAt(x, z), `${x}, ${z}`).toBe(terrain.heightAt(x, z));
    expect(handle.ground.normalAt(x, z), `${x}, ${z}`).toEqual(terrain.normalAt(x, z));
    if (Math.abs(terrain.heightAt(x, z)) > 0.1) raised++;
  }
  // A stub returning 0 would match only at the spot.
  expect(raised).toBeGreaterThanOrEqual(4);
});

test('the handle boundary factor is 0 at the spot and 1 past the edge', () => {
  expect(handle.boundaryFactor([0, 0, 0])).toBe(0);
  expect(handle.boundaryFactor([0, 1.6, 0])).toBe(0);
  expect(handle.boundaryFactor([BOUNDARY_RADIUS + 1, 0, 0])).toBe(1);
  expect(handle.boundaryFactor([0, 0, -(BOUNDARY_RADIUS + 10)])).toBe(1);
  expect(handle.boundaryFactor([0, BOUNDARY_ALTITUDE + 1, 0])).toBe(1);
});

test('the built batch carries the eave underside copies, each facing down', () => {
  // No scattered village stroke faces down (walls are vertical, roofs face up), so the
  // downward-facing building strokes in the app's chunks are exactly the eave copies that
  // `assembleWorldStrokes` adds (pinned at 10,098 in tests/world-starry-night.test.ts).
  const SNORM16 = 32767;
  let down = 0;
  for (const chunk of handle.batch.chunks) {
    const normal = chunk.geometry.getAttribute('iNormal').array as Int16Array;
    const meta = chunk.geometry.getAttribute('iMeta').array as Uint8Array;
    for (let i = 0; i < chunk.count; i++) {
      if (meta[i * 4 + 1] !== STROKE_LAYER.building) continue;
      const n = octDecode(
        Math.max(-1, normal[i * 2] / SNORM16),
        Math.max(-1, normal[i * 2 + 1] / SNORM16),
      );
      if (n[1] < -0.3) down++;
    }
  }
  expect(down).toBe(10_098);
});

test('the handle blocks the seed-1 village’s houses and church, and not the painter’s spot', () => {
  const blocked = handle.blocked;
  expect(blocked).toBeDefined();
  if (!blocked) return;
  const village = createVillage(1, createTerrain(1));
  for (const house of village.houses) expect(blocked(house.center[0], house.center[2])).toBe(true);
  expect(blocked(village.church.center[0], village.church.center[2])).toBe(true);
  expect(blocked(0, 0)).toBe(false);
  expect(blocked(0, -5)).toBe(false);
});
