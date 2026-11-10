/**
 * The stroke reach field (src/render/strokes/reach-field.ts): exact capped-quad distances on
 * synthetic strokes, against an independent brute force over every stroke.
 */
import { describe, expect, test } from 'vitest';
import { HAND_HALF_SIZE_CAP, HAND_RADIUS } from '../src/motion/reactive';
import { strokeAxes, type Vec3 } from '../src/render/strokes/frame';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  type StrokeBuffers,
  type StrokeInstance,
  unpackInstance,
} from '../src/render/strokes/instance';
import { buildStrokeReach } from '../src/render/strokes/reach-field';

function stroke(
  position: Vec3,
  normal: Vec3,
  tangent: number,
  size: [number, number],
): StrokeInstance {
  return {
    position,
    normal,
    tangent,
    color: [128, 128, 128, 255],
    size,
    brush: 0,
    layer: STROKE_LAYER.ground,
    phase: 0,
  };
}

function pack(strokes: readonly StrokeInstance[]): StrokeBuffers {
  const buffers = createStrokeBuffers(strokes.length);
  strokes.forEach((s, i) => {
    packInstance(buffers, i, s);
  });
  return buffers;
}

/** The packed stroke's axes, from its stored (quantised) normal and tangent. */
function axesOf(buffers: StrokeBuffers, i: number): { n: Vec3; long: Vec3; short: Vec3 } {
  const s = unpackInstance(buffers, i);
  const { long, short } = strokeAxes(s.normal, s.tangent);
  return { n: s.normal, long, short };
}

/** Independent q: the offset's parts past the capped half-size along each axis, and off the plane. */
function bruteDistance(buffers: StrokeBuffers, p: Vec3, cap = HAND_HALF_SIZE_CAP): number {
  let best = Infinity;
  for (let i = 0; i < buffers.count; i += 1) {
    const { n, long, short } = axesOf(buffers, i);
    const c = [buffers.position[3 * i], buffers.position[3 * i + 1], buffers.position[3 * i + 2]];
    const e = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const dot = (a: readonly number[]): number => e[0] * a[0] + e[1] * a[1] + e[2] * a[2];
    const hl = Math.min(buffers.size[2 * i] / 2, cap);
    const hw = Math.min(buffers.size[2 * i + 1] / 2, cap);
    const el = Math.max(Math.abs(dot(long)) - hl, 0);
    const es = Math.max(Math.abs(dot(short)) - hw, 0);
    best = Math.min(best, Math.hypot(el, es, dot(n)));
  }
  return best < HAND_RADIUS ? best : Infinity;
}

const add = (p: Vec3, a: Vec3, k: number): Vec3 => [
  p[0] + a[0] * k,
  p[1] + a[1] * k,
  p[2] + a[2] * k,
];

describe('stroke reach field', () => {
  const centre: Vec3 = [1.2, 0.4, -3.1];
  const lone = pack([stroke(centre, [0, 1, 0], 0.7, [0.6, 0.2])]);
  const field = buildStrokeReach([lone]);
  const { n, long, short } = axesOf(lone, 0);

  test('reads the distance past the quad along each axis, off its plane, and at a corner', () => {
    expect(field.reach).toBe(HAND_RADIUS);
    expect(field.distance(...add(centre, long, 0.3 + 0.05))).toBeCloseTo(0.05, 5);
    expect(field.distance(...add(centre, long, -(0.3 + 0.08)))).toBeCloseTo(0.08, 5);
    expect(field.distance(...add(centre, short, 0.1 + 0.07))).toBeCloseTo(0.07, 5);
    expect(field.distance(...add(centre, n, 0.09))).toBeCloseTo(0.09, 5);
    expect(field.distance(...add(centre, n, -0.04))).toBeCloseTo(0.04, 5);
    expect(field.distance(...add(add(centre, long, 0.33), short, 0.14))).toBeCloseTo(0.05, 5);
    // Inside the quad's rectangle the distance is the height off its plane.
    expect(field.distance(...add(add(centre, long, 0.2), n, 0.03))).toBeCloseTo(0.03, 5);
    expect(field.distance(...centre)).toBeCloseTo(0, 6);
  });

  test('reports nothing past the reach', () => {
    expect(field.distance(...add(centre, n, HAND_RADIUS + 0.001))).toBe(Infinity);
    expect(field.distance(...add(centre, long, 0.3 + HAND_RADIUS + 0.001))).toBe(Infinity);
    expect(field.distance(100, 100, 100)).toBe(Infinity);
    expect(field.distance(...add(centre, n, HAND_RADIUS - 0.001))).toBeCloseTo(
      HAND_RADIUS - 0.001,
      5,
    );
  });

  test('caps each half-size as the reactive shader does', () => {
    const long2 = pack([stroke(centre, [0, 1, 0], 0.7, [2, 0.2])]);
    const f = buildStrokeReach([long2]);
    const a = axesOf(long2, 0).long;
    // The drawn quad reaches 1 m along its axis, the hand's push only the capped 0.4 m.
    expect(f.distance(...add(centre, a, HAND_HALF_SIZE_CAP + 0.06))).toBeCloseTo(0.06, 5);
    expect(f.distance(...add(centre, a, 0.9))).toBe(Infinity);
  });

  test('an empty field reports nothing', () => {
    const empty = buildStrokeReach([createStrokeBuffers(0)]);
    expect(empty.stats.strokes).toBe(0);
    expect(empty.distance(0, 0, 0)).toBe(Infinity);
  });

  test('matches a brute force over every stroke, across sources, tiers and cell sizes', () => {
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const make = (count: number): StrokeBuffers =>
      pack(
        Array.from({ length: count }, () => {
          const normal: Vec3 = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
          const size: [number, number] = [0.05 + rand() * 1.2, 0.03 + rand() * 0.5];
          return stroke(
            [rand() * 3 - 1.5, rand() * 2, rand() * 3 - 1.5],
            normal,
            rand() * 2 * Math.PI,
            size,
          );
        }),
      );
    const sources = [make(400), make(250), make(0), make(50)];
    const all = pack(
      sources.flatMap((b) => Array.from({ length: b.count }, (_, i) => unpackInstance(b, i))),
    );
    for (const options of [
      {},
      { cellSize: 0.25 },
      { cellSize: 1.3 },
      { tiers: [] },
      { tiers: [0.1, 0.2, 0.3] },
    ]) {
      const f = buildStrokeReach(sources, { ...options, stepUnits: 64 });
      expect(f.stats.strokes).toBe(700);
      expect(f.stats.tiers.reduce((sum, t) => sum + t.strokes, 0)).toBe(700);
      let within = 0;
      for (let k = 0; k < 1500; k += 1) {
        const p: Vec3 = [rand() * 3.6 - 1.8, rand() * 2.6 - 0.3, rand() * 3.6 - 1.8];
        const want = bruteDistance(all, p);
        const got = f.distance(...p);
        if (want === Infinity) {
          expect(got).toBe(Infinity);
        } else {
          within += 1;
          expect(Math.abs(got - want)).toBeLessThan(1e-6);
        }
      }
      // Enough points land inside the reach for the check to mean something.
      expect(within).toBeGreaterThan(150);
    }
  });
});
