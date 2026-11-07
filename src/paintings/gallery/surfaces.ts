/**
 * The gallery's painted surfaces (P5.4): every wall, the floor, the ceiling, the benches and the
 * frame mouldings as flat rectangles, the strokes that paint them and the flat base mesh under
 * them. Pure and deterministic per seed, so the unit tests count and bound the strokes without
 * WebGL.
 *
 * Strokes sit on a jittered grid per rectangle, sized so the quads cover each surface about
 * `OVERDRAW` times over, which the 25-50% brush masks need to leave no gap. Each stroke takes one
 * of its role's muted tones (palette.ts), jittered, times a light factor: no lamp and no spotlight,
 * only a soft wash on the wall around each painting, as if the canvases lit the room, with darker
 * corners, a dimmer top of the walls and a faint pool on the floor in front of each frame. So the
 * scans stay the brightest things in the room.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { canvasTangent, decodedNormal, strokeShade } from '../../demo/canvas/placement';
import { BRUSHES } from '../../render/strokes/brush-atlas-data';
import { DEPTH_RANKED_FLAG, sizeShare } from '../../render/strokes/depth-tie-break';
import type { Vec3 } from '../../render/strokes/frame';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  type StrokeBuffers,
  type StrokeLayer,
} from '../../render/strokes/instance';
import { SCATTER_DEPTH_JITTER } from '../../render/strokes/scatter';
import { mulberry32 } from '../../util/prng';
import { drain, type Steps } from '../../util/slicer';
import {
  BENCHES,
  FRAME_CENTRE_Y,
  HANGINGS,
  type Hanging,
  MOULDING_DEPTH,
  MOULDING_WIDTH,
  ROOM,
  WALLS,
  type Wall,
  type WallRect,
  wallPoint,
} from './layout';
import {
  luma,
  type Rgb,
  ROLE_TONES,
  SCAN_MEDIAN_LUMA,
  type SurfaceRole,
  underpaint,
} from './palette';

/**
 * Quad area laid per unit of surface area: the coverage the soft brush masks need to hold the
 * 0.5% bare limit. The ceiling's comma and crescent masks are the thinnest, so it takes the most.
 */
export const OVERDRAW: Readonly<Record<SurfaceRole, number>> = Object.freeze({
  wall: 8.5,
  floor: 8.5,
  ceiling: 10,
  bench: 8,
  moulding: 8,
});
/** Mean stroke length per role, metres. */
export const ROLE_LENGTH: Readonly<Record<SurfaceRole, number>> = Object.freeze({
  wall: 0.15,
  floor: 0.17,
  ceiling: 0.24,
  bench: 0.09,
  moulding: 0.07,
});
/** Stroke length varies uniformly by ± this share. */
const LENGTH_JITTER = 0.15;
/** Each stroke's tone moves by up to ± this share in brightness. */
const VALUE_JITTER = 0.09;
/** And each channel by up to ± this many sRGB levels. */
const CHANNEL_JITTER = 5;
/** Default world seed (no `?seed`). */
export const DEFAULT_GALLERY_SEED = 1;

const RIDGE = [0, 1, 2, 3];
const BRISTLE = [4, 5, 6, 7];
const DAB = [8, 9, 10];
const COMMA = [11, 12, 13];
const CRESCENT = [14, 15];

/** A flat rectangle to paint: `centre ± halfU·u ± halfV·v`, facing `normal`. */
export interface Surface {
  readonly name: string;
  readonly role: SurfaceRole;
  readonly centre: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly normal: Vec3;
  readonly halfU: number;
  readonly halfV: number;
  /** Stroke direction at local (a, b), radians from u toward v. */
  readonly angle: (a: number, b: number, rand: () => number) => number;
  readonly brushes: readonly number[];
  readonly layer: StrokeLayer;
  /** A wall's hangings: no stroke centre inside a frame or a plaque card. */
  readonly wall?: Wall;
}

const UP: Vec3 = [0, 1, 0];
const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];

function jittered(base: number, spread: number): Surface['angle'] {
  return (_a, _b, rand) => base + (2 * rand() - 1) * spread;
}

