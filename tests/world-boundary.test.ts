import { readFileSync } from 'node:fs';
import { Texture } from 'three';
import { expect, test } from 'vitest';
import { type FlowField, type Raster, REGION } from '../src/demo/canvas/field.ts';
import {
  buildCanvasHistogram,
  type CanvasSource,
} from '../src/paintings/starry-night/canvas-histogram.ts';
import { surfaceBasis, type Vec3 } from '../src/render/strokes/frame.ts';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  unpackInstance,
} from '../src/render/strokes/instance.ts';
import { createStrokeMaterial, HAZE_GROWTH } from '../src/render/strokes/material.ts';
import {
  BOUNDARY_ALTITUDE,
  BOUNDARY_RADIUS,
  boundaryFactor,
  createBoundaryHaze,
  HAZE_GROUND_MARGIN,
  HAZE_STROKE_DEFAULT,
} from '../src/world/boundary.ts';
import { createTerrain } from '../src/world/terrain.ts';

function raster(w: number, h: number, rgb: readonly number[]): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
}
const IMAGE = raster(4, 4, [40, 60, 180]);
const REGIONS = raster(4, 4, [REGION.sky, 0, 0]);
const FLOW: FlowField = {
  width: 2,
  height: 2,
  angle: new Float32Array(4).fill(0.7),
  coherence: new Float32Array(4).fill(1),
};
const SOURCE: CanvasSource = {
  image: IMAGE,
  regions: REGIONS,
  flow: FLOW,
  histogram: buildCanvasHistogram(IMAGE, REGIONS, FLOW),
};

const DIRS: Vec3[] = [
  [1, 0, 0],
  [0, 0, -1],
  [-0.6, 0.3, 0.74],
  [0.5, 0.8, 0.33],
  [0, 1, 0],
  [0.3, -0.5, 0.8],
];
const unit = (d: Vec3): Vec3 => {
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
};

test('boundaryFactor: 0 at the spot, 1 at the edge and beyond', () => {
  expect(boundaryFactor([0, 0, 0])).toBe(0);
  expect(boundaryFactor([BOUNDARY_RADIUS, 0, 0])).toBe(1);
  expect(boundaryFactor([0, 0, -80])).toBe(1);
  expect(boundaryFactor([0, BOUNDARY_ALTITUDE, 0])).toBe(1);
  expect(boundaryFactor([0, 90, 0])).toBe(1);
  expect(boundaryFactor([44, 0, 0])).toBe(0);
  expect(boundaryFactor([0, 34, 0])).toBe(0);
});

test('boundaryFactor is monotonic along rays and stays in [0, 1]', () => {
  for (const d of DIRS) {
    const u = unit(d);
    let prev = 0;
    for (let r = 0; r <= 70; r += 0.25) {
      const f = boundaryFactor([u[0] * r, u[1] * r, u[2] * r]);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
    expect(prev).toBe(1);
  }
});

test('haze: radial bounds, altitude clip, layer, inward normal', () => {
  const haze = createBoundaryHaze(SOURCE, { seed: 3, count: 4000 });
  expect(haze).toHaveLength(4000);
  for (const s of haze) {
    const r = Math.hypot(s.position[0], s.position[1], s.position[2]);
    expect(r).toBeGreaterThanOrEqual(45 - 1e-9);
    expect(r).toBeLessThanOrEqual(55 + 1e-9);
    expect(s.position[1]).toBeLessThanOrEqual(BOUNDARY_ALTITUDE + 5);
    expect(s.layer).toBe(STROKE_LAYER.sky);
    const n = s.normal;
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 6);
    const dot = (-n[0] * s.position[0] - n[1] * s.position[1] - n[2] * s.position[2]) / r;
    expect(dot).toBeCloseTo(1, 6);
    expect(Number.isFinite(s.tangent)).toBe(true);
  }
});

test('haze density rises with distance', () => {
  const haze = createBoundaryHaze(SOURCE, { seed: 5, count: 20000 });
  let inner = 0;
  let outer = 0;
  for (const s of haze) {
    if (Math.hypot(s.position[0], s.position[1], s.position[2]) < 50) inner++;
    else outer++;
  }
  expect(outer).toBeGreaterThan(inner * 1.5);
});

