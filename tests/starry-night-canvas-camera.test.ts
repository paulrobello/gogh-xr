import { expect, test } from 'vitest';
import { REGION } from '../src/demo/canvas/field.ts';
import {
  CANVAS_ASPECT,
  CANVAS_FOV_Y_DEG,
  CANVAS_PITCH,
  canvasRay,
  EYE_HEIGHT,
  HORIZON_V,
  LAYER_REGION,
  PAINTER_EYE,
  PAINTER_SPOT,
  projectToCanvas,
} from '../src/paintings/starry-night/canvas-camera.ts';
import type { Vec3 } from '../src/render/strokes/frame.ts';

const TAN_Y = Math.tan((CANVAS_FOV_Y_DEG * Math.PI) / 360);
const TAN_X = CANVAS_ASPECT * TAN_Y;

/**
 * World point at distance `d` along the camera-space direction (x, y, −1), rotated up by the
 * pitch about +X. Built from the exported constants by hand, independent of the module.
 */
function cameraPoint(x: number, y: number, d: number): Vec3 {
  const c = Math.cos(CANVAS_PITCH);
  const s = Math.sin(CANVAS_PITCH);
  const len = Math.hypot(x, y, 1);
  // Rx(pitch) · (x, y, −1).
  const wy = y * c + s;
  const wz = y * s - c;
  return [(x / len) * d, EYE_HEIGHT + (wy / len) * d, (wz / len) * d];
}

test('the painter stands at the origin with the eye 1.6 m up, framed at the canvas aspect', () => {
  expect(PAINTER_SPOT).toEqual([0, 0, 0]);
  expect(EYE_HEIGHT).toBe(1.6);
  expect(PAINTER_EYE).toEqual([0, 1.6, 0]);
  expect(CANVAS_ASPECT).toBeCloseTo(3750 / 3011, 12);
  expect(CANVAS_FOV_Y_DEG).toBeGreaterThanOrEqual(45);
  expect(CANVAS_FOV_Y_DEG).toBeLessThanOrEqual(70);
  // The ridge runs at v_down 0.507–0.728 in regions.json; HORIZON_V is v up.
  expect(1 - HORIZON_V).toBeGreaterThanOrEqual(0.5);
  expect(1 - HORIZON_V).toBeLessThanOrEqual(0.72);
  // The sky fills most of the canvas, so the camera looks up.
  expect(CANVAS_PITCH).toBeGreaterThan(0);
});

test('the canvas corners project to (0,0), (1,0), (0,1) and (1,1) within 1e-3', () => {
  const corners: [number, number, number, number][] = [
    [-1, -1, 0, 0],
    [1, -1, 1, 0],
    [-1, 1, 0, 1],
    [1, 1, 1, 1],
  ];
  for (const d of [2, 50, 1000]) {
    for (const [sx, sy, u, v] of corners) {
      const p = projectToCanvas(cameraPoint(sx * TAN_X, sy * TAN_Y, d));
      expect(p.uv).not.toBeNull();
      expect(p.uv?.[0]).toBeCloseTo(u, 3);
      expect(p.uv?.[1]).toBeCloseTo(v, 3);
    }
  }
});

test('the optical axis lands at the canvas centre and the true horizon at HORIZON_V', () => {
  const centre = projectToCanvas(cameraPoint(0, 0, 10));
  expect(centre.inFrustum).toBe(true);
  expect(centre.uv?.[0]).toBeCloseTo(0.5, 9);
  expect(centre.uv?.[1]).toBeCloseTo(0.5, 9);

  const horizon = projectToCanvas([0, EYE_HEIGHT, -1e7]);
  expect(horizon.inFrustum).toBe(true);
  expect(horizon.uv?.[0]).toBeCloseTo(0.5, 9);
  expect(horizon.uv?.[1]).toBeCloseTo(HORIZON_V, 6);
  // A level point off to the side stays on the horizon line.
  expect(projectToCanvas([-3e6, EYE_HEIGHT, -1e7]).uv?.[1]).toBeCloseTo(HORIZON_V, 6);
});

test('u runs left to right and v bottom to top', () => {
  const left = projectToCanvas([-1, 3, -10]);
  const right = projectToCanvas([1, 3, -10]);
  expect(left.uv?.[0]).toBeLessThan(right.uv?.[0] ?? Number.NaN);
  const low = projectToCanvas([0, 1, -10]);
  const high = projectToCanvas([0, 5, -10]);
  expect(low.uv?.[1]).toBeLessThan(high.uv?.[1] ?? Number.NaN);
});

test('a point behind the camera is not in the frustum and has no uv', () => {
  const behind = projectToCanvas([0, EYE_HEIGHT, 5]);
  expect(behind.inFrustum).toBe(false);
  expect(behind.uv).toBeNull();
  // Mirrored through the eye, an in-frame point would divide back into [0, 1]; it must not count.
  const front = cameraPoint(0.2 * TAN_X, 0.1 * TAN_Y, 10);
  const mirrored: Vec3 = [-front[0], 2 * EYE_HEIGHT - front[1], -front[2]];
  expect(projectToCanvas(front).inFrustum).toBe(true);
  expect(projectToCanvas(mirrored).inFrustum).toBe(false);
  // The eye itself has no direction.
  expect(projectToCanvas(PAINTER_EYE).inFrustum).toBe(false);
});

test('a point in front but outside the frame keeps its extended uv and is not in the frustum', () => {
  const p = projectToCanvas(cameraPoint(2 * TAN_X, 0, 10));
  expect(p.inFrustum).toBe(false);
  expect(p.uv?.[0]).toBeCloseTo(1.5, 9);
  expect(p.uv?.[1]).toBeCloseTo(0.5, 9);
  const below = projectToCanvas(cameraPoint(0, -1.2 * TAN_Y, 10));
  expect(below.inFrustum).toBe(false);
  expect(below.uv?.[1]).toBeCloseTo(-0.1, 9);
});

test('canvasRay is the unit direction from the eye that projects back to its uv', () => {
  for (const [u, v] of [
    [0, 0],
    [1, 1],
    [0.25, 0.8],
    [0.904, 1 - 0.171],
    [0.5, HORIZON_V],
  ] as const) {
    const dir = canvasRay(u, v);
    expect(Math.hypot(...dir)).toBeCloseTo(1, 12);
    for (const d of [1, 120]) {
      const p = projectToCanvas([
        PAINTER_EYE[0] + dir[0] * d,
        PAINTER_EYE[1] + dir[1] * d,
        PAINTER_EYE[2] + dir[2] * d,
      ]);
      expect(p.uv?.[0]).toBeCloseTo(u, 9);
      expect(p.uv?.[1]).toBeCloseTo(v, 9);
    }
  }
  // The horizon ray is level.
  expect(canvasRay(0.5, HORIZON_V)[1]).toBeCloseTo(0, 12);
});

test('each world layer reads its canvas region', () => {
  expect(LAYER_REGION).toEqual({
    terrain: REGION.hills,
    building: REGION.village,
    roof: REGION.village,
    window: REGION.village,
    church: REGION.church,
    cypress: REGION.cypress,
    sky: REGION.sky,
    haze: REGION.sky,
  });
  expect(Object.isFrozen(LAYER_REGION)).toBe(true);
});
