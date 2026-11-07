/**
 * Reactive strokes (P4.5): strokes make way around the viewer's head and hands, on every layer.
 *
 * Disturbers. Three per frame: the head, then controller slots 0 and 1 (`REACTIVE_DISTURBERS`),
 * world positions, each with its velocity from the last frame. The desktop has the eye only: the
 * controller slots carry strength 0 there. The head pushes at `HEAD_STRENGTH`, under half the
 * hands' `HAND_STRENGTH`, so strokes round the viewer's own face move gently (comfort).
 *
 * Velocity is relative to the locomotion rig (ruling Q41: walking or flying must not push
 * strokes, only physical motion does). `frame` is given the rig's world matrix, and a disturber's
 * velocity is the rate of change of its rig-local position, rotated back into world space by the
 * current rig rotation. Stick walking, flight, smooth and snap turns and teleport move the rig, not
 * the rig-local position, so they add nothing. The rig is a rotation and translation (scale 1).
 * Positions stay world: the static push, the wake sample positions and the box use them, so
 * strokes still part round a hand held near a wall as the rig glides past, and a hand waved while
 * walking leaves its wake where it was waved. On the desktop the eye is fixed in the rig, so its
 * velocity is always 0 and WASD leaves no wake.
 *
 * Wake. Each disturber keeps a CPU history of `WAKE_SAMPLES` positions about `WAKE_INTERVAL_S`
 * (150 ms) apart, so the window, WAKE_SAMPLES × WAKE_INTERVAL_S = 1.2 s, spans the plan's 1.2 s
 * decay. A sample's weight is its disturber's strength times its speed when it was taken over
 * `WAKE_REF_SPEED` (capped at 1), times a fade-in over its first `WAKE_FADE_IN_S` (60 ms, so the
 * newest segment appears at once rather than over a whole interval), times `wakeDecay(age)`:
 * exp(−age / WAKE_DECAY_S), tapered to exactly 0 over the last quarter of the window (0.9-1.2 s,
 * from a weight of about 0.47), so every sample lands on weight 0 before it is evicted and nothing
 * snaps. A still hand leaves no wake.
 *
 * Discontinuities. `frame` takes locomotion's discontinuity count (a teleport jump, a snap turn, a
 * spawn, a placed pose, an XR reference-space reset): when it changes, every disturber's history
 * and velocity restart from the new pose, so no wake or drag is drawn across the jump. Rig-relative
 * velocity already gives a teleport or a snap turn none, so this is the backstop for them and the
 * only guard for a reference-space reset, which moves the disturbers inside the rig. A rig-relative
 * step faster than `REACTIVE_JUMP_SPEED` (15 m/s) does the same for that disturber alone: a
 * backstop for a re-tracked controller, never reached by a hand.
 *
 * Displacement (the GLSL is `reactiveMotion` in motion.glsl; change the two together). With the
 * falloff f(x²) = (1 − x²)², x = distance / REACTIVE_RADIUS, zero beyond the radius:
 *   - push: strength × f × (PUSH_GAIN × (p − d) + DRAG_S × v) per disturber. The push is linear in
 *     p − d, so it is 0 at the disturber's own foot point and peaks at x = 1/√5. It stretches the
 *     surface round the hand, (1 + PUSH_GAIN)² in area at the foot point, which thins the strokes
 *     there; the stretch growth below grows them back over it. Its radial derivative is at least
 *     −0.8 × PUSH_GAIN, so the map stays monotone while PUSH_GAIN < 1.25.
 *   - swirl: a rotation of the stroke about its own normal through each wake sample, by
 *     weight × REACTIVE_SWIRL × f, so strokes curl round the recent trail; the stroke turns by the
 *     same angle.
 * The sum loses its part along the stroke normal, so strokes slide along their surface rather than
 * leave it, and is clamped to `REACTIVE_REACH` (under the radius); the turn is capped at
 * `REACTIVE_MAX_TURN`. The gain is the stretch's growth below, never negative: a reactive push
 * never shrinks a stroke. Calm scales the offset and the turn in motionOffset. Nothing is stored per stroke: the displacement is a pure
 * function of the rest position and the current disturbers and wake (PRD D7), so displaced strokes
 * spring back as the wake decays and the hand leaves.
 *
 * Stretch. The push spreads the surface round the foot point: in the stroke's tangent plane its
 * Jacobian is a·I − M, a = Σ G s f², M = Σ 4 G s f / R² t tᵀ (t the tangent part of p − d), so a
 * patch's area grows by J = det(I + a·I − M) ≈ (1 + a)(1 + a − tr M) (exact for one disturber;
 * the dropped det M ≥ 0 only underestimates). Each stroke grows by √J − 1 (`gain`, capped at
 * `REACTIVE_MAX_GAIN`, never below 0), so the strokes a hand spreads apart still cover the surface
 * they slide over (ruling R-P4o). Calm scales a and M, since it scales the push.
 *
 * Box. Each frame the CPU sends the axis-aligned box round every weighted disturber and wake
 * sample, grown by the radius, as `uReactiveCentre` and `uReactiveHalf`. A stroke whose rest centre
 * is outside it gets exactly 0 from the full function, so the shader tests the box once and skips
 * the loops (ruling R-P4c). No disturber leaves the box empty (half −1).
 *
 * Space. The disturbers are world positions and the shader reads the instance's model-space
 * `iPosition`: every stroke batch group and chunk mesh sits at the identity (batch.ts), which a
 * unit test pins.
 */
