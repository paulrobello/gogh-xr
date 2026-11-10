/**
 * Sky wrap A/B variants (src/diag/ab.ts, `?wrap`): the sky swirl's wrap treatments, switched live
 * by one shared uniform, `uSkyWrap`. `wave` is the default, on Paul's headset verdict of 2026-11-08
 * at 2 waves per turn. `base` is the P4.2 wrap shrink. motion.glsl reads the uniform only in the
 * sky motion (and stroke.frag.glsl reads the stream's one flat float): under wave, code 0, a
 * moving sky vertex pays one compare in skyMotion, base two, pingpong three, wheel four, and stream
 * and wheelflow five, and a still vertex pays none.
 *
 * - wrap `wheel` (2026-11-09): the strokes whose centres lie half a stroke inside
 *   SKY_WHEEL_CORE_SCALE of a vortex's core turn rigidly and forever about the vortex's centre
 *   direction, one turn per 3600 / n seconds (skyWheels in sky-swirl.ts), so nothing resets.
 *   Strokes outside the wheels hold still. The boundary haze holds still everywhere. At calm 0 the
 *   discs hold the pose they reached (main.ts setSkyWrap, clock.ts setHoldMask).
 * - wrap `stream` (2026-11-09): every sky stroke stays at rest. Its brush tone scrolls along its
 *   long axis inside the fixed coverage footprint, in two layers half a loop apart whose weights
 *   sum to 1 (skyStreamWeights), so the paint streams with no reset and no pulse.
 * - wrap `wheelflow` (2026-11-10): `wheel` inside the wheels, `stream` outside them, so the paint
 *   feeding each swirl flows into it (Paul, 2026-11-10). The stream's shift fades to 0 over
 *   SKY_WHEELFLOW_BAND outside each wheel's members (skyWheelFlowShift), and its loop is
 *   SKY_WHEELFLOW_PERIOD, so the paint streams at about the wheels' rim speed.
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
 * The `opacity` wrap was retired on Paul's verdict (pingpong above it), and `lift` on his headset
 * verdict of 2026-11-09 ("the other half seem to zip around in short bursts"): its reset read as
 * zips (docs/verification.md, Sky wrap variants: wheel and stream).
 *
 * The uniform lives in variant-uniforms.ts, apart from this table.
 */

/**
 * The sky swirl's wrap treatments (`?wrap`, the `wrap` A/B group), the default first. The A/B
 * group cycles them in this order, so one press from wave reaches wheel, two reach stream, and
 * wheelflow, appended last so the other codes hold, steps back to wave.
 */
export const SKY_WRAPS = ['wave', 'wheel', 'stream', 'base', 'pingpong', 'wheelflow'] as const;
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
    SKY_WRAP_WHEEL: `${skyWrapCode('wheel')}u`,
    SKY_WRAP_STREAM: `${skyWrapCode('stream')}u`,
    SKY_WRAP_BASE: `${skyWrapCode('base')}u`,
    SKY_WRAP_PINGPONG: `${skyWrapCode('pingpong')}u`,
    SKY_WRAP_WHEELFLOW: `${skyWrapCode('wheelflow')}u`,
  };
}
