/**
 * The settings panel's pose memory (P5.3): saved relative to the head's position and yaw, on grab
 * release and on XR exit, under its own `localStorage` key. It is a presentation pose, not a world
 * position, so PRD D12 (no stored position) holds: it restores in front of wherever the head is.
 * Validated on load; anything odd falls back to the default spawn.
 */
import { Euler, Quaternion, Vector3 } from 'three';
import { clampPanelScale, type PanelPose } from './panel-core';

export const PANEL_POSE_KEY = 'gogh-xr.panel.v1';
export const PANEL_POSE_VERSION = 1;
/** The default spawn, in the head's yaw frame: ahead and a little below the eye. */
export const DEFAULT_OFFSET: readonly [number, number, number] = Object.freeze([0, -0.16, -0.72]);
/** A restored panel stays within reach: between these distances from the head, metres. */
export const MIN_DISTANCE = 0.25;
export const MAX_DISTANCE = 2.5;
/** How far inside the distance bounds a clamped save lands, metres. */
const BOUND_MARGIN = 1e-9;

/** The head in rig-local space: position and yaw (the YXZ yaw of its quaternion). */
export interface HeadYaw {
  readonly position: Vector3;
  readonly yaw: number;
}

export interface StoredPanelPose {
  readonly version: 1;
  /** The panel centre from the head, in the head's yaw frame, metres. */
  readonly offset: [number, number, number];
  /** The panel's rotation in the head's yaw frame. */
  readonly quaternion: [number, number, number, number];
  readonly scale: number;
}

export type PanelPoseStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const yawQ = new Quaternion();
const yAxis = new Vector3(0, 1, 0);
const euler = new Euler(0, 0, 0, 'YXZ');

/** The head's yaw from a camera quaternion (rig-local), ignoring pitch and roll. */
export function headYawOf(quaternion: Quaternion): number {
  return euler.setFromQuaternion(quaternion, 'YXZ').y;
}

/** The rotation whose +Z, the panel's face, points from `from` toward `to`, kept upright. */
export function facing(from: Vector3, to: Vector3, out = new Quaternion()): Quaternion {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const yaw = Math.atan2(dx, dz);
  const pitch = -Math.atan2(dy, Math.hypot(dx, dz));
  return out.setFromEuler(euler.set(pitch, yaw, 0, 'YXZ'));
}

/** The pose relative to the head's yaw frame. */
export function toStored(pose: PanelPose, head: HeadYaw): StoredPanelPose {
  yawQ.setFromAxisAngle(yAxis, -head.yaw);
  const offset = pose.position.clone().sub(head.position).applyQuaternion(yawQ);
  // A push can carry the panel past the load bounds, so the save keeps it inside them along the
  // same direction rather than writing a pose the next open would reject. It aims just inside each
  // bound, because the rescaled length can round past it and the load check is strict.
  const distance = offset.length();
  if (distance > MAX_DISTANCE) offset.multiplyScalar((MAX_DISTANCE - BOUND_MARGIN) / distance);
  else if (distance < MIN_DISTANCE) {
    if (distance > 1e-6) offset.multiplyScalar((MIN_DISTANCE + BOUND_MARGIN) / distance);
    else offset.set(...DEFAULT_OFFSET);
  }
  const q = yawQ.clone().multiply(pose.quaternion).normalize();
  return {
    version: PANEL_POSE_VERSION,
    offset: [offset.x, offset.y, offset.z],
    quaternion: [q.x, q.y, q.z, q.w],
    scale: clampPanelScale(pose.scale),
  };
}

/** Writes `stored` placed relative to `head` into `pose`. */
export function fromStored(stored: StoredPanelPose, head: HeadYaw, pose: PanelPose): PanelPose {
  yawQ.setFromAxisAngle(yAxis, head.yaw);
  pose.position
    .set(...stored.offset)
    .applyQuaternion(yawQ)
    .add(head.position);
  pose.quaternion
    .set(...stored.quaternion)
    .premultiply(yawQ)
    .normalize();
  pose.scale = clampPanelScale(stored.scale);
  return pose;
}

/** The default spawn in front of `head`, facing the eye, at scale 1. */
export function defaultStored(): StoredPanelPose {
  const from = new Vector3(...DEFAULT_OFFSET);
  const q = facing(from, new Vector3(0, 0, 0));
  return {
    version: PANEL_POSE_VERSION,
    offset: [...DEFAULT_OFFSET],
    quaternion: [q.x, q.y, q.z, q.w],
    scale: 1,
  };
}

function finiteArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** Parses stored text, or null when it is missing, malformed or out of reach. */
export function parsePanelPose(text: string | null): StoredPanelPose | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== PANEL_POSE_VERSION) return null;
  if (!finiteArray(r.offset, 3) || !finiteArray(r.quaternion, 4)) return null;
  if (typeof r.scale !== 'number' || !Number.isFinite(r.scale)) return null;
  const distance = Math.hypot(...r.offset);
  if (distance < MIN_DISTANCE || distance > MAX_DISTANCE) return null;
  const q = new Quaternion(...(r.quaternion as [number, number, number, number]));
  if (q.length() < 1e-6) return null;
  q.normalize();
  return {
    version: PANEL_POSE_VERSION,
    offset: r.offset as [number, number, number],
    quaternion: [q.x, q.y, q.z, q.w],
    scale: clampPanelScale(r.scale),
  };
}

function storage(): PanelPoseStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPanelPose(store: PanelPoseStorage | null = storage()): StoredPanelPose | null {
  try {
    return parsePanelPose(store?.getItem(PANEL_POSE_KEY) ?? null);
  } catch {
    return null;
  }
}

export function savePanelPose(
  pose: StoredPanelPose,
  store: PanelPoseStorage | null = storage(),
): boolean {
  try {
    store?.setItem(PANEL_POSE_KEY, JSON.stringify(pose));
    return store !== null;
  } catch {
    return false;
  }
}

/** Recenter forgets the saved pose (the guide's both-stick recovery), and nothing else. */
export function clearPanelPose(store: PanelPoseStorage | null = storage()): void {
  try {
    store?.removeItem(PANEL_POSE_KEY);
  } catch {
    // storage unavailable: nothing saved to forget
  }
}
