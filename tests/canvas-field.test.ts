import { expect, test } from 'vitest';
import {
  buildFlowField,
  decodeFlowAngle,
  type Raster,
  REGION,
  regionAt,
  sampleColor,
  sampleFlow,
} from '../src/demo/canvas/field.ts';

/** RGBA raster filled per texel by `fill(x, y)`, row 0 at the top. */
function raster(
  width: number,
  height: number,
  fill: (x: number, y: number) => readonly [number, number, number],
): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** flow.png bytes for orientation `theta` and coherence `c`, as the bake encodes them. */
function flowBytes(theta: number, c: number): [number, number, number] {
  return [
    Math.round((0.5 + 0.5 * Math.cos(2 * theta)) * 255),
    Math.round((0.5 + 0.5 * Math.sin(2 * theta)) * 255),
    Math.round(c * 255),
  ];
}

/** Smallest difference between two orientations, which repeat every π. */
function orientationError(a: number, b: number): number {
  const d = (((a - b) % Math.PI) + Math.PI) % Math.PI;
  return Math.min(d, Math.PI - d);
}

test('flow angles decode the bake encoding, from +x counterclockwise, in [0, π)', () => {
  for (const theta of [0, Math.PI / 6, Math.PI / 4, Math.PI / 2, (2 * Math.PI) / 3, 3]) {
    const [r, g] = flowBytes(theta, 1);
    expect(orientationError(decodeFlowAngle(r, g), theta)).toBeLessThan(0.01);
    expect(decodeFlowAngle(r, g)).toBeGreaterThanOrEqual(0);
    expect(decodeFlowAngle(r, g)).toBeLessThan(Math.PI);
  }
  // Known bytes: R 128, G 255 is 2θ = π/2, a 45° stroke; R 0, G 128 is vertical.
  expect(decodeFlowAngle(128, 255)).toBeCloseTo(Math.PI / 4, 2);
  expect(decodeFlowAngle(0, 128)).toBeCloseTo(Math.PI / 2, 2);
});

test('v = 1 is the top row of the image, u = 0 the left column', () => {
  const image = raster(4, 4, (x, y) => [x * 60, y * 60, 0]);
  expect(sampleColor(image, 0, 1)).toEqual([0, 0, 0]);
  expect(sampleColor(image, 1, 1)).toEqual([180, 0, 0]);
  expect(sampleColor(image, 0, 0)).toEqual([0, 180, 0]);
  // Texel centres sample exactly; between them the result is bilinear.
  expect(sampleColor(image, 0.125, 0.875)).toEqual([0, 0, 0]);
  expect(sampleColor(image, 0.25, 0.875)[0]).toBeCloseTo(30, 5);
});

test('regions sample nearest, and unknown ids fall back to sky', () => {
  const regions = raster(7, 1, (x) => [x, x, x]);
  for (let id = 0; id < 7; id++) expect(regionAt(regions, (id + 0.5) / 7, 0.5)).toBe(id);
  // Just inside a texel edge still reads that texel, never a blend of two ids.
  expect(regionAt(regions, 2 / 7 + 1e-6, 0.5)).toBe(REGION.moon);
  expect(regionAt(regions, 2 / 7 - 1e-6, 0.5)).toBe(REGION.stars);
  expect(
    regionAt(
      raster(1, 1, () => [200, 200, 200]),
      0.5,
      0.5,
    ),
  ).toBe(REGION.sky);
  // Out-of-range uv clamps to the edge texels.
  expect(regionAt(regions, -0.5, 0.5)).toBe(0);
  expect(regionAt(regions, 1.5, 0.5)).toBe(6);
});

test('coherent flow keeps its own angle and coherence', () => {
  const field = buildFlowField(raster(32, 32, () => flowBytes(Math.PI / 3, 0.9)));
  const sample = sampleFlow(field, 0.4, 0.6);
  expect(orientationError(sample.angle, Math.PI / 3)).toBeLessThan(0.01);
  expect(sample.coherence).toBeCloseTo(0.9, 2);
});

test('incoherent texels take the orientation of their coherent neighbourhood', () => {
  // A 45° field with a flat patch in the middle, where the bake writes θ = 0 at coherence 0.
  const field = buildFlowField(
    raster(64, 64, (x, y) =>
      Math.abs(x - 32) < 4 && Math.abs(y - 32) < 4 ? flowBytes(0, 0) : flowBytes(Math.PI / 4, 1),
    ),
  );
  const flat = sampleFlow(field, 32.5 / 64, 1 - 32.5 / 64);
  expect(flat.coherence).toBe(0);
  expect(orientationError(flat.angle, Math.PI / 4)).toBeLessThan(0.05);
});

test('orientation is averaged as a doubled angle, so near-0 and near-π agree', () => {
  // Alternating 5° and 175° texels are all nearly horizontal; a plain θ average would give 90°.
  const field = buildFlowField(
    raster(32, 32, (x, y) =>
      (x + y) % 2 === 0
        ? flowBytes((5 * Math.PI) / 180, 0.05)
        : flowBytes((175 * Math.PI) / 180, 0.05),
    ),
  );
  expect(orientationError(sampleFlow(field, 0.5, 0.5).angle, 0)).toBeLessThan(0.12);
});
