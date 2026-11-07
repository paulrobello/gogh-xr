/**
 * Cypress flame (P4.4): the cypress layer's motion. Every stroke rises up its lobe and wraps, and
 * the lobes flicker sideways, more toward the tips, so the tree licks upward like a flame.
 *
 * Rise. A stroke climbs the steepest ascent of its own plane, `up = Y − n (n · Y)`, unnormalised:
 * its length is sin φ, φ the normal's angle from the vertical, so it is fastest on the steep sides
 * and still at a flat top, and its vertical part `1 − n.y²` is never negative. The scatter lays each
 * stroke in its face's plane (face normals, world.ts), and on a lobe that plane is the lobe's, so the
 * climb follows the lobe surface to first order. The stroke sweeps a bounded arc of
 * ±CYPRESS_FLAME_HALF_ARC along it per CYPRESS_FLAME_PERIOD and wraps with its phase byte, as the
 * sky does (P4.2): "respawn at the base of its lobe" is the wrap back to the arc's low end, so the
 * displacement and the cull reach stay bounded. The arc tapers to nothing over the top
 * CYPRESS_FLAME_TIP of each mass, so no stroke climbs past an apex. The stroke shrinks to nothing at
 * the wrap (`gain`) and is never calm-scaled (amended R-P4e).
 *
 * Flicker. A lateral sway along the horizontal tangent `side = Y × n`, as long as `up` and
 * orthogonal to it: two travelling sines in y and time, phased by the lobe id, so each lobe sways
 * as one tongue and its crests run up the tree. The amplitude is CYPRESS_FLICKER_MAX times the
 * square of the stroke's normalised height, rising toward the tips. Every period divides 3600 s
 * (R-P4d).
 *
 * Per-stroke data. The scatter bakes each cypress stroke's lobe id and normalised height into the
 * reserved colour alpha byte (`encodeFlame`), which the default shader path never reads, so the
 * instance stride does not grow and the static render is unchanged. Deriving them in the shader
 * would cost an atan and the axis spline per vertex.
 *
 * motion.glsl's `cypressMotion` is the GLSL; `cypressFlameGlslDefines` hands it these constants.
 * Change the two together.
 */
import type { Vec3 } from '../render/strokes/frame';

/** Seconds per rise loop: 3600 / 900, so it divides the 3600 s wrap of uTime (ruling R-P4d). */
export const CYPRESS_FLAME_PERIOD: number = 4;
/**
 * Half the rise arc, metres along a vertical face: about half a cypress stroke length at the
 * painter's distance (0.0175 rad × 10 m × WORLD_SIZE_SCALE 1.8 = 0.315 m). A stroke climbs 0.3 m,
 * about 1.7° seen from the spot, every 4 s (0.075 m/s). The phases are random, so the rise reads
 * as a slow upward shimmer of the texture rather than a front; the sway carries the flame. The arc
 * is bounded by the hull: the climb runs in the stroke's own face plane, and the faceted, lobed
 * mesh bends away from that plane, so the excursion off the hull grows with the arc. Measured on
 * the seed-1 strokes, a 0.3 m half arc left the hull by up to 0.48 m (p99 0.19 m), 0.2 m by
 * 0.29 m and 0.12 m by 0.16 m. At 0.15 m, tests/motion-cypress-flame.test.ts measures the rise arc
 * leaving the hull by p99 7.4 cm (23.5% of the stroke's length) and at most 25 cm (81%), and
 * asserts p99 ≤ 25% and max ≤ 100% of the stroke's length.
 */
export const CYPRESS_FLAME_HALF_ARC: number = 0.15;
/**
 * The share of each loop, at either end, over which the stroke grows from nothing or shrinks to it:
 * 0.2 s of the 4 s loop. Ruling R-P4m halved it from 0.1 for the pinned coverage margin.
 */
export const CYPRESS_FLAME_FADE: number = 0.05;
/**
 * The arc tapers to 0 over this top share of each mass's normalised height, as
 * `smoothstep(0, TIP, 1 − h)`. smoothstep(x) / x peaks at 1.125, so a stroke climbs at most
 * `1.125 × HALF_ARC / TIP` times its remaining height share: under the apex whenever the mass is
 * taller than 2.25 m (both are).
 */
