import { describe, expect, test } from 'vitest';
import { memoReach } from '../src/render/strokes/reach-memo';

describe('memoReach', () => {
  test('answers a repeated point from memory and searches a new one', () => {
    const asked: number[][] = [];
    const memo = memoReach({
      distance: (x, y, z) => {
        asked.push([x, y, z]);
        return x + y + z;
      },
    });
    // The orbs' two hands, then the rustle at the same two points on the same frame.
    expect(memo.distance(1, 2, 3)).toBe(6);
    expect(memo.distance(-1, 0.5, 2)).toBe(1.5);
    expect(memo.distance(1, 2, 3)).toBe(6);
    expect(memo.distance(-1, 0.5, 2)).toBe(1.5);
    expect(asked).toHaveLength(2);
    expect([memo.hits, memo.misses]).toEqual([2, 2]);
    // A moved hand is searched again, and evicts the oldest point.
    expect(memo.distance(1, 2, 3.001)).toBeCloseTo(6.001, 9);
    expect(asked).toHaveLength(3);
    expect(memo.distance(-1, 0.5, 2)).toBe(1.5);
    expect(memo.distance(1, 2, 3)).toBe(6);
    expect(asked).toHaveLength(4);
  });

  test('passes Infinity through and never matches the unset slots', () => {
    const memo = memoReach({ distance: () => Infinity });
    expect(memo.distance(Number.NaN, Number.NaN, Number.NaN)).toBe(Infinity);
    expect(memo.distance(0, 0, 0)).toBe(Infinity);
    expect(memo.misses).toBe(2);
  });
});
