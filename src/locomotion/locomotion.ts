/**
 * Locomotion wiring (P3.2): the rig, a three.js Group in the scene with the camera as its child,
 * driven every frame by the pure core in turn.ts and step.ts, or flight.ts while flying (P3.5). XR
 * and desktop share this one path.
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
import { MAX_DT } from '../xr/input';
import { boundaryExcess, enterFlight, exitFlight, type FlightInput, fly } from './flight';
import type { LocomotionSettings, TurnMode } from './settings';
import {
  calibrateSeated,
  createLocomotionState,
  FLAT_GROUND,
  type Ground,
  type LocomotionMode,
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
import { type TurnInput, turn, turnAboutHead } from './turn';
import { clampToWalkBounds, type WalkBounds } from './walk-bounds';

/** The part of a P3.1 `Actions` frame locomotion reads. */
export interface FrameActions extends FlightInput, TurnInput {
  /** Seconds, already clamped by the input layer. */
  readonly dt: number;
  /** Level: a teleport aim is held. */
  readonly teleportAim: boolean;
  /** Edge: the aim ended this frame. */
  readonly teleportCommit: boolean;
  /** Edge: toggle flight (P3.5). */
  readonly flightToggle: boolean;
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

/** `__goghDiag().rig`. */
export interface RigDiag {
  readonly position: [number, number, number];
  yaw: number;
  mode: LocomotionMode;
  /** The head's height above the ground under it, metres. */
  altitude: number;
  /** The boundary haze thickening, 0-1: 0 in walk mode once eased out. */
  haze: number;
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
   * Binds a world's ground, boundary, footprints and haze hook (a `WorldHandle`) for ground
   * follow, teleport landings and flight, or null for the flat y = 0 floor with none of them.
   */
  setWorld(world: LocomotionWorld | null): void;
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
  /**
   * Live settings (the P5.3 panel). A change to `seated` or `standingHeight` recalibrates the
   * seated offset on the next XR frame with a head pose.
   */
  setSettings(next: LocomotionSettings): void;
  /**
   * Recenter (P5.3): turns the rig about the head so the view's yaw, rig yaw plus head yaw, is
   * `yaw` (a world's spawn direction), and counts a discontinuity. The head stays where it is.
   */
  faceYaw(yaw: number): void;
  /**
   * Counts discontinuous rig and view moves: a teleport jump, a snap turn, `spawn`, `setPose`, and
   * each `markDiscontinuity` (main.ts calls it on an XR reference-space reset, the system
   * recenter). The reactive tracker restarts its wakes when it changes (P4.5).
   */
  discontinuities(): number;
  markDiscontinuity(): void;
  /** The rig, in one object reused across calls. */
  diag(): RigDiag;
}

/** What `setWorld` binds: a teleport landing world, plus the boundary haze's thickening hook. */
export interface LocomotionWorld extends LandingWorld {
  /** Thickens the boundary haze, 0-1, 0 being the painting as built. Omitted: no haze. */
  setHaze?(thickness: number): void;
  /** An indoor world's walls and ceiling for smooth movement and flight. Omitted: none. */
  readonly walkBounds?: WalkBounds;
}

/** The haze thickening's easing time constant, seconds, so leaving flight at the edge never pops. */
export const HAZE_TAU = 0.25;
/** Below this, with nothing pushing it up, the haze thickening is exactly 0. */
const HAZE_REST = 1e-3;

/**
 * A head this low is no pose yet: a frame without a viewer pose leaves three's XR camera at the
 * origin. Seated calibration waits for a real one.
 */
const MIN_CALIBRATION_HEAD_Y = 0.3;
/** Turning input while a teleport aim is held: none. */
const NO_TURN: TurnInput = Object.freeze({ turn: Object.freeze({ x: 0, snap: 0 as const }) });
const LEVEL: Vec3 = Object.freeze([0, 1, 0]) as Vec3;

export function createLocomotion(deps: LocomotionDeps): Locomotion {
  const { scene, camera, look, vignette, arc } = deps;
  let settings = deps.settings;
  const now = deps.now ?? (() => performance.now());
  const rig = new Group();
  rig.name = 'rig';
  scene.add(rig);
  rig.add(camera);

  const state = createLocomotionState();
  let ground: Ground | null = FLAT_GROUND;
  /** Where teleport lands and flight is bounded: the bound world, kept in step with `ground`. */
  let landing: LocomotionWorld = FLAT_WORLD;
  /** The haze thickening last given to `landing.setHaze`. */
  let haze = 0;
  const aim = createArcResult();
  /** True while `aim` holds this frame's trace. */
  let aimActive = false;
  /**
   * Set by a flight toggle: an aim held across it counts for nothing until it is released, so
   * holding T (or the stick) through leaving flight neither draws the arc nor teleports.
   */
  let aimBlocked = false;
  const blink = createBlink();
  /** The landing a running blink jumps to at full black. */
  const pending: [number, number, number] = [0, 0, 0];
  let lastTeleport: TeleportRecord | null = null;
  /** Discontinuous moves so far (`discontinuities`). */
  let discontinuities = 0;
  const aimOrigin: [number, number, number] = [0, 0, 0];
  const aimDirection: [number, number, number] = [0, 0, 0];
  const eye: [number, number, number] = [0, 0, 0];
  const scratch = new Vector3();
  const head = { x: 0, y: 0, z: 0, yaw: 0 };
  /** The head's pitch, radians, positive up: flight flies along it. */
  let headPitch = 0;
  const euler = new Euler(0, 0, 0, 'YXZ');
  let presenting = false;
  /** Presenting frames this session. The first still shows the pose from before the session. */
  let xrFrames = 0;
  let calibrated = false;
  const rigDiag: RigDiag = {
    position: [0, 0, 0],
    yaw: 0,
    mode: 'walk',
    altitude: 0,
    haze: 0,
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
    euler.setFromQuaternion(camera.quaternion, 'YXZ');
    head.yaw = euler.y;
    headPitch = euler.x;
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
    discontinuities += 1;
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
   * ground (a world loading) there is no aim. `allowed` is false in flight and during the exit
   * drop: no aim and no commit then.
   */
  function teleport(
    actions: FrameActions,
    aiming: boolean,
    allowed: boolean,
    isPresenting: boolean,
  ): void {
    const aimed = aimActive;
    aimActive = false;
    if (blink.active) {
      if (stepBlink(blink, actions.dt)) jump(pending);
    } else if (actions.teleportCommit && allowed) {
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

  /**
   * The flight toggle. Ignored while a world loads (no ground to fly over or drop onto) and while
   * a teleport blink runs, so the jump it is fading toward still lands on a walking rig.
   */
  function toggleFlight(): void {
    if (ground === null || blink.active) return;
    aimBlocked = true;
    if (state.mode === 'walk') {
      enterFlight(state);
      aimActive = false;
      arc?.hide();
    } else {
      exitFlight(state);
    }
  }

  /** Binds `next`, handing the outgoing world's haze back as built. */
  function bindLanding(next: LocomotionWorld): void {
    if (haze !== 0) landing.setHaze?.(0);
    haze = 0;
    landing = next;
  }

  /** Eases the haze thickening toward its target and hands it to the world when it changes. */
  function easeHaze(dt: number): void {
    const target = state.mode === 'fly' ? boundaryExcess(state.boundary) : 0;
    const t = dt > 0 ? Math.min(dt, MAX_DT) : 0;
    let next = haze + (target - haze) * (1 - Math.exp(-t / HAZE_TAU));
    if (next < HAZE_REST && target < HAZE_REST) next = 0;
    if (next !== haze) {
      haze = next;
      landing.setHaze?.(haze);
    }
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
      if (!actions.teleportAim) aimBlocked = false;
      // Teleport is a walk-mode action: this is the one check flight, its exit drop and an aim held
      // across a flight toggle gate it at.
      const allowed = state.mode === 'walk' && !state.dropping && !aimBlocked;
      const aiming = actions.teleportAim && allowed;
      // A held aim never turns the rig, even pushed diagonally across the snap threshold.
      if (turn(state, aiming ? NO_TURN : actions, settings, actions.dt, head)) discontinuities += 1;
      if (state.mode === 'fly' && ground !== null) {
        fly(state, actions, ground, landing, settings, actions.dt, head, headPitch);
      } else {
        step(state, actions, ground, settings, actions.dt, head);
      }
      // A placed pose (`__goghPose`, `?painter`) stays where it was put until the next movement.
      if (landing.walkBounds && !state.held) clampToWalkBounds(state, head, landing.walkBounds);
      teleport(actions, aiming, allowed, isPresenting);
      // The toggle takes effect from the next frame: the exit drop's 0.5 s starts at this one.
      if (actions.flightToggle) toggleFlight();
      writeRig();
      easeHaze(actions.dt);
      // XR only: the desktop preview and its captures never show the vignette, even fading out.
      vignetteAlpha = isPresenting
        ? easeVignette(
            vignetteAlpha,
            settings.vignette *
              comfortFactor(Math.max(state.speed, state.pushSpeed), state.turnRate, settings),
            actions.dt,
          )
        : 0;
      vignette?.setAlpha(vignetteAlpha);
      // The desktop jumps at once, so its blink never shows.
      vignette?.setFade(isPresenting ? blink.fade : 0);
    },
    setGround(next) {
      ground = next ?? FLAT_GROUND;
      bindLanding(
        next
          ? { ground: { heightAt: (x, z) => next.heightAt(x, z), normalAt: () => LEVEL } }
          : FLAT_WORLD,
      );
    },
    setWorld(world) {
      ground = world?.ground ?? FLAT_GROUND;
      bindLanding(world ?? FLAT_WORLD);
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
      discontinuities += 1;
    },
    setPose(x, y, z, yaw, pitch) {
      cancelTeleport();
      placeRig(state, x, y - EYE_HEIGHT, z, yaw);
      look.setLook(0, pitch);
      look.update();
      writeRig();
      discontinuities += 1;
    },
    discontinuities: () => discontinuities,
    markDiscontinuity() {
      discontinuities += 1;
    },
    setSettings(next) {
      if (next.seated !== settings.seated || next.standingHeight !== settings.standingHeight) {
        calibrated = false;
      }
      settings = next;
    },
    faceYaw(yaw) {
      readHead();
      turnAboutHead(state, head, yaw - (state.yaw + head.yaw));
      writeRig();
      discontinuities += 1;
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
      rigDiag.mode = state.mode;
      rigDiag.altitude = state.altitude;
      rigDiag.haze = haze;
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
