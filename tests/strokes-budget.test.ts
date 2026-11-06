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

function viewFrom(batch: StrokeBatch, x: number, z: number): PerspectiveCamera {
  // Roughly the Quest 3 combined field of view.
  const camera = new PerspectiveCamera(100, 1.1, 0.05, 1000);
  camera.position.set(x, 1.6, z);
  camera.updateMatrixWorld();
  batch.update(camera);
  return camera;
}

describe('budget', () => {
  let batch: StrokeBatch;

  beforeAll(() => {
    batch = createStrokeBatch(referenceWorld(), {
      createAtlas: () => new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat),
    });
  }, 60_000);

  afterAll(() => batch.dispose());

  test.each([
    ['the centre', 0, 0],
    ['20 m out', 20, 0],
  ])('at the default densities a full turn from %s draws inside the 90 Hz budget', (_, x, z) => {
    viewFrom(batch, x, z);
    for (const band of STROKE_BANDS) expect(batch.density(band)).toBe(DEFAULT_BAND_DENSITY[band]);
    const drawn = drawnAllAround(batch);
    expect(drawn).toBeGreaterThanOrEqual(STROKE_BUDGET.default.min);
    expect(drawn).toBeLessThanOrEqual(STROKE_BUDGET.default.max);
    // Every band holds strokes, so each lever has something to pull.
    const perBand = new Map<StrokeBand, number>();
    for (const chunk of batch.chunks) {
      if (chunk.band) perBand.set(chunk.band, (perBand.get(chunk.band) ?? 0) + chunk.count);
    }
    for (const band of STROKE_BANDS) expect(perBand.get(band) ?? 0).toBeGreaterThan(10_000);
  });

  test('at full density the same world blows both budgets', () => {
    viewFrom(batch, 0, 0);
    for (const band of STROKE_BANDS) batch.setDensity(band, 1);
    expect(drawnAllAround(batch)).toBe(GROUND + SKY);
    expect(drawnAllAround(batch)).toBeGreaterThan(STROKE_BUDGET.maxBeauty.max);
    for (const band of STROKE_BANDS) batch.setDensity(band, DEFAULT_BAND_DENSITY[band]);
  });

  test('frustum culling draws fewer than the full turn', () => {
    viewFrom(batch, 0, 0);
    const visible = batch.visibleCount();
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(drawnAllAround(batch));
  });
});
