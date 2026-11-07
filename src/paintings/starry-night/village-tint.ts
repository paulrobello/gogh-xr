/**
 * Per-house paint for the village (ruling Q28). The village region's colour histogram is split by
 * lightness into texel-weighted L* quantile bands: the dark band paints the roofs and the nave
 * roof, the light band the house walls, and the lightest band the church walls and spire (the
 * painting's spire is pale; the outline pass draws its darker trim), so the church reads lighter than
 * every house (rulings Q28, Q30). Each house (and the church) picks one tint per role from
 * its band, seeded from the world seed and its index, and each stroke takes one of that tint's
 * nearest bins in the same band, so a house reads as one painted object while neighbours differ.
 *
 * Which strokes take the tint is the scatter's call (scatter.ts): every stroke except those on a
 * face turned toward the painter's spot and in frame on its layer's region, which keep the scan
 * pixel so the painter's view still matches the painting. There is no occlusion test: a turned
 * face hidden behind a nearer house also keeps the scan. On the church walls and spire those scan
 * pixels are lifted in lightness only (`SEEN_LIGHTNESS_LIFT`), so the church reads pale from the
 * ground while its hue and dark trim stay the painting's.
 */
import { REGION } from '../../demo/canvas/field';
import type { Vec3 } from '../../render/strokes/frame';
import { mulberry32 } from '../../util/prng';
import type { WorldLayer } from './canvas-camera';
import { type CanvasHistogram, COLOR_BITS } from './canvas-histogram';
import { TINT_ROLE, type TintRole } from './tint-tags';

export { TINT_ROLE, type TintRole, type TintTags } from './tint-tags';

const ROLES: readonly TintRole[] = [TINT_ROLE.wall, TINT_ROLE.roof, TINT_ROLE.churchWall];

/** The region whose histogram every tint band is cut from. */
export const TINT_REGION = REGION.village;

/**
 * A role's band: a texel-weighted L* quantile range [from, to) of the region, keeping only the
 * bins whose chroma C* is at most the region's texel-weighted chroma quantile `chroma` (1 keeps
 * all). The chroma cap keeps the lit windows' saturated yellows, which are among the village's
 * lightest paint, off the walls.
 */
export interface TintBandSpec {
  readonly lightness: readonly [number, number];
  readonly chroma: number;
}

/**
 * The roofs take the darker half; the house walls the light band above it, at most median chroma
 * (blue-greys, pale greens and greyed ochres); the church walls the lightest band, at most the
 * lower-quartile chroma, the scan's palest near-neutral paint. The church band lies wholly above
 * the house band, so the church reads lighter than every house. The house floor, 0.9, is the
 * lowest that lifts the seed-1 house whose back read 12.8 from the ground (house 19) past 15.
 */
export const TINT_BANDS: Readonly<Record<TintRole, TintBandSpec>> = Object.freeze({
  [TINT_ROLE.roof]: Object.freeze({ lightness: Object.freeze([0, 0.5] as const), chroma: 1 }),
  [TINT_ROLE.wall]: Object.freeze({ lightness: Object.freeze([0.9, 0.97] as const), chroma: 0.5 }),
  [TINT_ROLE.churchWall]: Object.freeze({
    lightness: Object.freeze([0.97, 1] as const),
    chroma: 0.25,
  }),
});

/**
 * How far a stroke on a face turned toward the painter's spot (in frame on its layer's region)
 * moves from the scan pixel toward its owner's tint, in linear light, per layer: 0 keeps the scan.
 * The church always keeps it there (the painter's view of it is what the owner likes).
 */
export const SEEN_TINT_BLEND: Readonly<Partial<Record<WorldLayer, number>>> = Object.freeze({
  building: 0,
  roof: 0,
});

/**
 * Lightness lift (ruling Q30) per layer, for church walls and spire only: a stroke that keeps its
 * scan pixel, and whose L* is above the layer region's L* at LIFT_PIVOT_QUANTILE, moves its L*
 * toward its owner's wall tint by this factor, keeping a* and b*. Strokes at or below the pivot are
 * the painted trim and keep their colour.
 */
export const SEEN_LIGHTNESS_LIFT: Readonly<Partial<Record<WorldLayer, number>>> = Object.freeze({
  church: 1,
});

/** The lift's pivot: this texel-weighted L* quantile of the layer's region. */
export const LIFT_PIVOT_QUANTILE: number = 0.5;

/**
 * House walls: a painter-facing wall stroke that keeps a scan pixel darker than the wall band's
 * floor has its L* raised toward that floor by this factor, keeping a* and b*. The 3D walls rise
 * past the painted wall tops, so their upper parts project onto the painting's dark roofs and
 * shadows (mean L* 24-29) while their lower parts fall below the frame and take the pale tint,
 * which read from the ground as pale walls with ground-coloured upper halves.
 */
export const SEEN_WALL_LIFT: number = 1;

