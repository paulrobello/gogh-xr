import { GLSL3, RawShaderMaterial, type Texture, Vector3, Vector4 } from 'three';
import {
  BACKDROP_RANK_SHIFT,
  BACKDROP_RANK_SPACING,
  backdropNdc,
  DEPTH_BACKDROP_FLAG,
} from './backdrop-depth';
import { ATLAS_SIZE, BRUSH_COUNT, brushTexelRect, brushUvRect } from './brush-atlas-data';
import {
  DEPTH_TIE_BREAK_FRONT_FLAG,
  DEPTH_TIE_BREAK_MAX_M,
  DEPTH_TIE_BREAK_STEPS,
  NDC_DEPTH_STEP,
} from './depth-tie-break';
import fragmentShader from './stroke.frag.glsl?raw';
import vertexShader from './stroke.vert.glsl?raw';

/** Towards the moon: from the upper right, in front of a viewer looking down -z. */
export const MOON_DIRECTION: Readonly<Vector3> = new Vector3(0.45, 0.6, 0.66).normalize();
/** Normal tilt per unit of height change over one stroke length. */
export const RELIEF_STRENGTH = 0.08;
/** Smallest relief finite-difference step, in mip-0 atlas texels. */
export const RELIEF_MIN_TEXELS = 2;

export interface StrokeMaterialUniforms {
  [name: string]: { value: unknown };
  uAtlas: { value: Texture };
  uBrushRects: { value: Vector4[] };
  uMoonDir: { value: Vector3 };
  uRelief: { value: number };
  /** Stroke-size multiplier: the quad's length and width scale by it. */
  uSizeScale: { value: number };
}

export type StrokeMaterial = RawShaderMaterial & { uniforms: StrokeMaterialUniforms };

/** A GLSL float literal: always carries a decimal point or an exponent. */
const glslFloat = (value: number): string => value.toExponential(8);

/**
 * Opaque alpha-to-coverage stroke material: no blending, depth write on, back faces culled (each
 * quad faces its instance normal). Colours are written as given, like the bench material.
 */
export function createStrokeMaterial(atlas: Texture, sizeScale = 1): StrokeMaterial {
  const uniforms: StrokeMaterialUniforms = {
    uAtlas: { value: atlas },
    uBrushRects: {
      value: Array.from({ length: BRUSH_COUNT }, (_, i) => {
        const rect = brushUvRect(i);
        return new Vector4(rect.u, rect.v, rect.width, rect.height);
      }),
    },
    uMoonDir: { value: MOON_DIRECTION.clone() },
    uRelief: { value: RELIEF_STRENGTH },
    uSizeScale: { value: sizeScale },
  };
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader,
    fragmentShader,
    uniforms,
    defines: {
      BRUSH_COUNT,
      ATLAS_SIZE,
      // Every brush rect spans the same texel width: one stroke length.
      RECT_TEXELS: brushTexelRect(0).width,
      RELIEF_MIN_TEXELS,
      DEPTH_TIE_BREAK_NDC: glslFloat(DEPTH_TIE_BREAK_STEPS * NDC_DEPTH_STEP),
      DEPTH_TIE_BREAK_MAX_M: glslFloat(DEPTH_TIE_BREAK_MAX_M),
      DEPTH_TIE_BREAK_FRONT_FLAG: `${DEPTH_TIE_BREAK_FRONT_FLAG}u`,
      DEPTH_BACKDROP_FLAG: `${DEPTH_BACKDROP_FLAG}u`,
      BACKDROP_FAR_NDC: glslFloat(backdropNdc(0, 'dome')),
      BACKDROP_RANK_NDC: glslFloat(BACKDROP_RANK_SPACING * NDC_DEPTH_STEP),
      BACKDROP_RANK_SHIFT: `${BACKDROP_RANK_SHIFT}u`,
    },
    transparent: false,
    depthWrite: true,
    alphaToCoverage: true,
  });
  material.name = 'stroke-a2c';
  return material as StrokeMaterial;
}
