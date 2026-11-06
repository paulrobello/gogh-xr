/**
 * Procedural brush atlas: 16 painterly stroke masks in a 2048² RGBA8 atlas, generated from a seed
 * with no DOM or GPU dependence, so a bake script can import it unchanged.
 *
 * Layout: a 4 × 4 grid of 512² cells. Brush i sits in column i % 4 and row floor(i / 4), and data
 * row 0 is v = 0 (the texture is uploaded with flipY = false). Each cell keeps a transparent
 * gutter of `ATLAS_GUTTER` texels on every side so mipmaps do not bleed between neighbours down to
 * mip 4; the brush's own `brushUvRect` crops tighter still, to the band its shape occupies.
 *
 * Strokes run along +u: the start (the loaded end of the brush) is at the rect's left edge and the
 * long axis is horizontal, so the renderer rotates the quad to the flow tangent.
 *
 * Channels (`BRUSH_CHANNEL`):
 * - R coverage: a shape mask, 1 inside and 0 outside with a 2–3 texel anti-aliased rim. It never
 *   carries texture, because alpha-to-coverage turns alpha that varies inside a stroke into a
 *   flickering screen-door dither.
 * - G height: impasto relief in 0..1 (dome, edge ridges, bristle grooves), premultiplied by
 *   coverage. The shader derives a normal from its finite differences for fake lighting.
 * - B tone: brightness variation around `TONE_NEUTRAL` (0.5) to multiply into the stroke colour.
 *   Exactly neutral outside every shape.
 * - A spare: 255.
 *
 * The output is deterministic per seed for a given JS engine. Math.sin, exp and atan2 are not
 * bit-identical across engines, so the hash can differ between node, bun and the Quest browser.
 */
import { mulberry32 } from '../../util/prng';

export const ATLAS_GRID = 4;
export const ATLAS_CELL_SIZE = 512;
export const ATLAS_SIZE = ATLAS_GRID * ATLAS_CELL_SIZE;
export const ATLAS_GUTTER = 16;
export const BRUSH_COUNT = ATLAS_GRID * ATLAS_GRID;
/** Used when `?seed` is absent so the look is stable across loads. */
export const DEFAULT_BRUSH_SEED = 1;

export const BRUSH_CHANNEL = { coverage: 0, height: 1, tone: 2, spare: 3 } as const;
/** Tone byte meaning "no change" (0.5). */
export const TONE_NEUTRAL = 128;

export type BrushKind = 'ridge' | 'bristle' | 'dab' | 'comma' | 'crescent';

export interface BrushInfo {
  readonly kind: BrushKind;
  /** 0-based variant within the kind. */
  readonly variant: number;
  /** Height / width of the brush's uv rect, the quad aspect that maps it without stretching. */
  readonly aspect: number;
}

/** A rect in atlas uv space; (u, v) is its minimum corner. */
export interface UvRect {
  readonly u: number;
  readonly v: number;
  readonly width: number;
  readonly height: number;
}

/** A rect in atlas texels; (x, y) is its minimum corner, y counted from data row 0. */
export interface TexelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const INSET = ATLAS_CELL_SIZE - 2 * ATLAS_GUTTER;

/** Height of each kind's uv rect in texels; the width is always the full inset (480). */
const RECT_HEIGHT: Readonly<Record<BrushKind, number>> = {
  ridge: 240,
  bristle: 240,
  dab: 352,
  comma: 400,
  crescent: 336,
};

const KIND_ORDER: readonly (readonly [BrushKind, number])[] = [
  ['ridge', 4],
  ['bristle', 4],
  ['dab', 3],
  ['comma', 3],
  ['crescent', 2],
];

/** Brush index → kind table: 0–3 ridge, 4–7 bristle, 8–10 dab, 11–13 comma, 14–15 crescent. */
export const BRUSHES: readonly BrushInfo[] = Object.freeze(
  KIND_ORDER.flatMap(([kind, count]) =>
    Array.from({ length: count }, (_, variant) =>
      Object.freeze({ kind, variant, aspect: RECT_HEIGHT[kind] / INSET }),
    ),
  ),
);

function brushAt(index: number): BrushInfo {
  const brush = Number.isInteger(index) ? BRUSHES[index] : undefined;
  if (!brush) throw new RangeError(`brush index ${index} is outside 0..${BRUSH_COUNT - 1}`);
  return brush;
}

