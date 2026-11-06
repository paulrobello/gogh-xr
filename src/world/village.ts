/**
 * The village and church in the valley below the painter's spot, laid out so that through the
 * painter's camera the roofs trace the painted village roofline and the steeple tip lands on the
 * painted church apex. Pure: geometry and data records only, no materials, no scene objects.
 *
 * Layout: every roof and the steeple are fitted by construction. Each house picks a target canvas
 * point on the roofline, casts `canvasRay` through it, and stands where that ray is its own height
 * above the ground: the ray point at the chosen distance is its ridge's top centre. A distance is
 * kept only when the resulting height is a realistic 4–8 m and its roof outline (a rotated
 * rectangle) clears every other outline, the church's included, and the house's silhouette stays
 * clear of the church's canvas u extent. A stratified pass spreads the
 * houses across the frame; a fill pass then tops the count up wherever there is room.
 */
import type { BufferGeometry } from 'three';
import {
  canvasRay,
  PAINTER_EYE,
  projectToCanvas,
  type Vec2,
} from '../paintings/starry-night/canvas-camera';
import type { Vec3 } from '../render/strokes/frame';
import { mulberry32 } from '../util/prng';
import {
  createMeshBuilder,
  type GableBox,
  type LocalFrame,
  type MeshBuilder,
  pushGableRoof,
  pushGableWalls,
  pushQuad,
  pushSteeple,
  toGeometry,
  toWorld,
  toWorldDir,
} from './house-geometry';
import { TERRAIN_CELL, type Terrain } from './terrain';

/**
 * Top edge of the canvas village region, (u, v) with v up, left to right. A copy of the
 * regions.json `village` polygon minus its bottom corners (v = 1 − v_json); a unit test keeps the
 * two in step.
 */
export const VILLAGE_ROOFLINE: readonly Vec2[] = Object.freeze(
  (
    [
      [0, 0.832],
      [0.125, 0.821],
      [0.367, 0.768],
      [0.45, 0.749],
      [0.517, 0.737],
      [0.6, 0.737],
      [0.683, 0.726],
      // biome-ignore lint/suspicious/noApproximativeNumericConstant: a painted v_json value, not √½.
      [0.75, 0.707],
      [0.833, 0.703],
      [0.917, 0.703],
      [1, 0.695],
    ] as const
  ).map(([u, vDown]) => Object.freeze([u, 1 - vDown]) as Vec2),
);

/** The regions.json `church` polygon's apex (midpoint of its two top vertices), v up. */
export const CHURCH_APEX_UV: Vec2 = Object.freeze([0.567, 1 - 0.632]) as Vec2;

/**
 * The regions.json `church` polygon's u extent. No house's silhouette may cross it: the church
 * stands at the far edge of the band, so any house there would stand in front of it.
 */
export const CHURCH_U_EXTENT: Vec2 = Object.freeze([0.493, 0.598]) as Vec2;

/** Horizontal distance band from the spot that houses and church stand in, metres. */
export const VILLAGE_BAND: Readonly<{ min: number; max: number }> = Object.freeze({
  min: 15,
  max: 40,
});
/** Target number of houses. When every try fails a seed gets fewer; none of the tested seeds do. */
export const HOUSE_COUNT: number = 20;
/** Height from the sunk base to the ridge, metres. */
export const HOUSE_HEIGHT: Readonly<{ min: number; max: number }> = Object.freeze({
  min: 4,
  max: 8,
});
/** Warm yellow of the lit windows, linear RGB in [0, 1]. Recorded in the window geometry's userData. */
export const WINDOW_COLOR: Vec3 = Object.freeze([1, 0.8, 0.32]) as Vec3;
/** Gap between a window quad and its wall, metres; keeps the two from z-fighting. */
export const WINDOW_OFFSET: number = 0.02;

/** Roof targets skip this u band around the church; `hidesChurch` then keeps whole silhouettes off it. */
const CHURCH_U_BAND: readonly [number, number] = Object.freeze([0.48, 0.61]) as readonly [
  number,
  number,
];
/** Inset from the frame's side edges for house targets, so every roof top is in frame. */
const U_EDGE = 0.015;
/**
 * Roof targets scatter this far below and above the roofline, in v, for a varied skyline. Right of
 * u 0.85 the painted roofline sits above the true horizon's reach, so roofs may drop further.
 */
