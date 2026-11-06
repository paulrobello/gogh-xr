/**
 * Times the default-world surface scatter (P2.6) on the desktop with the real bake rasters, decoded
 * with sharp, and runs the real-data check: every mapped region has texels, `sampleCanvas` never
 * throws, and the share of strokes facing the painter's eye per layer.
 *
 *   bun scripts/scatter-time.ts
 *
 * The timed run is the app's own world scatter (`scatterWorld`: P2.7's scaled sizes, face normals
 * and ridge override); the per-mesh table still shows the P2.6 layer tables at their own sizes.
 * Prints the per-layer table and a docs/perf.md row. The time counts only when the 1-minute load
 * average is at most 15 both before and after the run (ruling P6).
 */
import { loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { BufferGeometry } from 'three';
import { buildFlowField, type Raster } from '../src/demo/canvas/field';
import {
  LAYER_REGION,
  PAINTER_EYE,
  type WorldLayer,
} from '../src/paintings/starry-night/canvas-camera';
import {
  buildCanvasHistogram,
  type CanvasSource,
} from '../src/paintings/starry-night/canvas-histogram';
import { createWorldGeometry, scatterWorld, worldSeeds } from '../src/paintings/starry-night/world';
import { unpackInstance } from '../src/render/strokes/instance';
import {
  LAYER_DENSITY,
  LAYER_SIZE,
  scatterSurfaces,
  surfaceArea,
  WORLD_LAYERS,
} from '../src/render/strokes/scatter';
import { createCypress } from '../src/world/cypress';
import { createSkyDome } from '../src/world/sky';
import { createTerrain } from '../src/world/terrain';
import { createVillage } from '../src/world/village';

const PAINTING_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../public/paintings/starry-night',
);
/** Host load ceiling for a recorded timing (ruling P6). */
export const MAX_LOAD = 15;

/** Decodes an image to RGBA8 with no colour conversion of the stored values. */
export async function decode(name: string): Promise<Raster> {
  const { data, info } = await sharp(resolve(PAINTING_DIR, name))
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`${name}: decoded ${info.channels} channels, not 4`);
  return { width: info.width, height: info.height, data };
}

/** The real CanvasSource from frame.webp, regions.png and flow.png. */
export async function loadRealSource(): Promise<CanvasSource> {
  const [image, regions, flowRaster] = await Promise.all([
    decode('frame.webp'),
    decode('regions.png'),
    decode('flow.png'),
  ]);
  const flow = buildFlowField(flowRaster);
  return { image, regions, flow, histogram: buildCanvasHistogram(image, regions, flow) };
}

export interface WorldMesh {
  readonly name: string;
  readonly geometry: BufferGeometry;
}

/** The default world's surfaces, generator seed 1, in a fixed order. */
export function defaultWorldMeshes(seed = 1): WorldMesh[] {
  const terrain = createTerrain(seed);
  const village = createVillage(seed, terrain);
  const cypress = createCypress(seed, terrain);
  return [
    { name: 'ground', geometry: terrain.geometry },
    { name: 'ridge', geometry: terrain.ridge },
    ...Object.entries(village.geometries).map(([name, geometry]) => ({ name, geometry })),
    { name: 'cypress', geometry: cypress.geometry },
    { name: 'sky', geometry: createSkyDome() },
  ];
}

export interface MeshStats {
  readonly name: string;
  readonly layer: WorldLayer;
  readonly area: number;
  readonly count: number;
  /** Share of strokes whose normal faces PAINTER_EYE. */
  readonly facing: number;
  /** Shortest and longest stroke length, metres. */
  readonly length: readonly [number, number];
}

/**
 * Scatters each mesh alone. The first mesh of each layer matches the combined run exactly
 * (per-mesh streams); a later one (the ridge) runs as mesh 0 here, so it differs from the combined
 * run only by its Bernoulli remainders.
 */