/**
 * The trim (ruling Q31): `region`'s paint at or below the lift pivot, its texel-weighted median L*.
 * Every outline stroke on the houses, roofs, church and spire draws from its layer region's trim,
 * so all structures carry the painting's dark outlines.
 */
export function trimBand(histogram: CanvasHistogram, region: number): TintBand {
  const spec: TintBandSpec = { lightness: [0, LIFT_PIVOT_QUANTILE], chroma: 1 };
  return splitTintBands(histogram, region, {
    [TINT_ROLE.roof]: spec,
    [TINT_ROLE.wall]: spec,
    [TINT_ROLE.churchWall]: spec,
  })[TINT_ROLE.roof];
}

/** A stroke's colour is one of this many bins nearest its owner's tint (CIE76), tint included. */
export const TINT_NEIGHBOURS: number = 6;

export type Rgb = readonly [number, number, number];
export type Lab = readonly [number, number, number];

/** One role's bins, L* ascending, with their texel counts. */
export interface TintBand {
  readonly rgb: readonly Rgb[];
  readonly lab: readonly Lab[];
  readonly weight: Uint32Array;
  /** Running weight through each bin; the last entry is the band's texel count. */
  readonly cdf: Uint32Array;
  /** L* range of the band's bins. */
  readonly lightness: readonly [number, number];
}

export type TintBands = Readonly<Record<TintRole, TintBand>>;

/** A house's tint for one role and the bins its strokes draw from. */
export interface Tint {
  readonly rgb: Rgb;
  /** The TINT_NEIGHBOURS bins nearest the tint in its band, the tint first. */
  readonly choices: readonly Rgb[];
}

const toLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const labF = (t: number): number =>
  t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116;

