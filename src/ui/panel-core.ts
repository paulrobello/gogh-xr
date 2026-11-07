/**
 * The settings panel's interaction core (P5.3), pure three math with no rendering, after
 * ~/.claude/guides/webxr.md: per-controller rays that stop at the nearest hit, grip to grab and
 * trigger to operate, two-hand scaling bounded to 0.5-1.8, and handoffs without a jump.
 *
 * Everything is in rig-local space: the controller target-ray spaces and the panel root are both
 * rig children, so the panel travels with locomotion and no world matrix is needed. A ray is a
 * controller's -Z.
 *
 * The contract: grip never activates a control; grip on the panel grabs it. The trigger operates
 * the control under the ray, and a trigger pressed on the panel is the panel's until released.
 * A hand the panel holds is `claimed`, so main.ts takes it out of the action frame.
 *
 * A one-hand grab also takes that hand's stick, per the guide's controller contract: grip + stick
 * X yaws the panel about its own Y, grip + stick Y pitches it about its own X (stick back, raw
 * gamepad +Y, is positive), grip + trigger + stick Y pushes it along the laser (forward is away)
 * and grip + trigger + stick X rolls it about the laser (right is positive about the forward
 * axis). Two hands ignore the sticks.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ButtonAction, Hand } from '../xr/input';
import { type ControlHit, hitControl, PANEL_H, PANEL_W } from './panel-layout';

export const MIN_PANEL_SCALE = 0.5;
export const MAX_PANEL_SCALE = 1.8;
/** Controls sit this far in front of the backing, metres at scale 1. */
export const CONTROL_Z = 0.004;
/** The laser's reach when it hits nothing, metres. */
export const LASER_RANGE = 3;
/** Stable hover before a tooltip shows, ms. */
export const TOOLTIP_DELAY_MS = 700;
/** Grip + stick yaw, pitch and roll at full stick, rad/s. */
export const STICK_TURN_RATE = Math.PI / 2;
/** Grip + trigger + stick push and pull at full stick, m/s. */
export const STICK_PUSH_RATE = 1;
/** Push and pull keep the panel this far along the laser from the controller, metres. */
export const MIN_PUSH_DEPTH = 0.15;
export const MAX_PUSH_DEPTH = 2.5;
/** The longest frame the stick rates integrate over, seconds. */
const MAX_STICK_DT = 0.1;

export function clampPanelScale(scale: number): number {
  return Number.isFinite(scale) ? Math.min(MAX_PANEL_SCALE, Math.max(MIN_PANEL_SCALE, scale)) : 1;
}

export interface PanelPose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  scale: number;
}

export function createPanelPose(): PanelPose {
  return { position: new Vector3(), quaternion: new Quaternion(), scale: 1 };
}

export interface PanelHit {
  /** Along the ray from its origin, rig-local metres. */
  readonly distance: number;
  /** The contact point, rig-local. */
  readonly point: Vector3;
  /** Panel-local x and y, metres at scale 1. */
  readonly x: number;
  readonly y: number;
  /** The control under the contact, or null on the bare backing. */
  readonly control: ControlHit | null;
}

const inverse = new Matrix4();
const matrix = new Matrix4();
const scaleVec = new Vector3();
const localOrigin = new Vector3();
const localEnd = new Vector3();

/** The ray in panel-local space: origin, and the point one rig metre along it. */
function toLocal(origin: Vector3, direction: Vector3, pose: PanelPose): void {
  scaleVec.setScalar(pose.scale);
  matrix.compose(pose.position, pose.quaternion, scaleVec);
  inverse.copy(matrix).invert();
  localOrigin.copy(origin).applyMatrix4(inverse);
  localEnd.copy(origin).add(direction).applyMatrix4(inverse);
}

/**
 * Every surface the ray meets, nearest first: the controls (front only, `CONTROL_Z` proud of the
 * backing) and the backing (both sides, a grab surface). Hits behind the ray origin never count.
 * `direction` must be a unit vector; the distances are then rig-local metres.
 */
