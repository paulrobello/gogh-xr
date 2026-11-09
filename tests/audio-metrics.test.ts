// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../scripts/audio/contract.ts';
import {
  headTailBalance,
  interiorGaps,
  monoFold,
  type PcmLike,
  wrapStep,
} from '../scripts/audio/metrics.ts';

const SR = 48_000;

function pcm(...channels: Float32Array[]): PcmLike {
  return { sampleRate: SR, channels, frames: channels[0]?.length ?? 0 };
}

function sine(hz: number, frames: number, amp = 0.5): Float32Array {
  return Float32Array.from(
    { length: frames },
    (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR),
  );
}

function noise(seed: number, frames: number, amp: number): Float32Array {
  let a = seed;
  return Float32Array.from({ length: frames }, () => {
    a = (a * 1103515245 + 12345) % 2147483648;
    return amp * (a / 1073741824 - 1);
  });
}

const gapOptions = (loop: boolean) => ({
  windowS: LIMITS.gapWindowS,
  belowMedianDb: LIMITS.gapBelowMedianDb,
  zeroRunS: LIMITS.zeroRunS,
  loop,
  activeFloorDb: LIMITS.activeFloorDb,
});

describe('monoFold (explicit 0.5L + 0.5R)', () => {
  it('reads 0 dB for identical channels, which cannot cancel', () => {
    const s = noise(1, SR, 0.3);
    expect(monoFold(pcm(s, s)).lossDb).toBeCloseTo(0, 6);
  });

  it('reads about 3.01 dB for equal-power uncorrelated channels', () => {
    const loss = monoFold(pcm(noise(1, 4 * SR, 0.3), noise(7, 4 * SR, 0.3))).lossDb;
    expect(loss).toBeGreaterThan(2.8);
    expect(loss).toBeLessThan(3.2);
  });

  it('reads a large loss for anti-phase channels', () => {
    const s = noise(1, SR, 0.3);
    const inverted = s.map((v) => -0.9 * v);
    expect(monoFold(pcm(s, inverted)).lossDb).toBeGreaterThan(20);
  });

  it('reads 0 for a mono file, which has nothing to fold', () => {
    expect(monoFold(pcm(noise(1, SR, 0.3))).lossDb).toBe(0);
  });
});

const SEAM = { halfWindowS: LIMITS.seamHalfWindowS, lowpassHz: LIMITS.seamLowpassHz };

describe('wrapStep', () => {
  it('passes a whole-cycle sine plus noise', () => {
    // 100 Hz over 1 s is 100 whole cycles, so the last frame leads into the first.
    const s = sine(100, SR, 0.3);
    const n = noise(3, SR, 0.02);
    expect(wrapStep(pcm(s.map((v, i) => v + (n[i] as number))), SEAM).ratio).toBeLessThanOrEqual(
      LIMITS.wrapMaxRatio,
    );
  });

  it('fails the same signal cut half a period short', () => {
    const s = sine(100, SR, 0.3).map((v, i) => v + Math.cos((2 * Math.PI * 100 * i) / SR) * 0.3);
    const n = noise(3, SR, 0.02);
    const mixed = s.map((v, i) => v + (n[i] as number));
    expect(wrapStep(pcm(mixed.slice(0, SR - 240)), SEAM).ratio).toBeGreaterThan(
      LIMITS.wrapMaxRatio,
    );
  });
});

describe('headTailBalance', () => {
  it('reads about 0 dB for a stationary signal', () => {
    expect(headTailBalance(pcm(noise(5, 4 * SR, 0.2)), 1).deltaDb).toBeLessThan(0.5);
  });

  it('reads the level step of a quiet head', () => {
    const s = noise(5, 4 * SR, 0.2);
    for (let i = 0; i < SR; i++) s[i] = (s[i] as number) * 0.1;
    expect(headTailBalance(pcm(s), 1).deltaDb).toBeCloseTo(20, 0);
  });
});

describe('interiorGaps', () => {
  it('finds nothing in a steady loop', () => {
    const gaps = interiorGaps(pcm(noise(9, 4 * SR, 0.2)), gapOptions(true));
    expect(gaps.quiet).toHaveLength(0);
    expect(gaps.longestZeroRunS).toBe(0);
  });

  it('flags a zeroed span inside a loop, as quiet windows and as digital silence', () => {
    const s = noise(9, 4 * SR, 0.2);
    s.fill(0, 2 * SR, 2 * SR + 0.3 * SR);
    const gaps = interiorGaps(pcm(s), gapOptions(true));
    expect(gaps.quiet.length).toBeGreaterThanOrEqual(2);
    expect(gaps.longestZeroRunS).toBeCloseTo(0.3, 3);
    expect(gaps.zeroRunAt).toBeCloseTo(2, 3);
  });

  it('ignores digital silence outside a one-shot active span', () => {
    const s = new Float32Array(2 * SR);
    s.set(sine(440, SR, 0.5), 0.25 * SR);
    expect(interiorGaps(pcm(s), gapOptions(false)).longestZeroRunS).toBe(0);
  });

  it('flags digital silence inside a one-shot active span', () => {
    const s = sine(440, 2 * SR, 0.5);
    s.fill(0, SR, SR + 0.05 * SR);
    expect(interiorGaps(pcm(s), gapOptions(false)).longestZeroRunS).toBeCloseTo(0.05, 3);
  });
});
