import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import {
  CAMERA_FORWARD,
  CAMERA_RIGHT,
  CAMERA_UP,
  CANVAS_ASPECT,
  CANVAS_FOV_Y_DEG,
  CANVAS_PITCH,
  CANVAS_YAW,
  canvasRay,
  onFrontal,
  onLevel,
  PAINTER_EYE,
  STREET_VANISH,
  toCanvas,
} from '../src/paintings/cafe-terrace-at-night/canvas';
import { painterCamera } from '../src/paintings/cafe-terrace-at-night/index';

describe('café painter camera', () => {
  test('the street axis vanishes at STREET_VANISH and level rays stay on its v', () => {
    const far = toCanvas([0, PAINTER_EYE[1], -1e6]);
    expect(far.u).toBeCloseTo(STREET_VANISH[0], 6);
    expect(far.v).toBeCloseTo(STREET_VANISH[1], 6);
    for (const u of [0, 0.3, 1]) expect(canvasRay(u, STREET_VANISH[1])[1]).toBeCloseTo(0, 12);
  });

  test('the axes are orthonormal and the camera looks slightly up and left', () => {
    const dot = (a: readonly number[], b: readonly number[]) =>
      a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (const axis of [CAMERA_RIGHT, CAMERA_UP, CAMERA_FORWARD]) {
      expect(dot(axis, axis)).toBeCloseTo(1, 12);
    }
    expect(dot(CAMERA_RIGHT, CAMERA_UP)).toBeCloseTo(0, 12);
    expect(dot(CAMERA_RIGHT, CAMERA_FORWARD)).toBeCloseTo(0, 12);
    expect(dot(CAMERA_UP, CAMERA_FORWARD)).toBeCloseTo(0, 12);
    expect(CANVAS_PITCH).toBeGreaterThan(0);
    expect(CANVAS_YAW).toBeGreaterThan(0);
  });

  test('a point cast onto a plane projects back to its canvas point', () => {
    for (const [u, v] of [
      [0.145, 0.775],
      [0.6, 0.9],
      [0.985, 0.7],
    ]) {
      const ground = onLevel(u, v);
      expect(ground[1]).toBeCloseTo(0, 9);
      const back = toCanvas(ground);
      expect(back.u).toBeCloseTo(u, 9);
      expect(back.v).toBeCloseTo(v, 9);
      expect(back.depth).toBeGreaterThan(0);
    }
    const wall = onFrontal(0.4, 0.2, -21);
    expect(wall[2]).toBeCloseTo(-21, 9);
    expect(toCanvas(wall).v).toBeCloseTo(0.2, 9);
    expect(() => onLevel(0.5, 0.2)).toThrow(/never meets/);
  });

  test('matches three: the app camera at the painter pose frames canvas (u, v)', () => {
    const view = painterCamera();
    const camera = new PerspectiveCamera(view.fovYDeg, view.aspect, 0.1, 1000);
    camera.position.set(...view.eye);
    camera.rotation.set(view.pitch, view.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    expect(view.fovYDeg).toBe(CANVAS_FOV_Y_DEG);
    expect(view.aspect).toBe(CANVAS_ASPECT);
    for (const point of [onLevel(0.3, 0.8), onFrontal(0.7, 0.1, -30), onLevel(0.9, 0.62)]) {
      const ndc = new Vector3(...point).project(camera);
      const { u, v } = toCanvas(point);
      expect(0.5 + ndc.x / 2).toBeCloseTo(u, 6);
      expect(0.5 - ndc.y / 2).toBeCloseTo(v, 6);
    }
  });
});
