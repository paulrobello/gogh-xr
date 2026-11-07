/**
 * The painter's-spot fidelity metric (P2.8, PRD OQ6): how closely the painter's-camera capture
 * matches the scan, both downsampled to FIDELITY_WIDTH × FIDELITY_HEIGHT. Pure maths over 8-bit
 * sRGB pixel arrays, shared by `scripts/fidelity.ts` and `tests/e2e/fidelity.spec.ts`. Nothing in
 * src/ imports it, so it never reaches the production bundle.
 *
 * - SSIM (Wang et al. 2004) on Rec. 709 luma Y' = 0.2126 R' + 0.7152 G' + 0.0722 B' of the
 *   gamma-encoded 8-bit sRGB values (L = 255), with an 11 × 11 Gaussian window (σ 1.5), K1 0.01 and
 *   K2 0.03, averaged over the valid windows (no padding).
 * - Mean CIEDE2000 over a GRID_COLS × GRID_ROWS grid of block-mean colours. Blocks average in
 *   linear light (sRGB decoded per IEC 61966-2-1), then convert to CIELAB under D65.
 */
import {
  deltaE2000,
  type Lab,
  SRGB8_LINEAR as LINEAR,
  linearToLab,
  srgb8ToLab,
  srgbToLinear,
} from '../src/util/cielab.ts';

export type { Lab };
export { deltaE2000, linearToLab, srgb8ToLab, srgbToLinear };

/** An opaque 8-bit sRGB image, 3 bytes per pixel, row-major from the top-left. */
export interface RgbImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** Both images are compared at 256 px wide at the canvas aspect 3840 / 3041. */
export const FIDELITY_WIDTH = 256;
export const FIDELITY_HEIGHT = Math.round(FIDELITY_WIDTH / (3840 / 3041));
export const GRID_COLS = 16;
export const GRID_ROWS = 12;

/**
 * The first accepted render (OQ6, accepted by Paul on 2026-11-06): the production
 * build at bf9d9a9 captured with `?painting=starry-night&diag&shot&noanim&seed=1&painter` at
 * 1280 × 1014 on ANGLE Metal, rounded to 4 decimals. See docs/verification.md P2-A2.
 */
export const MEASURED_SSIM = 0.2943;
export const MEASURED_DELTA_E = 5.6961;
/** Fixed margins: the SSIM threshold sits 0.03 below the first render, ΔE 1.5 above it. */
export const SSIM_MARGIN = 0.03;
export const DELTA_E_MARGIN = 1.5;
/** A capture passes with SSIM ≥ SSIM_THRESHOLD and mean ΔE2000 ≤ DELTA_E_THRESHOLD. */
export const SSIM_THRESHOLD: number = Math.round((MEASURED_SSIM - SSIM_MARGIN) * 1e4) / 1e4;
export const DELTA_E_THRESHOLD: number =
  Math.round((MEASURED_DELTA_E + DELTA_E_MARGIN) * 1e4) / 1e4;

const WINDOW = 11;
const SIGMA = 1.5;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/** Rec. 709 luma of the gamma-encoded channels, 0–255. */
export function luma709(image: RgbImage): Float64Array {
  const { data } = image;
  const out = new Float64Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2];
  }
  return out;
}

const GAUSS: Float64Array = (() => {
  const half = (WINDOW - 1) / 2;
  const w = Float64Array.from({ length: WINDOW }, (_, i) =>
    Math.exp(-((i - half) ** 2) / (2 * SIGMA * SIGMA)),
  );
  const sum = w.reduce((s, v) => s + v, 0);
  return w.map((v) => v / sum);
})();

/** Separable 'valid' Gaussian filter: (width − 10) × (height − 10) outputs. */
function filterValid(src: Float64Array, width: number, height: number): Float64Array {
  const ow = width - WINDOW + 1;
  const oh = height - WINDOW + 1;
  const rows = new Float64Array(ow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let k = 0; k < WINDOW; k++) s += GAUSS[k] * src[y * width + x + k];
      rows[y * ow + x] = s;
    }
  }
  const out = new Float64Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let k = 0; k < WINDOW; k++) s += GAUSS[k] * rows[(y + k) * ow + x];
      out[y * ow + x] = s;
    }
  }
  return out;
}

