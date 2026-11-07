/**
 * The gallery room's layout (P5.4), pure so the unit tests check it without WebGL: the room box,
 * its four walls, the seven hangings at true relative scale, their plaques, the two benches, the
 * walk bounds and the teleport footprint test.
 *
 * World: metres, +Y up, the floor at y = 0. The viewer spawns at the origin facing -Z, 4 m from the
 * north wall, where The Starry Night hangs alone. The other six hang in the registry's order
 * clockwise seen from above, turning right from Starry Night: the east wall front to back, the
 * south (back) wall east to west, then the west wall back to front, so the Rhône ends beside
 * Starry Night.
 */
import type { Vec3 } from '../../render/strokes/frame';
import { PAINTINGS, type PaintingEntry } from '../registry';

/** Room interior: x across, z along, y up. */
export const ROOM = Object.freeze({
  minX: -3,
  maxX: 3,
  minZ: -4,
  maxZ: 6,
  height: 3.5,
});

/** Frames and plaques hang this far from any wall edge at least, metres. */
export const WALL_MARGIN = 0.25;
/** Every frame centre's height, metres (eye height). */
export const FRAME_CENTRE_Y = 1.6;
/** The moulding's face width around the scan, metres. */
export const MOULDING_WIDTH = 0.07;
/** How far the moulding's front face stands off the wall, metres. */
export const MOULDING_DEPTH = 0.05;
/** The scan plane's distance off the wall: just behind the moulding's front face. */
export const SCAN_DEPTH = 0.048;
/** Plaque card size and placement, metres. */
export const PLAQUE_WIDTH = 0.4;
export const PLAQUE_HEIGHT = 0.22;
export const PLAQUE_CENTRE_Y = 1.3;
/** Gap between a frame's moulding and its plaque card, metres. */
export const PLAQUE_GAP = 0.12;
/** The card's thickness, and how far its front face stands off the wall. */
export const PLAQUE_DEPTH = 0.012;
/** Teleport refuses this close to a wall or a bench, metres (P3.4's 0.3 m house margin). */
export const BLOCK_MARGIN = 0.3;
/** Smooth movement and flight keep the head this far inside the walls and below the ceiling. */
export const WALK_MARGIN = 0.3;

export type WallName = 'north' | 'east' | 'south' | 'west';

/**
 * A wall seen from inside the room. A point on it is `origin + s·right + y·up`; `normal` faces into
 * the room and `right` is up × normal, the viewer's right when facing the wall.
 */
export interface Wall {
  readonly name: WallName;
  readonly origin: Vec3;
  readonly right: Vec3;
  readonly normal: Vec3;
  readonly sMin: number;
  readonly sMax: number;
}

function wall(
  name: WallName,
  origin: Vec3,
  right: Vec3,
  normal: Vec3,
  sMin: number,
  sMax: number,
): Wall {
  return Object.freeze({ name, origin, right, normal, sMin, sMax });
}

export const WALLS: Readonly<Record<WallName, Wall>> = Object.freeze({
  north: wall('north', [0, 0, ROOM.minZ], [1, 0, 0], [0, 0, 1], ROOM.minX, ROOM.maxX),
  east: wall('east', [ROOM.maxX, 0, 0], [0, 0, 1], [-1, 0, 0], ROOM.minZ, ROOM.maxZ),
  south: wall('south', [0, 0, ROOM.maxZ], [-1, 0, 0], [0, 0, -1], -ROOM.maxX, -ROOM.minX),
  west: wall('west', [ROOM.minX, 0, 0], [0, 0, -1], [1, 0, 0], -ROOM.maxZ, -ROOM.minZ),
});

/** An axis-aligned rectangle in a wall's (s, y) coordinates. */
export interface WallRect {
  readonly s0: number;
  readonly s1: number;
  readonly y0: number;
  readonly y1: number;
}

/** UV crop of a scan: the part of [0, 1]² that shows, v up as three samples it. */
export interface UvCrop {
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
}

export interface Hanging {
  readonly painting: PaintingEntry;
  readonly wall: Wall;
  /** Centre along the wall, metres. */
  readonly s: number;
  readonly y: number;
  /** The scan's true size, metres. */
  readonly width: number;
  readonly height: number;
  /** The scan, then the scan plus its moulding. */
  readonly scan: WallRect;
  readonly outer: WallRect;
  readonly plaque: WallRect;
}

const SIDE_THIRD = (ROOM.maxZ - ROOM.minZ) / 3;

/** Where each painting hangs: its wall and its centre along it. Keys follow the registry. */
const PLACEMENT: Readonly<Record<string, { wall: WallName; s: number }>> = Object.freeze({
  'starry-night': { wall: 'north', s: 0 },
  'chestnut-trees-in-blossom': { wall: 'east', s: ROOM.minZ + SIDE_THIRD },
  'les-alyscamps': { wall: 'east', s: ROOM.minZ + 2 * SIDE_THIRD },
  'cafe-terrace-at-night': { wall: 'south', s: -1.4 },
  bedroom: { wall: 'south', s: 1.4 },
  'wheatfield-with-crows': { wall: 'west', s: -ROOM.maxZ + SIDE_THIRD },
  'starry-night-over-the-rhone': { wall: 'west', s: -ROOM.maxZ + 2 * SIDE_THIRD },
});

