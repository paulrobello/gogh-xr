/**
 * The painter's camera: the vantage that reproduces the Starry Night framing, and the projection
 * of world points onto the canvas. Every Phase 2 generator takes its colours and stroke directions
 * through it. Pure math over plain tuples, so it runs in unit tests without WebGL.
 *
 * World: metres, +Y up, the painter's spot at the origin facing −Z.
 * UV (as in src/demo/canvas/field.ts): u left to right, v bottom to top, (0, 0) the painting's
 * bottom-left corner. regions.json has v pointing down: convert with v = 1 − v_json.
 */
import { REGION, type RegionId } from '../../demo/canvas/field';
import type { Vec3 } from '../../render/strokes/frame';

export type Vec2 = readonly [number, number];

/** Ground at the painter's spot. The terrain conforms to it. */
export const PAINTER_SPOT: Vec3 = Object.freeze([0, 0, 0]) as Vec3;
/** Eye height above the spot, metres. */
export const EYE_HEIGHT: number = 1.6;
/** The camera's centre of projection. */
export const PAINTER_EYE: Vec3 = Object.freeze([
  PAINTER_SPOT[0],
  PAINTER_SPOT[1] + EYE_HEIGHT,
  PAINTER_SPOT[2],
]) as Vec3;

/** The scan's pixel aspect (3840 × 3041), which every bake raster shares. */
export const CANVAS_ASPECT: number = 3840 / 3041;

/**
 * Vertical field of view, degrees. Must sit in the 45–70° range of a plausible painter's view;
 * 60° is near the eye's comfortable field and keeps the pitch modest (about 14.25°).
 */
export const CANVAS_FOV_Y_DEG: number = 60;

/**
 * Canvas v of the true horizon (level rays at infinity). Must lie in the distant ridge's band
 * (regions.json hills top edge, v_down 0.50–0.72) and above the central village roofline (v_down
 * 0.737–0.768 at u 0.45–0.6), which is below eye level. v_down 0.72, the band's bottom edge: only
 * the ridge's far left (v_down up to 0.726 at u 0.11–0.17) dips under it, where the plain meets
 * the horizon.
 */
export const HORIZON_V: number = 0.28;

const TAN_HALF_Y = Math.tan((CANVAS_FOV_Y_DEG * Math.PI) / 360);
const TAN_HALF_X = CANVAS_ASPECT * TAN_HALF_Y;

/**
 * Upward tilt of the optical axis, radians, derived so a level ray lands exactly on HORIZON_V:
 * tan(pitch) = (1 − 2·HORIZON_V)·tan(fov / 2).
 */
export const CANVAS_PITCH: number = Math.atan((1 - 2 * HORIZON_V) * TAN_HALF_Y);

const COS_P = Math.cos(CANVAS_PITCH);
const SIN_P = Math.sin(CANVAS_PITCH);

export interface CanvasProjection {
  /**
   * Canvas uv of the point. Outside [0, 1] when the point is in front of the eye but off the
   * frame; null on or behind the eye plane, where no projection exists.
   */
  readonly uv: Vec2 | null;
  /** In front of the eye and inside the frame, edges included. */
  readonly inFrustum: boolean;
}

/** Projects a world point through the painter's camera onto the canvas. No near or far plane. */
export function projectToCanvas(point: Vec3): CanvasProjection {
  const dx = point[0] - PAINTER_EYE[0];
  const dy = point[1] - PAINTER_EYE[1];
  const dz = point[2] - PAINTER_EYE[2];
  // Camera basis: right (1, 0, 0), up (0, cos p, sin p), forward (0, sin p, −cos p).
  const depth = dy * SIN_P - dz * COS_P;
  if (!(depth > 0)) return { uv: null, inFrustum: false };
  const up = dy * COS_P + dz * SIN_P;
  const u = 0.5 + (0.5 * dx) / (depth * TAN_HALF_X);
  const v = 0.5 + (0.5 * up) / (depth * TAN_HALF_Y);
  return { uv: [u, v], inFrustum: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
}

/** Unit world direction from PAINTER_EYE through canvas (u, v); the inverse of projectToCanvas. */
export function canvasRay(u: number, v: number): Vec3 {
  const x = (2 * u - 1) * TAN_HALF_X;
  const y = (2 * v - 1) * TAN_HALF_Y;
  const wy = y * COS_P + SIN_P;
  const wz = y * SIN_P - COS_P;
  const len = Math.hypot(x, wy, wz);
  return [x / len, wy / len, wz / len];
}

/** World surface layers that take their paint from the canvas. Stars and moon are anchors. */
export type WorldLayer =
  | 'terrain'
  | 'building'
  | 'roof'
  | 'window'
  | 'church'
  | 'cypress'
  | 'sky'
  | 'haze';

/** The canvas region each world layer reads, and extrapolates from outside the frame. */
export const LAYER_REGION: Readonly<Record<WorldLayer, RegionId>> = Object.freeze({
  terrain: REGION.hills,
  building: REGION.village,
  roof: REGION.village,
  window: REGION.village,
  church: REGION.church,
  cypress: REGION.cypress,
  sky: REGION.sky,
  haze: REGION.sky,
});
