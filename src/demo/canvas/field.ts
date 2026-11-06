/**
 * Pure sampling of the P1.1 bake outputs and the painting image, over plain RGBA arrays so the
 * placement is testable without decoding images.
 *
 * UV convention (painting space): u runs left to right, v bottom to top, so v = 1 is image row 0.
 * flow.png and regions.png squash the painting into a square; sampling by uv undoes that.
 */

/** Decoded RGBA8 pixels, row 0 at the top of the image. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

/** regions.png ids (scripts/bake/analyze-scan.ts). */
export const REGION = {
  sky: 0,
  stars: 1,
  moon: 2,
  cypress: 3,
  village: 4,
  hills: 5,
  church: 6,
} as const;

export type RegionName = keyof typeof REGION;
export type RegionId = (typeof REGION)[RegionName];

const REGION_COUNT = 7;

/** Stroke orientation in [0, π) from flow.png's R and G bytes: θ = ½·atan2(2G − 1, 2R − 1). */
export function decodeFlowAngle(r: number, g: number): number {
  const theta = 0.5 * Math.atan2((2 * g) / 255 - 1, (2 * r) / 255 - 1);
  return theta < 0 ? theta + Math.PI : theta;
}

function clampIndex(i: number, size: number): number {
  return i < 0 ? 0 : i >= size ? size - 1 : i;
}

/** Index of the texel containing (u, v), clamped to the image. */
function nearestTexel(width: number, height: number, u: number, v: number): number {
  const x = clampIndex(Math.floor(u * width), width);
  const y = clampIndex(Math.floor((1 - v) * height), height);
  return y * width + x;
}

/** Region id at (u, v), nearest texel so ids never blend. Unknown ids read as sky. */
export function regionAt(regions: Raster, u: number, v: number): RegionId {
  const id = regions.data[nearestTexel(regions.width, regions.height, u, v) * 4];
  return (id < REGION_COUNT ? id : REGION.sky) as RegionId;
}

/** Bilinear RGB at (u, v), clamped at the edges. */
export function sampleColor(image: Raster, u: number, v: number): [number, number, number] {
  const { width, height, data } = image;
  const fx = u * width - 0.5;
  const fy = (1 - v) * height - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = clampIndex(x0, width);
  const xb = clampIndex(x0 + 1, width);
  const ya = clampIndex(y0, height) * width;
  const yb = clampIndex(y0 + 1, height) * width;
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const top = data[(ya + xa) * 4 + k] * (1 - tx) + data[(ya + xb) * 4 + k] * tx;
    const bottom = data[(yb + xa) * 4 + k] * (1 - tx) + data[(yb + xb) * 4 + k] * tx;
    out[k] = top * (1 - ty) + bottom * ty;
  }
  return out;
}

/** The flow field with low-coherence texels filled in from their neighbourhood. */
export interface FlowField {
  readonly width: number;
  readonly height: number;
  /** Stroke orientation per texel in [0, π), painting space. */
  readonly angle: Float32Array;
  /** The bake's coherence per texel in [0, 1]: 0 where flat or noisy. */
  readonly coherence: Float32Array;
}

/** Texels of the coherence-weighted neighbourhood average, each side of the centre. */
export const FLOW_SMOOTH_RADIUS = 12;

/** Separable box blur with an edge-normalised window, in place via `scratch`. */
function boxBlur(
  values: Float32Array,
  width: number,
  height: number,
  radius: number,
  scratch: Float32Array,
): void {
  const pass = (
    from: Float32Array,
    to: Float32Array,
    length: number,
    lines: number,
    step: number,
    stride: number,
  ): void => {
    for (let line = 0; line < lines; line++) {
      const base = line * stride;
      let sum = 0;
      for (let i = 0; i <= Math.min(radius, length - 1); i++) sum += from[base + i * step];
      for (let i = 0; i < length; i++) {
        const lo = i - radius - 1;
        const hi = i + radius;
        if (hi < length && i > 0) sum += from[base + hi * step];
        if (lo >= 0) sum -= from[base + lo * step];
        to[base + i * step] = sum / (Math.min(hi, length - 1) - Math.max(lo, -1));
      }
    }
  };
  pass(values, scratch, width, height, 1, width);
  pass(scratch, values, height, width, width, 1);
}

/**
 * Decodes flow.png and blends each texel's orientation towards its neighbourhood by how little the
 * bake trusts it: F = c·L + (1 − c)·Ŝ, with L the texel's doubled-angle vector (cos 2θ, sin 2θ)
 * and Ŝ the unit coherence-weighted average of L over a (2r + 1)² box. Flat areas, which the bake
 * writes as θ = 0, take their surroundings' flow instead of drawing horizontal. Orientations repeat
 * every π, so they are averaged as doubled angles, never as θ.
 */
export function buildFlowField(flow: Raster, radius: number = FLOW_SMOOTH_RADIUS): FlowField {
  const { width, height, data } = flow;
  const n = width * height;
  const lx = new Float32Array(n);
  const ly = new Float32Array(n);
  const coherence = new Float32Array(n);
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = data[i * 4 + 2] / 255;
    lx[i] = (2 * data[i * 4]) / 255 - 1;
    ly[i] = (2 * data[i * 4 + 1]) / 255 - 1;
    coherence[i] = c;
    sx[i] = c * lx[i];
    sy[i] = c * ly[i];
  }
  const scratch = new Float32Array(n);
  boxBlur(sx, width, height, radius, scratch);
  boxBlur(sy, width, height, radius, scratch);
  const angle = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = coherence[i];
    const s = Math.hypot(sx[i], sy[i]);
    const fx = s > 1e-6 ? c * lx[i] + ((1 - c) * sx[i]) / s : lx[i];
    const fy = s > 1e-6 ? c * ly[i] + ((1 - c) * sy[i]) / s : ly[i];
    const theta = 0.5 * Math.atan2(fy, fx);
    angle[i] = theta < 0 ? theta + Math.PI : theta;
  }
  return { width, height, angle, coherence };
}

/** Orientation and coherence at (u, v), nearest texel. */
export function sampleFlow(
  field: FlowField,
  u: number,
  v: number,
): { angle: number; coherence: number } {
  const i = nearestTexel(field.width, field.height, u, v);
  return { angle: field.angle[i], coherence: field.coherence[i] };
}
