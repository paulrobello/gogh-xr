import { BufferGeometry, Float32BufferAttribute } from 'three';
import { expect, test } from 'vitest';
import {
  type FlowField,
  type Raster,
  REGION,
  regionAt,
  sampleColor,
  sampleFlow,
} from '../src/demo/canvas/field.ts';
import { COLOR_INSET } from '../src/demo/canvas/placement.ts';
import { canvasRay, EYE_HEIGHT, PAINTER_EYE } from '../src/paintings/starry-night/canvas-camera.ts';
import {
  ANGLE_BINS,
  buildCanvasHistogram,
  type CanvasSource,
  COLOR_BITS,
  REGION_PALETTE_RIVALS,
  sampleCanvas,
  sampleRegionHistogram,
} from '../src/paintings/starry-night/canvas-histogram.ts';
import type { Vec3 } from '../src/render/strokes/frame.ts';
import { unpackInstance } from '../src/render/strokes/instance.ts';
import { scatterSurfaces } from '../src/render/strokes/scatter.ts';
import { mulberry32 } from '../src/util/prng.ts';

type Rgb = readonly [number, number, number];

/** RGBA raster filled per texel by `fill(x, y)`, row 0 at the top. */
function raster(width: number, height: number, fill: (x: number, y: number) => Rgb): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const SKY: Rgb = [20, 40, 200];
const HILL_A: Rgb = [200, 100, 0];
const HILL_B: Rgb = [0, 160, 40];
const VILLAGE: Rgb = [230, 200, 60];
const SKY_ANGLE = 0.2;
const HILL_ANGLE = 1.0;
const VILLAGE_ANGLE = 2.5;

/**
 * An 8 × 6 frame over a 4 × 4 region map, so the two rasters only line up through uv. The top
 * half is sky; below it, hills in two colours (columns 0–1 and 2–5, so 1 : 2) and the village in
 * columns 6–7. No church texels.
 */
const IMAGE = raster(8, 6, (x, y) => (y < 3 ? SKY : x >= 6 ? VILLAGE : x < 2 ? HILL_A : HILL_B));
const REGIONS = raster(4, 4, (x, y) => [
  y < 2 ? REGION.sky : x === 3 ? REGION.village : REGION.hills,
  0,
  0,
]);
const FLOW: FlowField = (() => {
  const angle = new Float32Array(16);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      angle[y * 4 + x] = y < 2 ? SKY_ANGLE : x === 3 ? VILLAGE_ANGLE : HILL_ANGLE;
    }
  }
  return { width: 4, height: 4, angle, coherence: new Float32Array(16).fill(1) };
})();
const SOURCE: CanvasSource = {
  image: IMAGE,
  regions: REGIONS,
  flow: FLOW,
  histogram: buildCanvasHistogram(IMAGE, REGIONS, FLOW),
};

/** The colour a histogram bin hands back for `c`: the centre of its quantisation bin. */
function binned(c: Rgb): Rgb {
  const step = 256 >> COLOR_BITS;
  return c.map((k) => Math.floor(k / step) * step + step / 2) as unknown as Rgb;
}

function angleBin(theta: number): number {
  return Math.floor((theta / Math.PI) * ANGLE_BINS);
}

/** A world point 20 m out along the painter's ray through (u, v). */
function pointAt(u: number, v: number): Vec3 {
  const d = canvasRay(u, v);
  return [PAINTER_EYE[0] + d[0] * 20, PAINTER_EYE[1] + d[1] * 20, PAINTER_EYE[2] + d[2] * 20];
}

const BEHIND: Vec3 = [3, EYE_HEIGHT, 30];

test('the histogram counts frame texels by the region under their uv', () => {
  const { regions } = SOURCE.histogram;
  expect(regions[REGION.sky].count).toBe(24);
  expect(regions[REGION.hills].count).toBe(18);
  expect(regions[REGION.village].count).toBe(6);
  expect(regions[REGION.church].count).toBe(0);
  expect(regions[REGION.stars].count).toBe(0);
});

