/**
 * The comfort tunnel vignette (P3.3): a head-locked, inside-out black sphere around the camera
 * whose fragment shader darkens each eye's view by its angle off that eye's forward axis. It is a
 * mesh, not post-processing, so fixed foveation stays intact. `vignette-alpha.ts` computes the
 * alpha; locomotion drives it in XR only.
 *
 * Parented to the camera: three moves the camera to its XR camera each frame and updates its
 * children (parked note M8: head-locked objects go under the camera, not the scene).
 */
import { BackSide, GLSL3, Mesh, type Object3D, RawShaderMaterial, SphereGeometry } from 'three';
import fragmentShader from './vignette.frag.glsl?raw';
import vertexShader from './vignette.vert.glsl?raw';

/**
 * Sphere radius, metres. The near plane clips on view-space depth, which falls to about half the
 * radius at a Quest 3 frustum corner, and the camera is three's union camera a few cm behind the
 * eyes, so the sphere is far larger than the 0.1 m near plane.
 */
export const VIGNETTE_RADIUS = 1;
/** Half-angle of the clear centre, degrees off the eye's forward axis. */
export const CLEAR_RADIUS_DEG = 30;
/** The ramp from clear to full alpha, degrees. Full alpha from 50° off-axis. */
export const FALLOFF_DEG = 20;
/**
 * Transparent, so three draws it after every opaque object. Within the transparent list it sorts
 * after anything of lower order and below the perf HUD's 1,000,000, so UI stays readable.
 */
export const VIGNETTE_RENDER_ORDER = 999_000;

const DEG = Math.PI / 180;

export interface VignetteUniforms {
  [name: string]: { value: unknown };
  uAlpha: { value: number };
}

export type VignetteMaterial = RawShaderMaterial & { uniforms: VignetteUniforms };

export interface Vignette {
  readonly mesh: Mesh<SphereGeometry, VignetteMaterial>;
  /** 0 hides the mesh, so a vignette at rest costs no draw call. */
  setAlpha(alpha: number): void;
  dispose(): void;
}

/** A GLSL float literal: always carries a decimal point or an exponent. */
const glslFloat = (value: number): string => value.toExponential(8);

export function createVignette(camera: Object3D): Vignette {
  const geometry = new SphereGeometry(VIGNETTE_RADIUS, 32, 16);
  const uniforms: VignetteUniforms = { uAlpha: { value: 0 } };
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader,
    fragmentShader,
    uniforms,
    defines: {
      CLEAR_RADIUS: glslFloat(CLEAR_RADIUS_DEG * DEG),
      FALLOFF: glslFloat(FALLOFF_DEG * DEG),
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: BackSide,
  }) as VignetteMaterial;
  material.name = 'vignette';
  const mesh = new Mesh(geometry, material);
  mesh.name = 'vignette';
  mesh.renderOrder = VIGNETTE_RENDER_ORDER;
  mesh.frustumCulled = false;
  mesh.visible = false;
  camera.add(mesh);

  return {
    mesh,
    setAlpha(alpha) {
      uniforms.uAlpha.value = alpha;
      mesh.visible = alpha > 0;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