export const CYPRESS_FLAME_TIP: number = 0.15;
/**
 * Flicker amplitude at normalised height 1, metres along a vertical face: 0.80° at 10 m, about 45%
 * of a stroke length (ruling R-P4n asked for about 0.15 m: 0.15 m measured the sway hull test at p99
 * 25.3% of a stroke length, over its 25% bound). It scales by the height squared, so the lower
 * half sways at most a quarter of it and the base stays planted.
 */
export const CYPRESS_FLICKER_MAX: number = 0.14;
/**
 * The flicker's two travelling sines: weight, period (s, each 3600 / n) and wavelength up the tree
 * (m). Each sine's phase advances by `lobe` turns per lobe id. The weights sum to 1, so the sway
 * stays within ±CYPRESS_FLICKER_MAX × h².
 */
export const CYPRESS_FLICKER_WAVES: readonly {
  readonly weight: number;
  readonly period: number;
  readonly wavelength: number;
  readonly lobe: number;
}[] = Object.freeze([
  Object.freeze({ weight: 0.6, period: 2.4, wavelength: 2.5, lobe: 0.381966 }),
  Object.freeze({ weight: 0.4, period: 1.5, wavelength: 1.3, lobe: 0.723607 }),
]);

/** The alpha byte of a stroke with no flame data: it stays at rest on the cypress layer. */
export const CYPRESS_FLAME_NONE: number = 255;
/** Height levels in the low five bits: 0..30, so no lobe id and height make the 255 sentinel. */
export const CYPRESS_HEIGHT_LEVELS: number = 30;
/** Lobe ids fit the top three bits. */
export const CYPRESS_MAX_LOBES: number = 8;

const TAU = 2 * Math.PI;

/**
 * The alpha byte of a cypress stroke on lobe `lobe` at normalised height `height`: the lobe in the
 * top three bits, the height rounded up to a level of 1/30 in the low five. Rounding up keeps the
 * decoded height at or above the true one, so the tip taper never lets a stroke climb further.
 */
export function encodeFlame(lobe: number, height: number): number {
  if (!Number.isInteger(lobe) || lobe < 0 || lobe >= CYPRESS_MAX_LOBES) {
    throw new RangeError(`cypress lobe ${lobe} is outside 0..${CYPRESS_MAX_LOBES - 1}`);
  }
  const h = Math.min(1, Math.max(0, height));
  const level = Math.min(
    CYPRESS_HEIGHT_LEVELS,
    Math.max(0, Math.ceil(h * CYPRESS_HEIGHT_LEVELS - 1e-9)),
  );
  return (lobe << 5) | level;
}

