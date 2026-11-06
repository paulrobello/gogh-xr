/**
 * Surface frame of a stroke (ruling R6). The quad lies in the plane perpendicular to the instance
 * normal, not facing the camera. `stroke.vert.glsl` implements the same maths; keep them in step.
 */

export type Vec3 = readonly [number, number, number];

export interface SurfaceBasis {
  readonly b1: Vec3;
  readonly b2: Vec3;
}

export interface StrokeAxes {
  /** Along the stroke: the atlas +u direction. */
  readonly long: Vec3;
  /** Across the stroke, `n × long`, so `long × short = n` and the quad faces the normal. */
  readonly short: Vec3;
}

/**
 * Branchless orthonormal basis from Duff et al. 2017, "Building an Orthonormal Basis, Revisited".
 * `n` must be unit length. For n = +z it gives b1 = +x and b2 = +y, and b1 × b2 = n for any n.
 * The sign is taken with `>= 0` rather than `Math.sign`, which returns 0 at n.z = 0.
 */
export function surfaceBasis(n: Vec3): SurfaceBasis {
  const [x, y, z] = n;
  const sign = z >= 0 ? 1 : -1;
  const a = -1 / (sign + z);
  const b = x * y * a;
  return {
    b1: [1 + sign * x * x * a, sign * b, -sign * x],
    b2: [b, sign + y * y * a, -y],
  };
}

/** The stroke's long axis is cos θ·b1 + sin θ·b2, with θ the instance tangent in radians. */
export function strokeAxes(n: Vec3, tangent: number): StrokeAxes {
  const { b1, b2 } = surfaceBasis(n);
  const c = Math.cos(tangent);
  const s = Math.sin(tangent);
  const long: Vec3 = [c * b1[0] + s * b2[0], c * b1[1] + s * b2[1], c * b1[2] + s * b2[2]];
  const short: Vec3 = [
    n[1] * long[2] - n[2] * long[1],
    n[2] * long[0] - n[0] * long[2],
    n[0] * long[1] - n[1] * long[0],
  ];
  return { long, short };
}