const V_BELOW = 0.025;
const V_BELOW_FAR_RIGHT = 0.045;
const V_ABOVE = 0.01;
/** Roof overhang past the walls, metres. */
export const ROOF_OVERHANG: number = 0.25;
/** Clear ground between neighbouring roof outlines, metres. */
export const OUTLINE_GAP: number = 0.3;
/** Lowest wall top above the base, metres. */
const MIN_EAVE = 2.6;
/** Wall height that must stay clear above the highest wall-bottom ground sample, for the windows. */
const MIN_CLEAR_WALL = 1.6;
const TRIES_PER_SLOT = 12;
const FILL_TRIES = 800;
/** Distances scanned along each try's ray, evenly over the band. */
const DISTANCE_STEPS = 50;
const WINDOW_W = 0.7;
const WINDOW_H = 0.9;

const CHURCH = Object.freeze({
  /** Steeple tower half-width, metres. */
  towerHalf: 1.1,
  /** Nave extent left and right of the steeple axis (painted u 0.493–0.598 around 0.567). */
  naveLeft: 4,
  naveRight: 1.6,
  /**
   * Naves tried at each distance, in order: behind the tower, longest first, then in front of it
   * (toward the viewer, the tower rising behind its gable). Lengths in metres.
   */
  naves: Object.freeze([
    ['behind', 8],
    ['behind', 7],
    ['behind', 6],
    ['behind', 5],
    ['behind', 4],
    ['behind', 3],
    ['front', 3],
    ['front', 4],
  ] as const),
  naveEave: 3.2,
  naveRise: 1.6,
  /** Nave roof overhang, metres; the church outline covers it. */
  overhang: 0.25,
  /** Tower top above the nave ridge, metres. Puts the spire foot near the painted v_json 0.737. */
  towerOverRidge: 1.4,
  /**
   * Upward nudges of the steeple tip off the painted apex, in v, tried in order. A nudge is used
   * only when no placement fits on the apex itself; the largest stays well inside the 0.03 fit.
   */
  apexNudges: Object.freeze([0, 0.005, 0.01, 0.015, 0.02]),
  /**
   * Steeple distances tried, far to near, in 0.5 m steps. The first distance and nave length
   * meeting every church bound win.
   */
  distances: Object.freeze(Array.from({ length: 29 }, (_, i) => 39 - i * 0.5)),
  minSteeple: 10,
  maxSteeple: 16,
});

/** The church outline stays within this distance of the spot, metres, inside the boundary. */
export const CHURCH_MAX_REACH: number = 48;
/** Most ground allowed above the church base anywhere over its walls, metres. */
export const CHURCH_MAX_BURIAL: number = 1;

export interface HouseRecord {
  /**
   * Base centre: footprint centre at the sunk base height, the lowest ground along the wall
   * bottoms (sampled at most one terrain cell apart, corners included).
   */
  readonly center: Vec3;
  /** Rotation about +Y, radians, three.js convention. The ridge runs along local x. */
  readonly yaw: number;
  /** Wall extent along the ridge, metres. */
  readonly width: number;
  /** Wall extent across the ridge, metres. */
  readonly depth: number;
  /** Wall top above the base, metres. */
  readonly eaveHeight: number;
  /** Ridge above the base, metres. */
  readonly ridgeHeight: number;
  /** World xz corners of the roof outline (walls plus overhang): what must not overlap. */
  readonly outline: readonly Vec2[];
  /** Top centre of the ridge: the point fitted to the painted roofline. */
  readonly roofTop: Vec3;
}

