/**
 * The motion A/B variants' shared uniforms (src/motion/variants.ts). Every stroke material spreads
 * `motionVariants.uniforms`, as it does `motionClock`'s, so one write reaches every band material
 * and the teleport arc.
 */
import { DataTexture, LinearFilter, RGBAFormat, Texture, UnsignedByteType } from 'three';
import {
  FLAME_SWAYS,
  type FlameSway,
  flameSwayCode,
  SKY_BASE_SIZE,
  SKY_WRAPS,
  type SkyBaseStrokes,
  type SkyWrap,
  skyBaseMap,
  skyWrapCode,
} from './variants';

export interface MotionVariantUniforms {
  [name: string]: { value: unknown };
  /** SKY_WRAPS index: 0 base, 1 fade, 2 half. */
  uSkyWrap: { value: number };
  /** FLAME_SWAYS index: 0 base, 1 wind. */
  uCypressSway: { value: number };
  /**
   * The `fade` wrap's target colours (`skyBaseMap`). Until built it is an empty texture that is
   * never uploaded, so three binds its own internal one and a boot without the fade map uploads no
   * extra texture (tests/e2e/locomotion.spec.ts counts the first aim's).
   */
  uSkyBase: { value: Texture };
}

export interface MotionVariants {
  readonly uniforms: MotionVariantUniforms;
  setWrap(wrap: SkyWrap): void;
  setFlame(sway: FlameSway): void;
  /** Uploads the `fade` wrap's base map (`skyBaseMap`), replacing any earlier one. */
  setSkyBase(map: Uint8Array, size: number): void;
  /**
   * Builds the base map from the `layer` strokes of `sets`, by direction from `eye`, unless one is
   * built already, and says whether it built. main.ts calls it for the first bound stroke batch of
   * any scene (a world, the canvas demo or the test scene), so `fade` never samples the empty
   * texture where a batch has sky strokes.
   */
  buildSkyBase(
    sets: readonly SkyBaseStrokes[],
    layer: number,
    eye: readonly [number, number, number],
  ): boolean;
  diag(): { wrap: SkyWrap; flame: FlameSway; skyBase: boolean };
}

export function createMotionVariants(): MotionVariants {
  const uniforms: MotionVariantUniforms = {
    uSkyWrap: { value: 0 },
    uCypressSway: { value: 0 },
    uSkyBase: { value: new Texture() },
  };
  let built = false;
  function setSkyBase(map: Uint8Array, size: number): void {
    const texture = new DataTexture(map, size, size, RGBAFormat, UnsignedByteType);
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    uniforms.uSkyBase.value.dispose();
    uniforms.uSkyBase.value = texture;
    built = true;
  }
  return {
    uniforms,
    setWrap(wrap) {
      uniforms.uSkyWrap.value = skyWrapCode(wrap);
    },
    setFlame(sway) {
      uniforms.uCypressSway.value = flameSwayCode(sway);
    },
    setSkyBase,
    buildSkyBase(sets, layer, eye) {
      if (built) return false;
      setSkyBase(skyBaseMap(sets, layer, eye), SKY_BASE_SIZE);
      return true;
    },
    diag: () => ({
      wrap: SKY_WRAPS[uniforms.uSkyWrap.value] ?? 'base',
      flame: FLAME_SWAYS[uniforms.uCypressSway.value] ?? 'base',
      skyBase: built,
    }),
  };
}

/** The app's variants, shared by every stroke material (material.ts). */
export const motionVariants: MotionVariants = createMotionVariants();
