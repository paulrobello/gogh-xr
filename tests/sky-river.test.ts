/**
 * The sky river's pure parts (src/motion/sky-river.ts): the rotation it bakes, the guide, the
 * frame distance, the kept wheels and their sense, on a synthetic orientation field.
 */
import { describe, expect, test } from 'vitest';
import {
  SKY_RIVER_DRIFT_SHARE,
  SKY_RIVER_EDGE_BAND,
  SKY_RIVER_MAX_CURVATURE,
  SKY_RIVER_PATHS,
  SKY_RIVER_SPEED,
  SKY_RIVER_WAVELENGTH,
  SKY_RIVER_WHEELS,
  type SkyRiverField,
  skyRiverBake,
  skyRiverFrameDistance,
  skyRiverGuide,
} from '../src/motion/sky-river';
import { SKY_WHEELS, skyWheelEdge } from '../src/motion/sky-swirl';
import {
  canvasRay,
  PAINTER_EYE,
  projectToCanvas,
} from '../src/paintings/starry-night/canvas-camera';

type Vec3 = [number, number, number];
const deg = Math.PI / 180;
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const uvOf = (d: Vec3) =>
  projectToCanvas([PAINTER_EYE[0] + d[0], PAINTER_EYE[1] + d[1], PAINTER_EYE[2] + d[2]]).uv;

/** A field whose painted orientation is `angle` everywhere, fully coherent. */
function uniformField(angle: number): SkyRiverField {
  const n = 16 * 16;
  return {
    width: 16,
    height: 16,
    x: new Float32Array(n).fill(Math.cos(2 * angle)),
    y: new Float32Array(n).fill(Math.sin(2 * angle)),
  };
}

