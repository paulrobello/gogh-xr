/**
 * Star and moon rings (P4.3): the star and moon layers' motion, and the table their additive halo
 * pass (src/render/sky-halo.ts) reads. Each of the 12 sky anchors (src/world/sky.ts, 11 stars then
 * the moon) carries a travelling wave that runs outward from its centre: at distance r metres and
 * motion time t its phase is `t / period + phase − r / wavelength`, and its height is
 * `ringBump(fract(phase))`, a bump in [0, 1] that is 0 at the wrap and smooth across it. A crest
 * leaves the centre once per period and crosses the rim in one period.
 *
 * - The anchor's own strokes (src/world/sky-lights.ts, which puts the anchor's index in each
 *   stroke's phase byte) slide radially outward by `swell × wave × hat(r)`, where `hat` is 0 inside
 *   `inner`, peaks halfway to `outer` and is 0 again at `outer`, the rim the haze cones are sized
 *   from. With swell ≤ 1 a moved stroke centre never passes `outer`, so the cones need no growth
 *   (R-P4b). Strokes from `inner` out also brighten by `bright × wave`. The stars ring from their
 *   centre (`inner` 0). The moon's `inner` is its own circle, so the crescent neither moves nor
 *   brightens, and only the glow band round it rings.
 * - The halo pass draws one soft additive glow per anchor over the strokes, carrying the same
 *   travelling rings in its brightness and swelling as a crest passes its peak radius. A star's glow
 *   peaks at its centre. The moon's is an annulus over 1.0-1.5 of its circle, peaking at 1.25, so no
 *   light lands on the crescent, which has no headroom left in R and G.
 *
 * Calm scales the offset and the brightness, both amplitudes, so the rings fade to rest as calm goes
 * to 0 (R-P4e). The gain stays 0: the rings never shrink a stroke. Every period divides the 3600 s
 * wrap of uTime (R-P4d): stars 3600 / round(3600 / T) for T in 3-7 s, the moon 3600 / 360 = 10 s.
 *
 * sky-rings.glsl is the GLSL; `skyRingGlslDefines` and `skyHaloGlslDefines` hand it these tables
 * as defines, so the two read one source. Change them together.
 */
import { PAINTER_EYE } from '../paintings/starry-night/canvas-camera';
import {
  BACKDROP_FRONT_RANKS,
  BACKDROP_RANK_SPACING,
  backdropNdc,
} from '../render/strokes/backdrop-depth';
import { NDC_DEPTH_STEP } from '../render/strokes/depth-tie-break';
import type { Vec3 } from '../render/strokes/frame';
import { anchorReach, SKY_LIGHT_RIM, type SkyAnchor, skyAnchors } from '../world/sky';

/** The star periods' range before quantising, seconds. */
export const SKY_RING_STAR_PERIODS: readonly [number, number] = [3, 7];
/** The moon's period: 3600 / 360, slower than any star. */
export const SKY_RING_MOON_PERIOD: number = 10;
/** Crest spacing, in units of the anchor's rim reach `outer`: one crest crosses the rim per period. */
export const SKY_RING_WAVELENGTH: number = 1;
/**
 * Radial swell of a star stroke at a crest: it moves out by `swell × hat`, at most `swell / 4` of
 * its rim reach, halfway out. At most 1, so no stroke centre passes the rim.
 */
export const SKY_RING_STAR_SWELL: number = 0.4;
/** The moon's glow band swells less, and its crescent not at all. */
export const SKY_RING_MOON_SWELL: number = 0.3;
/**
 * A star stroke draws at `1 + bright × wave` of its colour: 35% brighter on a crest. The moon's
 * band strokes brighten by up to 20%, and its crescent strokes, inside `inner`, not at all.
 */
export const SKY_RING_STAR_BRIGHT: number = 0.35;
export const SKY_RING_MOON_BRIGHT: number = 0.2;

/**
 * A star's halo radius at rest, in units of the rim reach: about 0.9 of the star's own circle, and
 * well inside the haze cone at any swell. Small, because blending is the Quest's fill cost.
 */
export const SKY_HALO_SIZE: number = 0.6;
/**
 * The moon's halo band, in units of its own circle: the glow peaks at `CENTRE` and falls to 0 at
 * `CENTRE ± WIDTH`, so it covers 1.0-1.5 and is 0 on the crescent. A swell only moves it outward.
 */
