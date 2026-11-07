import { readFileSync } from 'node:fs';
import { DataTexture, PerspectiveCamera, RGBAFormat } from 'three';
import { describe, expect, test } from 'vitest';
import { PAINTER_SPOT } from '../src/paintings/starry-night/canvas-camera.ts';
import { createWorldGeometry, worldSeeds } from '../src/paintings/starry-night/world.ts';
import {
  BACKDROP_DOME_RANKS,
  BACKDROP_FAR_MARGIN,
  BACKDROP_FRONT_RANK_SHIFT,
  BACKDROP_FRONT_RANKS,
  BACKDROP_RANK_SHIFT,
  BACKDROP_RANK_SPACING,
  backdropNdc,
  backdropRank,
  backdropSteps,
  backdropTier,
  DEPTH_BACKDROP_FLAG,
  positionHash,
  viewDepthAtNdc,
} from '../src/render/strokes/backdrop-depth.ts';
import {
  DEPTH_TIE_BREAK_FRONT_FLAG,
  NDC_DEPTH_STEP,
} from '../src/render/strokes/depth-tie-break.ts';
import { STROKE_LAYER } from '../src/render/strokes/instance.ts';
import { createStrokeMaterial } from '../src/render/strokes/material.ts';
import { BOUNDARY_RADIUS, HAZE_RADIUS, HAZE_STROKE_SIZE } from '../src/world/boundary.ts';
import { createSkyDome } from '../src/world/sky.ts';

/** The app camera's planes (src/main.ts); XR inherits them as depthNear and depthFar. */
const NEAR = 0.1;
const FAR = 1000;

describe('backdrop ranks', () => {
  test('the flag is its own bit in the meta byte', () => {
    expect(DEPTH_BACKDROP_FLAG & DEPTH_TIE_BREAK_FRONT_FLAG).toBe(0);
    expect(DEPTH_BACKDROP_FLAG).toBeGreaterThan(0);
    expect(DEPTH_BACKDROP_FLAG).toBeLessThan(256);
  });

  test('rank 0 of the dome sits the far margin in front of the far plane', () => {
    expect(backdropSteps(0, 'dome')).toBe(BACKDROP_FAR_MARGIN);
    expect(backdropNdc(0, 'dome')).toBe(1 - BACKDROP_FAR_MARGIN * NDC_DEPTH_STEP);
  });

  test('ranks are spaced by more than the GPU’s depth rounding, higher ranks nearer', () => {
    // Near z = 1 a window step is 2 float ulps and the divide by w can be 1-2 ulps off, so two
    // ranks need at least 4 steps between them to never meet.
    expect(BACKDROP_RANK_SPACING).toBeGreaterThanOrEqual(4);
    expect(BACKDROP_FAR_MARGIN).toBeGreaterThanOrEqual(2 * BACKDROP_RANK_SPACING);
    for (const r of [0, 1, 500, BACKDROP_DOME_RANKS - 2]) {
      const gap = (backdropNdc(r, 'dome') - backdropNdc(r + 1, 'dome')) / NDC_DEPTH_STEP;
      expect(gap).toBeCloseTo(BACKDROP_RANK_SPACING, 6);
    }
  });

  test('the depths are exact float32 values, so a constant-depth quad stays flat', () => {
    for (const tier of ['dome', 'front'] as const) {
      const ranks = tier === 'dome' ? BACKDROP_DOME_RANKS : BACKDROP_FRONT_RANKS;
      for (const r of [0, 1, ranks - 1]) {
        const ndc = backdropNdc(r, tier);
        expect(Math.fround(ndc)).toBe(ndc);
      }
    }
  });

  test('the shader’s rank is the hash’s top bits: a power-of-two rank count', () => {
    expect(Number.isInteger(Math.log2(BACKDROP_DOME_RANKS))).toBe(true);
    expect(BACKDROP_RANK_SHIFT).toBe(32 - Math.log2(BACKDROP_DOME_RANKS));
    expect(0xffffffff >>> BACKDROP_RANK_SHIFT).toBe(BACKDROP_DOME_RANKS - 1);
  });

  test('the star and moon tier sorts ahead of every dome rank', () => {
    const nearestDome = backdropNdc(BACKDROP_DOME_RANKS - 1, 'dome');
    const farthestFront = backdropNdc(0, 'front');
    expect(farthestFront).toBeLessThan(nearestDome);
    expect((nearestDome - farthestFront) / NDC_DEPTH_STEP).toBeCloseTo(BACKDROP_RANK_SPACING, 6);
  });

  test('a rank outside its tier throws', () => {
    expect(() => backdropSteps(-1, 'dome')).toThrow(RangeError);
    expect(() => backdropSteps(BACKDROP_DOME_RANKS, 'dome')).toThrow(RangeError);
    expect(() => backdropSteps(BACKDROP_FRONT_RANKS, 'front')).toThrow(RangeError);
    expect(() => backdropSteps(0.5, 'dome')).toThrow(RangeError);
  });
});