import { Vector3, Vector4 } from 'three';

type Vec3 = readonly [number, number, number];

/** Metres: the push and the swirl fall off to 0 at this distance. */
export const REACTIVE_RADIUS: number = 0.6;
/** The head, then controller slots 0 and 1. */
export const REACTIVE_DISTURBERS: number = 3;
/** Wake samples per disturber. */
export const WAKE_SAMPLES: number = 8;
/** Seconds between wake samples. */
export const WAKE_INTERVAL_S: number = 0.15;
/** Seconds: a new wake sample fades in over this, independent of the interval. */
export const WAKE_FADE_IN_S: number = 0.06;
/** Seconds: a sample is evicted at the latest this old, and its weight is 0 from here on. */
export const WAKE_WINDOW_S: number = WAKE_SAMPLES * WAKE_INTERVAL_S;
/** The wake's exponential time constant, seconds (the plan's "about 1.2 s"). */
export const WAKE_DECAY_S: number = 1.2;
/** The share of the window after which the weight tapers to 0. */
export const WAKE_TAPER_START: number = 0.75;
/** m/s: a wake sample taken at this speed or faster has full weight. */
export const WAKE_REF_SPEED: number = 1.5;
/** m/s: the (rig-relative) velocity a disturber reports is clamped to this. */
export const REACTIVE_MAX_SPEED: number = 3;
/**
 * m/s: a frame-to-frame step faster than this is a jump, never a hand: the disturber's wake is
 * cleared and its velocity is 0. A backstop for a re-tracked controller: locomotion's
 * discontinuity count catches teleports, snap turns, spawns and placed poses explicitly.
 */
export const REACTIVE_JUMP_SPEED: number = 15;
/** The head's strength: gentler than the hands' (comfort). */
export const HEAD_STRENGTH: number = 0.4;
/** A controller's strength. */
export const HAND_STRENGTH: number = 1;
/** Disturber strengths in slot order. */
export const DISTURBER_STRENGTHS: readonly number[] = Object.freeze([
  HEAD_STRENGTH,
  HAND_STRENGTH,
  HAND_STRENGTH,
]);
/**
 * The push per metre of `p − d` at the disturber: x(1 − x²)² peaks at 0.286, so a hand pushes a
 * stroke at most 0.286 × 0.6 × 0.6 m = 0.103 m and the head 0.041 m.
 */
export const REACTIVE_PUSH_GAIN: number = 0.6;
/** Seconds: a moving disturber drags nearby strokes by its velocity times this. */
export const REACTIVE_DRAG_S: number = 0.04;
/** Radians: the swirl's angle per wake sample at full weight and zero distance. */
export const REACTIVE_SWIRL: number = 0.12;
/** Metres: the reactive offset is clamped to this, under the radius. Also the cull reach. */
export const REACTIVE_REACH: number = 0.25;
/** Radians: the largest reactive turn. */
export const REACTIVE_MAX_TURN: number = 0.5;
/**
 * The largest stretch growth, as a size gain: strokes grow to at most 2× (one hand at the surface
 * needs (1 + PUSH_GAIN) = 1.6×). The stroke batch's cull spheres include it (batch.ts).
 */
export const REACTIVE_MAX_GAIN: number = 1;

