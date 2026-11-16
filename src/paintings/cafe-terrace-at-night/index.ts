import { Color, type Scene, type Texture } from 'three';
import type { Raster } from '../../demo/canvas/field';
import { type DiagToken, registerDiag, unregisterDiag } from '../../diag/diag';
import { createStrokeBatchSteps, type StrokeBatch } from '../../render/strokes/batch';
import type { Vec3 } from '../../render/strokes/frame';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  type StrokeBuffers,
} from '../../render/strokes/instance';
import { mulberry32 } from '../../util/prng';
import type { Steps } from '../../util/slicer';
import {
  buildSteps,
  type PainterCamera,
  type WorldDeps,
  type WorldHandle,
  type WorldPose,
} from '../world-module';
import {
  CANVAS_ASPECT,
  CANVAS_FOV_Y_DEG,
  CANVAS_PITCH,
  CANVAS_YAW,
  PAINTER_EYE,
  toCanvas,
} from './canvas';
import { facadeX, groundHeight, WALK_BOUNDS } from './layout';
import { disposeScanTexture, loadScanTexture, scanSampler } from './scan';
import { buildCafeScene, type CafeScene } from './scene';
import { outsideStreet, streetVolumes } from './street';

const ID = 'cafe-terrace-at-night';
/** The scan at its source size, 1280 × 1596, for the paint. */
const WORLD_SCAN = `paintings/${ID}/world.webp`;
/** The gallery's frame of the same scan, for the pixels the build reads. */
const FRAME_SCAN = `paintings/${ID}/frame.webp`;
/** Shows past the sky dome only if the dome fails to draw. */
const NIGHT = 0x143a78;
const UP: Vec3 = [0, 1, 0];
const DABS = 2400;

interface Built {
  readonly scene: Scene;
  readonly background: Scene['background'];
  readonly cafe: CafeScene;
  readonly scan: Texture;
  readonly batch: StrokeBatch;
  readonly diag: DiagToken;
}

let built: Built | null = null;

/**
 * Raised dabs on the cobbles, each in the scan's own colour where it lies. They are also the paint
 * the portal gathers when leaving the street.
 */
function* pavement(seed: number, raster: Raster): Steps<StrokeBuffers> {
  const random = mulberry32(seed);
  const sample = scanSampler(raster);
  const buffers = createStrokeBuffers(DABS);
  const { minZ, maxZ, maxX } = WALK_BOUNDS;
  for (let i = 0; i < buffers.count; i++) {
    const z = maxZ - 4 - random() * (maxZ - 4 - minZ);
    const left = facadeX(z) + 0.3;
    const x = left + random() * (maxX - left);
    const { u, v } = toCanvas([x, 0, z]);
    const [r, g, b] = sample(u, v);
    packInstance(buffers, i, {
      position: [x, 0.004, z],
      normal: UP,
      tangent: random() * 1.4 - 0.7,
      color: [Math.min(255, r * 1.08), Math.min(255, g * 1.08), Math.min(255, b * 1.08), 255],
      size: [0.1 + random() * 0.12, 0.02 + random() * 0.04],
      brush: i % 8,
      layer: STROKE_LAYER.ground,
      phase: 0,
    });
    if (i % 400 === 399) yield;
  }
  return buffers;
}

export async function build(deps: WorldDeps): Promise<WorldHandle> {
  if (built) throw new Error('Dispose Café Terrace before building it again');
  const { scene } = deps;
  const seed = deps.seed ?? 1;
  const { run } = buildSteps(deps.slicer);
  const base = import.meta.env.BASE_URL;
  const painted = loadScanTexture(`${base}${WORLD_SCAN}`, Math.min(8, deps.maxAnisotropy ?? 1));
  let raster: Raster;
  try {
    raster = await deps.loadRaster(`${base}${FRAME_SCAN}`, false);
  } catch (error) {
    void painted.then(disposeScanTexture, () => {});
    throw error;
  }
  const scan = await painted;
  let cafe: CafeScene | undefined;
  let batch: StrokeBatch | undefined;
  const background = scene.background;
  try {
    const set = await run(buildCafeScene(seed, scan, raster), 'cafe-scene');
    cafe = set;
    const buffers = await run(pavement(seed, raster), 'cafe-pavement');
    const paint = await run(
      createStrokeBatchSteps(buffers, { atlas: deps.atlas, cellSize: 6 }),
      'cafe-batch',
    );
    batch = paint;
    const volumes = streetVolumes(set.solids);
    scene.background = new Color(NIGHT);
    scene.add(set.root);
    paint.attach(scene);
    const diag = registerDiag('world', () => ({
      painting: ID,
      seed,
      counts: set.counts,
      strokes: paint.stats(),
    }));
    built = { scene, background, cafe: set, scan, batch: paint, diag };
    return {
      batch: paint,
      ground: { heightAt: groundHeight, normalAt: () => UP },
      boundaryFactor: ([x, , z]) => (outsideStreet(x, z) ? 1 : 0),
      blocked: (x, z) => outsideStreet(x, z) || volumes.at(x, 0, z) >= 0,
      volumes,
      walkBounds: WALK_BOUNDS,
      textures: [scan],
    };
  } catch (error) {
    batch?.dispose();
    cafe?.dispose();
    disposeScanTexture(scan);
    scene.background = background;
    throw error;
  }
}

export function update(motionTime: number, _dt: number): void {
  built?.cafe.animate(motionTime);
}

export function dispose(): void {
  if (!built) return;
  const { batch, cafe, scan, scene, background, diag } = built;
  built = null;
  unregisterDiag('world', diag);
  batch.dispose();
  cafe.dispose();
  disposeScanTexture(scan);
  scene.background = background;
}

export function painterSpot(): WorldPose {
  return { position: [PAINTER_EYE[0], 0, PAINTER_EYE[2]], yaw: CANVAS_YAW };
}

export function spawnPose(): WorldPose {
  return painterSpot();
}

export function painterCamera(): PainterCamera {
  return {
    eye: [...PAINTER_EYE],
    yaw: CANVAS_YAW,
    pitch: CANVAS_PITCH,
    fovYDeg: CANVAS_FOV_Y_DEG,
    aspect: CANVAS_ASPECT,
  };
}
