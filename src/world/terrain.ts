/**
 * The hill the viewer stands on and the distant ridge behind the valley. Pure geometry and math:
 * no materials, no scene objects, so it runs in unit tests without WebGL.
 *
 * World: metres, +Y up, the painter's spot at the origin facing −Z. The ground is a 128 × 128
 * vertex grid over 120 m × 120 m centred on the spot. Every cell is split along its b–c diagonal
 * into the triangles (a, c, b) and (b, c, d), and `heightAt` interpolates over those same
 * triangles, so it equals the mesh surface everywhere inside the grid.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { PAINTER_SPOT, type WorldLayer } from '../paintings/starry-night/canvas-camera';
import type { Vec3 } from '../render/strokes/frame';
import { drain, type Steps } from '../util/slicer';
import { createValueNoise2D, fbm2 } from './noise';

/** Vertices per side of the ground grid. */
export const TERRAIN_GRID: number = 128;
/** Side length of the ground grid, metres. */
export const TERRAIN_SIZE: number = 120;
/** Spacing between neighbouring grid vertices, metres. */
export const TERRAIN_CELL: number = TERRAIN_SIZE / (TERRAIN_GRID - 1);
/** Radius around the spot inside which no ground may rise above the spot, metres. */
export const SPOT_CLEAR_RADIUS: number = 8;
/** Layer tag both meshes carry in `geometry.userData.layer`, read by the stroke scatter. */
export const TERRAIN_LAYER: WorldLayer = 'terrain';
/** Ground height at the spot; the field is pinned to it. */
export const SPOT_HEIGHT: number = PAINTER_SPOT[1];

/** Ridge distance band from the spot, metres. */
export const RIDGE_RADIUS: Readonly<{ min: number; max: number }> = Object.freeze({
  min: 70,
  max: 110,
});

const RIDGE_COLUMNS = 28;
/** Ridge arc in degrees from −Z toward +X (ahead and to the right). */
const RIDGE_ARC_DEG: readonly [number, number] = Object.freeze([-45, 80]) as readonly [
  number,
  number,
];
/**
 * Ridge foot. Deep enough that the terrain skyline hides it from any eye at or above the spot,
 * including a raised eye behind it; the seam test in tests/world-terrain.test.ts enforces this.
 */
export const RIDGE_FOOT_Y: number = -40;

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export interface Terrain {
  readonly seed: number;
  /** Ground grid with position, normal and index attributes. `userData.layer` is `'terrain'`. */
  readonly geometry: BufferGeometry;
  /** Distant ridge backdrop, outside `heightAt`. `userData.layer` is `'terrain'`. */
  readonly ridge: BufferGeometry;
  /**
   * Ground height at (x, z), following the mesh triangles. Outside the grid the coordinates clamp
   * to its edge. `heightAt(0, 0)` is exactly 0.
   */
  readonly heightAt: (x: number, z: number) => number;
  /** Exact unit upward face normal of the mesh triangle `heightAt` interpolates at (x, z). */
  readonly normalAt: (x: number, z: number) => Vec3;
}

/**
 * Continuous height field. A hill drops off a flat top (radius 1.5 m, so the four vertices around
 * the origin are exactly 0) into a bowl. Ahead (−Z) it settles onto a shallow terrace about 4–6 m
 * below the spot across the 15–40 m village band, shoaling toward the right, then rises toward the
 * ridge. The terrace depth is set by the painter's framing: from the eye, houses 4–8 m tall
 * standing on it must reach the painted village roofline, which lies 1–2° below level and rises
 * toward the right.
 * Ground rises behind and to the sides beyond 10 m. fBm noise fades in from 2 m out, and the
 * hill's drop outgrows it, so the spot stays the maximum within `SPOT_CLEAR_RADIUS`.
 */
function makeField(seed: number): (x: number, z: number) => number {
  const noise = createValueNoise2D(seed);
  return (x, z) => {
    const r = Math.hypot(x, z);
    const ahead = Math.max(0, -z);
    const hill = -5 * smoothstep(1.5, 12, r);
    // The terrace shoals to half depth toward the right, where the painted roofline rises.
    const terrace =
      (2 * smoothstep(4, 24, ahead) + 2 * smoothstep(20, 45, ahead)) *
      (1 - 0.5 * smoothstep(0, 30, x));
    const valley = -terrace + 2 * smoothstep(45, 60, ahead);
    const rim = 16 * smoothstep(10, 60, r) * (1 - 0.7 * smoothstep(0, 25, ahead));
    const rough = 3.2 * smoothstep(2, 14, r) * fbm2(noise, x / 28, z / 28, 4);
    // "+ 0" folds a -0 into 0 so the spot also compares equal under Object.is.
    return hill + valley + rim + rough + 0;
  };
}

/** Grid rows of the ground's height and normal passes between two yields of `createTerrainSteps`. */
const TERRAIN_SLICE_ROWS = 16;

