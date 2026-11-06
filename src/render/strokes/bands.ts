/**
 * Distance-band LOD (P1.4). Every chunk sits in one band, chosen from the camera's distance to the
 * chunk with 0.5 m hysteresis. Each band has a density, the drawn share of each chunk's
 * importance-ordered instances, and a stroke-size multiplier. The governor (P1.6) pulls these.
 */

export const STROKE_BANDS = ['near', 'mid', 'far'] as const;
export type StrokeBand = (typeof STROKE_BANDS)[number];

/** Upper edge of the near band, metres (plan: Near 0-6 m). */
export const NEAR_BAND_MAX_M = 6;
/** Upper edge of the mid band, metres (plan: Mid 6-25 m, Far 25 m to the boundary). */
export const MID_BAND_MAX_M = 25;
/** A chunk changes band only once its distance passes an edge by more than this. */
export const BAND_HYSTERESIS_M = 0.5;

const EDGES = [NEAR_BAND_MAX_M, MID_BAND_MAX_M] as const;
const BAND_INDEX: Readonly<Record<StrokeBand, number>> = { near: 0, mid: 1, far: 2 };

/**
 * Densities the governor starts from. The budget counts instances drawn per frame after culling
 * (ruling R9), so these are tuned on forward Quest-like views in the 1.2M-stroke reference world
 * of `tests/strokes-budget.test.ts`: every heading from the centre and from 10 m out draws inside
 * the default-mode range. Views toward the boundary may fall outside it either way; the governor
 * sheds the dense ones, and a sparse one simply draws less.
 */
export const DEFAULT_BAND_DENSITY: Readonly<Record<StrokeBand, number>> = Object.freeze({
  near: 1,
  mid: 0.9,
  far: 0.4,
});

/**
 * Stroke-size multipliers that go with the default densities: about 1/sqrt(d), so the painted
 * area per chunk, count times quad area, stays roughly constant as density falls.
 */
export const DEFAULT_BAND_SIZE: Readonly<Record<StrokeBand, number>> = Object.freeze({
  near: 1,
  mid: 1.05,
  far: 1.6,
});

export interface StrokeBudget {
  /** XR target frame rate. */
  readonly hz: number;
  /**
   * The governor's shed limit: it never lowers density below the level that would draw this many
   * (ruling R10). Not a per-view guarantee, since a sparse view cannot draw strokes it lacks.
   */
  readonly min: number;
  /** Most drawn instances the mode holds its frame rate at. */
  readonly max: number;
}

/**
 * Drawn-instance budgets per mode, from the P0.8 headset measurements (plans/phase-1). They count
 * instances submitted per frame after culling for the actual view (ruling R9).
 */
export const STROKE_BUDGET: Readonly<Record<'default' | 'maxBeauty', StrokeBudget>> = Object.freeze(
  {
    default: Object.freeze({ hz: 90, min: 150_000, max: 325_000 }),
    maxBeauty: Object.freeze({ hz: 72, min: 150_000, max: 500_000 }),
  },
);

/** The band for `distance` with no hysteresis: [0, 6) near, [6, 25) mid, 25 and beyond far. */
export function bandForDistance(distance: number): StrokeBand {
  if (distance < NEAR_BAND_MAX_M) return 'near';
  if (distance < MID_BAND_MAX_M) return 'mid';
  return 'far';
}

/**
 * The band after moving to `distance` from `current`. A chunk moves out past an edge only once
 * the distance exceeds edge + 0.5 m and back only once it is below edge - 0.5 m, so a viewer
 * swaying across an edge does not flip it. Loops both ways, so a teleport can cross two bands. A
 * chunk with no band yet (`null`) takes the plain thresholds.
 */
export function nextBand(current: StrokeBand | null, distance: number): StrokeBand {
  if (current === null) return bandForDistance(distance);
  let i = BAND_INDEX[current];
  while (i < EDGES.length && distance > EDGES[i] + BAND_HYSTERESIS_M) i++;
  while (i > 0 && distance < EDGES[i - 1] - BAND_HYSTERESIS_M) i--;
  return STROKE_BANDS[i];
}

interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Distance from `eye` to the nearest point of a chunk's bounding sphere, 0 inside it. The nearest
 * point rather than the centre: a 4 m chunk has a radius of about 3.5 m, so a centre metric would
 * thin strokes 3 m from the viewer. A chunk draws at the quality its nearest strokes need.
 */
export function chunkDistance(center: Point, radius: number, eye: Point): number {
  const d = Math.hypot(center.x - eye.x, center.y - eye.y, center.z - eye.z);
  return Math.max(0, d - radius);
}

/** Absorbs binary error in `d * count`, e.g. 0.29 * 100 = 28.999999999999996. */
const DRAW_COUNT_EPSILON = 1e-6;

/**
 * Instances a chunk of `count` draws at density `d` in [0, 1]: `floor(d * count + 1e-6)`. The
 * epsilon only absorbs binary representation error, so 0.29 of 100 draws 29.
 */
export function bandDrawCount(d: number, count: number): number {
  return Math.min(count, Math.floor(d * count + DRAW_COUNT_EPSILON));
}