export interface ChurchRecord {
  /** Footprint centre at the sunk base height, the lowest ground along both wall rectangles. */
  readonly center: Vec3;
  /** The four world xz corners of the church's wall rectangle, nave and tower together. */
  readonly footprint: readonly Vec2[];
  /** The tower's and the nave's wall rectangles, world xz corners in perimeter order. */
  readonly walls: readonly (readonly Vec2[])[];
  /** The wall rectangle grown by the nave roof overhang: what must not overlap. */
  readonly outline: readonly Vec2[];
  /** The spire's tip: the point fitted to the painted church apex. */
  readonly steepleTip: Vec3;
  /** Steeple tower width, metres. */
  readonly steepleWidth: number;
  /** Nave ridge above the base, metres. */
  readonly naveRidge: number;
  /** Nave length along z, metres. */
  readonly naveLength: number;
  /** Whether the nave stands behind the tower or in front of it, toward the viewer. */
  readonly naveSide: 'behind' | 'front';
  /**
   * True when the steeple is 10–16 m, the outline within `CHURCH_MAX_REACH` and the burial within
   * `CHURCH_MAX_BURIAL`. False means no tried placement met them and the nearest-miss is kept.
   */
  readonly fitted: boolean;
}

export interface WindowRecord {
  /** Index into `Village.houses`. */
  readonly house: number;
  /** Quad centre, `WINDOW_OFFSET` outside the wall. */
  readonly center: Vec3;
  /** Unit outward wall normal. */
  readonly normal: Vec3;
  readonly width: number;
  readonly height: number;
  /** On a gable end (local ±x wall) rather than a long wall. */
  readonly onGable: boolean;
}

export interface Village {
  readonly seed: number;
  readonly houses: readonly HouseRecord[];
  readonly church: ChurchRecord;
  readonly windows: readonly WindowRecord[];
  /**
   * Merged flat-shaded triangle soups, one per world layer, each tagged in `userData.layer`. The
   * window geometry also carries `userData.emissive = true` and `userData.color = WINDOW_COLOR`.
   */
  readonly geometries: Readonly<{
    building: BufferGeometry;
    roof: BufferGeometry;
    window: BufferGeometry;
    church: BufferGeometry;
  }>;
}

/** Canvas v (up) of the painted roofline at u, linear between its vertices. */
export function rooflineV(u: number): number {
  const pts = VILLAGE_ROOFLINE;
  const first = pts[0] as Vec2;
  if (u <= first[0]) return first[1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [u0, v0] = pts[i] as Vec2;
    const [u1, v1] = pts[i + 1] as Vec2;
    if (u <= u1) return u1 === u0 ? v0 : v0 + ((u - u0) / (u1 - u0)) * (v1 - v0);
  }
  return (pts[pts.length - 1] as Vec2)[1];
}

/** The point on the painter's ray through (u, v) at horizontal distance `dist` from the eye. */
function rayPointAt(u: number, v: number, dist: number): Vec3 {
  const d = canvasRay(u, v);
  const s = dist / Math.hypot(d[0], d[2]);
  return [PAINTER_EYE[0] + d[0] * s, PAINTER_EYE[1] + d[1] * s, PAINTER_EYE[2] + d[2] * s];
}

const cornersXZ = (f: LocalFrame, hw: number, hd: number): Vec2[] =>
  (
    [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ] as const
  ).map(([lx, lz]) => {
    const p = toWorld({ ...f, base: 0 }, lx, 0, lz);
    return [p[0], p[2]] as Vec2;
  });

/**
 * Whether convex polygons a and b (world xz, perimeter order) come closer than `gap`: the
 * separating axis test over both polygons' edge normals.
 */
export function outlinesTouch(a: readonly Vec2[], b: readonly Vec2[], gap: number): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i] as Vec2;
      const q = poly[(i + 1) % poly.length] as Vec2;
      const nx = q[1] - p[1];
      const nz = p[0] - q[0];
      const len = Math.hypot(nx, nz);
      const proj = (pts: readonly Vec2[]): [number, number] => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const [x, z] of pts) {
          const d = (x * nx + z * nz) / len;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
        return [lo, hi];
      };
      const [alo, ahi] = proj(a);
      const [blo, bhi] = proj(b);
      if (alo - bhi >= gap || blo - ahi >= gap) return false;
    }
  }
  return true;
}

/**
 * Whether the box over `outline` from `bottom` to `top` crosses the church's canvas u extent. The
 * box's corners bound its projected u span: u is monotonic in x along every depth slice.
 */
