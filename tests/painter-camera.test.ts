import { PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { expect, test } from 'vitest';
import { installDesktopControls } from '../src/desktop/controls.ts';
import { applyPainterCamera } from '../src/desktop/painter-camera.ts';
import { createLocomotion } from '../src/locomotion/locomotion.ts';
import { DEFAULT_LOCOMOTION_SETTINGS } from '../src/locomotion/settings.ts';
import {
  CANVAS_ASPECT,
  CANVAS_FOV_Y_DEG,
  CANVAS_PITCH,
  PAINTER_EYE,
  projectToCanvas,
} from '../src/paintings/starry-night/canvas-camera.ts';
import { painterCamera as starryNightCamera } from '../src/paintings/starry-night/index.ts';
import type { Vec3 } from '../src/render/strokes/frame.ts';

function painterCamera(): PerspectiveCamera {
  const scene = new Scene();
  const camera = new PerspectiveCamera(70, 16 / 9, 0.05, 1000);
  const look = installDesktopControls(document.createElement('canvas'), camera);
  const locomotion = createLocomotion({
    scene,
    camera,
    look,
    settings: DEFAULT_LOCOMOTION_SETTINGS,
  });
  // A ground the painter eye does not stand on: ground follow must not move the placed pose.
  locomotion.setGround({ heightAt: () => -0.7 });
  applyPainterCamera(camera, locomotion.setPose, starryNightCamera());
  // The next frames must keep the pose.
  for (let i = 0; i < 10; i += 1) {
    look.update();
    locomotion.frame(
      {
        dt: 0.016,
        move: { x: 0, y: 0 },
        sprint: false,
        turn: { x: 0, snap: 0 },
        teleportAim: false,
        teleportCommit: false,
        flightToggle: false,
        vertical: 0,
      },
      false,
    );
  }
  scene.updateMatrixWorld();
  return camera;
}

test('the Starry Night world exposes the canvas-camera vantage', () => {
  expect(starryNightCamera()).toEqual({
    eye: [...PAINTER_EYE],
    yaw: 0,
    pitch: CANVAS_PITCH,
    fovYDeg: CANVAS_FOV_Y_DEG,
    aspect: CANVAS_ASPECT,
  });
});

test('the painter camera frames exactly canvas uv [0, 1]²: projectToCanvas corners land on NDC corners', () => {
  const camera = painterCamera();
  expect(camera.fov).toBe(CANVAS_FOV_Y_DEG);
  expect(camera.aspect).toBe(CANVAS_ASPECT);
  expect(camera.getWorldPosition(new Vector3()).toArray()).toEqual([...PAINTER_EYE]);

  // World points on the frame corners, the centre and one inner point, built by hand from the
  // exported constants. projectToCanvas gives their canvas uv; three's camera must agree.
  const tanY = Math.tan((CANVAS_FOV_Y_DEG * Math.PI) / 360);
  const tanX = CANVAS_ASPECT * tanY;
  const c = Math.cos(CANVAS_PITCH);
  const s = Math.sin(CANVAS_PITCH);
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
    [0, 0],
    [0.5, -0.25],
  ]) {
    for (const d of [3, 80]) {
      // Camera-space ray (sx·tanX, sy·tanY, −1), pitched up about +X, scaled to distance d.
      const x = sx * tanX;
      const y = sy * tanY;
      const len = Math.hypot(x, y, 1);
      const point: Vec3 = [
        PAINTER_EYE[0] + (x / len) * d,
        PAINTER_EYE[1] + ((y * c + s) / len) * d,
        PAINTER_EYE[2] + ((y * s - c) / len) * d,
      ];
      const canvas = projectToCanvas(point);
      expect(canvas.uv).not.toBeNull();
      const [u, v] = canvas.uv ?? [Number.NaN, Number.NaN];
      const ndc = new Vector3(...point).project(camera);
      expect(ndc.x).toBeCloseTo(2 * u - 1, 9);
      expect(ndc.y).toBeCloseTo(2 * v - 1, 9);
      expect(Math.abs(ndc.z)).toBeLessThan(1);
    }
  }
});

test('the painter camera looks along −Z pitched up, with no yaw or roll', () => {
  const camera = painterCamera();
  const forward = new Vector3(0, 0, -1).applyQuaternion(
    camera.getWorldQuaternion(new Quaternion()),
  );
  expect(forward.x).toBeCloseTo(0, 12);
  expect(forward.y).toBeCloseTo(Math.sin(CANVAS_PITCH), 12);
  expect(forward.z).toBeCloseTo(-Math.cos(CANVAS_PITCH), 12);
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.getWorldQuaternion(new Quaternion()));
  expect(right.toArray().map((n) => Number(n.toFixed(12)))).toEqual([1, 0, 0]);
});
