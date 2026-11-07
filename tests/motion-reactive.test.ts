import { readFileSync } from 'node:fs';
import {
  DataTexture,
  Matrix4,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  RGBAFormat,
  Scene,
  Texture,
  Vector3,
} from 'three';
import { describe, expect, test } from 'vitest';
import { installDesktopControls } from '../src/desktop/controls.ts';
import { createArcMesh } from '../src/locomotion/arc-mesh.ts';
import { createLocomotion, type FrameActions } from '../src/locomotion/locomotion.ts';
import { DEFAULT_LOCOMOTION_SETTINGS } from '../src/locomotion/settings.ts';
import { createMotionClock, motionClock } from '../src/motion/clock.ts';
import {
  LIVE_MOTION,
  MOTION_LAYER_MASK,
  type MotionFunctions,
  motionLayerMask,
  motionOffset,
  REACTIVE_MOTION_BIT,
  REST,
  reactiveReach,
  STUB_MOTION,
} from '../src/motion/motion.ts';
import {
  createReactiveTracker,
  DISTURBER_STRENGTHS,
  HAND_STRENGTH,
  HEAD_STRENGTH,
  insideReactiveBox,
  REACTIVE_DISTURBERS,
  REACTIVE_JUMP_SPEED,
  REACTIVE_MAX_GAIN,
  REACTIVE_MAX_SPEED,
  REACTIVE_MAX_TURN,
  REACTIVE_PUSH_GAIN,
  REACTIVE_RADIUS,
  REACTIVE_REACH,
  type ReactiveField,
  reactiveFalloff,
  reactiveMotion,
  reactiveTracker,
  WAKE_DECAY_S,
  WAKE_FADE_IN_S,
  WAKE_INTERVAL_S,
  WAKE_SAMPLES,
  WAKE_WINDOW_S,
  wakeDecay,
  wakeFadeIn,
  wakeWeight,
} from '../src/motion/reactive.ts';
import { createStrokeBatch } from '../src/render/strokes/batch.ts';
import { createStrokeBuffers, packInstance, STROKE_LAYER } from '../src/render/strokes/instance.ts';
import { createStrokeMaterial } from '../src/render/strokes/material.ts';
import { mulberry32 } from '../src/util/prng.ts';

type V3 = [number, number, number];
const motionGlsl = readFileSync('src/motion/motion.glsl', 'utf8');

const norm = (v: V3): V3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: readonly number[], b: readonly number[]): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A random field: every disturber and sample within a couple of metres, at the extremes too. */
function randomField(rand: () => number, extreme: boolean): ReactiveField {
  const at = (): V3 => [4 * rand() - 2, 4 * rand() - 2, 4 * rand() - 2];
  const disturbers = Array.from({ length: REACTIVE_DISTURBERS }, (_, j) => {
    const v: V3 = norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
    const speed = extreme ? REACTIVE_MAX_SPEED : REACTIVE_MAX_SPEED * rand();
    return {
      position: at(),
      velocity: [v[0] * speed, v[1] * speed, v[2] * speed] as V3,
      strength: extreme ? DISTURBER_STRENGTHS[j] : DISTURBER_STRENGTHS[j] * rand(),
    };
  });
  const wake = Array.from({ length: REACTIVE_DISTURBERS * WAKE_SAMPLES }, (_, i) => ({
    position: extreme ? disturbers[Math.floor(i / WAKE_SAMPLES)].position : at(),
    weight: extreme ? 1 : rand(),
  }));
  return { disturbers, wake };
}

