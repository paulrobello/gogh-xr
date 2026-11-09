/**
 * Building and tree footprints for teleport (P3.4, review F4/F10), pure. Each building is a convex
 * wall polygon in world XZ grown by a margin, with a top height: a house is its walls under the
 * gable roof, the church is its tower and its nave as two rectangles, not their bounding box. A
 * tree crown is the cypress rings at standing-eye height. `index.ts` exposes the tests as
 * `WorldHandle.blocked` (footprint), `volumes` (segment queries, for arcs) and `treeBlocked` (crowns).
 */

import type { VolumeQuery } from '../../locomotion/teleport';
import { CYPRESS_LOWER_SEGMENTS, CYPRESS_SEGMENTS, type Cypress } from '../../world/cypress';
import { toWorld } from '../../world/house-geometry';
import {
  CHURCH_NAVE_EAVE,
  type ChurchRecord,
  type HouseRecord,
  type Village,
} from '../../world/village';
import type { Vec2 } from './canvas-camera';

/**
 * Clear ground kept around every wall, metres. It also covers the 0.25 m roof overhang
 * (`ROOF_OVERHANG`), so no landing is under an eave.
 */
export const FOOTPRINT_MARGIN = 0.3;

/** Standing eye height above a landing, metres: a crown the eye would sit in blocks the landing. */
export const CROWN_EYE_HEIGHT = 1.6;

/** The records a footprint reads. */
export interface FootprintSource {
  readonly houses: readonly Pick<HouseRecord, 'center' | 'yaw' | 'width' | 'depth'>[];
  readonly church: Pick<ChurchRecord, 'walls'>;
}

/** The records a volume reads: a footprint's, plus the heights. */
export interface VolumeSource {
  readonly houses: readonly Pick<
    HouseRecord,
    'center' | 'yaw' | 'width' | 'depth' | 'eaveHeight' | 'ridgeHeight'
  >[];
  readonly church: Pick<ChurchRecord, 'walls' | 'center' | 'naveRidge' | 'steepleTip'>;
}

interface Footprint {
  /** Corners in perimeter order. */
  readonly corners: readonly Vec2[];
  /** Outward unit edge normals, one per edge from corner i to corner i + 1. */
  readonly normals: readonly Vec2[];
  /** The bounds grown by the margin, for a quick reject. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * A building part: its grown wall polygon and its top. The top is flat (`rise` 0) or a gable: it
 * climbs from `eave` at |across| = `halfSpan` to `eave + rise` on the ridge, where
 * across = (x - cx)·ux + (z - cz)·uz, and it stays on that profile in the margin past the gable
 * ends (only past the long walls does it cap at the eave).
 */
interface Solid {
  readonly footprint: Footprint;
  /** World y of the wall top (the eave) and the gable's rise above it. */
  readonly eaveY: number;
  readonly rise: number;
  readonly halfSpan: number;
  /** The unit direction of `across` and the ridge line's point. */
  readonly ux: number;
  readonly uz: number;
  readonly cx: number;
  readonly cz: number;
}

/** World y of the solid's top at (x, z). */
function topOf(s: Solid, x: number, z: number): number {
  if (s.rise === 0) return s.eaveY;
  const across = Math.min(1, Math.abs((x - s.cx) * s.ux + (z - s.cz) * s.uz) / s.halfSpan);
  return s.eaveY + s.rise * (1 - across);
}

/** A house's wall rectangle, as village.ts lays it out: local x along the ridge. */
function houseWalls(house: FootprintSource['houses'][number]): Vec2[] {
  const frame = { cx: house.center[0], cz: house.center[2], base: 0, yaw: house.yaw };
  const hw = house.width / 2;
  const hd = house.depth / 2;
  return (
    [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ] as const
  ).map(([lx, lz]) => {
    const p = toWorld(frame, lx, 0, lz);
    return [p[0], p[2]] as Vec2;
  });
}

function footprint(corners: readonly Vec2[], margin: number): Footprint {
  // Twice the signed area: positive when the corners run counter-clockwise in (x, z).
  let area = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const [ax, az] = corners[i] as Vec2;
    const [bx, bz] = corners[(i + 1) % corners.length] as Vec2;
    area += ax * bz - bx * az;
  }
  const outward = area > 0 ? 1 : -1;
  const normals = corners.map((p, i) => {
    const q = corners[(i + 1) % corners.length] as Vec2;
    const ex = q[0] - p[0];
    const ez = q[1] - p[1];
    const length = Math.hypot(ex, ez);
    return [(outward * ez) / length, (-outward * ex) / length] as Vec2;
  });
  const xs = corners.map((p) => p[0]);
  const zs = corners.map((p) => p[1]);
  // Moving the edges of a rectangle out by the margin moves its corners out by √2 × the margin,
  // on the diagonal, so a rotated one reaches further than the margin along world x or z.
  const reach = margin * Math.SQRT2;
  return {
    corners,
    normals,
    minX: Math.min(...xs) - reach,
    maxX: Math.max(...xs) + reach,
    minZ: Math.min(...zs) - reach,
    maxZ: Math.max(...zs) + reach,
  };
}