/** The texel rect brush `index` draws inside: full inset width, centred in v. */
export function brushTexelRect(index: number): TexelRect {
  const height = RECT_HEIGHT[brushAt(index).kind];
  return {
    x: (index % ATLAS_GRID) * ATLAS_CELL_SIZE + ATLAS_GUTTER,
    y: Math.floor(index / ATLAS_GRID) * ATLAS_CELL_SIZE + (ATLAS_CELL_SIZE - height) / 2,
    width: INSET,
    height,
  };
}

/** Atlas uv rect of brush `index`. Sample at `(u + width * qu, v + height * qv)` for quad uv q. */
export function brushUvRect(index: number): UvRect {
  const rect = brushTexelRect(index);
  return {
    u: rect.x / ATLAS_SIZE,
    v: rect.y / ATLAS_SIZE,
    width: rect.width / ATLAS_SIZE,
    height: rect.height / ATLAS_SIZE,
  };
}

/** Margin (px) the shape keeps from its rect edge; covers the blur rim plus a safety texel. */
const RECT_MARGIN = 6;
/** Half-span of the across-stroke tables: t indexes [-T_SPAN, T_SPAN]. */
const T_SPAN = 256;
const SUPERSAMPLE = 4;

interface StrokeSpec {
  readonly frame: 'line' | 'arc';
  /** Length along the stroke, px. */
  readonly length: number;
  /** line: sine bend of the centreline, px. */
  readonly bend: number;
  /** arc: radius of the centreline at the start, px. */
  readonly radius: number;
  /** arc: radius change from start to end as a fraction (negative curls the tail inward). */
  readonly spiral: number;
  /** Mirror the shape in v. */
  readonly mirror: boolean;
  /** Half-width per integer s on the +t and −t sides. */
  readonly widthTop: Float32Array;
  readonly widthBottom: Float32Array;
  /** Start and end of the stroke per t index (ragged bristle ends). */
  readonly startS: Float32Array;
  readonly endS: Float32Array;
  /** Bristle streak value 0..1 per t index. */
  readonly streak: Float32Array;
  /** Streak drift in px per integer s, so grooves waver. */
  readonly drift: Float32Array;
  /** Paint load (height multiplier) per integer s. */
  readonly load: Float32Array;
  /** Slow tone variation along the stroke, around 0, per integer s. */
  readonly toneAlong: Float32Array;
  readonly edgeRidge: number;
  readonly streakHeight: number;
  readonly streakTone: number;
}

type Rand = () => number;

function between(rand: Rand, lo: number, hi: number): number {
  return lo + (hi - lo) * rand();
}

/** Smooth value noise in 0..1 sampled at integer positions 0..n-1. */
function valueNoise(rand: Rand, n: number, period: number): Float32Array {
  const knots = Math.ceil(n / period) + 2;
  const lattice = new Float32Array(knots);
  for (let i = 0; i < knots; i++) lattice[i] = rand();
  const out = new Float32Array(n);
  const phase = rand() * period;
  for (let i = 0; i < n; i++) {
    const p = (i + phase) / period;
    const k = Math.floor(p);
    const f = p - k;
    const w = f * f * (3 - 2 * f);
    out[i] = (lattice[k] ?? 0) * (1 - w) + (lattice[k + 1] ?? 0) * w;
  }
  return out;
}

/** Weighted sum of value-noise octaves, renormalised to 0..1 over the table. */
function fractalNoise(rand: Rand, n: number, octaves: readonly (readonly [number, number])[]) {
  const out = new Float32Array(n);
  for (const [period, weight] of octaves) {
    const layer = valueNoise(rand, n, period);
    for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) + weight * (layer[i] ?? 0);
  }
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of out) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const span = hi - lo || 1;
  for (let i = 0; i < n; i++) out[i] = ((out[i] ?? 0) - lo) / span;
  return out;
}

/** Rounded cap: rises from 0 at x = 0 to 1 at x = size, like a quarter ellipse. */
function cap(x: number, size: number): number {
  const q = 1 - Math.min(1, Math.max(0, x) / size);
  return Math.sqrt(Math.max(0, 1 - q * q));
}

