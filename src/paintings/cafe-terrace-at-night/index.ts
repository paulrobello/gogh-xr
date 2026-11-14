import { Color, type Scene } from 'three';
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
import { buildCafeScene, CAFE_SKY, type CafeScene } from './scene';
import { outsideStreet, streetVolumes, WALK_BOUNDS } from './street';

const ID = 'cafe-terrace-at-night';
const VIEW_YAW = 0.17;
const VIEW_POSITION: Vec3 = [0.25, 0, 5.4];
const UP: Vec3 = [0, 1, 0];

interface Built {
  readonly scene: Scene;
  readonly background: Scene['background'];
  readonly cafe: CafeScene;
  readonly batch: StrokeBatch;
  readonly diag: DiagToken;
}

let built: Built | null = null;

/** Pavement highlights are also the paint the portal gathers when leaving the street. */
function* pavement(seed: number): Steps<StrokeBuffers> {
  const random = mulberry32(seed);
  const buffers = createStrokeBuffers(2400);
  for (let i = 0; i < buffers.count; i++) {
    const x = -3.2 + random() * 8;
    const z = 5.8 - random() * 24;
    const warm = x < 0.9 && z > -10 && z < 3.8;
    packInstance(buffers, i, {
      position: [x, 0.003, z],
      normal: UP,
      tangent: random() * 1.4 - 0.7,
      color: warm ? [162, 122, 64, 255] : [91, 108, 129, 255],
      size: [0.09 + random() * 0.11, 0.018 + random() * 0.036],
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
  const cafe = await run(buildCafeScene(seed), 'cafe-scene');
  let batch: StrokeBatch | undefined;
  const background = scene.background;
  try {
    const buffers = await run(pavement(seed), 'cafe-pavement');
    const paint = await run(
      createStrokeBatchSteps(buffers, { atlas: deps.atlas, cellSize: 6 }),
      'cafe-batch',
    );
    batch = paint;
    const volumes = streetVolumes(cafe.solids);
    scene.background = new Color(CAFE_SKY);
    scene.add(cafe.root);
    paint.attach(scene);
    const diag = registerDiag('world', () => ({
      painting: ID,
      seed,
      strokes: paint.stats(),
    }));
    built = { scene, background, cafe, batch: paint, diag };
    return {
      batch: paint,
      ground: { heightAt: () => 0, normalAt: () => UP },
      boundaryFactor: ([x, , z]) => (outsideStreet(x, z) ? 1 : 0),
      blocked: (x, z) => outsideStreet(x, z) || volumes.at(x, 0, z) >= 0,
      volumes,
      walkBounds: WALK_BOUNDS,
    };
  } catch (error) {
    batch?.dispose();
    cafe.dispose();
    scene.background = background;
    throw error;
  }
}

export function update(_time: number, _dt: number): void {}

export function dispose(): void {
  if (!built) return;
  const { batch, cafe, scene, background, diag } = built;
  built = null;
  unregisterDiag('world', diag);
  batch.dispose();
  cafe.dispose();
  scene.background = background;
}

export function painterSpot(): WorldPose {
  return { position: [...VIEW_POSITION], yaw: VIEW_YAW };
}

export function spawnPose(): WorldPose {
  return painterSpot();
}

export function painterCamera(): PainterCamera {
  return {
    eye: [VIEW_POSITION[0], 1.6, VIEW_POSITION[2]],
    yaw: VIEW_YAW,
    pitch: 0.08,
    fovYDeg: 69,
    aspect: 65.5 / 81,
  };
}