/** One disturber as the shader reads it. */
export interface Disturber {
  readonly position: Vec3;
  readonly velocity: Vec3;
  /** 0 when untracked or parked. */
  readonly strength: number;
}

/** One wake sample as the shader reads it. */
export interface WakeSample {
  readonly position: Vec3;
  readonly weight: number;
}

/** What `reactiveMotion` reads: `REACTIVE_DISTURBERS` disturbers and their wake, slot-major. */
export interface ReactiveField {
  readonly disturbers: readonly Disturber[];
  readonly wake: readonly WakeSample[];
}

/** The reactive part of a stroke's motion, before calm. */
export interface ReactiveMotion {
  readonly offset: Vec3;
  readonly turn: number;
  readonly gain: number;
  readonly bright: number;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The falloff at squared normalised distance `x2`: (1 − x²)², 0 from the radius on. */
export function reactiveFalloff(x2: number): number {
  const f = Math.max(1 - x2, 0);
  return f * f;
}

/**
 * The wake's decay at sample age `age` seconds: exp(−age / WAKE_DECAY_S), tapered smoothly to 0
 * over the last quarter of the window. Monotone non-increasing, 1 at 0, 0 from WAKE_WINDOW_S on.
 */
export function wakeDecay(age: number): number {
  if (age <= 0) return 1;
  return (
    Math.exp(-age / WAKE_DECAY_S) *
    (1 - smoothstep(WAKE_TAPER_START * WAKE_WINDOW_S, WAKE_WINDOW_S, age))
  );
}

/** A new sample's fade-in over its first WAKE_FADE_IN_S, so it never pops in at full weight. */
export function wakeFadeIn(age: number): number {
  return smoothstep(0, WAKE_FADE_IN_S, age);
}

/** A sample's weight: strength × capped speed share × fade-in × decay, in [0, strength]. */
export function wakeWeight(age: number, speed: number, strength: number): number {
  const share = Math.min(Math.max(speed, 0) / WAKE_REF_SPEED, 1);
  return strength * share * wakeFadeIn(age) * wakeDecay(age);
}

const INV_R2 = 1 / (REACTIVE_RADIUS * REACTIVE_RADIUS);

/**
 * The reactive motion of the stroke at rest centre `p` with unit normal `normal`: its offset and
 * turn before calm, and its stretch growth at `calm` (calm scales the push it compensates, and
 * motionOffset leaves gains unscaled). Matches reactiveMotion in motion.glsl.
 */
export function reactiveMotion(
  p: Vec3,
  normal: Vec3,
  field: ReactiveField,
  calm: number = 1,
): ReactiveMotion {
  const [px, py, pz] = p;
  const [nx, ny, nz] = normal;
  let ox = 0;
  let oy = 0;
  let oz = 0;
  let spread = 0;
  let squeeze = 0;
  for (const d of field.disturbers) {
    const dx = px - d.position[0];
    const dy = py - d.position[1];
    const dz = pz - d.position[2];
    const e2 = dx * dx + dy * dy + dz * dz;
    const f = Math.max(1 - e2 * INV_R2, 0);
    const sf = d.strength * f;
    const s = sf * f;
    ox += s * (REACTIVE_PUSH_GAIN * dx + REACTIVE_DRAG_S * d.velocity[0]);
    oy += s * (REACTIVE_PUSH_GAIN * dy + REACTIVE_DRAG_S * d.velocity[1]);
    oz += s * (REACTIVE_PUSH_GAIN * dz + REACTIVE_DRAG_S * d.velocity[2]);
    const en = nx * dx + ny * dy + nz * dz;
    spread += s;
    squeeze += sf * (e2 - en * en);
  }
  let ax = 0;
  let ay = 0;
  let az = 0;
  let theta = 0;
  for (const w of field.wake) {
    const ex = px - w.position[0];
    const ey = py - w.position[1];
    const ez = pz - w.position[2];
    const t = w.weight * REACTIVE_SWIRL * reactiveFalloff((ex * ex + ey * ey + ez * ez) * INV_R2);
    ax += t * ex;
    ay += t * ey;
    az += t * ez;
    theta += t;
  }
  // A rotation by t about the normal through the sample moves p by t × (n × (p − w)).
  ox += ny * az - nz * ay;
  oy += nz * ax - nx * az;
  oz += nx * ay - ny * ax;
  const along = nx * ox + ny * oy + nz * oz;
  ox -= along * nx;
  oy -= along * ny;
  oz -= along * nz;
  const length2 = ox * ox + oy * oy + oz * oz;
  const k = Math.min(1, REACTIVE_REACH / Math.sqrt(Math.max(length2, 1e-12)));
  const a = calm * REACTIVE_PUSH_GAIN * spread;
  const m = calm * 4 * REACTIVE_PUSH_GAIN * INV_R2 * squeeze;
  const stretch = (1 + a) * (1 + a - m);
  return {
    offset: [k * ox, k * oy, k * oz],
    turn: Math.min(theta, REACTIVE_MAX_TURN),
    gain: Math.min(Math.sqrt(Math.max(stretch, 1)) - 1, REACTIVE_MAX_GAIN),
    bright: 0,
  };
}

/** The shader's reactive uniforms. Every stroke material shares one set by reference. */
export interface ReactiveUniforms {
  [name: string]: { value: unknown };
  /** Per disturber: world position xyz, strength w (0 when untracked). */
  uDisturbers: { value: Vector4[] };
  /** Per disturber: rig-relative velocity xyz in world axes, m/s, clamped; w unused. */
  uDisturberVelocities: { value: Vector4[] };
  /** Disturber j's wake samples at j × WAKE_SAMPLES + i, newest first: xyz, weight w. */
  uWake: { value: Vector4[] };
  /** The reactive box's centre, world. */
  uReactiveCentre: { value: Vector3 };
  /** The reactive box's half extents; negative when empty. */
  uReactiveHalf: { value: Vector3 };
}

export interface DisturberDiag {
  tracked: boolean;
  position: [number, number, number];
  velocity: [number, number, number];
  strength: number;
  /** Wake samples held. */
  wake: number;
  /** The sum of this disturber's wake weights in `uWake`, as the shader reads them. */
  wakeWeight: number;
  /**
   * The strongest single wake weight in `uWake`. Unlike the sum, it does not depend on how many
   * samples the frame timing has taken, so it compares sweeps across runs.
   */
  wakePeak: number;
  /** History resets on a step past REACTIVE_JUMP_SPEED since boot. */
  jumps: number;
}

export interface ReactiveDiag {
  /** Frames the tracker has run. */
  frames: number;
  /** The last discontinuity count `frame` read, and how many times it changed (history resets). */
  discontinuity: number;
  resets: number;
  disturbers: DisturberDiag[];
  /** The reactive box, world, or null when empty. */
  box: { min: [number, number, number]; max: [number, number, number] } | null;
}

export interface ReactiveTracker {
  readonly uniforms: ReactiveUniforms;
  /**
   * Updates the uniforms at animation-frame time `timeMs` from the disturbers' world positions in
   * slot order (head, controller 0, controller 1), null for an untracked one. `discontinuity` is
   * locomotion's count of discontinuous rig moves: a change restarts every history at this pose.
   * `rig` is the rig's world matrix elements (column-major, rotation and translation only), null
   * or omitted for the identity: velocities are taken relative to it.
   */
  frame(
    timeMs: number,
    positions: readonly (Vec3 | null)[],
    discontinuity?: number,
    rig?: ArrayLike<number> | null,
  ): void;
  /** The field the uniforms hold, as `reactiveMotion` reads it. */
  field(): ReactiveField;
  diag(): ReactiveDiag;
}

interface Sample {
  x: number;
  y: number;
  z: number;
  t: number;
  speed: number;
}

interface Track {
  tracked: boolean;
  position: [number, number, number];
  /** Rig-local position at the last frame. */
  local: [number, number, number];
  velocity: [number, number, number];
  lastMs: number | null;
  history: Sample[];
  lastPushMs: number;
  jumps: number;
}

const IDENTITY: readonly number[] = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function createReactiveTracker(): ReactiveTracker {
  const uniforms: ReactiveUniforms = {
    uDisturbers: { value: Array.from({ length: REACTIVE_DISTURBERS }, () => new Vector4()) },
    uDisturberVelocities: {
      value: Array.from({ length: REACTIVE_DISTURBERS }, () => new Vector4()),
    },
    uWake: {
      value: Array.from({ length: REACTIVE_DISTURBERS * WAKE_SAMPLES }, () => new Vector4()),
    },
    uReactiveCentre: { value: new Vector3() },
    uReactiveHalf: { value: new Vector3(-1, -1, -1) },
  };
  const tracks: Track[] = Array.from({ length: REACTIVE_DISTURBERS }, () => ({
    tracked: false,
    position: [0, 0, 0],
    local: [0, 0, 0],
    velocity: [0, 0, 0],
    lastMs: null,
    history: [],
    lastPushMs: 0,
    jumps: 0,
  }));
  let frames = 0;
  let discontinuity = 0;
  let resets = 0;
  let cachedField: ReactiveField | null = null;
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  let boxed = false;

  const include = (x: number, y: number, z: number): void => {
    if (!boxed) {
      min[0] = max[0] = x;
      min[1] = max[1] = y;
      min[2] = max[2] = z;
      boxed = true;
      return;
    }
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  };

  function step(track: Track, timeMs: number, pose: Vec3 | null, rig: ArrayLike<number>): void {
    if (pose === null) {
      track.tracked = false;
      track.velocity = [0, 0, 0];
      track.history.length = 0;
      track.lastMs = null;
      return;
    }
    const [x, y, z] = pose;
    // Rig-local position: Rᵀ (p − t) for the rig's rotation R and translation t.
    const rx = x - rig[12];
    const ry = y - rig[13];
    const rz = z - rig[14];
    const lx = rig[0] * rx + rig[1] * ry + rig[2] * rz;
    const ly = rig[4] * rx + rig[5] * ry + rig[6] * rz;
    const lz = rig[8] * rx + rig[9] * ry + rig[10] * rz;
    if (track.tracked && track.lastMs !== null && timeMs > track.lastMs) {
      const dt = (timeMs - track.lastMs) / 1000;
      const dx = (lx - track.local[0]) / dt;
      const dy = (ly - track.local[1]) / dt;
      const dz = (lz - track.local[2]) / dt;
      // Back into world axes with the current rig rotation.
      const vx = rig[0] * dx + rig[4] * dy + rig[8] * dz;
      const vy = rig[1] * dx + rig[5] * dy + rig[9] * dz;
      const vz = rig[2] * dx + rig[6] * dy + rig[10] * dz;
      const speed = Math.hypot(vx, vy, vz);
      if (speed > REACTIVE_JUMP_SPEED) {
        track.velocity = [0, 0, 0];
        track.history.length = 0;
        track.jumps += 1;
      } else {
        const k = speed > REACTIVE_MAX_SPEED ? REACTIVE_MAX_SPEED / speed : 1;
        track.velocity = [k * vx, k * vy, k * vz];
      }
    } else if (!track.tracked) {
      track.velocity = [0, 0, 0];
      track.history.length = 0;
    }
    track.tracked = true;
    track.position = [x, y, z];
    track.local = [lx, ly, lz];
    track.lastMs = timeMs;
    if (track.history.length === 0 || timeMs - track.lastPushMs >= WAKE_INTERVAL_S * 1000) {
      const [vx, vy, vz] = track.velocity;
      track.history.unshift({ x, y, z, t: timeMs, speed: Math.hypot(vx, vy, vz) });
      if (track.history.length > WAKE_SAMPLES) track.history.length = WAKE_SAMPLES;
      track.lastPushMs = timeMs;
    }
  }

  const tracker: ReactiveTracker = {
    uniforms,
    frame(timeMs, positions, epoch = discontinuity, rig) {
      const frameRig = rig ?? IDENTITY;
      frames += 1;
      cachedField = null;
      boxed = false;
      if (epoch !== discontinuity) {
        discontinuity = epoch;
        resets += 1;
        for (const track of tracks) {
          track.velocity = [0, 0, 0];
          track.history.length = 0;
          track.lastMs = null;
        }
      }
      for (let j = 0; j < REACTIVE_DISTURBERS; j++) {
        const track = tracks[j];
        step(track, timeMs, positions[j] ?? null, frameRig);
        const strength = track.tracked ? (DISTURBER_STRENGTHS[j] ?? 0) : 0;
        const [x, y, z] = track.position;
        uniforms.uDisturbers.value[j].set(x, y, z, strength);
        const [vx, vy, vz] = track.velocity;
        uniforms.uDisturberVelocities.value[j].set(vx, vy, vz, 0);
        if (strength > 0) include(x, y, z);
        for (let i = 0; i < WAKE_SAMPLES; i++) {
          const slot = uniforms.uWake.value[j * WAKE_SAMPLES + i];
          const sample = track.history[i];
          if (!sample || strength <= 0) {
            slot.set(x, y, z, 0);
            continue;
          }
          const weight = wakeWeight((timeMs - sample.t) / 1000, sample.speed, strength);
          slot.set(sample.x, sample.y, sample.z, weight);
          if (weight > 0) include(sample.x, sample.y, sample.z);
        }
      }
      const centre = uniforms.uReactiveCentre.value;
      const half = uniforms.uReactiveHalf.value;
      if (boxed) {
        centre.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
        half.set(
          (max[0] - min[0]) / 2 + REACTIVE_RADIUS,
          (max[1] - min[1]) / 2 + REACTIVE_RADIUS,
          (max[2] - min[2]) / 2 + REACTIVE_RADIUS,
        );
      } else {
        centre.set(0, 0, 0);
        half.set(-1, -1, -1);
      }
    },
    field() {
      if (cachedField) return cachedField;
      const vec = (v: Vector4): Vec3 => [v.x, v.y, v.z];
      cachedField = {
        disturbers: uniforms.uDisturbers.value.map((d, j) => ({
          position: vec(d),
          velocity: vec(uniforms.uDisturberVelocities.value[j]),
          strength: d.w,
        })),
        wake: uniforms.uWake.value.map((w) => ({ position: vec(w), weight: w.w })),
      };
      return cachedField;
    },
    diag() {
      const half = uniforms.uReactiveHalf.value;
      const centre = uniforms.uReactiveCentre.value;
      return {
        frames,
        discontinuity,
        resets,
        disturbers: tracks.map((track, j) => ({
          tracked: track.tracked,
          position: [...track.position],
          velocity: [...track.velocity],
          strength: uniforms.uDisturbers.value[j].w,
          wake: track.history.length,
          wakeWeight: uniforms.uWake.value
            .slice(j * WAKE_SAMPLES, (j + 1) * WAKE_SAMPLES)
            .reduce((sum, w) => sum + w.w, 0),
          wakePeak: uniforms.uWake.value
            .slice(j * WAKE_SAMPLES, (j + 1) * WAKE_SAMPLES)
            .reduce((peak, w) => Math.max(peak, w.w), 0),
          jumps: track.jumps,
        })),
        box:
          half.x < 0
            ? null
            : {
                min: [centre.x - half.x, centre.y - half.y, centre.z - half.z],
                max: [centre.x + half.x, centre.y + half.y, centre.z + half.z],
              },
      };
    },
  };
  return tracker;
}

/** True when `p` is inside the tracker's reactive box, as reactiveGate in motion.glsl tests it. */
export function insideReactiveBox(uniforms: ReactiveUniforms, p: Vec3): boolean {
  const c = uniforms.uReactiveCentre.value;
  const h = uniforms.uReactiveHalf.value;
  return Math.abs(p[0] - c.x) < h.x && Math.abs(p[1] - c.y) < h.y && Math.abs(p[2] - c.z) < h.z;
}

/** A GLSL float literal: always carries a decimal point or an exponent. */
const glslFloat = (value: number): string => value.toExponential(8);

/** The material defines reactiveMotion in motion.glsl reads. */
export function reactiveGlslDefines(): Record<string, string | number> {
  return {
    REACTIVE_DISTURBERS,
    REACTIVE_WAKE_SAMPLES: REACTIVE_DISTURBERS * WAKE_SAMPLES,
    REACTIVE_INV_RADIUS2: glslFloat(INV_R2),
    REACTIVE_PUSH_GAIN: glslFloat(REACTIVE_PUSH_GAIN),
    REACTIVE_DRAG_S: glslFloat(REACTIVE_DRAG_S),
    REACTIVE_SWIRL: glslFloat(REACTIVE_SWIRL),
    REACTIVE_REACH: glslFloat(REACTIVE_REACH),
    REACTIVE_MAX_TURN: glslFloat(REACTIVE_MAX_TURN),
    REACTIVE_MAX_GAIN: glslFloat(REACTIVE_MAX_GAIN),
    REACTIVE_STRETCH_M: glslFloat(4 * REACTIVE_PUSH_GAIN * INV_R2),
  };
}

/**
 * The app's one tracker, whose uniforms every stroke material shares. main.ts drives it; the
 * motion gate's reactive bit decides whether any stroke reads it.
 */
export const reactiveTracker: ReactiveTracker = createReactiveTracker();