describe('falloff and wake decay (P4.5 verify)', () => {
  test('the falloff is 1 at the disturber, falls monotonically and is exactly 0 from the radius on', () => {
    expect(reactiveFalloff(0)).toBe(1);
    let last = 1;
    for (let k = 1; k <= 1000; k++) {
      const x = k / 1000;
      const f = reactiveFalloff(x * x);
      expect(f).toBeLessThanOrEqual(last);
      last = f;
    }
    for (const x of [1, 1 + 1e-9, 1.01, 2, 10, 1e6]) expect(reactiveFalloff(x * x)).toBe(0);
    // A disturber's push is exactly 0 for a stroke beyond the radius, at any strength and speed.
    const field: ReactiveField = {
      disturbers: [{ position: [0, 0, 0], velocity: [3, 0, 0], strength: 1 }],
      wake: [{ position: [0, 0, 0], weight: 1 }],
    };
    for (const r of [REACTIVE_RADIUS * (1 + 1e-9), REACTIVE_RADIUS + 1e-6, 1, 5]) {
      const m = reactiveMotion([r, 0, 0], [0, 0, 1], field);
      expect(Math.hypot(...m.offset)).toBe(0);
      expect(m.turn).toBe(0);
    }
  });

  test('the wake decay is 1 at age 0, monotone non-increasing, bounded in [0, 1] and 0 from the window on', () => {
    expect(wakeDecay(0)).toBe(1);
    let last = 1;
    for (let k = 1; k <= 2000; k++) {
      const age = (k / 1000) * WAKE_WINDOW_S;
      const d = wakeDecay(age);
      expect(d).toBeLessThanOrEqual(last);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
      // Never above the plan's exponential decay of about 1.2 s.
      expect(d).toBeLessThanOrEqual(Math.exp(-age / WAKE_DECAY_S) + 1e-15);
      last = d;
    }
    expect(WAKE_DECAY_S).toBe(1.2);
    // Ruling I2: 8 samples about 150 ms apart, so the window spans the 1.2 s decay.
    expect(WAKE_SAMPLES).toBe(8);
    expect(WAKE_INTERVAL_S).toBe(0.15);
    expect(WAKE_WINDOW_S).toBeCloseTo(WAKE_SAMPLES * WAKE_INTERVAL_S, 12);
    expect(WAKE_WINDOW_S).toBeCloseTo(WAKE_DECAY_S, 12);
    expect(wakeDecay(WAKE_WINDOW_S)).toBe(0);
    expect(wakeDecay(10)).toBe(0);
    // Up to the taper (0.9 s) it is the exponential itself, about 0.47 where the taper starts.
    expect(wakeDecay(0.3)).toBeCloseTo(Math.exp(-0.3 / 1.2), 12);
    expect(wakeDecay(0.9)).toBeCloseTo(Math.exp(-0.75), 12);
    expect(wakeDecay(0.9)).toBeGreaterThan(0.45);
  });

  test('a sample fades in over its own 60 ms, not the interval, and its weight is bounded by its strength', () => {
    expect(WAKE_FADE_IN_S).toBe(0.06);
    expect(WAKE_FADE_IN_S).toBeLessThan(WAKE_INTERVAL_S);
    expect(wakeFadeIn(0)).toBe(0);
    expect(wakeFadeIn(WAKE_FADE_IN_S / 2)).toBeCloseTo(0.5, 12);
    expect(wakeFadeIn(WAKE_FADE_IN_S)).toBe(1);
    const rand = mulberry32(7);
    for (let k = 0; k < 5000; k++) {
      const age = 2 * WAKE_WINDOW_S * rand();
      const speed = 10 * rand();
      const strength = rand();
      const w = wakeWeight(age, speed, strength);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(strength);
    }
    // A still disturber leaves no wake; one at the window's end has none left.
    expect(wakeWeight(0.2, 0, 1)).toBe(0);
    expect(wakeWeight(WAKE_WINDOW_S, 2, 1)).toBe(0);
  });
});

