/**
 * Backdrop depth: strokes on the sky dome are ordered by a stable per-instance rank, not by their
 * geometric depth. At the dome's 120 m one 24-bit window-depth step is about 8.6 mm, so the depth
 * tie-break's 0.25 m cap (depth-tie-break.ts) spans only about 29 steps. Dome strokes are about
 * 7 m long, lie tangent to a curved dome and overlap heavily, so they still traded places under
 * head-tracking noise (docs/verification.md, stroke flicker).
 *
 * A stroke whose spare meta byte carries DEPTH_BACKDROP_FLAG gets a constant clip z of `w × ndc`
 * in stroke.vert.glsl, so its quad is flat in depth at `backdropNdc(rank)`, just in front of the far
 * plane. The rank is the top bits of the stroke's position hash, so two overlapping dome strokes
 * keep one order whatever the eye does, and every dome stroke sits behind the rest of the world.
 * `w × ndc` keeps perspective-correct varyings, and behind the eye both clip planes reduce to
 * w ≥ 0, so clipping stays correct. The dome has no base mesh: the clear colour is its under-paint
 * (src/paintings/starry-night/base-meshes.ts).
 *
 * Stars and moon (STROKE_LAYER star and moon) will sit on the dome too and must draw over it. They
 * get the 'front' tier: the next BACKDROP_FRONT_RANKS ranks, all nearer than every dome rank and
 * still behind the world (tests/strokes-backdrop-depth.test.ts checks the budget). Today the shader
 * puts every flagged stroke in the dome tier. When those layers land, their scatter sets
 * DEPTH_BACKDROP_FLAG and the shader offsets a star or moon stroke's rank by BACKDROP_DOME_RANKS.
 */
import { NDC_DEPTH_STEP } from './depth-tie-break';

/** Bit in a stroke's spare meta byte (`iMeta.w`): the stroke draws at its backdrop rank's depth. */
export const DEPTH_BACKDROP_FLAG: number = 2;
/**
 * Window-depth steps between neighbouring ranks. Near z = 1 a step is 2 float ulps and the GPU's
 * divide by w can be 1-2 ulps off, so 4 steps keep two ranks from ever meeting.
 */
export const BACKDROP_RANK_SPACING: number = 4;
/** Window-depth steps between the far plane and rank 0 of the dome, a margin against clipping. */
export const BACKDROP_FAR_MARGIN: number = 16;
/** Ranks of the dome tier. A power of two: the shader takes the top bits of the hash. */
export const BACKDROP_DOME_RANKS: number = 1024;
/** Right shift that leaves log2(BACKDROP_DOME_RANKS) top bits of a 32-bit hash. */
export const BACKDROP_RANK_SHIFT: number = 32 - Math.log2(BACKDROP_DOME_RANKS);
/** Ranks reserved for the star and moon tier, in front of the dome tier. */
export const BACKDROP_FRONT_RANKS: number = 256;

export type BackdropTier = 'dome' | 'front';

/** Window-depth steps in front of the far plane at which `rank` of `tier` draws. */
export function backdropSteps(rank: number, tier: BackdropTier): number {
  const ranks = tier === 'dome' ? BACKDROP_DOME_RANKS : BACKDROP_FRONT_RANKS;
  if (!Number.isInteger(rank) || rank < 0 || rank >= ranks) {
    throw new RangeError(`backdrop rank ${rank} is outside 0..${ranks - 1} of the ${tier} tier`);
  }
  const first = tier === 'dome' ? 0 : BACKDROP_DOME_RANKS;
  return BACKDROP_FAR_MARGIN + BACKDROP_RANK_SPACING * (first + rank);
}

/** NDC z of `rank` of `tier`; the shader writes `w ×` this into clip z. */
export function backdropNdc(rank: number, tier: BackdropTier): number {
  return 1 - backdropSteps(rank, tier) * NDC_DEPTH_STEP;
}

/** View depth, metres, at which three's perspective projection gives NDC z `ndc`. */
export function viewDepthAtNdc(ndc: number, near: number, far: number): number {
  return (2 * far * near) / (far + near - ndc * (far - near));
}