/** Whether (x, z) is inside the footprint grown by `margin` (edges moved out, corners square). */
function contains(f: Footprint, x: number, z: number, margin: number): boolean {
  if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) return false;
  for (let i = 0; i < f.corners.length; i += 1) {
    const [px, pz] = f.corners[i] as Vec2;
    const [nx, nz] = f.normals[i] as Vec2;
    if ((x - px) * nx + (z - pz) * nz > margin) return false;
  }
  return true;
}

/** A house: its walls under the gable roof, whose ridge runs along local x. */
function houseSolid(house: VolumeSource['houses'][number], margin: number): Solid {
  const [cx, base, cz] = house.center;
  return {
    footprint: footprint(houseWalls(house), margin),
    eaveY: base + house.eaveHeight,
    rise: house.ridgeHeight - house.eaveHeight,
    halfSpan: house.depth / 2,
    // Local z across the ridge: the inverse of `toWorld`.
    ux: Math.sin(house.yaw),
    uz: Math.cos(house.yaw),
    cx,
    cz,
  };
}

/**
 * The church as its tower and its nave. The tower is a box to the spire's tip. The nave is a gable
 * whose ridge runs along world z, so its top depends on x.
 */
function churchSolids(church: VolumeSource['church'], margin: number): Solid[] {
  const [tower, nave] = church.walls as readonly [readonly Vec2[], readonly Vec2[]];
  const naveX = nave.map((p) => p[0]);
  const lo = Math.min(...naveX);
  const hi = Math.max(...naveX);
  const base = church.center[1];
  return [
    {
      footprint: footprint(tower, margin),
      eaveY: church.steepleTip[1],
      rise: 0,
      halfSpan: 1,
      ux: 1,
      uz: 0,
      cx: 0,
      cz: 0,
    },
    {
      footprint: footprint(nave, margin),
      eaveY: base + CHURCH_NAVE_EAVE,
      rise: church.naveRidge - CHURCH_NAVE_EAVE,
      halfSpan: (hi - lo) / 2,
      ux: 1,
      uz: 0,
      cx: (lo + hi) / 2,
      cz: 0,
    },
  ];
}

/**
 * The footprint test: true when (x, z) is within `margin` of a house's walls or of the church's
 * tower or nave, or inside one. Each polygon is grown by moving its edges out by the margin,
 * which keeps its corners square. The church is its two rectangles, so the open ground beside the
 * tower is open.
 */
export function createFootprintTest(
  village: FootprintSource | Village,
  margin: number = FOOTPRINT_MARGIN,
): (x: number, z: number) => boolean {
  const footprints = [
    ...village.houses.map((house) => footprint(houseWalls(house), margin)),
    ...(village.church.walls as readonly (readonly Vec2[])[]).map((w) => footprint(w, margin)),
  ];
  return (x, z) => {
    for (const f of footprints) if (contains(f, x, z, margin)) return true;
    return false;
  };
}

/** The clip of the last `clip` call: the segment's parameter range inside a footprint. */
const clipped = new Float64Array(2);

/**
 * Clips the segment (ax, az) to (bx, bz) against the footprint grown by `margin` (Cyrus-Beck over
 * the edge half-planes). Writes the parameter range to `clipped` and returns whether it is
 * non-empty.
 */
