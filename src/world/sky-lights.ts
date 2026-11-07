/**
 * The moon and the 11 stars as static strokes on the sky dome (P4.3 pulled forward, static only).
 * Each sky anchor (sky.ts) gets a disc of concentric rings of strokes, each stroke running along
 * its ring, coloured from the full-resolution scan (sky-scan.ts) at its projected canvas uv. So
 * the crescent and the star rings come from the painting's own colours. The moon's strokes are
 * half the stars' length, so the crescent's edge survives. Pure and deterministic per seed, so it
 * runs in unit tests without WebGL.
 *
 * The strokes carry DEPTH_BACKDROP_FLAG on the moon and star stroke layers, so the shader draws
 * them in the backdrop's front tier: over every dome stroke and behind the rest of the world
 * (src/render/strokes/backdrop-depth.ts). They sit exactly on the dome sphere, in the dome's own
 * stroke chunks, which are always in the far distance band (bands.ts). That band draws at
 * DEFAULT_BAND_SIZE.far times the stored size, so the stored size is the drawn one divided by
 * that. The batch pins these strokes (`isPinnedStroke` in batch.ts): each chunk draws all of them
 * at every band density, so the stored count is sized for SKY_LIGHT_OVERDRAW as drawn.
 *
 * The boundary haze would hide most discs from the painter's spot. The stroke shader culls the
 * haze in front of each disc per view, in the cones `skyLightCones` returns
 * (src/render/strokes/sky-light-cull.ts).
 */
import type { Raster } from '../demo/canvas/field';
import { REGION, type RegionId, sampleColor } from '../demo/canvas/field';
import { COLOR_INSET, decodedNormal, REGION_STYLES, strokeShade } from '../demo/canvas/placement';
import {
  CANVAS_ASPECT,
  canvasRay,
  PAINTER_EYE,
  projectToCanvas,
} from '../paintings/starry-night/canvas-camera';
import {
  type CanvasSource,
  sampleRegionHistogram,
} from '../paintings/starry-night/canvas-histogram';
import {
  BACKDROP_FRONT_RANK_SHIFT,
  BACKDROP_FRONT_RANKS,
  DEPTH_BACKDROP_FLAG,
} from '../render/strokes/backdrop-depth';
import { DEFAULT_BAND_SIZE } from '../render/strokes/bands';
import { BRUSHES } from '../render/strokes/brush-atlas-data';
import { float32Bits, lowbias32 } from '../render/strokes/depth-tie-break';
import { surfaceBasis, type Vec3 } from '../render/strokes/frame';
import type { StrokeInstance } from '../render/strokes/instance';
import type { SkyLightCone } from '../render/strokes/sky-light-cull';
import { mulberry32 } from '../util/prng';
import { SKY_DOME_RADIUS, type SkyAnchor, skyAnchors } from './sky';
import { type SkyScanCrop, sampleSkyScan, skyScanCrops } from './sky-scan';

/** Drawn stroke length and ring spacing per anchor kind, painting widths. */
export const SKY_LIGHT_STROKE: Readonly<
  Record<SkyAnchor['kind'], { readonly length: number; readonly spacing: number }>
> = Object.freeze({
  // About 15 px of a 1280 px painter capture.
  star: Object.freeze({ length: 0.012, spacing: 0.005 }),
  // Half the stars' length: the crescent is about 0.02 painting widths thick.
  moon: Object.freeze({ length: 0.006, spacing: 0.0025 }),
});
/**
 * Quad overdraw over a disc: stored strokes times mean drawn quad area over the disc's area. The
 * lights are pinned, so every governor level draws all of them. The brush masks cover about a
 * quarter to a half of their quads: at 8 the moon was solid but dark gaps stayed between the star
 * dabs, which 12 closes.
 */
