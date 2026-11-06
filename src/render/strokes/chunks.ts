import type { Frustum, Sphere, Vector3 } from 'three';
import type { Vec3 } from './frame';
import { type StrokeBuffers, selectStrokes } from './instance';

/** Default spatial grid cell edge, in metres. */
export const DEFAULT_CELL_SIZE = 4;

export interface StrokeBounds {
  readonly center: Vec3;
  /** `reach + halfDiagonal`: contains every quad corner at stroke-size multiplier 1. */
  readonly radius: number;
  /** Farthest stroke position from the centre. */
  readonly reach: number;
  /** Largest quad half-diagonal. Scale it by the size multiplier to bound enlarged strokes. */
  readonly halfDiagonal: number;
}

export interface StrokeChunkData {
  /** Integer grid cell (floor(position / cellSize)). */
  readonly cell: Vec3;
  readonly buffers: StrokeBuffers;
  /** Index of each chunk instance in the source buffers, ascending. */
  readonly sourceIndices: Uint32Array;
  readonly bounds: StrokeBounds;
}

/**
 * Bounding sphere of a set of strokes: the centre of their positions' bounding box, and a radius
 * reaching the farthest position plus the largest quad half-diagonal, so every corner is inside
 * whatever its orientation.
 */
export function computeBounds(buffers: StrokeBuffers): StrokeBounds {
  if (buffers.count === 0) return { center: [0, 0, 0], radius: 0, reach: 0, halfDiagonal: 0 };
  const p = buffers.position;
  const min = [p[0], p[1], p[2]];
  const max = [p[0], p[1], p[2]];
  for (let i = 0; i < buffers.count; i++) {
    for (let k = 0; k < 3; k++) {
      const value = p[i * 3 + k];
      if (value < min[k]) min[k] = value;
      if (value > max[k]) max[k] = value;
    }
  }
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let reach = 0;
  let halfDiagonal = 0;
  for (let i = 0; i < buffers.count; i++) {
    const d = Math.hypot(p[i * 3] - center[0], p[i * 3 + 1] - center[1], p[i * 3 + 2] - center[2]);
    if (d > reach) reach = d;
    const h = Math.hypot(buffers.size[i * 2], buffers.size[i * 2 + 1]) / 2;
    if (h > halfDiagonal) halfDiagonal = h;
  }
  return { center, radius: reach + halfDiagonal, reach, halfDiagonal };
}

/** Strokes grouped by grid cell, as flat typed arrays. */
export interface StrokePartition {
  /** Integer cell per chunk, xyz triples, in ascending (x, y, z) order. */
  readonly cells: Int32Array;
  /** Chunk `c` owns `order[offsets[c] .. offsets[c + 1])`; `chunks + 1` entries. */
  readonly offsets: Uint32Array;
  /** Source stroke indices grouped by chunk, ascending (input order) within each. */
  readonly order: Uint32Array;
}

/** Cell coordinates must fit in [-2^16, 2^16) so three of them pack into one exact double. */
const CELL_RANGE = 1 << 16;
const CELL_SPAN = CELL_RANGE * 2;

/**
 * Groups strokes by a cubic grid of `cellSize` metres without per-stroke allocation: a numeric
 * cell key (three 17-bit fields in one double) maps to a chunk slot, then a count-then-fill pass
 * writes stroke indices into one Uint32Array. Throws RangeError on a non-finite position or a cell
 * beyond +-65536 cells from the origin.
 */
export function partitionIndices(
  buffers: StrokeBuffers,
  cellSize: number = DEFAULT_CELL_SIZE,
): StrokePartition {
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
    throw new RangeError(`cell size ${cellSize} must be a positive number`);
  }
  const p = buffers.position;
  const n = buffers.count;
  const slotOf = new Uint32Array(n);
  const slots = new Map<number, number>();
  const keys: number[] = [];
  const counts: number[] = [];
  let lastKey = Number.NaN;
  let lastSlot = 0;
  for (let i = 0; i < n; i++) {
    let key = 0;
    for (let k = 0; k < 3; k++) {
      const cell = Math.floor(p[i * 3 + k] / cellSize);
      if (!(cell >= -CELL_RANGE && cell < CELL_RANGE)) {
        throw new RangeError(`stroke ${i} position ${p[i * 3 + k]} is outside the chunk grid`);
      }
      key = key * CELL_SPAN + (cell + CELL_RANGE);
    }
    if (key !== lastKey) {
      let slot = slots.get(key);
      if (slot === undefined) {
        slot = keys.length;
        slots.set(key, slot);
        keys.push(key);
        counts.push(0);
      }
      lastKey = key;
      lastSlot = slot;
    }
    slotOf[i] = lastSlot;
    counts[lastSlot]++;
  }

  // The key orders cells by (x, y, z), as each field is offset to be non-negative.
  const sorted = keys.map((_, slot) => slot).sort((a, b) => keys[a] - keys[b]);
  const chunkOfSlot = new Uint32Array(keys.length);
  const cells = new Int32Array(keys.length * 3);
  const offsets = new Uint32Array(keys.length + 1);
  sorted.forEach((slot, c) => {
    chunkOfSlot[slot] = c;
    let key = keys[slot];
    for (let k = 2; k >= 0; k--) {
      const field = key % CELL_SPAN;
      cells[c * 3 + k] = field - CELL_RANGE;
      key = (key - field) / CELL_SPAN;
    }
    offsets[c + 1] = offsets[c] + counts[slot];
  });
  const cursor = offsets.slice(0, keys.length);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[cursor[chunkOfSlot[slotOf[i]]]++] = i;
  return { cells, offsets, order };
}

/**
 * Splits strokes into chunks by a cubic grid of `cellSize` metres. Chunks come out in ascending
 * (x, y, z) cell order and each keeps its strokes in input order. The batch reorders each chunk by
 * importance itself, from `partitionIndices`.
 */
export function partitionStrokes(
  buffers: StrokeBuffers,
  cellSize: number = DEFAULT_CELL_SIZE,
): StrokeChunkData[] {
  const { cells, offsets, order } = partitionIndices(buffers, cellSize);
  const chunks: StrokeChunkData[] = [];
  for (let c = 0; c + 1 < offsets.length; c++) {
    const sourceIndices = order.slice(offsets[c], offsets[c + 1]);
    const chunk = selectStrokes(buffers, sourceIndices);
    chunks.push({
      cell: [cells[c * 3], cells[c * 3 + 1], cells[c * 3 + 2]],
      buffers: chunk,
      sourceIndices,
      bounds: computeBounds(chunk),
    });
  }
  return chunks;
}

/**
 * Indices of the spheres that intersect `frustum`, nearest centre first, ties by index. Opaque
 * front-to-back order lets the depth test reject hidden strokes before shading.
 */
export function cullAndSort(spheres: readonly Sphere[], frustum: Frustum, eye: Vector3): number[] {
  const kept: { index: number; distance: number }[] = [];
  spheres.forEach((sphere, index) => {
    if (frustum.intersectsSphere(sphere)) {
      kept.push({ index, distance: sphere.center.distanceToSquared(eye) });
    }
  });
  kept.sort((a, b) => a.distance - b.distance || a.index - b.index);
  return kept.map((entry) => entry.index);
}
