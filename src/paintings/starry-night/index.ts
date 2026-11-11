/**
 * The Starry Night world module (P2.7, PRD D14): loads the bake rasters, runs the generators,
 * scatters their surfaces through the scatter cache, adds the boundary haze, and attaches one
 * stroke batch over flat base meshes. The module namespace is the `WorldModule`, so the registry's
 * lazy `import()` resolves straight to it; it holds one built world at a time.
 */
import { Color, type Group, InstancedBufferAttribute, type Scene, SRGBColorSpace } from 'three';
import { buildFlowFieldSteps } from '../../demo/canvas/field';
import { type DiagToken, registerDiag, unregisterDiag } from '../../diag/diag';
import {
  buildSkyRiverFieldSteps,
  type SkyRiverField,
  skyRiverInstancesSteps,
} from '../../motion/sky-river';
import { createSkyHalo, type SkyHalo } from '../../render/sky-halo';
import { createStrokeBatchSteps, type StrokeBatch } from '../../render/strokes/batch';
import { STROKE_LAYER } from '../../render/strokes/instance';
import { buildStrokeReachSteps, chunkSources } from '../../render/strokes/reach-field';
import {
  BUILD_SHA,
  createIndexedDbStorage,
  loadOrScatter,
  scatterCacheKey,
  shouldBypassScatterCache,
} from '../../render/strokes/scatter-cache';
import { skyLightConeUniforms, skyLightFeatherUniforms } from '../../render/strokes/sky-light-cull';
import type { Steps } from '../../util/slicer';
import { boundaryFactor } from '../../world/boundary';
import {
  buildSteps,
  type PainterCamera,
  type WorldDeps,
  type WorldHandle,
  type WorldPose,
} from '../world-module';
import {
  BARE_COLOR,
  createBaseMeshesSteps,
  disposeBaseMeshes,
  underpaintColor,
} from './base-meshes';
import {
  CANVAS_ASPECT,
  CANVAS_FOV_Y_DEG,
  CANVAS_PITCH,
  PAINTER_EYE,
  PAINTER_SPOT,
} from './canvas-camera';
import { buildCanvasHistogramSteps, type CanvasSource } from './canvas-histogram';
import { createCrownTest, createFootprintTest, createVolumes } from './footprints';
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
  /** The stroke reach field over the batch's chunks (`buildStrokeReachSteps`). */
  reachMs: number;
  /** The sky river's field and its per-instance bake (iRiver). */
  riverMs: number;
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
/** This world's own `world` diag registration, so its dispose removes only that one. */
let worldDiag: DiagToken | null = null;

/** The sky river bake's footprint: the chunks given iRiver, their sky strokes and the bytes. */
export interface SkyRiverStats {
  readonly chunks: number;
  readonly strokes: number;
  readonly bytes: number;
}

/**
 * Adds iRiver (sky-river.ts skyRiverInstancesSteps) to every chunk of `batch` that holds a sky
 * stroke, SKY_RIVER_BYTES per instance of such a chunk. The other chunks never run the sky motion.
 */
function* addSkyRiverSteps(batch: StrokeBatch, field: SkyRiverField): Steps<SkyRiverStats> {
  let chunks = 0;
  let strokes = 0;
  let bytes = 0;
  for (const chunk of batch.chunks) {
    const g = chunk.geometry;
    const meta = g.getAttribute('iMeta').array;
    const data = yield* skyRiverInstancesSteps(field, {
      count: chunk.count,
      position: g.getAttribute('iPosition').array,
      normal: g.getAttribute('iNormal').array,
      tangent: g.getAttribute('iTangent').array,
      meta,
    });
    if (!data) continue;
    g.setAttribute('iRiver', new InstancedBufferAttribute(data, 4));
    chunks++;
    bytes += data.byteLength;
    for (let i = 0; i < chunk.count; i++) if (meta[i * 4 + 1] === STROKE_LAYER.sky) strokes++;
  }
  return { chunks, strokes, bytes };
}

