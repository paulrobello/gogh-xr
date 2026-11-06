/**
 * `?strokesTest`: a small deterministic scene that exercises the stroke engine end to end. A
 * swirling sky wall at z = -2 faces +z, a ground patch lies on the floor, a moon patch curves
 * around a sphere, and a building wall at z = +6 faces -z behind the default viewers, so that its
 * chunks cull until the viewer turns round.
 */
import type { Scene } from 'three';
import { registerDiag, unregisterDiag } from '../../diag/diag';
import { mulberry32 } from '../../util/prng';
import { createStrokeBatch, type StrokeBatch } from './batch';
import { BRUSH_COUNT, BRUSHES } from './brush-atlas-data';
import type { Vec3 } from './frame';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  type StrokeBuffers,
  type StrokeLayer,
} from './instance';

export const STROKES_TEST_SEED = 1889;
/** Grid cell edge for the test scene: small enough to split every surface into several chunks. */
export const STROKES_TEST_CELL_SIZE = 2;

const SKY = 3000;
const GROUND = 1500;
const MOON = 1000;
const BUILDING = 500;
export const STROKES_TEST_COUNT = SKY + GROUND + MOON + BUILDING;

type Rgb = readonly [number, number, number];

const SKY_COLORS: readonly Rgb[] = [
  [24, 42, 110],
  [44, 82, 160],
  [110, 150, 200],
  [190, 210, 220],
];
const STAR_COLORS: readonly Rgb[] = [
  [235, 200, 70],
  [245, 235, 170],
];
const GROUND_COLORS: readonly Rgb[] = [
  [40, 60, 40],
  [70, 90, 50],
  [110, 100, 60],
];
const MOON_COLORS: readonly Rgb[] = [
  [240, 200, 60],
  [250, 225, 120],
];
const BUILDING_COLORS: readonly Rgb[] = [
  [120, 90, 60],
  [150, 120, 70],
];

/** Builds the test strokes. Same seed, same buffers. */
export function buildStrokesTestBuffers(seed: number = STROKES_TEST_SEED): StrokeBuffers {
  const rand = mulberry32(seed);
  const buffers = createStrokeBuffers(STROKES_TEST_COUNT);
  let index = 0;

  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  const jitter = (rgb: Rgb): [number, number, number, number] => [
    rgb[0] + (rand() - 0.5) * 24,
    rgb[1] + (rand() - 0.5) * 24,
    rgb[2] + (rand() - 0.5) * 24,
    255,
  ];
  const add = (
    position: Vec3,
    normal: Vec3,
    tangent: number,
    rgb: Rgb,
    layer: StrokeLayer,
    length: number,
  ): void => {
    const brush = Math.floor(rand() * BRUSH_COUNT);
    packInstance(buffers, index++, {
      position,
      normal,
      tangent,
      color: jitter(rgb),
      size: [length, length * BRUSHES[brush].aspect],
      brush,
      layer,
      phase: Math.floor(rand() * 256),
    });
  };

  // Sky wall: strokes follow circles around a swirl centre; a star glows inside it.
  const swirl = [0.8, 1.9] as const;
  for (let i = 0; i < SKY; i++) {
    const x = -2.5 + rand() * 5;
    const y = 0.2 + rand() * 2.8;
    const dx = x - swirl[0];
    const dy = y - swirl[1];
    const r = Math.hypot(dx, dy);
    const star = r < 0.35;
    // For n = +z the tangent is the angle in the xy plane (ruling R6).
    add(
      [x, y, -2 + rand() * 0.01],
      [0, 0, 1],
      Math.atan2(dy, dx) + Math.PI / 2,
      star ? pick(STAR_COLORS) : SKY_COLORS[Math.min(3, Math.floor(r * 1.4 + rand() * 1.2))],
      star ? STROKE_LAYER.star : STROKE_LAYER.sky,
      0.08 + rand() * 0.12,
    );
  }

  // Ground patch, raised off the bare-scene floor plane; strokes run roughly along x.
  for (let i = 0; i < GROUND; i++) {
    add(
      [-2 + rand() * 4, 0.01 + rand() * 0.005, -1.8 + rand() * 3.8],
      [0, 1, 0],
      (rand() - 0.5) * 0.6,
      pick(GROUND_COLORS),
      STROKE_LAYER.ground,
      0.1 + rand() * 0.1,
    );
  }

  // Moon patch: the sphere's half facing +z, with strokes along its latitude lines.
  const moon = [1.6, 1.3, -1.0] as const;
  const radius = 0.45;
  for (let i = 0; i < MOON; i++) {
    const z = rand();
    const phi = rand() * Math.PI * 2;
    const ring = Math.sqrt(1 - z * z);
    const n: Vec3 = [ring * Math.cos(phi), ring * Math.sin(phi), z];
    add(
      [moon[0] + n[0] * radius, moon[1] + n[1] * radius, moon[2] + n[2] * radius],
      n,
      phi,
      pick(MOON_COLORS),
      STROKE_LAYER.moon,
      0.05 + rand() * 0.05,
    );
  }

  // Building wall behind the default viewers, facing them from z = +6.
  for (let i = 0; i < BUILDING; i++) {
    add(
      [-2 + rand() * 4, 0.2 + rand() * 2.4, 6],
      [0, 0, -1],
      Math.PI / 2 + (rand() - 0.5) * 0.3,
      pick(BUILDING_COLORS),
      STROKE_LAYER.building,
      0.12 + rand() * 0.1,
    );
  }

  return buffers;
}

export interface StrokesTestDeps {
  scene: Scene;
}

export interface StrokesTestHandle {
  readonly batch: StrokeBatch;
  dispose(): void;
}

/** Adds the test batch to `scene`, culls it every render and registers the `strokes` diag key. */
export function startStrokesTest(deps: StrokesTestDeps): StrokesTestHandle {
  const batch = createStrokeBatch(buildStrokesTestBuffers(), {
    cellSize: STROKES_TEST_CELL_SIZE,
  });
  batch.attach(deps.scene);
  registerDiag('strokes', () => batch.stats());
  return {
    batch,
    dispose() {
      unregisterDiag('strokes');
      batch.dispose();
    },
  };
}
