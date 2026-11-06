import type { PerspectiveCamera } from 'three';
import type { PainterCamera } from '../paintings/world-module';
import type { DesktopControls } from './controls';

/**
 * Puts the desktop camera on the painter camera (`?painter`): the pose goes through the controls,
 * which rewrite the camera every frame, and the lens through the projection. The caller keeps the
 * aspect on a resize.
 */
export function applyPainterCamera(
  camera: PerspectiveCamera,
  controls: DesktopControls,
  view: PainterCamera,
): void {
  controls.setPose(view.eye[0], view.eye[1], view.eye[2], view.yaw, view.pitch);
  controls.update(0);
  camera.fov = view.fovYDeg;
  camera.aspect = view.aspect;
  camera.updateProjectionMatrix();
}