export function rayHits(origin: Vector3, direction: Vector3, pose: PanelPose): PanelHit[] {
  toLocal(origin, direction, pose);
  const dz = localEnd.z - localOrigin.z;
  const hits: PanelHit[] = [];
  if (dz === 0) return hits;
  const at = (z: number): { t: number; x: number; y: number } => {
    const t = (z - localOrigin.z) / dz;
    return {
      t,
      x: localOrigin.x + (localEnd.x - localOrigin.x) * t,
      y: localOrigin.y + (localEnd.y - localOrigin.y) * t,
    };
  };
  const point = (t: number): Vector3 => direction.clone().multiplyScalar(t).add(origin);
  if (dz < 0) {
    const c = at(CONTROL_Z);
    const control = c.t > 0 ? hitControl(c.x, c.y) : null;
    if (control) hits.push({ distance: c.t, point: point(c.t), x: c.x, y: c.y, control });
  }
  const b = at(0);
  if (b.t > 0 && Math.abs(b.x) <= PANEL_W / 2 && Math.abs(b.y) <= PANEL_H / 2) {
    hits.push({ distance: b.t, point: point(b.t), x: b.x, y: b.y, control: null });
  }
  return hits.sort((p, q) => p.distance - q.distance);
}

/** A reusable hit for `nearestHit`, so a frame's ray test allocates no vectors. */
export interface PanelHitScratch {
  distance: number;
  point: Vector3;
  x: number;
  y: number;
  control: ControlHit | null;
}

export function createHitScratch(): PanelHitScratch {
  return { distance: 0, point: new Vector3(), x: 0, y: 0, control: null };
}

/**
 * The nearest hit, which the laser stops at and the contact marker sits on: `rayHits`' first,
 * written into `out`. From the front the control plane is nearer than the backing, and from
 * behind only the backing counts, so no sort is needed.
 */
export function nearestHit(
  origin: Vector3,
  direction: Vector3,
  pose: PanelPose,
  out: PanelHitScratch = createHitScratch(),
): PanelHit | null {
  toLocal(origin, direction, pose);
  const dz = localEnd.z - localOrigin.z;
  if (dz === 0) return null;
  if (dz < 0) {
    const t = (CONTROL_Z - localOrigin.z) / dz;
    if (t > 0) {
      const x = localOrigin.x + (localEnd.x - localOrigin.x) * t;
      const y = localOrigin.y + (localEnd.y - localOrigin.y) * t;
      const control = hitControl(x, y);
      if (control) return writeHit(out, origin, direction, t, x, y, control);
    }
  }
  const t = -localOrigin.z / dz;
  const x = localOrigin.x + (localEnd.x - localOrigin.x) * t;
  const y = localOrigin.y + (localEnd.y - localOrigin.y) * t;
  if (t > 0 && Math.abs(x) <= PANEL_W / 2 && Math.abs(y) <= PANEL_H / 2) {
    return writeHit(out, origin, direction, t, x, y, null);
  }
  return null;
}

function writeHit(
  out: PanelHitScratch,
  origin: Vector3,
  direction: Vector3,
  t: number,
  x: number,
  y: number,
  control: ControlHit | null,
): PanelHit {
  out.distance = t;
  out.point.copy(direction).multiplyScalar(t).add(origin);
  out.x = x;
  out.y = y;
  out.control = control;
  return out;
}

/** Panel-local x where the ray meets the panel's control plane, for a slider drag. */
export function planeX(origin: Vector3, direction: Vector3, pose: PanelPose): number | null {
  toLocal(origin, direction, pose);
  const dz = localEnd.z - localOrigin.z;
  if (dz === 0) return null;
  const t = (CONTROL_Z - localOrigin.z) / dz;
  return t > 0 ? localOrigin.x + (localEnd.x - localOrigin.x) * t : null;
}

/** One controller this frame, rig-local. */
export interface HandInput {
  /** The target-ray origin and unit -Z direction. */
  readonly origin: Vector3;
  readonly direction: Vector3;
  /** The controller pose the grab follows (the target-ray space's own). */
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly trigger: ButtonAction;
  readonly grip: ButtonAction;
  /** That controller's stick after the deadzone: x right, y forward. Absent means centred. */
  readonly stick?: { readonly x: number; readonly y: number };
}

export interface PanelCallbacks {
  /** A trigger press on a control. */
  press(hit: ControlHit, hand: Hand): void;
  /** The drag of a slider pressed with `hand`, at panel-local x. */
  drag(id: string, x: number, hand: Hand): void;
  /** The trigger that pressed `id` was released, or a grip cancelled it. */
  release(id: string, hand: Hand): void;
  /** A grab ended with no grip left on the panel: save the pose. */
  grabEnd(): void;
}

export interface HandState {
  hit: PanelHit | null;
  /** The control under the ray, while the hand neither grabs nor presses elsewhere. */
  hover: string | null;
  hoverSince: number;
  /** Holding the panel with grip. */
  grabbing: boolean;
  /** The trigger went down on the panel and is still held. */
  pressing: boolean;
  /** The control that press started on, or null on the backing. */
  pressed: string | null;
}

