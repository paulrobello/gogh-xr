import { Euler, type Object3D, Quaternion, Vector3 } from 'three';
import { type LandingWorld, landingReason } from '../locomotion/teleport';
import type { Vec3 } from '../render/strokes/frame';
import type { PainterCamera, WorldPose } from './world-module';

export const PAINTER_MATCH_THRESHOLD = 90;
// Starry Night's village sits ahead of the painter. This strip is past its houses,
// just inside the boundary haze. The landing check handles the church and terrain.
const START_DEPTH = 43;
const START_DEPTH_RANGE = 1;
const START_HALF_WIDTH = 8;
const MAX_SAMPLES = 64;
const POSITION_RANGE = 10;
const ANGLE_RANGE = Math.PI / 2;
// Matrix decomposition and acos can leave a small error at the exact target pose.
const MATCH_EPSILON = 1e-7;
const HINT_UPDATE_MS = 250;
const FOUND_DISPLAY_MS = 4000;

/** Sample the far side of the village with the same landing checks as teleport. */
export function findPainterStart(
  spot: WorldPose,
  world: LandingWorld,
  random: () => number = Math.random,
): WorldPose | null {
  const sin = Math.sin(spot.yaw);
  const cos = Math.cos(spot.yaw);
  for (let i = 0; i < MAX_SAMPLES; i += 1) {
    const across = (2 * random() - 1) * START_HALF_WIDTH;
    const depth = START_DEPTH + random() * START_DEPTH_RANGE;
    const x = spot.position[0] + across * cos - depth * sin;
    const z = spot.position[2] - across * sin - depth * cos;
    const y = world.ground.heightAt(x, z);
    if (!Number.isFinite(y)) continue;
    const position: Vec3 = [x, y, z];
    if (landingReason(world, position, world.ground.normalAt(x, z)) === 'ok') {
      return { position, yaw: spot.yaw + Math.PI };
    }
  }
  return null;
}

export interface PainterSpotDisplay {
  readonly text: string;
  readonly reference: boolean;
}

const FOUND: PainterSpotDisplay = { text: 'You found the painter’s spot', reference: false };

export interface PainterSpotRound {
  readonly match: number;
  readonly found: boolean;
  readonly hint: boolean;
  toggleHint(): void;
  frame(camera: Object3D, now: number): PainterSpotDisplay | null;
}

/**
 * Compare the rendered head pose against the authored canvas camera. Ten metres and 90° are
 * the full error ranges. Euclidean combination makes position and orientation both matter.
 */
export function createPainterSpotRound(view: PainterCamera, threshold: number): PainterSpotRound {
  const eye = new Vector3(...view.eye);
  const orientation = new Quaternion().setFromEuler(new Euler(view.pitch, view.yaw, 0, 'YXZ'));
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  const forward = new Vector3();
  let match = 0;
  let foundAt: number | null = null;
  let hint = false;
  let nextHint = 0;
  let display: PainterSpotDisplay | null = null;

  function direction(): string {
    const x = eye.x - position.x;
    const z = eye.z - position.z;
    const distance = Math.hypot(x, z);
    if (distance <= 1) return 'Line up your view with the painting';
    forward.set(0, 0, -1).applyQuaternion(rotation);
    if (Math.hypot(forward.x, forward.z) < 0.1) return 'Look toward the horizon';
    const angle = Math.atan2(forward.x * z - forward.z * x, forward.x * x + forward.z * z);
    const meters = Math.round(distance);
    if (Math.abs(angle) < Math.PI / 8) return `${meters} m ahead`;
    if (Math.abs(angle) > (7 * Math.PI) / 8) return `${meters} m behind you`;
    return `${meters} m to your ${angle > 0 ? 'right' : 'left'}`;
  }

  return {
    get match() {
      return match;
    },
    get found() {
      return foundAt !== null;
    },
    get hint() {
      return hint;
    },
    toggleHint() {
      if (foundAt !== null) return;
      hint = !hint;
      display = null;
      nextHint = 0;
    },
    frame(camera, now) {
      if (foundAt !== null) return now - foundAt < FOUND_DISPLAY_MS ? FOUND : null;
      camera.matrixWorld.decompose(position, rotation, scale);
      const error = Math.hypot(
        eye.distanceTo(position) / POSITION_RANGE,
        rotation.angleTo(orientation) / ANGLE_RANGE,
      );
      match = error < MATCH_EPSILON ? 100 : Math.max(0, 100 * (1 - error));
      if (match >= threshold) {
        hint = false;
        foundAt = now;
        return FOUND;
      }
      if (hint && now >= nextHint) {
        display = { text: `${Math.floor(match)}% match\n${direction()}`, reference: true };
        nextHint = now + HINT_UPDATE_MS;
      }
      return display;
    },
  };
}
