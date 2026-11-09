/**
 * The raster loader is bounded (portal review F2): a fetch that never answers rejects, so a world
 * build waiting on it always settles and the portal can enter that world again.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { loadRaster, RASTER_TIMEOUT_MS } from '../src/demo/canvas/demo.ts';
import { STALL_TIMEOUT_S } from '../src/portal/switcher.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a fetch that never answers rejects once the timeout passes, rather than hang', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          signals.push(signal);
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    ),
  );
  const started = performance.now();
  await expect(loadRaster('/paintings/starry-night/flow.png', true, 40)).rejects.toBeDefined();
  expect(performance.now() - started).toBeGreaterThanOrEqual(30);
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(true);
});

test('the bound sits well above the portal stall timeout, so running frames give up first', () => {
  expect(RASTER_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * STALL_TIMEOUT_S * 1000);
});
