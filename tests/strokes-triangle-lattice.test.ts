/**
 * The face-clamped lattice placement (`triangleSample`, SCATTER_VERSION 17) on a window pane: the
 * 0.7 × 0.9 m quad and one of its two triangles, at the seed-1 per-triangle window counts (about
 * 21 on the far, capped panes, 31 and 52 between, and 117 on the nearest).
 *
 * The statistic is the largest hole: the farthest any point of the pane (a barycentric grid over
 * each triangle) lies from the nearest placed stroke centre, in units of the lattice spacing
 * sqrt(triangle area / count), taken per random shift and summarised over many shifts. The fold it
 * replaces (the unit square's upper half reflected onto the lower half) is reimplemented here as
 * the reference.
 *
 * Measured with these exact parameters (300 shifts, grid 30, stream seed 17):
 *
 * | shape | count | fold p95 | fold max | lattice p95 | lattice max |
 * | --- | --- | --- | --- | --- | --- |
 * | triangle | 21 | 2.370 | 3.345 | 2.138 | 2.581 |
 * | triangle | 31 | 2.400 | 3.653 | 2.132 | 2.615 |
 * | triangle | 52 | 2.450 | 3.269 | 2.222 | 3.031 |
 * | triangle | 117 | 2.582 | 3.074 | 2.222 | 2.754 |
 * | quad | 21 | 1.828 | 2.237 | 1.678 | 1.929 |
 * | quad | 31 | 1.785 | 2.148 | 1.735 | 1.925 |
 * | quad | 52 | 1.953 | 2.375 | 1.675 | 2.102 |
 * | quad | 117 | 1.916 | 2.446 | 1.721 | 1.966 |
 *
 * Strokes with a neighbour within a quarter spacing: 8.6-9.8% under the fold, 0.05-0.64% under
 * the lattice.
 *
 * A wider run (2000 shifts, grid 40) read the fold at p95 2.41-2.55 and max 3.35-3.50 on the
 * triangle and p95 1.85-1.91 and max 2.34-2.72 on the quad, and the lattice at p95 2.12-2.27 and
 * max 2.62-3.16 on the triangle and p95 1.65-1.70 and max 2.03-2.23 on the quad. The share of
 * strokes with a neighbour within a quarter spacing was 9.1-9.5% under the fold and 0.1-0.6% under
 * the lattice.
 */
import { describe, expect, test } from 'vitest';
import { FACE_PLACEMENT_JITTER, triangleSample } from '../src/render/strokes/scatter.ts';
import { mulberry32 } from '../src/util/prng.ts';

type V2 = readonly [number, number];
type Tri = readonly [V2, V2, V2];
type Sampler = (shift: V2, step: number, u1: number, u2: number) => [number, number, number];

const R2_G = 1.324717957244746;
const frac = (x: number): number => x - Math.floor(x);

/** The SCATTER_VERSION 16 placement: the k-th jittered R2 point, the upper half folded down. */
function foldSampler(): Sampler {
  let k = 0;
  return (shift, step, u1, u2) => {
    let r1 = frac(shift[0] + k / R2_G + (u1 - 0.5) * FACE_PLACEMENT_JITTER * step);
    let r2 = frac(shift[1] + k / (R2_G * R2_G) + (u2 - 0.5) * FACE_PLACEMENT_JITTER * step);
    k++;
    if (r1 + r2 > 1) {
      r1 = 1 - r1;
      r2 = 1 - r2;
    }
    return [1 - r1 - r2, r1, r2];
  };
}

function latticeSampler(): Sampler {
  let lattice: { shift: V2; step: number; next: number } | null = null;
  return (shift, step, u1, u2) => {
    if (lattice?.shift !== shift) lattice = { shift, step, next: 0 };
    return triangleSample(lattice, u1, u2);
  };
}

const at = (tri: Tri, [r0, r1, r2]: readonly number[]): V2 => [
  r0 * tri[0][0] + r1 * tri[1][0] + r2 * tri[2][0],
  r0 * tri[0][1] + r1 * tri[1][1] + r2 * tri[2][1],
];

/** One triangle's strokes, drawing the shift and then two draws per stroke, as the scatter does. */
function place(tri: Tri, count: number, rand: () => number, sampler: Sampler): V2[] {
  const shift: V2 = [rand(), rand()];
  const step = 1 / Math.sqrt(count);
  const out: V2[] = [];
  for (let k = 0; k < count; k++) out.push(at(tri, sampler(shift, step, rand(), rand())));
  return out;
}

function grid(tris: readonly Tri[], res: number): V2[] {
  const g: V2[] = [];
  for (const tri of tris) {
    for (let i = 0; i <= res; i++) {
      for (let j = 0; j <= res - i; j++) g.push(at(tri, [1 - (i + j) / res, i / res, j / res]));
    }
  }
  return g;
}

