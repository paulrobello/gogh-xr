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
import { BOUNDARY_ALTITUDE, BOUNDARY_RADIUS } from '../src/world/boundary.ts';
import { createTerrain } from '../src/world/terrain.ts';

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