describe('reactive displacement (the GLSL-equivalent reference)', () => {
  test('the displacement is never larger than the reach, itself under the radius, and lies in the stroke plane', () => {
    expect(REACTIVE_REACH).toBeLessThan(REACTIVE_RADIUS);
    const rand = mulberry32(45);
    let largest = 0;
    for (let k = 0; k < 20000; k++) {
      const field = randomField(rand, k % 4 === 0);
      const p: V3 = [2 * rand() - 1, 2 * rand() - 1, 2 * rand() - 1];
      const n = norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
      const m = reactiveMotion(p, n, field);
      const length = Math.hypot(...m.offset);
      largest = Math.max(largest, length);
      expect(length).toBeLessThanOrEqual(REACTIVE_REACH + 1e-12);
      expect(Math.abs(dot(m.offset, n))).toBeLessThan(1e-9);
      expect(m.turn).toBeGreaterThanOrEqual(0);
      expect(m.turn).toBeLessThanOrEqual(REACTIVE_MAX_TURN);
      // A reactive push never shrinks a stroke, and its stretch growth is capped.
      expect(m.gain).toBeGreaterThanOrEqual(0);
      expect(m.gain).toBeLessThanOrEqual(REACTIVE_MAX_GAIN);
      expect(m.bright).toBe(0);
    }
    expect(largest).toBeGreaterThan(0.5 * REACTIVE_REACH);
    // A hand at full speed with a full-weight wake round the stroke is clamped to the reach.
    const strong: ReactiveField = {
      disturbers: [{ position: [0, 0, 0], velocity: [REACTIVE_MAX_SPEED, 0, 0], strength: 1 }],
      wake: Array.from({ length: 24 }, (_, i) => ({
        position: [0.1 * Math.cos(i), 0.1 * Math.sin(i), 0] as V3,
        weight: 1,
      })),
    };
    const clamped = reactiveMotion([0.15, 0.1, 0], [0, 0, 1], strong);
    expect(Math.hypot(...clamped.offset)).toBeCloseTo(REACTIVE_REACH, 9);
    expect(clamped.turn).toBe(REACTIVE_MAX_TURN);
  });

  test('a still push is 0 at the disturber, peaks at x = 1/√5 and stays a monotone map of the surface', () => {
    const field: ReactiveField = {
      disturbers: [{ position: [0, 0, 0.1], velocity: [0, 0, 0], strength: HAND_STRENGTH }],
      wake: [],
    };
    const n: V3 = [0, 0, 1];
    expect(Math.hypot(...reactiveMotion([0, 0, 0], n, field).offset)).toBe(0);
    // Along a ray in the stroke plane, the moved distance r + u(r) never decreases.
    let last = -1;
    let peak = 0;
    for (let k = 0; k <= 600; k++) {
      const r = (k / 600) * 0.7;
      const u = reactiveMotion([r, 0, 0], n, field).offset[0];
      expect(u).toBeGreaterThanOrEqual(0);
      expect(r + u).toBeGreaterThan(last);
      last = r + u;
      peak = Math.max(peak, u);
    }
    // In 3D the disturber sits 0.1 m off the plane, so the in-plane peak is a little under the
    // nominal 0.286 × gain × radius.
    expect(peak).toBeLessThanOrEqual(0.2862 * REACTIVE_PUSH_GAIN * REACTIVE_RADIUS + 1e-9);
    expect(peak).toBeGreaterThan(0.08);
  });

  test('strokes grow by the square root of the push areal stretch, so spread-apart strokes still cover (R-P4o)', () => {
    const n: V3 = [0, 0, 1];
    // One still hand on the surface: the foot point stretches by (1 + PUSH_GAIN)² in area.
    const onSurface: ReactiveField = {
      disturbers: [{ position: [0, 0, 0], velocity: [0, 0, 0], strength: HAND_STRENGTH }],
      wake: [],
    };
    expect(reactiveMotion([0, 0, 0], n, onSurface).gain).toBeCloseTo(REACTIVE_PUSH_GAIN, 12);
    // Against a finite-difference Jacobian of the offset field in the plane, for one hand at
    // depths 0-0.2 m behind the surface (the reach clamp and the cap never bind for one hand).
    const h = 1e-5;
    let checked = 0;
    for (const depth of [0, 0.05, 0.1, 0.2]) {
      const field: ReactiveField = {
        disturbers: [{ position: [0, 0, -depth], velocity: [0, 0, 0], strength: HAND_STRENGTH }],
        wake: [],
      };
      for (let k = 0; k <= 40; k++) {
        const r = (k / 40) * 0.7;
        const at = (x: number, y: number) => reactiveMotion([x, y, 0], n, field).offset;
        const ux = at(r + h, 0);
        const uxm = at(r - h, 0);
        const uy = at(r, h);
        const uym = at(r, -h);
        const j11 = 1 + (ux[0] - uxm[0]) / (2 * h);
        const j21 = (ux[1] - uxm[1]) / (2 * h);
        const j12 = (uy[0] - uym[0]) / (2 * h);
        const j22 = 1 + (uy[1] - uym[1]) / (2 * h);
        const area = j11 * j22 - j12 * j21;
        const expected = Math.min(Math.sqrt(Math.max(area, 1)) - 1, REACTIVE_MAX_GAIN);
        expect(reactiveMotion([r, 0, 0], n, field).gain).toBeCloseTo(expected, 6);
        checked++;
      }
    }
    expect(checked).toBe(164);
    // Calm scales the push, so the growth follows it down; none at calm 0.
    const full = reactiveMotion([0.1, 0, 0], n, onSurface, 1).gain;
    const half = reactiveMotion([0.1, 0, 0], n, onSurface, 0.5).gain;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
    expect(reactiveMotion([0.1, 0, 0], n, onSurface, 0).gain).toBe(0);
    // Every disturber stacked on one point is capped.
    const stacked: ReactiveField = {
      disturbers: Array.from({ length: 3 }, () => ({
        position: [0, 0, 0] as V3,
        velocity: [0, 0, 0] as V3,
        strength: HAND_STRENGTH,
      })),
      wake: [],
    };
    expect(reactiveMotion([0, 0, 0], n, stacked).gain).toBe(REACTIVE_MAX_GAIN);
  });

  test('the head pushes gentler than a hand (comfort)', () => {
    expect(HEAD_STRENGTH).toBeLessThan(0.5 * HAND_STRENGTH);
    expect(DISTURBER_STRENGTHS).toEqual([HEAD_STRENGTH, HAND_STRENGTH, HAND_STRENGTH]);
    const at = (strength: number): number =>
      Math.hypot(
        ...reactiveMotion([0.25, 0, 0], [0, 0, 1], {
          disturbers: [{ position: [0, 0, 0], velocity: [0, 0, 0], strength }],
          wake: [],
        }).offset,
      );
    expect(at(HEAD_STRENGTH)).toBeCloseTo(HEAD_STRENGTH * at(HAND_STRENGTH), 12);
  });

  test('the wake swirls strokes about their normal and turns them with it', () => {
    const field: ReactiveField = {
      disturbers: [],
      wake: [{ position: [0, 0, 0], weight: 1 }],
    };
    const m = reactiveMotion([0.2, 0, 0], [0, 0, 1], field);
    // A counter-clockwise turn about +z moves a point on +x towards +y.
    expect(m.offset[0]).toBeCloseTo(0, 12);
    expect(m.offset[1]).toBeGreaterThan(0);
    expect(m.turn).toBeGreaterThan(0);
    expect(m.offset[1]).toBeCloseTo(0.2 * m.turn, 12);
  });
});

