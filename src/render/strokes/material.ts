import { GLSL3, RawShaderMaterial, type Texture, Vector3, Vector4 } from 'three';
import { type MotionUniforms, motionClock } from '../../motion/clock';
import motionShader from '../../motion/motion.glsl?raw';
import {
  BACKDROP_DOME_RANKS,
  BACKDROP_FRONT_RANK_SHIFT,
  BACKDROP_RANK_SHIFT,
  BACKDROP_RANK_SPACING,
  backdropNdc,
  DEPTH_BACKDROP_FLAG,
} from './backdrop-depth';
import { ATLAS_SIZE, BRUSH_COUNT, brushTexelRect, brushUvRect } from './brush-atlas-data';
import {
  DEPTH_RANKED_FLAG,
  DEPTH_TIE_BREAK_FRONT_FLAG,
  DEPTH_TIE_BREAK_MAX_M,
  DEPTH_TIE_BREAK_STEPS,
  NDC_DEPTH_STEP,
} from './depth-tie-break';
import { FIT_SCALE_MASK, FIT_SCALE_SHIFT, FIT_SCALE_STEP } from './face-clamp';
import { STROKE_LAYER } from './instance';
import {
  SKY_LIGHT_CONES,
  SKY_LIGHT_CULL_FLAG,
  SKY_LIGHT_MIN_FEATHER,
  skyLightConeUniforms,
  skyLightFeatherUniforms,
} from './sky-light-cull';
import fragmentShader from './stroke.frag.glsl?raw';
import strokeVertexShader from './stroke.vert.glsl?raw';

/** The line in stroke.vert.glsl that motion.glsl replaces. */
export const MOTION_INCLUDE = '// #include motion.glsl';

/**
 * Splices `chunk` in place of the line starting `marker` in `source`. Throws unless exactly one
 * line does. three's own `#include <name>` resolves against its ShaderChunk table, even for a raw
 * shader, so the stroke shader uses a comment marker instead.
 */
export function spliceGlsl(source: string, marker: string, chunk: string): string {
  const lines = source.split('\n');
  const at = lines.flatMap((line, i) => (line.startsWith(marker) ? [i] : []));
  if (at.length !== 1) throw new Error(`expected one "${marker}" line, found ${at.length}`);
  lines.splice(at[0], 1, chunk.trimEnd());
  return lines.join('\n');
}

const vertexShader = spliceGlsl(strokeVertexShader, MOTION_INCLUDE, motionShader);

/** Towards the moon: from the upper right, in front of a viewer looking down -z. */
export const MOON_DIRECTION: Readonly<Vector3> = new Vector3(0.45, 0.6, 0.66).normalize();
/** Normal tilt per unit of height change over one stroke length. */
export const RELIEF_STRENGTH = 0.08;
/** Smallest relief finite-difference step, in mip-0 atlas texels. */
export const RELIEF_MIN_TEXELS = 2;
/**
 * Boundary haze strokes grow by up to this share of their size at `uHazeThickness` 1 (P3.5). The
 * cull sphere of a chunk holding haze always includes the full growth (batch.ts).
 */
export const HAZE_GROWTH = 0.5;

/** The motion uniforms (src/motion/clock.ts) are `motionClock`'s own objects, shared by reference. */
export interface StrokeMaterialUniforms extends MotionUniforms {
  [name: string]: { value: unknown };
  uAtlas: { value: Texture };
  uBrushRects: { value: Vector4[] };
  uMoonDir: { value: Vector3 };
  uRelief: { value: number };
  /** Stroke-size multiplier: the quad's length and width scale by it. */
  uSizeScale: { value: number };
  /** Moon and star discs whose cones thin SKY_LIGHT_CULL_FLAG strokes (sky-light-cull.ts). */
  uSkyLightCones: { value: Vector4[] };
  /**
   * Boundary haze thickening, 0-1 (P3.5): haze strokes grow by `HAZE_GROWTH` times it. The haze is
   * the only sky-layer stroke carrying SKY_LIGHT_CULL_FLAG (src/paintings/starry-night/world.ts),
   * as the flags byte has no spare bit for a haze flag of its own. 0 draws the world as built.
   */
  uHazeThickness: { value: number };
  /** Each cone's feather in metres, past its radius (sky-light-cull.ts). */
  uSkyLightFeathers: { value: number[] };
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
    uSkyLightCones: { value: skyLightConeUniforms([]) },
    uHazeThickness: { value: 0 },
    uSkyLightFeathers: { value: skyLightFeatherUniforms([]) },
    ...motionClock.uniforms,
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
      DEPTH_RANKED_FLAG: `${DEPTH_RANKED_FLAG}u`,
      DEPTH_BACKDROP_FLAG: `${DEPTH_BACKDROP_FLAG}u`,
      BACKDROP_FAR_NDC: glslFloat(backdropNdc(0, 'dome')),
      BACKDROP_RANK_NDC: glslFloat(BACKDROP_RANK_SPACING * NDC_DEPTH_STEP),
      BACKDROP_RANK_SHIFT: `${BACKDROP_RANK_SHIFT}u`,
      BACKDROP_DOME_RANKS: `${BACKDROP_DOME_RANKS}u`,
      BACKDROP_FRONT_RANK_SHIFT: `${BACKDROP_FRONT_RANK_SHIFT}u`,
      STROKE_LAYER_SKY: `${STROKE_LAYER.sky}u`,
      STROKE_LAYER_STAR: `${STROKE_LAYER.star}u`,
      STROKE_LAYER_MOON: `${STROKE_LAYER.moon}u`,
      STROKE_LAYER_CYPRESS: `${STROKE_LAYER.cypress}u`,
      FIT_SCALE_SHIFT: `${FIT_SCALE_SHIFT}u`,
      FIT_SCALE_MASK: `${FIT_SCALE_MASK}u`,
      FIT_SCALE_STEP: glslFloat(FIT_SCALE_STEP),
      SKY_LIGHT_CONES,
      SKY_LIGHT_CULL_FLAG: `${SKY_LIGHT_CULL_FLAG}u`,
      HAZE_GROWTH: glslFloat(HAZE_GROWTH),
      SKY_LIGHT_MIN_FEATHER: glslFloat(SKY_LIGHT_MIN_FEATHER),
      SKY_LIGHT_MIN_FEATHER_COS: glslFloat(Math.cos(SKY_LIGHT_MIN_FEATHER)),
      SKY_LIGHT_MIN_FEATHER_SIN: glslFloat(Math.sin(SKY_LIGHT_MIN_FEATHER)),
    },
    transparent: false,
    depthWrite: true,
    alphaToCoverage: true,
  });
  material.name = 'stroke-a2c';
  return material as StrokeMaterial;
}
