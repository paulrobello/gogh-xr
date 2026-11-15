/**
 * The café painter's camera: the vantage whose frame is exactly the scan, and the projection
 * between world points and canvas points. The set is authored by casting canvas points onto planes
 * through it, and the paint material projects the scan back through it, so the two agree by
 * construction. Pure math over plain tuples, so it runs in unit tests without WebGL.
 *
 * World: metres, +Y up, the painter's spot at the origin, the street's outer terrace edge along -Z.
 * Canvas: u left to right, v top to bottom, (0, 0) the scan's top-left corner.
 */
import type { Vec3 } from '../../render/strokes/frame';

export type CanvasPoint = readonly [number, number];

/** Width over height of the scan as shipped, 1280 × 1596. */
export const CANVAS_ASPECT: number = 1280 / 1596;
export const EYE_HEIGHT: number = 1.6;
export const PAINTER_EYE: Vec3 = [0, EYE_HEIGHT, 0];
/**
 * Vertical field of view, degrees. The lens only scales depth along the view axis: lateral sizes
 * and heights follow from the eye height alone. 60° puts the terrace about 6 to 22 m ahead.
 */
export const CANVAS_FOV_Y_DEG: number = 60;
/**
 * Where lines along the street vanish on the canvas: the terrace's outer edge, the awning's outer
 * edge and the right-hand rooflines meet here. The standing figures' heads sit on its v, so the
 * eye is at head height.
 */
export const STREET_VANISH: CanvasPoint = [0.51, 0.55];

/** Focal length in canvas heights. */
const FOCAL = 0.5 / Math.tan((CANVAS_FOV_Y_DEG * Math.PI) / 360);
/** Radians, positive looks up: puts the level street axis on STREET_VANISH's v. */
export const CANVAS_PITCH: number = Math.atan((STREET_VANISH[1] - 0.5) / FOCAL);
/** Radians, positive turns left: puts the street axis on STREET_VANISH's u. */
export const CANVAS_YAW: number = Math.atan(
  ((STREET_VANISH[0] - 0.5) * CANVAS_ASPECT * Math.cos(CANVAS_PITCH)) / FOCAL,
);

const SIN_YAW = Math.sin(CANVAS_YAW);
const COS_YAW = Math.cos(CANVAS_YAW);
const SIN_PITCH = Math.sin(CANVAS_PITCH);
const COS_PITCH = Math.cos(CANVAS_PITCH);

/** The camera's unit axes in world space. */
export const CAMERA_RIGHT: Vec3 = [COS_YAW, 0, -SIN_YAW];
export const CAMERA_UP: Vec3 = [SIN_YAW * SIN_PITCH, COS_PITCH, COS_YAW * SIN_PITCH];
export const CAMERA_FORWARD: Vec3 = [-SIN_YAW * COS_PITCH, SIN_PITCH, -COS_YAW * COS_PITCH];
/** Canvas units per unit of tan: u takes [0], v takes [1]. */
export const CANVAS_LENS: CanvasPoint = [FOCAL / CANVAS_ASPECT, FOCAL];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The world direction through canvas (u, v), with unit length along the optical axis. */
export function canvasRay(u: number, v: number): Vec3 {
  const x = (u - 0.5) / CANVAS_LENS[0];
  const y = (0.5 - v) / CANVAS_LENS[1];
  return [
    CAMERA_FORWARD[0] + x * CAMERA_RIGHT[0] + y * CAMERA_UP[0],
    CAMERA_FORWARD[1] + x * CAMERA_RIGHT[1] + y * CAMERA_UP[1],
    CAMERA_FORWARD[2] + x * CAMERA_RIGHT[2] + y * CAMERA_UP[2],
  ];
}

export interface CanvasHit {
  readonly u: number;
  readonly v: number;
  /** Distance along the optical axis, metres. Zero or less is behind the painter. */
  readonly depth: number;
}

/** Where a world point lands on the canvas. */
export function toCanvas(point: Vec3): CanvasHit {
  const q: Vec3 = [point[0] - PAINTER_EYE[0], point[1] - PAINTER_EYE[1], point[2] - PAINTER_EYE[2]];
  const depth = dot(q, CAMERA_FORWARD);
  return {
    u: 0.5 + (dot(q, CAMERA_RIGHT) / depth) * CANVAS_LENS[0],
    v: 0.5 - (dot(q, CAMERA_UP) / depth) * CANVAS_LENS[1],
    depth,
  };
}

/** The point where the ray through canvas (u, v) meets the plane through `point` with `normal`. */
export function onPlane(u: number, v: number, point: Vec3, normal: Vec3): Vec3 {
  const ray = canvasRay(u, v);
  const slope = dot(ray, normal);
  const t =
    dot([point[0] - PAINTER_EYE[0], point[1] - PAINTER_EYE[1], point[2] - PAINTER_EYE[2]], normal) /
    slope;
  if (!(t > 0)) throw new Error(`Canvas (${u}, ${v}) never meets that plane in front of the eye`);
  return [PAINTER_EYE[0] + ray[0] * t, PAINTER_EYE[1] + ray[1] * t, PAINTER_EYE[2] + ray[2] * t];
}

/** The point at height `y` under canvas (u, v): the ground by default. */
export function onLevel(u: number, v: number, y = 0): Vec3 {
  return onPlane(u, v, [0, y, 0], [0, 1, 0]);
}

/** The point on the frontal plane at world `z` under canvas (u, v). */
export function onFrontal(u: number, v: number, z: number): Vec3 {
  return onPlane(u, v, [0, 0, z], [0, 0, 1]);
}
