/**
 * The Starry Night world's CPU half: the seeded generators assembled into one set of surfaces,
 * scattered with strokes in one call, plus the boundary haze. Pure and deterministic per seed, so
 * the unit tests build the real world without WebGL; index.ts adds loading, the cache, the batch
 * and the base meshes.
 */
import type { BufferGeometry } from 'three';
import type { Raster } from '../../demo/canvas/field';
import {
  appendStrokes,
  STROKE_LAYER,
  type StrokeBuffers,
  type StrokeInstance,
  type StrokeLayerName,
} from '../../render/strokes/instance';
import {
  type GradedSize,
  LAYER_SIZE,
  resolveScatterTables,
  type ScatterOptions,
  type ScatterOverride,
  scatterOverrides,
  scatterSurfacesSteps,
} from '../../render/strokes/scatter';
import type { ScatterKeyInputs } from '../../render/strokes/scatter-cache';
import { SKY_LIGHT_CULL_FLAG, type SkyLightCone } from '../../render/strokes/sky-light-cull';
import { drain, type Steps } from '../../util/slicer';
import { createBoundaryHazeSteps, HAZE_STROKE_DEFAULT } from '../../world/boundary';
import { type Cypress, createCypress } from '../../world/cypress';
import { createSkyDome } from '../../world/sky';
import { createSkyLightsSteps, skyLightCones } from '../../world/sky-lights';
import { createTerrain, type Terrain } from '../../world/terrain';
import { createVillage, type Village } from '../../world/village';
import type { WorldLayer } from './canvas-camera';
import type { CanvasSource } from './canvas-histogram';

/** The seed when none is given. Every generator was fitted and tested at seed 1. */
export const DEFAULT_WORLD_SEED: number = 1;
/**
 * Stroke chunk edge, metres. The world spans the 120 m sky dome, so the 4 m default makes thousands
 * of chunks, one draw call each per eye. Ruling Q5 took 24 m over 16 m on the e018c2f reading
 * (55 fps at the painter's spot with 339 visible chunks), read then as CPU-bound on those draws.
 * The 2026-11-06 headset runs showed the frame is GPU-bound instead, on stroke geometry plus
 * fragment work, with main-thread JS at 6-7 ms of 21 ms (`docs/verification.md`). Over
 * the 24 coverage poses with a Quest-wide frustum, 16 m gives 1299 chunks and up to 597 visible
 * with at most 229k drawn, 24 m 543 and up to 267 with at most 273k drawn, inside the 325k budget.
 * At the painter's spot 24 m cuts the visible chunks from 420 to 189 for 14% more drawn strokes
 * (228k to 259k). 8 m gave 5049 chunks and up to 2158 visible (P2.7 report).
 */
export const WORLD_CELL_SIZE: number = 24;
/** Boundary haze strokes. */
export const WORLD_HAZE_COUNT: number = HAZE_STROKE_DEFAULT;
/**
 * Every layer's graded size (near, far and slope) times this; the density at each distance is
 * unchanged, so the stroke count is too and each stroke covers this squared more area. The P2.7
 * coverage sweep set it: at 1 the 24 poses left 1.9-13% of the view bare, at 1.6 up to 1.6%, at
 * 1.8 at most 0.5% (P2-A3). The near ground then draws about 4.5° strokes at the eye.
 */
export const WORLD_SIZE_SCALE: number = 1.8;
/**
 * The ridge backdrop (83-105 m) as a sparse row of large strokes, 3-5 m long, at about the
 * overdraw the scaled layers get (density × length × width ≈ 16 per m²).
 */
export const RIDGE_SCATTER: ScatterOverride = Object.freeze({
  density: 3,
  size: Object.freeze({ near: 3, far: 5 }),
});

const SCALED_LAYERS = [
  'terrain',
  'building',
  'roof',
  'window',
  'church',
  'cypress',
  'sky',
] as const;

/** `LAYER_SIZE` times WORLD_SIZE_SCALE for every surface layer, as `ScatterOptions.size`. */
export const WORLD_SCATTER_SIZE: Readonly<Partial<Record<WorldLayer, GradedSize>>> = Object.freeze(
  Object.fromEntries(
    SCALED_LAYERS.map((layer) => {
      const { near, far, slope } = LAYER_SIZE[layer];
      const k = WORLD_SIZE_SCALE;
      return [layer, Object.freeze({ near: near * k, far: far * k, slope: slope * k })];
    }),
  ),
);

