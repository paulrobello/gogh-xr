/**
 * The world boundary: `boundaryFactor` for locomotion to push the player back, and the shell of
 * painted haze strokes that softly closes off the world. Pure and deterministic per seed.
 *
 * World: metres, +Y up, the painter's spot at the origin. Radius and altitude are measured from
 * the spot.
 */
import { canvasTangent, decodedNormal, strokeShade } from '../demo/canvas/placement';
import { PAINTER_SPOT } from '../paintings/starry-night/canvas-camera';
import { type CanvasSource, sampleCanvas } from '../paintings/starry-night/canvas-histogram';
import { BRUSHES } from '../render/strokes/brush-atlas-data';
import type { Vec3 } from '../render/strokes/frame';
import { STROKE_LAYER, type StrokeInstance } from '../render/strokes/instance';
import { mulberry32 } from '../util/prng';
import { drain, type Steps } from '../util/slicer';

/** Radial distance from the spot at which `boundaryFactor` reaches 1, metres. */
export const BOUNDARY_RADIUS: number = 50;
/** Altitude above the spot at which `boundaryFactor` reaches 1, metres. */
export const BOUNDARY_ALTITUDE: number = 40;
/** Width of the ramp below each limit, metres. */
export const BOUNDARY_RAMP: number = 5;
/** The haze shell spans this radial band, metres. */
export const HAZE_RADIUS: Readonly<{ min: number; max: number }> = Object.freeze({
  min: 45,
  max: 55,
});
/** No haze above this altitude, metres: the altitude cap plus one ramp. */
export const HAZE_MAX_ALTITUDE: number = BOUNDARY_ALTITUDE + BOUNDARY_RAMP;
/** Default haze stroke count. P2.7 sets the per-band budget. */
export const HAZE_STROKE_DEFAULT: number = 30_000;
export const DEFAULT_HAZE_SEED: number = 1;
/** Haze stroke length and width, metres. */
export const HAZE_STROKE_SIZE: readonly [number, number] = Object.freeze([3, 1.2]) as readonly [
  number,
  number,
];

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * 0 inside, 1 at and beyond the edge, smooth in between. The radial term ramps over 45 → 50 m
 * from the spot and the altitude term over 35 → 40 m above it; the factor is their maximum, so it
 * never decreases along a ray from the spot.
 */
export function boundaryFactor(position: Vec3): number {
  const dx = position[0] - PAINTER_SPOT[0];
  const dy = position[1] - PAINTER_SPOT[1];
  const dz = position[2] - PAINTER_SPOT[2];
  const radial = smoothstep(
    BOUNDARY_RADIUS - BOUNDARY_RAMP,
    BOUNDARY_RADIUS,
    Math.hypot(dx, dy, dz),
  );
  const altitude = smoothstep(BOUNDARY_ALTITUDE - BOUNDARY_RAMP, BOUNDARY_ALTITUDE, dy);
  return Math.max(radial, altitude);
}

export interface BoundaryHazeOptions {
  /** Defaults to DEFAULT_HAZE_SEED. */
  readonly seed?: number;
  /** Strokes to emit; defaults to HAZE_STROKE_DEFAULT. */
  readonly count?: number;
  /**
   * Ground height at (x, z). When given, a sample below `groundHeight(x, z) + HAZE_GROUND_MARGIN`
   * is rejected, so no haze hides under the terrain.
   */
  readonly groundHeight?: (x: number, z: number) => number;
}

/** Clearance above the ground below which haze samples are rejected, metres. */
export const HAZE_GROUND_MARGIN: number = 2;
/** Candidate draws allowed per requested stroke before the loop gives up. */
export const HAZE_MAX_DRAWS_PER_STROKE: number = 500;

const HAZE_BRUSHES: readonly number[] = BRUSHES.flatMap((b, i) =>
  b.kind === 'ridge' || b.kind === 'comma' ? [i] : [],
);

