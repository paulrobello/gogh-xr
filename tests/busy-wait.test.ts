import { expect, test } from 'vitest';
import { busyWait } from '../src/util/busy-wait.ts';

test('spins until the clock has advanced by the requested ms', () => {
  let t = 100;
  const spent = busyWait(14, () => (t += 0.5));
  expect(spent).toBeGreaterThanOrEqual(14);
  expect(spent).toBeLessThan(14.5 + 1e-9);
});

test('zero returns at once', () => {
  let calls = 0;
  expect(
    busyWait(0, () => {
      calls++;
      return 5;
    }),
  ).toBe(0);
  expect(calls).toBe(1);
});