/**
 * The sky dome's stroke size as the scatter resolves it (`LAYER_SIZE.sky` under
 * `WORLD_SCATTER_SIZE.sky`). The moon and stars are brushed at it (src/world/sky-lights.ts).
 */
export const WORLD_DOME_SIZE: GradedSize = Object.freeze({
  ...LAYER_SIZE.sky,
  ...WORLD_SCATTER_SIZE.sky,
});

/** The seed each part of the world draws from. */
export interface WorldSeeds {
  readonly terrain: number;
  readonly village: number;
  readonly cypress: number;
  readonly scatter: number;
  readonly haze: number;
  /** The moon and star strokes (src/world/sky-lights.ts). */
  readonly lights: number;
}

/**
 * Every part takes the world seed itself. The generators were fitted at seed 1 (church fit,
 * cypress against the canvas), so seed 1 must give generator seed 1, not a hashed derivative.
 * Within the one scatter call each mesh has its own streams, and the haze, the moon and stars and
 * the generators use unrelated algorithms, so sharing the number does not correlate them.
 */
export function worldSeeds(seed: number): WorldSeeds {
  return Object.freeze({
    terrain: seed,
    village: seed,
    cypress: seed,
    scatter: seed,
    haze: seed,
    lights: seed,
  });
}

export interface WorldGeometry {
  readonly terrain: Terrain;
  readonly village: Village;
  readonly cypress: Cypress;
  readonly dome: BufferGeometry;
  /** Every stroke surface, each tagged with `userData.layer`: also the base meshes. */
  readonly surfaces: readonly BufferGeometry[];
}

/** Runs the generators; the ridge carries `RIDGE_SCATTER` in `userData.scatter`. */
export function createWorldGeometry(seeds: WorldSeeds): WorldGeometry {
  return drain(createWorldGeometrySteps(seeds));
}

/** `createWorldGeometry` as steps (P5.5): one generator per step. */
export function* createWorldGeometrySteps(seeds: WorldSeeds): Steps<WorldGeometry> {
  const terrain = createTerrain(seeds.terrain);
  yield;
  const village = createVillage(seeds.village, terrain);
  yield;
  const cypress = createCypress(seeds.cypress, terrain);
  yield;
  const dome = createSkyDome();
  terrain.ridge.userData.scatter = RIDGE_SCATTER;
  const { building, roof, window, church } = village.geometries;
  return {
    terrain,
    village,
    cypress,
    dome,
    surfaces: [
      terrain.geometry,
      terrain.ridge,
      building,
      roof,
      window,
      church,
      cypress.geometry,
      dome,
    ],
  };
}

/** The density and size options of the world scatter; the seed comes from `WorldSeeds`. */
const WORLD_SCATTER_OPTIONS: Pick<ScatterOptions, 'density' | 'size'> = Object.freeze({
  size: WORLD_SCATTER_SIZE,
});

/**
 * The scatter cache key inputs: the scatter seed, the fully resolved per-layer density and size
 * tables, the per-mesh overrides, every generator seed and the face-normal mode.
 */
export function worldScatterKeyInputs(world: WorldGeometry, seeds: WorldSeeds): ScatterKeyInputs {
  const tables = resolveScatterTables(WORLD_SCATTER_OPTIONS);
  return {
    seed: seeds.scatter,
    density: tables.density,
    size: tables.size,
    overrides: scatterOverrides(world.surfaces),
    generators: { terrain: seeds.terrain, village: seeds.village, cypress: seeds.cypress },
    normals: 'face',
  };
}

/**
 * The surface as the scatter sees it: the same triangles and tags with no normal attribute, so
 * every stroke lies in its own triangle's plane with the face normal. With interpolated normals a
 * stroke's quad tilts out of its face, half under the base mesh, and near a silhouette it faces
 * away (culled) while its face still shows, which left the base mesh bare in the sweep.
 */
function faceNormalSurface(geometry: BufferGeometry): BufferGeometry {
  const flat = geometry.clone();
  flat.deleteAttribute('normal');
  flat.userData = geometry.userData;
  return flat;
}

/**
 * All surfaces in one `scatterSurfaces` call, so no two meshes replay each other's streams, with
 * face normals and the WORLD_SCATTER_SIZE sizes.
 */
export function scatterWorld(
  world: WorldGeometry,
  source: CanvasSource,
  seeds: WorldSeeds,
): StrokeBuffers {
  return drain(scatterWorldSteps(world, source, seeds));
}

