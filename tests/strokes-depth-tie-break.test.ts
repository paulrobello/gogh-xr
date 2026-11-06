import { PerspectiveCamera } from 'three';
import { describe, expect, test } from 'vitest';
import {
  DEPTH_TIE_BREAK_MAX_M,
  DEPTH_TIE_BREAK_STEPS,
  depthStepAt,
  depthTieBreakClipRange,
  depthTieBreakRange,
  NDC_DEPTH_STEP,
} from '../src/render/strokes/depth-tie-break.ts';
import { SKY_DOME_RADIUS } from '../src/world/sky.ts';
import { RIDGE_RADIUS } from '../src/world/terrain.ts';
import { OUTLINE_GAP, ROOF_OVERHANG } from '../src/world/village.ts';

const NEAR = 0.1;
const FAR = 1000;
/** three's own projectionMatrix[3][2], which the shader reads: -2fn / (f - n). */
const P32 = new PerspectiveCamera(70, 1, NEAR, FAR).projectionMatrix.elements[14];

describe('depthStepAt', () => {
  test('one 24-bit window step is 2^-23 in NDC z', () => {
    expect(NDC_DEPTH_STEP).toBe(2 ** -23);
  });

  test('matches the derivative of three’s perspective depth', () => {
    const ndc = (z: number) => (FAR + NEAR) / (FAR - NEAR) - (2 * FAR * NEAR) / ((FAR - NEAR) * z);
    for (const z of [1, 10, 100]) {
      const h = z * 1e-4;
      const slope = (ndc(z + h) - ndc(z - h)) / (2 * h);
      expect(depthStepAt(z, NEAR, FAR)).toBeCloseTo(NDC_DEPTH_STEP / slope, 9);
    }
  });

  test('is about 6 mm at 100 m and grows with the square of the depth at near 0.1', () => {
    expect(depthStepAt(100, NEAR, FAR)).toBeCloseTo(0.00596, 5);
    expect(depthStepAt(20, NEAR, FAR) / depthStepAt(10, NEAR, FAR)).toBeCloseTo(4, 9);
  });
});

describe('depthTieBreakRange', () => {
  test('is the step range up close and the metre cap far away', () => {
    expect(depthTieBreakRange(5, NEAR, FAR)).toBeCloseTo(
      DEPTH_TIE_BREAK_STEPS * depthStepAt(5, NEAR, FAR),
      12,
    );
    expect(depthTieBreakRange(100, NEAR, FAR)).toBe(DEPTH_TIE_BREAK_MAX_M);
  });

  test('the cap stays inside the gaps between surfaces that must not reorder', () => {
    // Eaves overhang their walls by ROOF_OVERHANG and neighbouring roofs stand OUTLINE_GAP apart: a
    // cap within both leaves only thin swaps where those surfaces meet (ruling Q21).
    expect(DEPTH_TIE_BREAK_MAX_M).toBeLessThanOrEqual(ROOF_OVERHANG);
    expect(DEPTH_TIE_BREAK_MAX_M).toBeLessThanOrEqual(OUTLINE_GAP);
    // A sky stroke must stay behind the ridge's farthest reach.
    expect(depthTieBreakRange(SKY_DOME_RADIUS, NEAR, FAR)).toBeLessThan(
      SKY_DOME_RADIUS - RIDGE_RADIUS.max,
    );
  });
});

describe('depthTieBreakClipRange (the shader form)', () => {
  test('reads three’s projection matrix', () => {
    expect(-P32).toBeCloseTo((2 * FAR * NEAR) / (FAR - NEAR), 12);
  });

  test('in front of the eye it is the metre range, in clip z', () => {
    for (const w of [0.5, 5, 20, 60, 300]) {
      const ndc = depthTieBreakClipRange(w, P32) / w;
      const metres = (ndc * w * w * (FAR - NEAR)) / (2 * FAR * NEAR);
      expect(metres).toBeCloseTo(depthTieBreakRange(w, NEAR, FAR), 9);
    }
  });

  test('behind the eye it is the step range alone, so it stays small and clips linearly', () => {
    for (const w of [-50, -0.1, -1e-9, -0, 0]) {
      const range = depthTieBreakClipRange(w, P32);
      expect(Number.isFinite(range)).toBe(true);
      expect(range).toBeCloseTo(DEPTH_TIE_BREAK_STEPS * NDC_DEPTH_STEP * w, 15);
      expect(Math.abs(range)).toBeLessThanOrEqual(DEPTH_TIE_BREAK_STEPS * NDC_DEPTH_STEP * 50);
    }
  });
});
