import { Euler, Object3D, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { installDesktopControls } from '../src/desktop/controls';
import { EYE_HEIGHT } from '../src/desktop/walk';
import { createLocomotion, type FrameActions } from '../src/locomotion/locomotion';
import { DEFAULT_LOCOMOTION_SETTINGS, type LocomotionSettings } from '../src/locomotion/settings';
import type { Ground } from '../src/locomotion/step';
import {
  type ArcResult,
  BLINK_DOWN,
  GRAVITY,
  LAUNCH_SPEED,
  type LandingWorld,
} from '../src/locomotion/teleport';
import type { Vec3 } from '../src/render/strokes/frame';

const IDLE: FrameActions = {
  dt: 0.05,
  move: { x: 0, y: 0 },
  sprint: false,
  turn: { x: 0, snap: 0 },
  teleportAim: false,
  teleportCommit: false,
};
const FORWARD: FrameActions = { ...IDLE, move: { x: 0, y: 1 } };
/** A right-stick push past the snap threshold, on its first frame. */
const SNAP_RIGHT: FrameActions = { ...IDLE, turn: { x: 1, snap: 1 } };
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

describe('turning', () => {
  it('a desktop snap (E) turns the rig 30° right about the eye, leaving the mouse look alone', () => {
    const { camera, desktop, locomotion, desktopFrame, eye } = setup();
    locomotion.spawn(1, 0, -2, 0);
    desktop.setLook(0.4, 0.1);
    desktopFrame(IDLE);
    const before = eye();
    desktopFrame(SNAP_RIGHT);
    expect(locomotion.diag().yaw).toBeCloseTo(-Math.PI / 6, 14);
    expect(locomotion.rig.rotation.y).toBeCloseTo(-Math.PI / 6, 14);
    const after = eye();
    for (let i = 0; i < 3; i += 1) expect(after[i]).toBeCloseTo(before[i] as number, 12);
    // The look is the camera's own rotation, inside the rig.
    expect(camera.rotation.y).toBeCloseTo(0.4, 14);
  });

  it('an XR snap pivots on the head read from the camera, so the rendered eye stays put', () => {
    const { camera, locomotion, xrFrame, scene } = setup();
    locomotion.spawn(1, 0, 2, 0.5);
    const head = new Vector3(0.5, 1.5, -0.4);
    xrFrame(IDLE, head);
    scene.updateMatrixWorld();
    const before = camera.getWorldPosition(new Vector3());
    xrFrame(SNAP_RIGHT, head);
    scene.updateMatrixWorld();
    const after = camera.getWorldPosition(new Vector3());
    expect(locomotion.diag().yaw).toBeCloseTo(0.5 - Math.PI / 6, 14);
    expect(after.x).toBeCloseTo(before.x, 12);
    expect(after.y).toBeCloseTo(before.y, 12);
    expect(after.z).toBeCloseTo(before.z, 12);
  });

  it('smooth mode turns continuously and ignores the snap request', () => {
    const { locomotion, desktopFrame } = setup({
      ...DEFAULT_LOCOMOTION_SETTINGS,
      turnMode: 'smooth',
    });
    for (let i = 0; i < 20; i += 1) desktopFrame(SNAP_RIGHT);
    expect(locomotion.diag().yaw).toBeCloseTo(-Math.PI / 2, 12);
    expect(locomotion.diag().turnMode).toBe('smooth');
  });
});

describe('the vignette', () => {
  /** A rig whose vignette records every alpha it is given. */
  function withVignette(settings: LocomotionSettings = DEFAULT_LOCOMOTION_SETTINGS) {
    const alphas: number[] = [];
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const desktop = installDesktopControls(document.createElement('canvas'), camera);
    const vignette = { setAlpha: (alpha: number) => void alphas.push(alpha), setFade: () => {} };
    const locomotion = createLocomotion({ scene, camera, look: desktop, settings, vignette });
    const head = new Vector3(0, 1.6, 0);
    const xr = (actions: FrameActions, frames = 1): number => {
      for (let i = 0; i < frames; i += 1) {
        camera.position.copy(head);
        locomotion.frame(actions, true);
      }
      return locomotion.diag().vignette;
    };
    const flat = (actions: FrameActions, frames = 1): number => {
      for (let i = 0; i < frames; i += 1) {
        desktop.update();
        locomotion.frame(actions, false);
      }
      return locomotion.diag().vignette;
    };
    return { alphas, xr, flat };
  }
  const SMOOTH_RIGHT: FrameActions = { ...IDLE, turn: { x: 1, snap: 0 } };

  it('is exactly 0 at rest, and drives the mesh with that 0', () => {
    const { alphas, xr } = withVignette();
    expect(xr(IDLE, 20)).toBe(0);
    expect(alphas).toHaveLength(20);
    expect(alphas.every((alpha) => alpha === 0)).toBe(true);
  });

  it('rises with smooth-move speed to the full 0.6 strength at full stick, never above', () => {
    const { alphas, xr } = withVignette();
    expect(xr(FORWARD)).toBeGreaterThan(0);
    xr(FORWARD, 40);
    expect(xr(FORWARD)).toBeCloseTo(0.6, 6);
    expect(Math.max(...alphas)).toBeLessThanOrEqual(0.6);
    for (let i = 1; i < alphas.length; i += 1) {
      expect(alphas[i] as number).toBeGreaterThanOrEqual(alphas[i - 1] as number);
    }
    // Half stick: half the comfort factor, at any move speed setting.
    const half: FrameActions = { ...IDLE, move: { x: 0, y: 0.5 } };
    expect(withVignette().xr(half, 40)).toBeCloseTo(0.3, 6);
    const slow = { ...DEFAULT_LOCOMOTION_SETTINGS, moveSpeed: 1 };
    expect(withVignette(slow).xr(FORWARD, 40)).toBeCloseTo(0.6, 6);
  });

  it('rises to the full strength at the full smooth-turn rate, and follows the strength', () => {
    expect(withVignette().xr({ ...IDLE, turn: { x: 1, snap: 0 } }, 1)).toBe(0);
    const smooth = { ...DEFAULT_LOCOMOTION_SETTINGS, turnMode: 'smooth' as const };
    expect(withVignette(smooth).xr(SMOOTH_RIGHT, 60)).toBeCloseTo(0.6, 6);
    expect(withVignette({ ...smooth, vignette: 1 }).xr(SMOOTH_RIGHT, 60)).toBeCloseTo(1, 6);
    expect(withVignette({ ...smooth, vignette: 0 }).xr(SMOOTH_RIGHT, 60)).toBe(0);
  });

  it('adds nothing for a snap turn', () => {
    const { xr } = withVignette();
    expect(xr(SNAP_RIGHT)).toBe(0);
    expect(xr(IDLE, 5)).toBe(0);
  });

  it('eases back to exactly 0 within a second of stopping', () => {
    const { alphas, xr } = withVignette();
    xr(FORWARD, 40);
    expect(xr(IDLE)).toBeGreaterThan(0.2);
    // 20 frames of 50 ms.
    expect(xr(IDLE, 20)).toBe(0);
    expect(alphas.at(-1)).toBe(0);
  });

  it('shows in XR only: never on the desktop, and gone at once when the session ends', () => {
    const { alphas, xr, flat } = withVignette();
    expect(flat(FORWARD, 40)).toBe(0);
    expect(xr(FORWARD, 40)).toBeGreaterThan(0.3);
    expect(flat(FORWARD)).toBe(0);
    expect(alphas.at(-1)).toBe(0);
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
      turnMode: 'snap',
      vignette: 0,
      aim: { active: false, valid: false, reason: 'none', hit: null },
      lastTeleport: null,
    });
    expect(first.position).toHaveLength(3);
    desktopFrame(IDLE);
    const second = locomotion.diag();
    expect(second).toBe(first);
    expect(second.position).toBe(first.position);
    expect(second.speed).toBe(0);
  });
});