test('in frame on its own region, a sample reads the canvas directly', () => {
  const rng = mulberry32(7);
  for (const [u, v, layer] of [
    [0.3, 0.2, 'terrain'],
    [0.1, 0.4, 'terrain'],
    [0.9, 0.1, 'building'],
    [0.5, 0.9, 'sky'],
    [0.2, 0.7, 'haze'],
  ] as const) {
    const s = sampleCanvas(SOURCE, pointAt(u, v), layer, rng);
    expect(s.extrapolated).toBe(false);
    const rgb = sampleColor(
      IMAGE,
      COLOR_INSET[0] + u * (1 - 2 * COLOR_INSET[0]),
      COLOR_INSET[1] + v * (1 - 2 * COLOR_INSET[1]),
    );
    for (let k = 0; k < 3; k++) expect(s.rgb[k]).toBeCloseTo(rgb[k], 6);
    expect(s.flowAngle).toBeCloseTo(sampleFlow(FLOW, u, v).angle, 6);
  }
});

test('the direct branch does not advance the rng', () => {
  const a = mulberry32(3);
  sampleCanvas(SOURCE, pointAt(0.3, 0.2), 'terrain', a);
  expect(a()).toBe(mulberry32(3)());
});

test('in frame on another region, or out of the frame, a sample is extrapolated', () => {
  const rng = mulberry32(11);
  // Terrain that lands on painted sky.
  const onSky = sampleCanvas(SOURCE, pointAt(0.3, 0.8), 'terrain', rng);
  expect(onSky.extrapolated).toBe(true);
  expect([binned(HILL_A), binned(HILL_B)]).toContainEqual(onSky.rgb);
  // Terrain behind the painter.
  const behind = sampleCanvas(SOURCE, BEHIND, 'terrain', rng);
  expect(behind.extrapolated).toBe(true);
  expect([binned(HILL_A), binned(HILL_B)]).toContainEqual(behind.rgb);
  // In front, but off the side of the frame.
  const off = sampleCanvas(SOURCE, [-40, 0, -10], 'building', rng);
  expect(off.extrapolated).toBe(true);
  expect(off.rgb).toEqual(binned(VILLAGE));
});

test('extrapolated samples are drawn from the layer region histogram (fixed seed)', () => {
  const n = 3000;
  const draw = (layer: 'terrain' | 'roof' | 'sky', seed: number) => {
    const rng = mulberry32(seed);
    return Array.from({ length: n }, () => sampleCanvas(SOURCE, BEHIND, layer, rng));
  };

  const hills = draw('terrain', 42);
  let a = 0;
  for (const s of hills) {
    expect(s.extrapolated).toBe(true);
    expect([binned(HILL_A), binned(HILL_B)]).toContainEqual(s.rgb);
    if (s.rgb[0] === binned(HILL_A)[0]) a++;
    expect(angleBin(s.flowAngle)).toBe(angleBin(HILL_ANGLE));
  }
  // Columns 0–1 of 0–5: one third of the hill texels.
  expect(a / n).toBeGreaterThan(1 / 3 - 0.04);
  expect(a / n).toBeLessThan(1 / 3 + 0.04);
  // The angle is jittered within its bin, not handed back as one constant.
  expect(new Set(hills.map((s) => s.flowAngle)).size).toBeGreaterThan(100);

  for (const s of draw('roof', 42)) {
    expect(s.rgb).toEqual(binned(VILLAGE));
    expect(angleBin(s.flowAngle)).toBe(angleBin(VILLAGE_ANGLE));
  }
  for (const s of draw('sky', 42)) {
    expect(s.rgb).toEqual(binned(SKY));
    expect(angleBin(s.flowAngle)).toBe(angleBin(SKY_ANGLE));
  }

  // The same seed draws the same sequence; another seed a different one.
  expect(draw('terrain', 42)).toEqual(hills);
  expect(draw('terrain', 43)).not.toEqual(hills);
});

