/**
 * Locomotion wiring (P3.2): the rig, a three.js Group in the scene with the camera as its child,
 * driven every frame by the pure core in turn.ts and step.ts. XR and desktop share this one path.
 *
 * The head pose is read from the camera's local transform, which is rig-relative in both modes.
 * In XR, three's XR camera writes it at each render, so a frame reads the pose of the last render.
 * On the desktop, src/desktop/controls.ts writes it (the eye EYE_HEIGHT above the rig, turned by
 * the mouse look) before this runs.
 */
import { Euler, Group, type Object3D, Vector3 } from 'three';
import { EYE_HEIGHT } from '../desktop/walk';
import type { Vec3 } from '../render/strokes/frame';
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
import {
  type ArcResult,
  createArcResult,
  createBlink,
  FLAT_WORLD,
  type LandingReason,
  type LandingWorld,
  startBlink,
  stepBlink,
  teleportRig,
  traceArc,
} from './teleport';
import { type TurnInput, turn } from './turn';

/** The part of a P3.1 `Actions` frame locomotion reads. */
export interface FrameActions extends MoveInput, TurnInput {
  /** Seconds, already clamped by the input layer. */
  readonly dt: number;
  /** Level: a teleport aim is held. */
  readonly teleportAim: boolean;
  /** Edge: the aim ended this frame. */
  readonly teleportCommit: boolean;
}

/** The desktop look (src/desktop/controls.ts). */
export interface LookTarget {
  setLook(yaw: number, pitch: number): void;
  update(): void;
}

/** The tunnel vignette mesh (src/ui/vignette.ts). */
export interface VignetteTarget {
  setAlpha(alpha: number): void;
  /** The teleport blink: full-view black, 0-1, over the tunnel. */
  setFade(fade: number): void;
}

/** Draws the teleport arc (src/locomotion/arc-mesh.ts). */
export interface ArcTarget {
  /** Draws `aim` this frame, its strokes turned toward `eye`, in world space. */
  show(aim: ArcResult, eye: Vec3): void;
  hide(): void;
}

export interface LocomotionDeps {
  readonly scene: Object3D;
  readonly camera: Object3D;
  readonly look: LookTarget;
  readonly settings: LocomotionSettings;
  /** Given the vignette alpha and the blink fade every frame. Omitted where nothing draws it. */
  readonly vignette?: VignetteTarget;
  /**
   * The right controller's target-ray space, a child of the rig, or null while it is not tracked.
   * XR aims along its -Z. Omitted: no XR aim. The desktop aims from the camera.
   */
  readonly aimSource?: () => Object3D | null;
  /** Draws the arc while aiming. Omitted: the aim still works, undrawn. */
  readonly arc?: ArcTarget;
  /** The clock of `lastTeleport.t`, ms. Defaults to `performance.now`. */
  readonly now?: () => number;
}

export interface TeleportAimDiag {
  /** An arc was traced this frame. */
  active: boolean;
  valid: boolean;
  reason: LandingReason;
  /** The landing, or null with no arc or no ground in reach. */
  hit: [number, number, number] | null;
}

export interface TeleportRecord {
  /** The head's world XZ before the jump, at the ground height under it then. */
  readonly from: Vec3;
  /** The landing: the head's world XZ after the jump, on the ground. */
  readonly to: Vec3;
  /** `now()` at the jump, ms. */
  readonly t: number;
}

/** `__goghDiag().rig`. P3.5 extends it. */
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
  readonly aim: TeleportAimDiag;
  /** The last jump, recorded when the rig moved: after the blink's fade in XR. */
  lastTeleport: TeleportRecord | null;
}

export interface Locomotion {
  readonly rig: Group;
  /** One frame, after the desktop look has written the camera. */
  frame(actions: FrameActions, presenting: boolean): void;
  /**
   * Binds a walk ground and nothing else, or null for the flat y = 0 floor. Teleport lands on it
   * as level ground with no boundary and no footprints; `setWorld` binds those too.
   */
  setGround(ground: Ground | null): void;
  /**
   * Binds a world's ground, boundary and footprints (a `WorldHandle`) for ground follow and
   * teleport landings, or null for the flat y = 0 floor with neither.
   */
  setWorld(world: LandingWorld | null): void;
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
/** Turning input while a teleport aim is held: none. */
const NO_TURN: TurnInput = Object.freeze({ turn: Object.freeze({ x: 0, snap: 0 as const }) });
const LEVEL: Vec3 = Object.freeze([0, 1, 0]) as Vec3;

export function createLocomotion(deps: LocomotionDeps): Locomotion {
  const { scene, camera, look, settings, vignette, arc } = deps;
  const now = deps.now ?? (() => performance.now());
  const rig = new Group();
  rig.name = 'rig';
  scene.add(rig);
  rig.add(camera);

  const state = createLocomotionState();
  let ground: Ground | null = FLAT_GROUND;
  /** Where teleport lands: the bound world, kept in step with `ground`. */
  let landing: LandingWorld = FLAT_WORLD;
  const aim = createArcResult();
  /** True while `aim` holds this frame's trace. */
  let aimActive = false;
  const blink = createBlink();
  /** The landing a running blink jumps to at full black. */
  const pending: [number, number, number] = [0, 0, 0];
  let lastTeleport: TeleportRecord | null = null;
  const aimOrigin: [number, number, number] = [0, 0, 0];
  const aimDirection: [number, number, number] = [0, 0, 0];
  const eye: [number, number, number] = [0, 0, 0];
  const scratch = new Vector3();
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
    aim: { active: false, valid: false, reason: 'none', hit: null },
    lastTeleport: null,
  };
  const aimHit: [number, number, number] = [0, 0, 0];
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

