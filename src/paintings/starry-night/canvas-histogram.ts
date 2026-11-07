/**
 * Canvas sampling with extrapolation. Inside the frame a surface reads the painting under it;
 * outside, or where the painting shows another region than the surface's layer, it draws from
 * the colour and flow histograms of its layer's region, so off-frame paint stays plausible.
 *
 * The histograms are built from decoded rasters (frame image, regions.png, the flow field), so
 * tests run on small synthetic rasters. The rasters need not share a size: they meet through uv.
 *
 * A region with rivals in REGION_PALETTE_RIVALS keeps only its own palette: regions.json's coarse
 * cypress polygon reaches past the painted tree onto sky and hill paint (about 11% of its texels),
 * so those colours leave its histogram, and a direct read of one falls back to the histogram.
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
import { deltaE2000, type Lab, srgb8ToLab } from '../../util/cielab';
import { drain, type Steps } from '../../util/slicer';
import { LAYER_REGION, projectToCanvas, type WorldLayer } from './canvas-camera';

/** Bits per channel of a colour bin: 5 gives 32³ bins, at most 4/255 off the texel. */
export const COLOR_BITS: number = 5;
/** Orientation bins over [0, π), about 2.8° each. Samples are jittered within their bin. */
export const ANGLE_BINS: number = 64;

/**
 * Regions whose paint must stay in their own palette, each with the regions it must not look
 * like. A colour is in a region's palette when its CIEDE2000 distance to the region's centre is
 * below its distance to every rival's centre by PALETTE_MARGIN. Only the cypress is checked: its
 * polygon takes in sky and hill paint, which reads as blue patches on the 3D tree.
 */
export const REGION_PALETTE_RIVALS: Readonly<Partial<Record<RegionId, readonly RegionId[]>>> =
  Object.freeze({ [REGION.cypress]: Object.freeze([REGION.hills, REGION.sky]) });

/**
 * CIEDE2000 by which a colour must be nearer its region's centre than every rival's. Without it,
 * colours about equidistant from the cypress and hill centres (0.06% of the cypress strokes) stayed.
 */
export const PALETTE_MARGIN: number = 2;

const REGION_COUNT = Math.max(...Object.values(REGION)) + 1;
const COLOR_LEVELS = 1 << COLOR_BITS;
const COLOR_BIN_COUNT = COLOR_LEVELS ** 3;
const COLOR_STEP = 256 / COLOR_LEVELS;

export interface RegionHistogram {
  /**
   * Frame texels in the colour bins: the region's texels, less those outside its palette for a
   * region in REGION_PALETTE_RIVALS.
   */
  readonly count: number;
  /** Non-empty colour bins, ascending, packed as (r << 2b) | (g << b) | b with b = COLOR_BITS. */
  readonly colorBins: Uint16Array;
  /** Running texel count through each colorBins entry; the last entry is `count`. */
  readonly colorCdf: Uint32Array;
  /**
   * Running texel count through each of the ANGLE_BINS orientation bins, over all the region's
   * texels: the palette check drops colours, not flow.
   */
  readonly angleCdf: Uint32Array;
}

export interface CanvasHistogram {
  /** Indexed by RegionId. */
  readonly regions: readonly RegionHistogram[];
  /**
   * Indexed by RegionId: the texel-weighted mean CIELAB of the region's colour bins (bin centres)
   * before the palette check, or null for a region the frame never shows.
   */
  readonly centres: readonly (Lab | null)[];
}

/** The bin centre of a packed colour key, 0–255 per channel. */
function binCentre(key: number): [number, number, number] {
  const mask = COLOR_LEVELS - 1;
  const half = COLOR_STEP / 2;
  return [
    (key >> (2 * COLOR_BITS)) * COLOR_STEP + half,
    ((key >> COLOR_BITS) & mask) * COLOR_STEP + half,
    (key & mask) * COLOR_STEP + half,
  ];
}

function rgbToLab(rgb: readonly [number, number, number]): Lab {
  const c = (x: number): number => Math.min(255, Math.max(0, Math.round(x)));
  return srgb8ToLab(c(rgb[0]), c(rgb[1]), c(rgb[2]));
}

/**
 * Whether `rgb` (0–255) is in `region`'s palette: always true for a region without rivals in
 * REGION_PALETTE_RIVALS; otherwise nearer, in CIEDE2000, to the region's centre than to every
 * rival's centre by more than PALETTE_MARGIN. A rival the frame never shows is ignored.
 */