export const SKY_HALO_MOON_CENTRE: number = 1.25;
export const SKY_HALO_MOON_WIDTH: number = 0.25;
/** The halo swells by up to this share as a crest passes its peak radius. */
export const SKY_HALO_SWELL: number = 0.12;
/** The halo's peak additive brightness at rest, at its peak radius, per kind. */
export const SKY_HALO_STAR_REST: number = 0.1;
export const SKY_HALO_MOON_REST: number = 0.05;
/** Peak additive brightness the travelling rings add to the halo, per kind. */
export const SKY_HALO_STAR_RING: number = 0.14;
export const SKY_HALO_MOON_RING: number = 0.07;
/** Halo tints, display-referred 0-1 like the stroke colours: a pale star yellow and the crescent's gold. */
export const SKY_HALO_STAR_COLOUR: Vec3 = Object.freeze([1, 0.93, 0.68]) as Vec3;
export const SKY_HALO_MOON_COLOUR: Vec3 = Object.freeze([1, 0.82, 0.42]) as Vec3;
/**
 * NDC z the halo draws at: one rank spacing in front of the backdrop front tier's top rank, so it
 * draws over the dome and the moon and star strokes and behind the whole world, haze included.
 */
export const SKY_HALO_NDC: number =
  backdropNdc(BACKDROP_FRONT_RANKS - 1, 'front') - BACKDROP_RANK_SPACING * NDC_DEPTH_STEP;

/** One anchor's wave and halo. */
export interface SkyRing {
  readonly kind: SkyAnchor['kind'];
  readonly note: string;
  /** The anchor's world position on the dome. */
  readonly centre: Vec3;
  /** Seconds per crest, 3600 / n. */
  readonly period: number;
  /** The wave's phase at t = 0 at the centre, in [0, 1). */
  readonly phase: number;
  /** Strokes nearer the centre than this, metres, neither move nor brighten (the moon's crescent). */
  readonly inner: number;
  /** The rim reach, metres: `anchorReach(anchor, SKY_LIGHT_RIM)`, the haze cones' rim. */
  readonly outer: number;
  /** Crest spacing, metres. */
  readonly wavelength: number;
  /** Radial swell at a crest, at most 1. */
  readonly swell: number;
  /** Brightness at a crest. */
  readonly bright: number;
  /** The halo's peak radius at rest, metres: 0 for a star's centred glow, the band for the moon. */
  readonly haloCentre: number;
  /** The halo's half-width at rest, metres: its glow falls to 0 at `haloCentre ± haloSize`. */
  readonly haloSize: number;
  readonly haloRest: number;
  readonly haloRing: number;
  readonly haloColour: Vec3;
}

/** 3600 / round(3600 / period): the nearest period that divides the 3600 s wrap (R-P4d). */
export function quantisePeriod(period: number): number {
  return 3600 / Math.round(3600 / period);
}

const fract = (x: number): number => x - Math.floor(x);

/** The rings of `anchors`, 11 stars then the moon, as `skyAnchors()` lists them. */
export function skyRings(anchors: readonly SkyAnchor[] = skyAnchors()): readonly SkyRing[] {
  let star = 0;
  return Object.freeze(
    anchors.map((anchor) => {
      const moon = anchor.kind === 'moon';
      const outer = anchorReach(anchor, SKY_LIGHT_RIM);
      const disc = anchorReach(anchor, 1);
      // Spread the stars' periods and phases evenly over their ranges by the golden ratio and the
      // plastic number, so neighbouring stars never pulse together.
      const k = star;
      if (!moon) star++;
      const [lo, hi] = SKY_RING_STAR_PERIODS;
      return Object.freeze({
        kind: anchor.kind,
        note: anchor.note,
        centre: anchor.position,
        period: moon
          ? SKY_RING_MOON_PERIOD
          : quantisePeriod(lo + (hi - lo) * fract(0.5 + k * 0.6180339887)),
        phase: moon ? 0 : fract(k * 0.7548776662),
        inner: moon ? disc : 0,
        outer,
        wavelength: SKY_RING_WAVELENGTH * outer,
        swell: moon ? SKY_RING_MOON_SWELL : SKY_RING_STAR_SWELL,
        bright: moon ? SKY_RING_MOON_BRIGHT : SKY_RING_STAR_BRIGHT,
        haloCentre: moon ? SKY_HALO_MOON_CENTRE * disc : 0,
        haloSize: moon ? SKY_HALO_MOON_WIDTH * disc : SKY_HALO_SIZE * outer,
        haloRest: moon ? SKY_HALO_MOON_REST : SKY_HALO_STAR_REST,
        haloRing: moon ? SKY_HALO_MOON_RING : SKY_HALO_STAR_RING,
        haloColour: moon ? SKY_HALO_MOON_COLOUR : SKY_HALO_STAR_COLOUR,
      });
    }),
  );
}

