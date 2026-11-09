/**
 * Pure analysis maths for the scan bake (`scripts/bake/analyze-scan.ts`). Everything here works
 * on plain typed arrays so the unit tests can drive it with synthetic images.
 *
 * Image arrays are row-major and top-down (row 0 is the top of the image), as decoded.
 *
 * Angle convention: an orientation θ is measured from +x (right), counterclockwise, with +y up
 * (so row index and y run in opposite directions). Orientations are modulo π. The stroke
 * direction is the direction along which luminance varies least: tangent to edges and swirls,
 * perpendicular to the dominant gradient.
 */

export interface OrientationOptions {
  /** Gaussian sigma (px) of the pre-smoothing applied to luminance before differentiation. Default 1. */
  preSigma?: number;
  /**
   * Gaussian sigma (px) of the integration window over the structure tensor. Default 5, about one
   * stroke width at 1024² (roughly 19 px on the 3840 px scan); it keeps white-noise coherence low.
   */
  tensorSigma?: number;
  /**
   * Painting width / height when the field was resampled to a different shape (the bake squashes
   * the scan's 3750 × 3011 painted canvas into 1024²). The y gradient is scaled by it so θ is in painting space,
   * not in the squashed field. 1 for a field with the painting's own proportions.
   */
  aspect?: number;
}

export interface OrientationField {
  /** Stroke orientation θ in radians, in [0, π). */
  angle: Float32Array;
  /** (λ1 − λ2) / (λ1 + λ2) of the smoothed structure tensor, in [0, 1]. 0 where flat. */
  coherence: Float32Array;
}

/** Deterministic 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] = (k[i] as number) / sum;
  return k;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Separable Gaussian blur with clamp-to-edge borders. Returns a new array. */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src.slice();
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        acc += (k[i + r] as number) * (src[row + clamp(x + i, 0, w - 1)] as number);
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        acc += (k[i + r] as number) * (tmp[clamp(y + i, 0, h - 1) * w + x] as number);
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * Structure-tensor orientation field. Luminance is Gaussian-smoothed, differentiated with Scharr
 * kernels, and the tensor [gx², gx·gy; gx·gy, gy²] is integrated with a second Gaussian. The
 * dominant gradient orientation is φ = ½·atan2(2Jxy, Jxx − Jyy), and the stroke runs at φ + 90°.
 */
export function orientationField(
  lum: Float32Array,
  w: number,
  h: number,
  opts: OrientationOptions = {},
): OrientationField {
  const { preSigma = 1, tensorSigma = 5, aspect = 1 } = opts;
  const s = gaussianBlur(lum, w, h, preSigma);
  const at = (x: number, y: number): number =>
    s[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)] as number;
  const jxx = new Float32Array(w * h);
  const jxy = new Float32Array(w * h);
  const jyy = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let x = 0; x < w; x++) {
      const gx =
        3 * (at(x + 1, row - 1) - at(x - 1, row - 1)) +
        10 * (at(x + 1, row) - at(x - 1, row)) +
        3 * (at(x + 1, row + 1) - at(x - 1, row + 1));
      // Rows run downward, so the upward gradient is (row above) − (row below).
      const gy =
        aspect *
        (3 * (at(x - 1, row - 1) - at(x - 1, row + 1)) +
          10 * (at(x, row - 1) - at(x, row + 1)) +
          3 * (at(x + 1, row - 1) - at(x + 1, row + 1)));
      const i = row * w + x;
      jxx[i] = gx * gx;
      jxy[i] = gx * gy;
      jyy[i] = gy * gy;
    }
  }
  const sxx = gaussianBlur(jxx, w, h, tensorSigma);
  const sxy = gaussianBlur(jxy, w, h, tensorSigma);
  const syy = gaussianBlur(jyy, w, h, tensorSigma);
  const angle = new Float32Array(w * h);
  const coherence = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = sxx[i] as number;
    const b = sxy[i] as number;
    const d = syy[i] as number;
    const trace = a + d;
    const diff = Math.hypot(a - d, 2 * b);
    if (trace <= 1e-12 || diff <= 1e-12) continue;
    // Stroke doubled angle is the gradient doubled angle plus π: (cos 2θ, sin 2θ) = −(a − d, 2b).
    let theta = 0.5 * Math.atan2(-2 * b, -(a - d));
    if (theta < 0) theta += Math.PI;
    angle[i] = theta;
    coherence[i] = clamp(diff / trace, 0, 1);
  }
  return { angle, coherence };
}

