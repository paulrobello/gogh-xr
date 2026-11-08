/**
 * The Starry Night world module (P2.7, PRD D14): loads the bake rasters, runs the generators,
 * scatters their surfaces through the scatter cache, adds the boundary haze, and attaches one
 * stroke batch over flat base meshes. The module namespace is the `WorldModule`, so the registry's
 * lazy `import()` resolves straight to it; it holds one built world at a time.
 */
import { Color, type Group, type Scene, SRGBColorSpace } from 'three';
import { buildFlowFieldSteps } from '../../demo/canvas/field';
import { registerDiag, unregisterDiag } from '../../diag/diag';
import { createSkyHalo, type SkyHalo } from '../../render/sky-halo';
import { createStrokeBatchSteps, type StrokeBatch } from '../../render/strokes/batch';
import {
  BUILD_SHA,
  createIndexedDbStorage,
  loadOrScatter,
  scatterCacheKey,
  shouldBypassScatterCache,
} from '../../render/strokes/scatter-cache';
import { skyLightConeUniforms, skyLightFeatherUniforms } from '../../render/strokes/sky-light-cull';
import { boundaryFactor } from '../../world/boundary';
import {
  buildSteps,
  type PainterCamera,
  type WorldDeps,
  type WorldHandle,
  type WorldPose,
} from '../world-module';
import { BARE_COLOR, createBaseMeshes, disposeBaseMeshes, underpaintColor } from './base-meshes';
import {
  CANVAS_ASPECT,
  CANVAS_FOV_Y_DEG,
  CANVAS_PITCH,
  PAINTER_EYE,
  PAINTER_SPOT,
} from './canvas-camera';
import { buildCanvasHistogramSteps, type CanvasSource } from './canvas-histogram';
import { createFootprintTest } from './footprints';
import {
  assembleWorldStrokesSteps,
  createWorldGeometrySteps,
  DEFAULT_WORLD_SEED,
  scatterWorldSteps,
  worldBatchOptions,
  worldScatterKeyInputs,
  worldSeeds,
} from './world';

const PAINTING_ID = 'starry-night';
const PAINTING_DIR = `${import.meta.env.BASE_URL}paintings/starry-night/`;

/** Wall times of the build stages, ms. GPU upload happens at the first render and is not timed. */
export interface WorldBuildTimes {
  /** Fetch and decode of the four rasters, the flow field and the histograms. */
  decodeMs: number;
  /** Terrain, village, cypress and sky dome. */
  generateMs: number;
  /** Surface scatter or cache read, plus the moon and stars, the haze and the eave copies. */
  scatterMs: number;
  /** `createStrokeBatch`, atlas excluded. */
  batchMs: number;
  /** All of the above. */
  buildMs: number;
}

interface Built {
  readonly scene: Scene;
  readonly batch: StrokeBatch;
  readonly halo: SkyHalo;
  readonly base: Group;
  readonly background: Scene['background'];
}

let built: Built | null = null;