describe('teleport', () => {
  const AIM: FrameActions = { ...IDLE, teleportAim: true };
  const RELEASE: FrameActions = { ...IDLE, teleportCommit: true };
  const LEVEL: Vec3 = [0, 1, 0];
  /** Where a shot fired level from `height` above flat ground lands, metres out. */
  const levelReach = (height: number): number => LAUNCH_SPEED * Math.sqrt((2 * height) / GRAVITY);

  function withTeleport(settings: LocomotionSettings = DEFAULT_LOCOMOTION_SETTINGS) {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const desktop = installDesktopControls(document.createElement('canvas'), camera);
    const fades: number[] = [];
    const shown: { valid: boolean; eye: Vec3 }[] = [];
    const arc = {
      hidden: 0,
      show: (aim: ArcResult, eye: Vec3) => void shown.push({ valid: aim.valid, eye: [...eye] }),
      hide: () => {
        arc.hidden += 1;
      },
    };
    /** The right controller's target-ray space, under the rig as main.ts parents it. */
    const controller = new Object3D();
    const hand = { tracked: true };
    const locomotion = createLocomotion({
      scene,
      camera,
      look: desktop,
      settings,
      vignette: { setAlpha: () => {}, setFade: (fade: number) => void fades.push(fade) },
      aimSource: () => (hand.tracked ? controller : null),
      arc,
      now: () => 1234,
    });
    locomotion.rig.add(controller);
    const desktopFrame = (actions: FrameActions): void => {
      desktop.update();
      locomotion.frame(actions, false);
    };
    const xrFrame = (actions: FrameActions, head: Vector3): void => {
      camera.position.copy(head);
      locomotion.frame(actions, true);
    };
    /** The camera's world XZ from the rig state, as step.ts computes the head's. */
    const headXZ = (): [number, number] => {
      const { position, yaw } = locomotion.diag();
      const s = Math.sin(yaw);
      const c = Math.cos(yaw);
      return [
        position[0] + c * camera.position.x + s * camera.position.z,
        position[2] - s * camera.position.x + c * camera.position.z,
      ];
    };
    return { arc, controller, fades, hand, locomotion, shown, desktopFrame, xrFrame, headXZ };
  }

  it('on the desktop, T aims from the eye along the view and its release jumps at once', () => {
    const t = withTeleport();
    // Rig yaw +90° faces -X; the level look adds nothing.
    t.locomotion.spawn(1, 0, 2, Math.PI / 2);
    t.desktopFrame(AIM);
    const aim = t.locomotion.diag().aim;
    expect(aim.active).toBe(true);
    expect(aim.valid).toBe(true);
    expect(aim.reason).toBe('ok');
    const hit = [...(aim.hit as Vec3)] as Vec3;
    expect(hit[0]).toBeCloseTo(1 - levelReach(EYE_HEIGHT), 6);
    expect(hit[1]).toBe(0);
    expect(hit[2]).toBeCloseTo(2, 9);
    expect(t.locomotion.diag().lastTeleport).toBeNull();

    t.desktopFrame(RELEASE);
    const [hx, hz] = t.headXZ();
    expect(hx).toBeCloseTo(hit[0], 9);
    expect(hz).toBeCloseTo(hit[2], 9);
    expect(t.locomotion.diag().position[1]).toBe(0);
    expect(t.locomotion.diag().lastTeleport).toEqual({ from: [1, 0, 2], to: hit, t: 1234 });
    expect(t.locomotion.diag().aim).toEqual({
      active: false,
      valid: false,
      reason: 'none',
      hit: null,
    });
  });

  it('in XR it aims from the right controller under the rig, and jumps the head at full black', () => {
    const t = withTeleport();
    const yaw = 0.5;
    t.locomotion.spawn(2, 0, 1, yaw);
    t.controller.position.set(0.25, 1.4, -0.4);
    const head = new Vector3(0.3, 1.6, -0.2);
    t.xrFrame(AIM, head);
    const hit = [...(t.locomotion.diag().aim.hit as Vec3)] as Vec3;
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    // The controller's world origin, then a level shot along the rig's -Z.
    const ox = 2 + c * 0.25 + s * -0.4;
    const oz = 1 - s * 0.25 + c * -0.4;
    const reach = levelReach(1.4);
    expect(hit[0]).toBeCloseTo(ox - s * reach, 6);
    expect(hit[2]).toBeCloseTo(oz - c * reach, 6);

    const before = [...t.locomotion.diag().position];
    t.xrFrame(RELEASE, head);
    // The commit frame starts the fade and moves nothing.
    expect(t.locomotion.diag().position).toEqual(before);
    expect(t.locomotion.diag().lastTeleport).toBeNull();
    // The head drifts during the fade; the jump still lands it on the hit.
    const drifted = new Vector3(0.1, 1.6, 0.3);
    const frames = Math.ceil(BLINK_DOWN / IDLE.dt - 1e-9);
    const fadesBefore = t.fades.length;
    for (let i = 0; i < frames - 1; i += 1) t.xrFrame(IDLE, drifted);
    expect(t.locomotion.diag().lastTeleport).toBeNull();
    t.xrFrame(IDLE, drifted);
    expect(t.fades.at(-1)).toBe(1);
    expect(t.fades.slice(fadesBefore, -1).every((f) => f > 0 && f < 1)).toBe(true);
    const [hx, hz] = t.headXZ();
    expect(hx).toBeCloseTo(hit[0], 9);
    expect(hz).toBeCloseTo(hit[2], 9);
    expect(t.locomotion.diag().yaw).toBe(yaw);
    expect(t.locomotion.diag().lastTeleport?.to).toEqual(hit);
    for (let i = 0; i < 5; i += 1) t.xrFrame(IDLE, drifted);
    expect(t.fades.at(-1)).toBe(0);
  });

  it('jumps the rig y straight onto the landing ground, with no ground-follow ease', () => {
    const t = withTeleport();
    const terrace: LandingWorld = {
      ground: { heightAt: (_x, z) => (z < -2 ? -1 : 0), normalAt: () => LEVEL },
    };
    t.locomotion.setWorld(terrace);
    t.locomotion.spawn(0, 0, 0, 0);
    t.desktopFrame(AIM);
    expect(t.locomotion.diag().aim.hit?.[1]).toBe(-1);
    t.desktopFrame(RELEASE);
    expect(t.locomotion.diag().position[1]).toBe(-1);
    t.desktopFrame(IDLE);
    expect(t.locomotion.diag().position[1]).toBe(-1);
  });

  it('an invalid aim on release does nothing', () => {
    const t = withTeleport();
    t.locomotion.setWorld({
      ground: { heightAt: () => 0, normalAt: () => LEVEL },
      blocked: () => true,
    });
    t.locomotion.spawn(0, 0, 0, 0);
    t.desktopFrame(AIM);
    expect(t.locomotion.diag().aim).toMatchObject({
      active: true,
      valid: false,
      reason: 'footprint',
    });
    t.desktopFrame(RELEASE);
    expect(t.locomotion.diag().position).toEqual([0, 0, 0]);
    expect(t.locomotion.diag().lastTeleport).toBeNull();
    for (let i = 0; i < 5; i += 1) t.desktopFrame(IDLE);
    expect(t.locomotion.diag().position).toEqual([0, 0, 0]);
  });

  it('while aiming, snap and smooth turn are ignored and the left stick still moves', () => {
    for (const turnMode of ['snap', 'smooth'] as const) {
      const t = withTeleport({ ...DEFAULT_LOCOMOTION_SETTINGS, turnMode });
      t.locomotion.spawn(0, 0, 0, 0);
      // A diagonal right-stick push held as an aim: X past the snap threshold.
      const diagonal: FrameActions = { ...AIM, move: { x: 0, y: 1 }, turn: { x: 0.8, snap: 1 } };
      for (let i = 0; i < 10; i += 1) t.desktopFrame(diagonal);
      expect(t.locomotion.diag().yaw).toBe(0);
      expect(t.locomotion.diag().position[2]).toBeCloseTo(-1, 9);
      // Released, the same stick turns again.
      t.desktopFrame({ ...IDLE, turn: { x: 0.8, snap: 1 } });
      expect(t.locomotion.diag().yaw).toBeLessThan(0);
    }
  });

  it('draws the arc while aiming, facing the eye, and hides it otherwise', () => {
    const t = withTeleport();
    t.locomotion.spawn(0, 0, 0, 0);
    t.desktopFrame(IDLE);
    expect(t.shown).toHaveLength(0);
    const hidden = t.arc.hidden;
    t.desktopFrame(AIM);
    expect(t.shown).toEqual([{ valid: true, eye: [0, EYE_HEIGHT, 0] }]);
    expect(t.arc.hidden).toBe(hidden);
    t.desktopFrame(RELEASE);
    expect(t.arc.hidden).toBe(hidden + 1);
    // The desktop never fades.
    expect(t.fades.every((f) => f === 0)).toBe(true);
  });

  it('has no aim while a world ground loads, or in XR with no tracked right controller', () => {
    const loading = withTeleport();
    loading.locomotion.awaitGround();
    loading.desktopFrame(AIM);
    expect(loading.locomotion.diag().aim.active).toBe(false);
    loading.desktopFrame(RELEASE);
    expect(loading.locomotion.diag().lastTeleport).toBeNull();

    const untracked = withTeleport();
    untracked.hand.tracked = false;
    untracked.xrFrame(AIM, new Vector3(0, 1.6, 0));
    expect(untracked.locomotion.diag().aim.active).toBe(false);
  });

  it('setWorld binds the landing limits and the walk ground; null is the flat floor', () => {
    const t = withTeleport();
    t.locomotion.setWorld({
      ground: { heightAt: () => 0.4, normalAt: () => LEVEL },
      boundaryFactor: () => 0.2,
    });
    for (let i = 0; i < 40; i += 1) t.desktopFrame(IDLE);
    expect(t.locomotion.diag().position[1]).toBeCloseTo(0.4, 6);
    t.desktopFrame(AIM);
    expect(t.locomotion.diag().aim.reason).toBe('boundary');
    t.locomotion.setWorld(null);
    t.desktopFrame(AIM);
    expect(t.locomotion.diag().aim.reason).toBe('ok');
    for (let i = 0; i < 40; i += 1) t.desktopFrame(IDLE);
    expect(t.locomotion.diag().position[1]).toBeCloseTo(0, 6);
  });
});
