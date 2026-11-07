/**
 * Building footprints for teleport landings (P3.4): each house's wall rectangle and the church's
 * footprint, grown by a margin, as convex polygons in world XZ. Pure. `index.ts` exposes the test
 * as `WorldHandle.blocked`.
 */
import { toWorld } from '../../world/house-geometry';
import type { ChurchRecord, HouseRecord, Village } from '../../world/village';
import type { Vec2 } from './canvas-camera';

/**
 * Clear ground kept around every wall, metres. It also covers the 0.25 m roof overhang
 * (`ROOF_OVERHANG`), so no landing is under an eave.
 */
export const FOOTPRINT_MARGIN = 0.3;

/** The records a footprint reads. */
export interface FootprintSource {
  readonly houses: readonly Pick<HouseRecord, 'center' | 'yaw' | 'width' | 'depth'>[];
  readonly church: Pick<ChurchRecord, 'footprint'>;
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

/**
 * The footprint test: true when (x, z) is within `margin` of a house's walls or the church's
 * footprint, or inside one. Each polygon is grown by moving its edges out by the margin, which
 * keeps its corners square.
 */
export function createFootprintTest(
  village: FootprintSource | Village,
  margin: number = FOOTPRINT_MARGIN,
): (x: number, z: number) => boolean {
  const footprints = [
    ...village.houses.map((house) => footprint(houseWalls(house), margin)),
    footprint(village.church.footprint, margin),
  ];
  return (x, z) => {
    for (const f of footprints) {
      if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue;
      let inside = true;
      for (let i = 0; i < f.corners.length; i += 1) {
        const [px, pz] = f.corners[i] as Vec2;
        const [nx, nz] = f.normals[i] as Vec2;
        if ((x - px) * nx + (z - pz) * nz > margin) {
          inside = false;
          break;
        }
      }
      if (inside) return true;
    }
    return false;
  };
}
