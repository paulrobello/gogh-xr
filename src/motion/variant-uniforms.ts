/**
 * The sky wrap A/B variant's shared uniforms (src/motion/variants.ts). Every stroke material spreads
 * `motionVariants.uniforms`, as it does `motionClock`'s, so one write reaches every band material
 * and the teleport arc.
 */
import { SKY_WAVE_PER_TURN, type SkyWaveTurns } from './sky-swirl';
import { DEFAULT_SKY_WRAP, SKY_WRAPS, type SkyWrap, skyWrapCode } from './variants';

export interface MotionVariantUniforms {
  [name: string]: { value: unknown };
  /**
   * SKY_WRAPS index: 0 wave, 1 wheel, 2 stream, 3 base, 4 pingpong, 5 wheelflow (the default),
   * 6 wheelrun.
   */
  uSkyWrap: { value: number };
  /**
   * The wave's waves per turn (SKY_WAVE_TURNS), read by skyWavePhase on the wave branch and on
   * the default wheelflow's branch outside the wheels.
   */
  uWaveTurns: { value: number };
}

export interface MotionVariants {
  readonly uniforms: MotionVariantUniforms;
  setWrap(wrap: SkyWrap): void;
  setWaveTurns(turns: SkyWaveTurns): void;
  /** The wave wrap's waves per turn. */
  waveTurns(): SkyWaveTurns;
  diag(): { wrap: SkyWrap };
}

export function createMotionVariants(): MotionVariants {
  const uniforms: MotionVariantUniforms = {
    uSkyWrap: { value: skyWrapCode(DEFAULT_SKY_WRAP) },
    uWaveTurns: { value: SKY_WAVE_PER_TURN },
  };
  return {
    uniforms,
    setWrap(wrap) {
      uniforms.uSkyWrap.value = skyWrapCode(wrap);
    },
    setWaveTurns(turns) {
      uniforms.uWaveTurns.value = turns;
    },
    waveTurns: () => uniforms.uWaveTurns.value as SkyWaveTurns,
    diag: () => ({ wrap: SKY_WRAPS[uniforms.uSkyWrap.value] ?? DEFAULT_SKY_WRAP }),
  };
}

/** The app's variants, shared by every stroke material (material.ts). */
export const motionVariants: MotionVariants = createMotionVariants();
