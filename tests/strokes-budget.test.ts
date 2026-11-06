import { DataTexture, PerspectiveCamera, RGBAFormat } from 'three';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  DEFAULT_BAND_DENSITY,
  STROKE_BANDS,
  STROKE_BUDGET,
  type StrokeBand,
} from '../src/render/strokes/bands.ts';
import { createStrokeBatch, type StrokeBatch } from '../src/render/strokes/batch.ts';
import { createStrokeBuffers, type StrokeBuffers } from '../src/render/strokes/instance.ts';
import { mulberry32 } from '../src/util/prng.ts';

/**
 * Reference world for the budget check, laid out from area before any density was chosen: a
 * ground disc of radius 45 m and a sky hemisphere of radius 50 m, each with a uniform areal
 * density, 1.2M strokes in all (the plan's 1-1.5M authored total). Only positions and sizes are
 * filled; bands and bounds read nothing else.
 */
const GROUND = 700_000;
const SKY = 500_000;
const GROUND_RADIUS = 45;
const SKY_RADIUS = 50;

function referenceWorld(): StrokeBuffers {
  const rand = mulberry32(1889);
  const buffers = createStrokeBuffers(GROUND + SKY);
  const { position, size } = buffers;
  for (let i = 0; i < GROUND; i++) {
    const r = GROUND_RADIUS * Math.sqrt(rand());
    const theta = rand() * Math.PI * 2;
    position[i * 3] = r * Math.cos(theta);
    position[i * 3 + 1] = 0.01;
    position[i * 3 + 2] = r * Math.sin(theta);
    size[i * 2] = 0.15;
    size[i * 2 + 1] = 0.06;
  }
  for (let i = GROUND; i < GROUND + SKY; i++) {
    // Uniform on the hemisphere: height is uniform on a sphere zone (Archimedes).
    const y = rand();
    const ring = Math.sqrt(1 - y * y);
    const phi = rand() * Math.PI * 2;
    position[i * 3] = SKY_RADIUS * ring * Math.cos(phi);
    position[i * 3 + 1] = SKY_RADIUS * y;
    position[i * 3 + 2] = SKY_RADIUS * ring * Math.sin(phi);
    size[i * 2] = 0.4;
    size[i * 2 + 1] = 0.15;
  }
  return buffers;
}

/** Instances drawn over a full turn: every chunk's draw count, culling ignored. */
function drawnAllAround(batch: StrokeBatch): number {
  return batch.chunks.reduce((sum, chunk) => sum + chunk.drawCount, 0);
}

/**
 * Quest 3 combined field of view, both eyes: about 110 degrees horizontal by 96 vertical, so a
 * 96 degree vertical fov with aspect tan(55)/tan(48) = 1.29.
 */
const QUEST_FOV = 96;
const QUEST_ASPECT = Math.tan((55 * Math.PI) / 180) / Math.tan((48 * Math.PI) / 180);

/** Views from (x, 1.6, z) facing `yaw` degrees about +y (0 faces -z, 90 faces -x); drawn count. */
function viewFrom(batch: StrokeBatch, x: number, z: number, yaw = 0): number {
  const camera = new PerspectiveCamera(QUEST_FOV, QUEST_ASPECT, 0.05, 1000);
  camera.position.set(x, 1.6, z);
  camera.rotation.set(0, (yaw * Math.PI) / 180, 0);
  camera.updateMatrixWorld();
  batch.update(camera);
  return batch.visibleCount();
}

describe('budget', () => {
  let batch: StrokeBatch;

  beforeAll(() => {
    batch = createStrokeBatch(referenceWorld(), {
      createAtlas: () => new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat),
    });
  }, 60_000);

  afterAll(() => batch.dispose());

  // The budget counts instances drawn per frame after culling for the actual view (ruling R9).
  test.each([0, 90, 180, 270])(
    'from the centre, heading %s, the defaults draw inside the 90 Hz budget',
    (yaw) => {
      for (const band of STROKE_BANDS) expect(batch.density(band)).toBe(DEFAULT_BAND_DENSITY[band]);
      const drawn = viewFrom(batch, 0, 0, yaw);
      expect(drawn).toBeGreaterThanOrEqual(STROKE_BUDGET.default.min);
      expect(drawn).toBeLessThanOrEqual(STROKE_BUDGET.default.max);
    },
  );

  test.each([0, 90, 180])(
    'from 20 m out, heading %s, the defaults draw inside the 90 Hz budget',
    (yaw) => {
      const drawn = viewFrom(batch, 20, 0, yaw);
      expect(drawn).toBeGreaterThanOrEqual(STROKE_BUDGET.default.min);
      expect(drawn).toBeLessThanOrEqual(STROKE_BUDGET.default.max);
    },
  );

  test('from 20 m out facing the boundary the view holds fewer strokes than the floor', () => {
    // Heading 270 faces +x, out to the boundary: 25 m of ground and the near side of the sky.
    // Measured 108.7k at the defaults against 302.9k facing in (heading 90), a spread of 2.79.
    // The budget allows 325/150 = 2.17, and near and mid sit at or close to 1 while far adds only
    // about 6k per 0.1 here, so no uniform per-band defaults fit both. The floor is an open
    // ruling for the coordinator; the maximum, the frame-rate constraint, holds on every view.
    const drawn = viewFrom(batch, 20, 0, 270);
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(STROKE_BUDGET.default.min);
  });

  test('every band holds strokes, so each lever has something to pull', () => {
    viewFrom(batch, 0, 0);
    const perBand = new Map<StrokeBand, number>();
    for (const chunk of batch.chunks) {
      if (chunk.band) perBand.set(chunk.band, (perBand.get(chunk.band) ?? 0) + chunk.count);
    }
    for (const band of STROKE_BANDS) expect(perBand.get(band) ?? 0).toBeGreaterThan(10_000);
  });

  test('at full density the levers matter: the forward view and a full turn exceed the budget', () => {
    for (const band of STROKE_BANDS) batch.setDensity(band, 1);
    expect(viewFrom(batch, 0, 0)).toBeGreaterThan(STROKE_BUDGET.default.max);
    expect(drawnAllAround(batch)).toBe(GROUND + SKY);
    expect(drawnAllAround(batch)).toBeGreaterThan(STROKE_BUDGET.maxBeauty.max);
    for (const band of STROKE_BANDS) batch.setDensity(band, DEFAULT_BAND_DENSITY[band]);
  });
});