/** A slow swirl across the ceiling: a quiet echo of the Starry Night sky, in the darkest blue. */
const swirl: Surface['angle'] = (a, b, rand) =>
  Math.PI / 2 + 0.7 * Math.sin(a * 0.9 + 0.4) + 0.6 * Math.cos(b * 0.55) + (2 * rand() - 1) * 0.15;

function wallSurface(wall: Wall): Surface {
  const mid = (wall.sMin + wall.sMax) / 2;
  return {
    name: `wall-${wall.name}`,
    role: 'wall',
    centre: wallPoint(wall, mid, ROOM.height / 2),
    u: wall.right,
    v: UP,
    normal: wall.normal,
    halfU: (wall.sMax - wall.sMin) / 2,
    halfV: ROOM.height / 2,
    // Short upright dashes, as on the walls of The Bedroom.
    angle: jittered(Math.PI / 2, 0.22),
    brushes: [...BRISTLE, ...RIDGE, DAB[0]],
    layer: STROKE_LAYER.building,
    wall,
  };
}

/** The moulding of one hanging: the four front strips and the four outer sides. */
function mouldingSurfaces(h: Hanging): Surface[] {
  const { wall, scan, outer } = h;
  const w = MOULDING_WIDTH;
  const d = MOULDING_DEPTH;
  const outerHalfS = (outer.s1 - outer.s0) / 2;
  const outerHalfY = (outer.y1 - outer.y0) / 2;
  const scanHalfY = (scan.y1 - scan.y0) / 2;
  const right = wall.right;
  const along = jittered(0, 0.04);
  const base = {
    role: 'moulding' as const,
    brushes: RIDGE,
    layer: STROKE_LAYER.building,
  };
  const id = h.painting.id;
  return [
    {
      ...base,
      name: `moulding-${id}-top`,
      centre: wallPoint(wall, h.s, scan.y1 + w / 2, d),
      u: right,
      v: UP,
      normal: wall.normal,
      halfU: outerHalfS,
      halfV: w / 2,
      angle: along,
    },
    {
      ...base,
      name: `moulding-${id}-bottom`,
      centre: wallPoint(wall, h.s, scan.y0 - w / 2, d),
      u: right,
      v: UP,
      normal: wall.normal,
      halfU: outerHalfS,
      halfV: w / 2,
      angle: along,
    },
    {
      ...base,
      name: `moulding-${id}-left`,
      centre: wallPoint(wall, scan.s0 - w / 2, h.y, d),
      u: UP,
      v: right,
      normal: wall.normal,
      halfU: scanHalfY,
      halfV: w / 2,
      angle: along,
    },
    {
      ...base,
      name: `moulding-${id}-right`,
      centre: wallPoint(wall, scan.s1 + w / 2, h.y, d),
      u: UP,
      v: right,
      normal: wall.normal,
      halfU: scanHalfY,
      halfV: w / 2,
      angle: along,
    },
    {
      ...base,
      name: `moulding-${id}-top-side`,
      centre: wallPoint(wall, h.s, outer.y1, d / 2),
      u: right,
      v: wall.normal,
      normal: UP,
      halfU: outerHalfS,
      halfV: d / 2,
      angle: along,
    },
    {
      ...base,
      name: `moulding-${id}-bottom-side`,
      centre: wallPoint(wall, h.s, outer.y0, d / 2),
      u: right,
      v: wall.normal,
      normal: neg(UP),
      halfU: outerHalfS,
      halfV: d / 2,
      angle: along,
    },
    {
      ...base,
      name: `moulding-${id}-left-side`,
      centre: wallPoint(wall, outer.s0, h.y, d / 2),
      u: UP,
      v: wall.normal,
      normal: neg(right),
      halfU: outerHalfY,
      halfV: d / 2,
      angle: along,
    },
    {
      ...base,
      name: `moulding-${id}-right-side`,
      centre: wallPoint(wall, outer.s1, h.y, d / 2),
      u: UP,
      v: wall.normal,
      normal: right,
      halfU: outerHalfY,
      halfV: d / 2,
      angle: along,
    },
  ];
}

