/**
 * Canvas sampling with extrapolation. Inside the frame a surface reads the painting under it;
 * outside, or where the painting shows another region than the surface's layer, it draws from
 * the colour and flow histograms of its layer's region, so off-frame paint stays plausible.
 *
 * The histograms are built from decoded rasters (frame image, regions.png, the flow field), so
 * tests run on small synthetic rasters. The rasters need not share a size: they meet through uv.
 */
import {
  type FlowField,
  type Raster,
  REGION,
  type RegionId,
  regionAt,
  sampleColor,
  sampleFlow,
} from '../../demo/canvas/field';
import { COLOR_INSET } from '../../demo/canvas/placement';
import type { Vec3 } from '../../render/strokes/frame';
import { LAYER_REGION, projectToCanvas, type WorldLayer } from './canvas-camera';

/** Bits per channel of a colour bin: 5 gives 32³ bins, at most 4/255 off the texel. */
export const COLOR_BITS: number = 5;
/** Orientation bins over [0, π), about 2.8° each. Samples are jittered within their bin. */
export const ANGLE_BINS: number = 64;

const REGION_COUNT = Math.max(...Object.values(REGION)) + 1;
const COLOR_LEVELS = 1 << COLOR_BITS;
const COLOR_BIN_COUNT = COLOR_LEVELS ** 3;
const COLOR_STEP = 256 / COLOR_LEVELS;

export interface RegionHistogram {
  /** Frame texels in the region. */
  readonly count: number;
  /** Non-empty colour bins, ascending, packed as (r << 2b) | (g << b) | b with b = COLOR_BITS. */
  readonly colorBins: Uint16Array;
  /** Running texel count through each colorBins entry; the last entry is `count`. */
  readonly colorCdf: Uint32Array;
  /** Running texel count through each of the ANGLE_BINS orientation bins. */
  readonly angleCdf: Uint32Array;
}

export interface CanvasHistogram {
  /** Indexed by RegionId. */
  readonly regions: readonly RegionHistogram[];
}

function quantize(c: number): number {
  const q = Math.floor(c / COLOR_STEP);
  return q < 0 ? 0 : q >= COLOR_LEVELS ? COLOR_LEVELS - 1 : q;
}

function angleBin(theta: number): number {
  const b = Math.floor((theta / Math.PI) * ANGLE_BINS);
  return b < 0 ? 0 : b >= ANGLE_BINS ? ANGLE_BINS - 1 : b;
}

/**
 * Per-region histograms of the frame's colours and the flow under each frame texel centre. Each
 * texel maps back to painting uv through COLOR_INSET, and texels of the mat (outside [0, 1]) are
 * skipped, so no mat colour reaches an extrapolated stroke.
 */
export function buildCanvasHistogram(
  image: Raster,
  regions: Raster,
  flow: FlowField,
): CanvasHistogram {
  const { width, height, data } = image;
  const colors = new Uint32Array(REGION_COUNT * COLOR_BIN_COUNT);
  const angles = new Uint32Array(REGION_COUNT * ANGLE_BINS);
  const counts = new Uint32Array(REGION_COUNT);
  const [iu, iv] = COLOR_INSET;
  for (let y = 0; y < height; y++) {
    const v = (1 - (y + 0.5) / height - iv) / (1 - 2 * iv);
    if (v < 0 || v > 1) continue;
    for (let x = 0; x < width; x++) {
      const u = ((x + 0.5) / width - iu) / (1 - 2 * iu);
      if (u < 0 || u > 1) continue;
      const region = regionAt(regions, u, v);
      const i = (y * width + x) * 4;
      const key =
        (quantize(data[i]) << (2 * COLOR_BITS)) |
        (quantize(data[i + 1]) << COLOR_BITS) |
        quantize(data[i + 2]);
      colors[region * COLOR_BIN_COUNT + key]++;
      angles[region * ANGLE_BINS + angleBin(sampleFlow(flow, u, v).angle)]++;
      counts[region]++;
    }
  }

  const out: RegionHistogram[] = [];
  for (let r = 0; r < REGION_COUNT; r++) {
    const base = r * COLOR_BIN_COUNT;
    let used = 0;
    for (let k = 0; k < COLOR_BIN_COUNT; k++) if (colors[base + k] > 0) used++;
    const colorBins = new Uint16Array(used);
    const colorCdf = new Uint32Array(used);
    let n = 0;
    let total = 0;
    for (let k = 0; k < COLOR_BIN_COUNT; k++) {
      const c = colors[base + k];
      if (c === 0) continue;
      total += c;
      colorBins[n] = k;
      colorCdf[n++] = total;
    }
    const angleCdf = new Uint32Array(ANGLE_BINS);
    let running = 0;
    for (let b = 0; b < ANGLE_BINS; b++) {
      running += angles[r * ANGLE_BINS + b];
      angleCdf[b] = running;
    }
    out.push({ count: counts[r], colorBins, colorCdf, angleCdf });
  }
  return { regions: out };
}