/** `scatterWorld` as steps (P5.5), for a build behind a portal transition. */
export function* scatterWorldSteps(
  world: WorldGeometry,
  source: CanvasSource,
  seeds: WorldSeeds,
): Steps<StrokeBuffers> {
  const flat = world.surfaces.map(faceNormalSurface);
  yield;
  const strokes = yield* scatterSurfacesSteps(flat, source, {
    ...WORLD_SCATTER_OPTIONS,
    seed: seeds.scatter,
  });
  for (const g of flat) g.dispose();
  return strokes;
}

/** The boundary haze, clipped to the terrain, as steps. */
function worldHazeSteps(
  world: WorldGeometry,
  source: CanvasSource,
  seeds: WorldSeeds,
): Steps<StrokeInstance[]> {
  return createBoundaryHazeSteps(source, {
    seed: seeds.haze,
    count: WORLD_HAZE_COUNT,
    groundHeight: world.terrain.heightAt,
  });
}

/** Strokes per stroke layer, the moon and stars included, plus the haze on its own. */
export type WorldStrokeCounts = Record<StrokeLayerName | 'haze', number>;

export interface WorldStrokes {
  /** The scattered strokes, then the moon and star strokes, then the boundary haze. */
  readonly buffers: StrokeBuffers;
  /** Index of the first moon or star stroke: the scattered stroke count. */
  readonly lightsStart: number;
  /** Index of the first haze stroke. */
  readonly hazeStart: number;
  readonly counts: WorldStrokeCounts;
  /** Moon and star strokes that share a front-tier rank with an overlapping one (`SkyLights`). */
  readonly lightRankTies: number;
  /** The moon and star discs, for the stroke materials' `uSkyLightCones`. */
  readonly cones: readonly SkyLightCone[];
}

/**
 * Every stroke of the world: the scatter (or its cache read), the moon and stars
 * (`createSkyLights`, colours from `scan`, lights.webp) and the boundary haze, appended in that
 * order. The last two are generated on every build, outside the scatter cache. Every haze stroke
 * carries SKY_LIGHT_CULL_FLAG, so the shader clears it, per view, from in front of the discs and
 * thins it over a feather around them.
 */
export function assembleWorldStrokes(
  scattered: StrokeBuffers,
  world: WorldGeometry,
  source: CanvasSource,
  scan: Raster,
  seeds: WorldSeeds,
): WorldStrokes {
  return drain(assembleWorldStrokesSteps(scattered, world, source, scan, seeds));
}

/** `assembleWorldStrokes` as steps (P5.5): the lights and the haze in slices, then the append. */
export function* assembleWorldStrokesSteps(
  scattered: StrokeBuffers,
  world: WorldGeometry,
  source: CanvasSource,
  scan: Raster,
  seeds: WorldSeeds,
): Steps<WorldStrokes> {
  const { strokes: lights, rankTies } = yield* createSkyLightsSteps(
    source,
    scan,
    seeds.lights,
    WORLD_DOME_SIZE,
  );
  yield;
  const haze = (yield* worldHazeSteps(world, source, seeds)).map((s) => ({
    ...s,
    flags: (s.flags ?? 0) | SKY_LIGHT_CULL_FLAG,
  }));
  yield;
  const buffers = appendStrokes(scattered, [...lights, ...haze]);
  yield;
  const hazeStart = scattered.count + lights.length;
  const counts = { ...strokeLayerCounts(buffers), haze: haze.length };
  // Haze strokes are on the sky stroke layer: count them once, under haze.
  counts.sky -= haze.length;
  return {
    buffers,
    lightsStart: scattered.count,
    hazeStart,
    counts,
    lightRankTies: rankTies,
    cones: skyLightCones(WORLD_DOME_SIZE),
  };
}

const LAYER_NAMES = Object.keys(STROKE_LAYER) as StrokeLayerName[];

/** Strokes per stroke layer (sky, star, moon, cypress, ground, building), from the meta bytes. */
export function strokeLayerCounts(buffers: StrokeBuffers): Record<StrokeLayerName, number> {
  const counts = Object.fromEntries(LAYER_NAMES.map((n) => [n, 0])) as Record<
    StrokeLayerName,
    number
  >;
  const byValue = LAYER_NAMES.map((n) => [STROKE_LAYER[n], n] as const);
  const lookup = new Map<number, StrokeLayerName>(byValue);
  for (let i = 0; i < buffers.count; i++) {
    const name = lookup.get(buffers.meta[i * 4 + 1]);
    if (name) counts[name]++;
  }
  return counts;
}