test('haze is deterministic per seed and defaults sensibly', () => {
  const a = createBoundaryHaze(SOURCE, { seed: 9, count: 300 });
  const b = createBoundaryHaze(SOURCE, { seed: 9, count: 300 });
  const c = createBoundaryHaze(SOURCE, { seed: 10, count: 300 });
  expect(b).toEqual(a);
  expect(c).not.toEqual(a);
  expect(HAZE_STROKE_DEFAULT).toBe(30_000);
});

test('haze tangent follows the constant flow angle in the plane perpendicular to the normal', () => {
  const haze = createBoundaryHaze(SOURCE, { seed: 4, count: 300 });
  let checked = 0;
  for (const s of haze) {
    const buffers = createStrokeBuffers(1);
    packInstance(buffers, 0, s);
    const u = unpackInstance(buffers, 0);
    const n = u.normal;
    const { b1, b2 } = surfaceBasis(n);
    const c = Math.cos(u.tangent);
    const sn = Math.sin(u.tangent);
    const dir = [0, 1, 2].map((i) => c * b1[i] + sn * b2[i]);
    expect(Math.abs(dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2])).toBeLessThan(1e-3);
    // Expected: cos(0.7) * right + sin(0.7) * up, right = world X projected into the plane.
    const rx = [1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]];
    const rl = Math.hypot(rx[0], rx[1], rx[2]);
    if (rl < 0.5) continue;
    const right = rx.map((v) => v / rl);
    const up = [
      n[1] * right[2] - n[2] * right[1],
      n[2] * right[0] - n[0] * right[2],
      n[0] * right[1] - n[1] * right[0],
    ];
    const want = [0, 1, 2].map((i) => Math.cos(0.7) * right[i] + Math.sin(0.7) * up[i]);
    const dot = dir[0] * want[0] + dir[1] * want[1] + dir[2] * want[2];
    expect(dot).toBeGreaterThan(Math.cos(0.05));
    checked++;
  }
  expect(checked).toBeGreaterThan(200);
});

test('haze avoids the ground by the margin and still meets the count', () => {
  const terrain = createTerrain(1);
  const haze = createBoundaryHaze(SOURCE, { seed: 2, count: 3000, groundHeight: terrain.heightAt });
  expect(haze).toHaveLength(3000);
  for (const s of haze) {
    expect(s.position[1]).toBeGreaterThanOrEqual(
      terrain.heightAt(s.position[0], s.position[2]) + HAZE_GROUND_MARGIN,
    );
  }
});

test('haze stops at the draw guard when the ground starves it', () => {
  const haze = createBoundaryHaze(SOURCE, { seed: 2, count: 20, groundHeight: () => 1000 });
  expect(haze.length).toBeLessThan(20);
});

test('the stroke material thickens only the haze, and draws it as built by default (P3.5)', () => {
  const material = createStrokeMaterial(new Texture());
  expect(material.uniforms.uHazeThickness.value).toBe(0);
  expect(material.defines.STROKE_LAYER_SKY).toBe(`${STROKE_LAYER.sky}u`);
  expect(Number(material.defines.HAZE_GROWTH)).toBe(HAZE_GROWTH);
  const glsl = readFileSync('src/render/strokes/stroke.vert.glsl', 'utf8');
  for (const line of [
    'uniform float uHazeThickness;',
    'if (iMeta.y == STROKE_LAYER_SKY && (iMeta.w & SKY_LIGHT_CULL_FLAG) != 0u) {',
    'sizeScale *= 1.0 + HAZE_GROWTH * uHazeThickness;',
  ]) {
    expect(glsl).toContain(line);
  }
  // The growth lands before the quad is built from `size`.
  expect(glsl.indexOf('sizeScale *= 1.0 + HAZE_GROWTH')).toBeLessThan(
    glsl.indexOf('vec2 size = iSize * sizeScale;'),
  );
});
