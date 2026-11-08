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

/** A gable box standing in its local frame: a house, or the church nave. */
export interface GableRoof {
  readonly frame: LocalFrame;
  readonly box: GableBox;
}

/** A gable roof's outline in its local frame. */
export interface GableRoofLines {
  /** Half extent along local x: the walls plus the overhang. */
  readonly hw: number;
  /** Half extent along local z: the walls plus the overhang. */
  readonly hd: number;
  /** Ridge above the base. */
  readonly ridge: number;
  /** The overhang's outer edge above the base: the eave less the pitch's drop over the overhang. */
  readonly low: number;
}

export function gableRoofLines(b: GableBox): GableRoofLines {
  const drop = (b.overhang * b.rise) / (b.depth / 2);
  return {
    hw: b.width / 2 + b.overhang,
    hd: b.depth / 2 + b.overhang,
    ridge: b.eave + b.rise,
    low: b.eave - drop,
  };
}

/** World unit normal of the slope on local side `side` (+1 faces local +z): up and outward. */
export function gableSlopeNormal(f: LocalFrame, b: GableBox, side: 1 | -1): Vec3 {
  const len = Math.hypot(b.depth / 2, b.rise);
  return toWorldDir(f, 0, b.depth / 2 / len, (side * b.rise) / len);
}

/** The two roof slopes, ridge along local x, overhanging the walls and dropping along their pitch. */
export function pushGableRoof(m: MeshBuilder, f: LocalFrame, b: GableBox): void {
  const { hw, hd, ridge, low } = gableRoofLines(b);
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

/**
 * The underside of each slope's overhang band, the part past the wall line, facing down: the eave
 * strip along the full width, and the two rake strips past the gable walls, from the eave line to
 * the ridge. Three quads in each slope's plane. An eye outside the house sees no other part of the
 * underside, because the walls and gables hide it.
 */
export function pushGableSoffit(m: MeshBuilder, f: LocalFrame, b: GableBox): void {
  const { hw, hd, ridge, low } = gableRoofLines(b);
  const w = b.width / 2;
  const z = b.depth / 2;
  const P = (lx: number, ly: number, lz: number): Vec3 => toWorld(f, lx, ly, lz);
  for (const side of [1, -1] as const) {
    const n = gableSlopeNormal(f, b, side);
    const down: Vec3 = [-n[0], -n[1], -n[2]];
    const wall = side * z;
    const edge = side * hd;
    pushQuad(
      m,
      P(-hw, b.eave, wall),
      P(hw, b.eave, wall),
      P(hw, low, edge),
      P(-hw, low, edge),
      down,
    );
    for (const end of [1, -1] as const) {
      const a = end * w;
      const o = end * hw;
      pushQuad(m, P(a, ridge, 0), P(o, ridge, 0), P(o, b.eave, wall), P(a, b.eave, wall), down);
    }
  }
}

/**
 * Whether a footprint centred at local (lx, lz), reaching `ex` either way along local x and `ez`
 * along local z, crosses the wall line onto the overhang band: the only part of a roof's underside
 * that an eye outside the house can see.
 */
export function reachesOverhang(
  b: GableBox,
  lx: number,
  lz: number,
  ex: number,
  ez: number,
): boolean {
  return Math.abs(lx) + ex > b.width / 2 || Math.abs(lz) + ez > b.depth / 2;
}

/** Local coordinates of world point `p`: the inverse of `toWorld`. */
export function toLocal(f: LocalFrame, p: Vec3): Vec3 {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  const dx = p[0] - f.cx;
  const dz = p[2] - f.cz;
  return [dx * c - dz * s, p[1] - f.base, dx * s + dz * c];
}

/** Local components of world direction `v`: the inverse of `toWorldDir`. */
export function toLocalDir(f: LocalFrame, v: Vec3): Vec3 {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  return [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c];
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
