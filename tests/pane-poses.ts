/**
 * Poses for the window pane probe (tests/e2e/panes.spec.ts), shared with its unit checks in
 * tests/world-starry-night.test.ts. The panes are the first window of every seed-1 house whose
 * window faces the painter (15 of the 20 houses).
 *
 * Near poses stand 0.3 m out from the pane, as the R-P4o village guard does. Far poses stand where
 * the pane's overlay chunk is in the far band: its band distance (`chunkDistance` to the chunk's
 * sphere) past MID_BAND_MAX_M plus the hysteresis plus FAR_MARGIN_M, estimated here from the
 * window rectangles of the pane's 3D chunk cell. The unit test checks the real batch's band.
 */
import type { VolumeQuery } from '../src/locomotion/teleport.ts';
import { PAINTER_EYE } from '../src/paintings/starry-night/canvas-camera.ts';
import {
  CROWN_EYE_HEIGHT,
  createCrownTest,
  createVolumes,
} from '../src/paintings/starry-night/footprints.ts';
import type { WorldGeometry } from '../src/paintings/starry-night/world.ts';
import { WORLD_CELL_SIZE } from '../src/paintings/starry-night/world.ts';
import { BAND_HYSTERESIS_M, MID_BAND_MAX_M } from '../src/render/strokes/bands.ts';
import type { WindowRecord } from '../src/world/village.ts';

export type Vec3 = [number, number, number];

export interface PanePose {
  readonly house: number;
  readonly eye: Vec3;
  /** Yaw 0 faces -Z, as `__goghPose` takes it. */
  readonly yaw: number;
  readonly pitch: number;
}

export interface Pane {
  readonly house: number;
  readonly window: WindowRecord;
  /** The pane's four corners, world space, in perimeter order. */
  readonly corners: readonly Vec3[];
}

/** The near poses' distance out from the pane and how far the pane's centre sits above the eye. */
export const NEAR_OUT_M = 0.3;
export const NEAR_BELOW_M = 0.27;
/** Margin past the far band's entry (MID_BAND_MAX_M + BAND_HYSTERESIS_M) the estimate keeps. */
export const FAR_MARGIN_M = 1.5;
/** A far pose's eye stays this far from the origin, inside the 45 m boundary. */
export const FAR_MAX_RADIUS_M = 44;
/** The desktop camera (src/main.ts) and the probe's viewport, about Quest pixel density. */
export const PROBE_FOV_DEG = 70;
export const PROBE_VIEW = { width: 3200, height: 1800 } as const;
/** A far pane smaller than this on screen is skipped as too small to judge. */
export const MIN_PANE_PX = 400;

export function panes(world: Pick<WorldGeometry, 'village'>): Pane[] {
  const { village } = world;
  const out: Pane[] = [];
  village.houses.forEach((_, house) => {
    const w = village.windows.find((x) => x.house === house);
    if (!w) throw new Error(`house ${house} has no window`);
    const [nx, , nz] = w.normal;
    const facing = nx * (PAINTER_EYE[0] - w.center[0]) + nz * (PAINTER_EYE[2] - w.center[2]);
    if (facing > 0) out.push({ house, window: w, corners: cornersOf(w) });
  });
  return out;
}

function cornersOf(w: WindowRecord): Vec3[] {
  // Horizontal along the wall: up × normal.
  const t: Vec3 = [w.normal[2], 0, -w.normal[0]];
  const len = Math.hypot(t[0], t[2]);
  const hw = w.width / 2 / len;
  const hh = w.height / 2;
  const c = w.center;
  return [
    [c[0] - t[0] * hw, c[1] - hh, c[2] - t[2] * hw],
    [c[0] + t[0] * hw, c[1] - hh, c[2] + t[2] * hw],
    [c[0] + t[0] * hw, c[1] + hh, c[2] + t[2] * hw],
    [c[0] - t[0] * hw, c[1] + hh, c[2] - t[2] * hw],
  ];
}

