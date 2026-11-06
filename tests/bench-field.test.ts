import { Scene } from 'three';
import { expect, test, vi } from 'vitest';
import { buildStrokeField, layoutFor } from '../src/bench/field.ts';
import {
  MAX_RADIUS,
  MIN_RADIUS,
  mulberry32,
  placeStrokes,
  shuffledSlots,
} from '../src/bench/placement.ts';

const base = { mode: 'a2c', order: 'sorted', sizePx: 24, seed: 1 } as const;

function radiusAt(positions: Float32Array, i: number): number {
  return Math.hypot(positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0);
}

test('one InstancedMesh per chunk with the chunked counts', () => {
  const field = buildStrokeField({ ...base, n: 100000 });
  expect(field.meshes.map((m) => m.count)).toEqual([65536, 34464]);
  expect(field.instanceCount()).toBe(100000);
  expect(field.group.children).toHaveLength(2);
  for (const mesh of field.meshes) {
    expect(mesh.geometry).toBe(field.geometry);
    expect(mesh.material).toBe(field.material);
    expect(mesh.frustumCulled).toBe(false);
  }
  field.dispose();
});

test('instance translations come from the seeded placement', () => {
  const field = buildStrokeField({ ...base, n: 10, chunkSize: 4 });
  const { positions } = placeStrokes(10, 1, 'near-first');
  const second = field.meshes[1];
  const matrices = second?.instanceMatrix.array ?? [];
  expect(matrices[12]).toBeCloseTo(positions[4 * 3] ?? Number.NaN);
  expect(matrices[14]).toBeCloseTo(positions[4 * 3 + 2] ?? Number.NaN);
  expect(matrices[0]).toBe(1);
  expect(second?.instanceColor?.count).toBe(4);
  field.dispose();
});

test('placement is deterministic per seed and stays inside the hemisphere shell', () => {
  const a = placeStrokes(500, 7, 'random');
  expect(placeStrokes(500, 7, 'random').positions).toEqual(a.positions);
  expect(placeStrokes(500, 8, 'random').positions).not.toEqual(a.positions);
  for (let i = 0; i < 500; i++) {
    const r = radiusAt(a.positions, i);
    expect(r).toBeGreaterThanOrEqual(MIN_RADIUS - 1e-4);
    expect(r).toBeLessThanOrEqual(MAX_RADIUS + 1e-4);
    expect(a.positions[i * 3 + 1]).toBeGreaterThan(0);
  }
});

test('layouts: sorted a2c is near-first, sorted blend is far-first, random is random', () => {
  expect(layoutFor('a2c', 'sorted')).toBe('near-first');
  expect(layoutFor('blend', 'sorted')).toBe('far-first');
  expect(layoutFor('a2c', 'random')).toBe('random');
  expect(layoutFor('blend', 'random')).toBe('random');
});

test('random layout is a seeded permutation of the sorted strokes', () => {
  const slots = shuffledSlots(1000, 9);
  expect([...slots].sort((a, b) => a - b)).toEqual([...Array(1000).keys()]);
  expect(shuffledSlots(1000, 9)).toEqual(slots);
  expect(shuffledSlots(1000, 10)).not.toEqual(slots);
  const sorted = placeStrokes(1000, 9, 'near-first').positions;
  const random = placeStrokes(1000, 9, 'random').positions;
  const radii = (p: Float32Array) => [...Array(1000).keys()].map((i) => radiusAt(p, i));
  expect(radii(random).sort((a, b) => a - b)).toEqual(radii(sorted));
  // Not monotonic: count near-to-far steps; a sorted order would have 999.
  let ascending = 0;
  for (let i = 1; i < 1000; i++) if (radiusAt(random, i) > radiusAt(random, i - 1)) ascending++;
  expect(ascending).toBeGreaterThan(350);
  expect(ascending).toBeLessThan(650);
});

test('sorted layouts order near-to-far and far-to-near', () => {
  const near = placeStrokes(300, 3, 'near-first').positions;
  const far = placeStrokes(300, 3, 'far-first').positions;
  for (let i = 1; i < 300; i++) {
    expect(radiusAt(near, i)).toBeGreaterThan(radiusAt(near, i - 1));
    expect(radiusAt(far, i)).toBeLessThan(radiusAt(far, i - 1));
  }
});

test('modes set the material state', () => {
  const a2c = buildStrokeField({ ...base, n: 1 });
  expect(a2c.material.alphaToCoverage).toBe(true);
  expect(a2c.material.transparent).toBe(false);
  expect(a2c.material.depthWrite).toBe(true);
  const blend = buildStrokeField({ ...base, mode: 'blend', n: 1 });
  expect(blend.material.alphaToCoverage).toBe(false);
  expect(blend.material.transparent).toBe(true);
  expect(blend.material.depthWrite).toBe(false);
  a2c.dispose();
  blend.dispose();
});

test('chunks draw in index order', () => {
  const field = buildStrokeField({ ...base, mode: 'blend', n: 9, chunkSize: 4 });
  expect(field.meshes.map((m) => m.renderOrder)).toEqual([0, 1, 2]);
  field.dispose();
});

test('dispose releases every mesh, the geometry and the material, and detaches the group', () => {
  const scene = new Scene();
  const field = buildStrokeField({ ...base, n: 140000 });
  scene.add(field.group);
  const meshes = [...field.meshes];
  const meshSpies = meshes.map((mesh) => vi.spyOn(mesh, 'dispose'));
  const geometrySpy = vi.spyOn(field.geometry, 'dispose');
  const materialSpy = vi.spyOn(field.material, 'dispose');

  field.dispose();

  expect(meshSpies).toHaveLength(3);
  for (const spy of meshSpies) expect(spy).toHaveBeenCalledTimes(1);
  expect(geometrySpy).toHaveBeenCalledTimes(1);
  expect(materialSpy).toHaveBeenCalledTimes(1);
  expect(field.group.parent).toBeNull();
  expect(field.group.children).toHaveLength(0);
  expect(field.instanceCount()).toBe(0);
  expect(scene.children).toHaveLength(0);
});

test('zero strokes builds an empty field', () => {
  const field = buildStrokeField({ ...base, n: 0 });
  expect(field.meshes).toHaveLength(0);
  expect(field.instanceCount()).toBe(0);
  field.dispose();
});

test('mulberry32 is deterministic and in [0, 1)', () => {
  const a = mulberry32(5);
  const b = mulberry32(5);
  for (let i = 0; i < 100; i++) {
    const v = a();
    expect(v).toBe(b());
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});
