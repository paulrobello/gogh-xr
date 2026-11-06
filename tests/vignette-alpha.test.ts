import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCOMOTION_SETTINGS } from '../src/locomotion/settings';
import {
  comfortFactor,
  easeVignette,
  VIGNETTE_REST_ALPHA,
  VIGNETTE_TAU,
} from '../src/ui/vignette-alpha';

const DEG = Math.PI / 180;
const SETTINGS = DEFAULT_LOCOMOTION_SETTINGS;

/** Eases `frames` frames of `dt` toward a fixed target. */
function ease(alpha: number, target: number, frames: number, dt: number): number {
  let a = alpha;
  for (let i = 0; i < frames; i += 1) a = easeVignette(a, target, dt);
  return a;
}

describe('comfort factor', () => {
  it('is 0 at rest', () => {
    expect(comfortFactor(0, 0, SETTINGS)).toBe(0);
  });

  it('is the smooth-move speed over the set move speed, so full stick is 1', () => {
    expect(comfortFactor(1, 0, SETTINGS)).toBeCloseTo(0.5, 14);
    expect(comfortFactor(2, 0, SETTINGS)).toBe(1);
    const slow = { ...SETTINGS, moveSpeed: 1 };
    expect(comfortFactor(0.5, 0, slow)).toBeCloseTo(0.5, 14);
    expect(comfortFactor(1, 0, slow)).toBe(1);
    // The desktop sprint runs past the set speed: still capped at 1.
    expect(comfortFactor(3, 0, SETTINGS)).toBe(1);
  });

  it('is the smooth-turn rate over the set rate, either way round', () => {
    expect(comfortFactor(0, -90 * DEG, SETTINGS)).toBeCloseTo(1, 14);
    expect(comfortFactor(0, 45 * DEG, SETTINGS)).toBeCloseTo(0.5, 14);
    const fast = { ...SETTINGS, smoothTurnDegPerSec: 180 };
    expect(comfortFactor(0, 90 * DEG, fast)).toBeCloseTo(0.5, 14);
  });

  it('takes the larger of the two and never exceeds 1', () => {
    expect(comfortFactor(1, 72 * DEG, SETTINGS)).toBeCloseTo(0.8, 14);
    expect(comfortFactor(1.8, 45 * DEG, SETTINGS)).toBeCloseTo(0.9, 14);
    expect(comfortFactor(9, 400 * DEG, SETTINGS)).toBe(1);
  });
});

describe('easing', () => {
  it('stays exactly 0 at rest', () => {
    expect(ease(0, 0, 100, 0.011)).toBe(0);
  });

  it('rises toward the target with a 0.12 s time constant, independent of the frame rate', () => {
    expect(VIGNETTE_TAU).toBe(0.12);
    // Two frames of half the time constant (one 0.12 s frame would be clamped to 0.1 s).
    expect(ease(0, 0.6, 2, VIGNETTE_TAU / 2)).toBeCloseTo(0.6 * (1 - Math.exp(-1)), 14);
    // 0.5 s at 72 Hz and at 90 Hz land on the same alpha.
    const expected = 0.4 * (1 - Math.exp(-0.5 / VIGNETTE_TAU));
    expect(ease(0, 0.4, 36, 1 / 72)).toBeCloseTo(expected, 12);
    expect(ease(0, 0.4, 45, 1 / 90)).toBeCloseTo(expected, 12);
  });

  it('rises monotonically and never passes the target', () => {
    let a = 0;
    for (let i = 0; i < 200; i += 1) {
      const next = easeVignette(a, 0.6, 0.011);
      expect(next).toBeGreaterThanOrEqual(a);
      expect(next).toBeLessThanOrEqual(0.6);
      a = next;
    }
    expect(a).toBeCloseTo(0.6, 6);
  });

  it('falls back to exactly 0 once the motion stops', () => {
    const settled = ease(0.6, 0, 1, 0.011);
    expect(settled).toBeGreaterThan(0.5);
    // ln(0.6 / 0.001) × 0.12 s ≈ 0.77 s, so it is exactly 0 within 1 s.
    expect(ease(0.6, 0, 91, 0.011)).toBe(0);
    expect(VIGNETTE_REST_ALPHA).toBeLessThanOrEqual(0.001);
  });

  it('lets a small target rise rather than snapping it to 0', () => {
    const small = 2 * VIGNETTE_REST_ALPHA;
    expect(ease(0, small, 1, 0.011)).toBeGreaterThan(0);
    // A target below the rest alpha stays dark: no draw call for a stick barely off the deadzone.
    expect(ease(0, VIGNETTE_REST_ALPHA / 2, 100, 0.011)).toBe(0);
  });

  it('clamps dt to 0.1 s and holds on a zero or negative dt', () => {
    expect(easeVignette(0, 0.6, 5)).toBeCloseTo(0.6 * (1 - Math.exp(-0.1 / VIGNETTE_TAU)), 14);
    expect(easeVignette(0.3, 0.6, 0)).toBe(0.3);
    expect(easeVignette(0.3, 0.6, -1)).toBe(0.3);
  });
});
