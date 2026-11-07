/**
 * The motion layer table and gate (P4.1), apart from the motions themselves so the clock and the
 * e2e specs can read it without the sky swirl's regions.json import. motion.ts re-exports it.
 */
import { STROKE_LAYER, type StrokeLayer } from '../render/strokes/instance';

/**
 * The layers whose motion is live: the sky (P4.2), the stars and the moon (P4.3). A stroke on a
 * closed layer pays one AND, compare and branch per vertex, and no motion maths. The app's clock
 * opens these only for a world (main.ts), so the P1 canvas demo, the stroke test scene and the
 * bench stay static.
 */
export const MOTION_LAYERS: readonly StrokeLayer[] = Object.freeze([
  STROKE_LAYER.sky,
  STROKE_LAYER.star,
  STROKE_LAYER.moon,
]);

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
