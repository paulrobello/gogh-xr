/**
 * `?demo=canvas`: the P1 test canvas (PRD P1-A2). Decodes the painting and its bake outputs in the
 * browser, places the strokes and attaches one stroke batch. `?noanim` freezes the motion clock
 * (src/motion/clock.ts), so every stroke sits at rest and `?shot` captures are deterministic for a
 * `?seed`.
 */
import type { Scene } from 'three';
import { registerDiag, unregisterDiag } from '../../diag/diag';
import { createStrokeBatch, type StrokeBatch } from '../../render/strokes/batch';
import { buildFlowField, type Raster } from './field';
import {
  buildCanvasStrokes,
  CANVAS_CELL_SIZE,
  CANVAS_STROKE_TARGET,
  DEFAULT_CANVAS_SEED,
} from './placement';

const PAINTING_DIR = `${import.meta.env.BASE_URL}paintings/starry-night/`;

/**
 * Fetches and decodes an image to RGBA8 at its natural size. Data images skip colour-space
 * conversion so the encoded angles and region ids arrive as written.
 */
export async function loadRaster(url: string, data: boolean): Promise<Raster> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: data ? 'none' : 'default',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D canvas context is not available');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { width, height, data: pixels } = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width, height, data: pixels };
}

export interface CanvasDemoDeps {
  scene: Scene;
  /** `?seed`; null means `DEFAULT_CANVAS_SEED`. */
  seed: number | null;
  /** `&count`, the stroke target; null means `CANVAS_STROKE_TARGET`. */
  count: number | null;
}

/** Wall times of the build stages, ms. GPU upload happens at the first render and is not timed. */
export interface CanvasBuildTimes {
  /** Fetch and decode of the three images, plus the flow-field smoothing. */
  decodeMs: number;
  /** Stroke placement into instance buffers. */
  placeMs: number;
  /** Chunk partition, importance order and geometry setup in `createStrokeBatch`, atlas excluded. */
  batchMs: number;
  /** decode + place + batch. */
  buildMs: number;
}

export interface CanvasDemoHandle {
  readonly batch: StrokeBatch;
  readonly times: CanvasBuildTimes;
  dispose(): void;
}

/** Builds the canvas, adds it to `scene` and registers the `canvas` diag key. */
export async function startCanvasDemo(deps: CanvasDemoDeps): Promise<CanvasDemoHandle> {
  const seed = deps.seed ?? DEFAULT_CANVAS_SEED;
  const start = performance.now();
  const [color, flow, regions] = await Promise.all([
    loadRaster(`${PAINTING_DIR}frame.webp`, false),
    loadRaster(`${PAINTING_DIR}flow.png`, true),
    loadRaster(`${PAINTING_DIR}regions.png`, true),
  ]);
  const field = buildFlowField(flow);
  const decoded = performance.now();
  const target = deps.count ?? CANVAS_STROKE_TARGET;
  const buffers = buildCanvasStrokes({ color, flow: field, regions }, { seed, target });
  const placed = performance.now();
  // Its regions lie LAYER_STEP apart along the normal and never tie, so depth keeps them in order.
  const batch = createStrokeBatch(buffers, { cellSize: CANVAS_CELL_SIZE, depthWrite: true });
  const batched = performance.now();
  const atlasMs = batch.stats().atlasMs;
  const times: CanvasBuildTimes = {
    decodeMs: decoded - start,
    placeMs: placed - decoded,
    batchMs: batched - placed - atlasMs,
    buildMs: batched - start - atlasMs,
  };
  batch.attach(deps.scene);
  // The provider lives as long as the demo; reading the count off `buffers` would keep every
  // source buffer alive with it, though the batch holds its own per-chunk copies.
  const count = buffers.count;
  registerDiag('canvas', () => ({ seed, count, ...times, strokes: batch.stats() }));
  return {
    batch,
    times,
    dispose() {
      unregisterDiag('canvas');
      batch.dispose();
    },
  };
}
