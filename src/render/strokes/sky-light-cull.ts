/**
 * View-dependent cull of the boundary haze in front of the moon and stars. The haze shell (45-55 m)
 * hides most of the sky below about 40° elevation, and the moon and star strokes draw behind it on
 * the dome (backdrop-depth.ts front tier). A stroke carrying SKY_LIGHT_CULL_FLAG collapses to zero
 * area in the vertex shader when its centre, seen from the eye of the view being drawn, falls
 * inside a light's cone: the disc's angular radius plus the angle of the stroke's own drawn half
 * diagonal. Every corner of a quad lies within its half diagonal of the centre, so a haze quad the
 * cull keeps cannot reach over the disc. The eye is three's cameraPosition uniform, set per camera
 * next to viewMatrix, so each XR eye culls for itself, and the cull adds no draw call.
 * `skyLightCulled` is the CPU mirror of the shader's test.
 */
import { Vector4 } from 'three';
import type { Vec3 } from './frame';

/** iMeta.w bit: a boundary haze stroke the sky-light cones may cull. */
export const SKY_LIGHT_CULL_FLAG: number = 128;
/** Cone slots in the stroke material: the moon and the 11 stars. */
export const SKY_LIGHT_CONES: number = 12;

/** A moon or star disc on the dome: its world centre and radius, metres. */
export interface SkyLightCone {
  readonly centre: Vec3;
  readonly radius: number;
}

/** The `uSkyLightCones` uniform value: xyz centre and w radius, unused slots w = 0. */
export function skyLightConeUniforms(cones: readonly SkyLightCone[]): Vector4[] {
  if (cones.length > SKY_LIGHT_CONES) {
    throw new Error(`${cones.length} sky-light cones, at most ${SKY_LIGHT_CONES} fit`);
  }
  return Array.from({ length: SKY_LIGHT_CONES }, (_, i) => {
    const cone = cones[i];
    return cone ? new Vector4(...cone.centre, cone.radius) : new Vector4(0, 0, 0, 0);
  });
}

/**
 * True when a flagged stroke centred at `position`, reaching `halfExtent` metres from its centre
 * (the shader passes the drawn quad's half diagonal), is culled for an eye at `eye`: the angle
 * between the eye's rays to the stroke and to a cone's centre is under asin(radius / distance to
 * the centre) plus asin(halfExtent / distance to the stroke), the widest angle any point of the
 * quad can sit off its centre's ray. Mirrors `skyLightCulled` in
 * stroke.vert.glsl, cosine form included.
 */
export function skyLightCulled(
  eye: Vec3,
  position: Vec3,
  halfExtent: number,
  cones: readonly SkyLightCone[],
): boolean {
  const h: Vec3 = [position[0] - eye[0], position[1] - eye[1], position[2] - eye[2]];
  const lenH = Math.hypot(...h);
  const sinB = Math.min(1, halfExtent / lenH);
  const cosB = Math.sqrt(1 - sinB * sinB);
  for (const cone of cones) {
    if (!(cone.radius > 0)) continue;
    const a: Vec3 = [cone.centre[0] - eye[0], cone.centre[1] - eye[1], cone.centre[2] - eye[2]];
    const lenA = Math.hypot(...a);
    const sinA = Math.min(1, cone.radius / lenA);
    const cosA = Math.sqrt(1 - sinA * sinA);
    const d = a[0] * h[0] + a[1] * h[1] + a[2] * h[2];
    if (d > (cosA * cosB - sinA * sinB) * lenA * lenH) return true;
  }
  return false;
}
