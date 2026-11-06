/**
 * The Starry Night world module (P2.7, PRD D14): loads the bake rasters, runs the generators,
 * scatters their surfaces through the scatter cache, adds the boundary haze, and attaches one
 * stroke batch over flat base meshes. The module namespace is the `WorldModule`, so the registry's
 * lazy `import()` resolves straight to it; it holds one built world at a time.
 */
import { Color, type Group, type Scene, SRGBColorSpace } from 'three';
import { buildFlowField } from '../../demo/canvas/field';
import { registerDiag, unregisterDiag } from '../../diag/diag';
import { createStrokeBatch, type StrokeBatch } from '../../render/strokes/batch';
import {
  BUILD_SHA,
  createIndexedDbStorage,
  loadOrScatter,
  scatterCacheKey,
  shouldBypassScatterCache,
} from '../../render/strokes/scatter-cache';
import { boundaryFactor } from '../../world/boundary';
import type { PainterCamera, WorldDeps, WorldHandle, WorldPose } from '../world-module';
import { BARE_COLOR, createBaseMeshes, disposeBaseMeshes, underpaintColor } from './base-meshes';
import {
  CANVAS_ASPECT,
  CANVAS_FOV_Y_DEG,
  CANVAS_PITCH,
  PAINTER_EYE,
  PAINTER_SPOT,
} from './canvas-camera';
import { buildCanvasHistogram, type CanvasSource } from './canvas-histogram';
import {
  createWorldGeometry,
  DEFAULT_WORLD_SEED,
  scatterWorld,
  strokeLayerCounts,
  WORLD_CELL_SIZE,
  withHaze,
  worldScatterKeyInputs,
  worldSeeds,
} from './world';

const PAINTING_ID = 'starry-night';
const PAINTING_DIR = `${import.meta.env.BASE_URL}paintings/starry-night/`;

/** Wall times of the build stages, ms. GPU upload happens at the first render and is not timed. */
export interface WorldBuildTimes {
  /** Fetch and decode of the three rasters, the flow field and the histograms. */
  decodeMs: number;
  /** Terrain, village, cypress and sky dome. */
  generateMs: number;
  /** Surface scatter or cache read, plus the haze. */
  scatterMs: number;
  /** `createStrokeBatch`, atlas excluded. */
  batchMs: number;
  /** All of the above. */
  buildMs: number;
}

interface Built {
  readonly scene: Scene;
  readonly batch: StrokeBatch;
  readonly base: Group;
  readonly background: Scene['background'];
}

let built: Built | null = null;

export async function build(deps: WorldDeps): Promise<WorldHandle> {
  if (built) throw new Error('the Starry Night world is already built; dispose it first');
  const seed = deps.seed ?? DEFAULT_WORLD_SEED;
  const debug = deps.debug ?? null;
  const start = performance.now();
  const [image, flowRaster, regions] = await Promise.all([
    deps.loadRaster(`${PAINTING_DIR}frame.webp`, false),
    deps.loadRaster(`${PAINTING_DIR}flow.png`, true),
    deps.loadRaster(`${PAINTING_DIR}regions.png`, true),
  ]);
  const flow = buildFlowField(flowRaster);
  const source: CanvasSource = {
    image,
    regions,
    flow,
    histogram: buildCanvasHistogram(image, regions, flow),
  };
  const decoded = performance.now();

  const seeds = worldSeeds(seed);
  const world = createWorldGeometry(seeds);
  const generated = performance.now();

  const bypass = shouldBypassScatterCache(
    { mode: import.meta.env.MODE, prod: import.meta.env.PROD, sha: BUILD_SHA },
    { seed: deps.seed, nocache: deps.nocache ?? false, cache: deps.cache ?? false },
  );
  const load = await loadOrScatter({
    storage: bypass ? null : createIndexedDbStorage(),
    key: scatterCacheKey(BUILD_SHA, worldScatterKeyInputs(world, seeds)),
    bypass,
    scatter: () => scatterWorld(world, source, seeds),
  });
  const buffers = withHaze(load.buffers, world, source, seeds);
  const scattered = performance.now();

  const batch = createStrokeBatch(buffers, { cellSize: WORLD_CELL_SIZE });
  const batched = performance.now();
  const atlasMs = batch.stats().atlasMs;
  const times: WorldBuildTimes = {
    decodeMs: decoded - start,
    generateMs: generated - decoded,
    scatterMs: scattered - generated,
    batchMs: batched - scattered - atlasMs,
    buildMs: batched - start - atlasMs,
  };

  const { scene } = deps;
  const base = createBaseMeshes(world.surfaces, source.histogram, debug ? 'magenta' : 'underpaint');
  const background = scene.background;
  const sky = underpaintColor(source.histogram, 'sky');
  scene.background = debug
    ? new Color(BARE_COLOR)
    : new Color().setRGB(sky[0] / 255, sky[1] / 255, sky[2] / 255, SRGBColorSpace);
  scene.add(base);
  batch.attach(scene);
  if (debug === 'bare') batch.group.visible = false;
  built = { scene, batch, base, background };

  const counts = { ...strokeLayerCounts(load.buffers), haze: buffers.count - load.buffers.count };
  const cache = bypass ? 'bypass' : load.hit ? 'hit' : 'miss';
  // Read out here so the closure does not hold the stroke buffers (about 19 MB) past the upload.
  const total = buffers.count;
  registerDiag('world', () => ({
    painting: PAINTING_ID,
    seed,
    debug,
    counts,
    total,
    times,
    cache,
    strokes: batch.stats(),
  }));
  const { heightAt, normalAt } = world.terrain;
  return { batch, ground: { heightAt, normalAt }, boundaryFactor };
}

/** Nothing animates yet (P4). */
export function update(_time: number, _dt: number): void {}

export function dispose(): void {
  if (!built) return;
  unregisterDiag('world');
  built.batch.dispose();
  disposeBaseMeshes(built.base);
  built.scene.background = built.background;
  built = null;
}

/** The painter's spot at the origin, facing -Z: the canvas framing. */
export function painterSpot(): WorldPose {
  return { position: [...PAINTER_SPOT], yaw: 0 };
}

/** The canvas camera of canvas-camera.ts: its frame is exactly canvas uv [0, 1]². */
export function painterCamera(): PainterCamera {
  return {
    eye: [...PAINTER_EYE],
    yaw: 0,
    pitch: CANVAS_PITCH,
    fovYDeg: CANVAS_FOV_Y_DEG,
    aspect: CANVAS_ASPECT,
  };
}

/** A viewer starts at the painter's spot (a random spawn is roadmap mode RM1). */
export function spawnPose(): WorldPose {
  return painterSpot();
}
