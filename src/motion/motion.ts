/**
 * The motion layer table and a TypeScript mirror of motion.glsl's gate and dispatch (P4.1). The
 * per-layer motions are stubs returning zero until P4.2 (sky), P4.3 (stars and moon), P4.4
 * (cypress) and P4.5 (reactive, every layer) fill them in; each one then also sets its layer's bit
 * in `MOTION_LAYERS`, and its GLSL in motion.glsl and its mirror here change together.
 */
import { STROKE_LAYER, type StrokeLayer } from '../render/strokes/instance';

type Vec3 = readonly [number, number, number];

/**
 * The layers whose motion is live. Empty in P4.1, so the shader's motion gate never opens and the
 * default path pays one AND, compare and branch per vertex.
 */
export const MOTION_LAYERS: readonly StrokeLayer[] = Object.freeze([]);

/** Bit `layer` set for each layer in `layers`. Layers are 0-5, inside one uint. */
export function motionLayerMask(layers: readonly StrokeLayer[]): number {
  let mask = 0;
  for (const layer of layers) mask |= 1 << layer;
  return mask >>> 0;
}

export const MOTION_LAYER_MASK: number = motionLayerMask(MOTION_LAYERS);

/** Matches motionGate in motion.glsl. */
export function motionGate(layerMask: number, layer: number): boolean {
  return ((layerMask >>> 0) & (1 << layer)) !== 0;
}

export interface MotionInput {
  /** Stroke centre at rest, model space. */
  readonly position: Vec3;
  /** The instance's phase byte as a fraction, `iMeta.z / 256`, in [0, 1). */
  readonly phase: number;
  /** `uTime`, seconds. */
  readonly time: number;
}

/** One layer's displacement of the stroke centre, before calm scaling. */
export type LayerMotion = (input: MotionInput) => Vec3;

export interface MotionFunctions {
  readonly sky: LayerMotion;
  readonly star: LayerMotion;
  readonly moon: LayerMotion;
  readonly cypress: LayerMotion;
  /** Added for every layer (P4.5). */
  readonly reactive: LayerMotion;
}

const still: LayerMotion = () => [0, 0, 0];

/** The P4.1 stubs, matching motion.glsl. */
export const STUB_MOTION: MotionFunctions = Object.freeze({
  sky: still,
  star: still,
  moon: still,
  cypress: still,
  reactive: still,
});

function layerMotion(layer: number, fns: MotionFunctions): LayerMotion {
  switch (layer) {
    case STROKE_LAYER.sky:
      return fns.sky;
    case STROKE_LAYER.star:
      return fns.star;
    case STROKE_LAYER.moon:
      return fns.moon;
    case STROKE_LAYER.cypress:
      return fns.cypress;
    default:
      return still;
  }
}

export interface MotionUniformValues {
  readonly time: number;
  readonly calm: number;
  readonly layerMask: number;
}

/**
 * Matches the gated block in stroke.vert.glsl and `motionOffset` in motion.glsl: zero unless the
 * layer's gate bit is set, otherwise the layer's motion plus the reactive term, times calm.
 */
export function motionOffset(
  layer: number,
  phaseByte: number,
  position: Vec3,
  uniforms: MotionUniformValues,
  fns: MotionFunctions = STUB_MOTION,
): [number, number, number] {
  if (!motionGate(uniforms.layerMask, layer)) return [0, 0, 0];
  const input: MotionInput = { position, phase: phaseByte / 256, time: uniforms.time };
  const a = layerMotion(layer, fns)(input);
  const r = fns.reactive(input);
  const c = uniforms.calm;
  return [c * (a[0] + r[0]), c * (a[1] + r[1]), c * (a[2] + r[2])];
}