function benchSurfaces(index: number): Surface[] {
  const bench = BENCHES[index];
  const [cx, cz] = bench.centre;
  const alongX = bench.sizeX >= bench.sizeZ;
  const long: Vec3 = alongX ? [1, 0, 0] : [0, 0, 1];
  const short: Vec3 = alongX ? [0, 0, 1] : [1, 0, 0];
  const halfLong = (alongX ? bench.sizeX : bench.sizeZ) / 2;
  const halfShort = (alongX ? bench.sizeZ : bench.sizeX) / 2;
  const h = bench.height;
  const at = (l: number, s: number, y: number): Vec3 => [
    cx + long[0] * l + short[0] * s,
    y,
    cz + long[2] * l + short[2] * s,
  ];
  const base = {
    role: 'bench' as const,
    brushes: [...RIDGE, ...BRISTLE],
    layer: STROKE_LAYER.building,
    angle: jittered(0, 0.08),
  };
  return [
    {
      ...base,
      name: `bench-${index}-top`,
      centre: at(0, 0, h),
      u: long,
      v: short,
      normal: UP,
      halfU: halfLong,
      halfV: halfShort,
    },
    {
      ...base,
      name: `bench-${index}-side-a`,
      centre: at(0, halfShort, h / 2),
      u: long,
      v: UP,
      normal: short,
      halfU: halfLong,
      halfV: h / 2,
    },
    {
      ...base,
      name: `bench-${index}-side-b`,
      centre: at(0, -halfShort, h / 2),
      u: long,
      v: UP,
      normal: neg(short),
      halfU: halfLong,
      halfV: h / 2,
    },
    {
      ...base,
      name: `bench-${index}-end-a`,
      centre: at(halfLong, 0, h / 2),
      u: short,
      v: UP,
      normal: long,
      halfU: halfShort,
      halfV: h / 2,
    },
    {
      ...base,
      name: `bench-${index}-end-b`,
      centre: at(-halfLong, 0, h / 2),
      u: short,
      v: UP,
      normal: neg(long),
      halfU: halfShort,
      halfV: h / 2,
    },
  ];
}

/** Every painted rectangle in the room. */
export function gallerySurfaces(): Surface[] {
  const width = ROOM.maxX - ROOM.minX;
  const length = ROOM.maxZ - ROOM.minZ;
  const midX = (ROOM.minX + ROOM.maxX) / 2;
  const midZ = (ROOM.minZ + ROOM.maxZ) / 2;
  const surfaces: Surface[] = [
    {
      name: 'floor',
      role: 'floor',
      centre: [midX, 0, midZ],
      u: [1, 0, 0],
      v: [0, 0, 1],
      normal: UP,
      halfU: width / 2,
      halfV: length / 2,
      // Along the room's length, as boards run.
      angle: jittered(Math.PI / 2, 0.12),
      brushes: [...RIDGE, ...BRISTLE],
      layer: STROKE_LAYER.ground,
    },
    {
      name: 'ceiling',
      role: 'ceiling',
      centre: [midX, ROOM.height, midZ],
      u: [1, 0, 0],
      v: [0, 0, -1],
      normal: neg(UP),
      halfU: width / 2,
      halfV: length / 2,
      angle: swirl,
      brushes: [...COMMA, ...CRESCENT, ...RIDGE],
      layer: STROKE_LAYER.building,
    },
    ...Object.values(WALLS).map(wallSurface),
  ];
  for (const h of HANGINGS) surfaces.push(...mouldingSurfaces(h));
  for (let i = 0; i < BENCHES.length; i++) surfaces.push(...benchSurfaces(i));
  return surfaces;
}

function inside(r: WallRect, s: number, y: number, inset = 0): boolean {
  return s > r.s0 + inset && s < r.s1 - inset && y > r.y0 + inset && y < r.y1 - inset;
}

