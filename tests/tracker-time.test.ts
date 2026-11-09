import { describe, expect, it } from 'vitest';
import { createReactiveTracker } from '../src/motion/reactive';
import { trackerTime } from '../src/motion/tracker-time';

describe('trackerTime', () => {
  it('prefers the frame predictedDisplayTime', () => {
    expect(trackerTime(1000, { predictedDisplayTime: 1011.5 })).toBe(1011.5);
  });

  it('falls back to the callback time without a frame or a usable prediction', () => {
    expect(trackerTime(1000)).toBe(1000);
    expect(trackerTime(1000, null)).toBe(1000);
    expect(trackerTime(1000, {})).toBe(1000);
    expect(trackerTime(1000, { predictedDisplayTime: Number.NaN })).toBe(1000);
    expect(trackerTime(1000, { predictedDisplayTime: Number.POSITIVE_INFINITY })).toBe(1000);
  });

  it('falls back for a zero or negative prediction', () => {
    expect(trackerTime(1000, { predictedDisplayTime: 0 })).toBe(1000);
    expect(trackerTime(1000, { predictedDisplayTime: -5 })).toBe(1000);
  });

  it('gives the tracker a sane dt across a fallback frame', () => {
    const tracker = createReactiveTracker();
    const head: [number, number, number] = [0, 1.6, 0];
    const hand = (x: number): [number, number, number] => [x, 1, -0.5];
    // Frame 2 reports a zero prediction: its time falls back to the callback time.
    tracker.frame(trackerTime(1000, { predictedDisplayTime: 1010 }), [head, hand(0), null]);
    tracker.frame(trackerTime(1016, { predictedDisplayTime: 0 }), [head, hand(0.006), null]);
    expect(tracker.diag().disturbers[1].velocity[0]).toBeCloseTo(1, 9);
    tracker.frame(trackerTime(1032, { predictedDisplayTime: 1032 }), [head, hand(0.022), null]);
    expect(tracker.diag().disturbers[1].velocity[0]).toBeCloseTo(1, 9);
  });
});
