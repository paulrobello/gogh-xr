/**
 * e2e only (R-P4g): the TS mirror's prediction of where the sky swirl moves the dome stroke seen
 * at a canvas point in the painter view. main.ts installs it as `window.__goghSkyShift` in
 * `--mode e2e` builds, where the e2e spec can call it: Playwright cannot load sky-swirl.ts itself,
 * which imports regions.json.
 */
import { SKY_MOON_RING, SKY_RINGS, skyHaloGlow, skyHaloState, skyRing } from '../motion/sky-rings';
import { SKY_WAVE_PER_TURN, skySwirl } from '../motion/sky-swirl';
import type { SkyWrap } from '../motion/variants';
import { canvasRay, PAINTER_EYE, projectToCanvas } from '../paintings/starry-night/canvas-camera';
import { anchorReach, SKY_DOME_RADIUS, skyAnchors } from '../world/sky';

/**
 * The canvas shift, [du, dv] with v down, of the dome point at canvas (u, vDown) under the sky
 * swirl at `calm`, motion time `time`, phase `phase` and wrap variant `wrap`, under `wave` at
 * `turns` waves per turn. Null when the moved point is off the eye's front.
 */
export function predictSkyShift(
  u: number,
  vDown: number,
  calm: number,
  time: number,
  phase: number,
  wrap: SkyWrap = 'base',
  turns: number = SKY_WAVE_PER_TURN,
): [number, number] | null {
  const ray = canvasRay(u, 1 - vDown);
  const p: [number, number, number] = [
    PAINTER_EYE[0] + ray[0] * SKY_DOME_RADIUS,
    PAINTER_EYE[1] + ray[1] * SKY_DOME_RADIUS,
    PAINTER_EYE[2] + ray[2] * SKY_DOME_RADIUS,
  ];
  const m = skySwirl(p, [-ray[0], -ray[1], -ray[2]], phase, time, undefined, wrap, turns);
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

/**
 * e2e only (P4.6): the TS mirror's additive halo brightness, before the tint, that halo `k` of
 * SKY_RINGS adds at canvas (u, vDown) of the painter view at motion time `time` and calm 1. The
 * halo lies on the dome's tangent plane at its anchor (sky-halo.vert.glsl), so the point is where
 * the canvas ray meets that plane. Null when the ray misses it.
 */
export function predictHaloGlow(k: number, u: number, vDown: number, time: number): number | null {
  const ring = SKY_RINGS[k];
  const ray = canvasRay(u, 1 - vDown);
  const c = ring.centre;
  const n = [c[0] - PAINTER_EYE[0], c[1] - PAINTER_EYE[1], c[2] - PAINTER_EYE[2]];
  const along = ray[0] * n[0] + ray[1] * n[1] + ray[2] * n[2];
  if (!(along > 0)) return null;
  const s = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) / along;
  const rho = Math.hypot(
    PAINTER_EYE[0] + s * ray[0] - c[0],
    PAINTER_EYE[1] + s * ray[1] - c[1],
    PAINTER_EYE[2] + s * ray[2] - c[2],
  );
  return skyHaloGlow(ring, skyHaloState(ring, time, 1), rho);
}

/**
 * The moon disc's rim in the painter view, as P4.3 measured the crescent's colour clip: the moon
 * anchor's `anchorReach(anchor, 1)` circle on the dome's tangent plane at the ring centre,
 * projected through the painter camera at `points` points, each canvas [u, vDown]. Null when a
 * point falls behind the eye.
 */
export function moonDiscRim(points: number): [number, number][] | null {
  const c = SKY_RINGS[SKY_MOON_RING].centre;
  const radius = anchorReach(skyAnchors()[SKY_MOON_RING], 1);
  const n = [c[0] - PAINTER_EYE[0], c[1] - PAINTER_EYE[1], c[2] - PAINTER_EYE[2]];
  const nl = Math.hypot(n[0], n[1], n[2]);
  for (let i = 0; i < 3; i++) n[i] /= nl;
  const ul = Math.hypot(n[2], n[0]);
  const u = [-n[2] / ul, 0, n[0] / ul];
  const v = [u[1] * n[2] - u[2] * n[1], u[2] * n[0] - u[0] * n[2], u[0] * n[1] - u[1] * n[0]];
  const rim: [number, number][] = [];
  for (let k = 0; k < points; k++) {
    const a = (k / points) * 2 * Math.PI;
    const p: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) p[i] = c[i] + radius * (Math.cos(a) * u[i] + Math.sin(a) * v[i]);
    const uv = projectToCanvas(p).uv;
    if (!uv) return null;
    rim.push([uv[0], 1 - uv[1]]);
  }
  return rim;
}