test('a region with no texels cannot be sampled', () => {
  expect(() => sampleRegionHistogram(SOURCE.histogram, REGION.church, mulberry32(1))).toThrow(
    /no canvas texels/,
  );
  expect(() => sampleCanvas(SOURCE, BEHIND, 'church', mulberry32(1))).toThrow(/no canvas texels/);
});

test('sampled flow angles stay in [0, π)', () => {
  const rng = mulberry32(5);
  for (let i = 0; i < 500; i++) {
    const { flowAngle } = sampleRegionHistogram(SOURCE.histogram, REGION.hills, rng);
    expect(flowAngle).toBeGreaterThanOrEqual(0);
    expect(flowAngle).toBeLessThan(Math.PI);
  }
});

/**
 * A 256 × 406 frame whose outer 2 columns and 1 row are a magenta mat, inside COLOR_INSET (3
 * columns, 2 rows at this size), so neither bilinear taps nor texel centres reach it.
 */
const MAT: Rgb = [255, 0, 255];
const MAT_IMAGE = raster(256, 406, (x, y) =>
  x < 2 || x >= 254 || y < 1 || y >= 405 ? MAT : [40 + (x % 50), 120, 60 + (y % 80)],
);
const MAT_REGIONS = raster(4, 4, (x) => [x < 2 ? REGION.hills : REGION.sky, 0, 0]);
const MAT_SOURCE: CanvasSource = {
  image: MAT_IMAGE,
  regions: MAT_REGIONS,
  flow: FLOW,
  histogram: buildCanvasHistogram(MAT_IMAGE, MAT_REGIONS, FLOW),
};

test('in-frame colour is inset past the frame mat, out to the frame edges', () => {
  const rng = mulberry32(2);
  for (const u of [0.0002, 0.0005, 0.5, 0.9995, 0.9998]) {
    for (const v of [0.0002, 0.001, 0.5, 0.999, 0.9998]) {
      const layer = regionAt(MAT_REGIONS, u, v) === REGION.hills ? 'terrain' : 'sky';
      const s = sampleCanvas(MAT_SOURCE, pointAt(u, v), layer, rng);
      expect(s.extrapolated).toBe(false);
      // Any mat in a bilinear tap would pull green below the painting's constant 120.
      expect(s.rgb[1]).toBeCloseTo(120, 6);
    }
  }
});

test('the histogram skips mat texels, so extrapolated samples never return the mat', () => {
  const kept = MAT_SOURCE.histogram.regions.reduce((sum, r) => sum + r.count, 0);
  expect(kept).toBeLessThan(256 * 406);
  expect(kept).toBeGreaterThanOrEqual(250 * 402);
  const rng = mulberry32(9);
  for (const layer of ['terrain', 'sky'] as const) {
    for (let i = 0; i < 2000; i++) {
      const s = sampleCanvas(MAT_SOURCE, BEHIND, layer, rng);
      expect(s.extrapolated).toBe(true);
      expect(s.rgb).not.toEqual(binned(MAT));
      expect(s.rgb[1]).toBe(binned([0, 120, 0])[1]);
    }
  }
});

/**
 * A 16 × 16 frame and region map for the cypress palette check: sky above, the cypress (dark
 * green) bottom-left and the hills bottom-right, with a block of sky paint inside the cypress
 * region (columns 2–5, rows 10–13), as where regions.json's polygon overreaches the painted tree.
 */