describe('reactive tracker', () => {
  const head: V3 = [0, 1.6, 0];

  test('the desktop has the eye only: the controller slots carry strength 0 and no wake', () => {
    const tracker = createReactiveTracker();
    tracker.frame(0, [head, null, null]);
    const { uniforms } = tracker;
    expect(uniforms.uDisturbers.value[0].toArray()).toEqual([...head, HEAD_STRENGTH]);
    expect(uniforms.uDisturbers.value[1].w).toBe(0);
    expect(uniforms.uDisturbers.value[2].w).toBe(0);
    for (const w of uniforms.uWake.value) expect(w.w).toBe(0);
    const diag = tracker.diag();
    expect(diag.frames).toBe(1);
    expect(diag.disturbers.map((d) => d.tracked)).toEqual([true, false, false]);
    expect(diag.box).toEqual({
      min: [-REACTIVE_RADIUS, 1.6 - REACTIVE_RADIUS, -REACTIVE_RADIUS],
      max: [REACTIVE_RADIUS, 1.6 + REACTIVE_RADIUS, REACTIVE_RADIUS],
    });
  });

  test('nothing tracked leaves the box empty, so no stroke enters the reactive maths', () => {
    const tracker = createReactiveTracker();
    tracker.frame(0, [null, null, null]);
    expect(tracker.diag().box).toBeNull();
    expect(tracker.uniforms.uReactiveHalf.value.x).toBeLessThan(0);
    expect(insideReactiveBox(tracker.uniforms, [0, 0, 0])).toBe(false);
  });

  test('velocities are m/s from the last frame, clamped; a jump resets the wake', () => {
    const tracker = createReactiveTracker();
    const hand = (x: number): V3 => [x, 1, -0.5];
    tracker.frame(1000, [head, hand(0), null]);
    tracker.frame(1016, [head, hand(0.016), null]);
    expect(tracker.diag().disturbers[1].velocity[0]).toBeCloseTo(1, 9);
    // 6 m/s is a fast hand: clamped to the maximum.
    tracker.frame(1032, [head, hand(0.016 + 0.096), null]);
    expect(Math.hypot(...tracker.diag().disturbers[1].velocity)).toBeCloseTo(REACTIVE_MAX_SPEED, 9);
    expect(tracker.diag().disturbers[1].wake).toBeGreaterThan(0);
    // A teleport-sized step is a jump: no velocity and no wake across it.
    const far = 5 + REACTIVE_JUMP_SPEED;
    tracker.frame(1048, [head, hand(far), null]);
    const d = tracker.diag().disturbers[1];
    expect(d.velocity).toEqual([0, 0, 0]);
    expect(d.jumps).toBe(1);
    expect(d.wake).toBe(1);
    // The backstop sits well above a fast hand (M1): 12 m/s is still motion, clamped.
    expect(REACTIVE_JUMP_SPEED).toBe(15);
    tracker.frame(1064, [head, hand(far + 0.012 * 16), null]);
    expect(Math.hypot(...tracker.diag().disturbers[1].velocity)).toBeCloseTo(REACTIVE_MAX_SPEED, 9);
    expect(tracker.diag().disturbers[1].jumps).toBe(1);
  });

  test('a change in the discontinuity count restarts every history at the new pose (M1)', () => {
    const tracker = createReactiveTracker();
    let t = 0;
    let x = 0;
    for (let k = 0; k < 40; k++, t += 1000 / 72, x += 1.5 / 72) {
      tracker.frame(t, [head, [x, 1, -0.5], null], 0);
    }
    expect(tracker.diag().disturbers[1].wake).toBeGreaterThan(1);
    expect(tracker.diag().resets).toBe(0);
    // The same slow step, but locomotion reports a discontinuity: no velocity, one still sample.
    tracker.frame(t, [head, [x + 1.5 / 72, 1, -0.5], null], 1);
    const diag = tracker.diag();
    expect(diag.discontinuity).toBe(1);
    expect(diag.resets).toBe(1);
    for (const d of diag.disturbers.slice(0, 2)) {
      expect(d.velocity).toEqual([0, 0, 0]);
      expect(d.wake).toBe(1);
      expect(d.jumps).toBe(0);
    }
    for (const w of tracker.uniforms.uWake.value) expect(w.w).toBe(0);
  });

  test('samples land about 150 ms apart, at most 8, and a moving hand leaves a wake that decays back to 0', () => {
    const tracker = createReactiveTracker();
    let t = 0;
    let x = 0;
    for (let k = 0; k < 120; k++, t += 1000 / 72, x += 1.5 / 72) {
      tracker.frame(t, [head, [x, 1, -0.5], null]);
    }
    expect(tracker.diag().disturbers[1].wake).toBe(WAKE_SAMPLES);
    const weights = (): number[] =>
      tracker.uniforms.uWake.value.slice(WAKE_SAMPLES, 2 * WAKE_SAMPLES).map((w) => w.w);
    expect(Math.max(...weights())).toBeGreaterThan(0.5);
    for (const w of weights()) expect(w).toBeLessThanOrEqual(HAND_STRENGTH);
    expect(tracker.diag().disturbers[1].wakePeak).toBe(Math.max(...weights()));
    // The hand stops: after one window every sample is still, so the wake is 0 (spring back).
    const settle = Math.ceil(WAKE_WINDOW_S * 72) + 2;
    for (let k = 0; k < settle; k++, t += 1000 / 72) tracker.frame(t, [head, [x, 1, -0.5], null]);
    for (const w of weights()) expect(w).toBe(0);
  });

  test('the box holds every disturber and weighted sample grown by the radius; outside it the full function is exactly 0', () => {
    const tracker = createReactiveTracker();
    let t = 0;
    for (let k = 0; k < 40; k++, t += 1000 / 72) {
      const a = k / 10;
      tracker.frame(t, [head, [Math.cos(a), 1, Math.sin(a)], [0.3, 1.2 + 0.02 * k, -0.4]]);
    }
    const field = tracker.field();
    const rand = mulberry32(11);
    let inside = 0;
    for (let k = 0; k < 20000; k++) {
      const p: V3 = [6 * rand() - 3, 6 * rand() - 1.5, 6 * rand() - 3];
      const n = norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
      const m = reactiveMotion(p, n, field);
      if (insideReactiveBox(tracker.uniforms, p)) {
        inside++;
        continue;
      }
      expect(m.offset).toEqual([0, 0, 0]);
      expect(m.turn).toBe(0);
    }
    expect(inside).toBeGreaterThan(100);
    // Every weighted point is at least a radius inside the box.
    const box = tracker.diag().box;
    if (!box) throw new Error('expected a box');
    for (const point of [
      ...field.disturbers.filter((d) => d.strength > 0).map((d) => d.position),
      ...field.wake.filter((w) => w.weight > 0).map((w) => w.position),
    ]) {
      for (let a = 0; a < 3; a++) {
        expect(point[a] - box.min[a]).toBeGreaterThanOrEqual(REACTIVE_RADIUS - 1e-9);
        expect(box.max[a] - point[a]).toBeGreaterThanOrEqual(REACTIVE_RADIUS - 1e-9);
      }
    }
  });
});

