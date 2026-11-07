/**
 * Walk bounds (P5.4): an indoor world's walls and ceiling for smooth movement and flight. After the
 * frame's step or flight, the rig is moved so the head's world XZ stays inside the box and, in
 * flight, the head below its ceiling. Teleport needs none of this: it already refuses landings
 * where `blocked` is true. A world without walk bounds (Starry Night) is never clamped.
 *
 * Pure like step.ts. Conventions match it: yaw 0 faces -Z, positive yaw turns left, and the head
 * pose is relative to the rig.
 */
import type { HeadPose, LocomotionState } from './step';

/** A side of the box: the wall the clamp lets the head through, within an opening. */
export type WalkSide = 'minX' | 'maxX' | 'minZ' | 'maxZ';

/**
 * A gap in one wall (P5.5 opens the Starry Night frame as a portal): along that side the clamp
 * does not apply while the head's other coordinate lies in [from, to].
 */
export interface WalkOpening {
  readonly side: WalkSide;
  readonly from: number;
  readonly to: number;
}

/** The head's allowed world box: XZ limits and a ceiling for its height, metres. */
export interface WalkBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** The head's highest world y. */
  readonly maxY: number;
  readonly opening?: WalkOpening;
}

function open(bounds: WalkBounds, side: WalkSide, along: number): boolean {
  const gap = bounds.opening;
  return gap !== undefined && gap.side === side && along >= gap.from && along <= gap.to;
}

/**
 * Moves the rig so the head's world position lies inside `bounds`. Returns true when it moved.
 * The head offset turns with the rig yaw, so the correction is a pure translation of the rig.
 */
export function clampToWalkBounds(
  state: LocomotionState,
  head: HeadPose,
  bounds: WalkBounds,
): boolean {
  const position = state.position;
  const sin = Math.sin(state.yaw);
  const cos = Math.cos(state.yaw);
  const hx = position[0] + cos * head.x + sin * head.z;
  const hz = position[2] - sin * head.x + cos * head.z;
  const hy = position[1] + head.y;
  let dx = 0;
  let dz = 0;
  if (hx < bounds.minX && !open(bounds, 'minX', hz)) dx = bounds.minX - hx;
  else if (hx > bounds.maxX && !open(bounds, 'maxX', hz)) dx = bounds.maxX - hx;
  if (hz < bounds.minZ && !open(bounds, 'minZ', hx)) dz = bounds.minZ - hz;
  else if (hz > bounds.maxZ && !open(bounds, 'maxZ', hx)) dz = bounds.maxZ - hz;
  const dy = hy > bounds.maxY ? bounds.maxY - hy : 0;
  position[0] += dx;
  position[1] += dy;
  position[2] += dz;
  return dx !== 0 || dy !== 0 || dz !== 0;
}