/** Distance from (s, y) to `r` in the wall plane, 0 inside it. */
function rectDistance(r: WallRect, s: number, y: number): number {
  const ds = Math.max(r.s0 - s, 0, s - r.s1);
  const dy = Math.max(r.y0 - y, 0, y - r.y1);
  return Math.hypot(ds, dy);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Wall coordinates of a world point on `wall`. */
function wallCoords(wall: Wall, p: Vec3): [number, number] {
  const s = (p[0] - wall.origin[0]) * wall.right[0] + (p[2] - wall.origin[2]) * wall.right[2];
  return [s, p[1]];
}

/** Horizontal distance from (x, z) to the nearest wall. */
function wallClearance(x: number, z: number): number {
  return Math.min(x - ROOM.minX, ROOM.maxX - x, z - ROOM.minZ, ROOM.maxZ - z);
}

/** Wash of light around each frame on its own wall: up to 1 + 0.42 at the moulding. */
const WALL_GLOW = 0.42;
/** The wall strokes' mean tone luma, before light. */
const WALL_TONE_LUMA =
  ROLE_TONES.wall.reduce((sum, tone) => sum + luma(tone), 0) / ROLE_TONES.wall.length;
/**
 * The wash a frame casts, capped so the wall's mean tone beside it peaks at 0.7 of its scan's
 * median luma: a dark nocturne (the Rhône, the Café Terrace) lights its wall less than the bright
 * Wheatfield, and even the wall's brightest strokes beside it stay under the painting's median.
 * tests/gallery-surfaces.test.ts checks every frame against its scan.
 */
export function wallGlow(h: Hanging): number {
  const median = SCAN_MEDIAN_LUMA[h.painting.id] ?? WALL_TONE_LUMA;
  return Math.min(WALL_GLOW, Math.max(0, (0.7 * median) / WALL_TONE_LUMA - 1));
}
/** Bench top and side light: the top catches the room's light, the sides stay in shade. */
const BENCH_TOP_LIGHT = 1.2;
const BENCH_SIDE_LIGHT = 0.85;
const WALL_GLOW_RADIUS = 0.75;
/** Floor pool in front of each frame. */
const FLOOR_GLOW = 0.3;
const FLOOR_GLOW_RADIUS = 1.4;

/** The light factor at `p` on a surface of `role` (and `wall`, for a wall). */
export function lightAt(role: SurfaceRole, p: Vec3, wall?: Wall, normal?: Vec3): number {
  const [x, y, z] = p;
  const corner = 0.84 + 0.16 * smoothstep(0, 0.7, wallClearance(x, z));
  if (role === 'wall' && wall) {
    const [s] = wallCoords(wall, p);
    let glow = 0;
    for (const h of HANGINGS) {
      if (h.wall !== wall) continue;
      const d = rectDistance(h.outer, s, y);
      glow += wallGlow(h) * Math.exp(-((d / WALL_GLOW_RADIUS) ** 2));
    }
    const edge = Math.min(s - wall.sMin, wall.sMax - s);
    const cornerWall = 0.82 + 0.18 * smoothstep(0, 0.8, edge);
    const height =
      (0.8 + 0.2 * smoothstep(0, 0.9, y)) * (1 - 0.32 * smoothstep(2.1, ROOM.height, y));
    return cornerWall * height * (1 + glow);
  }
  if (role === 'floor') {
    let glow = 0;
    for (const h of HANGINGS) {
      const foot = wallPoint(h.wall, h.s, 0, 0.6);
      const d = Math.hypot(x - foot[0], z - foot[2]);
      glow += FLOOR_GLOW * Math.exp(-((d / FLOOR_GLOW_RADIUS) ** 2));
    }
    return corner * (1 + glow);
  }
  if (role === 'ceiling') return corner * 0.95;
  if (role === 'moulding') {
    // The top bars catch a little more of the room's light than the bottom ones.
    return 0.92 + 0.12 * smoothstep(FRAME_CENTRE_Y - 0.5, FRAME_CENTRE_Y + 0.5, y);
  }
  const face = normal && normal[1] > 0.5 ? BENCH_TOP_LIGHT : BENCH_SIDE_LIGHT;
  return face * (0.9 + 0.1 * smoothstep(0, 0.45, y));
}

/**
 * The largest tie-break share a wall stroke whose quad can reach a frame's moulding may take. The
 * moulding stands `MOULDING_DEPTH` (5 cm) off the wall, and a stroke's tie-break pulls it toward the
 * eye by its share of a range that grows with distance (about 0.125 m from the far end of the room,
 * depth-tie-break.ts). At share 0.3 a wall stroke moves at most 0.0375 m there, so it stays behind
 * the moulding from anywhere in the room (up to about 11.7 m, the room's diagonal).
 */
export const NEAR_FRAME_SHARE = 0.3;

/** True when a wall quad of `radius` centred at `p` can reach a frame's moulding. */
function reachesMoulding(wall: Wall, p: Vec3, radius: number): boolean {
  const [s, y] = wallCoords(wall, p);
  for (const h of HANGINGS_BY_WALL.get(wall) ?? []) {
    if (rectDistance(h.outer, s, y) < radius) return true;
  }
  return false;
}

const HANGINGS_BY_WALL = new Map<Wall, Hanging[]>();
for (const h of HANGINGS) {
  const list = HANGINGS_BY_WALL.get(h.wall) ?? [];
  list.push(h);
  HANGINGS_BY_WALL.set(h.wall, list);
}

/** True when a wall stroke centred at `p` would sit under a frame or a plaque card. */
function underHanging(wall: Wall, p: Vec3): boolean {
  const [s, y] = wallCoords(wall, p);
  for (const h of HANGINGS_BY_WALL.get(wall) ?? []) {
    if (inside(h.outer, s, y, 0.01) || inside(h.plaque, s, y, 0.01)) return true;
  }
  return false;
}

/** True when a floor stroke centred at (x, z) is under a bench. */
function underBench(x: number, z: number): boolean {
  return BENCHES.some(
    (b) =>
      Math.abs(x - b.centre[0]) < b.sizeX / 2 - 0.02 &&
      Math.abs(z - b.centre[1]) < b.sizeZ / 2 - 0.02,
  );
}

function meanAspect(brushes: readonly number[]): number {
  return brushes.reduce((sum, b) => sum + BRUSHES[b].aspect, 0) / brushes.length;
}

interface Placement {
  readonly surface: Surface;
  readonly a: number;
  readonly b: number;
}

/** The jittered grid of one surface: one stroke centre per cell, in local (a, b). */
function gridOf(surface: Surface, rand: () => number, out: Placement[]): void {
  const length = ROLE_LENGTH[surface.role];
  const cell = Math.sqrt((length * length * meanAspect(surface.brushes)) / OVERDRAW[surface.role]);
  const cols = Math.max(1, Math.ceil((2 * surface.halfU) / cell));
  const rows = Math.max(1, Math.ceil((2 * surface.halfV) / cell));
  const cu = (2 * surface.halfU) / cols;
  const cv = (2 * surface.halfV) / rows;
  // A strip narrower than a stroke takes extra strokes along its length instead.
  const extra = Math.max(1, Math.round(cell / cv));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      for (let k = 0; k < extra; k++) {
        out.push({
          surface,
          a: -surface.halfU + (col + rand()) * cu,
          b: -surface.halfV + (row + rand()) * cv,
        });
      }
    }
  }
}

