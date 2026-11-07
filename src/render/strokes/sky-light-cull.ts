/**
 * View-dependent thinning of the boundary haze in front of the moon and stars. The haze shell
 * (45-55 m) hides most of the sky below about 40° elevation, and the moon and star strokes draw
 * behind it on the dome (backdrop-depth.ts front tier). A stroke carrying SKY_LIGHT_CULL_FLAG is
 * judged in the vertex shader against each light's cone, seen from the eye of the view being drawn.
 *
 * - Inside the cone, the disc's angular radius plus the angle of the stroke's own drawn half
 *   diagonal, the stroke collapses to zero area. Every corner of a quad lies within its half
 *   diagonal of the centre, so no haze quad can reach over the disc.
 * - Outside it, the stroke's drawn size scales by the square root of a smoothstep of the angular
 *   gap to that edge, so its area ramps from 0 at the edge to full over the feather, and the
 *   haze's coverage approximately with it. The feather is the cone's `feather` metres past its
 *   radius, as an angle from this eye, plus the stroke's half-diagonal angle. Neighbouring cones
 *   multiply their factors.
 * - A cone whose feather the stroke lies past, by the cosine of outer + 2 beta +
 *   SKY_LIGHT_MIN_FEATHER, is skipped with no inverse trigonometry, so most haze vertices pay a few
 *   multiplies per cone. The skip only takes cones whose factor is exactly 1.
 *
 * A shrunk quad never reaches further than the full one, so the thinning keeps the disc guarantee.
 * The haze rim at 50 m is therefore no hard edge 70 m in front of the moon, which stereo would read
 * as a hole. The eye is three's cameraPosition uniform, set per camera next to viewMatrix, so each
 * XR eye thins for itself, and it adds no draw call. `skyLightThin` is the CPU mirror of the
 * shader's factor and `skyLightCulled` of its zero test.
 */
import { Vector4 } from 'three';
import type { Vec3 } from './frame';

/** iMeta.w bit: a boundary haze stroke the sky-light cones may thin. */
export const SKY_LIGHT_CULL_FLAG: number = 128;
/** Cone slots in the stroke material: the moon and the 11 stars. */
export const SKY_LIGHT_CONES: number = 12;
/** Narrowest feather in radians, so the smoothstep's edges never meet. */
export const SKY_LIGHT_MIN_FEATHER: number = 1e-4;
const MIN_FEATHER_COS = Math.cos(SKY_LIGHT_MIN_FEATHER);
const MIN_FEATHER_SIN = Math.sin(SKY_LIGHT_MIN_FEATHER);

/** A moon or star disc on the dome: its world centre, radius and feather, metres. */
export interface SkyLightCone {
  readonly centre: Vec3;
  readonly radius: number;
  /** Haze thins over this many metres past `radius` on the dome, plus a stroke half diagonal. */
  readonly feather: number;
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

/** The `uSkyLightFeathers` uniform value: each cone's feather in metres, unused slots 0. */
export function skyLightFeatherUniforms(cones: readonly SkyLightCone[]): number[] {
  if (cones.length > SKY_LIGHT_CONES) {
    throw new Error(`${cones.length} sky-light cones, at most ${SKY_LIGHT_CONES} fit`);
  }
  return Array.from({ length: SKY_LIGHT_CONES }, (_, i) => cones[i]?.feather ?? 0);
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The coverage factor, 0 to 1, of a flagged stroke centred at `position`, reaching `halfExtent`
 * metres from its centre (the shader passes the drawn quad's half diagonal), for an eye at `eye`.
 * It is 0 when the angle between the eye's rays to the stroke and to a cone's centre is under
 * asin(radius / distance to the centre) plus asin(halfExtent / distance to the stroke), the widest
 * angle any point of the quad can sit off its centre's ray. Past that edge it is the product over
 * the cones of a smoothstep of the angular gap over the feather. The shader scales the drawn size
 * by its square root. Mirrors `skyLightThin` in stroke.vert.glsl, cosine form and early-out
 * included. `earlyOut` false skips the early-out, so a test can show it never changes the factor.
 */
export function skyLightThin(
  eye: Vec3,
  position: Vec3,
  halfExtent: number,
  cones: readonly SkyLightCone[],
  earlyOut: boolean = true,
): number {
  const h: Vec3 = [position[0] - eye[0], position[1] - eye[1], position[2] - eye[2]];
  const lenH = Math.hypot(...h);
  const sinB = Math.min(1, halfExtent / lenH);
  const cosB = Math.sqrt(1 - sinB * sinB);
  // The angle k = 2 beta + SKY_LIGHT_MIN_FEATHER. A cone's factor is exactly 1 from outer + k on,
  // the feather's far end or past it, which stays under pi while beta <= pi / 6.
  const cos2B = 1 - 2 * sinB * sinB;
  const sin2B = 2 * sinB * cosB;
  const cosK = cos2B * MIN_FEATHER_COS - sin2B * MIN_FEATHER_SIN;
  const sinK = sin2B * MIN_FEATHER_COS + cos2B * MIN_FEATHER_SIN;
  const early = earlyOut && sinB <= 0.5;
  let thin = 1;
  for (const cone of cones) {
    if (!(cone.radius > 0)) continue;
    const a: Vec3 = [cone.centre[0] - eye[0], cone.centre[1] - eye[1], cone.centre[2] - eye[2]];
    const lenA = Math.max(Math.hypot(...a), 1e-3);
    const d = a[0] * h[0] + a[1] * h[1] + a[2] * h[2];
    const sinO = Math.min(1, (cone.radius + cone.feather) / lenA);
    const cosO = Math.sqrt(1 - sinO * sinO);
    if (early && sinO < 1 && d <= (cosO * cosK - sinO * sinK) * lenA * lenH) continue;
    const sinA = Math.min(1, cone.radius / lenA);
    const cosA = Math.sqrt(1 - sinA * sinA);
    if (d > (cosA * cosB - sinA * sinB) * lenA * lenH) return 0;
    const beta = Math.asin(sinB);
    const alpha = Math.asin(sinA);
    const feather = Math.max(SKY_LIGHT_MIN_FEATHER, Math.asin(sinO) - alpha + beta);
    const gap = Math.acos(Math.min(1, Math.max(-1, d / (lenA * lenH)))) - alpha - beta;
    thin *= smoothstep(0, feather, gap);
  }
  return thin;
}

/** True when `skyLightThin` collapses the stroke: no part of it may draw. */
export function skyLightCulled(
  eye: Vec3,
  position: Vec3,
  halfExtent: number,
  cones: readonly SkyLightCone[],
): boolean {
  return skyLightThin(eye, position, halfExtent, cones) === 0;
}