describe('viewDepthAtNdc', () => {
  test('inverts three’s perspective depth', () => {
    const p = new PerspectiveCamera(70, 1, NEAR, FAR).projectionMatrix.elements;
    for (const d of [0.5, 10, 120, 600]) {
      const clipZ = p[10] * -d + p[14];
      const ndc = clipZ / d;
      expect(viewDepthAtNdc(ndc, NEAR, FAR)).toBeCloseTo(d, 6);
    }
    expect(viewDepthAtNdc(1, NEAR, FAR)).toBeCloseTo(FAR, 6);
  });
});

describe('the backdrop draws behind the whole world', () => {
  test('the nearest backdrop rank lies beyond any surface seen from inside the boundary', () => {
    const world = createWorldGeometry(worldSeeds(1));
    let farthest = 0;
    for (const surface of world.surfaces) {
      if (surface.userData.backdrop === true) continue;
      const position = surface.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        farthest = Math.max(
          farthest,
          Math.hypot(
            position.getX(i) - PAINTER_SPOT[0],
            position.getY(i) - PAINTER_SPOT[1],
            position.getZ(i) - PAINTER_SPOT[2],
          ),
        );
      }
    }
    farthest = Math.max(farthest, HAZE_RADIUS.max + Math.hypot(...HAZE_STROKE_SIZE));
    // An eye stays within BOUNDARY_RADIUS of the spot; 10 m covers the largest stroke's reach.
    const reach = BOUNDARY_RADIUS + farthest + 10;
    const nearest = backdropNdc(BACKDROP_FRONT_RANKS - 1, 'front');
    const depth = viewDepthAtNdc(nearest, NEAR, FAR);
    expect(depth).toBeGreaterThan(reach);
  });

  test('only the sky dome is a backdrop surface', () => {
    const world = createWorldGeometry(worldSeeds(1));
    expect(createSkyDome().userData.backdrop).toBe(true);
    const backdrops = world.surfaces.filter((s) => s.userData.backdrop === true);
    expect(backdrops).toEqual([world.dome]);
  });
});

test('the stroke material carries the backdrop constants as defines', () => {
  const atlas = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
  const material = createStrokeMaterial(atlas);
  const defines = material.defines as Record<string, string>;
  expect(Math.fround(Number(defines.BACKDROP_FAR_NDC))).toBe(backdropNdc(0, 'dome'));
  expect(Math.fround(Number(defines.BACKDROP_RANK_NDC))).toBe(
    BACKDROP_RANK_SPACING * NDC_DEPTH_STEP,
  );
  expect(defines.BACKDROP_RANK_SHIFT).toBe(`${BACKDROP_RANK_SHIFT}u`);
  expect(defines.DEPTH_BACKDROP_FLAG).toBe(`${DEPTH_BACKDROP_FLAG}u`);
  expect(defines.BACKDROP_DOME_RANKS).toBe(`${BACKDROP_DOME_RANKS}u`);
  expect(defines.BACKDROP_FRONT_RANK_SHIFT).toBe(`${BACKDROP_FRONT_RANK_SHIFT}u`);
  expect(defines.STROKE_LAYER_STAR).toBe(`${STROKE_LAYER.star}u`);
  expect(defines.STROKE_LAYER_MOON).toBe(`${STROKE_LAYER.moon}u`);
  material.dispose();
});

test('a flagged moon or star stroke draws at its front rank, in front of every dome rank', () => {
  expect(BACKDROP_FRONT_RANK_SHIFT).toBe(32 - Math.log2(BACKDROP_FRONT_RANKS));
  expect(backdropTier(STROKE_LAYER.star)).toBe('front');
  expect(backdropTier(STROKE_LAYER.moon)).toBe('front');
  expect(backdropTier(STROKE_LAYER.sky)).toBe('dome');
  const p: [number, number, number] = [12.5, 80.25, -90.125];
  const h = positionHash(p);
  expect(backdropRank(p, STROKE_LAYER.moon)).toBe(h >>> 24);
  expect(backdropRank(p, STROKE_LAYER.sky)).toBe(h >>> BACKDROP_RANK_SHIFT);
  // The shader's NDC for front rank r: the far NDC less (BACKDROP_DOME_RANKS + r) rank steps.
  for (const r of [0, 255]) {
    const shader =
      backdropNdc(0, 'dome') - (BACKDROP_DOME_RANKS + r) * BACKDROP_RANK_SPACING * NDC_DEPTH_STEP;
    expect(shader).toBeCloseTo(backdropNdc(r, 'front'), 12);
    expect(backdropNdc(r, 'front')).toBeLessThan(backdropNdc(BACKDROP_DOME_RANKS - 1, 'dome'));
  }
  const vert = readFileSync('src/render/strokes/stroke.vert.glsl', 'utf8');
  expect(vert).toContain('iMeta.y == STROKE_LAYER_STAR || iMeta.y == STROKE_LAYER_MOON');
  expect(vert).toContain('float(BACKDROP_DOME_RANKS + (h >> BACKDROP_FRONT_RANK_SHIFT))');
});
