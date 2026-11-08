/**
 * The sky wrap A/B variant's shared uniforms (src/motion/variants.ts). Every stroke material spreads
 * `motionVariants.uniforms`, as it does `motionClock`'s, so one write reaches every band material
 * and the teleport arc.
 */
import { SKY_WAVE_PER_TURN, type SkyWaveTurns } from './sky-swirl';
import { SKY_WRAPS, type SkyWrap, skyWrapCode } from './variants';

export interface MotionVariantUniforms {
  [name: string]: { value: unknown };
  /** SKY_WRAPS index: 0 base, 1 pingpong, 2 wave. */
  uSkyWrap: { value: number };
  /** The wave wrap's waves per turn (SKY_WAVE_TURNS), read only on the wave branch. */
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
    uSkyWrap: { value: 0 },
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
    diag: () => ({ wrap: SKY_WRAPS[uniforms.uSkyWrap.value] ?? 'base' }),
  };
}

/** The app's variants, shared by every stroke material (material.ts). */
export const motionVariants: MotionVariants = createMotionVariants();
