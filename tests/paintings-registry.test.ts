import { expect, test, vi } from 'vitest';
import { livePainting, PAINTINGS } from '../src/paintings/registry.ts';

test('the registry holds the one live Starry Night entry', () => {
  expect(PAINTINGS.map((p) => p.id)).toEqual(['starry-night']);
  const entry = PAINTINGS[0];
  expect(entry.status).toBe('live');
  expect(entry.year).toBe(1889);
  expect(entry.title).toBe('The Starry Night');
  expect(entry.museum).toMatch(/Museum of Modern Art/);
  expect(entry.frameImage).toMatch(/frame\.webp$/);
  expect(typeof entry.world).toBe('function');
});

test('livePainting returns a live entry and warns, returning null, for anything else', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(livePainting('starry-night')?.id).toBe('starry-night');
  expect(warn).not.toHaveBeenCalled();
  expect(livePainting(null)).toBeNull();
  expect(warn).not.toHaveBeenCalled();
  expect(livePainting('water-lilies')).toBeNull();
  expect(warn).toHaveBeenCalledOnce();
  expect(String(warn.mock.calls[0][0])).toMatch(/water-lilies/);
  warn.mockRestore();
});