export async function build(deps: WorldDeps): Promise<WorldHandle> {
  if (built) throw new Error('the Starry Night world is already built; dispose it first');
  const seed = deps.seed ?? DEFAULT_WORLD_SEED;
  const debug = deps.debug ?? null;
  const { run } = buildSteps(deps.slicer);
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
  // The river arms' per-instance rotation (iRiver), baked from each chunk's own arrays before the
  // chunks first draw, so no VAO is set up without it.
  const riverField = await run(buildSkyRiverFieldSteps(flow), 'river-field');
  const river = await run(addSkyRiverSteps(batch, riverField), 'river');
  const rivered = performance.now();
  // The dome and its moon and stars sit 120 m out (SKY_DOME_RADIUS), and no locomotion brings a
  // hand near them: flight stops at 55 m and 40 m up, and the ground ends at the ridge inside the
  // dome. Every other stroke, the boundary haze included, can be pushed by a hand.
  const strokeReach = await run(
    buildStrokeReachSteps(
      chunkSources(batch.chunks.filter((c) => c.drawClass !== 'dome' && c.drawClass !== 'lights')),
    ),
    'reach',
  );
  const reached = performance.now();
  const atlasMs = batch.stats().atlasMs;
  const times: WorldBuildTimes = {
    decodeMs: decoded - start,
    generateMs: generated - decoded,
    scatterMs: scattered - generated,
    batchMs: batched - scattered - atlasMs,
    reachMs: reached - rivered,
    riverMs: rivered - batched,
    buildMs: reached - start - atlasMs,
  };

  const { scene } = deps;
  const base = await run(
    createBaseMeshesSteps(
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
  // Until `built` is set `dispose` has nothing to release, so a throw in this window undoes
  // what it added itself (a world that fails to build is never disposed by the caller).
  let made: SkyHalo | null = null;
  try {
    scene.add(base);
    batch.attach(scene);
    if (debug === 'bare') batch.group.visible = false;
    // The star and moon halos (P4.3), the world's one blended pass. The `?bare` and `?coverage`
    // sweeps count magenta pixels, which additive light would hide, so they draw without it, and
    // `?nohalo` turns it off for a cost A/B. It draws after the lights and before the cypress and
    // the world, which write no depth, so their overhang paints over it (docs/verification.md, N2).
    made = createSkyHalo(batch.orderBeforeClass('cypress'));
    made.mesh.visible = debug === null && deps.halo !== false;
    scene.add(made.mesh);
  } catch (error) {
    (made as SkyHalo | null)?.dispose();
    batch.dispose();
    scene.remove(base);
    disposeBaseMeshes(base);
    scene.background = background;
    throw error;
  }
  const halo = made as SkyHalo | null;
  if (!halo) throw new Error('the sky halo was not made');
  built = { scene, batch, halo, base, background };

  const cache = bypass ? 'bypass' : load.hit ? 'hit' : 'miss';
  // Read out here so the closure does not hold the stroke buffers (about 19 MB) past the upload.
  const total = buffers.count;
  worldDiag = registerDiag('world', () => ({
    painting: PAINTING_ID,
    seed,
    debug,
    counts,
    lightRankTies,
    total,
    times,
    cache,
    strokes: batch.stats(),
    reach: strokeReach.stats,
    river,
  }));
  registerDiag('halo', () => ({ visible: halo.mesh.visible, halos: halo.state() }));
  const { heightAt, normalAt } = world.terrain;
  const blocked = createFootprintTest(world.village);
  const volumes = createVolumes(world.village);
  const treeBlocked = createCrownTest(world.cypress, heightAt);
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
    volumes,
    treeBlocked,
    setHaze,
    setHalo,
    halo: halo.mesh,
    strokeReach,
  };
}

/** Nothing animates yet (P4). */
export function update(_time: number, _dt: number): void {}

export function dispose(): void {
  if (!built) return;
  if (worldDiag) unregisterDiag('world', worldDiag);
  worldDiag = null;
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
