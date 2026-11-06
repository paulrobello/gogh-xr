import type { Frustum, Sphere, Vector3 } from 'three';
import type { Vec3 } from './frame';
import { type StrokeBuffers, selectStrokes } from './instance';

/** Default spatial grid cell edge, in metres. */
export const DEFAULT_CELL_SIZE = 4;

export interface StrokeBounds {
  readonly center: Vec3;
  readonly radius: number;
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
  if (buffers.count === 0) return { center: [0, 0, 0], radius: 0 };
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
  let farthest = 0;
  let halfDiagonal = 0;
  for (let i = 0; i < buffers.count; i++) {
    const d = Math.hypot(p[i * 3] - center[0], p[i * 3 + 1] - center[1], p[i * 3 + 2] - center[2]);
    if (d > farthest) farthest = d;
    const h = Math.hypot(buffers.size[i * 2], buffers.size[i * 2 + 1]) / 2;
    if (h > halfDiagonal) halfDiagonal = h;
  }
  return { center, radius: farthest + halfDiagonal };
}

/**
 * Splits strokes into chunks by a cubic grid of `cellSize` metres. Chunks come out in ascending
 * (x, y, z) cell order and each keeps its strokes in input order, so a caller's within-chunk
 * ordering (P1.4 importance) survives partitioning.
 */
export function partitionStrokes(
  buffers: StrokeBuffers,
  cellSize: number = DEFAULT_CELL_SIZE,
): StrokeChunkData[] {
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
    throw new RangeError(`cell size ${cellSize} must be a positive number`);
  }
  const cells = new Map<string, { cell: Vec3; indices: number[] }>();
  const p = buffers.position;
  for (let i = 0; i < buffers.count; i++) {
    const cell: Vec3 = [
      Math.floor(p[i * 3] / cellSize),
      Math.floor(p[i * 3 + 1] / cellSize),
      Math.floor(p[i * 3 + 2] / cellSize),
    ];
    const key = cell.join(',');
    let entry = cells.get(key);
    if (!entry) {
      entry = { cell, indices: [] };
      cells.set(key, entry);
    }
    entry.indices.push(i);
  }
  return [...cells.values()]
    .sort((a, b) => a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1] || a.cell[2] - b.cell[2])
    .map(({ cell, indices }) => {
      const chunk = selectStrokes(buffers, indices);
      return {
        cell,
        buffers: chunk,
        sourceIndices: Uint32Array.from(indices),
        bounds: computeBounds(chunk),
      };
    });
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