const toByte = (v: number): number => Math.round(clamp(v, 0, 1) * 255);

/**
 * Packs an orientation field into interleaved RGB8 for flow.png:
 * R = 0.5 + 0.5·cos 2θ, G = 0.5 + 0.5·sin 2θ, B = coherence (the stroke-length hint).
 */
export function encodeFlow(angle: Float32Array, coherence: Float32Array): Uint8Array {
  const out = new Uint8Array(angle.length * 3);
  for (let i = 0; i < angle.length; i++) {
    const t = 2 * (angle[i] as number);
    out[i * 3] = toByte(0.5 + 0.5 * Math.cos(t));
    out[i * 3 + 1] = toByte(0.5 + 0.5 * Math.sin(t));
    out[i * 3 + 2] = toByte(coherence[i] as number);
  }
  return out;
}

/** Inverse of {@link encodeFlow} for normalized R and G samples: θ = ½·atan2(2G − 1, 2R − 1). */
export function decodeFlowAngle(r: number, g: number): number {
  const theta = 0.5 * Math.atan2(2 * g - 1, 2 * r - 1);
  return theta < 0 ? theta + Math.PI : theta;
}

export interface Swatch {
  hex: string;
  rgb: [number, number, number];
  /** Fraction of sampled pixels assigned to this swatch, rounded to 4 decimals. */
  weight: number;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB8 → Oklab, the space k-means clusters in (perceptually even distances). */
function oklab(r8: number, g8: number, b8: number): [number, number, number] {
  const r = srgbToLinear(r8);
  const g = srgbToLinear(g8);
  const b = srgbToLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const KMEANS_MAX_ITERATIONS = 50;

/**
 * k-means over interleaved RGB8 pixels, clustered in Oklab with seeded k-means++ init. Stops when
 * no assignment changes or after 50 iterations. Each swatch colour is the mean sRGB of its
 * members. Swatches are sorted by Oklab lightness, then hex, so the output is stable.
 */
export function kmeansPalette(pixels: Uint8Array, k: number, seed: number): Swatch[] {
  const n = Math.floor(pixels.length / 3);
  if (n < k) throw new Error(`kmeansPalette: ${n} pixels cannot make ${k} swatches`);
  const lab = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    lab.set(
      oklab(pixels[i * 3] as number, pixels[i * 3 + 1] as number, pixels[i * 3 + 2] as number),
      i * 3,
    );
  }
  const dist2 = (i: number, centres: Float64Array, c: number): number => {
    const dl = (lab[i * 3] as number) - (centres[c * 3] as number);
    const da = (lab[i * 3 + 1] as number) - (centres[c * 3 + 1] as number);
    const db = (lab[i * 3 + 2] as number) - (centres[c * 3 + 2] as number);
    return dl * dl + da * da + db * db;
  };

  // k-means++: first centre uniform, then proportional to squared distance from the nearest.
  const rand = mulberry32(seed);
  const centres = new Float64Array(k * 3);
  const nearest = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  let pick = Math.floor(rand() * n);
  for (let c = 0; c < k; c++) {
    centres.set(lab.subarray(pick * 3, pick * 3 + 3), c * 3);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = dist2(i, centres, c);
      if (d < (nearest[i] as number)) nearest[i] = d;
      total += nearest[i] as number;
    }
    if (c === k - 1) break;
    let target = rand() * total;
    pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= nearest[i] as number;
      if (target < 0) {
        pick = i;
        break;
      }
    }
  }

  const assign = new Int32Array(n).fill(-1);
  const sums = new Float64Array(k * 3);
  const counts = new Int32Array(k);
  for (let iter = 0; iter < KMEANS_MAX_ITERATIONS; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let c = 0; c < k; c++) {
        const d = dist2(i, centres, c);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i] as number;
      counts[c] = (counts[c] as number) + 1;
      for (let j = 0; j < 3; j++)
        sums[c * 3 + j] = (sums[c * 3 + j] as number) + (lab[i * 3 + j] as number);
    }
    for (let c = 0; c < k; c++) {
      const count = counts[c] as number;
      if (count === 0) continue; // An empty cluster keeps its centre.
      for (let j = 0; j < 3; j++) centres[c * 3 + j] = (sums[c * 3 + j] as number) / count;
    }
  }

  const rgbSums = new Float64Array(k * 3);
  counts.fill(0);
  for (let i = 0; i < n; i++) {
    const c = assign[i] as number;
    counts[c] = (counts[c] as number) + 1;
    for (let j = 0; j < 3; j++)
      rgbSums[c * 3 + j] = (rgbSums[c * 3 + j] as number) + (pixels[i * 3 + j] as number);
  }
  const swatches: Array<Swatch & { lightness: number }> = [];
  for (let c = 0; c < k; c++) {
    const count = counts[c] as number;
    if (count === 0) continue;
    const rgb = [0, 1, 2].map((j) => Math.round((rgbSums[c * 3 + j] as number) / count)) as [
      number,
      number,
      number,
    ];
    const hex = `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    swatches.push({
      hex,
      rgb,
      weight: Math.round((count / n) * 1e4) / 1e4,
      lightness: oklab(...rgb)[0],
    });
  }
  swatches.sort(
    (a, b) => a.lightness - b.lightness || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0),
  );
  return swatches.map(({ hex, rgb, weight }) => ({ hex, rgb, weight }));
}

/**
 * Hand-authored region shapes (regions.json). Coordinates are normalized canvas uv (the painted
 * canvas, mat excluded, as bake.ts canvasRect crops it) with the origin at the top-left and v
 * pointing down (image space); three.js UV with flipY is
 * (u, 1 − v). A circle radius is in painting-width units, so with `aspect` = width / height a
 * circle stays round on the painting even though the raster is square.
 */
export type RegionShape =
  | { type: 'polygon'; points: Array<[number, number]>; note?: string }
  | { type: 'circle'; center: [number, number]; radius: number; note?: string };

export interface Region {
  name: string;
  /** Value written to regions.png. */
  id: number;
  shapes: RegionShape[];
}

export interface RegionsDoc {
  about?: string;
  /** Canvas width / height (the painted canvas, mat excluded). */
  aspect: number;
  /** Rasterized in order: later entries paint over earlier ones. Unpainted pixels are 0. */
  regions: Region[];
}

function insidePolygon(u: number, v: number, points: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ui, vi] = points[i] as [number, number];
    const [uj, vj] = points[j] as [number, number];
    if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
  }
  return inside;
}

/** Rasterizes a regions doc to one region id per pixel, sampling each pixel at its centre. */
export function rasterizeRegions(doc: RegionsDoc, w: number, h: number): Uint8Array {
  const ids = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    const v = (row + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      for (const region of doc.regions) {
        for (const shape of region.shapes) {
          const hit =
            shape.type === 'polygon'
              ? insidePolygon(u, v, shape.points)
              : Math.hypot(u - shape.center[0], (v - shape.center[1]) / doc.aspect) <= shape.radius;
          if (hit) {
            ids[row * w + x] = region.id;
            break;
          }
        }
      }
    }
  }
  return ids;
}