interface ProfileOptions {
  readonly length: number;
  readonly halfWidth: number;
  /** Half-width as a fraction of `halfWidth` at x = s / length. */
  readonly profile: (x: number) => number;
  /** Per-side wobble amplitude as a fraction of the width. */
  readonly wobble: number;
  readonly wobblePeriod: number;
}

function widthTables(rand: Rand, o: ProfileOptions): [Float32Array, Float32Array] {
  const n = Math.ceil(o.length) + 1;
  const sides: Float32Array[] = [];
  for (let side = 0; side < 2; side++) {
    const wobble = valueNoise(rand, n, o.wobblePeriod);
    const fine = valueNoise(rand, n, o.wobblePeriod / 4);
    const w = new Float32Array(n);
    for (let s = 0; s < n; s++) {
      const jitter = 1 + o.wobble * (2 * (wobble[s] ?? 0) - 1) + 0.25 * o.wobble * (fine[s] ?? 0);
      w[s] = Math.max(0, o.halfWidth * o.profile(s / o.length) * jitter);
    }
    sides.push(w);
  }
  return [sides[0] as Float32Array, sides[1] as Float32Array];
}

function constant(n: number, value: number): Float32Array {
  return new Float32Array(n).fill(value);
}

function alongTable(length: number, fn: (x: number) => number): Float32Array {
  const n = Math.ceil(length) + 1;
  const out = new Float32Array(n);
  for (let s = 0; s < n; s++) out[s] = fn(s / length);
  return out;
}

