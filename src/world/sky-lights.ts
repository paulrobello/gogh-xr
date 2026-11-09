/**
 * The moon and the 11 stars as static strokes on the sky dome (P4.3 pulled forward, static only).
 * Each sky anchor (sky.ts) gets strokes brushed like the dome around it: the dome's stroke size,
 * length jitter and brushes, each stroke along the flow field, coloured from the full-resolution
 * scan (sky-scan.ts) along its length. Strokes split to half and quarter size only where the
 * scan's colour steps across them, such as the crescent's edge. They reach past each anchor's
 * circle into a rim band where they thin out, so the dome shows between them and the disc has no
 * edge. Pure and deterministic per seed, so it runs in unit tests without WebGL.
 *
 * The strokes carry DEPTH_BACKDROP_FLAG on the moon and star stroke layers, so the shader draws
 * them in the backdrop's front tier: over every dome stroke and behind the rest of the world
 * (src/render/strokes/backdrop-depth.ts). They sit exactly on the dome sphere, in the dome's own
 * stroke chunks, which are always in the far distance band (bands.ts). That band draws at
 * DEFAULT_BAND_SIZE.far times the stored size, so the stored size is the drawn one divided by
 * that. The batch pins these strokes (`isPinnedStroke` in batch.ts): each chunk draws all of them
 * at every band density, so the stored count is sized for SKY_LIGHT_OVERDRAW as drawn.
 *
 * The boundary haze would hide most discs from the painter's spot. The stroke shader clears the
 * haze in front of each disc per view, in the cones `skyLightCones` returns, and thins it over a
 * feather around them (src/render/strokes/sky-light-cull.ts).
 */

import type { Raster } from '../demo/canvas/field';
import { REGION, type RegionId, sampleColor, sampleFlow } from '../demo/canvas/field';
import { COLOR_INSET, decodedNormal, REGION_STYLES, strokeShade } from '../demo/canvas/placement';
import { ringOf, SKY_MOON_STILL_PHASE, SKY_RING_REACH, skyRingReach } from '../motion/sky-rings';
import { CANVAS_ASPECT, canvasRay, PAINTER_EYE } from '../paintings/starry-night/canvas-camera';
import type { CanvasSource } from '../paintings/starry-night/canvas-histogram';
import {
  BACKDROP_FRONT_RANK_SHIFT,
  BACKDROP_FRONT_RANKS,
  DEPTH_BACKDROP_FLAG,
} from '../render/strokes/backdrop-depth';
import { DEFAULT_BAND_SIZE } from '../render/strokes/bands';
import { BRUSHES } from '../render/strokes/brush-atlas-data';
import { float32Bits, lowbias32 } from '../render/strokes/depth-tie-break';
import { surfaceBasis, type Vec3 } from '../render/strokes/frame';
import { STROKE_LAYER, type StrokeInstance } from '../render/strokes/instance';
import {
  cameraDirection,
  type GradedSize,
  SCATTER_SIZE_JITTER,
  strokeSizeAt,
} from '../render/strokes/scatter';
import type { SkyLightCone } from '../render/strokes/sky-light-cull';
import { deltaE2000, type Lab, srgb8ToLab } from '../util/cielab';
import { mulberry32 } from '../util/prng';
import { drain, type Steps } from '../util/slicer';
import { anchorReach, SKY_DOME_RADIUS, SKY_LIGHT_RIM, type SkyAnchor, skyAnchors } from './sky';
import { type SkyScanCrop, sampleSkyScan, skyScanCrops } from './sky-scan';

export { SKY_LIGHT_RIM };
/**
 * The boundary haze thins toward each light over this many anchor radii past its cone, plus one
 * haze stroke's half diagonal (sky-light-cull.ts), so the haze has no rim in front of the disc. At
 * least SKY_LIGHT_RIM, the width of the scan's halo band. At that floor the haze dabs still shrank
 * in a visible ring beside the moon; twice it spreads the shrink as gradually as the dome strokes
 * vary in size (docs/shots/moon-hole-after-*.jpg).
 */
