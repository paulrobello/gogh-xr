/**
 * Per-instance stroke data, stored as one typed array per attribute (structure of arrays) so each
 * uploads as its own tightly packed instanced vertex buffer. Separate buffers keep every attribute
 * aligned to its component size, which WebGL requires of strides and offsets.
 *
 * | attribute  | type            | bytes | meaning                                         |
 * |------------|-----------------|-------|-------------------------------------------------|
 * | `iPosition`| float32 × 3     | 12    | stroke centre in world metres                   |
 * | `iNormal`  | snorm16 × 2     | 4     | surface normal, octahedral encoded              |
 * | `iTangent` | unorm16 × 1     | 2     | long-axis angle about the normal, 0..2π (R6)    |
 * | `iColor`   | unorm8 × 4      | 4     | display-referred RGB; A never draws (see below) |
 * | `iSize`    | float32 × 2     | 8     | quad length (long axis) and width in metres     |
 * | `iMeta`    | uint8 × 4 (int) | 4     | brush, layer, phase, flags; read as `uvec4`     |
 *
 * iColor's A byte never reaches the colour: a cypress stroke's carries its flame lobe and height
 * (src/motion/cypress-flame.ts, P4.4), read only behind the motion gate, and every other stroke's is
 * 255.
 *
 * 34 bytes per instance. Size stays float32: a half-float `Uint16Array` uploads as UNSIGNED_SHORT
 * in three r186 unless it is a `Float16BufferAttribute`, which has no instanced variant.
 */
import { BRUSH_COUNT } from './brush-atlas-data';
import type { Vec3 } from './frame';

export const STROKE_LAYER = {
  sky: 0,
  star: 1,
  moon: 2,
  cypress: 3,
  ground: 4,
  building: 5,
} as const;

export type StrokeLayerName = keyof typeof STROKE_LAYER;
export type StrokeLayer = (typeof STROKE_LAYER)[StrokeLayerName];

export interface StrokeInstance {
  readonly position: Vec3;
  /** Surface normal, normalised on pack; the quad lies in the plane perpendicular to it. */
  readonly normal: Vec3;
  /**
   * Radians about the normal, measured from the surface basis b1 towards b2. Duff's basis turns
   * by π across n.z = 0, so compute the angle against the basis of the decoded (quantised) normal,
   * e.g. `surfaceBasis(unpackInstance(...).normal)`, not the source normal: near n.z = 0 the two
   * can fall on opposite sides and flip the stroke end for end.
   */
  readonly tangent: number;
  /**
   * RGBA bytes 0..255. A never draws, because alpha below 1 inside a stroke dithers under
   * alpha-to-coverage (ruling R3): the cypress flame reads it as its lobe and height byte (P4.4).
   */
  readonly color: readonly [number, number, number, number];
  /** Length along the stroke and width across it, in metres. */
  readonly size: readonly [number, number];
  /** Brush atlas index, 0..BRUSH_COUNT - 1. */
  readonly brush: number;
  readonly layer: StrokeLayer;
  /** Animation phase byte 0..255. */
  readonly phase: number;
  /**
   * Flag bits 0..255; 0 when omitted. `DEPTH_TIE_BREAK_FRONT_FLAG` marks lit windows, and
   * `DEPTH_RANKED_FLAG` a tie-break share taken from the quad size, the share of its lift.
   */
  readonly flags?: number;
}

export interface StrokeBuffers {
  readonly count: number;
  readonly position: Float32Array;
  readonly normal: Int16Array;
  readonly tangent: Uint16Array;
  readonly color: Uint8Array;
  readonly size: Float32Array;
  readonly meta: Uint8Array;
}

export type StrokeArrayKey = Exclude<keyof StrokeBuffers, 'count'>;

export interface StrokeAttributeSpec {
  /** GLSL attribute name. */
  readonly name: string;
  readonly key: StrokeArrayKey;
  readonly itemSize: number;
  /** Normalised fixed point (snorm/unorm) rather than raw values. */
  readonly normalized: boolean;
  /** Read through `vertexAttribIPointer` as an integer vector. */
  readonly integer: boolean;
}

export const STROKE_ATTRIBUTES: readonly StrokeAttributeSpec[] = Object.freeze([
  { name: 'iPosition', key: 'position', itemSize: 3, normalized: false, integer: false },
  { name: 'iNormal', key: 'normal', itemSize: 2, normalized: true, integer: false },
  { name: 'iTangent', key: 'tangent', itemSize: 1, normalized: true, integer: false },
  { name: 'iColor', key: 'color', itemSize: 4, normalized: true, integer: false },
  { name: 'iSize', key: 'size', itemSize: 2, normalized: false, integer: false },
  { name: 'iMeta', key: 'meta', itemSize: 4, normalized: false, integer: true },
]);

const ARRAY_TYPES = {
  position: Float32Array,
  normal: Int16Array,
  tangent: Uint16Array,
  color: Uint8Array,
  size: Float32Array,
  meta: Uint8Array,
} as const;

export const BYTES_PER_INSTANCE: number = STROKE_ATTRIBUTES.reduce(
  (sum, spec) => sum + spec.itemSize * ARRAY_TYPES[spec.key].BYTES_PER_ELEMENT,
  0,
);

const TAU = Math.PI * 2;
const SNORM16 = 32767;
const UNORM16 = 65535;