function hidesChurch(outline: readonly Vec2[], bottom: number, top: number): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, z] of outline) {
    for (const y of [bottom, top]) {
      const uv = projectToCanvas([x, y, z]).uv;
      if (uv === null) return true;
      lo = Math.min(lo, uv[0]);
      hi = Math.max(hi, uv[0]);
    }
  }
  return hi >= CHURCH_U_EXTENT[0] && lo <= CHURCH_U_EXTENT[1];
}

/** Maps t in [0, 1) onto the house u range: the frame minus its edges and the church band. */
function houseU(t: number): number {
  const left = CHURCH_U_BAND[0] - U_EDGE;
  const right = 1 - U_EDGE - CHURCH_U_BAND[1];
  const s = t * (left + right);
  return s < left ? U_EDGE + s : CHURCH_U_BAND[1] + (s - left);
}

/** Points along each edge of a closed polygon, at most `TERRAIN_CELL` apart, corners included. */
export function edgeSamples(poly: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i] as Vec2;
    const [bx, bz] = poly[(i + 1) % poly.length] as Vec2;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / TERRAIN_CELL));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

/** A grid over an axis-aligned rectangle, at most half a terrain cell apart, edges included. */
function gridSamples(x0: number, x1: number, z0: number, z1: number): Vec2[] {
  const nx = Math.max(1, Math.ceil((x1 - x0) / (TERRAIN_CELL / 2)));
  const nz = Math.max(1, Math.ceil((z1 - z0) / (TERRAIN_CELL / 2)));
  const out: Vec2[] = [];
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) out.push([x0 + ((x1 - x0) * i) / nx, z0 + ((z1 - z0) * j) / nz]);
  }
  return out;
}

const rect = (x0: number, x1: number, z0: number, z1: number): Vec2[] => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
];

interface ChurchPlan {
  readonly record: ChurchRecord;
  readonly frame: LocalFrame;
  readonly tipHeight: number;
  readonly towerTop: number;
}

/**
 * Fits the church: the steeple tip on the painted apex ray, the nave behind the tower. Tries apex
 * nudges smallest first, then distances far to near, then nave lengths long to short; the first
 * meeting the steeple height, reach and burial bounds wins. Otherwise the nearest miss is kept,
 * marked unfitted.
 */
function placeChurch(heightAt: Terrain['heightAt']): ChurchPlan {
  const c = CHURCH;
  let fallback: { plan: ChurchPlan; miss: number } | null = null;
  for (const nudge of c.apexNudges) {
    for (const dist of c.distances) {
      const tip = rayPointAt(CHURCH_APEX_UV[0], CHURCH_APEX_UV[1] + nudge, dist);
      for (const [side, naveLength] of c.naves) {
        const x0 = tip[0] - c.naveLeft;
        const x1 = tip[0] + c.naveRight;
        const tz0 = tip[2] - c.towerHalf;
        const tz1 = tip[2] + c.towerHalf;
        const nz0 = side === 'behind' ? tz0 - naveLength : tz1;
        const nz1 = side === 'behind' ? tz0 : tz1 + naveLength;
        const z0 = Math.min(tz0, nz0);
        const z1 = Math.max(tz1, nz1);
        const tower = rect(tip[0] - c.towerHalf, tip[0] + c.towerHalf, tz0, tz1);
        const naveWalls = rect(x0, x1, nz0, nz1);
        const base = Math.min(
          ...[...edgeSamples(tower), ...edgeSamples(naveWalls)].map(([x, z]) => heightAt(x, z)),
        );
        const burial =
          Math.max(
            ...[
              ...gridSamples(tip[0] - c.towerHalf, tip[0] + c.towerHalf, tz0, tz1),
              ...gridSamples(x0, x1, nz0, nz1),
            ].map(([x, z]) => heightAt(x, z)),
          ) - base;
        const outline = rect(x0 - c.overhang, x1 + c.overhang, z0 - c.overhang, z1 + c.overhang);
        const reach = Math.max(...outline.map(([x, z]) => Math.hypot(x, z)));
        const tipHeight = tip[1] - base;
        const fitted =
          tipHeight >= c.minSteeple &&
          tipHeight <= c.maxSteeple &&
          reach <= CHURCH_MAX_REACH &&
          burial <= CHURCH_MAX_BURIAL;
        const plan: ChurchPlan = {
          record: {
            center: [(x0 + x1) / 2, base, (z0 + z1) / 2],
            footprint: rect(x0, x1, z0, z1),
            walls: [tower, naveWalls],
            outline,
            steepleTip: tip,
            steepleWidth: 2 * c.towerHalf,
            naveRidge: c.naveEave + c.naveRise,
            naveLength,
            naveSide: side,
            fitted,
          },
          frame: { cx: tip[0], cz: tip[2], base, yaw: 0 },
          tipHeight,
          towerTop: c.naveEave + c.naveRise + c.towerOverRidge,
        };
        if (fitted) return plan;
        const miss =
          Math.max(0, burial - CHURCH_MAX_BURIAL) +
          Math.max(0, reach - CHURCH_MAX_REACH) +
          Math.max(0, c.minSteeple - tipHeight, tipHeight - c.maxSteeple);
        if (fallback === null || miss < fallback.miss) fallback = { plan, miss };
      }
    }
  }
  return (fallback as NonNullable<typeof fallback>).plan;
}

