/**
 * A stroke reach query that remembers its last few answers, so the hand orbs and the rustle,
 * which ask about the same hand positions on the same frame, pay for one search per hand. The
 * field never changes, so an answer for the exact same point is always current. Kept apart from
 * reach-field.ts so the boot chunk can wrap a field without importing its build.
 */
import type { StrokeReach } from './reach-field';

export interface MemoReach extends Pick<StrokeReach, 'distance'> {
  /** Queries answered from memory, and searched, since the wrap. */
  readonly hits: number;
  readonly misses: number;
}

/** Wraps `field` with a round-robin memory of `size` points (one per hand by default). */
export function memoReach(field: Pick<StrokeReach, 'distance'>, size = 2): MemoReach {
  const points = new Float64Array(3 * size).fill(Number.NaN);
  const answers = new Float64Array(size);
  let next = 0;
  const memo = {
    hits: 0,
    misses: 0,
    distance(x: number, y: number, z: number): number {
      for (let i = 0; i < size; i += 1) {
        if (points[3 * i] === x && points[3 * i + 1] === y && points[3 * i + 2] === z) {
          memo.hits += 1;
          return answers[i] as number;
        }
      }
      memo.misses += 1;
      const d = field.distance(x, y, z);
      points[3 * next] = x;
      points[3 * next + 1] = y;
      points[3 * next + 2] = z;
      answers[next] = d;
      next = (next + 1) % size;
      return d;
    },
  };
  return memo;
}