function clip(
  f: Footprint,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  margin: number,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  for (let i = 0; i < f.corners.length; i += 1) {
    const [px, pz] = f.corners[i] as Vec2;
    const [nx, nz] = f.normals[i] as Vec2;
    const num = margin - ((ax - px) * nx + (az - pz) * nz);
    const den = dx * nx + dz * nz;
    if (den === 0) {
      if (num < 0) return false;
    } else {
      const t = num / den;
      if (den > 0) t1 = Math.min(t1, t);
      else t0 = Math.max(t0, t);
      if (t0 > t1) return false;
    }
  }
  clipped[0] = t0;
  clipped[1] = t1;
  return true;
}

/** Height of the segment a to b over the solid's top at parameter t; at or below 0 is inside. */
function gap(
  s: Solid,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  t: number,
): number {
  return ay + (by - ay) * t - topOf(s, ax + (bx - ax) * t, az + (bz - az) * t);
}

/** Whether the gap is at or below 0 at the parameter where `across` reaches `target`, inside (t0, t1). */
function bends(
  s: Solid,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  t0: number,
  t1: number,
  target: number,
): boolean {
  const a0 = (ax - s.cx) * s.ux + (az - s.cz) * s.uz;
  const da = (bx - ax) * s.ux + (bz - az) * s.uz;
  if (da === 0) return false;
  const t = (target - a0) / da;
  return t > t0 && t < t1 && gap(s, ax, ay, az, bx, by, bz, t) <= 0;
}

/** Whether the segment a to b dips to or below the solid's top over the parameters [t0, t1]. */
function dips(
  s: Solid,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  t0: number,
  t1: number,
): boolean {
  if (gap(s, ax, ay, az, bx, by, bz, t0) <= 0 || gap(s, ax, ay, az, bx, by, bz, t1) <= 0) {
    return true;
  }
  if (s.rise === 0) return false;
  // The top is linear between the ridge and the eave lines, so the gap's minimum is at one of
  // them or at an end.
  return (
    bends(s, ax, ay, az, bx, by, bz, t0, t1, 0) ||
    bends(s, ax, ay, az, bx, by, bz, t0, t1, s.halfSpan) ||
    bends(s, ax, ay, az, bx, by, bz, t0, t1, -s.halfSpan)
  );
}

/**
 * The building volumes: each solid's grown footprint up to its top. `at` tests a point and
 * `crossing` a segment, exactly: the segment is clipped to each footprint, and the top is
 * compared over the clip at its ends and at the gable's ridge and eave lines, where it bends.
 * No call allocates. `begin` and `update` keep a mode per volume for the running trace: a volume
 * whose walls hold the origin is skipped until the arc leaves them, and one that holds it only in
 * its margin is tested without the margin. The tower and nave overlap in a strip, so more than one
 * can hold the origin.
 */
export function createVolumes(
  village: VolumeSource | Village,
  margin: number = FOOTPRINT_MARGIN,
): VolumeQuery {
  const solids: Solid[] = [
    ...village.houses.map((house) => houseSolid(house, margin)),
    ...churchSolids(village.church, margin),
  ];
  /** Per solid: 0 tested with its margin, 1 ignored (the trace started in its walls), 2 bare. */
  const mode = new Uint8Array(solids.length);
  let tracked = 0;
  const inside = (i: number, x: number, y: number, z: number, m: number): boolean => {
    const s = solids[i] as Solid;
    return contains(s.footprint, x, z, m) && y <= topOf(s, x, z);
  };
  return {
    at(x, y, z) {
      for (let i = 0; i < solids.length; i += 1) if (inside(i, x, y, z, margin)) return i;
      return -1;
    },
    begin(x, y, z) {
      tracked = 0;
      for (let i = 0; i < solids.length; i += 1) {
        mode[i] = inside(i, x, y, z, 0) ? 1 : inside(i, x, y, z, margin) ? 2 : 0;
        if (mode[i] !== 0) tracked += 1;
      }
    },
    update(x, y, z) {
      if (tracked === 0) return;
      for (let i = 0; i < solids.length; i += 1) {
        if (mode[i] === 1 && !inside(i, x, y, z, 0)) mode[i] = 2;
      }
    },
    crossing(ax, ay, az, bx, by, bz) {
      const minX = Math.min(ax, bx);
      const maxX = Math.max(ax, bx);
      const minZ = Math.min(az, bz);
      const maxZ = Math.max(az, bz);
      for (let i = 0; i < solids.length; i += 1) {
        if (mode[i] === 1) continue;
        const m = mode[i] === 2 ? 0 : margin;
        const s = solids[i] as Solid;
        const f = s.footprint;
        if (maxX < f.minX || minX > f.maxX || maxZ < f.minZ || minZ > f.maxZ) continue;
        if (!clip(f, ax, az, bx, bz, m)) continue;
        if (dips(s, ax, ay, az, bx, by, bz, clipped[0] as number, clipped[1] as number)) return i;
      }
      return -1;
    },
  };
}