export const SKY_RINGS: readonly SkyRing[] = skyRings();

/** Stars occupy indices 0..SKY_STAR_COUNT − 1 of SKY_RINGS and the moon SKY_MOON_RING. */
export const SKY_STAR_COUNT: number = SKY_RINGS.filter((r) => r.kind === 'star').length;
export const SKY_MOON_RING: number = SKY_RINGS.findIndex((r) => r.kind === 'moon');
if (SKY_MOON_RING !== SKY_STAR_COUNT || SKY_RINGS.length !== SKY_STAR_COUNT + 1) {
  throw new Error('sky rings: expected the stars first, then one moon');
}

/** The pulse's bump: (4f(1 − f))², 0 at f = 0 and 1, 1 at f = 0.5, flat across the wrap. */
export function ringBump(f: number): number {
  const b = 4 * f * (1 - f);
  return b * b;
}

/** The wave's height, 0-1, at `r` metres from the ring's centre at motion time `time`. */
export function ringWave(ring: SkyRing, r: number, time: number): number {
  return ringBump(fract(time / ring.period + ring.phase - r / ring.wavelength));
}

/** The radial envelope, metres: 0 inside `inner` and past `outer`, a parabola between. */
export function ringHat(ring: SkyRing, r: number): number {
  return (Math.max(r - ring.inner, 0) * Math.max(ring.outer - r, 0)) / (ring.outer - ring.inner);
}

export interface SkyRingMotion {
  readonly offset: Vec3;
  readonly turn: number;
  readonly gain: number;
  readonly bright: number;
}

/**
 * The ring motion, before calm, of a stroke centred at `position` that rings round `ring`, at
 * motion time `time`. Matches ringMotion in sky-rings.glsl, the clamped distance included.
 */
export function skyRing(ring: SkyRing, position: Vec3, time: number): SkyRingMotion {
  const dx = position[0] - ring.centre[0];
  const dy = position[1] - ring.centre[1];
  const dz = position[2] - ring.centre[2];
  const d2 = Math.max(dx * dx + dy * dy + dz * dz, 1e-6);
  const inv = 1 / Math.sqrt(d2);
  const r = d2 * inv;
  const w = ringWave(ring, r, time);
  const k = ring.swell * w * ringHat(ring, r) * inv;
  // GLSL step(inner, r): 0 below inner, 1 from it.
  const bright = r < ring.inner ? 0 : ring.bright * w;
  return { offset: [k * dx, k * dy, k * dz], turn: 0, gain: 0, bright };
}

/**
 * The farthest the ring moves a stroke centred at (x, y, z) from rest at calm 1, metres: the swell
 * times its hat, reached on a crest. Exact per stroke, allocation-free: the stroke batch calls it for
 * every star and moon stroke at build (R-P4a).
 */
export function skyRingReach(ring: SkyRing, x: number, y: number, z: number): number {
  const dx = x - ring.centre[0];
  const dy = y - ring.centre[1];
  const dz = z - ring.centre[2];
  const r = Math.sqrt(Math.max(dx * dx + dy * dy + dz * dz, 1e-6));
  return ring.swell * ringHat(ring, r);
}

/**
 * Bound on any star or moon stroke's ring displacement, metres: `swell × (outer − inner) / 4`, the
 * hat's peak, over every ring. A test checks it against the shader mirror over every light stroke.
 */
export const SKY_RING_REACH: number = Math.max(
  ...SKY_RINGS.map((r) => (r.swell * (r.outer - r.inner)) / 4),
);

/**
 * The ring a star or moon stroke with phase byte `phaseByte` rings round: the moon's for the moon
 * layer, the star the byte names (clamped) for the star layer. Matches the index starMotion and
 * moonMotion take in motion.glsl.
 */
