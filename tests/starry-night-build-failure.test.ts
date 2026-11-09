/**
 * A Starry Night build that throws after it added to the scene releases what it added: the
 * caller never disposes a world whose build rejected, so `dispose` (a no-op before `built`) would
 * leave the base meshes and the stroke batch in the scene under the next world (card 01a1c05ae68c).
 */
import { DataTexture, Scene } from 'three';
import { expect, test, vi } from 'vitest';
import { decode } from '../scripts/scatter-time.ts';
import { build, dispose } from '../src/paintings/starry-night/index.ts';

vi.mock('../src/render/sky-halo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/render/sky-halo')>()),
  createSkyHalo: () => {
    throw new Error('halo failed');
  },
}));

test('a build that throws after the scene was filled leaves the scene as it found it', async () => {
  const scene = new Scene();
  const background = scene.background;
  const atlas = new DataTexture(new Uint8Array(4), 1, 1);
  const loadRaster = (url: string) => decode(url.split('/').pop() ?? url);
  const deps = { scene, seed: null, loadRaster, atlas, nocache: true };
  await expect(build(deps)).rejects.toThrow('halo failed');
  expect(scene.children).toEqual([]);
  expect(scene.background).toBe(background);
  // Not left "built": the next build is not refused, and dispose has nothing to do.
  dispose();
  await expect(build(deps)).rejects.toThrow('halo failed');
  expect(scene.children).toEqual([]);
}, 120_000);
