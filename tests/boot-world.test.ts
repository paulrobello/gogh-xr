/**
 * The boot's world start with its fallback (card 01a1c05452e4): a `?painting` import that never
 * settles falls back to the gallery with a notice inside the import bound.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootWorld } from '../src/boot-mode';
import { bootWorldWithFallback } from '../src/boot-world';
import { WORLD_IMPORT_TIMEOUT_MS } from '../src/paintings/world-module';

const world = (id: string): BootWorld => ({ id, world: () => new Promise(() => {}) });
const painting = world('starry-night');
const gallery = world('gallery');

afterEach(() => vi.useRealTimers());

describe('bootWorldWithFallback', () => {
  it('starts the requested world and raises nothing', async () => {
    const started: string[] = [];
    const failed = vi.fn();
    await bootWorldWithFallback(painting, gallery, {
      load: async (w) => w.id,
      start: async (w) => void started.push(w.id),
      failed,
    });
    expect(started).toEqual(['starry-night']);
    expect(failed).not.toHaveBeenCalled();
  });

  it('an import that never settles falls back to the gallery with a notice within the bound', async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    const failed: { id: string; message: string }[] = [];
    let done = false;
    const booted = bootWorldWithFallback(painting, gallery, {
      // The painting's chunk fetch never answers; the gallery's does.
      load: (w) => (w.id === 'gallery' ? Promise.resolve(w.id) : new Promise<string>(() => {})),
      start: async (w) => void started.push(w.id),
      failed: (w, error) => failed.push({ id: w.id, message: (error as Error).message }),
    }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(WORLD_IMPORT_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    expect(failed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await booted;
    expect(failed).toEqual([
      { id: 'starry-night', message: `world import timed out after ${WORLD_IMPORT_TIMEOUT_MS} ms` },
    ]);
    expect(started).toEqual(['gallery']);
  });

  it('a build that throws falls back too, and a failing gallery stops the chain', async () => {
    const failed: string[] = [];
    const started: string[] = [];
    await bootWorldWithFallback(painting, gallery, {
      load: async (w) => w.id,
      start: async (w) => {
        started.push(w.id);
        throw new Error('build');
      },
      failed: (w) => failed.push(w.id),
    });
    expect(started).toEqual(['starry-night', 'gallery']);
    expect(failed).toEqual(['starry-night', 'gallery']);
  });

  it('a failing gallery boot is reported once and not retried', async () => {
    const failed: string[] = [];
    await bootWorldWithFallback(gallery, gallery, {
      load: async () => {
        throw new Error('import');
      },
      start: async () => {},
      failed: (w) => failed.push(w.id),
    });
    expect(failed).toEqual(['gallery']);
  });
});
