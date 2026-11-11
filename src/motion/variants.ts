/**
 * Sky wrap A/B variants (src/diag/ab.ts, `?wrap`): the sky swirl's wrap treatments, switched live
 * by one shared uniform, `uSkyWrap`. `wheelrun` is the default (Paul, 2026-11-10). `base` is the
 * P4.2 wrap shrink. motion.glsl reads the uniform only in the sky motion (and stroke.frag.glsl reads
 * the stream's one flat float): the river arms (wheelflow, wheelrun) pay one compare in skyMotion,
 * wave two, base three, pingpong four, wheel and stream five, and a still vertex pays none.
 *
 * - wrap `wheel` (2026-11-09): the strokes whose centres lie half a stroke inside
 *   SKY_WHEEL_CORE_SCALE of a vortex's core turn rigidly and forever about the vortex's centre
 *   direction, one turn per 3600 / n seconds (skyWheels in sky-swirl.ts), so nothing resets.
 *   Strokes outside the wheels hold still. The boundary haze holds still everywhere. At calm 0 the
 *   discs hold the pose they reached (main.ts setSkyWrap, clock.ts setHoldMask).
 * - wrap `stream` (2026-11-09): every sky stroke stays at rest. Its brush tone scrolls along its
 *   long axis inside the fixed coverage footprint, in two layers half a loop apart whose weights
 *   sum to 1 (skyStreamWeights), so the paint streams with no reset and no pulse.
 * - the river arms (2026-11-10, Paul's drawn flow, sky-river.ts): three wheels turn (the small
 *   right swirl, the moon and the large star; the big swirl's wheel is dropped), and every other
 *   sky stroke slides along its own painted brush direction, the way Paul's arrows send it, by a
 *   rotation baked per stroke (iRiver). Each stroke's travel fades by its own clearance from the
 *   kept wheels' edges (skyWheelFlowTravel), so no moved centre crosses a turning disc's edge.
 *   - wrap `wheelrun`, the default: one way, base's loop, each stroke shrinking to nothing as it
 *     jumps back, so the paint runs on along the river.
 *   - wrap `wheelflow`: forward and back on pingpong's curve, in bands 30° apart along the river's
 *     stream coordinate that travel downstream.
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
 * The sky swirl's wrap treatments (`?wrap`), in shader-code order: each one's index is its
 * `uSkyWrap` code, so a new wrap is appended and no code moves.
 */
export const SKY_WRAPS = [
  'wave',
  'wheel',
  'stream',
  'base',
  'pingpong',
  'wheelflow',
  'wheelrun',
] as const;
export type SkyWrap = (typeof SKY_WRAPS)[number];

/** The wrap every boot draws without `?wrap`: wheelrun, the one-way river (Paul, 2026-11-10). */
export const DEFAULT_SKY_WRAP: SkyWrap = 'wheelrun';

/**
 * The `wrap` A/B group's cycle (`?ab=wrap`): the default first, then wheelflow, so one press
 * compares the two river arms, then the older arms.
 */
export const SKY_WRAP_AB_ORDER: readonly SkyWrap[] = Object.freeze([
  'wheelrun',
  'wheelflow',
  'wave',
  'wheel',
  'stream',
  'base',
  'pingpong',
]);

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
    SKY_WRAP_WHEELRUN: `${skyWrapCode('wheelrun')}u`,
  };
}
