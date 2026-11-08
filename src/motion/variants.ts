/**
 * Sky wrap A/B variants (src/diag/ab.ts, `?wrap`): alternatives to the sky swirl's wrap shrink
 * (P4.2), switched live by one shared uniform, `uSkyWrap`. motion.glsl reads it only inside
 * skyMotion, so each moving sky vertex pays one compare, and a still one none. At 0, base, the
 * motion runs today's code unchanged.
 *
 * - wrap `opacity`: the stroke keeps its full size through the wrap. Over the same wrap window its
 *   alpha-to-coverage alpha fades to 0 at the jump, then back in. The vertex shader hands the weight
 *   to the fragment shader as a flat varying, 1 for every other stroke. At alpha 0 the coverage
 *   mask is empty, so the stroke writes no sample: no colour and no depth.
 * - wrap `pingpong`: the stroke sweeps base's arc forward over half the loop and eases back along
 *   it over the other half, `tau = PERIOD (smoothstep(0, 1, 1 − |2f − 1|) − ½)`, with no wrap and no
 *   size change. |tau| stays within PERIOD / 2, as in base, so every reach bound (cull, haze thin)
 *   still holds. It covers the arc twice per loop, so its mean speed is twice base's and its peak
 *   three times.
 *
 * The uniform lives in variant-uniforms.ts, apart from this table.
 */

/** The sky swirl's wrap treatments (`?wrap`, the `wrap` A/B group), base first. */
export const SKY_WRAPS = ['base', 'opacity', 'pingpong'] as const;
export type SkyWrap = (typeof SKY_WRAPS)[number];

/** The shader code of each variant: its index in SKY_WRAPS. */
export const skyWrapCode = (wrap: SkyWrap): number => SKY_WRAPS.indexOf(wrap);

/** The material defines the variant branches in motion.glsl read. */
export function motionVariantGlslDefines(): Record<string, string | number> {
  return {
    SKY_WRAP_OPACITY: `${skyWrapCode('opacity')}u`,
    SKY_WRAP_PINGPONG: `${skyWrapCode('pingpong')}u`,
  };
}