export const SKY_LIGHT_OVERDRAW: number = 12;
/** Stroke length varies uniformly by ± this share, as SCATTER_SIZE_JITTER does. */
export const SKY_LIGHT_LENGTH_JITTER: number = 0.15;
/** A stroke's ring radius varies by ± this share of the ring spacing. */
const RING_JITTER = 0.3;
/** A stroke turns off its ring tangent by up to ± this, radians. */
const TANGENT_JITTER = 0.15;
/** Strokes closer than this many longest drawn lengths never share a front-tier rank. */
export const SKY_LIGHT_RANK_REACH: number = 1.3;
/** Most x float32 steps `rankedDomePoint` tries; one in BACKDROP_FRONT_RANKS hits. */
const RANK_TRIES = 1 << 16;

const REGION_OF: Readonly<Record<SkyAnchor['kind'], RegionId>> = Object.freeze({
  star: REGION.stars,
  moon: REGION.moon,
});

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Longest drawn stroke of an anchor kind after length jitter, painting widths. */
export function skyLightMaxLength(kind: SkyAnchor['kind']): number {
  return SKY_LIGHT_STROKE[kind].length * (1 + SKY_LIGHT_LENGTH_JITTER);
}

/** The point on the dome sphere along the painter's ray through canvas (u, v). */
function domePoint(u: number, v: number): Vec3 {
  const ray = canvasRay(u, v);
  return [
    PAINTER_EYE[0] + ray[0] * SKY_DOME_RADIUS,
    PAINTER_EYE[1] + ray[1] * SKY_DOME_RADIUS,
    PAINTER_EYE[2] + ray[2] * SKY_DOME_RADIUS,
  ];
}