describe('sky river', () => {
  test('the bake is a rotation: the centre moves along the stroke direction at the river speed, and turns at its curvature', () => {
    const field = uniformField(0.3);
    for (const [u, v] of [
      [0.2, 0.8],
      [0.6, 0.85],
      [0.45, 0.62],
    ]) {
      const d = canvasRay(u, v) as Vec3;
      const bake = skyRiverBake(field, d);
      const velocity = cross(bake.omega as Vec3, d);
      expect(dot(velocity, d)).toBeCloseTo(0, 12);
      expect(Math.hypot(...velocity)).toBeCloseTo(bake.amplitude * SKY_RIVER_SPEED, 12);
      expect(bake.amplitude).toBeLessThanOrEqual(1 + 1e-12);
      expect(Math.abs(bake.curvature)).toBeLessThanOrEqual(SKY_RIVER_MAX_CURVATURE);
      if (bake.frame < -3 * deg) {
        // ω · d̂ = σ A v κ: the turn about the view ray is the path's curvature rate.
        expect(dot(bake.omega as Vec3, d)).toBeCloseTo(
          bake.sign * bake.amplitude * SKY_RIVER_SPEED * bake.curvature,
          12,
        );
      }
    }
  });

  test('the guide heads along each polyline at its points, and the drift far from them', () => {
    for (const path of SKY_RIVER_PATHS) {
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1];
        const b = path.points[i];
        const mid = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
        const l = Math.hypot(...mid);
        const d: Vec3 = [mid[0] / l, mid[1] / l, mid[2] / l];
        const chord: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const g = skyRiverGuide(d).heading as Vec3;
        expect(dot(g, chord) / Math.hypot(...chord)).toBeGreaterThan(0);
      }
    }
    // Behind the painter the guide is the drift about the vertical.
    const back: Vec3 = [0, 0.3, Math.sqrt(1 - 0.09)];
    const g = skyRiverGuide(back).heading as Vec3;
    expect(dot(g, [-back[2], 0, back[0]]) / Math.hypot(back[0], back[2])).toBeGreaterThan(0.999);
  });

  test('the stream coordinate rises along the river', () => {
    let last = -Infinity;
    for (const path of SKY_RIVER_PATHS) {
      for (const s of path.s) {
        expect(s).toBeGreaterThan(last);
        last = s;
      }
    }
    // 12 bands per turn, so the background coordinate's 2π wrap behind the painter has no seam.
    expect((2 * Math.PI) / SKY_RIVER_WAVELENGTH).toBe(12);
  });

  test('the frame distance is negative inside the canvas, about the angle past an edge outside, and large behind', () => {
    expect(skyRiverFrameDistance(canvasRay(0.5, 0.5) as Vec3)).toBeLessThan(-25 * deg);
    expect(skyRiverFrameDistance(canvasRay(0.99, 0.5) as Vec3)).toBeLessThan(0);
    expect(skyRiverFrameDistance(canvasRay(1.01, 0.5) as Vec3)).toBeGreaterThan(0);
    const past = skyRiverFrameDistance(canvasRay(1.2, 0.5) as Vec3);
    expect(past).toBeGreaterThan(4 * deg);
    expect(past).toBeLessThan(10 * deg);
    expect(skyRiverFrameDistance([0, 0, 1])).toBeGreaterThan(120 * deg);
  });

  test('past the edge band the whole dome drifts about the vertical at the drift share', () => {
    const field = uniformField(0.3);
    for (const d of [
      [0, 0, 1],
      [1, 0, 0],
      [-0.6, 0.6, Math.sqrt(1 - 0.72)],
    ] as Vec3[]) {
      const bake = skyRiverBake(field, d);
      expect(bake.frame).toBeGreaterThan(SKY_RIVER_EDGE_BAND);
      expect(bake.omega[0]).toBeCloseTo(0, 15);
      expect(bake.omega[1]).toBeCloseTo(-SKY_RIVER_DRIFT_SHARE * SKY_RIVER_SPEED, 15);
      expect(bake.omega[2]).toBeCloseTo(0, 15);
    }
  });

  test('the river arms keep the small right swirl, the moon and the large star, and drop the big swirl', () => {
    expect(SKY_RIVER_WHEELS).toEqual(SKY_WHEELS.slice(1));
    expect(SKY_RIVER_WHEELS.map((w) => w.note)).not.toContain(SKY_WHEELS[0].note);
    expect(SKY_RIVER_SPEED).toBe(SKY_WHEELS[1].rimSpeed);
    expect((SKY_RIVER_SPEED * 180) / Math.PI).toBeCloseTo(0.469, 3);
  });

  test('the small right swirl already turns clockwise on screen, as Paul drew it', () => {
    const w = SKY_RIVER_WHEELS[0];
    const centre = uvOf(w.axis as Vec3);
    expect(centre).not.toBeNull();
    const r = 0.8 * skyWheelEdge(w);
    const rate = 2 * Math.PI * w.rate;
    const omega: Vec3 = [w.axis[0] * rate, w.axis[1] * rate, w.axis[2] * rate];
    // Points above, right of, below and left of the centre on the canvas, and the way each moves.
    for (const [du, dv, eu, ev] of [
      [0, 1, 1, 0],
      [1, 0, 0, -1],
      [0, -1, -1, 0],
      [-1, 0, 0, 1],
    ]) {
      const c = centre as readonly [number, number];
      const d = canvasRay(c[0] + du * r, c[1] + dv * r * 1.25) as Vec3;
      const v = cross(omega, d);
      const q = uvOf([d[0] + 1e-3 * v[0], d[1] + 1e-3 * v[1], d[2] + 1e-3 * v[2]]) as readonly [
        number,
        number,
      ];
      const p = uvOf(d) as readonly [number, number];
      expect((q[0] - p[0]) * eu + (q[1] - p[1]) * ev).toBeGreaterThan(0);
    }
  });

  test('a kept wheel member has no river motion', () => {
    const field = uniformField(0.3);
    for (const w of SKY_RIVER_WHEELS) {
      const bake = skyRiverBake(field, w.axis as Vec3);
      expect(bake.member).toBeGreaterThanOrEqual(0);
      expect(bake.omega).toEqual([0, 0, 0]);
    }
  });
});