function pointOf(surface: Surface, a: number, b: number): Vec3 {
  const { centre: c, u, v } = surface;
  return [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b, c[2] + u[2] * a + v[2] * b];
}

function jitterTone(tone: Rgb, light: number, rand: () => number): [number, number, number] {
  const value = light * (1 + (2 * rand() - 1) * VALUE_JITTER);
  return [
    tone[0] * value + (2 * rand() - 1) * CHANNEL_JITTER,
    tone[1] * value + (2 * rand() - 1) * CHANNEL_JITTER,
    tone[2] * value + (2 * rand() - 1) * CHANNEL_JITTER,
  ];
}

export interface GalleryStrokes {
  readonly buffers: StrokeBuffers;
  /** Strokes per role. */
  readonly counts: Readonly<Record<SurfaceRole, number>>;
}

/** Paints every surface: deterministic for `seed`. */
export function scatterGallery(surfaces: readonly Surface[], seed: number): GalleryStrokes {
  return drain(scatterGallerySteps(surfaces, seed));
}

/** Strokes placed between two yields of `scatterGallerySteps`. */
const GALLERY_SLICE = 4096;

/** `scatterGallery` as steps (P5.5): the same draws in the same order, yielding as it goes. */
export function* scatterGallerySteps(
  surfaces: readonly Surface[],
  seed: number,
): Steps<GalleryStrokes> {
  const rand = mulberry32(seed >>> 0);
  const placements: Placement[] = [];
  for (const surface of surfaces) {
    gridOf(surface, rand, placements);
    yield;
  }
  const kept: Placement[] = [];
  for (const p of placements) {
    const point = pointOf(p.surface, p.a, p.b);
    if (p.surface.wall && underHanging(p.surface.wall, point)) continue;
    if (p.surface.role === 'floor' && underBench(point[0], point[2])) continue;
    kept.push(p);
  }
  const buffers = createStrokeBuffers(kept.length);
  const counts: Record<SurfaceRole, number> = {
    wall: 0,
    floor: 0,
    ceiling: 0,
    bench: 0,
    moulding: 0,
  };
  const normals = new Map<Surface, Vec3>();
  for (let i = 0; i < kept.length; i++) {
    if (i > 0 && i % GALLERY_SLICE === 0) yield;
    const { surface, a, b } = kept[i];
    let decoded = normals.get(surface);
    if (!decoded) {
      decoded = decodedNormal(surface.normal);
      normals.set(surface, decoded);
    }
    const point = pointOf(surface, a, b);
    const brush = surface.brushes[Math.floor(rand() * surface.brushes.length)];
    let length = ROLE_LENGTH[surface.role] * (1 + (2 * rand() - 1) * LENGTH_JITTER);
    const aspect = BRUSHES[brush].aspect;
    // A wall stroke that can reach a moulding keeps a low share: its size is nudged by a few ulps
    // until the hash of the stored size falls under NEAR_FRAME_SHARE (about 3 tries).
    if (
      surface.wall &&
      reachesMoulding(surface.wall, point, 0.5 * Math.hypot(length, length * aspect))
    ) {
      while (sizeShare(Math.fround(length), Math.fround(length * aspect)) >= NEAR_FRAME_SHARE) {
        length *= 1 - 2 ** -20;
      }
    }
    const quad: [number, number] = [length, length * aspect];
    const flip = rand() < 0.5 ? Math.PI : 0;
    const tangent = canvasTangent(decoded, surface.u, surface.v, surface.angle(a, b, rand) + flip);
    const tones = ROLE_TONES[surface.role];
    const tone = tones[Math.floor(rand() * tones.length)];
    const rgb = jitterTone(tone, lightAt(surface.role, point, surface.wall, surface.normal), rand);
    const shade = strokeShade(decoded);
    const lift =
      SCATTER_DEPTH_JITTER *
      ROLE_LENGTH[surface.role] *
      sizeShare(Math.fround(quad[0]), Math.fround(quad[1]));
    const n = surface.normal;
    packInstance(buffers, i, {
      position: [point[0] + n[0] * lift, point[1] + n[1] * lift, point[2] + n[2] * lift],
      normal: n,
      tangent,
      color: [rgb[0] / shade, rgb[1] / shade, rgb[2] / shade, 255],
      size: quad,
      brush,
      layer: surface.layer,
      phase: Math.floor(rand() * 256),
      flags: DEPTH_RANKED_FLAG,
    });
    counts[surface.role] += 1;
  }
  return { buffers, counts };
}