/** CIELAB (D65) of an sRGB 0-255 colour. */
export function srgbToLab(rgb: Rgb): Lab {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const distance = (a: Lab, b: Lab): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Splits `region`'s histogram into the role bands: bins sorted by L* (ties by bin key), each in the
 * band holding the texel-weighted quantile at its middle. Deterministic for a histogram.
 */
export function splitTintBands(
  histogram: CanvasHistogram,
  region: number = TINT_REGION,
  bands: Readonly<Record<TintRole, TintBandSpec>> = TINT_BANDS,
): TintBands {
  const h = histogram.regions[region];
  if (!h || h.count === 0) throw new Error(`no canvas texels in region ${region}`);
  const levels = 1 << COLOR_BITS;
  const step = 256 / levels;
  const bins = Array.from(h.colorBins, (key, i) => {
    const rgb: Rgb = [
      (key >> (2 * COLOR_BITS)) * step + step / 2,
      ((key >> COLOR_BITS) & (levels - 1)) * step + step / 2,
      (key & (levels - 1)) * step + step / 2,
    ];
    return {
      key,
      rgb,
      lab: srgbToLab(rgb),
      weight: h.colorCdf[i] - (i > 0 ? h.colorCdf[i - 1] : 0),
    };
  });
  const chroma = (lab: Lab): number => Math.hypot(lab[1], lab[2]);
  const byChroma = [...bins].sort((a, b) => chroma(a.lab) - chroma(b.lab) || a.key - b.key);
  /** C* at the texel-weighted chroma quantile q. */
  const chromaAt = (q: number): number => {
    let running = 0;
    for (const bin of byChroma) {
      running += bin.weight;
      if (running >= q * h.count) return chroma(bin.lab);
    }
    return Infinity;
  };
  bins.sort((a, b) => a.lab[0] - b.lab[0] || a.key - b.key);
  const members = new Map<TintRole, typeof bins>(ROLES.map((r) => [r, []]));
  const caps = new Map<TintRole, number>(
    ROLES.map((r) => [r, bands[r].chroma >= 1 ? Infinity : chromaAt(bands[r].chroma)]),
  );
  let running = 0;
  for (const bin of bins) {
    const q = (running + bin.weight / 2) / h.count;
    running += bin.weight;
    for (const role of ROLES) {
      const [from, to] = bands[role].lightness;
      if (q < from || !(q < to || (to === 1 && q <= 1))) continue;
      if (chroma(bin.lab) <= (caps.get(role) ?? Infinity)) members.get(role)?.push(bin);
    }
  }
  const out = {} as Record<TintRole, TintBand>;
  for (const role of ROLES) {
    const list = members.get(role) ?? [];
    if (list.length === 0) {
      // A palette too small for the band (a synthetic test raster): the bin nearest its middle.
      const [from, to] = bands[role].lightness;
      list.push(bins[Math.min(bins.length - 1, Math.floor(((from + to) / 2) * bins.length))]);
    }
    const weight = Uint32Array.from(list, (b) => b.weight);
    const cdf = new Uint32Array(list.length);
    let total = 0;
    list.forEach((b, i) => {
      total += b.weight;
      cdf[i] = total;
    });
    out[role] = {
      rgb: list.map((b) => b.rgb),
      lab: list.map((b) => b.lab),
      weight,
      cdf,
      lightness: [list[0].lab[0], list[list.length - 1].lab[0]],
    };
  }
  return Object.freeze(out);
}

/** The house pick's stream: the world seed, the layer, the owner and the role. */
export function tintSeed(seed: number, layer: number, owner: number, role: TintRole): number {
  let h = seed >>> 0;
  for (const v of [layer, owner, role, 0x7417]) {
    h = Math.imul(h ^ (v + 0x9e3779b9), 0x85ebca6b);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/** One texel-weighted bin of `band` for `seed`, with its TINT_NEIGHBOURS nearest bins. */
export function pickTint(band: TintBand, seed: number): Tint {
  const rng = mulberry32(seed);
  const total = band.cdf[band.cdf.length - 1];
  const target = Math.floor(rng() * total);
  let lo = 0;
  let hi = band.cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (band.cdf[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  const lab = band.lab[lo];
  const order = band.lab
    .map((other, i) => ({ i, d: distance(lab, other) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, TINT_NEIGHBOURS);
  return { rgb: band.rgb[lo], choices: order.map(({ i }) => band.rgb[i]) };
}

/** One texel-weighted bin of `band`. Advances `rng` once. */
export function drawBand(band: TintBand, rng: () => number): Rgb {
  const total = band.cdf[band.cdf.length - 1];
  const target = Math.floor(rng() * total);
  let lo = 0;
  let hi = band.cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (band.cdf[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return band.rgb[lo];
}

/** A stroke's colour around `tint`: one of its choices. Advances `rng` once. */
export function jitterTint(tint: Tint, rng: () => number): Rgb {
  return tint.choices[Math.min(tint.choices.length - 1, Math.floor(rng() * tint.choices.length))];
}

const toSrgb8 = (c: number): number =>
  255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** `a` moved toward `b` by `t`, in linear light; sRGB 0-255 in and out. */
export function mixLinear(a: Rgb, b: Rgb, t: number): Rgb {
  if (t === 0) return a;
  const mix = (x: number, y: number): number => toSrgb8(toLinear(x) * (1 - t) + toLinear(y) * t);
  return [mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])];
}

const labFInverse = (f: number): number =>
  f ** 3 > 216 / 24389 ? f ** 3 : (116 * f - 16) / (24389 / 27);

/** sRGB 0-255 of a CIELAB (D65) colour, clamped to the gamut per channel. */
export function labToSrgb(lab: Lab): Rgb {
  const fy = (lab[0] + 16) / 116;
  const x = 0.95047 * labFInverse(fy + lab[1] / 500);
  const y = labFInverse(fy);
  const z = 1.08883 * labFInverse(fy - lab[2] / 200);
  const channel = (c: number): number => Math.min(255, Math.max(0, toSrgb8(Math.max(0, c))));
  return [
    channel(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    channel(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    channel(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ];
}

/** The texel-weighted L* at quantile `q` of `region`'s colour histogram (bin centres). */
export function lightnessQuantile(histogram: CanvasHistogram, region: number, q: number): number {
  const h = histogram.regions[region];
  if (!h || h.count === 0) throw new Error(`no canvas texels in region ${region}`);
  const levels = 1 << COLOR_BITS;
  const step = 256 / levels;
  const bins = Array.from(h.colorBins, (key, i) => ({
    l: srgbToLab([
      (key >> (2 * COLOR_BITS)) * step + step / 2,
      ((key >> COLOR_BITS) & (levels - 1)) * step + step / 2,
      (key & (levels - 1)) * step + step / 2,
    ])[0],
    weight: h.colorCdf[i] - (i > 0 ? h.colorCdf[i - 1] : 0),
  })).sort((a, b) => a.l - b.l);
  let running = 0;
  for (const bin of bins) {
    running += bin.weight;
    if (running >= q * h.count) return bin.l;
  }
  return bins[bins.length - 1].l;
}

/** `rgb` with its L* raised toward `floor` by `t` when it lies below, a* and b* kept. */
export function raiseLightness(rgb: Rgb, floor: number, t: number): Rgb {
  if (t === 0) return rgb;
  const lab = srgbToLab(rgb);
  if (lab[0] >= floor) return rgb;
  return labToSrgb([lab[0] + t * (floor - lab[0]), lab[1], lab[2]]);
}

/**
 * `rgb` with its L* moved toward `target` by `t` when it lies above `pivot`, a* and b* kept; at or
 * below the pivot, `rgb` unchanged.
 */
export function liftLightness(rgb: Rgb, pivot: number, target: number, t: number): Rgb {
  if (t === 0) return rgb;
  const lab = srgbToLab(rgb);
  if (lab[0] <= pivot) return rgb;
  return labToSrgb([lab[0] + t * (target - lab[0]), lab[1], lab[2]]);
}

/** Whether a point on a surface with normal `n` faces the eye: the surface is seen from its front. */
export function facesEye(point: Vec3, n: Vec3, eye: Vec3): boolean {
  return n[0] * (eye[0] - point[0]) + n[1] * (eye[1] - point[1]) + n[2] * (eye[2] - point[2]) > 0;
}