export function createStrokeBuffers(count: number): StrokeBuffers {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`bad stroke count ${count}`);
  return {
    count,
    position: new Float32Array(count * 3),
    normal: new Int16Array(count * 2),
    tangent: new Uint16Array(count),
    color: new Uint8Array(count * 4),
    size: new Float32Array(count * 2),
    meta: new Uint8Array(count * 4),
  };
}

function signNotZero(v: number): number {
  return v >= 0 ? 1 : -1;
}

/**
 * Octahedral encoding of a direction into [-1, 1]². Accepts any non-zero finite vector and encodes
 * its direction; throws RangeError otherwise. Matches `octDecode` in stroke.vert.glsl.
 */
export function octEncode(x: number, y: number, z: number): [number, number] {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
  // Dividing by the L1 norm also normalises a non-unit vector; zero or non-finite input would NaN.
  if (!(l1 > 0) || !Number.isFinite(l1)) {
    throw new RangeError(`normal (${x}, ${y}, ${z}) is zero-length or not finite`);
  }
  const u = x / l1;
  const v = y / l1;
  if (z >= 0) return [u, v];
  return [(1 - Math.abs(v)) * signNotZero(u), (1 - Math.abs(u)) * signNotZero(v)];
}

export function octDecode(u: number, v: number): [number, number, number] {
  let x = u;
  let y = v;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    x = (1 - Math.abs(v)) * signNotZero(u);
    y = (1 - Math.abs(u)) * signNotZero(v);
  }
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
}

function checkIndex(buffers: StrokeBuffers, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= buffers.count) {
    throw new RangeError(`stroke index ${index} is outside 0..${buffers.count - 1}`);
  }
}

function checkByte(label: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${label} ${value} is outside 0..${max}`);
  }
}

function toByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

export function packInstance(buffers: StrokeBuffers, index: number, s: StrokeInstance): void {
  checkIndex(buffers, index);
  checkByte('brush', s.brush, BRUSH_COUNT - 1);
  checkByte('phase', s.phase, 255);
  checkByte('layer', s.layer, 255);
  checkByte('flags', s.flags ?? 0, 255);
  const i3 = index * 3;
  const i2 = index * 2;
  const i4 = index * 4;
  buffers.position[i3] = s.position[0];
  buffers.position[i3 + 1] = s.position[1];
  buffers.position[i3 + 2] = s.position[2];
  const [u, v] = octEncode(s.normal[0], s.normal[1], s.normal[2]);
  buffers.normal[i2] = Math.round(u * SNORM16);
  buffers.normal[i2 + 1] = Math.round(v * SNORM16);
  const turn = (((s.tangent % TAU) + TAU) % TAU) / TAU;
  buffers.tangent[index] = Math.round(turn * UNORM16);
  for (let k = 0; k < 4; k++) buffers.color[i4 + k] = toByte(s.color[k]);
  buffers.size[i2] = s.size[0];
  buffers.size[i2 + 1] = s.size[1];
  buffers.meta[i4] = s.brush;
  buffers.meta[i4 + 1] = s.layer;
  buffers.meta[i4 + 2] = s.phase;
  buffers.meta[i4 + 3] = s.flags ?? 0;
}

/** Decodes an instance the way the GPU reads it, quantisation included. */
export function unpackInstance(buffers: StrokeBuffers, index: number): StrokeInstance {
  checkIndex(buffers, index);
  const i3 = index * 3;
  const i2 = index * 2;
  const i4 = index * 4;
  const u = Math.max(-1, buffers.normal[i2] / SNORM16);
  const v = Math.max(-1, buffers.normal[i2 + 1] / SNORM16);
  const c = buffers.color;
  return {
    position: [buffers.position[i3], buffers.position[i3 + 1], buffers.position[i3 + 2]],
    normal: octDecode(u, v),
    tangent: ((buffers.tangent[index] % UNORM16) / UNORM16) * TAU,
    color: [c[i4], c[i4 + 1], c[i4 + 2], c[i4 + 3]],
    size: [buffers.size[i2], buffers.size[i2 + 1]],
    brush: buffers.meta[i4],
    layer: buffers.meta[i4 + 1] as StrokeLayer,
    phase: buffers.meta[i4 + 2],
    flags: buffers.meta[i4 + 3],
  };
}

/** Copies the instances at `indices`, in that order, into new buffers. */
export function selectStrokes(source: StrokeBuffers, indices: ArrayLike<number>): StrokeBuffers {
  const out = createStrokeBuffers(indices.length);
  for (const spec of STROKE_ATTRIBUTES) {
    const from = source[spec.key];
    const to = out[spec.key];
    const n = spec.itemSize;
    for (let i = 0; i < indices.length; i++) {
      const src = indices[i] * n;
      for (let k = 0; k < n; k++) to[i * n + k] = from[src + k];
    }
  }
  return out;
}

/** New buffers holding `buffers` as packed, followed by `extra` packed in order. */
export function appendStrokes(
  buffers: StrokeBuffers,
  extra: readonly StrokeInstance[],
): StrokeBuffers {
  const out = createStrokeBuffers(buffers.count + extra.length);
  for (const spec of STROKE_ATTRIBUTES) out[spec.key].set(buffers[spec.key]);
  for (let i = 0; i < extra.length; i++) packInstance(out, buffers.count + i, extra[i]);
  return out;
}