  /** The head's world position from the rig state, into `out`. */
  function headWorld(out: [number, number, number], y: number): void {
    const sin = Math.sin(state.yaw);
    const cos = Math.cos(state.yaw);
    out[0] = state.position[0] + cos * head.x + sin * head.z;
    out[1] = y;
    out[2] = state.position[2] - sin * head.x + cos * head.z;
  }

  function jump(hit: Vec3): void {
    const from: [number, number, number] = [0, 0, 0];
    headWorld(from, state.groundY);
    teleportRig(state, head, hit, settings);
    lastTeleport = { from, to: [hit[0], hit[1], hit[2]], t: now() };
  }

  /** Traces the aim from `source`'s -Z in world space, the rig as written this frame. */
  function traceAim(source: Object3D): void {
    writeRig();
    source.updateWorldMatrix(true, false);
    scratch.setFromMatrixPosition(source.matrixWorld);
    aimOrigin[0] = scratch.x;
    aimOrigin[1] = scratch.y;
    aimOrigin[2] = scratch.z;
    scratch.set(0, 0, -1).transformDirection(source.matrixWorld);
    aimDirection[0] = scratch.x;
    aimDirection[1] = scratch.y;
    aimDirection[2] = scratch.z;
    traceArc(aim, aimOrigin, aimDirection, landing);
  }

  /**
   * One frame of teleport: a running blink jumps at full black, a release jumps to a valid aim
   * (in XR through the blink, on the desktop at once), and a held aim traces the arc. Without a
   * ground (a world loading) there is no aim.
   */
  function teleport(actions: FrameActions, aiming: boolean, isPresenting: boolean): void {
    const aimed = aimActive;
    aimActive = false;
    if (blink.active) {
      if (stepBlink(blink, actions.dt)) jump(pending);
    } else if (actions.teleportCommit) {
      const hit = aimed && aim.valid ? aim.hit : null;
      if (hit) {
        if (isPresenting) {
          pending[0] = hit[0];
          pending[1] = hit[1];
          pending[2] = hit[2];
          startBlink(blink);
        } else {
          jump(hit);
        }
      }
    } else if (aiming && ground !== null) {
      const source = isPresenting ? (deps.aimSource?.() ?? null) : camera;
      if (source) {
        traceAim(source);
        aimActive = true;
      }
    }
    if (aimActive) {
      headWorld(eye, state.position[1] + head.y);
      arc?.show(aim, eye);
    } else {
      arc?.hide();
    }
  }

  function cancelTeleport(): void {
    blink.active = false;
    blink.fade = 0;
    aimActive = false;
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
      // Teleport is a walk-mode action: this is the one check that flight (P3.5) gates it at.
      const aiming = actions.teleportAim && rigDiag.mode === 'walk';
      // A held aim never turns the rig, even pushed diagonally across the snap threshold.
      turn(state, aiming ? NO_TURN : actions, settings, actions.dt, head);
      step(state, actions, ground, settings, actions.dt, head);
      teleport(actions, aiming, isPresenting);
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
      // The desktop jumps at once, so its blink never shows.
      vignette?.setFade(isPresenting ? blink.fade : 0);
    },
    setGround(next) {
      ground = next ?? FLAT_GROUND;
      landing = next
        ? { ground: { heightAt: (x, z) => next.heightAt(x, z), normalAt: () => LEVEL } }
        : FLAT_WORLD;
    },
    setWorld(world) {
      ground = world?.ground ?? FLAT_GROUND;
      landing = world ?? FLAT_WORLD;
    },
    awaitGround() {
      ground = null;
    },
    spawn(x, y, z, yaw) {
      cancelTeleport();
      spawnAt(state, x, y, z, yaw);
      look.setLook(0, 0);
      look.update();
      writeRig();
    },
    setPose(x, y, z, yaw, pitch) {
      cancelTeleport();
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
      const aimDiag = rigDiag.aim;
      aimDiag.active = aimActive;
      aimDiag.valid = aimActive && aim.valid;
      aimDiag.reason = aimActive ? aim.reason : 'none';
      aimDiag.hit = null;
      if (aimActive && aim.hit) {
        aimHit[0] = aim.hit[0];
        aimHit[1] = aim.hit[1];
        aimHit[2] = aim.hit[2];
        aimDiag.hit = aimHit;
      }
      rigDiag.lastTeleport = lastTeleport;
      return rigDiag;
    },
  };
}
