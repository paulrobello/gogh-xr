/**
 * The Starry Night world's CPU half: the seeded generators assembled into one set of surfaces,
 * scattered with strokes in one call, plus the boundary haze. Pure and deterministic per seed, so
 * the unit tests build the real world without WebGL; index.ts adds loading, the cache, the batch
 * and the base meshes.
 */
import type { BufferGeometry, Texture } from 'three';
import type { Raster } from '../../demo/canvas/field';
import { MAX_ALTITUDE, MAX_FLIGHT_RADIUS } from '../../locomotion/flight';
import { BAND_HYSTERESIS_M, MID_BAND_MAX_M } from '../../render/strokes/bands';
import type {
  StrokeBatchOptions,
  StrokeDrawClass,
  StrokePartMerge,
} from '../../render/strokes/batch';
import type { Vec3 } from '../../render/strokes/frame';
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
import { PAINTER_EYE, type WorldLayer } from './canvas-camera';
import type { CanvasSource } from './canvas-histogram';
import { eaveUndersidesSteps } from './eave-undersides';

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
 * (228k to 259k). 8 m gave 5049 chunks and up to 2158 visible (P2.7 report). The dome and the
 * lights merge further (`worldPartGroup`).
 */
export const WORLD_CELL_SIZE: number = 24;
/**
 * The sky sector edge, degrees, by which `worldPartGroup` merges the dome's 24 m parts. The dome
 * was most of the draws: at the desktop painter view 66 dome and 21 lights chunks of 148. Sectors
 * are rows of this height from the horizon, seen from PAINTER_EYE, each row cut into
 * round(360 cos(row middle) / this) equal azimuth slices, so a sector holds about the same sky
 * everywhere. Measured offline at seed 1 (painter view, spawn view, Quest-wide painter view, most
 * drawn over the 24 coverage poses): at 24 m parts only, 148, 166 and 227 chunks with 249k at the
 * painter and at most 272k drawn. 36° gives 72, 79 and 94 chunks, 265k and at most 296k. 30° gives
 * 76, 83 and 99, 45° 70, 75 and 90 with at most 318k, and 60° draws 329k at the painter, over the
 * 325k default budget. Cubic cells cull worse: 96 m gives 76, 79 and 96 with at most 315k.
 */
export const WORLD_DOME_SECTOR_DEG: number = 36;

/**
 * A dome part's (a 24 m cell's dome strokes) sky sector key (WORLD_DOME_SECTOR_DEG), by the
 * direction of its centre from PAINTER_EYE. Every lights part gets `'sky'`, one chunk of about 4.9k
 * pinned strokes, and every other class gets null. Rows count up from the horizon, so a part below
 * it has a negative row. The top row, 72° to the zenith, is a single cap, because its slice count
 * is taken at 89°, which rounds to one. `createWorldPartGroup` adds the flight exclusion.
 */
export function worldPartGroup(drawClass: StrokeDrawClass, centre: Vec3): string | null {
  if (drawClass === 'lights') return 'sky';
  if (drawClass !== 'dome') return null;
  const x = centre[0] - PAINTER_EYE[0];
  const y = centre[1] - PAINTER_EYE[1];
  const z = centre[2] - PAINTER_EYE[2];
  const sector = WORLD_DOME_SECTOR_DEG;
  const elevation = (Math.atan2(y, Math.hypot(x, z)) * 180) / Math.PI;
  const row = Math.floor(elevation / sector);
  const middle = Math.min(89, Math.abs((row + 0.5) * sector));
  const slices = Math.max(1, Math.round((360 * Math.cos((middle * Math.PI) / 180)) / sector));
  // Azimuth from -Z, so with an even slice count a slice edge lies straight ahead of the painter.
  const azimuth = (Math.atan2(x, -z) * 180) / Math.PI;
  const slice = Math.min(slices - 1, Math.floor(((azimuth + 180) / 360) * slices));
  return `${row}_${slice}`;
}

/**
 * A dome part whose band probe can come within this of the flight envelope stays a chunk of its
 * own. A far chunk drops to mid only under MID_BAND_MAX_M minus the hysteresis, so this keeps a 1 m
 * margin over that edge for the 1 m ground sampling in `createWorldPartGroup`.
 */
export const WORLD_FLIGHT_REACH_M: number = MID_BAND_MAX_M + BAND_HYSTERESIS_M;
/** Half-width of the ground window `createWorldPartGroup` samples around a candidate part, m. */
const FLIGHT_WINDOW_M = 12;

/**
 * `StrokeBatchOptions.mergeParts` for the world: `worldPartGroup`, except that a dome part the
 * flight envelope can bring within WORLD_FLIGHT_REACH_M stays a chunk of its own. The envelope is
 * every head position flight allows: within MAX_FLIGHT_RADIUS of the origin, from the ground to
 * MAX_ALTITUDE above it. A merged chunk takes the band of its nearest part, so without this a
 * flight near the cap moved a whole sector, up to 9.5k strokes, to the mid band at once, where its
 * 24 m part alone (about 1.2k strokes) did before. At seed 1 it keeps 15 of the 435 dome parts
 * alone, none of them in the painter or spawn view (tests/world-starry-night.test.ts).
 *
 * A part is a candidate only if it is that close to the envelope's bounding cylinder, the ground's
 * range over the disc sampled once on a 2 m grid with 1 m of slack. A candidate is then measured
 * against the ground on a 1 m grid within FLIGHT_WINDOW_M of the point under it, clamped to the
 * disc, which keeps the batch build step short.
 */
