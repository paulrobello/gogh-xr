/**
 * The stroke depth tie-break. Overlapping strokes on one surface sit within a fraction of a
 * depth-buffer step of each other, so head-tracking jitter re-sorts them every frame and they
 * strobe. The vertex shader (stroke.vert.glsl) moves each stroke towards the eye by a stable
 * random share of a range given in window-depth steps, so two overlapping strokes almost always
 * differ by more than a step. Only `gl_Position` changes, so early-z still works.
 *
 * The range is capped in metres of view depth, because a step grows with the square of the depth.
 * The cap is also how far apart two separate surfaces can be and still swap. At 0.25 m it does not
 * exceed the roof overhang or the 0.3 m gap between neighbouring roofs, so in far views eaves,
 * walls and roof edges trade places only along thin junction lines (docs/verification.md, stroke
 * flicker). A larger cap thickens those lines; a smaller one lets the flicker back.
 *
 * The scatter also lifts each stroke off its surface along the normal, and that lift is a
 * world-space order: from in front of a flat face, the stroke lifted more is nearer along every
 * ray. The tie-break is a depth-space order whose size in metres grows with the square of the view
 * depth. When the two orders disagree for an overlapping pair, the pair's depth gap passes through
 * zero at some view angle and distance, and past it the order flips as the viewer walks. So a
 * scattered stroke carries DEPTH_RANKED_FLAG, and one share drives both: the scatter lifts it by
 * that share of the largest lift, and the shader takes the same share of the tie-break range. The
 * share is a hash of the stroke's quad size (`sizeShare`), which the scatter writes exactly and the
 * lift does not move, so the scatter and the shader compute it alike. The lift is the share times
 * the graded length, which grows with the distance from the painter's eye, so two overlapping
 * neighbours with close shares can still disagree. In the seed-1 world that is 0.66% of
 * overlapping ground pairs, 0.18% of building pairs and 0.21% of cypress pairs, against about half
 * of them with independent orders. Where they agree, the order holds from any view in front of
 * parallel strokes.
 */

/** One 24-bit window-depth step in NDC z, whose range is 2. */
export const NDC_DEPTH_STEP: number = 2 ** -23;
/** Tie-break range in window-depth steps. */
export const DEPTH_TIE_BREAK_STEPS: number = 2048;
/** Most view depth the range may span, metres. */
export const DEPTH_TIE_BREAK_MAX_M: number = 0.25;
/**
 * Bit in a stroke's spare meta byte (`iMeta.w`): the stroke takes the whole range instead of a
 * random share, so it draws over almost every tie-broken stroke on its surface. Lit windows carry
 * it. Any detail meant to sit on top of its surface by less than the cap needs it too.
 */
export const DEPTH_TIE_BREAK_FRONT_FLAG: number = 1;
/**
 * Bit in a stroke's spare meta byte (`iMeta.w`): its tie-break share is `sizeShare` of its quad
 * size, the share its lift took. Bits 2-5 hold the fit level (face-clamp.ts). Strokes without it
 * (haze, `?demo=canvas`, `?strokesTest`) may repeat a size, so they take the position hash share.
 */
export const DEPTH_RANKED_FLAG: number = 64;
/** The 32-bit integer hash the vertex shader uses (`lowbias32` in stroke.vert.glsl). */
export function lowbias32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

const floatBits = new Float32Array(1);
const floatWord = new Uint32Array(floatBits.buffer);

/** The bits of `value` as a float32, as GLSL's floatBitsToUint reads them. */
export function float32Bits(value: number): number {
  floatBits[0] = value;
  return floatWord[0];
}

/**
 * The share of the largest lift and of the tie-break range a ranked stroke takes, in [0, 1): a hash
 * of its quad size as stored (float32), as the shader computes it.
 */
export function sizeShare(length: number, width: number): number {
  const h = lowbias32(float32Bits(length) ^ lowbias32(float32Bits(width)));
  return (h >>> 8) / 16777216;
}

/** View depth, metres, that one window-depth step spans at view depth `depth`. */
export function depthStepAt(depth: number, near: number, far: number): number {
  return (NDC_DEPTH_STEP * depth * depth * (far - near)) / (2 * far * near);
}

/** View depth, metres, that the whole tie-break range spans at view depth `depth`. */
export function depthTieBreakRange(depth: number, near: number, far: number): number {
  return Math.min(DEPTH_TIE_BREAK_STEPS * depthStepAt(depth, near, far), DEPTH_TIE_BREAK_MAX_M);
}

/**
 * The range in clip z, as the shader computes it from clip w and `projectionMatrix[3][2]`
 * (`p32`, which is -2fn / (f - n)). Behind the eye (w ≤ 0) the metre cap's 1 / w is unbounded, so
 * the step term alone applies there: it is linear in w, so clipping keeps it a constant NDC offset.
 */
export function depthTieBreakClipRange(w: number, p32: number): number {
  const steps = DEPTH_TIE_BREAK_STEPS * NDC_DEPTH_STEP * w;
  return w > 0 ? Math.min(steps, (-p32 * DEPTH_TIE_BREAK_MAX_M) / w) : steps;
}