function largestHole(g: readonly V2[], points: readonly V2[]): number {
  let worst = 0;
  for (const p of g) {
    let best = Number.POSITIVE_INFINITY;
    for (const q of points) best = Math.min(best, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2);
    worst = Math.max(worst, best);
  }
  return Math.sqrt(worst);
}

/** Share of strokes whose nearest neighbour on the same triangle is within `share` spacings. */
function closeShare(sets: readonly (readonly V2[])[], spacing: number, share: number): number {
  let close = 0;
  let total = 0;
  for (const set of sets) {
    for (let i = 0; i < set.length; i++) {
      let best = Number.POSITIVE_INFINITY;
      for (let j = 0; j < set.length; j++) {
        if (j !== i)
          best = Math.min(best, Math.hypot(set[i][0] - set[j][0], set[i][1] - set[j][1]));
      }
      total++;
      if (best < share * spacing) close++;
    }
  }
  return close / total;
}

const LOWER: Tri = [
  [0, 0],
  [0.7, 0],
  [0, 0.9],
];
const UPPER: Tri = [
  [0.7, 0.9],
  [0, 0.9],
  [0.7, 0],
];
const TRIANGLE_AREA = (0.7 * 0.9) / 2;
const SHIFTS = 300;
const GRID = 30;

interface Stats {
  p95: number;
  max: number;
  close: number;
}

function measure(tris: readonly Tri[], count: number, make: () => Sampler): Stats {
  const rand = mulberry32(17);
  const g = grid(tris, GRID);
  const spacing = Math.sqrt(TRIANGLE_AREA / count);
  const holes: number[] = [];
  let close = 0;
  for (let s = 0; s < SHIFTS; s++) {
    const sets = tris.map((tri) => place(tri, count, rand, make()));
    holes.push(largestHole(g, sets.flat()) / spacing);
    close += closeShare(sets, spacing, 0.25) / SHIFTS;
  }
  holes.sort((a, b) => a - b);
  return { p95: holes[Math.floor(0.95 * SHIFTS)], max: holes[SHIFTS - 1], close };
}

const COUNTS = [21, 31, 52, 117] as const;
const SHAPES = { triangle: [LOWER], quad: [LOWER, UPPER] } as const;
/** The largest measured lattice value over the counts plus about 5%: a regression past these fails. */
const BOUND = {
  triangle: { p95: 2.35, max: 3.2 },
  quad: { p95: 1.83, max: 2.22 },
} as const;

describe('face-clamped lattice placement on a window pane', () => {
  for (const [shape, tris] of Object.entries(SHAPES) as [keyof typeof SHAPES, readonly Tri[]][]) {
    for (const count of COUNTS) {
      test(`${shape}, ${count} strokes per triangle: smaller holes than the fold, no coincidence`, () => {
        const fold = measure(tris, count, foldSampler);
        const lattice = measure(tris, count, latticeSampler);
        console.log(
          `| ${shape} | ${count} | ${fold.p95.toFixed(3)} | ${fold.max.toFixed(3)} | ${lattice.p95.toFixed(3)} | ${lattice.max.toFixed(3)} | close ${(fold.close * 100).toFixed(2)}% ${(lattice.close * 100).toFixed(2)}%`,
        );
        expect(lattice.p95).toBeLessThan(fold.p95);
        expect(lattice.max).toBeLessThan(fold.max);
        expect(lattice.p95).toBeLessThan(BOUND[shape].p95);
        expect(lattice.max).toBeLessThan(BOUND[shape].max);
        expect(fold.close).toBeGreaterThan(0.05);
        expect(lattice.close).toBeLessThan(0.01);
      });
    }
  }

  test('keeps every stroke inside the triangle and the count unchanged', () => {
    const rand = mulberry32(3);
    for (let s = 0; s < 200; s++) {
      const count = 1 + Math.floor(rand() * 150);
      const lattice = { shift: [rand(), rand()] as const, step: 1 / Math.sqrt(count), next: 0 };
      for (let k = 0; k < count; k++) {
        const [r0, r1, r2] = triangleSample(lattice, rand(), rand());
        for (const r of [r0, r1, r2]) {
          expect(r).toBeGreaterThanOrEqual(-1e-12);
          expect(r).toBeLessThanOrEqual(1 + 1e-12);
        }
        expect(r0 + r1 + r2).toBeCloseTo(1, 12);
      }
      // Half the square's points lie in the triangle, so the index runs about twice the count.
      expect(lattice.next).toBeGreaterThanOrEqual(count);
      expect(lattice.next).toBeLessThan(2 * count + 8);
    }
  });

  test('leaves the non-lattice draws on the old reflection', () => {
    expect(triangleSample(null, 0.2, 0.3)).toEqual([1 - 0.2 - 0.3, 0.2, 0.3]);
    const [r0, r1, r2] = triangleSample(null, 0.8, 0.7);
    expect([r1, r2]).toEqual([1 - 0.8, 1 - 0.7]);
    expect(r0).toBe(1 - (1 - 0.8) - (1 - 0.7));
  });
});