describe('gate, calm and plumbing', () => {
  const field: ReactiveField = {
    disturbers: [{ position: [0, 0, 0.2], velocity: [0, 0, 0], strength: 1 }],
    wake: [],
  };
  const fns: MotionFunctions = {
    ...STUB_MOTION,
    sky: () => ({ offset: [0, 1, 0], turn: 0.1, gain: -0.5, bright: 0 }),
    reactive: ({ position, normal, calm }) => reactiveMotion(position, normal, field, calm),
  };
  const p: V3 = [0.2, 0, 0];
  const n: V3 = [0, 0, 1];
  const uniforms = (layerMask: number, calm = 1) => ({ time: 1, calm, layerMask });

  test('the reactive bit alone moves every layer by the reactive term, and no layer motion', () => {
    const reactive = reactiveMotion(p, n, field);
    expect(Math.hypot(...reactive.offset)).toBeGreaterThan(0);
    for (const layer of Object.values(STROKE_LAYER)) {
      const m = motionOffset(layer, 0, p, n, uniforms(REACTIVE_MOTION_BIT), fns);
      expect(m.offset).toEqual(reactive.offset);
      expect(m.gain).toBeGreaterThan(0);
      expect(m.gain).toBeCloseTo(reactive.gain, 12);
    }
    // The sky's bit without the reactive bit: the sky motion alone.
    const sky = motionOffset(STROKE_LAYER.sky, 0, p, n, uniforms(1 << STROKE_LAYER.sky), fns);
    expect(sky.offset).toEqual([0, 1, 0]);
    // Both: they add, and the layer's gain, its wrap envelope, stands.
    const both = motionOffset(
      STROKE_LAYER.sky,
      0,
      p,
      n,
      uniforms((1 << STROKE_LAYER.sky) | REACTIVE_MOTION_BIT),
      fns,
    );
    expect(both.offset[1]).toBeCloseTo(1 + reactive.offset[1], 12);
    // The gains combine as size factors: the wrap envelope still scales the stretched stroke.
    expect(both.gain).toBeCloseTo((1 - 0.5) * (1 + reactive.gain) - 1, 12);
    // Neither: at rest.
    const closed = motionLayerMask(Object.values(STROKE_LAYER)) & ~(1 << STROKE_LAYER.ground);
    expect(motionOffset(STROKE_LAYER.ground, 0, p, n, uniforms(closed), fns)).toBe(REST);
  });

  test('calm scales the reactive offset and turn; frozen and calm 0 close the reactive bit', () => {
    const full = motionOffset(STROKE_LAYER.ground, 0, p, n, uniforms(REACTIVE_MOTION_BIT), fns);
    const half = motionOffset(
      STROKE_LAYER.ground,
      0,
      p,
      n,
      uniforms(REACTIVE_MOTION_BIT, 0.5),
      fns,
    );
    for (let a = 0; a < 3; a++) expect(half.offset[a]).toBeCloseTo(0.5 * full.offset[a], 12);
    expect(half.turn).toBeCloseTo(0.5 * full.turn, 12);
    // The stretch growth follows the calm-scaled push down; gains are otherwise unscaled.
    expect(half.gain).toBeGreaterThan(0);
    expect(half.gain).toBeLessThan(full.gain);
    expect(reactiveReach(0.5)).toBe(0.5 * REACTIVE_REACH);
    const clock = createMotionClock({ layerMask: MOTION_LAYER_MASK });
    expect(clock.uniforms.uMotionLayers.value & REACTIVE_MOTION_BIT).toBe(REACTIVE_MOTION_BIT);
    clock.setFrozen(true);
    expect(clock.uniforms.uMotionLayers.value).toBe(0);
    clock.setFrozen(false);
    clock.setCalm(0);
    expect(clock.uniforms.uMotionLayers.value).toBe(0);
  });

  test('LIVE_MOTION reads the app tracker, and every stroke material shares its uniforms by reference', () => {
    const a = createStrokeMaterial(new Texture());
    for (const key of [
      'uDisturbers',
      'uDisturberVelocities',
      'uWake',
      'uReactiveCentre',
      'uReactiveHalf',
    ] as const) {
      expect(a.uniforms[key]).toBe(reactiveTracker.uniforms[key]);
    }
    expect(a.defines.REACTIVE_MOTION_BIT).toBe(`${REACTIVE_MOTION_BIT}u`);
    expect(a.defines.REACTIVE_WAKE_SAMPLES).toBe(24);
    expect(a.defines.REACTIVE_DISTURBERS).toBe(3);
    expect(Number(a.defines.REACTIVE_STRETCH_M)).toBeCloseTo(
      (4 * REACTIVE_PUSH_GAIN) / (REACTIVE_RADIUS * REACTIVE_RADIUS),
      6,
    );
    expect(Number(a.defines.REACTIVE_MAX_GAIN)).toBe(REACTIVE_MAX_GAIN);
    // The app tracker starts with nothing tracked: the live reactive term is 0.
    const m = LIVE_MOTION.reactive({
      position: [0, 1.6, 0],
      normal: [0, 0, 1],
      phase: 0,
      phaseByte: 0,
      flameByte: 255,
      time: 0,
      calm: 1,
    });
    expect(Math.hypot(...m.offset)).toBe(0);
  });

  test('the teleport arc has its own closed motion gate and still shares the stroke program', () => {
    const scene = { add: () => undefined, remove: () => undefined } as never;
    const atlas = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
    const arc = createArcMesh(scene, atlas);
    const material = arc.mesh.material;
    expect(material.uniforms.uMotionLayers).not.toBe(motionClock.uniforms.uMotionLayers);
    expect(material.uniforms.uMotionLayers.value).toBe(0);
    const batchMaterial = createStrokeMaterial(atlas);
    expect(material.vertexShader).toBe(batchMaterial.vertexShader);
    expect(material.defines).toEqual(batchMaterial.defines);
    arc.dispose();
  });

  test('every stroke batch group and chunk sits at the identity, so iPosition is world space', () => {
    const buffers = createStrokeBuffers(3);
    for (let i = 0; i < 3; i++) {
      packInstance(buffers, i, {
        position: [i * 10, 1, -5],
        normal: [0, 0, 1],
        tangent: 0,
        color: [255, 255, 255, 255],
        size: [1, 0.5],
        brush: 0,
        layer: STROKE_LAYER.ground,
        phase: 0,
      });
    }
    const batch = createStrokeBatch(buffers, {
      cellSize: 4,
      createAtlas: () => new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat),
    });
    batch.group.updateMatrixWorld(true);
    expect(batch.group.matrixWorld.equals(batch.group.matrixWorld.clone().identity())).toBe(true);
    for (const chunk of batch.chunks) {
      expect(chunk.mesh.matrixWorld.equals(chunk.mesh.matrixWorld.clone().identity())).toBe(true);
    }
    batch.dispose();
  });

  test('motion.glsl mirrors the reference: falloff, push, swirl, plane projection, clamp, stretch and the box gate', () => {
    for (const line of [
      // The push's sign: p - d points away from the disturber (review I1).
      'vec3 e = p - d.xyz;',
      'float f = max(1.0 - e2 * REACTIVE_INV_RADIUS2, 0.0);',
      'offset += s * (REACTIVE_PUSH_GAIN * e + REACTIVE_DRAG_S * uDisturberVelocities[j].xyz);',
      'squeeze += sf * (e2 - en * en);',
      'vec3 e = p - w.xyz;',
      'float f = max(1.0 - dot(e, e) * REACTIVE_INV_RADIUS2, 0.0);',
      'float t = w.w * REACTIVE_SWIRL * f * f;',
      'offset += cross(n, swirl);',
      'offset -= n * dot(n, offset);',
      'offset *= min(1.0, REACTIVE_REACH * inversesqrt(max(dot(offset, offset), 1e-12)));',
      'float stretch = (1.0 + a) * (1.0 + a - uCalm * REACTIVE_STRETCH_M * squeeze);',
      'float gain = min(sqrt(max(stretch, 1.0)) - 1.0, REACTIVE_MAX_GAIN);',
      'return Motion(offset, min(theta, REACTIVE_MAX_TURN), gain, 0.0);',
      'm.gain = (1.0 + m.gain) * (1.0 + r.gain) - 1.0;',
      'all(lessThan(abs(p - uReactiveCentre), uReactiveHalf));',
      'return (uMotionLayers & REACTIVE_MOTION_BIT) != 0u &&',
    ]) {
      expect(motionGlsl).toContain(line);
    }
  });
});