/** The volume test at a point: true when (x, y, z) is inside a building volume. */
export function createVolumeTest(
  village: VolumeSource | Village,
  margin: number = FOOTPRINT_MARGIN,
): (x: number, y: number, z: number) => boolean {
  const volumes = createVolumes(village, margin);
  return (x, y, z) => volumes.at(x, y, z) >= 0;
}

/** One ring of a crown: its height and its outline in XZ, x and z interleaved. */
interface CrownRing {
  readonly xz: Float64Array;
}

interface Crown {
  readonly rings: readonly CrownRing[];
  /** Ring spacing in y, metres. */
  readonly spacing: number;
  readonly baseY: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** The cypress mass's rings from its geometry: `rings` loops of `segs` vertices, then the tip. */
function crownOf(
  positions: ArrayLike<number>,
  mass: Cypress['main'],
  segs: number,
  margin: number,
): Crown {
  const count = (mass.vertexCount - 1) / segs;
  const rings: CrownRing[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let r = 0; r < count; r += 1) {
    const xz = new Float64Array(segs * 2);
    for (let k = 0; k < segs; k += 1) {
      const v = (mass.firstVertex + r * segs + k) * 3;
      const x = positions[v] as number;
      const z = positions[v + 2] as number;
      xz[k * 2] = x;
      xz[k * 2 + 1] = z;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    rings.push({ xz });
  }
  return {
    rings,
    spacing: mass.height / count,
    baseY: mass.base[1],
    minX: minX - margin,
    maxX: maxX + margin,
    minZ: minZ - margin,
    maxZ: maxZ + margin,
  };
}

/** Whether (x, z) is inside the polygon (even-odd) or within `margin` of its edge. */
function insideOrNear(xz: Float64Array, x: number, z: number, margin: number): boolean {
  const n = xz.length / 2;
  const limit = margin * margin;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const ax = xz[j * 2] as number;
    const az = xz[j * 2 + 1] as number;
    const bx = xz[i * 2] as number;
    const bz = xz[i * 2 + 1] as number;
    if (az > z !== bz > z && x < ax + ((z - az) / (bz - az)) * (bx - ax)) inside = !inside;
    const ex = bx - ax;
    const ez = bz - az;
    const along = ex * ex + ez * ez;
    const t = along > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / along)) : 0;
    const dx = x - (ax + t * ex);
    const dz = z - (az + t * ez);
    if (dx * dx + dz * dz <= limit) return true;
  }
  return inside;
}

/**
 * The crown test: true when a viewer landing at (x, z) would stand in a cypress or have the eye in
 * it. The landing's foot is at the ground there and the eye `CROWN_EYE_HEIGHT` above it, so the
 * crown rings from the foot up to the eye are tested, each grown by the margin. A ring is the
 * crown's outline at its height, flame lobes included. Arcs are not tested: foliage is soft.
 */
export function createCrownTest(
  cypress: Pick<Cypress, 'geometry' | 'main' | 'lower'>,
  heightAt: (x: number, z: number) => number,
  margin: number = FOOTPRINT_MARGIN,
): (x: number, z: number) => boolean {
  const positions = cypress.geometry.getAttribute('position').array;
  const crowns = [
    crownOf(positions, cypress.main, CYPRESS_SEGMENTS, margin),
    crownOf(positions, cypress.lower, CYPRESS_LOWER_SEGMENTS, margin),
  ];
  return (x, z) => {
    const foot = heightAt(x, z);
    for (const crown of crowns) {
      if (x < crown.minX || x > crown.maxX || z < crown.minZ || z > crown.maxZ) continue;
      const last = crown.rings.length - 1;
      const from = Math.max(0, Math.floor((foot - crown.baseY) / crown.spacing));
      const to = Math.min(last, Math.ceil((foot + CROWN_EYE_HEIGHT - crown.baseY) / crown.spacing));
      for (let r = from; r <= to; r += 1) {
        if (insideOrNear((crown.rings[r] as CrownRing).xz, x, z, margin)) return true;
      }
    }
    return false;
  };
}
