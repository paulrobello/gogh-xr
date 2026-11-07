/**
 * e2e only (R-P4g): the TS mirror's prediction of where the sky swirl moves the dome stroke seen
 * at a canvas point in the painter view. main.ts installs it as `window.__goghSkyShift` in
 * `--mode e2e` builds, where the e2e spec can call it: Playwright cannot load sky-swirl.ts itself,
 * which imports regions.json.
 */
import { SKY_RINGS, skyRing } from '../motion/sky-rings';
import { skySwirl } from '../motion/sky-swirl';
import { canvasRay, PAINTER_EYE, projectToCanvas } from '../paintings/starry-night/canvas-camera';
import { SKY_DOME_RADIUS } from '../world/sky';

/**
 * The canvas shift, [du, dv] with v down, of the dome point at canvas (u, vDown) under the sky
 * swirl at `calm`, motion time `time` and phase `phase`. Null when the moved point is off the eye's
 * front.
 */
export function predictSkyShift(
  u: number,
  vDown: number,
  calm: number,
  time: number,
  phase: number,
): [number, number] | null {
  const ray = canvasRay(u, 1 - vDown);
  const p: [number, number, number] = [
    PAINTER_EYE[0] + ray[0] * SKY_DOME_RADIUS,
    PAINTER_EYE[1] + ray[1] * SKY_DOME_RADIUS,
    PAINTER_EYE[2] + ray[2] * SKY_DOME_RADIUS,
  ];
  const m = skySwirl(p, [-ray[0], -ray[1], -ray[2]], phase, time);
  const uv = projectToCanvas([
    p[0] + calm * m.offset[0],
    p[1] + calm * m.offset[1],
    p[2] + calm * m.offset[2],
  ]).uv;
  return uv ? [uv[0] - u, 1 - uv[1] - vDown] : null;
}

/** `predictRingShift`'s answer: the shift and brightening of one dome point under one ring. */
export interface RingShift {
  /** The ring centre's canvas point, [u, v] with v down. */
  readonly centre: [number, number];
  /** The ring's rim radius on the canvas, in canvas u units. */
  readonly rim: number;
  /** The point's canvas shift, [du, dv] with v down. */
  readonly shift: [number, number];
  /** The colour gain the ring adds at the point, `skyRing`'s bright. */
  readonly bright: number;
}

/**
 * e2e only (P4.3, I2): the TS mirror's ring motion of the dome point at canvas (u, vDown) under
 * ring `k` of SKY_RINGS at motion time `time` and calm 1. Null when a point is off the eye's front.
 */
export function predictRingShift(
  k: number,
  u: number,
  vDown: number,
  time: number,
): RingShift | null {
  const ring = SKY_RINGS[k];
  const ray = canvasRay(u, 1 - vDown);
  const p: [number, number, number] = [
    PAINTER_EYE[0] + ray[0] * SKY_DOME_RADIUS,
    PAINTER_EYE[1] + ray[1] * SKY_DOME_RADIUS,
    PAINTER_EYE[2] + ray[2] * SKY_DOME_RADIUS,
  ];
  const m = skyRing(ring, p, time);
  const moved = projectToCanvas([p[0] + m.offset[0], p[1] + m.offset[1], p[2] + m.offset[2]]).uv;
  const c = ring.centre;
  const centre = projectToCanvas(c).uv;
  // The rim point along the halo's own tangent u axis (sky-halo.vert.glsl).
  const n = [c[0] - PAINTER_EYE[0], c[1] - PAINTER_EYE[1], c[2] - PAINTER_EYE[2]];
  const side = Math.hypot(n[2], n[0]);
  const edge = projectToCanvas([
    c[0] - (n[2] / side) * ring.outer,
    c[1],
    c[2] + (n[0] / side) * ring.outer,
  ]).uv;
  if (!moved || !centre || !edge) return null;
  return {
    centre: [centre[0], 1 - centre[1]],
    rim: Math.hypot(edge[0] - centre[0], edge[1] - centre[1]),
    shift: [moved[0] - u, 1 - moved[1] - vDown],
    bright: m.bright,
  };
}