export function createWorldPartGroup(heightAt: (x: number, z: number) => number): StrokePartMerge {
  const r = MAX_FLIGHT_RADIUS;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let x = -r; x <= r; x += 2) {
    for (let z = -r; z <= r; z += 2) {
      if (Math.hypot(x, z) > r) continue;
      const g = heightAt(x, z);
      low = Math.min(low, g);
      high = Math.max(high, g);
    }
  }
  low -= 1;
  high += 1 + MAX_ALTITUDE;
  const reach = WORLD_FLIGHT_REACH_M;
  const nearFlight = (c: Vec3, radius: number): boolean => {
    const h = Math.hypot(c[0], c[2]);
    const above = Math.max(0, c[1] - high, low - c[1]);
    if (Math.hypot(Math.max(0, h - r), above) - radius >= reach) return false;
    const k = h > r ? r / h : 1;
    const qx = Math.round(c[0] * k);
    const qz = Math.round(c[2] * k);
    for (let dx = -FLIGHT_WINDOW_M; dx <= FLIGHT_WINDOW_M; dx++) {
      for (let dz = -FLIGHT_WINDOW_M; dz <= FLIGHT_WINDOW_M; dz++) {
        let x = qx + dx;
        let z = qz + dz;
        const d = Math.hypot(x, z);
        if (d > r) {
          x *= r / d;
          z *= r / d;
        }
        const g = heightAt(x, z);
        const y = Math.min(g + MAX_ALTITUDE, Math.max(g, c[1]));
        if (Math.hypot(c[0] - x, c[1] - y, c[2] - z) - radius < reach) return true;
      }
    }
    return false;
  };
  return (drawClass, centre, radius) =>
    drawClass === 'dome' && nearFlight(centre, radius) ? null : worldPartGroup(drawClass, centre);
}

/** The world's stroke batch options, as index.ts builds the batch. */
export function worldBatchOptions(
  heightAt: (x: number, z: number) => number,
  atlas?: Texture,
): StrokeBatchOptions {
  return {
    cellSize: WORLD_CELL_SIZE,
    cypressChunk: true,
    mergeParts: createWorldPartGroup(heightAt),
    atlas,
  };
}

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

/**
 * Strokes per stroke layer, the moon and stars included, plus the haze and the eave underside
 * copies (eave-undersides.ts) each on its own.
 */
export type WorldStrokeCounts = Record<StrokeLayerName | 'haze' | 'eaves', number>;

export interface WorldStrokes {
  /**
   * The scattered strokes, then the moon and star strokes, then the boundary haze, then the eave
   * underside copies.
   */
  readonly buffers: StrokeBuffers;
  /** Index of the first moon or star stroke: the scattered stroke count. */
  readonly lightsStart: number;
  /** Index of the first haze stroke. */
  readonly hazeStart: number;
  /** Index of the first eave underside copy. */
  readonly eavesStart: number;
  /** For each eave underside copy in order, the index of the scattered stroke it copies. */
  readonly eaveSources: readonly number[];
  readonly counts: WorldStrokeCounts;
  /** Moon and star strokes that share a front-tier rank with an overlapping one (`SkyLights`). */
  readonly lightRankTies: number;
  /** The moon and star discs, for the stroke materials' `uSkyLightCones`. */
  readonly cones: readonly SkyLightCone[];
}

/**
 * Every stroke of the world: the scatter (or its cache read), the moon and stars
 * (`createSkyLights`, colours from `scan`, lights.webp), the boundary haze and the eave underside
 * copies of the scattered roof strokes (`eaveUndersides`), appended in that order. The last three
 * are generated on every build, outside the scatter cache. Every haze stroke carries
 * SKY_LIGHT_CULL_FLAG, so the shader clears it, per view, from in front of the discs and thins it
 * over a feather around them.
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

/**
 * `assembleWorldStrokes` as steps (P5.5): the lights, the haze and the eave copies in slices, then
 * the append.
 */
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
  const eaves = yield* eaveUndersidesSteps(scattered, world.village.roofs);
  yield;
  const buffers = appendStrokes(scattered, [...lights, ...haze, ...eaves.strokes]);
  yield;
  const hazeStart = scattered.count + lights.length;
  const counts = {
    ...strokeLayerCounts(buffers),
    haze: haze.length,
    eaves: eaves.strokes.length,
  };
  // Haze strokes are on the sky stroke layer and the eave copies on the building one: count each
  // once, under its own name.
  counts.sky -= haze.length;
  counts.building -= eaves.strokes.length;
  return {
    buffers,
    lightsStart: scattered.count,
    hazeStart,
    eavesStart: hazeStart + haze.length,
    eaveSources: eaves.sources,
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
