/**
 * Flat-shaded triangle soup for the village: house walls, pitched roofs, window quads and the
 * church. Pure geometry: no materials, no scene objects. Every face is wound counter-clockwise seen
 * from its outward side, and its normal is that face's exact unit normal.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import type { WorldLayer } from '../paintings/starry-night/canvas-camera';
import type { Vec3 } from '../render/strokes/frame';

/** Accumulates non-indexed triangles with per-vertex face normals. */
export interface MeshBuilder {
  readonly positions: number[];
  readonly normals: number[];
}

export const createMeshBuilder = (): MeshBuilder => ({ positions: [], normals: [] });

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Appends triangle (a, b, c), flipped if needed so its normal points along `outward`. `outward`
 * only picks the side; it need not be exact or unit length.
 */
export function pushTriangle(m: MeshBuilder, a: Vec3, b: Vec3, c: Vec3, outward: Vec3): void {
  let n = cross(sub(b, a), sub(c, a));
  const p = a;
  let q = b;
  let r = c;
  if (dot(n, outward) < 0) {
    [q, r] = [c, b];
    n = [-n[0], -n[1], -n[2]];
  }
  const len = Math.hypot(n[0], n[1], n[2]);
  for (const v of [p, q, r]) {
    m.positions.push(v[0], v[1], v[2]);
    m.normals.push(n[0] / len, n[1] / len, n[2] / len);
  }
}

/** Appends planar quad a-b-c-d (in perimeter order) as two triangles facing `outward`. */
export function pushQuad(m: MeshBuilder, a: Vec3, b: Vec3, c: Vec3, d: Vec3, outward: Vec3): void {
  pushTriangle(m, a, b, c, outward);
  pushTriangle(m, a, c, d, outward);
}

/** Packs the builder into a BufferGeometry tagged with `layer` in `userData.layer`. */
export function toGeometry(m: MeshBuilder, layer: WorldLayer): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(m.positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(m.normals), 3));
  g.userData.layer = layer;
  return g;
}

/**
 * A yaw-rotated local frame: local x along the ridge, local z across it, local y up from `base`.
 * Matches three.js `rotation.y = yaw`: world x = cx + lx·cos + lz·sin, world z = cz − lx·sin + lz·cos.
 */
export interface LocalFrame {
  readonly cx: number;
  readonly cz: number;
  readonly base: number;
  readonly yaw: number;
}

export function toWorld(f: LocalFrame, lx: number, ly: number, lz: number): Vec3 {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  return [f.cx + lx * c + lz * s, f.base + ly, f.cz - lx * s + lz * c];
}

/** World direction of a local horizontal direction (lx, lz). */
export function toWorldDir(f: LocalFrame, lx: number, ly: number, lz: number): Vec3 {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  return [lx * c + lz * s, ly, -lx * s + lz * c];
}

export interface GableBox {
  /** Along local x (the ridge axis), metres. */
  readonly width: number;
  /** Along local z, metres. */
  readonly depth: number;
  /** Wall top above the base, metres. */
  readonly eave: number;
  /** Ridge above the eave, metres. */
  readonly rise: number;
  /** Roof overhang past the walls on every side, metres. */
  readonly overhang: number;
}

/**
 * Walls of a gable-roofed box from the base to the eaves, with the two gable triangles on the
 * local ±x ends. No floor: the base is sunk to the lowest corner of the ground, so it sits below it.
 */
export function pushGableWalls(m: MeshBuilder, f: LocalFrame, b: GableBox): void {
  const hw = b.width / 2;
  const hd = b.depth / 2;
  const P = (lx: number, ly: number, lz: number): Vec3 => toWorld(f, lx, ly, lz);
  const D = (lx: number, lz: number): Vec3 => toWorldDir(f, lx, 0, lz);
  pushQuad(m, P(-hw, 0, hd), P(hw, 0, hd), P(hw, b.eave, hd), P(-hw, b.eave, hd), D(0, 1));
  pushQuad(m, P(hw, 0, -hd), P(-hw, 0, -hd), P(-hw, b.eave, -hd), P(hw, b.eave, -hd), D(0, -1));
  pushQuad(m, P(hw, 0, hd), P(hw, 0, -hd), P(hw, b.eave, -hd), P(hw, b.eave, hd), D(1, 0));
  pushQuad(m, P(-hw, 0, -hd), P(-hw, 0, hd), P(-hw, b.eave, hd), P(-hw, b.eave, -hd), D(-1, 0));
  const ridge = b.eave + b.rise;
  pushTriangle(m, P(hw, b.eave, hd), P(hw, b.eave, -hd), P(hw, ridge, 0), D(1, 0));
  pushTriangle(m, P(-hw, b.eave, -hd), P(-hw, b.eave, hd), P(-hw, ridge, 0), D(-1, 0));
}

/** The two roof slopes, ridge along local x, overhanging the walls and dropping along their pitch. */
export function pushGableRoof(m: MeshBuilder, f: LocalFrame, b: GableBox): void {
  const hw = b.width / 2 + b.overhang;
  const hd = b.depth / 2 + b.overhang;
  const ridge = b.eave + b.rise;
  const drop = (b.overhang * b.rise) / (b.depth / 2);
  const low = b.eave - drop;
  const P = (lx: number, ly: number, lz: number): Vec3 => toWorld(f, lx, ly, lz);
  for (const side of [1, -1] as const) {
    pushQuad(
      m,
      P(-hw, low, side * hd),
      P(hw, low, side * hd),
      P(hw, ridge, 0),
      P(-hw, ridge, 0),
      toWorldDir(f, 0, 1, side),
    );
  }
}

/** A square tower from the base to `top`, then a four-sided spire to `tip`. Axis-aligned. */
export function pushSteeple(
  m: MeshBuilder,
  f: LocalFrame,
  halfWidth: number,
  top: number,
  tip: number,
): void {
  const h = halfWidth;
  const P = (lx: number, ly: number, lz: number): Vec3 => toWorld(f, lx, ly, lz);
  const D = (lx: number, ly: number, lz: number): Vec3 => toWorldDir(f, lx, ly, lz);
  const ring: readonly [number, number][] = [
    [-h, h],
    [h, h],
    [h, -h],
    [-h, -h],
  ];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = ring[i] as [number, number];
    const [bx, bz] = ring[(i + 1) % 4] as [number, number];
    const out = D((ax + bx) / 2, 0, (az + bz) / 2);
    pushQuad(m, P(ax, 0, az), P(bx, 0, bz), P(bx, top, bz), P(ax, top, az), out);
    pushTriangle(
      m,
      P(ax, top, az),
      P(bx, top, bz),
      P(0, tip, 0),
      D((ax + bx) / 2, h, (az + bz) / 2),
    );
  }
}