function* buildGroundSteps(field: (x: number, z: number) => number): Steps<{
  geometry: BufferGeometry;
  heights: Float64Array;
}> {
  const n = TERRAIN_GRID;
  const half = TERRAIN_SIZE / 2;
  const heights = new Float64Array(n * n);
  const positions = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    if (j > 0 && j % TERRAIN_SLICE_ROWS === 0) yield;
    for (let i = 0; i < n; i++) {
      const x = -half + i * TERRAIN_CELL;
      const z = -half + j * TERRAIN_CELL;
      const h = field(x, z);
      const k = j * n + i;
      heights[k] = h;
      positions[k * 3] = x;
      positions[k * 3 + 1] = h;
      positions[k * 3 + 2] = z;
    }
  }
  yield;
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let w = 0;
  for (let j = 0; j < n - 1; j++) {
    if (j > 0 && j % TERRAIN_SLICE_ROWS === 0) yield;
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices.set([a, c, b, b, c, d], w);
      w += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return { geometry, heights };
}

function buildRidge(seed: number): BufferGeometry {
  const noise = createValueNoise2D(seed ^ 0x9e3779b9);
  const rows = 3;
  const cols = RIDGE_COLUMNS + 1;
  const positions = new Float32Array(cols * rows * 3);
  const [a0, a1] = RIDGE_ARC_DEG;
  for (let j = 0; j < cols; j++) {
    const s = j / RIDGE_COLUMNS;
    const theta = ((a0 + (a1 - a0) * s) * Math.PI) / 180;
    const radius =
      RIDGE_RADIUS.min +
      (RIDGE_RADIUS.max - RIDGE_RADIUS.min) * (0.5 + 0.5 * noise(s * 6 + 40, 3.5));
    // The hills rise toward the right edge, as in the painting.
    const crest = 9 + 20 * smoothstep(0.1, 1, s) + 5 * noise(s * 9, 11.5);
    const heights = [RIDGE_FOOT_Y, crest * 0.55, crest];
    for (let k = 0; k < rows; k++) {
      const o = (k * cols + j) * 3;
      positions[o] = radius * Math.sin(theta);
      positions[o + 1] = heights[k] as number;
      positions[o + 2] = -radius * Math.cos(theta);
    }
  }
  const indices = new Uint32Array(RIDGE_COLUMNS * (rows - 1) * 6);
  let w = 0;
  for (let k = 0; k < rows - 1; k++) {
    for (let j = 0; j < RIDGE_COLUMNS; j++) {
      const a = k * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.set([a, b, c, b, d, c], w);
      w += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.userData.layer = TERRAIN_LAYER;
  return geometry;
}

/** Builds the seeded ground mesh, the ridge backdrop, and the `heightAt` / `normalAt` queries. */
export function createTerrain(seed: number): Terrain {
  return drain(createTerrainSteps(seed));
}

/**
 * `createTerrain` as steps (P5.5): the same arithmetic in the same order, yielding every
 * TERRAIN_SLICE_ROWS grid rows of the height, index and normal passes, and before the ridge.
 */
export function* createTerrainSteps(seed: number): Steps<Terrain> {
  const { geometry, heights } = yield* buildGroundSteps(makeField(seed));
  const n = TERRAIN_GRID;
  const half = TERRAIN_SIZE / 2;

  /** The triangle of the mesh containing (x, z), clamped to the grid. */
  const locate = (x: number, z: number) => {
    const gx = Math.min(n - 1 - 1e-9, Math.max(0, (x + half) / TERRAIN_CELL));
    const gz = Math.min(n - 1 - 1e-9, Math.max(0, (z + half) / TERRAIN_CELL));
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    return {
      fx,
      fz,
      lower: fx + fz <= 1,
      a: heights[j * n + i] as number,
      b: heights[j * n + i + 1] as number,
      c: heights[(j + 1) * n + i] as number,
      d: heights[(j + 1) * n + i + 1] as number,
    };
  };

  const heightAt = (x: number, z: number): number => {
    const { fx, fz, lower, a, b, c, d } = locate(x, z);
    return lower ? a + fx * (b - a) + fz * (c - a) : d + (1 - fx) * (c - d) + (1 - fz) * (b - d);
  };

  const normalAt = (x: number, z: number): Vec3 => {
    const { lower, a, b, c, d } = locate(x, z);
    const gx = (lower ? b - a : d - c) / TERRAIN_CELL;
    const gz = (lower ? c - a : d - b) / TERRAIN_CELL;
    const len = Math.hypot(gx, 1, gz);
    return [-gx / len, 1 / len, -gz / len];
  };

  /** Central-difference normal over one cell on each side: smooth shading across triangles. */
  const smoothNormalAt = (x: number, z: number): Vec3 => {
    const e = TERRAIN_CELL;
    const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    const len = Math.hypot(gx, 1, gz);
    return [-gx / len, 1 / len, -gz / len];
  };

  yield;
  const normals = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    if (j > 0 && j % TERRAIN_SLICE_ROWS === 0) yield;
    for (let i = 0; i < n; i++) {
      normals.set(
        smoothNormalAt(-half + i * TERRAIN_CELL, -half + j * TERRAIN_CELL),
        (j * n + i) * 3,
      );
    }
  }
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.userData.layer = TERRAIN_LAYER;
  yield;

  return { seed, geometry, ridge: buildRidge(seed), heightAt, normalAt };
}