function buildChurch(m: MeshBuilder, church: ChurchPlan): void {
  const c = CHURCH;
  const { frame, tipHeight, towerTop } = church;
  const { naveLength, naveSide } = church.record;
  pushSteeple(m, frame, c.towerHalf, towerTop, tipHeight);
  // Nave: its ridge runs along world z, so build it with a quarter turn.
  const naveCx = frame.cx + (c.naveRight - c.naveLeft) / 2;
  const naveCz = frame.cz + (naveSide === 'behind' ? -1 : 1) * (c.towerHalf + naveLength / 2);
  const nave: LocalFrame = { cx: naveCx, cz: naveCz, base: frame.base, yaw: Math.PI / 2 };
  const box: GableBox = {
    width: naveLength,
    depth: c.naveLeft + c.naveRight,
    eave: c.naveEave,
    rise: c.naveRise,
    overhang: c.overhang,
  };
  pushGableWalls(m, nave, box);
  pushGableRoof(m, nave, box);
}

/** Lays out the seeded village and church on `terrain` and builds their per-layer geometry. */
export function createVillage(seed: number, terrain: Pick<Terrain, 'heightAt'>): Village {
  const rand = mulberry32(seed ^ 0x51ed270b);
  const { heightAt } = terrain;
  const church = placeChurch(heightAt);
  const taken: (readonly Vec2[])[] = [church.record.outline];

  const houses: HouseRecord[] = [];
  const boxes: { frame: LocalFrame; box: GableBox; groundTop: number }[] = [];
  /**
   * One seeded try at a house targeting canvas u: fixed size, pitch and yaw, then a scan along the
   * painter's ray over the band's distances, from a seeded start, for the first spot that fits.
   */
  const tryHouse = (u: number): boolean => {
    const below = u > 0.85 ? V_BELOW_FAR_RIGHT : V_BELOW;
    const v = rooflineV(u) - below + rand() * (below + V_ABOVE);
    const width = 3.4 + rand() * 2;
    const depth = 3 + rand() * 1.4;
    const pitch = ((35 + rand() * 10) * Math.PI) / 180;
    const turn = (rand() < 0.5 ? 0 : Math.PI / 2) + (rand() - 0.5) * 0.6;
    const start = rand();
    for (let step = 0; step < DISTANCE_STEPS; step++) {
      const t = (start + step / DISTANCE_STEPS) % 1;
      const dist = VILLAGE_BAND.min + t * (VILLAGE_BAND.max - VILLAGE_BAND.min);
      if (placeAt(u, v, dist, width, depth, pitch, turn)) return true;
    }
    return false;
  };
  /** Places the house with its ridge top at the ray point, if it fits there; true when placed. */
  const placeAt = (
    u: number,
    v: number,
    dist: number,
    width: number,
    depth: number,
    pitch: number,
    turn: number,
  ): boolean => {
    const top = rayPointAt(u, v, dist);
    const yaw = Math.atan2(-top[0], -top[2]) + turn;
    const frame0: LocalFrame = { cx: top[0], cz: top[2], base: 0, yaw };
    const ground = edgeSamples(cornersXZ(frame0, width / 2, depth / 2)).map(([x, z]) =>
      heightAt(x, z),
    );
    const base = Math.min(...ground);
    const ridgeHeight = top[1] - base;
    if (ridgeHeight < HOUSE_HEIGHT.min || ridgeHeight > HOUSE_HEIGHT.max) return false;
    const rise = Math.min((depth / 2) * Math.tan(pitch), ridgeHeight - MIN_EAVE);
    const eave = ridgeHeight - rise;
    const groundTop = Math.max(...ground) - base;
    if (eave - groundTop < MIN_CLEAR_WALL) return false;
    const outline = cornersXZ(frame0, width / 2 + ROOF_OVERHANG, depth / 2 + ROOF_OVERHANG);
    if (hidesChurch(outline, base, top[1])) return false;
    if (taken.some((o) => outlinesTouch(outline, o, OUTLINE_GAP))) return false;
    taken.push(outline);
    houses.push({
      center: [top[0], base, top[2]],
      yaw,
      width,
      depth,
      eaveHeight: eave,
      ridgeHeight,
      outline,
      roofTop: top,
    });
    boxes.push({
      frame: { ...frame0, base },
      box: { width, depth, eave, rise, overhang: ROOF_OVERHANG },
      groundTop,
    });
    return true;
  };
  for (let slot = 0; slot < HOUSE_COUNT; slot++) {
    for (let k = 0; k < TRIES_PER_SLOT; k++) {
      if (tryHouse(houseU((slot + rand()) / HOUSE_COUNT))) break;
    }
  }
  for (let k = 0; k < FILL_TRIES && houses.length < HOUSE_COUNT; k++) tryHouse(houseU(rand()));

  const building = createMeshBuilder();
  const roof = createMeshBuilder();
  const glass = createMeshBuilder();
  const churchMesh = createMeshBuilder();
  const windows: WindowRecord[] = [];
  boxes.forEach(({ frame, box, groundTop }, house) => {
    pushGableWalls(building, frame, box);
    pushGableRoof(roof, frame, box);
    const y = (groundTop + box.eave) / 2;
    const walls: { lx: number; lz: number; span: number; onGable: boolean }[] = [
      { lx: 0, lz: 1, span: box.width, onGable: false },
      { lx: 0, lz: -1, span: box.width, onGable: false },
      { lx: 1, lz: 0, span: box.depth, onGable: true },
      { lx: -1, lz: 0, span: box.depth, onGable: true },
    ];
    walls.forEach((w, wi) => {
      const count = Math.max(1, Math.min(3, Math.floor(w.span / 2.2)));
      const out = (w.onGable ? box.width : box.depth) / 2 + WINDOW_OFFSET;
      for (let k = 0; k < count; k++) {
        // The first window of the first wall is always lit, so every house shows at least one.
        if (!(wi === 0 && k === 0) && rand() < 0.3) continue;
        const t = ((k + 0.5) / count - 0.5) * w.span;
        // Along the wall: local x on the long walls, local z on the gables.
        const ax = w.onGable ? 0 : 1;
        const az = w.onGable ? 1 : 0;
        const cx = w.lx * out + ax * t;
        const cz = w.lz * out + az * t;
        const P = (da: number, dy: number): ReturnType<typeof toWorld> =>
          toWorld(frame, cx + ax * da, y + dy, cz + az * da);
        const hw = WINDOW_W / 2;
        const hh = WINDOW_H / 2;
        const normal = toWorldDir(frame, w.lx, 0, w.lz);
        pushQuad(glass, P(-hw, -hh), P(hw, -hh), P(hw, hh), P(-hw, hh), normal);
        windows.push({
          house,
          center: toWorld(frame, cx, y, cz),
          normal,
          width: WINDOW_W,
          height: WINDOW_H,
          onGable: w.onGable,
        });
      }
    });
  });
  buildChurch(churchMesh, church);

  const windowGeometry = toGeometry(glass, 'window');
  windowGeometry.userData.emissive = true;
  windowGeometry.userData.color = WINDOW_COLOR;
  return {
    seed,
    houses,
    church: church.record,
    windows,
    geometries: Object.freeze({
      building: toGeometry(building, 'building'),
      roof: toGeometry(roof, 'roof'),
      window: windowGeometry,
      church: toGeometry(churchMesh, 'church'),
    }),
  };
}