/** Index of the first cdf entry above a uniform draw in [0, total). */
function pick(cdf: Uint32Array, total: number, rng: () => number): number {
  const target = Math.floor(rng() * total);
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export interface CanvasSample {
  /** 0–255 per channel. */
  readonly rgb: readonly [number, number, number];
  /** Stroke orientation in [0, π), painting space. */
  readonly flowAngle: number;
  /** Drawn from the layer's region histogram rather than read at the projected uv. */
  readonly extrapolated: boolean;
}

/**
 * A colour (its bin centre) and an orientation (jittered within its bin), drawn independently
 * in proportion to the region's texel counts. Advances `rng` three times. Throws for a region
 * the frame never shows.
 */
export function sampleRegionHistogram(
  histogram: CanvasHistogram,
  region: RegionId,
  rng: () => number,
): Omit<CanvasSample, 'extrapolated'> {
  const h = histogram.regions[region];
  if (!h || h.count === 0) throw new Error(`no canvas texels in region ${region}`);
  const key = h.colorBins[pick(h.colorCdf, h.count, rng)];
  const mask = COLOR_LEVELS - 1;
  const half = COLOR_STEP / 2;
  const rgb: [number, number, number] = [
    (key >> (2 * COLOR_BITS)) * COLOR_STEP + half,
    ((key >> COLOR_BITS) & mask) * COLOR_STEP + half,
    (key & mask) * COLOR_STEP + half,
  ];
  const bin = pick(h.angleCdf, h.count, rng);
  return { rgb, flowAngle: ((bin + rng()) * Math.PI) / ANGLE_BINS };
}

/** Everything sampleCanvas reads: the decoded rasters and their histograms. */
export interface CanvasSource {
  readonly image: Raster;
  readonly regions: Raster;
  readonly flow: FlowField;
  readonly histogram: CanvasHistogram;
}

/**
 * Paint for a surface point on `layer`. In frame and on the layer's own region it reads the
 * canvas at the projected uv (the colour inset past the mat by COLOR_INSET, region and flow at the
 * raw uv) and leaves `rng` untouched; otherwise it draws from the region's histogram.
 */
export function sampleCanvas(
  source: CanvasSource,
  point: Vec3,
  layer: WorldLayer,
  rng: () => number,
): CanvasSample {
  const region = LAYER_REGION[layer];
  const { uv, inFrustum } = projectToCanvas(point);
  if (inFrustum && uv !== null && regionAt(source.regions, uv[0], uv[1]) === region) {
    return {
      rgb: sampleColor(
        source.image,
        COLOR_INSET[0] + uv[0] * (1 - 2 * COLOR_INSET[0]),
        COLOR_INSET[1] + uv[1] * (1 - 2 * COLOR_INSET[1]),
      ),
      flowAngle: sampleFlow(source.flow, uv[0], uv[1]).angle,
      extrapolated: false,
    };
  }
  return { ...sampleRegionHistogram(source.histogram, region, rng), extrapolated: true };
}