/** Facing `target` from `eye`: yaw 0 faces -Z, pitch up positive. */
function aimAt(
  eye: Vec3,
  target: readonly [number, number, number],
): { yaw: number; pitch: number } {
  const dx = target[0] - eye[0];
  const dy = target[1] - eye[1];
  const dz = target[2] - eye[2];
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

export function nearPose(pane: Pane): PanePose {
  const w = pane.window;
  const [nx, , nz] = w.normal;
  return {
    house: pane.house,
    eye: [w.center[0] + NEAR_OUT_M * nx, w.center[1] - NEAR_BELOW_M, w.center[2] + NEAR_OUT_M * nz],
    // Faces back along -normal, into the wall, level, as the guard does.
    yaw: Math.atan2(nx, nz),
    pitch: 0,
  };
}

/**
 * Screen-space corners of `points` for `pose` in pixels of PROBE_VIEW (x right, y down), or null
 * when one is behind the eye.
 */
export function project(pose: PanePose, points: readonly Vec3[]): [number, number][] | null {
  const f = PROBE_VIEW.height / 2 / Math.tan((PROBE_FOV_DEG * Math.PI) / 360);
  const cy = Math.cos(pose.yaw);
  const sy = Math.sin(pose.yaw);
  const cp = Math.cos(pose.pitch);
  const sp = Math.sin(pose.pitch);
  const out: [number, number][] = [];
  for (const p of points) {
    const dx = p[0] - pose.eye[0];
    const dy = p[1] - pose.eye[1];
    const dz = p[2] - pose.eye[2];
    // Undo the yaw about +Y, then the pitch about +X (rotation order YXZ).
    const x = cy * dx - sy * dz;
    const z1 = sy * dx + cy * dz;
    const y = cp * dy + sp * z1;
    const z = -sp * dy + cp * z1;
    if (z >= -0.1) return null;
    out.push([PROBE_VIEW.width / 2 + (f * x) / -z, PROBE_VIEW.height / 2 - (f * y) / -z]);
  }
  return out;
}

export function polygonArea(poly: readonly [number, number][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/**
 * The estimated band distance of the pane's overlay chunk from `eye`: the windows in the pane's 3D
 * WORLD_CELL_SIZE cell, their corners' box centre, and the farthest corner from it as the radius.
 */
export function overlayChunkDistance(
  world: Pick<WorldGeometry, 'village'>,
  pane: Pane,
  eye: Vec3,
): number {
  const cell = (p: readonly number[]) => p.map((v) => Math.floor(v / WORLD_CELL_SIZE)).join(',');
  const key = cell(pane.window.center);
  const pts = world.village.windows.filter((w) => cell(w.center) === key).flatMap(cornersOf);
  const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const r = Math.max(...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
  return Math.max(0, Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]) - r);
}

export interface SightTest {
  /** True when the segment from `eye` to house `house`'s pane point `p` is clear of buildings, cypress and hill. */
  clear(eye: Vec3, p: readonly [number, number, number], house: number): boolean;
  /** True when a viewer may stand with the eye at `eye`: outside every building and crown. */
  standable(eye: Vec3): boolean;
}

/**
 * Line of sight against the village volumes (each footprint grown by 0.3 m, up to its walls and
 * roof), the cypress crowns as columns up to the tree's top (each ring grown by 0.3 m) and the
 * terrain, sampled every 0.25 m. The pane's own house is tested at its bare walls, since its grown
 * volume holds the pane 2 cm off the wall, and the last 0.5 m before the pane is not tested.
 */
export function sightTest(
  world: Pick<WorldGeometry, 'village' | 'terrain' | 'cypress'>,
): SightTest {
  const { village } = world;
  const volumes = createVolumes(village);
  const perHouse = new Map<number, { own: VolumeQuery; rest: VolumeQuery }>();
  const split = (house: number) => {
    let entry = perHouse.get(house);
    if (!entry) {
      entry = {
        own: createVolumes({ houses: [village.houses[house]], church: village.church }, 0),
        rest: createVolumes({
          houses: village.houses.filter((_, i) => i !== house),
          church: village.church,
        }),
      };
      perHouse.set(house, entry);
    }
    return entry;
  };
  const { heightAt } = world.terrain;
  const crown = createCrownTest(world.cypress, heightAt);
  const pos = world.cypress.geometry.getAttribute('position');
  let top = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
  const inTree = (x: number, y: number, z: number) => y <= top + 0.3 && crown(x, z);
  return {
    clear(eye, p, house) {
      const d = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
      const s = Math.max(0, (d - 0.5) / d);
      const b: Vec3 = [
        eye[0] + s * (p[0] - eye[0]),
        eye[1] + s * (p[1] - eye[1]),
        eye[2] + s * (p[2] - eye[2]),
      ];
      for (const q of Object.values(split(house))) {
        q.begin(...eye);
        if (q.crossing(...eye, ...b) >= 0) return false;
      }
      const n = Math.ceil((d - 0.5) / 0.25);
      for (let i = 1; i <= n; i++) {
        const t = (i / n) * s;
        const x = eye[0] + t * (p[0] - eye[0]);
        const y = eye[1] + t * (p[1] - eye[1]);
        const z = eye[2] + t * (p[2] - eye[2]);
        if (y <= heightAt(x, z) + 0.05) return false;
        if (inTree(x, y, z)) return false;
      }
      return true;
    },
    standable(eye) {
      if (volumes.at(...eye) >= 0) return false;
      return !inTree(eye[0], eye[1], eye[2]) && !inTree(eye[0], eye[1] - CROWN_EYE_HEIGHT, eye[2]);
    },
  };
}

/** Eye heights above the ground a far pose tries: standing first, then flight heights. */
const FAR_HEIGHTS = [1.6, 4, 8, 14, 20] as const;

/**
 * The far pose for each pane: of the eyes within ±75° of the pane's outward normal (5° steps), at
 * 0.5 m steps of distance, standing or at a flight height, inside FAR_MAX_RADIUS_M, standable,
 * whose estimated chunk distance clears the far band's entry by FAR_MARGIN_M and that see the
 * pane's centre and corners, the one with the largest projected pane area. null when none does.
 */
export function farPose(
  world: Pick<WorldGeometry, 'village' | 'terrain' | 'cypress'>,
  pane: Pane,
  sight: SightTest,
): PanePose | null {
  const w = pane.window;
  const az = Math.atan2(w.normal[0], w.normal[2]);
  const need = MID_BAND_MAX_M + BAND_HYSTERESIS_M + FAR_MARGIN_M;
  let best: { pose: PanePose; area: number } | null = null;
  for (const h of FAR_HEIGHTS) {
    for (let deg = -75; deg <= 75; deg += 5) {
      const a = az + (deg * Math.PI) / 180;
      for (let d = 20; d <= 90; d += 0.5) {
        const x = w.center[0] + d * Math.sin(a);
        const z = w.center[2] + d * Math.cos(a);
        if (Math.hypot(x, z) > FAR_MAX_RADIUS_M) continue;
        const eye: Vec3 = [x, world.terrain.heightAt(x, z) + h, z];
        if (overlayChunkDistance(world, pane, eye) < need) continue;
        if (!sight.standable(eye)) continue;
        const pose: PanePose = { house: pane.house, eye, ...aimAt(eye, w.center) };
        const screen = project(pose, pane.corners);
        if (!screen) continue;
        const area = polygonArea(screen);
        if (best && area <= best.area) continue;
        if (![w.center, ...pane.corners].every((p) => sight.clear(eye, p, pane.house))) continue;
        best = { pose, area };
      }
    }
    const found = best as { pose: PanePose; area: number } | null;
    if (found) return found.pose;
  }
  return null;
}
