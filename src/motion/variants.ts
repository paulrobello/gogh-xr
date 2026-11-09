/**
 * Sky wrap A/B variants (src/diag/ab.ts, `?wrap`): the sky swirl's wrap treatments, switched live
 * by one shared uniform, `uSkyWrap`. `wave` is the default, on Paul's headset verdict of 2026-11-08
 * at 2 waves per turn. `base` is the P4.2 wrap shrink. motion.glsl reads the uniform only in the
 * sky motion: under wave, code 0, a moving sky vertex pays one compare in skyMotion, base and
 * pingpong a second, and a still vertex pays none.
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

/**
 * The sky swirl's wrap treatments (`?wrap`, the `wrap` A/B group), the default first. The A/B
 * group cycles them in this order, so base still steps to pingpong and pingpong back to wave.
 */
export const SKY_WRAPS = ['wave', 'base', 'pingpong'] as const;
export type SkyWrap = (typeof SKY_WRAPS)[number];

/** The wrap every boot draws without `?wrap`: wave (docs/verification.md, sky wrap default). */
export const DEFAULT_SKY_WRAP: SkyWrap = SKY_WRAPS[0];

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
    SKY_WRAP_BASE: `${skyWrapCode('base')}u`,
  };
}