export function ringOf(moon: boolean, phaseByte: number): SkyRing {
  return SKY_RINGS[moon ? SKY_MOON_RING : Math.min(phaseByte, SKY_STAR_COUNT - 1)];
}

export interface SkyHaloState {
  /** Drawn half-width, metres. */
  readonly size: number;
  /** Drawn peak radius, metres: 0 for a star. */
  readonly centre: number;
  /** The wave's phase at the anchor's centre, in [0, 1). */
  readonly phase: number;
  /** Peak brightness the rings add, calm included: 0 while the gate is closed. */
  readonly ring: number;
}

/**
 * Matches sky-halo.vert.glsl: the halo of `ring` at motion time `time`, with `live` the calm while
 * its layer's gate is open and 0 while it is closed. At 0 it is the rest halo whatever the time.
 * It swells as a crest passes its peak radius.
 */
export function skyHaloState(ring: SkyRing, time: number, live: number): SkyHaloState {
  const phase = fract(time / ring.period + ring.phase);
  const swell =
    1 + live * SKY_HALO_SWELL * ringBump(fract(phase - ring.haloCentre / ring.wavelength));
  return {
    size: ring.haloSize * swell,
    centre: ring.haloCentre * swell,
    phase,
    ring: live * ring.haloRing,
  };
}

/** The halo's outer reach at rest, metres: where its glow falls to 0. */
export function skyHaloExtent(ring: SkyRing): number {
  return ring.haloCentre + ring.haloSize;
}

/**
 * Matches sky-halo.frag.glsl: the additive brightness, before the tint, at `rho` metres from the
 * anchor's centre. At most `haloRest + haloRing` (≤ 0.24 for a star, 0.12 for the moon).
 */
export function skyHaloGlow(ring: SkyRing, state: SkyHaloState, rho: number): number {
  const s = (rho - state.centre) / state.size;
  const fall = Math.max(1 - s * s, 0) ** 2;
  const wave = ringBump(fract(state.phase - rho / ring.wavelength));
  return fall * (ring.haloRest + state.ring * wave);
}

/** A GLSL float literal: always carries a decimal point or an exponent. */
const glslFloat = (value: number): string => value.toExponential(8);
const vec4 = (values: readonly number[]): string => `vec4(${values.map(glslFloat).join(', ')})`;
const vec3 = (values: readonly number[]): string => `vec3(${values.map(glslFloat).join(', ')})`;

/** The defines sky-rings.glsl reads: the per-anchor wave tables, for both stroke and halo shaders. */
export function skyRingGlslDefines(
  rings: readonly SkyRing[] = SKY_RINGS,
): Record<string, string | number> {
  const n = rings.length;
  return {
    SKY_RING_COUNT: n,
    SKY_RING_STAR_COUNT: rings.filter((r) => r.kind === 'star').length,
    SKY_RING_MOON: rings.findIndex((r) => r.kind === 'moon'),
    SKY_RING_CENTRES: `vec4[${n}](${rings.map((r) => vec4([...r.centre, 1 / r.period])).join(', ')})`,
    SKY_RING_WAVES: `vec4[${n}](${rings
      .map((r) => vec4([r.phase, 1 / r.wavelength, r.inner, r.outer]))
      .join(', ')})`,
    SKY_RING_GAINS: `vec2[${n}](${rings
      .map((r) => `vec2(${glslFloat(r.swell / (r.outer - r.inner))}, ${glslFloat(r.bright)})`)
      .join(', ')})`,
  };
}

/** The defines sky-halo.vert.glsl adds: halo bands, brightness and tints, the eye and the NDC. */
export function skyHaloGlslDefines(
  rings: readonly SkyRing[] = SKY_RINGS,
): Record<string, string | number> {
  const n = rings.length;
  return {
    ...skyRingGlslDefines(rings),
    SKY_HALOS: `vec4[${n}](${rings
      .map((r) => vec4([r.haloCentre, r.haloSize, r.haloRest, r.haloRing]))
      .join(', ')})`,
    SKY_HALO_SWELL: glslFloat(SKY_HALO_SWELL),
    SKY_HALO_COLOURS: `vec3[${n}](${rings.map((r) => vec3(r.haloColour)).join(', ')})`,
    SKY_HALO_EYE: vec3(PAINTER_EYE),
    SKY_HALO_NDC: glslFloat(SKY_HALO_NDC),
  };
}