/** Mean SSIM of two single-channel images in 0–255, over the valid 11 × 11 Gaussian windows. */
export function ssim(a: Float64Array, b: Float64Array, width: number, height: number): number {
  if (a.length !== width * height || b.length !== width * height) {
    throw new Error(`ssim: images must both be ${width} × ${height}`);
  }
  if (width < WINDOW || height < WINDOW) {
    throw new Error(`ssim: images must be at least ${WINDOW} × ${WINDOW}`);
  }
  const ab = a.map((v, i) => v * b[i]);
  const muA = filterValid(a, width, height);
  const muB = filterValid(b, width, height);
  const aa = filterValid(
    a.map((v) => v * v),
    width,
    height,
  );
  const bb = filterValid(
    b.map((v) => v * v),
    width,
    height,
  );
  const abF = filterValid(ab, width, height);
  let sum = 0;
  for (let i = 0; i < muA.length; i++) {
    const ma = muA[i];
    const mb = muB[i];
    const va = aa[i] - ma * ma;
    const vb = bb[i] - mb * mb;
    const cov = abF[i] - ma * mb;
    sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
  }
  return sum / muA.length;
}

/** Block edges over `size` pixels for `count` blocks: floor(i · size / count), i = 0..count. */
export function blockEdges(size: number, count: number): number[] {
  return Array.from({ length: count + 1 }, (_, i) => Math.floor((i * size) / count));
}

/** Block-mean colours in CIELAB, averaged in linear light, row-major from the top-left. */
export function blockMeanLabs(image: RgbImage, cols: number, rows: number): Lab[] {
  const xs = blockEdges(image.width, cols);
  const ys = blockEdges(image.height, rows);
  const out: Lab[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = ys[row]; y < ys[row + 1]; y++) {
        for (let x = xs[col]; x < xs[col + 1]; x++) {
          const i = (y * image.width + x) * 3;
          r += LINEAR[image.data[i]];
          g += LINEAR[image.data[i + 1]];
          b += LINEAR[image.data[i + 2]];
        }
      }
      const n = (xs[col + 1] - xs[col]) * (ys[row + 1] - ys[row]);
      out.push(linearToLab(r / n, g / n, b / n));
    }
  }
  return out;
}

export interface BlockDelta {
  /** 0 at the left. */
  readonly col: number;
  /** 0 at the top. */
  readonly row: number;
  readonly deltaE: number;
}

export interface FidelityResult {
  readonly ssim: number;
  readonly meanDeltaE: number;
  /** Row-major from the top-left, GRID_COLS × GRID_ROWS. */
  readonly blocks: readonly BlockDelta[];
}

/** Compares a capture with the reference; both must have the same size. */
export function compareFidelity(reference: RgbImage, capture: RgbImage): FidelityResult {
  if (reference.width !== capture.width || reference.height !== capture.height) {
    throw new Error(
      `compareFidelity: ${reference.width} × ${reference.height} vs ${capture.width} × ${capture.height}`,
    );
  }
  const { width, height } = reference;
  const s = ssim(luma709(reference), luma709(capture), width, height);
  const labsA = blockMeanLabs(reference, GRID_COLS, GRID_ROWS);
  const labsB = blockMeanLabs(capture, GRID_COLS, GRID_ROWS);
  const blocks = labsA.map((lab, i) => ({
    col: i % GRID_COLS,
    row: Math.floor(i / GRID_COLS),
    deltaE: deltaE2000(lab, labsB[i]),
  }));
  const meanDeltaE = blocks.reduce((sum, block) => sum + block.deltaE, 0) / blocks.length;
  return { ssim: s, meanDeltaE, blocks };
}

/** The `count` blocks with the largest ΔE, largest first. */
export function worstBlocks(blocks: readonly BlockDelta[], count: number): BlockDelta[] {
  return [...blocks].sort((a, b) => b.deltaE - a.deltaE).slice(0, count);
}
