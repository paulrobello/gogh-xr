import { describe, expect, it } from 'vitest';
import {
  decodeFlowAngle,
  encodeFlow,
  kmeansPalette,
  mulberry32,
  orientationField,
  type RegionsDoc,
  rasterizeRegions,
} from '../scripts/bake/scan-analysis.ts';

const DEG = 180 / Math.PI;

/** Smallest difference between two orientations, in degrees, modulo 180. */
function orientationError(a: number, b: number): number {
  const d = Math.abs((((a - b) * DEG) % 180) + 180) % 180;
  return Math.min(d, 180 - d);
}

/** Builds a w*h luminance image top-down from f(x, yUp), where yUp = h - 1 - row (y up). */
function image(w: number, h: number, f: (x: number, yUp: number) => number): Float32Array {
  const lum = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let x = 0; x < w; x++) lum[row * w + x] = f(x, h - 1 - row);
  }
  return lum;
}

describe('orientationField', () => {
  it('gives 0 degrees for horizontal stripes', () => {
    const w = 64;
    const lum = image(w, w, (_x, y) => 0.5 + 0.5 * Math.sin((2 * Math.PI * y) / 10));
    const { angle, coherence } = orientationField(lum, w, w);
    for (let row = 12; row < w - 12; row += 3) {
      for (let x = 12; x < w - 12; x += 3) {
        expect(orientationError(angle[row * w + x] as number, 0)).toBeLessThan(1);
        expect(coherence[row * w + x]).toBeGreaterThan(0.9);
      }
    }
  });

  it('gives 45 degrees for stripes running up-right (pins the y-up convention)', () => {
    const w = 64;
    const lum = image(w, w, (x, y) => 0.5 + 0.5 * Math.sin((2 * Math.PI * (x - y)) / 12));
    const { angle } = orientationField(lum, w, w);
    for (let row = 12; row < w - 12; row += 3) {
      for (let x = 12; x < w - 12; x += 3) {
        expect(orientationError(angle[row * w + x] as number, Math.PI / 4)).toBeLessThan(1);
      }
    }
  });

  it('gives tangential angles within 3 degrees for concentric rings', () => {
    const w = 128;
    const c = (w - 1) / 2;
    const lum = image(
      w,
      w,
      (x, y) => 0.5 + 0.5 * Math.cos((2 * Math.PI * Math.hypot(x - c, y - c)) / 10),
    );
    const { angle } = orientationField(lum, w, w);
    let sampled = 0;
    for (let row = 0; row < w; row += 2) {
      for (let x = 0; x < w; x += 2) {
        const y = w - 1 - row;
        const r = Math.hypot(x - c, y - c);
        if (r < 20 || r > c - 12) continue;
        const tangent = Math.atan2(y - c, x - c) + Math.PI / 2;
        expect(orientationError(angle[row * w + x] as number, tangent)).toBeLessThan(3);
        sampled++;
      }
    }
    expect(sampled).toBeGreaterThan(500);
  });

  it('has mean coherence below 0.2 on seeded white noise', () => {
    const w = 128;
    const rand = mulberry32(7);
    const lum = new Float32Array(w * w).map(() => rand());
    const { coherence } = orientationField(lum, w, w);
    let sum = 0;
    for (const v of coherence) sum += v;
    expect(sum / coherence.length).toBeLessThan(0.2);
  });

  it('corrects for a non-square resample with the aspect option', () => {
    // A 45-degree stroke in a 2:1 painting, squashed into a square field, lands at atan(2).
    const w = 64;
    const lum = image(w, w, (x, y) => 0.5 + 0.5 * Math.sin((2 * Math.PI * (2 * x - y)) / 16));
    const { angle } = orientationField(lum, w, w, { aspect: 2 });
    const i = 32 * w + 32;
    expect(orientationError(angle[i] as number, Math.PI / 4)).toBeLessThan(1);
  });
});

describe('flow encoding', () => {
  it('round-trips the doubled angle through RGB8', () => {
    for (const deg of [0, 30, 45, 90, 135, 170]) {
      const theta = deg / DEG;
      const rgb = encodeFlow(new Float32Array([theta]), new Float32Array([0.75]));
      expect(rgb).toHaveLength(3);
      expect(rgb[2]).toBe(Math.round(0.75 * 255));
      const decoded = decodeFlowAngle((rgb[0] as number) / 255, (rgb[1] as number) / 255);
      expect(orientationError(decoded, theta)).toBeLessThan(0.5);
    }
  });
});

describe('kmeansPalette', () => {
  const twoBlobs = (): Uint8Array => {
    const px = new Uint8Array(200 * 3);
    for (let i = 0; i < 200; i++) px.set(i < 150 ? [20, 30, 120] : [240, 220, 40], i * 3);
    return px;
  };

  it('recovers distinct colours with weights, sorted dark to light', () => {
    const swatches = kmeansPalette(twoBlobs(), 2, 1);
    expect(swatches.map((s) => s.hex)).toEqual(['#141e78', '#f0dc28']);
    expect(swatches.map((s) => s.weight)).toEqual([0.75, 0.25]);
  });

  it('is deterministic for a fixed seed', () => {
    const rand = mulberry32(3);
    const px = new Uint8Array(3000).map(() => Math.floor(rand() * 256));
    expect(kmeansPalette(px, 6, 42)).toEqual(kmeansPalette(px, 6, 42));
  });
});

describe('rasterizeRegions', () => {
  const doc: RegionsDoc = {
    aspect: 2,
    regions: [
      { name: 'sky', id: 0, shapes: [] },
      {
        name: 'hills',
        id: 5,
        shapes: [
          {
            type: 'polygon',
            points: [
              [0, 0.5],
              [1, 0.5],
              [1, 1],
              [0, 1],
            ],
          },
        ],
      },
      { name: 'stars', id: 1, shapes: [{ type: 'circle', center: [0.5, 0.5], radius: 0.1 }] },
    ],
  };

  it('fills sky by default and paints later entries over earlier ones', () => {
    const ids = rasterizeRegions(doc, 20, 20);
    expect(ids[2 * 20 + 2]).toBe(0);
    expect(ids[17 * 20 + 2]).toBe(5);
    expect(ids[10 * 20 + 10]).toBe(1);
  });

  it('measures circle radii in painting-width units, so circles stay round', () => {
    const ids = rasterizeRegions(doc, 40, 40);
    // Radius 0.1 of width spans 0.1 in u and 0.2 in v on a 2:1 painting.
    expect(ids[20 * 40 + 23]).toBe(1);
    expect(ids[20 * 40 + 16]).toBe(1);
    expect(ids[20 * 40 + 26]).toBe(5);
    expect(ids[27 * 40 + 20]).toBe(1);
    expect(ids[13 * 40 + 20]).toBe(1);
  });
});