export const SKY_LIGHT_FEATHER: number = 3;
/**
 * Quad overdraw where the density is full: stored strokes times mean drawn quad area over the area.
 * The lights are pinned, so every governor level draws all of them. The brush masks cover about a
 * quarter to a half of their quads, and 12 leaves no dark gaps across the moon.
 */
export const SKY_LIGHT_OVERDRAW: number = 12;
/**
 * A stroke splits into four at half the size, at most this many times, where the scan's colour
 * steps across its footprint: the crescent's edge and the stars' cores. Elsewhere the lights use
 * the dome strokes' own size.
 */
export const SKY_LIGHT_FINE_LEVELS: number = 2;
/**
 * Colour step over which a star stroke splits: CIEDE2000 between the mean colours of its
 * footprint's two halves, end against end or side against side.
 */
export const SKY_LIGHT_EDGE_DE: number = 20;
/**
 * The moon does not split: every cell holds a dome-size stroke, so the moon's strokes match the
 * dome's (Paul's ruling, fix round 2). The crescent's edges get extra strokes at this size level
 * on top instead, only where their footprint straddles the crescent's gold.
 */
export const SKY_LIGHT_MOON_EDGE_LEVEL: number = 2;
/** Quad overdraw of the moon's edge strokes, where they are placed. */
export const SKY_LIGHT_MOON_EDGE_OVERDRAW: number = 3;
/**
 * CIELAB b* over which the scan's moon reads as the crescent's gold. The cream disc the crescent
 * bites into and the halo stay under it (b* about 35 to 45; the gold is 55 to 75).
 */
export const SKY_LIGHT_GOLD_B: number = 50;
/**
 * CIELAB b* over which a moon stroke inside the moon's circle stays still (src/motion/sky-rings.ts),
 * a margin under SKY_LIGHT_GOLD_B: the cream strokes nearest gold also draw the crescent's
 * antialiased outline, so they keep it still too.
 */
export const SKY_LIGHT_MOON_STILL_B: number = 45;
/** Samples of the crescent mask, of 15 over an edge stroke's footprint, needed on each side. */
const EDGE_SIDE_SAMPLES = 3;
/** Split path of a moon edge-stroke cell; the main grid's paths start at 1. */
const EDGE_PATH = 0;
/** Most x float32 steps `rankedDomePoint` tries; one in BACKDROP_FRONT_RANKS hits. */
const RANK_TRIES = 1 << 16;
/** Colour samples along a stroke footprint, as shares of its drawn length from the centre. */
const FOOTPRINT_ALONG: readonly number[] = [-0.45, -0.225, 0, 0.225, 0.45];
/** Colour-step samples across a stroke footprint, as shares of its drawn width. */
const FOOTPRINT_ACROSS: readonly number[] = [-0.45, 0, 0.45];
/**
 * Two quads closer than this times the sum of their half diagonals take different ranks. It covers
 * the micrometre x move `rankedDomePoint` makes after the rank is picked.
 */
const RANK_MARGIN = 1.01;

