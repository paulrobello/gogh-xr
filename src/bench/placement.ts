import { mulberry32 } from '../util/prng';

export { mulberry32 };

export const MIN_RADIUS = 2;
export const MAX_RADIUS = 30;

const PALETTE: readonly (readonly [number, number, number])[] = [
  [0.09, 0.17, 0.42],
  [0.16, 0.3, 0.62],
  [0.32, 0.5, 0.78],
  [0.55, 0.7, 0.86],
  [0.93, 0.82, 0.32],
  [0.98, 0.93, 0.6],
  [0.12, 0.22, 0.16],
];

export interface Placement {
  /** xyz per instance, ordered by draw order. */
  readonly positions: Float32Array;
  /** linear rgb per instance, same order. */
  readonly colors: Float32Array;
}

/** Draw order of the instances relative to a viewer at the sphere centre. */
export type Layout = 'near-first' | 'far-first' | 'random';

/** Seeded Fisher-Yates permutation of 0..count-1. */
export function shuffledSlots(count: number, seed: number): Uint32Array {
  const slots = new Uint32Array(count);
  for (let i = 0; i < count; i++) slots[i] = i;
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = slots[i] ?? 0;
    slots[i] = slots[j] ?? 0;
    slots[j] = tmp;
  }
  return slots;
}

/**
 * Places `n` strokes in a full spherical shell around the origin, uniform per solid angle, so
 * every view direction sees the same density and a reading does not depend on where the viewer
 * looks. Radii are stratified, so
 * stroke i is strictly nearer than stroke i + 1. `near-first` keeps that order, `far-first`
 * reverses it (back-to-front for blending), and `random` scatters it with a seeded shuffle.
 */
export function placeStrokes(n: number, seed: number, layout: Layout): Placement {
  const count = Math.max(0, Math.floor(n));
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const rand = mulberry32(seed);
  const shuffle = layout === 'random' ? shuffledSlots(count, seed) : null;
  for (let i = 0; i < count; i++) {
    const t = (i + rand()) / count;
    const radius = MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * t;
    const y = 2 * rand() - 1;
    const ring = Math.sqrt(1 - y * y);
    const azimuth = rand() * Math.PI * 2;
    const slot = shuffle ? (shuffle[i] ?? i) : layout === 'far-first' ? count - 1 - i : i;
    positions[slot * 3] = radius * ring * Math.cos(azimuth);
    positions[slot * 3 + 1] = radius * y;
    positions[slot * 3 + 2] = radius * ring * Math.sin(azimuth);
    const color = PALETTE[Math.floor(rand() * PALETTE.length)];
    const shade = 0.85 + 0.3 * rand();
    colors[slot * 3] = Math.min(1, color[0] * shade);
    colors[slot * 3 + 1] = Math.min(1, color[1] * shade);
    colors[slot * 3 + 2] = Math.min(1, color[2] * shade);
  }
  return { positions, colors };
}
