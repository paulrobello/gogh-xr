import { describe, expect, test } from 'vitest';
import {
  BAND_HYSTERESIS_M,
  bandDrawCount,
  bandForDistance,
  chunkDistance,
  DEFAULT_BAND_DENSITY,
  DEFAULT_BAND_SIZE,
  MID_BAND_MAX_M,
  NEAR_BAND_MAX_M,
  nextBand,
  STROKE_BANDS,
  STROKE_BUDGET,
  type StrokeBand,
} from '../src/render/strokes/bands.ts';

describe('band constants', () => {
  test('match the plan: near 0-6 m, mid 6-25 m, far beyond, 0.5 m hysteresis', () => {
    expect(STROKE_BANDS).toEqual(['near', 'mid', 'far']);
    expect(NEAR_BAND_MAX_M).toBe(6);
    expect(MID_BAND_MAX_M).toBe(25);
    expect(BAND_HYSTERESIS_M).toBe(0.5);
  });

  test('the budget table matches the P0.8 measurements', () => {
    expect(STROKE_BUDGET.default).toEqual({ hz: 90, min: 150_000, max: 325_000 });
    expect(STROKE_BUDGET.maxBeauty).toEqual({ hz: 72, min: 150_000, max: 500_000 });
  });

  test('defaults thin and enlarge with distance', () => {
    expect(DEFAULT_BAND_DENSITY.near).toBe(1);
    expect(DEFAULT_BAND_DENSITY.mid).toBeLessThan(DEFAULT_BAND_DENSITY.near);
    expect(DEFAULT_BAND_DENSITY.far).toBeLessThan(DEFAULT_BAND_DENSITY.mid);
    expect(DEFAULT_BAND_SIZE.near).toBe(1);
    expect(DEFAULT_BAND_SIZE.mid).toBeGreaterThan(DEFAULT_BAND_SIZE.near);
    expect(DEFAULT_BAND_SIZE.far).toBeGreaterThan(DEFAULT_BAND_SIZE.mid);
  });
});

describe('bandForDistance', () => {
  test('uses the plain thresholds, each band closed below', () => {
    expect(bandForDistance(0)).toBe('near');
    expect(bandForDistance(5.99)).toBe('near');
    expect(bandForDistance(6)).toBe('mid');
    expect(bandForDistance(24.99)).toBe('mid');
    expect(bandForDistance(25)).toBe('far');
    expect(bandForDistance(1e6)).toBe('far');
  });
});

describe('nextBand', () => {
  test('a chunk with no band takes the plain threshold', () => {
    expect(nextBand(null, 6.2)).toBe('mid');
    expect(nextBand(null, 5.8)).toBe('near');
  });

  test('moves out only past boundary + 0.5 m and back only below boundary - 0.5 m', () => {
    expect(nextBand('near', 6.5)).toBe('near');
    expect(nextBand('near', 6.51)).toBe('mid');
    expect(nextBand('mid', 5.5)).toBe('mid');
    expect(nextBand('mid', 5.49)).toBe('near');
    expect(nextBand('mid', 25.5)).toBe('mid');
    expect(nextBand('mid', 25.51)).toBe('far');
    expect(nextBand('far', 24.5)).toBe('far');
    expect(nextBand('far', 24.49)).toBe('mid');
  });

  test('a teleport crosses several bands in one step', () => {
    expect(nextBand('near', 40)).toBe('far');
    expect(nextBand('far', 1)).toBe('near');
  });

  test('a path oscillating 0.4 m around each boundary never changes band', () => {
    for (const edge of [NEAR_BAND_MAX_M, MID_BAND_MAX_M]) {
      for (const start of [edge - 0.4, edge + 0.4]) {
        let band = nextBand(null, start);
        const initial = band;
        for (let step = 0; step < 200; step++) {
          band = nextBand(band, edge + 0.4 * Math.sin(step * 0.7));
          expect(band).toBe(initial);
        }
      }
    }
  });

  test('crossing a boundary by more than 0.5 m changes band exactly once per crossing', () => {
    for (const edge of [NEAR_BAND_MAX_M, MID_BAND_MAX_M]) {
      let band: StrokeBand = nextBand(null, edge - 1);
      let changes = 0;
      // Out, back, out, back: four crossings, sampled finely so each passes through the dead zone.
      const path: number[] = [];
      for (let k = 0; k < 4; k++) {
        for (let s = 0; s <= 100; s++) {
          const t = s / 100;
          path.push(k % 2 === 0 ? edge - 1 + 2 * t : edge + 1 - 2 * t);
        }
      }
      for (const distance of path) {
        const next = nextBand(band, distance);
        if (next !== band) changes++;
        band = next;
      }
      expect(changes).toBe(4);
      expect(band).toBe(bandForDistance(edge - 1));
    }
  });
});

describe('chunkDistance', () => {
  test('is the distance to the nearest point of the sphere, zero inside it', () => {
    const center = { x: 0, y: 0, z: -10 };
    expect(chunkDistance(center, 3, { x: 0, y: 0, z: 0 })).toBeCloseTo(7, 12);
    expect(chunkDistance(center, 3, { x: 0, y: 0, z: -9 })).toBe(0);
  });
});

describe('bandDrawCount', () => {
  test('is floor(d * count) with binary representation error absorbed', () => {
    expect(bandDrawCount(0.5, 7)).toBe(3);
    expect(bandDrawCount(0.29, 100)).toBe(29);
    expect(bandDrawCount(0.7, 10)).toBe(7);
    expect(bandDrawCount(1, 12345)).toBe(12345);
    expect(bandDrawCount(0, 12345)).toBe(0);
    expect(bandDrawCount(0.15, 1_000_000)).toBe(150_000);
    expect(bandDrawCount(0.333, 3)).toBe(0);
  });
});