const REGION_OF: Readonly<Record<SkyAnchor['kind'], RegionId>> = Object.freeze({
  star: REGION.stars,
  moon: REGION.moon,
});

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Share of full density at `rho` anchor radii from the centre. */
export function skyLightFade(rho: number): number {
  return rho < 1 ? 1 : 1 - smoothstep(1, SKY_LIGHT_RIM, rho);
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
export function metresPerWidth(anchor: SkyAnchor): number {
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

/** A stream seed per anchor, so retuning one disc leaves the others unchanged. */
function anchorSeed(seed: number, anchor: number): number {
  let h = Math.imul((seed >>> 0) ^ (anchor + 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * Front-tier ranks for the sky lights, greedily: each stroke takes the first rank, from a random start,
 * that no earlier stroke it can overlap holds. Two strokes can overlap only when their centres are
 * closer than the sum of their half diagonals, all in metres on the dome, as drawn. When every rank
 * is held by such a neighbour, the stroke takes its start rank anyway and `ties` counts it; the
 * world diag reports the total (`lightRankTies`). `maxHalf` bounds every half diagonal the picker
 * sees. Each stroke also carries the reach its ring can move it (P4.3, at most `maxReach`), added
 * to the pair's overlap distance, so two strokes that share a rank never come to overlap as the
 * rings move them.
 */
export class RankPicker {
  private readonly cells = new Map<
    number,
    Array<{ p: Vec3; half: number; reach: number; rank: number }>
  >();
  private readonly used = new Uint8Array(BACKDROP_FRONT_RANKS);
  private readonly cell: number;
  /** Strokes that found no free rank and share one with a stroke they can overlap. */
  ties = 0;

  constructor(
    private readonly maxHalf: number,
    private readonly maxReach = 0,
  ) {
    this.cell = 2 * (maxHalf + maxReach);
  }

  private key(cx: number, cy: number, cz: number): number {
    return ((cx + 2048) * 4096 + (cy + 2048)) * 4096 + (cz + 2048);
  }

  /**
   * The rank for a stroke at `p` of half diagonal `half`: the first free one from `start` in
   * `step` steps, so step -1 from the top rank puts a stroke over every neighbour it can.
   */
  pick(p: Vec3, half: number, start: number, step: 1 | -1 = 1, reach = 0): number {
    if (half > this.maxHalf) {
      throw new Error(`half diagonal ${half} over the picker's ${this.maxHalf}`);
    }
    if (reach > this.maxReach) {
      throw new Error(`ring reach ${reach} over the picker's ${this.maxReach}`);
    }
    this.used.fill(0);
    const [cx, cy, cz] = p.map((c) => Math.floor(c / this.cell));
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (let k = cz - 1; k <= cz + 1; k++) {
          for (const s of this.cells.get(this.key(i, j, k)) ?? []) {
            const near = s.half + half + s.reach + reach;
            const d = sub(s.p, p);
            if (dot(d, d) < near * near) this.used[s.rank] = 1;
          }
        }
      }
    }
    let rank = -1;
    for (let k = 0; k < BACKDROP_FRONT_RANKS; k++) {
      const r =
        (((start + step * k) % BACKDROP_FRONT_RANKS) + BACKDROP_FRONT_RANKS) % BACKDROP_FRONT_RANKS;
      if (!this.used[r]) {
        rank = r;
        break;
      }
    }
    if (rank < 0) {
      rank = start % BACKDROP_FRONT_RANKS;
      this.ties++;
    }
    const cell = this.key(cx, cy, cz);
    const list = this.cells.get(cell);
    const entry = { p, half, reach, rank };
    if (list) list.push(entry);
    else this.cells.set(cell, [entry]);
    return rank;
  }
}

/** Each anchor's index in `skyAnchors()`, or -1 for an anchor it does not hold. */
function anchorIndices(anchors: readonly SkyAnchor[]): number[] {
  const all = skyAnchors();
  return anchors.map((anchor) =>
    all.findIndex((a) => a.uv[0] === anchor.uv[0] && a.uv[1] === anchor.uv[1]),
  );
}

/** Each anchor's crop in lights.webp, or null for an anchor `skyAnchors()` does not hold. */
function cropsFor(anchors: readonly SkyAnchor[]): Array<SkyScanCrop | null> {
  const crops = skyScanCrops(skyAnchors());
  return anchorIndices(anchors).map((i) => (i < 0 ? null : (crops[i] ?? null)));
}

export interface SkyLights {
  readonly strokes: StrokeInstance[];
  /** Strokes that share a front-tier rank with a stroke they can overlap (`RankPicker.ties`). */
  readonly rankTies: number;
}

/** The sky dome's own brushes and their mean and widest aspect. */
function domeBrushes(): { brushes: readonly number[]; meanAspect: number; maxAspect: number } {
  const { brushes } = REGION_STYLES[REGION.sky];
  const aspects = brushes.map((b) => BRUSHES[b].aspect);
  return {
    brushes,
    meanAspect: aspects.reduce((sum, a) => sum + a, 0) / aspects.length,
    maxAspect: Math.max(...aspects),
  };
}

/**
 * Drawn half diagonal in metres of a quad of stored length `length` metres and brush aspect
 * `aspect`, with RANK_MARGIN.
 */
export function skyLightHalfDiagonal(length: number, aspect: number): number {
  return 0.5 * length * Math.hypot(1, aspect) * DEFAULT_BAND_SIZE.far * RANK_MARGIN;
}

/** A stream seed per anchor, grid cell and split path, so one flipped split moves only its cell. */
function cellSeed(seed: number, anchor: number, i: number, j: number, path: number): number {
  let h = lowbias32(anchorSeed(seed, anchor) ^ lowbias32(((i + 4096) << 13) | (j + 4096)));
  h = lowbias32(h ^ path);
  return h;
}

/** The scan's colour at canvas uv: the anchor's crop where it covers uv, else frame.webp. */
function colourAtUv(
  source: CanvasSource,
  scan: Raster,
  crop: SkyScanCrop | null,
  uv: readonly [number, number],
): readonly [number, number, number] {
  return (
    (crop ? sampleSkyScan(scan, crop, uv) : null) ??
    sampleColor(
      source.image,
      COLOR_INSET[0] + uv[0] * (1 - 2 * COLOR_INSET[0]),
      COLOR_INSET[1] + uv[1] * (1 - 2 * COLOR_INSET[1]),
    )
  );
}

/**
 * The moon and star strokes, anchor by anchor in `skyAnchors()` order, brushed like the dome
 * around them. Every stroke uses the dome's stroke size at the dome's radius (`domeSize`, the sky
 * layer's resolved size), its length jitter and its brushes, and runs along the flow field at its
 * uv, as the dome's strokes do (the scan's structure tensor agrees with the flow field better than
 * with rings about the anchor, docs/verification.md). Where the scan's colour changes across a
 * star stroke's footprint by more than SKY_LIGHT_EDGE_DE, the stroke splits into four at half the
 * size, up to SKY_LIGHT_FINE_LEVELS times, so the stars' cores survive. The moon keeps dome-size
 * strokes and gets finer edge strokes on top along the crescent (SKY_LIGHT_MOON_EDGE_LEVEL). Each
 * grid cell draws its random numbers from its own seed (`cellSeed`).
 *
 * Placement is a jittered grid over the square of half side SKY_LIGHT_RIM·r (painting widths),
 * with a cell sized for SKY_LIGHT_OVERDRAW as drawn. A stroke at rho anchor radii is kept with
 * probability `skyLightFade(rho)`. Per stroke: position on the dome sphere along the painter's ray;
 * normal towards the painter's eye; colour from the scan (`scan` is lights.webp, frame.webp past
 * the crop) divided by `strokeShade`; the star or moon stroke layer; DEPTH_BACKDROP_FLAG; a
 * front-tier rank no stroke it can overlap shares.
 */
export function createSkyLights(
  source: CanvasSource,
  scan: Raster,
  seed: number,
  domeSize: GradedSize,
  anchors: readonly SkyAnchor[] = skyAnchors(),
): SkyLights {
  return drain(createSkyLightsSteps(source, scan, seed, domeSize, anchors));
}

/** Strokes ranked between two yields of `createSkyLightsSteps`' final pass. */
const SKY_LIGHT_SLICE = 64;

/**
 * `createSkyLights` as steps (P5.5): the same draws in the same order, yielding after every grid
 * row of each anchor and every `SKY_LIGHT_SLICE` ranked strokes, so a portal build spreads it over
 * frames.
 */
export function* createSkyLightsSteps(
  source: CanvasSource,
  scan: Raster,
  seed: number,
  domeSize: GradedSize,
  anchors: readonly SkyAnchor[] = skyAnchors(),
): Steps<SkyLights> {
  // Every stroke is placed first and ranked after, full size first, then half, then quarter: a
  // full-size stroke overlaps far more quarter-size ones than the 256 ranks, but each stroke only
  // needs a rank its already-ranked neighbours do not hold.
  const pending: Array<{
    readonly level: number;
    readonly finish: (rank: number) => StrokeInstance;
    readonly p: Vec3;
    readonly half: number;
    /** How far the stroke's ring can move it (skyRingReach), metres. */
    readonly reach: number;
    readonly start: number;
    readonly top: boolean;
  }> = [];
  const crops = cropsFor(anchors);
  const indices = anchorIndices(anchors);
  const { brushes, meanAspect, maxAspect } = domeBrushes();
  const stored = strokeSizeAt(domeSize, SKY_DOME_RADIUS);
  // One picker for every anchor, in metres on the dome: neighbouring stars' rims overlap, and a
  // painting width spans a different length on the dome in each direction.
  const ranks = new RankPicker(
    skyLightHalfDiagonal(stored * (1 + SCATTER_SIZE_JITTER), maxAspect),
    SKY_RING_REACH,
  );
  for (const [a, anchor] of anchors.entries()) {
    const region = REGION_OF[anchor.kind];
    const layer = REGION_STYLES[region].layer;
    const crop = crops[a] ?? null;
    // A star stroke's phase byte names the star it rings round (src/motion/sky-rings.ts), not a
    // per-stroke phase: the rings' phase is per anchor. A moon stroke's is `moonPhase`.
    const ring = indices[a] < 0 ? a : indices[a];
    const perWidth = metresPerWidth(anchor);
    const drawn = (stored * DEFAULT_BAND_SIZE.far) / perWidth;
    const cell = Math.sqrt((drawn * drawn * meanAspect) / SKY_LIGHT_OVERDRAW);
    const { radius } = anchor;
    const outer = SKY_LIGHT_RIM * radius;
    const moon = anchor.kind === 'moon';
    const lab = (rgb: readonly number[]): Lab => {
      const [r, g, b] = rgb.map((c) => Math.min(255, Math.max(0, Math.round(c))));
      return srgb8ToLab(r, g, b);
    };
    /**
     * The scan's colours over a stroke footprint at (x, y), drawn `length` painting widths long and
     * `width` wide along the flow: FOOTPRINT_ALONG positions along it, at each of FOOTPRINT_ACROSS.
     */
    const footprint = (
      x: number,
      y: number,
      length: number,
      width: number,
      across: readonly number[],
    ): Array<readonly [number, number, number]> => {
      const centre = offsetUv(anchor.uv, x, y);
      const angle = sampleFlow(source.flow, centre[0], centre[1]).angle;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const out: Array<readonly [number, number, number]> = [];
      for (const t of FOOTPRINT_ALONG) {
        for (const k of across) {
          const dx = t * length * c - k * width * s;
          const dy = t * length * s + k * width * c;
          out.push(colourAtUv(source, scan, crop, offsetUv(anchor.uv, x + dx, y + dy)));
        }
      }
      return out;
    };

    /**
     * The colour step across a stroke footprint at (x, y): the larger CIEDE2000 difference between
     * the mean colours of its two halves, end against end and side against side. Brush texture
     * and halo rings finer than the stroke average out in each half; an edge such as the
     * crescent's does not.
     */
    const spread = (x: number, y: number, length: number): number => {
      const labs = footprint(x, y, length, length * meanAspect, FOOTPRINT_ACROSS).map(lab);
      const across = FOOTPRINT_ACROSS.length;
      const meanOf = (keep: (t: number, k: number) => boolean): Lab => {
        const sum = [0, 0, 0];
        let n = 0;
        labs.forEach((l, i) => {
          if (!keep(FOOTPRINT_ALONG[Math.floor(i / across)], FOOTPRINT_ACROSS[i % across])) return;
          for (let c = 0; c < 3; c++) sum[c] += l[c];
          n++;
        });
        return [sum[0] / n, sum[1] / n, sum[2] / n];
      };
      return Math.max(
        deltaE2000(
          meanOf((t) => t < 0),
          meanOf((t) => t > 0),
        ),
        deltaE2000(
          meanOf((_, k) => k < 0),
          meanOf((_, k) => k > 0),
        ),
      );
    };

    /** Whether a footprint at (x, y) `length` long holds both the crescent's gold and not. */
    const straddles = (x: number, y: number, length: number): boolean => {
      const labs = footprint(x, y, length, length * meanAspect, FOOTPRINT_ACROSS).map(lab);
      const gold = labs.filter((l) => l[2] > SKY_LIGHT_GOLD_B).length;
      return gold >= EDGE_SIDE_SAMPLES && labs.length - gold >= EDGE_SIDE_SAMPLES;
    };

    /**
     * A moon stroke's phase byte (src/motion/sky-rings.ts). SKY_MOON_STILL_PHASE keeps the
     * crescent still: a stroke the ring never moves (`reach` 0, inside the moon's circle) is still
     * when its colour `rgb` is near the crescent's gold (SKY_LIGHT_MOON_STILL_B) or the scan under
     * its centre is gold, so a crescent stroke whose length averages in the cream stays still too;
     * one it slides is still when its footprint, `length` stored and `aspect` wide, samples any
     * gold, so no sliding stroke covers or uncovers the crescent. Any other stroke gets a shimmer phase hashed
     * from its offset, so no random draw is added.
     */
    const moonPhase = (
      x: number,
      y: number,
      length: number,
      aspect: number,
      reach: number,
      rgb: readonly number[],
    ): number => {
      const along = (length * DEFAULT_BAND_SIZE.far) / perWidth;
      const gold =
        reach > 0
          ? footprint(x, y, along, along * aspect, FOOTPRINT_ACROSS).some(
              (c) => lab(c)[2] > SKY_LIGHT_GOLD_B,
            )
          : lab(rgb)[2] > SKY_LIGHT_MOON_STILL_B ||
            lab(colourAtUv(source, scan, crop, offsetUv(anchor.uv, x, y)))[2] > SKY_LIGHT_GOLD_B;
      if (gold) return SKY_MOON_STILL_PHASE;
      return lowbias32(float32Bits(x) ^ lowbias32(float32Bits(y))) % SKY_MOON_STILL_PHASE;
    };

    const emit = (x: number, y: number, level: number, rand: () => number, top = false): void => {
      const scale = 0.5 ** level;
      const [u, v] = offsetUv(anchor.uv, x, y);
      const brush = brushes[Math.floor(rand() * brushes.length)];
      const aspect = BRUSHES[brush].aspect;
      const length = stored * scale * (1 + (2 * rand() - 1) * SCATTER_SIZE_JITTER);
      const flip = rand() < 0.5 ? Math.PI : 0;
      // Still drawn, so every later draw, ranks included, is unchanged.
      rand();
      const p = domePoint(u, v);
      const reach = skyRingReach(ringOf(layer === STROKE_LAYER.moon, ring), p[0], p[1], p[2]);
      // The lower half, so a moon edge stroke, which takes the highest free rank, lands on top.
      const start = Math.floor((rand() * BACKDROP_FRONT_RANKS) / 2);
      const finish = (rank: number): StrokeInstance => {
        const position = rankedDomePoint(u, v, rank);
        const toward = sub(PAINTER_EYE, position);
        const len = Math.hypot(...toward);
        const normal: Vec3 = [toward[0] / len, toward[1] / len, toward[2] / len];
        const decoded = decodedNormal(normal);
        const { b1, b2 } = surfaceBasis(decoded);
        // Along the flow field, as the dome's strokes run; tangential about the anchor if the
        // flow direction is edge-on (it never is on the dome, which faces the painter).
        const along =
          cameraDirection(position, decoded, sampleFlow(source.flow, u, v).angle) ??
          sub(domePoint(...offsetUv(anchor.uv, x - y * 1e-3, y + x * 1e-3)), domePoint(u, v));
        const tangent = Math.atan2(dot(along, b2), dot(along, b1)) + flip;
        // The mean of the scan along the stroke's drawn length, so a thin dark line under its
        // centre does not paint the whole stroke.
        const samples = footprint(x, y, (length * DEFAULT_BAND_SIZE.far) / perWidth, 0, [0]);
        const rgb = [0, 1, 2].map(
          (k) => samples.reduce((sum, c) => sum + c[k], 0) / samples.length,
        );
        const shade = strokeShade(decoded);
        const color = [rgb[0] / shade, rgb[1] / shade, rgb[2] / shade];
        const phase = moon ? moonPhase(x, y, length, aspect, reach, color) : ring;
        return {
          position,
          normal,
          tangent,
          color: [color[0], color[1], color[2], 255],
          size: [length, length * aspect],
          brush,
          layer,
          phase,
          flags: DEPTH_BACKDROP_FLAG,
        };
      };
      pending.push({
        level,
        finish,
        p,
        half: skyLightHalfDiagonal(length, aspect),
        reach,
        start,
        top,
      });
    };

    const place = (
      x0: number,
      y0: number,
      size: number,
      level: number,
      i: number,
      j: number,
      path: number,
    ): void => {
      const cx = x0 + size / 2;
      const cy = y0 + size / 2;
      // A cell wholly past the rim holds nothing.
      if (Math.hypot(cx, cy) - size * Math.SQRT1_2 >= outer) return;
      if (
        !moon &&
        level < SKY_LIGHT_FINE_LEVELS &&
        spread(cx, cy, drawn * 0.5 ** level) > SKY_LIGHT_EDGE_DE
      ) {
        const half = size / 2;
        place(x0, y0, half, level + 1, i, j, path * 4);
        place(x0 + half, y0, half, level + 1, i, j, path * 4 + 1);
        place(x0, y0 + half, half, level + 1, i, j, path * 4 + 2);
        place(x0 + half, y0 + half, half, level + 1, i, j, path * 4 + 3);
        return;
      }
      const rand = mulberry32(cellSeed(seed, a, i, j, path));
      const x = x0 + rand() * size;
      const y = y0 + rand() * size;
      if (rand() >= skyLightFade(Math.hypot(x, y) / radius)) return;
      emit(x, y, level, rand);
    };

    const n = Math.ceil(outer / cell);
    for (let j = -n; j < n; j++) {
      for (let i = -n; i < n; i++) place(i * cell, j * cell, cell, 0, i, j, 1);
      yield;
    }
    if (!moon) continue;
    // The crescent's edges: finer strokes over the dome-size ones, on a jittered grid of their own
    // over the disc, kept only where their footprint straddles the gold.
    const fine = drawn * 0.5 ** SKY_LIGHT_MOON_EDGE_LEVEL;
    const fineCell = Math.sqrt((fine * fine * meanAspect) / SKY_LIGHT_MOON_EDGE_OVERDRAW);
    const m = Math.ceil(radius / fineCell);
    for (let j = -m; j < m; j++) {
      for (let i = -m; i < m; i++) {
        const rand = mulberry32(cellSeed(seed, a, i, j, EDGE_PATH));
        const x = (i + rand()) * fineCell;
        const y = (j + rand()) * fineCell;
        if (Math.hypot(x, y) >= radius || !straddles(x, y, fine)) continue;
        emit(x, y, SKY_LIGHT_MOON_EDGE_LEVEL, rand, true);
      }
      yield;
    }
  }
  const order = pending
    .map((_, i) => i)
    .sort((i, j) => pending[i].level - pending[j].level || i - j);
  const strokes: StrokeInstance[] = [];
  for (const i of order) {
    if (strokes.length > 0 && strokes.length % SKY_LIGHT_SLICE === 0) yield;
    const p = pending[i];
    strokes.push(
      p.finish(
        p.top
          ? ranks.pick(p.p, p.half, BACKDROP_FRONT_RANKS - 1, -1, p.reach)
          : ranks.pick(p.p, p.half, p.start, 1, p.reach),
      ),
    );
  }
  return { strokes, rankTies: ranks.ties };
}

/**
 * The cones the stroke shader clears the haze from (sky-light-cull.ts): each anchor's dome centre
 * and the lights' reach in metres, out to SKY_LIGHT_RIM radii plus the longest drawn stroke's half
 * diagonal, and a feather of SKY_LIGHT_FEATHER anchor radii in metres.
 */
export function skyLightCones(
  domeSize: GradedSize,
  anchors: readonly SkyAnchor[] = skyAnchors(),
): SkyLightCone[] {
  const { maxAspect } = domeBrushes();
  const longest = strokeSizeAt(domeSize, SKY_DOME_RADIUS) * (1 + SCATTER_SIZE_JITTER);
  const half = skyLightHalfDiagonal(longest, maxAspect);
  return anchors.map((anchor) => {
    // The farthest dome point on the rim, where perspective stretches it most, plus a stroke. The
    // star and moon rings (src/motion/sky-rings.ts) keep every stroke centre inside the same rim,
    // so the cones need no growth for them (R-P4b).
    const radius = anchorReach(anchor, SKY_LIGHT_RIM);
    return {
      centre: anchor.position,
      radius: radius + half,
      feather: SKY_LIGHT_FEATHER * anchor.radius * metresPerWidth(anchor),
    };
  });
}
