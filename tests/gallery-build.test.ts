/**
 * The gallery's build releases what it made when it throws (P5.5 review N4): the scans' bitmaps,
 * which only `dispose` closed before, so a build that failed after they loaded leaked them.
 */
import { DataTexture, type Object3D, Scene } from 'three';
import { afterEach, expect, test, vi } from 'vitest';
import { build, dispose } from '../src/paintings/gallery/index.ts';
import { HANGINGS } from '../src/paintings/gallery/layout.ts';
import type { Slicer } from '../src/util/slicer.ts';

/** A scene that refuses the gallery's root: the build throws after its scans have loaded. */
class RefusingScene extends Scene {
  override add(...objects: Object3D[]): this {
    if (objects.some((o) => o.name === 'gallery')) throw new Error('no room for the gallery');
    return super.add(...objects);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  dispose();
});

test('a build that throws after its scans load closes their bitmaps (N4)', async () => {
  const close = vi.fn();
  const fetched: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url);
      return new Response(new Blob([new Uint8Array(4)]));
    }),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 64, height: 48, close })),
  );
  const atlas = new DataTexture(new Uint8Array(4), 1, 1);
  const deps = { scene: new RefusingScene(), seed: null, loadRaster: vi.fn(), atlas };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(build(deps)).rejects.toThrow('no room for the gallery');
  expect(fetched).toHaveLength(HANGINGS.length);
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(HANGINGS.length));
  // Nothing is kept: the next build starts afresh rather than finding the gallery built.
  await expect(build(deps)).rejects.toThrow('no room for the gallery');
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2 * HANGINGS.length));
  warn.mockRestore();
});

test('a scan that never lands keeps none of the others open (F4)', async () => {
  const close = vi.fn();
  const stuck = HANGINGS[2].painting.frameImage;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.endsWith(stuck)
        ? new Promise<Response>(() => {})
        : Promise.resolve(new Response(new Blob([new Uint8Array(4)]))),
    ),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 64, height: 48, close })),
  );
  // A slicer that fails its first job: the build throws while the scans are still loading.
  const slicer = {
    run: () => Promise.reject(new Error('the slicer is gone')),
    nextFrame: () => Promise.resolve(),
  } as unknown as Slicer;
  const atlas = new DataTexture(new Uint8Array(4), 1, 1);
  const deps = { scene: new Scene(), seed: null, loadRaster: vi.fn(), atlas, slicer };
  await expect(build(deps)).rejects.toThrow('the slicer is gone');
  // Each scan closes as it lands, without waiting for the one that never does.
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(HANGINGS.length - 1));
});
