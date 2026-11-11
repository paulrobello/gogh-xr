/**
 * The hand ripple contract: a world whose painting ripples where a hand orb touches it (the
 * gallery's live scan, src/paintings/gallery/ripple.ts). main.ts drives it every frame with the
 * reactive tracker's hand disturbers, so it lives apart from the gallery chunk.
 */
import type { Vector4 } from 'three';
import { reactiveGate } from '../motion/layers';

export interface HandRippleFrame {
  /** An XR session presents: there are no hands on the desktop. */
  readonly presenting: boolean;
  /** The hand orbs setting: orbs off, no ripple. */
  readonly enabled: boolean;
  /** A portal transition runs: no new contact is taken, and every slot eases out where it was. */
  readonly busy: boolean;
  /** `rippleAmplitude`: calm while the reactive gate would be open, else 0. */
  readonly amplitude: number;
  /** The reactive tracker's `uDisturbers`: xyz world, w strength (0 when untracked). */
  readonly disturbers: readonly Vector4[];
  /** Per hand (left, right), its disturber index, or -1 when no slot holds that hand. */
  readonly slots: readonly [number, number];
  /** Seconds since the last frame. */
  readonly dt: number;
}

/** One contact in `__goghDiag().galleryRipple`: canvas uv (v up, 0-1) and the eased strength. */
export interface HandRippleContact {
  uv: [number, number];
  strength: number;
}

export interface HandRippleDiag {
  /** Left, right (the e2e hook's forced contact takes the left slot), null at rest. */
  contacts: [HandRippleContact | null, HandRippleContact | null];
  /**
   * The amplitude the shader applies on top of each strength: calm, or 0 with the gate shut
   * (`?noanim`, calm 0, `?motionlayers` without `reactive`). A portal transition leaves it as is.
   */
  amplitude: number;
}

export interface HandRipple {
  frame(state: HandRippleFrame): void;
  /**
   * e2e only: forces one contact at canvas uv (u, v), v up, at `strength` (0-1), with no ease and
   * no XR or orb gating; null releases it at once. The amplitude still applies, and a portal
   * transition eases it out.
   */
  force(u: number, v: number, strength: number | null): void;
  diag(): HandRippleDiag;
}

/**
 * The ripple's amplitude: the hand orbs' reactive gate (src/render/hand-orbs.ts), judged on the
 * world motion mask rather than the live clock mask, which the gallery keeps at 0. `?noanim`, calm
 * 0 or a mask without the reactive bit (`?motionlayers`) give 0; otherwise calm, clamped to 0-1.
 */
export function rippleAmplitude(noanim: boolean, calm: number, worldMask: number): number {
  if (noanim || !reactiveGate(worldMask) || !(calm > 0)) return 0;
  return Math.min(calm, 1);
}