/** Metres per painting width on the dome around an anchor, along canvas u. */
function metresPerWidth(anchor: SkyAnchor): number {
  const step = 1e-3;
  return Math.hypot(...sub(domePoint(anchor.uv[0] + step, anchor.uv[1]), anchor.position)) / step;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/**
 * The point on the dome along the painter's ray through (u, v), rounded to float32 as the instance
 * buffer stores it, with x moved by the fewest float32 steps that make the shader's front-tier
 * rank (`backdropRank`, a hash of the stored bits) equal `rank`. A step is a few micrometres at
 * the dome, so the move shows nowhere. Only x changes, so the y and z part of the hash is fixed
 * and nothing is allocated until the hit.
 */
function rankedDomePoint(u: number, v: number, rank: number): Vec3 {
  const ray = canvasRay(u, v);
  const y = Math.fround(PAINTER_EYE[1] + ray[1] * SKY_DOME_RADIUS);
  const z = Math.fround(PAINTER_EYE[2] + ray[2] * SKY_DOME_RADIUS);
  const inner = lowbias32(float32Bits(y) ^ lowbias32(float32Bits(z)));
  const x = float32Bits(PAINTER_EYE[0] + ray[0] * SKY_DOME_RADIUS);
  for (let k = 0; k < RANK_TRIES; k++) {
    const bits = (x + k) >>> 0;
    if (lowbias32(bits ^ inner) >>> BACKDROP_FRONT_RANK_SHIFT === rank) {
      u32[0] = bits;
      return [f32[0], y, z];
    }
  }
  throw new Error(`no dome point near uv (${u}, ${v}) takes front rank ${rank}`);
}

/** Canvas uv at painting-width offset (dx, dy) from (u, v): v units are CANVAS_ASPECT longer. */
function offsetUv(uv: readonly [number, number], dx: number, dy: number): [number, number] {
  return [uv[0] + dx, uv[1] + dy * CANVAS_ASPECT];
}

/**
 * The scan's colour at the point's projected uv: from the anchor's full-resolution crop when it
 * covers the point, else from frame.webp inset past the mat by COLOR_INSET, with no region check
 * (the painted star or moon is what the scan shows there). Off the frame it draws from the
 * region's histogram, as `sampleCanvas` does.
 */
function scanColor(
  source: CanvasSource,
  scan: Raster,
  crop: SkyScanCrop | null,
  point: Vec3,
  region: RegionId,
  rng: () => number,
): readonly [number, number, number] {
  const { uv, inFrustum } = projectToCanvas(point);
  if (inFrustum && uv !== null) {
    const fine = crop ? sampleSkyScan(scan, crop, uv) : null;
    return (
      fine ??
      sampleColor(
        source.image,
        COLOR_INSET[0] + uv[0] * (1 - 2 * COLOR_INSET[0]),
        COLOR_INSET[1] + uv[1] * (1 - 2 * COLOR_INSET[1]),
      )
    );
  }
  return sampleRegionHistogram(source.histogram, region, rng).rgb;
}

/** A stream seed per anchor, so retuning one disc leaves the others unchanged. */
function anchorSeed(seed: number, anchor: number): number {
  let h = Math.imul((seed >>> 0) ^ (anchor + 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * Front-tier ranks for one disc, greedily: each stroke takes the first rank, from a random start,
 * that no earlier stroke within `reach` painting widths holds. Only strokes within `reach` can
 * overlap. When every rank is held nearby, the stroke takes its start rank anyway and `ties`
 * counts it; the world diag reports the total (`lightRankTies`).
 */
export class RankPicker {
  private readonly cells = new Map<number, Array<{ x: number; y: number; rank: number }>>();
  private readonly used = new Uint8Array(BACKDROP_FRONT_RANKS);
  /** Strokes that found no free rank and share one with a stroke within reach. */
  ties = 0;

  constructor(private readonly reach: number) {}

  private key(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  pick(x: number, y: number, start: number): number {
    this.used.fill(0);
    const cx = Math.floor(x / this.reach);
    const cy = Math.floor(y / this.reach);
    const reach2 = this.reach * this.reach;
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (const s of this.cells.get(this.key(i, j)) ?? []) {
          if ((s.x - x) ** 2 + (s.y - y) ** 2 < reach2) this.used[s.rank] = 1;
        }
      }
    }
    let rank = -1;
    for (let k = 0; k < BACKDROP_FRONT_RANKS; k++) {
      const r = (start + k) % BACKDROP_FRONT_RANKS;
      if (!this.used[r]) {
        rank = r;
        break;
      }
    }
    if (rank < 0) {
      rank = start % BACKDROP_FRONT_RANKS;
      this.ties++;
    }
    const cell = this.key(cx, cy);
    const list = this.cells.get(cell);
    const entry = { x, y, rank };
    if (list) list.push(entry);
    else this.cells.set(cell, [entry]);
    return rank;
  }
}

/** Each anchor's crop in lights.webp, or null for an anchor `skyAnchors()` does not hold. */
function cropsFor(anchors: readonly SkyAnchor[]): Array<SkyScanCrop | null> {
  const all = skyAnchors();
  const crops = skyScanCrops(all);
  return anchors.map((anchor) => {
    const i = all.findIndex((a) => a.uv[0] === anchor.uv[0] && a.uv[1] === anchor.uv[1]);
    return i < 0 ? null : (crops[i] ?? null);
  });
}

export interface SkyLights {
  readonly strokes: StrokeInstance[];
  /** Strokes that share a front-tier rank with a stroke within reach (`RankPicker.ties`). */
  readonly rankTies: number;
}

/**
 * The moon and star strokes, anchor by anchor in `skyAnchors()` order. A disc of anchor radius r
 * (painting widths) holds rings at radii (i + 0.5)·r / n for n = max(1, round(r / spacing)); each
 * ring takes strokes at even angles with jitter, enough for SKY_LIGHT_OVERDRAW once the band
 * grows them. Per stroke: position on the dome sphere along the painter's ray;
 * normal towards the painter's eye; long axis along the ring; brush and stroke layer from the
 * region style; colour from the scan (`scan` is lights.webp) divided by `strokeShade`;
 * DEPTH_BACKDROP_FLAG; a front-tier rank no overlapping neighbour shares.
 */
export function createSkyLights(
  source: CanvasSource,
  scan: Raster,
  seed: number,
  anchors: readonly SkyAnchor[] = skyAnchors(),
): SkyLights {
  const out: StrokeInstance[] = [];
  let rankTies = 0;
  const crops = cropsFor(anchors);
  anchors.forEach((anchor, a) => {
    const rand = mulberry32(anchorSeed(seed, a));
    const region = REGION_OF[anchor.kind];
    const style = REGION_STYLES[region];
    const { length: drawn, spacing: ringSpacing } = SKY_LIGHT_STROKE[anchor.kind];
    const authored = drawn / DEFAULT_BAND_SIZE.far;
    const meanAspect =
      style.brushes.reduce((sum, b) => sum + BRUSHES[b].aspect, 0) / style.brushes.length;
    const stored = SKY_LIGHT_OVERDRAW / (drawn * drawn * meanAspect);
    const perWidth = metresPerWidth(anchor);
    // Quads of the widest brush (aspect 0.833) can touch corner to corner up to sqrt(1 + 0.833²),
    // about 1.3 lengths apart; a hair more covers float32 rounding of the positions.
    const ranks = new RankPicker(skyLightMaxLength(anchor.kind) * SKY_LIGHT_RANK_REACH * 1.01);
    const { radius } = anchor;
    const rings = Math.max(1, Math.round(radius / ringSpacing));
    const spacing = radius / rings;
    for (let i = 0; i < rings; i++) {
      const ring = (i + 0.5) * spacing;
      const count = Math.max(3, Math.round(2 * Math.PI * ring * spacing * stored));
      const offset = rand() * 2 * Math.PI;
      for (let j = 0; j < count; j++) {
        const theta = offset + ((j + rand()) / count) * 2 * Math.PI;
        const rho = ring + (2 * rand() - 1) * RING_JITTER * spacing;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        const [u, v] = offsetUv(anchor.uv, rho * c, rho * s);
        const rank = ranks.pick(rho * c, rho * s, Math.floor(rand() * BACKDROP_FRONT_RANKS));
        const position = rankedDomePoint(u, v, rank);
        const toward = sub(PAINTER_EYE, position);
        const len = Math.hypot(...toward);
        const normal: Vec3 = [toward[0] / len, toward[1] / len, toward[2] / len];
        // The ring's direction at this point, from a small step along it.
        const e = 1e-3;
        const at = (t: number): Vec3 =>
          domePoint(...offsetUv(anchor.uv, rho * Math.cos(t), rho * Math.sin(t)));
        const along = sub(at(theta + e), at(theta - e));
        const decoded = decodedNormal(normal);
        const { b1, b2 } = surfaceBasis(decoded);
        const flip = rand() < 0.5 ? Math.PI : 0;
        const tangent =
          Math.atan2(dot(along, b2), dot(along, b1)) + (2 * rand() - 1) * TANGENT_JITTER + flip;
        const brush = style.brushes[Math.floor(rand() * style.brushes.length)];
        const length = authored * perWidth * (1 + (2 * rand() - 1) * SKY_LIGHT_LENGTH_JITTER);
        const phase = Math.floor(rand() * 256);
        const rgb = scanColor(source, scan, crops[a] ?? null, position, region, rand);
        const shade = strokeShade(decoded);
        out.push({
          position,
          normal,
          tangent,
          color: [rgb[0] / shade, rgb[1] / shade, rgb[2] / shade, 255],
          size: [length, length * BRUSHES[brush].aspect],
          brush,
          layer: style.layer,
          phase,
          flags: DEPTH_BACKDROP_FLAG,
        });
      }
    }
    rankTies += ranks.ties;
  });
  return { strokes: out, rankTies };
}

/**
 * The cones the stroke shader clears the haze from (sky-light-cull.ts): each anchor's dome centre
 * and the disc's reach in metres, out to its outermost ring plus ring jitter and half the longest
 * drawn stroke.
 */
export function skyLightCones(anchors: readonly SkyAnchor[] = skyAnchors()): SkyLightCone[] {
  return anchors.map((anchor) => {
    const { spacing } = SKY_LIGHT_STROKE[anchor.kind];
    const reach = anchor.radius + RING_JITTER * spacing + skyLightMaxLength(anchor.kind) / 2;
    // The farthest dome point at that reach, over the rim: perspective stretches some directions.
    let radius = 0;
    for (let k = 0; k < 32; k++) {
      const t = (k / 32) * 2 * Math.PI;
      const rim = domePoint(...offsetUv(anchor.uv, reach * Math.cos(t), reach * Math.sin(t)));
      radius = Math.max(radius, Math.hypot(...sub(rim, anchor.position)));
    }
    return { centre: anchor.position, radius };
  });
}