describe('a snap turn leaves no wake (M1)', () => {
  const IDLE: FrameActions = {
    dt: 1 / 72,
    move: { x: 0, y: 0 },
    sprint: false,
    turn: { x: 0, snap: 0 },
    teleportAim: false,
    teleportCommit: false,
    flightToggle: false,
    vertical: 0,
  };
  const SNAP: FrameActions = { ...IDLE, turn: { x: 1, snap: 1 } };

  function rigWithControls() {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const desktop = installDesktopControls(document.createElement('canvas'), camera);
    const locomotion = createLocomotion({
      scene,
      camera,
      look: desktop,
      settings: DEFAULT_LOCOMOTION_SETTINGS,
    });
    return { camera, desktop, locomotion };
  }

  /**
   * Snap-turns a rig whose hand is 0.21 m off the head's axis, so the turn moves it about 0.11 m in
   * one 72 Hz frame (about 7.9 m/s, under the 15 m/s backstop), on the frame a wake sample is
   * taken. `epoch` maps locomotion's count to what the tracker is told. Returns the hand's wake
   * weights after the turn and the discontinuities locomotion counted.
   */
  function snapWithHand(
    epoch: (count: number) => number,
    rigRelative = false,
  ): { weights: number[]; count: number } {
    const { camera, desktop, locomotion } = rigWithControls();
    const hand = new Object3D();
    hand.position.set(0.15, 1.5, -0.15);
    locomotion.rig.add(hand);
    const tracker = createReactiveTracker();
    const world = (o: Object3D): V3 => {
      o.updateWorldMatrix(true, false);
      return new Vector3().setFromMatrixPosition(o.matrixWorld).toArray() as V3;
    };
    const frame = (k: number, actions: FrameActions): void => {
      desktop.update();
      locomotion.frame(actions, false);
      const count = epoch(locomotion.discontinuities());
      locomotion.rig.updateWorldMatrix(true, false);
      tracker.frame(
        (k * 1000) / 72,
        [world(camera), world(hand), null],
        count,
        rigRelative ? locomotion.rig.matrixWorld.elements : null,
      );
    };
    const start = locomotion.discontinuities();
    // Frame 11 (152.8 ms) is the first 150 ms after the sample at frame 0, so it takes a sample.
    for (let k = 0; k <= 10; k++) frame(k, IDLE);
    const before = world(hand);
    frame(11, SNAP);
    const moved = world(hand).map((v, a) => v - before[a]);
    expect(Math.hypot(...moved)).toBeGreaterThan(0.1);
    for (let k = 12; k <= 20; k++) frame(k, IDLE);
    const weights = tracker.uniforms.uWake.value
      .slice(WAKE_SAMPLES, 2 * WAKE_SAMPLES)
      .map((w) => w.w);
    return { weights, count: locomotion.discontinuities() - start };
  }

  test('locomotion counts the snap, and the tracker drops the hand history across it', () => {
    const signalled = snapWithHand((count) => count);
    expect(signalled.count).toBe(1);
    for (const w of signalled.weights) expect(w).toBe(0);
    // Without the signal and in world velocity the same snap draws a wake: the speed backstop alone
    // misses it. Rig-relative velocity (Q41) needs neither: the hand does not move in the rig.
    const unsignalled = snapWithHand(() => 0);
    expect(Math.max(...unsignalled.weights)).toBeGreaterThan(0.5);
    const rigRelative = snapWithHand(() => 0, true);
    for (const w of rigRelative.weights) expect(w).toBeCloseTo(0, 6);
  });

  test('spawn, a placed pose and an explicit mark count as discontinuities too', () => {
    const { locomotion } = rigWithControls();
    const start = locomotion.discontinuities();
    locomotion.spawn(1, 0, -2, 0.5);
    locomotion.setPose(3, 2, -4, 0.5, 0);
    locomotion.markDiscontinuity();
    expect(locomotion.discontinuities()).toBe(start + 3);
  });

  test('only the moves that carry the head count as head jumps, not turns about it (P5.5)', () => {
    const { desktop, locomotion } = rigWithControls();
    desktop.update();
    const turns = locomotion.discontinuities();
    const jumps = locomotion.headJumps();
    locomotion.frame(SNAP, false);
    locomotion.faceYaw(1);
    expect(locomotion.discontinuities()).toBe(turns + 2);
    expect(locomotion.headJumps()).toBe(jumps);
    locomotion.spawn(1, 0, -2, 0.5);
    locomotion.setPose(3, 2, -4, 0.5, 0);
    locomotion.markDiscontinuity();
    expect(locomotion.headJumps()).toBe(jumps + 3);
  });
});

