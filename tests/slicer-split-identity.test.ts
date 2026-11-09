import {
  type BufferAttribute,
  type BufferGeometry,
  DataTexture,
  type Mesh,
  type MeshBasicMaterial,
  RGBAFormat,
} from 'three';
import { expect, test } from 'vitest';
import { loadRealSource, loadSkyScan } from '../scripts/scatter-time.ts';
import { GALLERY_CELL_SIZE } from '../src/paintings/gallery/index.ts';
import { gallerySurfaces, scatterGallerySteps } from '../src/paintings/gallery/surfaces.ts';
import { createBaseMeshesSteps } from '../src/paintings/starry-night/base-meshes.ts';
import {
  assembleWorldStrokesSteps,
  createWorldGeometrySteps,
  scatterWorldSteps,
  worldBatchOptions,
  worldSeeds,
} from '../src/paintings/starry-night/world.ts';
import { createStrokeBatchSteps, type StrokeBatch } from '../src/render/strokes/batch.ts';
import { STROKE_ATTRIBUTES, type StrokeBuffers } from '../src/render/strokes/instance.ts';
import { createSlicer, type Steps } from '../src/util/slicer.ts';

/**
 * The portal builds (P5.5) split into many short slicer steps produce exactly what the coarse,
 * unsplit builders did. Each literal below was taken from the unsplit builders at d2d3e84, where
 * `createWorldGeometrySteps` ran one generator per step and the batch's cell loop, the village, the
 * terrain, the importance orders and the gallery filter had no yields of their own.
 */
const UNSPLIT: Readonly<Record<string, string>> = {
  geometry: 'f01e5682',
  scattered: '15625022',
  assembled: 'bee37a2a',
  batch: '058c3946',
  base: 'ba91745f',
  gallery: '6f6580f0',
  galleryBatch: 'be87405e',
};

/** FNV-1a over the bytes of each view, in order, as 8 hex digits. */
function fnv(views: readonly ArrayBufferView[]): string {
  let h = 0x811c9dc5;
  for (const view of views) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
    h = Math.imul(h ^ 0xff, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const text = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function strokeViews(buffers: StrokeBuffers): ArrayBufferView[] {
  return [new Uint32Array([buffers.count]), ...STROKE_ATTRIBUTES.map((s) => buffers[s.key])];
}

/** Every attribute, in name order, the index and the tint tags of `geometry` and its soffit. */
function geometryViews(geometry: BufferGeometry): ArrayBufferView[] {
  const views: ArrayBufferView[] = [];
  for (const name of Object.keys(geometry.attributes).sort()) {
    views.push(text(name), (geometry.getAttribute(name) as BufferAttribute).array);
  }
  const index = geometry.getIndex();
  if (index) views.push(index.array);
  const tint = geometry.userData.tint as { owner: Uint16Array; role: Uint8Array } | undefined;
  if (tint) views.push(tint.owner, tint.role);
  const soffit = geometry.userData.soffit as BufferGeometry | undefined;
  if (soffit) views.push(...geometryViews(soffit));
  return views;
}

/** The chunks in order: name, class, counts, bounds and every instance attribute's bytes. */
function batchViews(batch: StrokeBatch): ArrayBufferView[] {
  return batch.chunks.flatMap((chunk) => [
    text([
      chunk.mesh.name,
      chunk.drawClass,
      chunk.count,
      chunk.pinned,
      chunk.mesh.renderOrder,
      chunk.bounds.center.toArray(),
      chunk.bounds.radius,
    ]),
    ...geometryViews(chunk.geometry),
  ]);
}

/**
 * Runs `steps` one step per frame, as a portal build under load does. The clock advances 1 ms per
 * read, so with a 1.5 ms budget each frame's budget check passes once and fails after one step.
 */
async function sliced<T>(steps: Steps<T>): Promise<T> {
  let clock = 0;
  const slicer = createSlicer(1.5, () => clock++);
  const result = slicer.run(steps);
  let frames = 0;
  while (slicer.pending > 0) {
    slicer.frame();
    frames++;
  }
  expect(frames).toBeGreaterThan(1);
  expect(slicer.stats.steps).toBe(frames);
  return result;
}

const atlas = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);

test('the split builders give the unsplit builds byte for byte', async () => {
  const source = await loadRealSource();
  const scan = await loadSkyScan();
  const seeds = worldSeeds(1);
  const world = await sliced(createWorldGeometrySteps(seeds));
  const scattered = await sliced(scatterWorldSteps(world, source, seeds));
  const assembled = await sliced(assembleWorldStrokesSteps(scattered, world, source, scan, seeds));
  const batch = await sliced(
    createStrokeBatchSteps(assembled.buffers, worldBatchOptions(world.terrain.heightAt, atlas)),
  );
  const base = await sliced(
    createBaseMeshesSteps(world.surfaces, source.histogram, 'underpaint', seeds.scatter),
  );
  const gallery = await sliced(scatterGallerySteps(gallerySurfaces(), 1));
  const galleryBatch = await sliced(
    createStrokeBatchSteps(gallery.buffers, { cellSize: GALLERY_CELL_SIZE, atlas }),
  );
  const { village, cypress } = world;
  const hashes = {
    geometry: fnv([
      ...world.surfaces.flatMap(geometryViews),
      text([village.houses, village.windows, village.church, village.roofs]),
      text([cypress.main, cypress.lower, cypress.lobeCount]),
    ]),
    scattered: fnv(strokeViews(scattered)),
    assembled: fnv([
      ...strokeViews(assembled.buffers),
      text([
        assembled.lightsStart,
        assembled.hazeStart,
        assembled.eavesStart,
        assembled.eaveSources,
        assembled.counts,
        assembled.lightRankTies,
        assembled.cones,
      ]),
    ]),
    batch: fnv(batchViews(batch)),
    base: fnv(
      base.children.flatMap((child) => {
        const mesh = child as Mesh<BufferGeometry, MeshBasicMaterial>;
        return [
          text([mesh.name, mesh.material.color.getHex(), mesh.material.vertexColors]),
          ...geometryViews(mesh.geometry),
        ];
      }),
    ),
    gallery: fnv([...strokeViews(gallery.buffers), text(gallery.counts)]),
    galleryBatch: fnv(batchViews(galleryBatch)),
  };
  batch.dispose();
  galleryBatch.dispose();
  expect(hashes).toEqual(UNSPLIT);
}, 120_000);
