import { describe, expect, test } from 'vitest';
import { BRUSH_COUNT } from '../src/render/strokes/brush-atlas-data.ts';
import {
  appendStrokes,
  BYTES_PER_INSTANCE,
  createStrokeBuffers,
  octDecode,
  octEncode,
  packInstance,
  STROKE_LAYER,
  type StrokeInstance,
  unpackInstance,
} from '../src/render/strokes/instance.ts';
import { mulberry32 } from '../src/util/prng.ts';

const TAU = Math.PI * 2;

function randomUnit(rand: () => number): [number, number, number] {
  const z = rand() * 2 - 1;
  const phi = rand() * TAU;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(phi), r * Math.sin(phi), z];
}

function randomInstance(rand: () => number): StrokeInstance {
  const layers = Object.values(STROKE_LAYER);
  return {
    position: [rand() * 200 - 100, rand() * 50, rand() * 200 - 100],
    normal: randomUnit(rand),
    tangent: rand() * TAU,
    color: [
      Math.floor(rand() * 256),
      Math.floor(rand() * 256),
      Math.floor(rand() * 256),
      Math.floor(rand() * 256),
    ],
    size: [0.01 + rand() * 2, 0.005 + rand()],
    brush: Math.floor(rand() * BRUSH_COUNT),
    layer: layers[Math.floor(rand() * layers.length)],
    phase: Math.floor(rand() * 256),
  };
}

function angleBetween(a: readonly number[], b: readonly number[]): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

function wrappedDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % TAU;
  return Math.min(d, TAU - d);
}

describe('instance layout', () => {
  test('bytes per instance matches the typed arrays', () => {
    const buffers = createStrokeBuffers(10);
    const total =
      buffers.position.byteLength +
      buffers.normal.byteLength +
      buffers.tangent.byteLength +
      buffers.color.byteLength +
      buffers.size.byteLength +
      buffers.meta.byteLength;
    expect(total).toBe(10 * BYTES_PER_INSTANCE);
    expect(BYTES_PER_INSTANCE).toBe(34);
  });

  test('layer enum is the six world layers with distinct u8 values', () => {
    expect(Object.keys(STROKE_LAYER)).toEqual([
      'sky',
      'star',
      'moon',
      'cypress',
      'ground',
      'building',
    ]);
    expect(new Set(Object.values(STROKE_LAYER)).size).toBe(6);
    for (const value of Object.values(STROKE_LAYER)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(256);
    }
  });
});

describe('pack and unpack', () => {
  test('round trips random instances within quantisation', () => {
    const rand = mulberry32(1234);
    const count = 2000;
    const buffers = createStrokeBuffers(count);
    const source = Array.from({ length: count }, () => randomInstance(rand));
    source.forEach((instance, i) => {
      packInstance(buffers, i, instance);
    });
    source.forEach((instance, i) => {
      const out = unpackInstance(buffers, i);
      for (let k = 0; k < 3; k++) expect(out.position[k]).toBeCloseTo(instance.position[k], 4);
      // snorm16 oct encoding: worst case well under 0.01 degrees.
      expect(angleBetween(out.normal, instance.normal)).toBeLessThan(2e-4);
      expect(Math.hypot(...out.normal)).toBeCloseTo(1, 6);
      // unorm16 over 2π: one step is 9.6e-5 rad.
      expect(wrappedDelta(out.tangent, instance.tangent)).toBeLessThan(1e-4);
      expect(out.color).toEqual(instance.color);
      expect(out.size[0]).toBeCloseTo(instance.size[0], 5);
      expect(out.size[1]).toBeCloseTo(instance.size[1], 5);
      expect(out.brush).toBe(instance.brush);
      expect(out.layer).toBe(instance.layer);
      expect(out.phase).toBe(instance.phase);
    });
  });

  test('tangent wraps into [0, 2π)', () => {
    const buffers = createStrokeBuffers(3);
    const base = randomInstance(mulberry32(5));
    packInstance(buffers, 0, { ...base, tangent: -Math.PI / 2 });
    packInstance(buffers, 1, { ...base, tangent: TAU + 0.25 });
    packInstance(buffers, 2, { ...base, tangent: TAU });
    expect(unpackInstance(buffers, 0).tangent).toBeCloseTo((3 * Math.PI) / 2, 3);
    expect(unpackInstance(buffers, 1).tangent).toBeCloseTo(0.25, 3);
    expect(unpackInstance(buffers, 2).tangent).toBeCloseTo(0, 3);
  });

  test('rejects out-of-range brush, phase and indices', () => {
    const buffers = createStrokeBuffers(1);
    const base = randomInstance(mulberry32(9));
    expect(() => packInstance(buffers, 0, { ...base, brush: BRUSH_COUNT })).toThrow(RangeError);
    expect(() => packInstance(buffers, 0, { ...base, brush: 1.5 })).toThrow(RangeError);
    expect(() => packInstance(buffers, 0, { ...base, phase: 256 })).toThrow(RangeError);
    expect(() => packInstance(buffers, 1, base)).toThrow(RangeError);
    expect(() => unpackInstance(buffers, -1)).toThrow(RangeError);
  });
});

describe('octahedral normals', () => {
  test('axis normals survive exactly', () => {
    const axes: [number, number, number][] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const axis of axes) {
      const [u, v] = octEncode(axis[0], axis[1], axis[2]);
      const out = octDecode(u, v);
      for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(axis[k], 6);
    }
  });

  test('rejects zero-length and non-finite normals', () => {
    const bad: [number, number, number][] = [
      [0, 0, 0],
      [Number.NaN, 0, 1],
      [0, Number.POSITIVE_INFINITY, 0],
    ];
    for (const n of bad) expect(() => octEncode(n[0], n[1], n[2])).toThrow(RangeError);
    const buffers = createStrokeBuffers(1);
    const base = randomInstance(mulberry32(4));
    expect(() => packInstance(buffers, 0, { ...base, normal: [0, 0, 0] })).toThrow(RangeError);
  });

  test('non-unit normals pack as their direction', () => {
    const buffers = createStrokeBuffers(1);
    const base = randomInstance(mulberry32(6));
    packInstance(buffers, 0, { ...base, normal: [0, 3, -4] });
    const out = unpackInstance(buffers, 0).normal;
    expect(angleBetween(out, [0, 0.6, -0.8])).toBeLessThan(2e-4);
  });

  test('encoded values stay in [-1, 1]', () => {
    const rand = mulberry32(77);
    for (let i = 0; i < 500; i++) {
      const [x, y, z] = randomUnit(rand);
      const [u, v] = octEncode(x, y, z);
      expect(Math.abs(u)).toBeLessThanOrEqual(1);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });
});

test('appendStrokes copies the packed buffers, then packs the extra instances after them', () => {
  const rand = mulberry32(31);
  const first = Array.from({ length: 5 }, () => randomInstance(rand));
  const extra = Array.from({ length: 3 }, () => randomInstance(rand));
  const packed = createStrokeBuffers(first.length);
  for (let i = 0; i < first.length; i++) packInstance(packed, i, first[i]);
  const all = createStrokeBuffers(first.length + extra.length);
  for (const [i, s] of [...first, ...extra].entries()) packInstance(all, i, s);
  const merged = appendStrokes(packed, extra);
  expect(merged.count).toBe(8);
  for (const key of ['position', 'normal', 'tangent', 'color', 'size', 'meta'] as const) {
    expect(Array.from(merged[key])).toEqual(Array.from(all[key]));
  }
  expect(appendStrokes(packed, []).count).toBe(5);
});