export function meshStats(
  meshes: readonly WorldMesh[],
  source: CanvasSource,
  seed: number,
  densityScale = 1,
): MeshStats[] {
  const density = Object.fromEntries(WORLD_LAYERS.map((l) => [l, LAYER_DENSITY[l] * densityScale]));
  return meshes.map(({ name, geometry }) => {
    const layer = geometry.userData.layer as WorldLayer;
    const buffers = scatterSurfaces([geometry], source, { seed, density });
    let facing = 0;
    let shortest = Number.POSITIVE_INFINITY;
    let longest = 0;
    for (let i = 0; i < buffers.count; i++) {
      const s = unpackInstance(buffers, i);
      shortest = Math.min(shortest, s.size[0]);
      longest = Math.max(longest, s.size[0]);
      const d =
        s.normal[0] * (PAINTER_EYE[0] - s.position[0]) +
        s.normal[1] * (PAINTER_EYE[1] - s.position[1]) +
        s.normal[2] * (PAINTER_EYE[2] - s.position[2]);
      if (d > 0) facing++;
    }
    return {
      name,
      layer,
      area: surfaceArea(geometry),
      count: buffers.count,
      facing: buffers.count ? facing / buffers.count : 0,
      length: buffers.count ? [shortest, longest] : [0, 0],
    };
  });
}

/** Regions LAYER_REGION maps to that have no frame texels; empty when the bake is sound. */
export function emptyMappedRegions(source: CanvasSource): number[] {
  const mapped = [...new Set(Object.values(LAYER_REGION))];
  return mapped.filter((r) => !(source.histogram.regions[r]?.count > 0));
}

/** The per-mesh table: graded size (near, far, slope) and the stroke lengths actually drawn. */
export function printStats(stats: readonly MeshStats[]): void {
  console.log(
    '\n| Mesh | Layer | Area m² | Density at near /m² | Size near-far m, slope | Length range m | Strokes | Facing eye |',
  );
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of stats) {
    const z = LAYER_SIZE[s.layer];
    console.log(
      `| ${s.name} | ${s.layer} | ${s.area.toFixed(0)} | ${LAYER_DENSITY[s.layer]} | ${z.near}-${z.far}, ${z.slope} | ${s.length[0].toFixed(3)}-${s.length[1].toFixed(3)} | ${s.count.toLocaleString('en-US')} | ${(s.facing * 100).toFixed(1)}% |`,
    );
  }
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const source = await loadRealSource();
  const t1 = performance.now();
  const meshes = defaultWorldMeshes();
  const t2 = performance.now();
  const empty = emptyMappedRegions(source);
  console.log(`decode + source ${(t1 - t0).toFixed(0)} ms, geometry ${(t2 - t1).toFixed(0)} ms`);
  console.log(`mapped regions without texels: ${empty.length ? empty.join(', ') : 'none'}`);

  // Warm-up at low density so the JIT has compiled the scatter before the timed run.
  scatterSurfaces(
    meshes.map((m) => m.geometry),
    source,
    { seed: 1, density: Object.fromEntries(WORLD_LAYERS.map((l) => [l, LAYER_DENSITY[l] * 0.05])) },
  );
  // The timed run is the app's own world scatter: scaled sizes, face normals, the ridge override.
  const seeds = worldSeeds(1);
  const world = createWorldGeometry(seeds);
  const loadBefore = loadavg()[0];
  const s0 = performance.now();
  const buffers = scatterWorld(world, source, seeds);
  const scatterMs = performance.now() - s0;
  const loadAfter = loadavg()[0];

  const stats = meshStats(meshes, source, 1);
  printStats(stats);
  const sum = stats.reduce((a, s) => a + s.count, 0);
  console.log(
    `\nworld scatter strokes: ${buffers.count.toLocaleString('en-US')} (P2.6 per-mesh table sum ${sum})`,
  );
  console.log(
    `scatter ${scatterMs.toFixed(0)} ms, load ${loadBefore.toFixed(2)} -> ${loadAfter.toFixed(2)}`,
  );
  const ok = loadBefore <= MAX_LOAD && loadAfter <= MAX_LOAD;
  const host = `bun ${process.versions.bun ?? '?'}, ${process.platform}/${process.arch}`;
  console.log(
    ok
      ? `perf.md row: | ${buffers.count.toLocaleString('en-US')} | ${scatterMs.toFixed(0)} ms | ${loadBefore.toFixed(2)} | ${loadAfter.toFixed(2)} | ${host} |`
      : `perf.md row: pending measurement (host load ${Math.max(loadBefore, loadAfter).toFixed(2)})`,
  );
  if (empty.length) process.exitCode = 1;
}

if (import.meta.main) await main();