function makeSpec(kind: BrushKind, variant: number, rand: Rand): StrokeSpec {
  const tn = 2 * T_SPAN + 1;
  switch (kind) {
    case 'ridge': {
      const length = between(rand, 390, 440);
      const startCap = between(rand, 0.1, 0.15);
      const endCap = between(rand, 0.16, 0.26);
      const taper = between(rand, 0.28, 0.5);
      const [widthTop, widthBottom] = widthTables(rand, {
        length,
        halfWidth: between(rand, 74, 90),
        profile: (x) => cap(x, startCap) * cap(1 - x, endCap) * (1 - taper * x),
        wobble: 0.05,
        wobblePeriod: 60,
      });
      const pile = between(rand, 0.15, 0.3);
      return {
        frame: 'line',
        length,
        bend: between(rand, -14, 14),
        radius: 0,
        spiral: 0,
        mirror: false,
        widthTop,
        widthBottom,
        startS: constant(tn, 0),
        endS: constant(tn, length),
        streak: fractalNoise(rand, tn, [
          [5, 0.45],
          [11, 0.35],
          [29, 0.2],
        ]),
        drift: alongTable(length, (x) => 4 * Math.sin(Math.PI * x + variant)),
        load: alongTable(length, (x) => 1 - 0.35 * x + pile * Math.exp(-(((x - 0.9) / 0.05) ** 2))),
        toneAlong: fractalNoise(rand, Math.ceil(length) + 1, [[90, 1]]),
        edgeRidge: 0.3,
        streakHeight: 0.28,
        streakTone: 0.32,
      };
    }
    case 'bristle': {
      const length = between(rand, 400, 450);
      const taper = between(rand, 0.05, 0.2);
      const [widthTop, widthBottom] = widthTables(rand, {
        length,
        halfWidth: between(rand, 76, 92),
        profile: (x) => cap(x, 0.06) * cap(1 - x, 0.05) * (1 - taper * x),
        wobble: 0.04,
        wobblePeriod: 50,
      });
      // Clumped noise (period ≥ 16 px) so ragged ends are bristle bundles, not 1-texel slivers.
      const clumps = fractalNoise(rand, tn, [
        [18, 0.7],
        [40, 0.3],
      ]);
      const rag = between(rand, 0.16, 0.26);
      const startRag = between(rand, 0.02, 0.05);
      const startClumps = fractalNoise(rand, tn, [[24, 1]]);
      const endS = new Float32Array(tn);
      const startS = new Float32Array(tn);
      for (let i = 0; i < tn; i++) {
        const c = clumps[i] ?? 0;
        endS[i] = length * (1 - rag * c * c * (3 - 2 * c));
        startS[i] = length * startRag * (startClumps[i] ?? 0);
      }
      return {
        frame: 'line',
        length,
        bend: between(rand, -12, 12),
        radius: 0,
        spiral: 0,
        mirror: false,
        widthTop,
        widthBottom,
        startS,
        endS,
        streak: fractalNoise(rand, tn, [
          [3, 0.4],
          [7, 0.4],
          [17, 0.2],
        ]),
        drift: alongTable(length, (x) => 3 * Math.sin(2 * Math.PI * x + variant)),
        load: alongTable(length, (x) => 0.95 - 0.4 * x),
        toneAlong: fractalNoise(rand, Math.ceil(length) + 1, [[70, 1]]),
        edgeRidge: 0.12,
        streakHeight: 0.45,
        streakTone: 0.55,
      };
    }
    case 'dab': {
      const length = between(rand, 270, 330);
      const [widthTop, widthBottom] = widthTables(rand, {
        length,
        halfWidth: between(rand, 112, 132),
        profile: (x) => Math.sqrt(Math.max(0, 1 - (2 * x - 1) ** 2)) * (1 - 0.15 * x),
        wobble: 0.08,
        wobblePeriod: 34,
      });
      return {
        frame: 'line',
        length,
        bend: between(rand, -4, 4),
        radius: 0,
        spiral: 0,
        mirror: false,
        widthTop,
        widthBottom,
        startS: constant(tn, 0),
        endS: constant(tn, length),
        streak: fractalNoise(rand, tn, [
          [6, 0.5],
          [15, 0.5],
        ]),
        drift: alongTable(length, (x) => 8 * Math.sin(Math.PI * x * 1.5 + variant)),
        load: alongTable(length, (x) => 0.8 + 0.25 * Math.sin(Math.PI * x)),
        toneAlong: fractalNoise(rand, Math.ceil(length) + 1, [[60, 1]]),
        edgeRidge: 0.38,
        streakHeight: 0.22,
        streakTone: 0.3,
      };
    }
    case 'comma': {
      const length = between(rand, 400, 440);
      const head = between(rand, 0.12, 0.16);
      const tail = between(rand, 1.3, 1.7);
      const [widthTop, widthBottom] = widthTables(rand, {
        length,
        halfWidth: between(rand, 104, 116),
        profile: (x) => cap(x, head) * (1 - x ** tail),
        wobble: 0.05,
        wobblePeriod: 50,
      });
      return {
        frame: 'arc',
        length,
        bend: 0,
        radius: between(rand, 240, 280),
        spiral: -between(rand, 0.2, 0.32),
        mirror: variant === 1,
        widthTop,
        widthBottom,
        startS: constant(tn, 0),
        endS: constant(tn, length),
        streak: fractalNoise(rand, tn, [
          [5, 0.5],
          [12, 0.5],
        ]),
        drift: alongTable(length, (x) => 4 * Math.sin(Math.PI * x + variant)),
        load: alongTable(length, (x) => 1 - 0.45 * x),
        toneAlong: fractalNoise(rand, Math.ceil(length) + 1, [[80, 1]]),
        edgeRidge: 0.28,
        streakHeight: 0.3,
        streakTone: 0.36,
      };
    }
    case 'crescent': {
      const length = between(rand, 410, 445);
      const exponent = between(rand, 0.45, 0.6);
      const [widthTop, widthBottom] = widthTables(rand, {
        length,
        halfWidth: between(rand, 78, 88),
        profile: (x) => Math.sin(Math.PI * Math.min(1, Math.max(0, x))) ** exponent,
        wobble: 0.04,
        wobblePeriod: 60,
      });
      return {
        frame: 'arc',
        length,
        bend: 0,
        radius: between(rand, 240, 290),
        spiral: 0,
        mirror: variant === 1,
        widthTop,
        widthBottom,
        startS: constant(tn, 0),
        endS: constant(tn, length),
        streak: fractalNoise(rand, tn, [
          [4, 0.45],
          [10, 0.35],
          [26, 0.2],
        ]),
        drift: alongTable(length, (x) => 3 * Math.sin(Math.PI * x + variant)),
        load: alongTable(length, (x) => 0.85 + 0.1 * Math.sin(Math.PI * x)),
        toneAlong: fractalNoise(rand, Math.ceil(length) + 1, [[90, 1]]),
        edgeRidge: 0.3,
        streakHeight: 0.3,
        streakTone: 0.36,
      };
    }
  }
}