export function inRegionPalette(
  histogram: CanvasHistogram,
  region: RegionId,
  rgb: readonly [number, number, number],
): boolean {
  const rivals = REGION_PALETTE_RIVALS[region];
  const own = histogram.centres[region];
  if (!rivals || !own) return true;
  const lab = rgbToLab(rgb);
  const distance = deltaE2000(lab, own);
  for (const rival of rivals) {
    const centre = histogram.centres[rival];
    if (centre && deltaE2000(lab, centre) <= distance + PALETTE_MARGIN) return false;
  }
  return true;
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
  return drain(buildCanvasHistogramSteps(image, regions, flow));
}

/** Image rows binned between two yields of `buildCanvasHistogramSteps`. */
const HISTOGRAM_SLICE_ROWS = 48;

/** `buildCanvasHistogram` as steps (P5.5): the same counts, yielding every few rows and regions. */
export function* buildCanvasHistogramSteps(
  image: Raster,
  regions: Raster,
  flow: FlowField,
): Steps<CanvasHistogram> {
  const { width, height, data } = image;
  const colors = new Uint32Array(REGION_COUNT * COLOR_BIN_COUNT);
  const angles = new Uint32Array(REGION_COUNT * ANGLE_BINS);
  const counts = new Uint32Array(REGION_COUNT);
  const [iu, iv] = COLOR_INSET;
  for (let y = 0; y < height; y++) {
    if (y > 0 && y % HISTOGRAM_SLICE_ROWS === 0) yield;
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

  const centres: (Lab | null)[] = [];
  for (let r = 0; r < REGION_COUNT; r++) {
    if (counts[r] === 0) {
      centres.push(null);
      continue;
    }
    const base = r * COLOR_BIN_COUNT;
    const sum = [0, 0, 0];
    for (let k = 0; k < COLOR_BIN_COUNT; k++) {
      const c = colors[base + k];
      if (c === 0) continue;
      const lab = rgbToLab(binCentre(k));
      sum[0] += c * lab[0];
      sum[1] += c * lab[1];
      sum[2] += c * lab[2];
    }
    centres.push([sum[0] / counts[r], sum[1] / counts[r], sum[2] / counts[r]]);
  }
  const partial: CanvasHistogram = { regions: [], centres };

  const out: RegionHistogram[] = [];
  for (let r = 0; r < REGION_COUNT; r++) {
    yield;
    const base = r * COLOR_BIN_COUNT;
    const checked = REGION_PALETTE_RIVALS[r as RegionId] !== undefined;
    const keep = (k: number): boolean =>
      colors[base + k] > 0 && (!checked || inRegionPalette(partial, r as RegionId, binCentre(k)));
    let used = 0;
    for (let k = 0; k < COLOR_BIN_COUNT; k++) if (keep(k)) used++;
    const colorBins = new Uint16Array(used);
    const colorCdf = new Uint32Array(used);
    let n = 0;
    let total = 0;
    for (let k = 0; k < COLOR_BIN_COUNT; k++) {
      if (!keep(k)) continue;
      total += colors[base + k];
      colorBins[n] = k;
      colorCdf[n++] = total;
    }
    const angleCdf = new Uint32Array(ANGLE_BINS);
    let running = 0;
    for (let b = 0; b < ANGLE_BINS; b++) {
      running += angles[r * ANGLE_BINS + b];
      angleCdf[b] = running;
    }
    out.push({ count: total, colorBins, colorCdf, angleCdf });
  }
  return { regions: out, centres };
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
  const rgb = binCentre(h.colorBins[pick(h.colorCdf, h.count, rng)]);
  const bin = pick(h.angleCdf, h.angleCdf[ANGLE_BINS - 1], rng);
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
 * raw uv) and leaves `rng` untouched; otherwise, or where that colour is outside the region's
 * palette (`inRegionPalette`), it draws from the region's histogram.
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
    const rgb = sampleColor(
      source.image,
      COLOR_INSET[0] + uv[0] * (1 - 2 * COLOR_INSET[0]),
      COLOR_INSET[1] + uv[1] * (1 - 2 * COLOR_INSET[1]),
    );
    if (inRegionPalette(source.histogram, region, rgb)) {
      return { rgb, flowAngle: sampleFlow(source.flow, uv[0], uv[1]).angle, extrapolated: false };
    }
  }
  return { ...sampleRegionHistogram(source.histogram, region, rng), extrapolated: true };
}