/** Matches the decode in cypressMotion: null for the sentinel. */
export function decodeFlame(
  byte: number,
): { readonly lobe: number; readonly height: number } | null {
  if (byte === CYPRESS_FLAME_NONE) return null;
  return { lobe: byte >> 5, height: (byte & 31) / CYPRESS_HEIGHT_LEVELS };
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const fract = (x: number): number => x - Math.floor(x);

/** The rise arc's taper at decoded height `h`, in [0, 1]. */
export const flameTaper = (h: number): number => smoothstep(0, CYPRESS_FLAME_TIP, 1 - h);

/** The flicker amplitude at decoded height `h`, metres along a vertical face. */
export const flickerAmplitude = (h: number): number => CYPRESS_FLICKER_MAX * h * h;

/** The flicker's weight sum in [-1, 1] at world height `y`, lobe `lobe` and time `time`. */
export function flickerWave(lobe: number, y: number, time: number): number {
  let w = 0;
  for (const wave of CYPRESS_FLICKER_WAVES) {
    const turns = y / wave.wavelength - fract(time / wave.period) + lobe * wave.lobe;
    w += wave.weight * Math.sin(TAU * turns);
  }
  return w;
}

export interface CypressFlame {
  /** Displacement of the stroke centre, metres. */
  readonly offset: Vec3;
  readonly turn: number;
  /** Size delta: the stroke draws at 1 + gain of its size, gain in [-1, 0]. */
  readonly gain: number;
  readonly bright: number;
}

const STILL: CypressFlame = Object.freeze({
  offset: Object.freeze([0, 0, 0]) as Vec3,
  turn: 0,
  gain: 0,
  bright: 0,
});

/**
 * The cypress motion of a stroke centred at `position` with unit normal `normal`, phase fraction
 * `phase` and alpha byte `flameByte`, at motion time `time`, before calm. Matches cypressMotion in
 * motion.glsl.
 */
export function cypressFlame(
  position: Vec3,
  normal: Vec3,
  phase: number,
  flameByte: number,
  time: number,
): CypressFlame {
  const flame = decodeFlame(flameByte);
  if (flame === null) return STILL;
  const [nx, ny, nz] = normal;
  const taper = flameTaper(flame.height);
  const f = fract(time / CYPRESS_FLAME_PERIOD + phase);
  const s = (2 * f - 1) * CYPRESS_FLAME_HALF_ARC * taper;
  const a = flickerAmplitude(flame.height) * flickerWave(flame.lobe, position[1], time);
  return {
    // s × up + a × side, up = (−nx ny, 1 − ny², −nz ny), side = (nz, 0, −nx).
    offset: [-s * nx * ny + a * nz, s * (1 - ny * ny), -s * nz * ny - a * nx],
    turn: 0,
    gain: taper > 0 ? smoothstep(0, CYPRESS_FLAME_FADE, Math.min(f, 1 - f)) - 1 : 0,
    bright: 0,
  };
}

/**
 * The farthest the flame moves a stroke with unit normal y component `ny` and alpha byte
 * `flameByte` from rest at calm 1, metres. `up` and `side` are orthogonal with length
 * sin φ = √(1 − ny²), the rise reaches ±HALF_ARC × taper and the sway ±amplitude independently, so
 * the exact maximum is sin φ × √(rise² + sway²). The stroke batch grows a cypress chunk's cull
 * sphere by its largest (ruling R-P4a).
 */
export function cypressFlameReach(ny: number, flameByte: number): number {
  const flame = decodeFlame(flameByte);
  if (flame === null) return 0;
  const rise = CYPRESS_FLAME_HALF_ARC * flameTaper(flame.height);
  const sway = flickerAmplitude(flame.height);
  return Math.sqrt(Math.max(0, 1 - ny * ny)) * Math.hypot(rise, sway);
}

/** A GLSL float literal: always carries a decimal point or an exponent. */
const glslFloat = (value: number): string => value.toExponential(8);

/** The material defines cypressMotion in motion.glsl reads. */
export function cypressFlameGlslDefines(): Record<string, string | number> {
  const [w1, w2] = CYPRESS_FLICKER_WAVES;
  return {
    CYPRESS_FLAME_NONE: `${CYPRESS_FLAME_NONE}u`,
    CYPRESS_INV_HEIGHT_LEVELS: glslFloat(1 / CYPRESS_HEIGHT_LEVELS),
    CYPRESS_FLAME_INV_PERIOD: glslFloat(1 / CYPRESS_FLAME_PERIOD),
    CYPRESS_FLAME_HALF_ARC: glslFloat(CYPRESS_FLAME_HALF_ARC),
    CYPRESS_FLAME_FADE: glslFloat(CYPRESS_FLAME_FADE),
    CYPRESS_FLAME_TIP: glslFloat(CYPRESS_FLAME_TIP),
    CYPRESS_FLICKER_MAX: glslFloat(CYPRESS_FLICKER_MAX),
    CYPRESS_FLICKER_W1: glslFloat(w1.weight),
    CYPRESS_FLICKER_W2: glslFloat(w2.weight),
    CYPRESS_FLICKER_INV_P1: glslFloat(1 / w1.period),
    CYPRESS_FLICKER_INV_P2: glslFloat(1 / w2.period),
    CYPRESS_FLICKER_K1: glslFloat(1 / w1.wavelength),
    CYPRESS_FLICKER_K2: glslFloat(1 / w2.wavelength),
    CYPRESS_FLICKER_L1: glslFloat(w1.lobe),
    CYPRESS_FLICKER_L2: glslFloat(w2.lobe),
  };
}
