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
