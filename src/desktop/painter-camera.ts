import type { PerspectiveCamera } from 'three';
import type { PainterCamera } from '../paintings/world-module';

/** Puts the eye exactly at (x, y, z) with a yaw and pitch: the locomotion rig's `setPose`. */
export type PlaceEye = (x: number, y: number, z: number, yaw: number, pitch: number) => void;

/**
 * Puts the desktop camera on the painter camera (`?painter`): the pose through `place`, which
 * holds it against ground follow, and the lens through the projection. The caller keeps the
 * aspect on a resize.
 */
export function applyPainterCamera(
  camera: PerspectiveCamera,
  place: PlaceEye,
  view: PainterCamera,
): void {
  place(view.eye[0], view.eye[1], view.eye[2], view.yaw, view.pitch);
  camera.fov = view.fovYDeg;
  camera.aspect = view.aspect;
  camera.updateProjectionMatrix();
}