describe('velocity is relative to the rig (Q41)', () => {
  const head: V3 = [0, 1.6, 0];
  const DT = 1000 / 72;
  const rigMatrix = (x: number, y: number, z: number, yaw: number): number[] =>
    new Matrix4()
      .compose(
        new Vector3(x, y, z),
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
        new Vector3(1, 1, 1),
      )
      .toArray();
  const toWorld = (m: number[], local: V3): V3 => {
    const v = new Vector3(...local).applyMatrix4(new Matrix4().fromArray(m));
    return [v.x, v.y, v.z];
  };

  test('rig translation alone gives every disturber velocity 0 and no wake', () => {
    const tracker = createReactiveTracker();
    const hand: V3 = [0.3, 1.2, -0.4];
    for (let k = 0; k < 60; k++) {
      const m = rigMatrix(k * (2 / 72), k * (1 / 72), -k * (2 / 72), 0);
      tracker.frame(
        k * DT,
        [toWorld(m, head), toWorld(m, hand), toWorld(m, [-0.3, 1.2, -0.4])],
        0,
        m,
      );
    }
    for (const d of tracker.diag().disturbers) {
      expect(Math.hypot(...d.velocity)).toBeCloseTo(0, 9);
      expect(d.wakeWeight).toBeCloseTo(0, 9);
    }
    expect(tracker.diag().disturbers[1].position[0]).toBeGreaterThan(1);
  });

  test('rig yaw alone, smooth or snapped, gives velocity 0 with no discontinuity signal', () => {
    const tracker = createReactiveTracker();
    const hand: V3 = [0.3, 1.2, -0.4];
    for (let k = 0; k < 60; k++) {
      const yaw = k < 30 ? k * 0.02 : 0.6 + 0.5;
      const m = rigMatrix(1, 0, 2, yaw);
      tracker.frame(k * DT, [toWorld(m, head), toWorld(m, hand), null], 0, m);
    }
    for (const d of tracker.diag().disturbers) {
      expect(Math.hypot(...d.velocity)).toBeCloseTo(0, 9);
      expect(d.wakeWeight).toBeCloseTo(0, 9);
      expect(d.jumps).toBe(0);
    }
  });

  test('a physical hand sweep gives the same velocity and wake with or without rig motion', () => {
    const run = (moving: boolean) => {
      const tracker = createReactiveTracker();
      for (let k = 0; k < 40; k++) {
        const m = moving
          ? rigMatrix(k * (2 / 72), 0.1, -k * (1.5 / 72), 0.01 * k)
          : rigMatrix(0, 0, 0, 0);
        const hand: V3 = [k * (1.2 / 72), 1.2, -0.4];
        tracker.frame(k * DT, [toWorld(m, head), toWorld(m, hand), null], 0, m);
      }
      const m = moving
        ? rigMatrix(39 * (2 / 72), 0.1, -39 * (1.5 / 72), 0.39)
        : rigMatrix(0, 0, 0, 0);
      const d = tracker.diag().disturbers[1];
      const rigLocal = new Vector3(...d.velocity).applyMatrix4(
        new Matrix4().extractRotation(new Matrix4().fromArray(m)).transpose(),
      );
      return { local: rigLocal.toArray(), weight: d.wakeWeight, speed: Math.hypot(...d.velocity) };
    };
    const still = run(false);
    const walking = run(true);
    expect(still.speed).toBeCloseTo(1.2, 9);
    expect(walking.speed).toBeCloseTo(1.2, 9);
    expect(walking.weight).toBeCloseTo(still.weight, 9);
    for (let a = 0; a < 3; a++) expect(walking.local[a]).toBeCloseTo(still.local[a], 9);
    expect(still.weight).toBeGreaterThan(0.5);
  });

  test('a teleport or a snap turn gives no velocity spike even without the discontinuity signal', () => {
    const tracker = createReactiveTracker();
    const hand: V3 = [0.15, 1.5, -0.15];
    let m = rigMatrix(0, 0, 0, 0);
    for (let k = 0; k < 20; k++) {
      if (k === 10) m = rigMatrix(8, 0, -6, 0);
      if (k === 15) m = rigMatrix(8, 0, -6, Math.PI / 6);
      tracker.frame(k * DT, [toWorld(m, head), toWorld(m, hand), null], 0, m);
      for (const d of tracker.diag().disturbers) {
        expect(Math.hypot(...d.velocity)).toBeCloseTo(0, 9);
        expect(d.jumps).toBe(0);
      }
    }
    expect(tracker.diag().resets).toBe(0);
  });

  test('the static push follows world positions: the disturber reports its world position', () => {
    const tracker = createReactiveTracker();
    const m = rigMatrix(5, 0, -3, 1);
    tracker.frame(0, [toWorld(m, head), null, null], 0, m);
    const expected = toWorld(m, head);
    const got = tracker.diag().disturbers[0].position;
    for (let a = 0; a < 3; a++) expect(got[a]).toBeCloseTo(expected[a], 9);
  });
});
