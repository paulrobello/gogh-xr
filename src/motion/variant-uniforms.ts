/**
 * The sky wrap A/B variant's shared uniform (src/motion/variants.ts). Every stroke material spreads
 * `motionVariants.uniforms`, as it does `motionClock`'s, so one write reaches every band material
 * and the teleport arc.
 */
import { SKY_WRAPS, type SkyWrap, skyWrapCode } from './variants';

export interface MotionVariantUniforms {
  [name: string]: { value: unknown };
  /** SKY_WRAPS index: 0 base, 1 opacity, 2 pingpong. */
  uSkyWrap: { value: number };
}

export interface MotionVariants {
  readonly uniforms: MotionVariantUniforms;
  setWrap(wrap: SkyWrap): void;
  diag(): { wrap: SkyWrap };
}

export function createMotionVariants(): MotionVariants {
  const uniforms: MotionVariantUniforms = {
    uSkyWrap: { value: 0 },
  };
  return {
    uniforms,
    setWrap(wrap) {
      uniforms.uSkyWrap.value = skyWrapCode(wrap);
    },
    diag: () => ({ wrap: SKY_WRAPS[uniforms.uSkyWrap.value] ?? 'base' }),
  };
}

/** The app's variants, shared by every stroke material (material.ts). */
export const motionVariants: MotionVariants = createMotionVariants();
