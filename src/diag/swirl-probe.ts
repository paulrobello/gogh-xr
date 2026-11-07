/**
 * e2e only (R-P4g): the TS mirror's prediction of where the sky swirl moves the dome stroke seen
 * at a canvas point in the painter view. main.ts installs it as `window.__goghSkyShift` in
 * `--mode e2e` builds, where the e2e spec can call it: Playwright cannot load sky-swirl.ts itself,
 * which imports regions.json.
 */
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
