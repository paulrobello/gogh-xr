/**
 * Sky wrap A/B variants (src/diag/ab.ts, `?wrap`): alternatives to the sky swirl's wrap shrink
 * (P4.2), switched live by one shared uniform, `uSkyWrap`. motion.glsl reads it only in the sky
 * motion: under base a moving sky vertex pays one compare in skyMotion, pingpong and wave add a
 * second inside skyWrapMotion, and a still vertex pays none. At 0, base, the motion runs today's
 * code unchanged.
 *
 * - wrap `pingpong`: the stroke sweeps base's arc forward over half the loop and eases back along
 *   it over the other half, `tau = PERIOD (smoothstep(0, 1, 1 − |2f − 1|) − ½)`, with no wrap and no
 *   size change. |tau| stays within PERIOD / 2, as in base, so every reach bound (cull, haze thin)
 *   still holds. It covers the arc twice per loop, so its mean speed is twice base's and its peak
 *   three times. Each stroke's loop phase is its own phase byte, so at any moment about half the
 *   strokes are on their way back, side by side with ones going forward.
 * - wrap `wave`: pingpong's motion, with the loop phase a smooth function of the stroke's direction
 *   from the painter's eye instead of its phase byte (`skyWavePhase` in sky-swirl.ts). It winds a
 *   whole number of times round each swirl, so neighbouring strokes move together, forward and
 *   returning bands alternate along each swirl's arc, and the bands travel forward along the flow.
 *
 * The `opacity` wrap was retired on Paul's verdict (pingpong above it), and `flow`, a paint-detail
 * scroll inside a still stroke, is not built: the brush atlas has no detail that can scroll along
 * a stroke without a seam (docs/verification.md, Sky wrap variants: wave).
 *
 * The uniform lives in variant-uniforms.ts, apart from this table.
 */

/** The sky swirl's wrap treatments (`?wrap`, the `wrap` A/B group), base first. */
export const SKY_WRAPS = ['base', 'pingpong', 'wave'] as const;
export type SkyWrap = (typeof SKY_WRAPS)[number];

/**
 * The `wave` wrap's wavelengths in waves per turn (`?waveturns`, the `uWaveTurns` uniform), the
 * default SKY_WAVE_PER_TURN in sky-swirl.ts.
 */
export const SKY_WAVE_TURNS = [1, 2, 3] as const;
export type SkyWaveTurns = (typeof SKY_WAVE_TURNS)[number];

/** The shader code of each variant: its index in SKY_WRAPS. */
export const skyWrapCode = (wrap: SkyWrap): number => SKY_WRAPS.indexOf(wrap);

/** The material defines the variant branches in motion.glsl read. */
export function motionVariantGlslDefines(): Record<string, string | number> {
  return {
    SKY_WRAP_WAVE: `${skyWrapCode('wave')}u`,
  };
}