const DARK: Rgb = [20, 40, 25];
const SKY_PAINT: Rgb = [60, 90, 200];
const HILL_PAINT: Rgb = [50, 60, 140];
const inBlock = (x: number, y: number): boolean => x >= 2 && x <= 5 && y >= 10 && y <= 13;
const CYP_IMAGE = raster(16, 16, (x, y) =>
  y < 8 ? SKY_PAINT : x >= 8 ? HILL_PAINT : inBlock(x, y) ? SKY_PAINT : DARK,
);
const CYP_REGIONS = raster(16, 16, (x, y) => [
  y < 8 ? REGION.sky : x >= 8 ? REGION.hills : REGION.cypress,
  0,
  0,
]);
const CYP_FLOW: FlowField = {
  width: 1,
  height: 1,
  angle: new Float32Array([0.5]),
  coherence: new Float32Array([1]),
};
const CYP_SOURCE: CanvasSource = {
  image: CYP_IMAGE,
  regions: CYP_REGIONS,
  flow: CYP_FLOW,
  histogram: buildCanvasHistogram(CYP_IMAGE, CYP_REGIONS, CYP_FLOW),
};

test('the cypress histogram drops the sky and hill paint inside its region, not its flow', () => {
  expect(REGION_PALETTE_RIVALS[REGION.cypress]).toEqual([REGION.hills, REGION.sky]);
  const h = CYP_SOURCE.histogram.regions[REGION.cypress];
  expect(h.count).toBe(64 - 16);
  expect([...h.colorBins].length).toBe(1);
  expect(h.angleCdf[ANGLE_BINS - 1]).toBe(64);
  const rng = mulberry32(5);
  for (let i = 0; i < 200; i++) {
    expect(sampleRegionHistogram(CYP_SOURCE.histogram, REGION.cypress, rng).rgb).toEqual(
      binned(DARK),
    );
  }
  // Regions without rivals keep every colour.
  expect(CYP_SOURCE.histogram.regions[REGION.sky].count).toBe(128);
});

test('a cypress point on sky paint takes the histogram; on its own paint it reads the canvas', () => {
  const rng = mulberry32(13);
  const onSky = sampleCanvas(CYP_SOURCE, pointAt(0.25, 0.25), 'cypress', rng);
  expect(onSky.extrapolated).toBe(true);
  expect(onSky.rgb).toEqual(binned(DARK));
  const onTree = sampleCanvas(CYP_SOURCE, pointAt(0.42, 0.4), 'cypress', rng);
  expect(onTree.extrapolated).toBe(false);
  expect(onTree.rgb.map(Math.round)).toEqual([...DARK]);
  // Other layers are not checked: terrain on hill paint reads it directly.
  expect(sampleCanvas(CYP_SOURCE, pointAt(0.75, 0.25), 'terrain', rng).extrapolated).toBe(false);
});

test('cypress strokes on sky paint take the histogram whichever way their face turns', () => {
  const corners = [pointAt(0.17, 0.17), pointAt(0.33, 0.17), pointAt(0.25, 0.33)];
  const eyeward = (g: BufferGeometry): number => {
    const p = g.getAttribute('position');
    const at = (i: number): Vec3 => [p.getX(i), p.getY(i), p.getZ(i)];
    const [a, b, c] = [at(0), at(1), at(2)];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    return (
      n[0] * (PAINTER_EYE[0] - a[0]) +
      n[1] * (PAINTER_EYE[1] - a[1]) +
      n[2] * (PAINTER_EYE[2] - a[2])
    );
  };
  const triangle = (order: readonly number[]): BufferGeometry => {
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new Float32BufferAttribute(
        order.flatMap((i) => [...corners[i]]),
        3,
      ),
    );
    g.userData.layer = 'cypress';
    return g;
  };
  const front = triangle([0, 1, 2]);
  const back = triangle([0, 2, 1]);
  expect(Math.sign(eyeward(front))).toBe(-Math.sign(eyeward(back)));
  for (const g of [front, back]) {
    const buffers = scatterSurfaces([g], CYP_SOURCE, { seed: 1 });
    expect(buffers.count).toBeGreaterThan(50);
    for (let i = 0; i < buffers.count; i++) {
      // The stored colour is the paint over the stroke shade (0.85–1.15): sky paint keeps blue
      // above 170, the cypress paint below 40.
      expect(unpackInstance(buffers, i).color[2]).toBeLessThan(40);
    }
  }
});