/**
 * `count` haze strokes in the shell between 45 and 55 m from the spot, clipped to 45 m altitude.
 * A candidate radius is accepted with probability rising linearly from 0 at 45 m to 1 at 55 m,
 * with the direction uniform on the sphere, so density rises with distance. Normals point at the
 * spot, colour and flow come from the sky region of the canvas via `sampleCanvas(..., 'haze')`,
 * with `strokeShade` divided out of the colour.
 */
export function createBoundaryHaze(
  source: CanvasSource,
  options: BoundaryHazeOptions = {},
): StrokeInstance[] {
  return drain(createBoundaryHazeSteps(source, options));
}

/** Candidates drawn between two yields of `createBoundaryHazeSteps`. */
const HAZE_SLICE = 2048;

/** `createBoundaryHaze` as steps (P5.5): the same draws, yielding every `HAZE_SLICE` candidates. */
export function* createBoundaryHazeSteps(
  source: CanvasSource,
  options: BoundaryHazeOptions = {},
): Steps<StrokeInstance[]> {
  const count = options.count ?? HAZE_STROKE_DEFAULT;
  const rand = mulberry32(options.seed ?? DEFAULT_HAZE_SEED);
  const span = HAZE_RADIUS.max - HAZE_RADIUS.min;
  const out: StrokeInstance[] = [];
  const maxDraws = count * HAZE_MAX_DRAWS_PER_STROKE + 1000;
  // Guard: if the rejection tests starve the loop (for example a ground above the whole shell),
  // it stops after maxDraws candidates and returns fewer than `count` strokes.
  for (let draws = 0; out.length < count && draws < maxDraws; draws++) {
    if (draws > 0 && draws % HAZE_SLICE === 0) yield;
    const r = HAZE_RADIUS.min + span * rand();
    const accept = rand();
    const dy = 2 * rand() - 1;
    const theta = 2 * Math.PI * rand();
    if (accept >= (r - HAZE_RADIUS.min) / span) continue;
    const s = Math.sqrt(1 - dy * dy);
    const dir: Vec3 = [s * Math.cos(theta), dy, s * Math.sin(theta)];
    const position: Vec3 = [
      PAINTER_SPOT[0] + dir[0] * r,
      PAINTER_SPOT[1] + dir[1] * r,
      PAINTER_SPOT[2] + dir[2] * r,
    ];
    if (position[1] - PAINTER_SPOT[1] > HAZE_MAX_ALTITUDE) continue;
    if (
      options.groundHeight &&
      position[1] < options.groundHeight(position[0], position[2]) + HAZE_GROUND_MARGIN
    )
      continue;

    const normal: Vec3 = [-dir[0], -dir[1], -dir[2]];
    const decoded = decodedNormal(normal);
    // Painting axes in the stroke plane: world X (Z when X is nearly the normal) as "right".
    const ref: Vec3 = Math.abs(decoded[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    const along = ref[0] * decoded[0] + ref[1] * decoded[1] + ref[2] * decoded[2];
    const rx: Vec3 = [
      ref[0] - along * decoded[0],
      ref[1] - along * decoded[1],
      ref[2] - along * decoded[2],
    ];
    const rl = Math.hypot(rx[0], rx[1], rx[2]);
    const right: Vec3 = [rx[0] / rl, rx[1] / rl, rx[2] / rl];
    const up: Vec3 = [
      decoded[1] * right[2] - decoded[2] * right[1],
      decoded[2] * right[0] - decoded[0] * right[2],
      decoded[0] * right[1] - decoded[1] * right[0],
    ];

    const sample = sampleCanvas(source, position, 'haze', rand);
    const shade = strokeShade(decoded);
    out.push({
      position,
      normal,
      tangent: canvasTangent(decoded, right, up, sample.flowAngle),
      color: [sample.rgb[0] / shade, sample.rgb[1] / shade, sample.rgb[2] / shade, 255],
      size: HAZE_STROKE_SIZE,
      brush: HAZE_BRUSHES[Math.floor(rand() * HAZE_BRUSHES.length)],
      layer: STROKE_LAYER.sky,
      phase: Math.floor(rand() * 256),
    });
  }
  return out;
}