export async function build(deps: WorldDeps): Promise<WorldHandle> {
  if (built) throw new Error('the Starry Night world is already built; dispose it first');
  const seed = deps.seed ?? DEFAULT_WORLD_SEED;
  const debug = deps.debug ?? null;
  const { step, run } = buildSteps(deps.slicer);
  const start = performance.now();
  const [image, flowRaster, regions, scan] = await Promise.all([
    deps.loadRaster(`${PAINTING_DIR}frame.webp`, false),
    deps.loadRaster(`${PAINTING_DIR}flow.png`, true),
    deps.loadRaster(`${PAINTING_DIR}regions.png`, true),
    deps.loadRaster(`${PAINTING_DIR}lights.webp`, false),
  ]);
  const flow = await run(buildFlowFieldSteps(flowRaster), 'flow');
  const source: CanvasSource = {
    image,
    regions,
    flow,
    histogram: await run(buildCanvasHistogramSteps(image, regions, flow), 'histogram'),
  };
  const decoded = performance.now();

  const seeds = worldSeeds(seed);
  const world = await run(createWorldGeometrySteps(seeds), 'geometry');
  const generated = performance.now();

  const bypass = shouldBypassScatterCache(
    { mode: import.meta.env.MODE, prod: import.meta.env.PROD, sha: BUILD_SHA },
    { seed: deps.seed, nocache: deps.nocache ?? false, cache: deps.cache ?? false },
  );
  const load = await loadOrScatter({
    storage: bypass ? null : createIndexedDbStorage(),
    key: scatterCacheKey(BUILD_SHA, worldScatterKeyInputs(world, seeds)),
    bypass,
    scatter: () => run(scatterWorldSteps(world, source, seeds), 'scatter'),
  });
  const { buffers, counts, cones, lightRankTies } = await run(
    assembleWorldStrokesSteps(load.buffers, world, source, scan, seeds),
    'assemble',
  );
  const scattered = performance.now();

  const batch = await run(
    createStrokeBatchSteps(buffers, worldBatchOptions(world.terrain.heightAt, deps.atlas)),
    'batch',
  );
  const coneUniforms = skyLightConeUniforms(cones);
  const featherUniforms = skyLightFeatherUniforms(cones);
  for (const material of Object.values(batch.materials)) {
    material.uniforms.uSkyLightCones.value = coneUniforms;
    material.uniforms.uSkyLightFeathers.value = featherUniforms;
  }
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
  const base = await step(
    () =>
      createBaseMeshes(
        world.surfaces,
        source.histogram,
        debug ? 'magenta' : 'underpaint',
        seeds.scatter,
      ),
    'base',
  );
  const background = scene.background;
  const sky = underpaintColor(source.histogram, 'sky');
  scene.background = debug
    ? new Color(BARE_COLOR)
    : new Color().setRGB(sky[0] / 255, sky[1] / 255, sky[2] / 255, SRGBColorSpace);
  scene.add(base);
  batch.attach(scene);
  if (debug === 'bare') batch.group.visible = false;
  // The star and moon halos (P4.3), the world's one blended pass. The `?bare` and `?coverage`
  // sweeps count magenta pixels, which additive light would hide, so they draw without it, and
  // `?nohalo` turns it off for a cost A/B. It draws after the lights and before the cypress and
  // the world, which write no depth, so their overhang paints over it (docs/verification.md, N2).
  const halo = createSkyHalo(batch.orderBeforeClass('cypress'));
  halo.mesh.visible = debug === null && deps.halo !== false;
  scene.add(halo.mesh);
  built = { scene, batch, halo, base, background };

  const cache = bypass ? 'bypass' : load.hit ? 'hit' : 'miss';
  // Read out here so the closure does not hold the stroke buffers (about 19 MB) past the upload.
  const total = buffers.count;
  registerDiag('world', () => ({
    painting: PAINTING_ID,
    seed,
    debug,
    counts,
    lightRankTies,
    total,
    times,
    cache,
    strokes: batch.stats(),
  }));
  registerDiag('halo', () => ({ visible: halo.mesh.visible, halos: halo.state() }));
  const { heightAt, normalAt } = world.terrain;
  const blocked = createFootprintTest(world.village);
  const setHaze = (thickness: number): void => {
    for (const material of Object.values(batch.materials)) {
      material.uniforms.uHazeThickness.value = thickness;
    }
  };
  const setHalo = (on: boolean): void => {
    halo.mesh.visible = debug === null && on;
  };
  return {
    batch,
    ground: { heightAt, normalAt },
    boundaryFactor,
    blocked,
    setHaze,
    setHalo,
    halo: halo.mesh,
  };
}

/** Nothing animates yet (P4). */
export function update(_time: number, _dt: number): void {}

export function dispose(): void {
  if (!built) return;
  unregisterDiag('world');
  unregisterDiag('halo');
  built.halo.dispose();
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