export interface PanelFrame {
  readonly claimed: Record<Hand, boolean>;
  readonly hands: Record<Hand, HandState>;
  /** The control whose tooltip shows, or null. */
  readonly tooltip: string | null;
  readonly grabbing: boolean;
}

export interface PanelInteraction {
  /** One frame. `pose` is the panel's, mutated by a grab. `hands` missing are untracked. */
  frame(hands: Partial<Record<Hand, HandInput>>, pose: PanelPose, now: number): PanelFrame;
  /** Drops every grab and press without callbacks (close, disposal, XR exit). */
  reset(): void;
}

function emptyHand(): HandState {
  return {
    hit: null,
    hover: null,
    hoverSince: 0,
    grabbing: false,
    pressing: false,
    pressed: null,
  };
}

const HANDS: readonly Hand[] = ['left', 'right'];

export function createPanelInteraction(callbacks: PanelCallbacks): PanelInteraction {
  const state: Record<Hand, HandState> = { left: emptyHand(), right: emptyHand() };
  const hitScratch: Record<Hand, PanelHitScratch> = {
    left: createHitScratch(),
    right: createHitScratch(),
  };
  const claimed: Record<Hand, boolean> = { left: false, right: false };
  /** One-hand grab: the panel pose in the holding controller's frame. */
  const offset = { position: new Vector3(), quaternion: new Quaternion() };
  /** Two-hand grab anchors. */
  const two = {
    mid: new Vector3(),
    span: new Vector3(),
    distance: 1,
    scale: 1,
    position: new Vector3(),
    quaternion: new Quaternion(),
  };
  let grabbers = 0;
  const inverseQ = new Quaternion();
  const v = new Vector3();
  const w = new Vector3();
  const turn = new Quaternion();
  const LASER = new Vector3(0, 0, -1);
  const AXIS_X = new Vector3(1, 0, 0);
  const AXIS_Y = new Vector3(0, 1, 0);
  let lastNow: number | null = null;

  /**
   * The one-hand stick gestures, applied to the grab offset (the panel in the controller's frame,
   * where the laser is -Z), so the follow below carries them.
   */
  function stickOne(hand: HandInput, dt: number): void {
    const stick = hand.stick;
    if (!stick || dt <= 0 || (stick.x === 0 && stick.y === 0)) return;
    if (hand.trigger.down) {
      // Push along the laser, never past the depth bounds (a depth already outside stays put).
      const depth = -offset.position.z;
      const next = depth + stick.y * STICK_PUSH_RATE * dt;
      const low = Math.min(depth, MIN_PUSH_DEPTH);
      const high = Math.max(depth, MAX_PUSH_DEPTH);
      offset.position.z = -Math.min(high, Math.max(low, next));
      // Roll about the laser through the controller: right is positive about the forward axis.
      turn.setFromAxisAngle(LASER, stick.x * STICK_TURN_RATE * dt);
      offset.position.applyQuaternion(turn);
      offset.quaternion.premultiply(turn);
      return;
    }
    // Yaw and pitch about the panel's own axes, through its centre.
    turn.setFromAxisAngle(AXIS_Y, stick.x * STICK_TURN_RATE * dt);
    offset.quaternion.multiply(turn);
    turn.setFromAxisAngle(AXIS_X, -stick.y * STICK_TURN_RATE * dt);
    offset.quaternion.multiply(turn);
  }

  function rebaseOne(hand: HandInput, pose: PanelPose): void {
    inverseQ.copy(hand.quaternion).invert();
    offset.position.copy(pose.position).sub(hand.position).applyQuaternion(inverseQ);
    offset.quaternion.copy(inverseQ).multiply(pose.quaternion);
  }

  function rebaseTwo(left: HandInput, right: HandInput, pose: PanelPose): void {
    two.mid.copy(left.position).add(right.position).multiplyScalar(0.5);
    two.span.copy(right.position).sub(left.position);
    two.distance = Math.max(1e-4, two.span.length());
    two.span.normalize();
    two.scale = pose.scale;
    two.position.copy(pose.position);
    two.quaternion.copy(pose.quaternion);
  }

  function followOne(hand: HandInput, pose: PanelPose): void {
    pose.position.copy(offset.position).applyQuaternion(hand.quaternion).add(hand.position);
    pose.quaternion.copy(hand.quaternion).multiply(offset.quaternion);
  }

  function followTwo(left: HandInput, right: HandInput, pose: PanelPose): void {
    v.copy(right.position).sub(left.position);
    const distance = Math.max(1e-4, v.length());
    v.normalize();
    const scale = clampPanelScale((two.scale * distance) / two.distance);
    const ratio = scale / two.scale;
    turn.setFromUnitVectors(two.span, v);
    w.copy(left.position).add(right.position).multiplyScalar(0.5);
    pose.position
      .copy(two.position)
      .sub(two.mid)
      .multiplyScalar(ratio)
      .applyQuaternion(turn)
      .add(w);
    pose.quaternion.copy(turn).multiply(two.quaternion);
    pose.scale = scale;
  }

  function endPress(hand: Hand, notify: boolean): void {
    const s = state[hand];
    if (notify && s.pressed) callbacks.release(s.pressed, hand);
    s.pressing = false;
    s.pressed = null;
  }

  return {
    frame(hands, pose, now) {
      const dt = lastNow === null ? 0 : Math.min(MAX_STICK_DT, Math.max(0, (now - lastNow) / 1000));
      lastNow = now;
      const before = grabbers;
      // Grips first: a grip ends a press on that hand before the trigger is looked at.
      for (const name of HANDS) {
        const hand = hands[name];
        const s = state[name];
        if (!hand) {
          if (s.pressing) endPress(name, true);
          s.grabbing = false;
          s.hit = null;
          s.hover = null;
          continue;
        }
        s.hit = nearestHit(hand.origin, hand.direction, pose, hitScratch[name]);
        if (!hand.grip.down) s.grabbing = false;
        if (hand.grip.fired && s.hit) {
          // Grip never activates a control, and it cancels a drag in progress.
          if (s.pressing) endPress(name, true);
          s.grabbing = true;
        }
      }
      grabbers = (state.left.grabbing ? 1 : 0) + (state.right.grabbing ? 1 : 0);
      const left = hands.left;
      const right = hands.right;
      if (grabbers !== before || grabbers === 0) {
        // A change in who holds the panel rebases from its current pose, so nothing jumps.
        if (grabbers === 2 && left && right) rebaseTwo(left, right, pose);
        else if (grabbers === 1) {
          const holder = state.left.grabbing ? left : right;
          if (holder) rebaseOne(holder, pose);
        }
      }
      if (grabbers === 2 && left && right) followTwo(left, right, pose);
      else if (grabbers === 1) {
        const holder = state.left.grabbing ? left : right;
        if (holder) {
          // Not on the grab's first frame: the rebase above just set the offset.
          if (grabbers === before) stickOne(holder, dt);
          followOne(holder, pose);
        }
      }
      if (before > 0 && grabbers === 0) callbacks.grabEnd();

      for (const name of HANDS) {
        const hand = hands[name];
        const s = state[name];
        if (!hand) {
          claimed[name] = false;
          continue;
        }
        // The pose may have moved this frame: re-aim before pressing.
        if (grabbers > 0) s.hit = nearestHit(hand.origin, hand.direction, pose, hitScratch[name]);
        if (s.pressing && !hand.trigger.down) endPress(name, true);
        if (hand.trigger.fired && !hand.grip.down && !s.grabbing && s.hit) {
          s.pressing = true;
          s.pressed = s.hit.control?.id ?? null;
          if (s.hit.control) callbacks.press(s.hit.control, name);
        } else if (s.pressing && s.pressed) {
          const x = planeX(hand.origin, hand.direction, pose);
          if (x !== null) callbacks.drag(s.pressed, x, name);
        }
        const hover =
          s.grabbing || hand.grip.down || (s.pressing && s.pressed === null)
            ? null
            : (s.hit?.control?.id ?? null);
        if (hover !== s.hover) s.hoverSince = now;
        s.hover = hover;
        claimed[name] = s.grabbing || s.pressing;
      }

      let tooltip: string | null = null;
      if (grabbers === 0) {
        let since = Number.POSITIVE_INFINITY;
        for (const name of HANDS) {
          const s = state[name];
          if (s.hover && !s.pressing && now - s.hoverSince >= TOOLTIP_DELAY_MS) {
            // The hand that has been on its control longest wins.
            if (s.hoverSince < since) {
              since = s.hoverSince;
              tooltip = s.hover;
            }
          }
        }
      }
      return { claimed, hands: state, tooltip, grabbing: grabbers > 0 };
    },
    reset() {
      for (const name of HANDS) {
        state[name] = emptyHand();
        claimed[name] = false;
      }
      grabbers = 0;
      lastNow = null;
    },
  };
}