/**
 * The flat base mesh: one quad per surface, wound to face its normal, coloured with its role's
 * under-paint dimmed to the strokes' mean light. One geometry, so one draw call.
 */
export function createBaseGeometry(surfaces: readonly Surface[]): BufferGeometry {
  const positions = new Float32Array(surfaces.length * 4 * 3);
  const colors = new Float32Array(surfaces.length * 4 * 3);
  const index = new Uint16Array(surfaces.length * 6);
  surfaces.forEach((surface, k) => {
    const { halfU: hu, halfV: hv } = surface;
    const corners = [
      pointOf(surface, -hu, -hv),
      pointOf(surface, hu, -hv),
      pointOf(surface, hu, hv),
      pointOf(surface, -hu, hv),
    ];
    const tone = underpaint(surface.role);
    const light = lightAt(surface.role, surface.centre, surface.wall, surface.normal) * 0.85;
    for (let c = 0; c < 4; c++) {
      positions.set(corners[c], (k * 4 + c) * 3);
      for (let ch = 0; ch < 3; ch++)
        colors[(k * 4 + c) * 3 + ch] = srgbToLinear((tone[ch] * light) / 255);
    }
    // u × v against the normal decides the winding.
    const { u, v, normal: n } = surface;
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const facing = cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] > 0;
    const o = k * 4;
    index.set(
      facing ? [o, o + 1, o + 2, o, o + 2, o + 3] : [o, o + 2, o + 1, o, o + 3, o + 2],
      k * 6,
    );
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Vertex colours are linear in three; the palette is sRGB. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
