import { DataTexture, PerspectiveCamera, RGBAFormat } from 'three';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createGovernor, type GovernorEvent } from '../src/render/governor.ts';
import {
  BEAUTY_BAND_DENSITY,
  DEFAULT_BAND_DENSITY,
  DEFAULT_BAND_SIZE,
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

/**
 * Runs a governor on a sustained 16 ms overrun at 90 Hz for the view from (x, 1.6, z) facing
 * `yaw`, applying each density shed to the batch, until the first non-density step. Returns the
 * density events and the drawn count then. Restores the default levels afterwards.
 */
function shedDensity(
  batch: StrokeBatch,
  x: number,
  z: number,
  yaw: number,
): { events: GovernorEvent[]; drawn: number } {
  const gov = createGovernor({ mode: 'default', targetHz: 90 });
  const events: GovernorEvent[] = [];
  let drawn = viewFrom(batch, x, z, yaw);
  for (let t = 0; t < 60_000; ) {
    // Each shed takes 5% off the interval, so none is undone as no-gain, and every level overruns.
    const intervalMs = 32 * 0.95 ** gov.snapshot().level;
    t += intervalMs;
    const { bands } = batch.stats();
    const event = gov.sample({
      t,
      intervalMs,
      drawn: { near: bands.near.visible, mid: bands.mid.visible, far: bands.far.visible },
    });
    if (!event || event.step.startsWith('foveation') || event.step === 'fb-scale') continue;
    if (!event.step.endsWith('-density')) break;
    events.push(event);
    for (const band of STROKE_BANDS) {
      batch.setDensity(band, gov.levels.density[band]);
      batch.setSizeMultiplier(band, gov.levels.size[band]);
    }
    drawn = viewFrom(batch, x, z, yaw);
  }
  for (const band of STROKE_BANDS) {
    batch.setDensity(band, DEFAULT_BAND_DENSITY[band]);
    batch.setSizeMultiplier(band, DEFAULT_BAND_SIZE[band]);
  }
  return { events, drawn };
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

  test.each([0, 90, 180, 270])(
    'from 10 m out, heading %s, the defaults draw inside the 90 Hz budget',
    (yaw) => {
      const drawn = viewFrom(batch, 10, 0, yaw);
      expect(drawn).toBeGreaterThanOrEqual(STROKE_BUDGET.default.min);
      expect(drawn).toBeLessThanOrEqual(STROKE_BUDGET.default.max);
    },
  );

  // Governor territory (ruling R10). Toward the boundary, one heading's view can hold several
  // times another's (2.8x at 20 m, 17x at 40 m), more than the budget's 325/150 spread, so no
  // static defaults fit every view. The 150k floor is the governor's shed limit, not a per-view
  // guarantee: a sparse view cannot draw strokes it does not have.
  test('a sparse view under the floor from 20 m out: the governor sheds no density', () => {
    expect(viewFrom(batch, 20, 0, 270)).toBeLessThan(STROKE_BUDGET.default.min);
    expect(shedDensity(batch, 20, 0, 270).events).toEqual([]);
  });

  test('facing in from the boundary at 40 m: density sheds to the floor and no further', () => {
    const before = viewFrom(batch, 40, 0, 90);
    expect(before).toBeGreaterThan(STROKE_BUDGET.default.max);
    const { events, drawn } = shedDensity(batch, 40, 0, 90);
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((e) => e.action === 'shed')).toBe(true);
    // Far sheds before mid and mid before near.
    const order = events.map((e) =>
      STROKE_BANDS.indexOf(e.step.replace('-density', '') as StrokeBand),
    );
    expect([...order].sort((a, b) => b - a)).toEqual(order);
    expect(drawn).toBeLessThan(STROKE_BUDGET.default.max);
    // Per-chunk flooring can lose at most one instance per visible chunk against the prediction.
    expect(drawn).toBeGreaterThanOrEqual(STROKE_BUDGET.default.min - batch.stats().visibleChunks);
  });

  test.each([0, 90, 180, 270])(
    'max beauty, heading %s: the beauty densities draw more, inside the 72 Hz budget',
    (yaw) => {
      for (const x of [0, 10]) {
        const defaults = viewFrom(batch, x, 0, yaw);
        for (const band of STROKE_BANDS) batch.setDensity(band, BEAUTY_BAND_DENSITY[band]);
        const drawn = viewFrom(batch, x, 0, yaw);
        for (const band of STROKE_BANDS) batch.setDensity(band, DEFAULT_BAND_DENSITY[band]);
        expect(drawn).toBeGreaterThan(defaults * 1.2);
        expect(drawn).toBeGreaterThanOrEqual(STROKE_BUDGET.maxBeauty.min);
        expect(drawn).toBeLessThanOrEqual(STROKE_BUDGET.maxBeauty.max);
      }
    },
  );

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
