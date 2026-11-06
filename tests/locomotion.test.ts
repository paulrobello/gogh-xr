import { Euler, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { installDesktopControls } from '../src/desktop/controls';
import { EYE_HEIGHT } from '../src/desktop/walk';
import { createLocomotion, type FrameActions } from '../src/locomotion/locomotion';
import { DEFAULT_LOCOMOTION_SETTINGS, type LocomotionSettings } from '../src/locomotion/settings';
import type { Ground } from '../src/locomotion/step';

const IDLE: FrameActions = { dt: 0.05, move: { x: 0, y: 0 }, sprint: false };
const FORWARD: FrameActions = { dt: 0.05, move: { x: 0, y: 1 }, sprint: false };
/** Rises 0.5 m per metre of -z. */
const SLOPE: Ground = { heightAt: (_x, z) => -0.5 * z };

function setup(settings: LocomotionSettings = DEFAULT_LOCOMOTION_SETTINGS) {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const desktop = installDesktopControls(document.createElement('canvas'), camera);
  const locomotion = createLocomotion({ scene, camera, look: desktop, settings });
  /** One desktop frame, in main.ts order: look, then locomotion. */
  const desktopFrame = (actions: FrameActions): void => {
    desktop.update();
    locomotion.frame(actions, false);
  };
  /** One XR frame: the camera holds the head pose three's XR camera wrote at the last render. */
  const xrFrame = (actions: FrameActions, head: Vector3, yaw = 0): void => {
    camera.position.copy(head);
    camera.quaternion.setFromEuler(new Euler(0.3, yaw, 0.1, 'YXZ'));
    locomotion.frame(actions, true);
  };
  const eye = (): number[] => {
    scene.updateMatrixWorld();
    return camera.getWorldPosition(new Vector3()).toArray();
  };
  return { scene, camera, desktop, locomotion, desktopFrame, xrFrame, eye };
}

describe('the rig', () => {
  it('is in the scene with the camera as its child', () => {
    const { scene, camera, locomotion } = setup();
    expect(locomotion.rig.parent).toBe(scene);
    expect(camera.parent).toBe(locomotion.rig);
  });

  it('spawn stands the rig on a floor pose: the desktop eye is EYE_HEIGHT above it', () => {
    const { locomotion, eye } = setup();
    // Applied at once, before any frame runs.
    locomotion.spawn(1, 0.25, -2, Math.PI / 2);
    const [x, y, z] = eye();
    expect(x).toBeCloseTo(1, 12);
    expect(y).toBeCloseTo(0.25 + EYE_HEIGHT, 12);
    expect(z).toBeCloseTo(-2, 12);
    expect(locomotion.rig.rotation.y).toBeCloseTo(Math.PI / 2, 12);
  });

  it('setPose places the eye exactly and holds it against ground follow until a move', () => {
    const { camera, locomotion, desktopFrame, eye } = setup();
    locomotion.setGround(SLOPE);
    locomotion.setPose(3, 30, -4, 0.5, -Math.PI / 2);
    for (let i = 0; i < 20; i += 1) desktopFrame(IDLE);
    const [px, py, pz] = eye();
    expect(px).toBeCloseTo(3, 12);
    expect(py).toBeCloseTo(30, 12);
    expect(pz).toBeCloseTo(-4, 12);
    const forward = new Vector3(0, 0, -1).applyQuaternion(
      camera.getWorldQuaternion(new Quaternion()),
    );
    expect(forward.y).toBeCloseTo(-1, 12);
    expect(locomotion.diag().grounded).toBe(false);
    desktopFrame(FORWARD);
    for (let i = 0; i < 40; i += 1) desktopFrame(IDLE);
    const [x, y, z] = eye();
    expect(y - EYE_HEIGHT).toBeCloseTo(SLOPE.heightAt(x, z), 6);
    expect(locomotion.diag().grounded).toBe(true);
  });

  it('awaitGround holds the spawn height until the world ground binds', () => {
    const { locomotion, desktopFrame } = setup();
    locomotion.awaitGround();
    locomotion.spawn(0, 0.4, 0, 0);
    for (let i = 0; i < 20; i += 1) desktopFrame(IDLE);
    expect(locomotion.diag().position[1]).toBe(0.4);
    expect(locomotion.diag().grounded).toBe(false);
    locomotion.setGround(SLOPE);
    for (let i = 0; i < 40; i += 1) desktopFrame(IDLE);
    expect(locomotion.diag().position[1]).toBeCloseTo(0, 6);
    expect(locomotion.diag().grounded).toBe(true);
  });

  it('with no ground bound, the floor is flat y = 0', () => {
    const { locomotion, desktopFrame, eye } = setup();
    locomotion.spawn(0, 0, 0, 0);
    for (let i = 0; i < 10; i += 1) desktopFrame(FORWARD);
    expect(eye()[1]).toBe(EYE_HEIGHT);
    locomotion.setGround(SLOPE);
    locomotion.setGround(null);
    for (let i = 0; i < 10; i += 1) desktopFrame(FORWARD);
    expect(eye()[1]).toBe(EYE_HEIGHT);
  });
});

describe('desktop movement', () => {
  it('walks along the desktop look yaw plus the rig yaw and follows the ground', () => {
    const { desktop, locomotion, desktopFrame, eye } = setup();
    locomotion.setGround(SLOPE);
    locomotion.spawn(0, 0, 0, Math.PI / 4);
    desktop.setLook(Math.PI / 4, 0.4);
    // Facing -X: forward for 1 s at 2 m/s.
    for (let i = 0; i < 20; i += 1) desktopFrame(FORWARD);
    const [x, , z] = eye();
    expect(x).toBeCloseTo(-2, 9);
    expect(z).toBeCloseTo(0, 9);
    expect(locomotion.diag().speed).toBe(2);
  });

  it('sprint doubles the default speed only up to 3.0 m/s', () => {
    const { locomotion, desktopFrame } = setup();
    desktopFrame({ ...FORWARD, sprint: true });
    expect(locomotion.diag().speed).toBe(3);
  });
});

describe('XR movement', () => {
  it('reads the head from the camera: its yaw steers and its world XZ picks the ground', () => {
    const { locomotion, xrFrame } = setup();
    locomotion.setGround(SLOPE);
    locomotion.spawn(0, 0, 0, 0);
    // The head stands 1 m ahead of the rig origin (local -z) and looks left (yaw +90°).
    const head = new Vector3(0, 1.5, -1);
    for (let i = 0; i < 20; i += 1) xrFrame(FORWARD, head, Math.PI / 2);
    const [x, , z] = locomotion.diag().position;
    expect(x).toBeCloseTo(-2, 9);
    expect(z).toBeCloseTo(0, 9);
    for (let i = 0; i < 40; i += 1) xrFrame(IDLE, head, Math.PI / 2);
    // Ground under the head at world z = -1: 0.5 m.
    expect(locomotion.diag().position[1]).toBeCloseTo(0.5, 6);
  });

  it('the rendered camera world eye is the rig plus the head pose', () => {
    const { camera, locomotion, xrFrame, scene } = setup();
    locomotion.spawn(2, 0, 3, Math.PI);
    xrFrame(IDLE, new Vector3(0.5, 1.4, 0));
    scene.updateMatrixWorld();
    const [x, y, z] = camera.getWorldPosition(new Vector3()).toArray();
    // Rig yaw 180° turns local +x to world -x.
    expect(x).toBeCloseTo(1.5, 12);
    expect(y).toBeCloseTo(1.4, 12);
    expect(z).toBeCloseTo(3, 12);
  });
});

describe('seated mode', () => {
  const SEATED = { ...DEFAULT_LOCOMOTION_SETTINGS, seated: true };

  it('calibrates from the first XR head pose, not the desktop pose the camera holds at first', () => {
    const { locomotion, xrFrame } = setup(SEATED);
    const seatedHead = new Vector3(0, 1.1, 0);
    // The first presenting frame still shows the pose from before the session.
    xrFrame(IDLE, new Vector3(0, EYE_HEIGHT, 0));
    // A frame with no viewer pose leaves the XR camera at the origin.
    xrFrame(IDLE, new Vector3(0, 0, 0));
    xrFrame(IDLE, seatedHead);
    for (let i = 0; i < 40; i += 1) xrFrame(IDLE, seatedHead);
    expect(locomotion.diag().position[1]).toBeCloseTo(0.5, 9);
    expect(locomotion.diag().seated).toBe(true);
  });

  it('captures the offset once per session and drops it outside XR', () => {
    const { locomotion, xrFrame, desktopFrame } = setup(SEATED);
    xrFrame(IDLE, new Vector3(0, 1.6, 0));
    for (let i = 0; i < 5; i += 1) xrFrame(IDLE, new Vector3(0, 1.2, 0));
    // Standing up does not recalibrate.
    for (let i = 0; i < 40; i += 1) xrFrame(IDLE, new Vector3(0, 1.6, 0));
    expect(locomotion.diag().position[1]).toBeCloseTo(0.4, 9);
    // calibrate() recaptures it from the current head.
    locomotion.calibrate();
    for (let i = 0; i < 40; i += 1) xrFrame(IDLE, new Vector3(0, 1.6, 0));
    expect(locomotion.diag().position[1]).toBeCloseTo(0, 9);
    // The desktop is a no-op: no offset.
    xrFrame(IDLE, new Vector3(0, 1.0, 0));
    locomotion.calibrate();
    for (let i = 0; i < 5; i += 1) desktopFrame(IDLE);
    expect(locomotion.diag().position[1]).toBe(0);
    locomotion.calibrate();
    desktopFrame(IDLE);
    expect(locomotion.diag().position[1]).toBe(0);
  });

  it('is never applied when the setting is off', () => {
    const { locomotion, xrFrame } = setup();
    xrFrame(IDLE, new Vector3(0, 1.6, 0));
    for (let i = 0; i < 5; i += 1) xrFrame(IDLE, new Vector3(0, 1.1, 0));
    expect(locomotion.diag().position[1]).toBe(0);
    expect(locomotion.diag().seated).toBe(false);
  });
});

describe('diag', () => {
  it('reports the rig in one reused object', () => {
    const { locomotion, desktopFrame } = setup();
    locomotion.spawn(1, 0, 2, 0.25);
    desktopFrame(FORWARD);
    const first = locomotion.diag();
    expect(first).toEqual({
      position: first.position,
      yaw: 0.25,
      mode: 'walk',
      seated: false,
      grounded: true,
      speed: 2,
    });
    expect(first.position).toHaveLength(3);
    desktopFrame(IDLE);
    const second = locomotion.diag();
    expect(second).toBe(first);
    expect(second.position).toBe(first.position);
    expect(second.speed).toBe(0);
  });
});