/** The hanging of `painting`, at true size from its `widthCm` × `heightCm`. */
export function hang(painting: PaintingEntry): Hanging {
  const place = PLACEMENT[painting.id];
  if (!place) throw new Error(`painting "${painting.id}" has no place in the gallery`);
  const wall = WALLS[place.wall];
  const width = painting.widthCm / 100;
  const height = painting.heightCm / 100;
  const { s } = place;
  const y = FRAME_CENTRE_Y;
  const scan = { s0: s - width / 2, s1: s + width / 2, y0: y - height / 2, y1: y + height / 2 };
  const outer = {
    s0: scan.s0 - MOULDING_WIDTH,
    s1: scan.s1 + MOULDING_WIDTH,
    y0: scan.y0 - MOULDING_WIDTH,
    y1: scan.y1 + MOULDING_WIDTH,
  };
  const plaqueS = outer.s1 + PLAQUE_GAP + PLAQUE_WIDTH / 2;
  const plaque = {
    s0: plaqueS - PLAQUE_WIDTH / 2,
    s1: plaqueS + PLAQUE_WIDTH / 2,
    y0: PLAQUE_CENTRE_Y - PLAQUE_HEIGHT / 2,
    y1: PLAQUE_CENTRE_Y + PLAQUE_HEIGHT / 2,
  };
  return { painting, wall, s, y, width, height, scan, outer, plaque };
}

/** All seven, in registry order. */
export const HANGINGS: readonly Hanging[] = Object.freeze(PAINTINGS.map(hang));

/** The world point at (s, y) on `wall`, `offset` metres into the room. */
export function wallPoint(wall: Wall, s: number, y: number, offset = 0): Vec3 {
  return [
    wall.origin[0] + wall.right[0] * s + wall.normal[0] * offset,
    y,
    wall.origin[2] + wall.right[2] * s + wall.normal[2] * offset,
  ];
}

export function rectsOverlap(a: WallRect, b: WallRect): boolean {
  return a.s0 < b.s1 && b.s0 < a.s1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** True when `r` lies inside `wall` with `margin` to spare on every side. */
export function insideWall(wall: Wall, r: WallRect, margin = WALL_MARGIN): boolean {
  return (
    r.s0 >= wall.sMin + margin &&
    r.s1 <= wall.sMax - margin &&
    r.y0 >= margin &&
    r.y1 <= ROOM.height - margin
  );
}

/**
 * The central UV window of a `scanWidth` × `scanHeight` scan whose aspect is the painting's,
 * `paintWidth` / `paintHeight`: the cover fit, cropping the excess off the long side. `bias` moves
 * a vertical crop toward the bottom (1) or the top (-1); 0 splits it evenly.
 */
export function coverCrop(
  scanWidth: number,
  scanHeight: number,
  paintWidth: number,
  paintHeight: number,
  bias = 0,
): UvCrop {
  const scan = scanWidth / scanHeight;
  const paint = paintWidth / paintHeight;
  if (scan > paint) {
    const keep = paint / scan;
    const margin = (1 - keep) / 2;
    return { u0: margin, u1: 1 - margin, v0: 0, v1: 1 };
  }
  const keep = scan / paint;
  const excess = 1 - keep;
  const fromBottom = (excess * (1 + Math.min(1, Math.max(-1, bias)))) / 2;
  return { u0: 0, u1: 1, v0: fromBottom, v1: fromBottom + keep };
}

/**
 * Per-painting vertical crop bias: the chestnut scan's dark rebate shows along its bottom edge
 * (the frame in the photograph's lower right), so most of its 6% excess comes off the bottom.
 */
export const CROP_BIAS: Readonly<Record<string, number>> = Object.freeze({
  'chestnut-trees-in-blossom': 0.4,
});

/** A bench: an axis-aligned block on the floor. */
export interface Bench {
  readonly centre: readonly [number, number];
  /** Full size along x and z, metres. */
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly height: number;
}

/** One bench before Starry Night, one down the room's back half facing the side walls. */
export const BENCHES: readonly Bench[] = Object.freeze([
  Object.freeze({ centre: [0, -2.1], sizeX: 1.6, sizeZ: 0.42, height: 0.45 } as const),
  Object.freeze({ centre: [0, 2.9], sizeX: 0.42, sizeZ: 1.6, height: 0.45 } as const),
]);

/**
 * True where no teleport may land: outside the room's interior shrunk by `BLOCK_MARGIN` (the walls
 * grown by it), or on a bench grown by it.
 */
export function galleryBlocked(x: number, z: number): boolean {
  if (
    x <= ROOM.minX + BLOCK_MARGIN ||
    x >= ROOM.maxX - BLOCK_MARGIN ||
    z <= ROOM.minZ + BLOCK_MARGIN ||
    z >= ROOM.maxZ - BLOCK_MARGIN
  ) {
    return true;
  }
  for (const bench of BENCHES) {
    if (
      Math.abs(x - bench.centre[0]) < bench.sizeX / 2 + BLOCK_MARGIN &&
      Math.abs(z - bench.centre[1]) < bench.sizeZ / 2 + BLOCK_MARGIN
    ) {
      return true;
    }
  }
  return false;
}

/** 0 inside the room, 1 outside it: nothing lands or flies beyond its walls. */
export function galleryBoundary(position: Vec3): number {
  const [x, , z] = position;
  return x > ROOM.minX && x < ROOM.maxX && z > ROOM.minZ && z < ROOM.maxZ ? 0 : 1;
}