/** Per-pixel sample of a stroke's frame, reused to avoid allocation in the inner loop. */
interface FrameSample {
  s: number;
  t: number;
  halfWidth: number;
  ti: number;
}

function lerpTable(table: Float32Array, x: number): number {
  const last = table.length - 1;
  if (x <= 0) return table[0] ?? 0;
  if (x >= last) return table[last] ?? 0;
  const i = Math.floor(x);
  const f = x - i;
  return (table[i] ?? 0) * (1 - f) + (table[i + 1] ?? 0) * f;
}

/** Stroke-local placement: where the frame origin sits in cell px (centred by `centreShape`). */
interface Placement {
  readonly spec: StrokeSpec;
  readonly ox: number;
  readonly oy: number;
  /** arc: start angle of the centreline. */
  readonly startAngle: number;
}

/**
 * Maps a point in cell px (origin at the cell centre, +y = +v) into stroke coordinates:
 * s along the stroke from its start, t across it from the centreline.
 */
function toFrame(p: Placement, x: number, y: number, out: FrameSample): void {
  const spec = p.spec;
  const lx = x - p.ox;
  const ly = (spec.mirror ? -y : y) - p.oy;
  if (spec.frame === 'line') {
    const s = lx + spec.length / 2;
    const xn = Math.min(1, Math.max(0, s / spec.length));
    const centre = spec.bend * Math.sin(Math.PI * xn);
    const slope = ((spec.bend * Math.PI) / spec.length) * Math.cos(Math.PI * xn);
    out.s = s;
    out.t = (ly - centre) / Math.sqrt(1 + slope * slope);
  } else {
    let angle = Math.atan2(ly, lx);
    if (angle < -Math.PI / 2) angle += 2 * Math.PI;
    const s = spec.radius * (p.startAngle - angle);
    const xn = Math.min(1, Math.max(0, s / spec.length));
    out.s = s;
    out.t = Math.hypot(lx, ly) - spec.radius * (1 + spec.spiral * xn);
  }
  out.ti = out.t + T_SPAN;
  out.halfWidth = lerpTable(out.t >= 0 ? spec.widthTop : spec.widthBottom, out.s);
}

function inside(spec: StrokeSpec, f: FrameSample): boolean {
  if (Math.abs(f.t) > f.halfWidth) return false;
  return f.s >= lerpTable(spec.startS, f.ti) && f.s <= lerpTable(spec.endS, f.ti);
}

