import { GLSL3, RawShaderMaterial, Vector2, Vector4, type WebGLRenderer } from 'three';
import type { BenchMode } from '../diag/flags';

/** Stroke width as a fraction of its length (`size` px is the long axis). */
export const WIDTH_RATIO = 1 / 3;

const vertexShader = /* glsl */ `
precision highp float;

in vec3 position;
in mat4 instanceMatrix;
in vec3 instanceColor;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 uViewport;
uniform float uSizePx;

out vec2 vUv;
out vec3 vColor;
out float vSeed;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 center = instanceMatrix[3].xyz;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(center, 1.0);
  float seed = hash13(center);
  float angle = seed * 6.2831853;
  vec2 dir = vec2(cos(angle), sin(angle));
  vec2 local = position.xy * vec2(uSizePx, uSizePx * ${WIDTH_RATIO.toFixed(6)});
  vec2 px = vec2(local.x * dir.x - local.y * dir.y, local.x * dir.y + local.y * dir.x);
  clip.xy += px * 2.0 / uViewport * clip.w;
  gl_Position = clip;
  vUv = position.xy * 2.0;
  vColor = instanceColor;
  vSeed = seed;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

in vec2 vUv;
in vec3 vColor;
in float vSeed;

out vec4 fragColor;

void main() {
  float along = vUv.x;
  float taper = mix(1.0, 0.45, smoothstep(-0.2, 1.0, along));
  float across = vUv.y / taper;
  float body = 1.0 - smoothstep(0.7, 1.0, length(vec2(along, across)));
  float bristles = 0.7 + 0.3 * sin(across * 19.0 + vSeed * 57.0);
  float alpha = clamp(body * bristles * 1.15, 0.0, 1.0);
  fragColor = vec4(vColor * (0.8 + 0.2 * bristles), alpha);
}
`;

export interface StrokeUniforms {
  [name: string]: { value: unknown };
  uViewport: { value: Vector2 };
  uSizePx: { value: number };
}

const viewport = new Vector4();
let eyeViewport: { width: number; height: number } | null = null;

/** The last eye viewport a stroke chunk drew into, in device pixels, or null before any draw. */
export function lastEyeViewport(): { width: number; height: number } | null {
  return eyeViewport;
}

/** a2c: opaque pass with alpha-to-coverage. blend: transparent, no depth write, drawn in order. */
export function createStrokeMaterial(mode: BenchMode, sizePx: number): RawShaderMaterial {
  const uniforms: StrokeUniforms = {
    uViewport: { value: new Vector2(1, 1) },
    uSizePx: { value: sizePx },
  };
  const blend = mode === 'blend';
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: blend,
    depthWrite: !blend,
    alphaToCoverage: !blend,
  });
  material.name = `bench-stroke-${mode}`;
  // The renderer sets the per-eye viewport before each object draws, so this reads it per eye.
  material.onBeforeRender = (renderer: WebGLRenderer) => {
    renderer.getCurrentViewport(viewport);
    uniforms.uViewport.value.set(Math.max(1, viewport.z), Math.max(1, viewport.w));
    // Skip degenerate eyes: IWER's mono mode gives the right eye a zero-width viewport.
    const drawable = viewport.z > 0 && viewport.w > 0;
    if (drawable && (eyeViewport?.width !== viewport.z || eyeViewport.height !== viewport.w)) {
      eyeViewport = { width: viewport.z, height: viewport.w };
    }
  };
  return material;
}
