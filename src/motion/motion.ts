/**
 * The motion layer table and a TypeScript mirror of motion.glsl's gate and dispatch (P4.1). A
 * layer's motion returns a `Motion`: an offset of the stroke centre, a turn about the stroke
 * normal, a size gain and a brightness, each zero at rest. `motionOffset` multiplies the offset,
 * turn and brightness, the amplitudes, by calm once. The gain is a loop's wrap envelope, which must
 * shrink the stroke to nothing as it jumps back at every calm, so it runs at full depth whenever the
 * gate is open (amended R-P4e).
 * P4.2 fills in the sky (src/motion/sky-swirl.ts), P4.3 the stars and moon
 * (src/motion/sky-rings.ts) and P4.4 the cypress (src/motion/cypress-flame.ts); P4.5 (reactive,
 * every layer) fills in the rest. Each
 * one also sets its layer's bit in `MOTION_LAYERS`, and its GLSL in motion.glsl and its mirror here
 * change together.
 */
import { PAINTER_EYE } from '../paintings/starry-night/canvas-camera';
import { STROKE_LAYER } from '../render/strokes/instance';
import { CYPRESS_FLAME_NONE, cypressFlame } from './cypress-flame';
import { motionGate } from './layers';
import { ringOf, skyRing } from './sky-rings';
import { SKY_SWIRL_MAX_ANGLE, skySwirl } from './sky-swirl';

export { MOTION_LAYER_MASK, MOTION_LAYERS, motionGate, motionLayerMask } from './layers';

type Vec3 = readonly [number, number, number];

/** A layer's motion of one stroke. Every field is 0 at rest. */
export interface Motion {
  /** Displacement of the stroke centre, model space. */
  readonly offset: Vec3;
  /** Turn about the stroke normal, radians, from the long axis towards the short axis. */
  readonly turn: number;
  /** Size delta: the stroke draws at `1 + gain` times its size. */
  readonly gain: number;
  /** Brightness delta: the stroke draws at `1 + bright` times its colour. */
  readonly bright: number;
}

export const REST: Motion = Object.freeze({
  offset: Object.freeze([0, 0, 0]) as Vec3,
  turn: 0,
  gain: 0,
  bright: 0,
});

export interface MotionInput {
  /** Stroke centre at rest, model space. */
  readonly position: Vec3;
  /** Unit stroke normal. */
  readonly normal: Vec3;
  /** The instance's phase byte as a fraction, `iMeta.z / 256`, in [0, 1). */
  readonly phase: number;
  /** The phase byte itself, `iMeta.z`: a star stroke's names its star (P4.3). */
  readonly phaseByte: number;
  /** The colour alpha byte, `iColor.a × 255`: a cypress stroke's flame data (P4.4). */
  readonly flameByte: number;
  /** `uTime`, seconds. */
  readonly time: number;
}

/** One layer's motion of a stroke, before calm scaling. */
export type LayerMotion = (input: MotionInput) => Motion;

export interface MotionFunctions {
  readonly sky: LayerMotion;
  readonly star: LayerMotion;
  readonly moon: LayerMotion;
  readonly cypress: LayerMotion;
  /** Added for every layer (P4.5). */
  readonly reactive: LayerMotion;
}

const still: LayerMotion = () => REST;

/** Every layer still. */
export const STUB_MOTION: MotionFunctions = Object.freeze({
  sky: still,
  star: still,
  moon: still,
  cypress: still,
  reactive: still,
});

/**
 * The motions motion.glsl runs: the sky swirl (P4.2), the star and moon rings (P4.3) and the
 * cypress flame (P4.4), the reactive term still until its card lands.
 */
export const LIVE_MOTION: MotionFunctions = Object.freeze({
  ...STUB_MOTION,
  sky: ({ position, normal, phase, time }: MotionInput) => ({
    ...skySwirl(position, normal, phase, time),
    bright: 0,
  }),
  star: ({ position, phaseByte, time }: MotionInput) =>
    skyRing(ringOf(false, phaseByte), position, time),
  moon: ({ position, phaseByte, time }: MotionInput) =>
    skyRing(ringOf(true, phaseByte), position, time),
  cypress: ({ position, normal, phase, flameByte, time }: MotionInput) =>
    cypressFlame(position, normal, phase, flameByte, time),
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
 * Matches `motionOffset` in motion.glsl: at rest unless the layer's gate bit is set, otherwise the
 * layer's motion plus the reactive term, with the offset, turn and brightness times calm and the
 * gain unscaled. `flameByte` is the stroke's colour alpha byte, which only the cypress reads.
 * stroke.vert.glsl's gated block also skips a haze stroke its sky-light thin has collapsed
 * (`thin` 0), which draws nothing either way, so this mirror leaves that skip out.
 */
export function motionOffset(
  layer: number,
  phaseByte: number,
  position: Vec3,
  normal: Vec3,
  uniforms: MotionUniformValues,
  fns: MotionFunctions = LIVE_MOTION,
  flameByte: number = CYPRESS_FLAME_NONE,
): Motion {
  if (!motionGate(uniforms.layerMask, layer)) return REST;
  const input: MotionInput = {
    position,
    normal,
    phase: phaseByte / 256,
    phaseByte,
    flameByte,
    time: uniforms.time,
  };
  const a = layerMotion(layer, fns)(input);
  const r = fns.reactive(input);
  const c = uniforms.calm;
  return {
    offset: [
      c * (a.offset[0] + r.offset[0]),
      c * (a.offset[1] + r.offset[1]),
      c * (a.offset[2] + r.offset[2]),
    ],
    turn: c * (a.turn + r.turn),
    gain: a.gain + r.gain,
    bright: c * (a.bright + r.bright),
  };
}

/**
 * Matches motionReach in motion.glsl: how far, metres, the open gate at `calm` can move a sky
 * stroke centred at `position` from rest. The haze's sky-light thin widens its stroke by it
 * (R-P4b). On the dome it is at most SKY_SWIRL_REACH; nearer the eye, as on the P1 canvas, it is a
 * few centimetres. The stroke batch's cull uses each stroke's exact `skySwirlReach` instead, which
 * this bounds. Only the haze, on the sky layer, reads it, so every other layer reads 0 here: the
 * star and moon rings' reach is `skyRingReach` (sky-rings.ts).
 */
export function motionReach(layer: number, position: Vec3, calm: number): number {
  if (layer !== STROKE_LAYER.sky) return 0;
  const [x, y, z] = position;
  const [ex, ey, ez] = PAINTER_EYE;
  return calm * SKY_SWIRL_MAX_ANGLE * Math.hypot(x - ex, y - ey, z - ez);
}