/** Centres the shape's bounding box on the cell centre by sampling its outline. */
function centreShape(spec: StrokeSpec): Placement {
  const startAngle = spec.frame === 'arc' ? Math.PI / 2 + spec.length / (2 * spec.radius) : 0;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const steps = Math.ceil(spec.length);
  for (let s = 0; s <= steps; s++) {
    const xn = s / spec.length;
    for (const [w, sign] of [
      [spec.widthTop[s] ?? 0, 1],
      [spec.widthBottom[s] ?? 0, -1],
    ] as const) {
      let x: number;
      let y: number;
      if (spec.frame === 'line') {
        x = s - spec.length / 2;
        y = spec.bend * Math.sin(Math.PI * xn) + sign * w;
      } else {
        const angle = startAngle - s / spec.radius;
        const r = spec.radius * (1 + spec.spiral * xn) + sign * w;
        x = r * Math.cos(angle);
        y = r * Math.sin(angle);
      }
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { spec, ox: -(minX + maxX) / 2, oy: -(minY + maxY) / 2, startAngle };
}

function smooth01(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/** Rasterises one brush into its cell of `data`. */
function drawBrush(data: Uint8Array, index: number, spec: StrokeSpec): void {
  const size = ATLAS_CELL_SIZE;
  const rect = brushTexelRect(index);
  const cellX = (index % ATLAS_GRID) * size;
  const cellY = Math.floor(index / ATLAS_GRID) * size;
  const x0 = rect.x - cellX + RECT_MARGIN;
  const x1 = rect.x - cellX + rect.width - RECT_MARGIN;
  const y0 = rect.y - cellY + RECT_MARGIN;
  const y1 = rect.y - cellY + rect.height - RECT_MARGIN;
  const place = centreShape(spec);
  const f: FrameSample = { s: 0, t: 0, halfWidth: 0, ti: 0 };
  const half = size / 2;

  // Pass 1: binary coverage at texel centres, clipped to the rect minus its margin.
  const binary = new Uint8Array(size * size);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      toFrame(place, px + 0.5 - half, py + 0.5 - half, f);
      if (inside(spec, f)) binary[py * size + px] = 1;
    }
  }

  // Pass 2: exact box-filtered coverage on boundary texels by 4 × 4 supersampling.
  const coverage = new Float32Array(size * size);
  const step = 1 / SUPERSAMPLE;
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = py * size + px;
      const b = binary[i] ?? 0;
      const edge =
        b !== binary[i - 1] ||
        b !== binary[i + 1] ||
        b !== binary[i - size] ||
        b !== binary[i + size];
      if (!edge) {
        coverage[i] = b;
        continue;
      }
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          toFrame(place, px + (sx + 0.5) * step - half, py + (sy + 0.5) * step - half, f);
          if (inside(spec, f)) hits++;
        }
      }
      coverage[i] = hits / (SUPERSAMPLE * SUPERSAMPLE);
    }
  }

  // Pass 3: a [1 2 1] / 4 separable blur widens the rim to 2–3 texels without texturing the body.
  const blurred = new Float32Array(size * size);
  for (let py = y0 - 1; py < y1 + 1; py++) {
    for (let px = x0 - 1; px < x1 + 1; px++) {
      const i = py * size + px;
      blurred[i] =
        0.25 * (coverage[i - 1] ?? 0) + 0.5 * (coverage[i] ?? 0) + 0.25 * (coverage[i + 1] ?? 0);
    }
  }
  for (let py = y0 - 1; py < y1 + 1; py++) {
    for (let px = x0 - 1; px < x1 + 1; px++) {
      const i = py * size + px;
      coverage[i] =
        0.25 * (blurred[i - size] ?? 0) + 0.5 * (blurred[i] ?? 0) + 0.25 * (blurred[i + size] ?? 0);
    }
  }

  // Pass 4: height and tone at texel centres wherever coverage is non-zero.
  for (let py = y0 - 1; py < y1 + 1; py++) {
    for (let px = x0 - 1; px < x1 + 1; px++) {
      const c = coverage[py * size + px] ?? 0;
      const r = Math.round(c * 255);
      if (r === 0) continue;
      toFrame(place, px + 0.5 - half, py + 0.5 - half, f);
      const across = Math.min(1, Math.abs(f.t) / Math.max(1, f.halfWidth));
      const dome = Math.sqrt(1 - across * across);
      const ridge = Math.exp(-(((across - 0.78) / 0.14) ** 2));
      const streak = lerpTable(spec.streak, f.ti + lerpTable(spec.drift, f.s)) - 0.5;
      const endFade = smooth01((lerpTable(spec.endS, f.ti) - f.s) / 12);
      const load = lerpTable(spec.load, f.s);
      const relief =
        load * (0.3 + 0.45 * dome + spec.edgeRidge * ridge) + spec.streakHeight * streak;
      const height = Math.min(1, Math.max(0, relief)) * endFade * c;
      const tone = 0.5 + spec.streakTone * streak + 0.1 * (lerpTable(spec.toneAlong, f.s) - 0.5);
      const o = ((cellY + py) * ATLAS_SIZE + cellX + px) * 4;
      data[o + BRUSH_CHANNEL.coverage] = r;
      data[o + BRUSH_CHANNEL.height] = Math.round(height * 255);
      data[o + BRUSH_CHANNEL.tone] = Math.round(Math.min(1, Math.max(0, tone)) * 255);
    }
  }
}

function brushSeed(seed: number, index: number): number {
  const base = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b);
  return (base ^ Math.imul(index + 1, 0xc2b2ae35)) >>> 0;
}

/** Generates the atlas RGBA8 bytes, row 0 first, for `seed`. Pure and deterministic. */
export function generateBrushAtlas(seed: number): Uint8Array {
  const data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i + BRUSH_CHANNEL.tone] = TONE_NEUTRAL;
    data[i + BRUSH_CHANNEL.spare] = 255;
  }
  for (let index = 0; index < BRUSH_COUNT; index++) {
    const brush = brushAt(index);
    const spec = makeSpec(brush.kind, brush.variant, mulberry32(brushSeed(seed, index)));
    drawBrush(data, index, spec);
  }
  return data;
}
