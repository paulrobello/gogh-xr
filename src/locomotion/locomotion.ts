/**
 * Locomotion wiring (P3.2): the rig, a three.js Group in the scene with the camera as its child,
 * driven every frame by the pure core in turn.ts and step.ts. XR and desktop share this one path.
 *
 * The head pose is read from the camera's local transform, which is rig-relative in both modes.
 * In XR, three's XR camera writes it at each render, so a frame reads the pose of the last render.
 * On the desktop, src/desktop/controls.ts writes it (the eye EYE_HEIGHT above the rig, turned by
 * the mouse look) before this runs.
 */
import { Euler, Group, type Object3D } from 'three';
import { EYE_HEIGHT } from '../desktop/walk';
import { comfortFactor, easeVignette } from '../ui/vignette-alpha';
import type { LocomotionSettings, TurnMode } from './settings';
import {
  calibrateSeated,
  createLocomotionState,
  FLAT_GROUND,
  type Ground,
  type MoveInput,
  placeRig,
  spawnAt,
  step,
} from './step';
import { type TurnInput, turn } from './turn';

/** The part of a P3.1 `Actions` frame locomotion reads. */
export interface FrameActions extends MoveInput, TurnInput {
  /** Seconds, already clamped by the input layer. */
  readonly dt: number;
}

/** The desktop look (src/desktop/controls.ts). */
export interface LookTarget {
  setLook(yaw: number, pitch: number): void;
  update(): void;
}

/** The tunnel vignette mesh (src/ui/vignette.ts). */
export interface VignetteTarget {
  setAlpha(alpha: number): void;
}

export interface LocomotionDeps {
  readonly scene: Object3D;
  readonly camera: Object3D;
  readonly look: LookTarget;
  readonly settings: LocomotionSettings;
  /** Given the vignette alpha every frame. Omitted where nothing draws it. */
  readonly vignette?: VignetteTarget;
}

/** `__goghDiag().rig`. P3.4-P3.5 extend it. */
export interface RigDiag {
  readonly position: [number, number, number];
  yaw: number;
  mode: 'walk';
  seated: boolean;
  grounded: boolean;
  speed: number;
  turnMode: TurnMode;
  /** The tunnel vignette alpha of the last frame, 0 at rest and always 0 outside XR. */
  vignette: number;
}

export interface Locomotion {
  readonly rig: Group;
  /** One frame, after the desktop look has written the camera. */
  frame(actions: FrameActions, presenting: boolean): void;
  /** The walkable ground of the bound world, or null for the flat y = 0 floor. */
  setGround(ground: Ground | null): void;
  /**
   * A world is loading: hold the rig's y (not grounded) until `setGround` binds its ground, so a
   * spawn above y = 0 does not sink toward the flat floor during the build.
   */
  awaitGround(): void;
  /** Stands the rig on a floor pose (a world's `spawnPose()`), level look, ground follow on. */
  spawn(x: number, y: number, z: number, yaw: number): void;
  /**
   * Puts the desktop eye exactly at (x, y, z) with the given yaw and pitch (`__goghPose`,
   * `?painter`). Ground follow stays off until the next movement input, so it never fights a
   * placed pose.
   */
  setPose(x: number, y: number, z: number, yaw: number, pitch: number): void;
  /** Recaptures the seated offset from the current XR head height. A no-op outside XR. */
  calibrate(): void;
  /** The rig, in one object reused across calls. */
  diag(): RigDiag;
}

/**
 * A head this low is no pose yet: a frame without a viewer pose leaves three's XR camera at the
 * origin. Seated calibration waits for a real one.
 */
const MIN_CALIBRATION_HEAD_Y = 0.3;

export function createLocomotion(deps: LocomotionDeps): Locomotion {
  const { scene, camera, look, settings, vignette } = deps;
  const rig = new Group();
  rig.name = 'rig';
  scene.add(rig);
  rig.add(camera);

  const state = createLocomotionState();
  let ground: Ground | null = FLAT_GROUND;
  const head = { x: 0, y: 0, z: 0, yaw: 0 };
  const euler = new Euler(0, 0, 0, 'YXZ');
  let presenting = false;
  /** Presenting frames this session. The first still shows the pose from before the session. */
  let xrFrames = 0;
  let calibrated = false;
  const rigDiag: RigDiag = {
    position: [0, 0, 0],
    yaw: 0,
    mode: 'walk',
    seated: settings.seated,
    grounded: true,
    speed: 0,
    turnMode: settings.turnMode,
    vignette: 0,
  };
  let vignetteAlpha = 0;

  function readHead(): void {
    head.x = camera.position.x;
    head.y = camera.position.y;
    head.z = camera.position.z;
    head.yaw = euler.setFromQuaternion(camera.quaternion, 'YXZ').y;
  }

  function writeRig(): void {
    rig.position.set(state.position[0], state.position[1], state.position[2]);
    rig.rotation.set(0, state.yaw, 0);
  }

  return {
    rig,
    frame(actions, isPresenting) {
      readHead();
      if (isPresenting) {
        xrFrames += 1;
        if (settings.seated && !calibrated && xrFrames > 1 && head.y > MIN_CALIBRATION_HEAD_Y) {
          calibrateSeated(state, settings, head.y);
          calibrated = true;
        }
      } else {
        xrFrames = 0;
        calibrated = false;
        state.seatedOffset = 0;
      }
      presenting = isPresenting;
      turn(state, actions, settings, actions.dt, head);
      step(state, actions, ground, settings, actions.dt, head);
      writeRig();
      // XR only: the desktop preview and its captures never show the vignette, even fading out.
      vignetteAlpha = isPresenting
        ? easeVignette(
            vignetteAlpha,
            settings.vignette * comfortFactor(state.speed, state.turnRate, settings),
            actions.dt,
          )
        : 0;
      vignette?.setAlpha(vignetteAlpha);
    },
    setGround(next) {
      ground = next ?? FLAT_GROUND;
    },
    awaitGround() {
      ground = null;
    },
    spawn(x, y, z, yaw) {
      spawnAt(state, x, y, z, yaw);
      look.setLook(0, 0);
      look.update();
      writeRig();
    },
    setPose(x, y, z, yaw, pitch) {
      placeRig(state, x, y - EYE_HEIGHT, z, yaw);
      look.setLook(0, pitch);
      look.update();
      writeRig();
    },
    calibrate() {
      if (!presenting) return;
      readHead();
      calibrateSeated(state, settings, head.y);
      calibrated = true;
    },
    diag() {
      rigDiag.position[0] = state.position[0];
      rigDiag.position[1] = state.position[1];
      rigDiag.position[2] = state.position[2];
      rigDiag.yaw = state.yaw;
      rigDiag.seated = settings.seated;
      rigDiag.grounded = state.grounded;
      rigDiag.speed = state.speed;
      rigDiag.turnMode = settings.turnMode;
      rigDiag.vignette = vignetteAlpha;
      return rigDiag;
    },
  };
}
