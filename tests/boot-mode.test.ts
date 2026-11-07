import { expect, test, vi } from 'vitest';
import { bootWorld, GALLERY_WORLD, resolveBootMode } from '../src/boot-mode.ts';
import { parseFlags } from '../src/diag/flags.ts';
import { livePainting, PAINTINGS } from '../src/paintings/registry.ts';

const quietLive = (id: string | null) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return livePainting(id);
  } finally {
    warn.mockRestore();
  }
};

const mode = (search: string) => resolveBootMode(parseFlags(search), quietLive);

test('no scene flag boots the gallery', () => {
  expect(mode('')).toEqual({ kind: 'gallery' });
  expect(mode('?diag&noanim&seed=3')).toEqual({ kind: 'gallery' });
  expect(bootWorld(mode(''))).toBe(GALLERY_WORLD);
  expect(GALLERY_WORLD.id).toBe('gallery');
});

test('?scene=bare boots the bare scene, trimmed and case-blind', () => {
  expect(mode('?scene=bare')).toEqual({ kind: 'bare' });
  expect(mode('?scene=%20BARE%20')).toEqual({ kind: 'bare' });
  expect(mode('?scene=gallery')).toEqual({ kind: 'gallery' });
  expect(bootWorld(mode('?scene=bare'))).toBeNull();
});

test('a live ?painting deep-links into its world over everything but the bench', () => {
  const starry = PAINTINGS[0];
  for (const search of [
    '?painting=starry-night',
    '?painting=starry-night&scene=bare',
    '?painting=starry-night&strokesTest&demo=canvas',
  ]) {
    expect(mode(search), search).toEqual({ kind: 'painting', entry: starry });
  }
  expect(bootWorld(mode('?painting=starry-night'))?.id).toBe('starry-night');
  expect(bootWorld(mode('?painting=starry-night'))?.world).toBe(starry.world);
});

test('an unknown or coming-soon ?painting warns and opens the gallery', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(resolveBootMode(parseFlags('?painting=nope'), livePainting)).toEqual({
      kind: 'gallery',
    });
    expect(resolveBootMode(parseFlags('?painting=bedroom'), livePainting)).toEqual({
      kind: 'gallery',
    });
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    warn.mockRestore();
  }
  expect(bootWorld(mode('?painting=nope'))).toBe(GALLERY_WORLD);
  // It is ignored, not a scene of its own: the flags after it still apply.
  expect(mode('?painting=nope&scene=bare')).toEqual({ kind: 'bare' });
  expect(mode('?painting=bedroom&strokesTest')).toEqual({ kind: 'test-scene' });
});

test('the test scenes keep their own boots, ahead of ?scene=bare', () => {
  expect(mode('?strokesTest')).toEqual({ kind: 'test-scene' });
  expect(mode('?demo=canvas')).toEqual({ kind: 'test-scene' });
  expect(mode('?demo=canvas&scene=bare')).toEqual({ kind: 'test-scene' });
  expect(bootWorld(mode('?strokesTest'))).toBeNull();
});

test('?bench wins over every scene flag', () => {
  for (const search of [
    '?bench=100000',
    '?bench=5000&painting=starry-night',
    '?bench=1&strokesTest',
    '?bench=1&scene=bare',
  ]) {
    expect(mode(search), search).toEqual({ kind: 'bench' });
  }
  expect(bootWorld({ kind: 'bench' })).toBeNull();
});
