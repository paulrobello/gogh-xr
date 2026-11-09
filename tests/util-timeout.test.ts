import { afterEach, expect, test, vi } from 'vitest';
import { withTimeout } from '../src/util/timeout.ts';

afterEach(() => vi.useRealTimers());

test('a promise that never settles rejects with the message at the bound, not before', async () => {
  vi.useFakeTimers();
  const outcome = withTimeout(new Promise(() => {}), 100, 'too slow').catch(
    (error: Error) => error.message,
  );
  await vi.advanceTimersByTimeAsync(99);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await outcome).toBe('too slow');
  expect(vi.getTimerCount()).toBe(0);
});

test('a promise that settles in time passes through and leaves no timer', async () => {
  vi.useFakeTimers();
  expect(await withTimeout(Promise.resolve(7), 100, 'x')).toBe(7);
  await expect(withTimeout(Promise.reject(new Error('own')), 100, 'x')).rejects.toThrow('own');
  expect(vi.getTimerCount()).toBe(0);
});
