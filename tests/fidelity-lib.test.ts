import { expect, test } from 'vitest';
import {
  blockEdges,
  blockMeanLabs,
  compareFidelity,
  DELTA_E_MARGIN,
  DELTA_E_THRESHOLD,
  deltaE2000,
  FIDELITY_HEIGHT,
  FIDELITY_WIDTH,
  GRID_COLS,
  GRID_ROWS,
  type Lab,
  luma709,
  MEASURED_DELTA_E,
  MEASURED_SSIM,
  type RgbImage,
  SSIM_MARGIN,
  SSIM_THRESHOLD,
  srgb8ToLab,
  ssim,
  worstBlocks,
} from '../scripts/fidelity-lib.ts';

/**
 * All 34 pairs of Sharma, Wu and Dalal (2005), Table 1, copied verbatim from
 * ciede2000testdata.txt on G. Sharma's Rochester page: L1 a1 b1 L2 a2 b2 ΔE00, pair number first.
 * Pairs 1–6 and 9–15 include the hue-rotation and the wrap past 180°; pairs 7–8 and 16–24 have
 * one colour of zero or near-zero chroma.
 */
const SHARMA: readonly (readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
])[] = [
  [1, 50.0, 2.6772, -79.7751, 50.0, 0.0, -82.7485, 2.0425],
  [2, 50.0, 3.1571, -77.2803, 50.0, 0.0, -82.7485, 2.8615],
  [3, 50.0, 2.8361, -74.02, 50.0, 0.0, -82.7485, 3.4412],
  [4, 50.0, -1.3802, -84.2814, 50.0, 0.0, -82.7485, 1.0],
  [5, 50.0, -1.1848, -84.8006, 50.0, 0.0, -82.7485, 1.0],
  [6, 50.0, -0.9009, -85.5211, 50.0, 0.0, -82.7485, 1.0],
  [7, 50.0, 0.0, 0.0, 50.0, -1.0, 2.0, 2.3669],
  [8, 50.0, -1.0, 2.0, 50.0, 0.0, 0.0, 2.3669],
  [9, 50.0, 2.49, -0.001, 50.0, -2.49, 0.0009, 7.1792],
  [10, 50.0, 2.49, -0.001, 50.0, -2.49, 0.001, 7.1792],
  [11, 50.0, 2.49, -0.001, 50.0, -2.49, 0.0011, 7.2195],
  [12, 50.0, 2.49, -0.001, 50.0, -2.49, 0.0012, 7.2195],
  [13, 50.0, -0.001, 2.49, 50.0, 0.0009, -2.49, 4.8045],
  [14, 50.0, -0.001, 2.49, 50.0, 0.001, -2.49, 4.8045],
  [15, 50.0, -0.001, 2.49, 50.0, 0.0011, -2.49, 4.7461],
  [16, 50.0, 2.5, 0.0, 50.0, 0.0, -2.5, 4.3065],
  [17, 50.0, 2.5, 0.0, 73.0, 25.0, -18.0, 27.1492],
  [18, 50.0, 2.5, 0.0, 61.0, -5.0, 29.0, 22.8977],
  [19, 50.0, 2.5, 0.0, 56.0, -27.0, -3.0, 31.903],
  [20, 50.0, 2.5, 0.0, 58.0, 24.0, 15.0, 19.4535],
  [21, 50.0, 2.5, 0.0, 50.0, 3.1736, 0.5854, 1.0],
  [22, 50.0, 2.5, 0.0, 50.0, 3.2972, 0.0, 1.0],
  [23, 50.0, 2.5, 0.0, 50.0, 1.8634, 0.5757, 1.0],
  [24, 50.0, 2.5, 0.0, 50.0, 3.2592, 0.335, 1.0],
  [25, 60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [26, 63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [27, 61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [28, 35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [29, 22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [30, 36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [31, 90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [32, 90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [33, 6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [34, 2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
];

test('ΔE2000 matches all 34 Sharma, Wu and Dalal reference pairs to 1e-4, in both orders', () => {
  for (const [pair, l1, a1, b1, l2, a2, b2, expected] of SHARMA) {
    const forward = deltaE2000([l1, a1, b1], [l2, a2, b2]);
    const backward = deltaE2000([l2, a2, b2], [l1, a1, b1]);
    expect(Math.abs(forward - expected), `pair ${pair}`).toBeLessThanOrEqual(1e-4);
    expect(Math.abs(backward - expected), `pair ${pair} reversed`).toBeLessThanOrEqual(1e-4);
  }
});

test('ΔE2000 of a colour with itself is 0', () => {
  expect(deltaE2000([50, 10, -20], [50, 10, -20])).toBe(0);
  expect(deltaE2000([0, 0, 0], [0, 0, 0])).toBe(0);
});

test('sRGB to CIELAB uses D65: white, black, primaries and mid grey', () => {
  const close = (lab: Lab, expected: Lab, digits: number): void => {
    for (let i = 0; i < 3; i++) expect(lab[i]).toBeCloseTo(expected[i], digits);
  };
  close(srgb8ToLab(255, 255, 255), [100, 0, 0], 6);
  close(srgb8ToLab(0, 0, 0), [0, 0, 0], 6);
  // Bruce Lindbloom's calculator, sRGB D65: red, green, blue.
  close(srgb8ToLab(255, 0, 0), [53.2408, 80.0925, 67.2032], 2);
  close(srgb8ToLab(0, 255, 0), [87.7347, -86.1827, 83.1793], 2);
  close(srgb8ToLab(0, 0, 255), [32.297, 79.1875, -107.8602], 2);
  // A neutral grey has a = b = 0 under D65 white.
  close(srgb8ToLab(128, 128, 128), [53.585, 0, 0], 2);
});

function image(width: number, height: number, pixel: (x: number, y: number) => number[]): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 3);
  }
  return { width, height, data };
}

/** Deterministic pseudo-random values in [0, 1). */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function textured(width: number, height: number): RgbImage {
  return image(width, height, (x, y) => {
    const v = Math.round(127 + 80 * Math.sin(x / 3) * Math.cos(y / 4));
    return [v, (v + 40) % 256, 255 - v];
  });
}

test('Rec. 709 luma weights the gamma-encoded channels 0.2126, 0.7152, 0.0722', () => {
  const img = image(
    3,
    1,
    (x) =>
      [
        [255, 0, 0],
        [0, 255, 0],
        [10, 20, 30],
      ][x],
  );
  const y = luma709(img);
  expect(y[0]).toBeCloseTo(0.2126 * 255, 10);
  expect(y[1]).toBeCloseTo(0.7152 * 255, 10);
  expect(y[2]).toBeCloseTo(0.2126 * 10 + 0.7152 * 20 + 0.0722 * 30, 10);
});

test('SSIM of an image with itself is 1', () => {
  const y = luma709(textured(40, 30));
  expect(ssim(y, y, 40, 30)).toBeCloseTo(1, 12);
});

test('SSIM of two constant images is the luminance term (2·μa·μb + C1) / (μa² + μb² + C1)', () => {
  const w = 20;
  const h = 16;
  const a = new Float64Array(w * h).fill(100);
  const b = new Float64Array(w * h).fill(120);
  const c1 = (0.01 * 255) ** 2;
  const expected = (2 * 100 * 120 + c1) / (100 ** 2 + 120 ** 2 + c1);
  expect(ssim(a, b, w, h)).toBeCloseTo(expected, 12);
});

test('SSIM falls as noise grows, and is symmetric', () => {
  const w = 48;
  const h = 40;
  const base = luma709(textured(w, h));
  const noisy = (amplitude: number): Float64Array => {
    const rand = noise(7);
    return base.map((v) => v + amplitude * (rand() - 0.5));
  };
  const small = ssim(base, noisy(10), w, h);
  const large = ssim(base, noisy(60), w, h);
  expect(small).toBeLessThan(1);
  expect(large).toBeLessThan(small);
  expect(large).toBeGreaterThan(0);
  expect(ssim(noisy(60), base, w, h)).toBeCloseTo(large, 12);
});

test('SSIM averages valid 11 × 11 windows only and rejects mismatched or tiny images', () => {
  // An 11 × 11 image has exactly one valid window, centred on (5, 5). With a constant 100 and the
  // centre pixel raised by d, that window's SSIM has a closed form in the Gaussian centre weight
  // wc = 1 / S², S = Σ exp(−k² / (2 · 1.5²)) for k = −5..5. A padded ('same') formulation would
  // average 121 windows, most of which barely see the centre, and land far closer to 1.
  const n = 11;
  const d = 100;
  const a = new Float64Array(n * n).fill(100);
  const b = a.slice();
  b[5 * n + 5] += d;
  let sum = 0;
  for (let k = -5; k <= 5; k++) sum += Math.exp(-(k * k) / (2 * 1.5 * 1.5));
  const wc = 1 / (sum * sum);
  const muB = 100 + wc * d;
  const varB = wc * (100 + d) ** 2 + (1 - wc) * 100 ** 2 - muB * muB;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const expected = ((2 * 100 * muB + c1) * c2) / ((100 ** 2 + muB ** 2 + c1) * (varB + c2));
  expect(expected).toBeLessThan(0.9);
  expect(ssim(a, b, n, n)).toBeCloseTo(expected, 10);
  expect(ssim(b, a, n, n)).toBeCloseTo(expected, 10);

  expect(() => ssim(a, b.subarray(1), n, n)).toThrow();
  expect(() => ssim(new Float64Array(100), new Float64Array(100), 10, 10)).toThrow();
});

test('block edges partition 206 rows into 12 blocks and 256 columns into 16', () => {
  for (const [size, count] of [
    [FIDELITY_HEIGHT, GRID_ROWS],
    [FIDELITY_WIDTH, GRID_COLS],
  ] as const) {
    const edges = blockEdges(size, count);
    expect(edges).toHaveLength(count + 1);
    expect(edges[0]).toBe(0);
    expect(edges[count]).toBe(size);
    for (let i = 0; i < count; i++) {
      const extent = edges[i + 1] - edges[i];
      expect(extent).toBeGreaterThanOrEqual(Math.floor(size / count));
      expect(extent).toBeLessThanOrEqual(Math.ceil(size / count));
    }
  }
  expect(FIDELITY_WIDTH).toBe(256);
  expect(FIDELITY_HEIGHT).toBe(206);
});

test('block means average in linear light, row-major from the top-left', () => {
  // Left half black, right half white, at 2 × 1 blocks: each block is uniform.
  const img = image(4, 2, (x) => (x < 2 ? [0, 0, 0] : [255, 255, 255]));
  const labs = blockMeanLabs(img, 2, 1);
  expect(labs[0][0]).toBeCloseTo(0, 6);
  expect(labs[1][0]).toBeCloseTo(100, 6);
  // One block over black and white: the linear mean is 0.5, L* 76.07, not the sRGB 127.5 grey.
  const [mixed] = blockMeanLabs(img, 1, 1);
  expect(mixed[0]).toBeCloseTo(116 * Math.cbrt(0.5) - 16, 4);
  expect(mixed[1]).toBeCloseTo(0, 6);
  expect(mixed[2]).toBeCloseTo(0, 6);
});

test('compareFidelity: identical images give SSIM 1 and ΔE 0, and the worst blocks are ranked', () => {
  const a = textured(FIDELITY_WIDTH, FIDELITY_HEIGHT);
  const same = compareFidelity(a, a);
  expect(same.ssim).toBeCloseTo(1, 12);
  expect(same.meanDeltaE).toBe(0);
  expect(same.blocks).toHaveLength(GRID_COLS * GRID_ROWS);

  // Brighten one block's pixels: only that block's ΔE moves.
  const edgesX = blockEdges(FIDELITY_WIDTH, GRID_COLS);
  const edgesY = blockEdges(FIDELITY_HEIGHT, GRID_ROWS);
  const b = { ...a, data: a.data.slice() };
  for (let y = edgesY[3]; y < edgesY[4]; y++) {
    for (let x = edgesX[5]; x < edgesX[6]; x++) {
      for (let c = 0; c < 3; c++) {
        const i = (y * FIDELITY_WIDTH + x) * 3 + c;
        b.data[i] = Math.min(255, b.data[i] + 30);
      }
    }
  }
  const result = compareFidelity(a, b);
  const [worst, second] = worstBlocks(result.blocks, 2);
  expect(worst).toMatchObject({ col: 5, row: 3 });
  expect(worst.deltaE).toBeGreaterThan(5);
  expect(second.deltaE).toBe(0);
  expect(result.meanDeltaE).toBeCloseTo(worst.deltaE / (GRID_COLS * GRID_ROWS), 12);
  expect(result.ssim).toBeLessThan(1);
  expect(() => compareFidelity(a, textured(10, 10))).toThrow();
});

test('the thresholds are the accepted anchor, moved by the canvas uv change, with the fixed margins (OQ6)', () => {
  expect(SSIM_MARGIN).toBe(0.03);
  expect(DELTA_E_MARGIN).toBe(1.5);
  expect(MEASURED_SSIM).toBe(0.3068);
  expect(MEASURED_DELTA_E).toBe(5.6243);
  expect(SSIM_THRESHOLD).toBe(0.2768);
  expect(DELTA_E_THRESHOLD).toBe(7.1243);
  expect(SSIM_THRESHOLD).toBeCloseTo(MEASURED_SSIM - SSIM_MARGIN, 12);
  expect(DELTA_E_THRESHOLD).toBeCloseTo(MEASURED_DELTA_E + DELTA_E_MARGIN, 12);
});
