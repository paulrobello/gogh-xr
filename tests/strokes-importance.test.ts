import { describe, expect, test } from 'vitest';
import { importanceOrder } from '../src/render/strokes/importance.ts';
import { mulberry32 } from '../src/util/prng.ts';

const PLANE = 4;
const GRID = 8;

/** Strokes jittered on a 4 x 4 m plane at y = 0, emitted in scanline order (x-major). */
function scanlinePlane(perAxis: number, seed = 5): Float32Array {
  const rand = mulberry32(seed);
  const position = new Float32Array(perAxis * perAxis * 3);
  const step = PLANE / perAxis;
  let i = 0;
  for (let x = 0; x < perAxis; x++) {
    for (let z = 0; z < perAxis; z++) {
      position[i++] = (x + rand()) * step;
      position[i++] = 0;
      position[i++] = (z + rand()) * step;
    }
  }
  return position;
}

function identity(n: number): Uint32Array {
  return Uint32Array.from({ length: n }, (_, i) => i);
}

/** Strokes of the first `prefix` entries of `order` in each cell of a GRID x GRID raster. */
function cellCounts(position: Float32Array, order: Uint32Array, prefix: number): number[] {
  const counts = new Array<number>(GRID * GRID).fill(0);
  for (let i = 0; i < prefix; i++) {
    const s = order[i];
    const cx = Math.min(GRID - 1, Math.floor((position[s * 3] / PLANE) * GRID));
    const cz = Math.min(GRID - 1, Math.floor((position[s * 3 + 2] / PLANE) * GRID));
    counts[cx * GRID + cz]++;
  }
  return counts;
}

describe('importanceOrder', () => {
  test('is a permutation of the given indices', () => {
    const position = scanlinePlane(40);
    const indices = identity(1600).subarray(100, 900);
    const order = importanceOrder(position, indices, 7);
    expect(order).toHaveLength(800);
    expect([...order].sort((a, b) => a - b)).toEqual([...indices]);
  });

  test('is deterministic for a seed and changes with it', () => {
    const position = scanlinePlane(40);
    const a = importanceOrder(position, identity(1600), 7);
    const b = importanceOrder(position, identity(1600), 7);
    const c = importanceOrder(position, identity(1600), 8);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test('a 10% prefix covers every cell of the plane evenly', () => {
    const position = scanlinePlane(80); // 6400 strokes, 100 per raster cell
    const n = 6400;
    const prefix = n / 10;
    const counts = cellCounts(position, importanceOrder(position, identity(n), 1), prefix);
    // 10 expected per cell. A uniform random shuffle spreads Poisson(10): standard deviation 3.2,
    // measured 2.7 to 3.5 over six seeds. The stratified order measured 1.4 to 1.9.
    const sd = Math.sqrt(counts.reduce((sum, c) => sum + (c - 10) ** 2, 0) / counts.length);
    expect(sd).toBeLessThan(2.2);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(5);
    // The scanline input order would put that whole prefix in the first column of cells.
    const raw = cellCounts(position, identity(n), prefix);
    expect(raw.filter((c) => c > 0).length).toBeLessThanOrEqual(GRID * 2);
  });

  test('a 10% suffix covers every cell of the plane evenly too', () => {
    const position = scanlinePlane(80);
    const n = 6400;
    const order = importanceOrder(position, identity(n), 1);
    const counts = cellCounts(position, order.slice().reverse(), n / 10);
    const sd = Math.sqrt(counts.reduce((sum, c) => sum + (c - 10) ** 2, 0) / counts.length);
    expect(sd).toBeLessThan(2.2);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(5);
  });

  test('every suffix keeps the relative density of each region', () => {
    const rand = mulberry32(3);
    const n = 1800;
    const position = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const dense = i < 900;
      position[i * 3] = dense ? 1 + rand() * 0.5 : rand() * PLANE;
      position[i * 3 + 2] = dense ? 1 + rand() * 0.5 : rand() * PLANE;
    }
    const order = importanceOrder(position, identity(n), 2);
    for (const d of [0.05, 0.1, 0.25, 0.5]) {
      const suffix = Math.floor(d * n);
      let dense = 0;
      for (let i = n - suffix; i < n; i++) if (order[i] < 900) dense++;
      expect(Math.abs(dense / suffix - 0.5)).toBeLessThan(0.1);
    }
  });

  test('every prefix keeps the relative density of each region', () => {
    // 900 strokes packed into one 0.5 m patch and 900 spread over the whole plane.
    const rand = mulberry32(3);
    const n = 1800;
    const position = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const dense = i < 900;
      position[i * 3] = dense ? 1 + rand() * 0.5 : rand() * PLANE;
      position[i * 3 + 2] = dense ? 1 + rand() * 0.5 : rand() * PLANE;
    }
    const order = importanceOrder(position, identity(n), 2);
    for (const d of [0.05, 0.1, 0.25, 0.5]) {
      const prefix = Math.floor(d * n);
      let dense = 0;
      for (let i = 0; i < prefix; i++) if (order[i] < 900) dense++;
      // Half of every prefix stays in the patch; round-robin over sub-cells would starve it.
      expect(Math.abs(dense / prefix - 0.5)).toBeLessThan(0.1);
    }
  });

  test('handles empty, single and coincident strokes', () => {
    expect(importanceOrder(new Float32Array(0), new Uint32Array(0), 1)).toEqual(new Uint32Array(0));
    const position = new Float32Array(30); // ten strokes at the origin
    expect([...importanceOrder(position, identity(1), 1)]).toEqual([0]);
    const order = importanceOrder(position, identity(10), 1);
    expect([...order].sort((a, b) => a - b)).toEqual([...identity(10)]);
  });
});
