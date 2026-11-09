import { afterEach, expect, test, vi } from 'vitest';
import { boundedImport, WORLD_IMPORT_TIMEOUT_MS } from '../src/paintings/world-module.ts';

afterEach(() => vi.useRealTimers());

test('an import that never settles rejects at the bound', async () => {
  vi.useFakeTimers();
  const outcome = boundedImport(new Promise(() => {})).then(
    () => 'resolved',
    (error: Error) => error.message,
  );
  await vi.advanceTimersByTimeAsync(WORLD_IMPORT_TIMEOUT_MS - 1);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await outcome).toMatch(/timed out/);
  expect(vi.getTimerCount()).toBe(0);
});

test('an import that lands in time resolves and leaves no timer', async () => {
  vi.useFakeTimers();
  expect(await boundedImport(Promise.resolve(7))).toBe(7);
  expect(vi.getTimerCount()).toBe(0);
});

test('an import landing after the bound never reaches the build step', async () => {
  vi.useFakeTimers();
  let land: (value: string) => void = () => {};
  const late = new Promise<string>((resolve) => (land = resolve));
  let builds = 0;
  // The shape of main.ts's switcher `build`: the import is awaited, then the module builds.
  const build = async (): Promise<void> => {
    await boundedImport(late, 50);
    builds += 1;
  };
  const outcome = build().catch((error: Error) => error.message);
  await vi.advanceTimersByTimeAsync(50);
  expect(await outcome).toMatch(/timed out/);
  land('module');
  await vi.advanceTimersByTimeAsync(0);
  expect(builds).toBe(0);
});
