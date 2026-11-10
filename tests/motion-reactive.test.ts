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
  DISTURBER_BOX_RADII,
  DISTURBER_DRAGS_S,
  DISTURBER_HALF_SIZE_CAPS,
  DISTURBER_LEVERS,
  DISTURBER_PUSH_GAINS,
  DISTURBER_RADII,
  DISTURBER_STRENGTHS,
  DISTURBER_SWIRLS,
  type Disturber,
  HAND_DRAG_S,
  HAND_HALF_SIZE_CAP,
  HAND_LEVER,
  HAND_PUSH_GAIN,
  HAND_RADIUS,
  HAND_STRENGTH,
  HAND_SWIRL,
  HEAD_DRAG_S,
  HEAD_PUSH_GAIN,
  HEAD_RADIUS,
  HEAD_STRENGTH,
  HEAD_SWIRL,
  insideReactiveBox,
  POINT_STROKE,
  REACTIVE_DISTURBERS,
  REACTIVE_JUMP_SPEED,
  REACTIVE_MAX_GAIN,
  REACTIVE_MAX_SPEED,
  REACTIVE_MAX_TURN,
  REACTIVE_REACH,
  type ReactiveField,
  reactiveFalloff,
  reactiveGlslDefines,
  reactiveMotion,
  reactiveTracker,
  type StrokeShape,
  WAKE_DECAY_S,
  WAKE_FADE_IN_S,
  WAKE_INTERVAL_S,
  WAKE_SAMPLES,
  WAKE_WINDOW_S,
  type WakeSample,
  wakeDecay,
  wakeFadeIn,
  wakeWeight,
} from '../src/motion/reactive.ts';
import { ORB_GLOW_RADIUS } from '../src/render/hand-orbs.ts';
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

const HEAD_SLOT = 0;
const HAND_SLOT = 1;
const OFF: Disturber = { position: [0, 0, 0], velocity: [0, 0, 0], strength: 0 };
const NO_SAMPLE: WakeSample = { position: [0, 0, 0], weight: 0 };

/**
 * A field with `d` in disturber slot `slot` (0 the head, 1 and 2 the hands) and `wake` as that
 * slot's samples; every other slot and sample is at strength or weight 0. Each slot reads its own
 * radius, gain, drag and swirl, so a hand under test must sit in a hand slot.
 */
function slotField(slot: number, d: Disturber, wake: readonly WakeSample[] = []): ReactiveField {
  return {
    disturbers: Array.from({ length: REACTIVE_DISTURBERS }, (_, j) => (j === slot ? d : OFF)),
    wake: Array.from({ length: REACTIVE_DISTURBERS * WAKE_SAMPLES }, (_, k) =>
      Math.floor(k / WAKE_SAMPLES) === slot ? (wake[k % WAKE_SAMPLES] ?? NO_SAMPLE) : NO_SAMPLE,
    ),
  };
}

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
    // A disturber's push is exactly 0 for a stroke beyond its own slot's radius, at any strength
    // and speed: the head's 0.6 m, a hand's 0.13 m.
    expect(DISTURBER_RADII).toEqual([HEAD_RADIUS, HAND_RADIUS, HAND_RADIUS]);
    expect(HEAD_RADIUS).toBe(0.6);
    expect(HAND_RADIUS).toBe(0.13);
    for (const slot of [0, 1, 2]) {
      const radius = DISTURBER_RADII[slot];
      const field = slotField(
        slot,
        { position: [0, 0, 0], velocity: [3, 0, 0], strength: 1 },
        Array.from({ length: WAKE_SAMPLES }, () => ({ position: [0, 0, 0] as V3, weight: 1 })),
      );
      for (const r of [radius * (1 + 1e-9), radius + 1e-6, 1, 5]) {
        const m = reactiveMotion([r, 0, 0], [0, 0, 1], field);
        expect(Math.hypot(...m.offset)).toBe(0);
        expect(m.turn).toBe(0);
        expect(m.gain).toBe(0);
      }
      // Just inside it, it moves.
      const inside = reactiveMotion([0.9 * radius, 0, 0], [0, 0, 1], field);
      expect(Math.hypot(...inside.offset)).toBeGreaterThan(0);
    }
  });

  test('a hand reacts only at its orb: its radius is the glow edge plus 0.05 m (2026-11-09)', () => {
    expect(HAND_RADIUS).toBeCloseTo(ORB_GLOW_RADIUS + 0.05, 12);
    // The head keeps its P4.5 behaviour.
    expect(DISTURBER_PUSH_GAINS).toEqual([HEAD_PUSH_GAIN, HAND_PUSH_GAIN, HAND_PUSH_GAIN]);
    expect(DISTURBER_DRAGS_S).toEqual([HEAD_DRAG_S, HAND_DRAG_S, HAND_DRAG_S]);
    expect(DISTURBER_SWIRLS).toEqual([HEAD_SWIRL, HAND_SWIRL, HAND_SWIRL]);
    expect([HEAD_PUSH_GAIN, HEAD_DRAG_S, HEAD_SWIRL, HEAD_STRENGTH]).toEqual([
      0.6, 0.04, 0.12, 0.4,
    ]);
    // A stroke's rest centre is never nearer than its nearest point, so a stroke whose nearest
    // point is 0.05 m past the glow edge has its centre outside the radius, whatever its size.
    const field = slotField(HAND_SLOT, {
      position: [0, 0, 0],
      velocity: [REACTIVE_MAX_SPEED, 0, 0],
      strength: HAND_STRENGTH,
    });
    for (const dir of [norm([1, 0, 0]), norm([1, 1, 0]), norm([0.3, -1, 0.2])]) {
      const r = (ORB_GLOW_RADIUS + 0.05) * (1 + 1e-9);
      const m = reactiveMotion([r * dir[0], r * dir[1], r * dir[2]], [0, 0, 1], field);
      expect(m.offset).toEqual([0, 0, 0]);
      expect(m.gain).toBe(0);
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
    expect(REACTIVE_REACH).toBeLessThan(HAND_RADIUS);
    expect(HAND_RADIUS).toBeLessThan(HEAD_RADIUS);
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
    const n: V3 = [0, 0, 1];
    for (const slot of [HEAD_SLOT, HAND_SLOT]) {
      const radius = DISTURBER_RADII[slot];
      const gain = DISTURBER_PUSH_GAINS[slot];
      // Both well under the monotone bound.
      expect(gain).toBeLessThan(1.25);
      const strength = DISTURBER_STRENGTHS[slot];
      const field = slotField(slot, {
        position: [0, 0, radius / 6],
        velocity: [0, 0, 0],
        strength,
      });
      expect(Math.hypot(...reactiveMotion([0, 0, 0], n, field).offset)).toBe(0);
      // Along a ray in the stroke plane, the moved distance r + u(r) never decreases.
      let last = -1;
      let peak = 0;
      for (let k = 0; k <= 600; k++) {
        const r = (k / 600) * 1.2 * radius;
        const u = reactiveMotion([r, 0, 0], n, field).offset[0];
        expect(u).toBeGreaterThanOrEqual(0);
        expect(r + u).toBeGreaterThan(last);
        last = r + u;
        peak = Math.max(peak, u);
      }
      // In 3D the disturber sits off the plane, so the in-plane peak is a little under the nominal
      // 0.286 × gain × radius.
      expect(peak).toBeLessThanOrEqual(0.2862 * strength * gain * radius + 1e-9);
      expect(peak).toBeGreaterThan(0.8 * 0.2862 * strength * gain * radius);
      // The reach clamp never binds for one still disturber.
      expect(0.2862 * strength * gain * radius).toBeLessThan(REACTIVE_REACH);
    }
  });

  test('a hand moves a stroke its orb touches by the quad distance, centre outside the radius or not (fix round 2)', () => {
    expect(HAND_LEVER).toBe(HAND_RADIUS);
    expect(HAND_HALF_SIZE_CAP).toBe(0.4);
    expect(DISTURBER_LEVERS[HEAD_SLOT]).toBeGreaterThan(100);
    expect(DISTURBER_HALF_SIZE_CAPS).toEqual([0, HAND_HALF_SIZE_CAP, HAND_HALF_SIZE_CAP]);
    const n: V3 = [0, 0, 1];
    const field = slotField(HAND_SLOT, {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      strength: HAND_STRENGTH,
    });
    // A 0.6 m stroke along x, its centre 0.25 m from the hand: the hand sits over its quad, so it
    // is pushed by the full lever, G λ = 0.052 m, though its centre is outside the 0.13 m radius.
    const long: StrokeShape = { long: [1, 0, 0], halfSize: [0.3, 0.05] };
    const over = reactiveMotion([0.25, 0, 0], n, field, 1, long);
    expect(Math.hypot(...over.offset)).toBeCloseTo(HAND_PUSH_GAIN * HAND_LEVER, 12);
    expect(HAND_PUSH_GAIN * HAND_LEVER).toBeGreaterThan(0.05);
    expect(over.offset[0]).toBeGreaterThan(0);
    // The motionOffset mirror passes the stroke's shape through to the reactive term.
    const viaMirror = motionOffset(
      STROKE_LAYER.ground,
      0,
      [0.25, 0, 0],
      n,
      { time: 0, calm: 1, layerMask: REACTIVE_MOTION_BIT },
      {
        ...STUB_MOTION,
        reactive: ({ position, normal, calm, stroke }) =>
          reactiveMotion(position, normal, field, calm, stroke),
      },
      undefined,
      long,
    );
    expect(viaMirror.offset).toEqual(over.offset);
    // The same centre as a point does not move.
    expect(reactiveMotion([0.25, 0, 0], n, field).offset).toEqual([0, 0, 0]);
    // A stroke whose quad is 0.13 m or more from the hand does not move, whatever its size.
    for (const [p, shape] of [
      [[0.3 + 0.13 + 1e-6, 0, 0], long],
      [[0, 0.05 + 0.13 + 1e-6, 0], long],
      [[0.3 + 0.13 * Math.SQRT1_2, 0.05 + 0.13 * Math.SQRT1_2 + 1e-6, 0], long],
      [[0.4 + 0.13 + 1e-6, 0, 0], { long: [1, 0, 0], halfSize: [2, 0.05] }],
    ] as [V3, StrokeShape][]) {
      expect(reactiveMotion(p, n, field, 1, shape).offset).toEqual([0, 0, 0]);
    }
    // The half-size is capped: a 4 m stroke reacts as an 0.8 m one.
    const capped = reactiveMotion([0.45, 0, 0], n, field, 1, {
      long: [1, 0, 0],
      halfSize: [2, 0.05],
    });
    const atCap = reactiveMotion([0.45, 0, 0], n, field, 1, {
      long: [1, 0, 0],
      halfSize: [0.4, 0.05],
    });
    expect(capped.offset).toEqual(atCap.offset);
    expect(Math.hypot(...capped.offset)).toBeGreaterThan(0);
    // The head reads only the centre, whatever the stroke's size.
    const headField = slotField(HEAD_SLOT, {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      strength: HEAD_STRENGTH,
    });
    for (const r of [0.1, 0.3, 0.5, 0.7]) {
      expect(reactiveMotion([r, 0, 0], n, headField, 1, long)).toEqual(
        reactiveMotion([r, 0, 0], n, headField),
      );
    }
    // The head's field is the P4.5 centre-distance one, written out here: push
    // s G (p − d) + s D v with s = strength f², f = 1 − |p − d|² / R², and the stretch
    // (1 + a)(1 + a − 4 G / R² strength f |t|²), a = s G, for any stroke shape.
    const v: V3 = [0.5, 0.3, 0];
    const moving = slotField(HEAD_SLOT, {
      position: [0, 0, -0.1],
      velocity: v,
      strength: HEAD_STRENGTH,
    });
    const rand = mulberry32(3);
    for (let k = 0; k < 200; k++) {
      const p: V3 = [1.2 * rand() - 0.6, 1.2 * rand() - 0.6, 0];
      const shape: StrokeShape = {
        long: norm([rand() - 0.5, rand() - 0.5, 0]),
        halfSize: [2 * rand(), 0.5 * rand()],
      };
      const e: V3 = [p[0], p[1], p[2] + 0.1];
      const f = Math.max(1 - dot(e, e) / (HEAD_RADIUS * HEAD_RADIUS), 0);
      const s = HEAD_STRENGTH * f * f;
      const want = [0, 1].map((a) => s * HEAD_PUSH_GAIN * e[a] + s * HEAD_DRAG_S * v[a]);
      const a = s * HEAD_PUSH_GAIN;
      const t2 = p[0] * p[0] + p[1] * p[1];
      const squeeze = ((4 * HEAD_PUSH_GAIN) / (HEAD_RADIUS * HEAD_RADIUS)) * HEAD_STRENGTH * f * t2;
      const gain = Math.min(
        Math.sqrt(Math.max((1 + a) * (1 + a - squeeze), 1)) - 1,
        REACTIVE_MAX_GAIN,
      );
      const got = reactiveMotion(p, n, moving, 1, shape);
      expect(got.offset[0]).toBeCloseTo(want[0], 14);
      expect(got.offset[1]).toBeCloseTo(want[1], 14);
      expect(got.offset[2]).toBe(0);
      expect(got.gain).toBeCloseTo(gain, 12);
    }
    expect(DISTURBER_BOX_RADII[HEAD_SLOT]).toBe(HEAD_RADIUS);
    expect(DISTURBER_BOX_RADII[HAND_SLOT]).toBeCloseTo(
      HAND_RADIUS + Math.SQRT2 * HAND_HALF_SIZE_CAP,
      12,
    );
  });

  test("a hand's push plus drag never folds the surface, up to the largest speed", () => {
    const n: V3 = [0, 0, 1];
    const radius = HAND_RADIUS;
    const h = 1e-6;
    let least = Number.POSITIVE_INFINITY;
    // Strokes of one size and orientation: a point, a cypress-like and a long ground stroke, the
    // last two along x and turned 30°, with the hand dragging along x or across.
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const shapes: StrokeShape[] = [
      POINT_STROKE,
      { long: [1, 0, 0], halfSize: [0.175, 0.05] },
      { long: [c, s, 0], halfSize: [0.175, 0.05] },
      { long: [1, 0, 0], halfSize: [1.3, 0.1] },
      { long: [c, s, 0], halfSize: [1.3, 0.1] },
    ];
    for (const shape of shapes)
      for (const [speed, vx, vy] of [
        [0, 1, 0],
        [1.5, 1, 0],
        [REACTIVE_MAX_SPEED, 1, 0],
        [REACTIVE_MAX_SPEED, 0, 1],
      ]) {
        const field = slotField(HAND_SLOT, {
          position: [0, 0, 0],
          velocity: [speed * vx, speed * vy, 0],
          strength: HAND_STRENGTH,
        });
        const at = (x: number, y: number) => reactiveMotion([x, y, 0], n, field, 1, shape).offset;
        // The field reads the half-size capped, so the grid spans only what can move.
        const span = radius + Math.min(Math.max(...shape.halfSize), HAND_HALF_SIZE_CAP);
        for (let i = 0; i <= 60; i++) {
          for (let k = 0; k <= 60; k++) {
            const x = (i / 30 - 1) * 1.05 * span;
            const y = (k / 30 - 1) * 1.05 * span;
            const ux = at(x + h, y);
            const uxm = at(x - h, y);
            const uy = at(x, y + h);
            const uym = at(x, y - h);
            const j11 = 1 + (ux[0] - uxm[0]) / (2 * h);
            const j21 = (ux[1] - uxm[1]) / (2 * h);
            const j12 = (uy[0] - uym[0]) / (2 * h);
            const j22 = 1 + (uy[1] - uym[1]) / (2 * h);
            least = Math.min(least, j11 * j22 - j12 * j21);
          }
        }
      }
    expect(least).toBeGreaterThan(0);
  });

  test('strokes grow by the square root of the push areal stretch, so spread-apart strokes still cover (R-P4o)', () => {
    const n: V3 = [0, 0, 1];
    // One still hand on the surface: the foot point stretches by (1 + PUSH_GAIN)² in area.
    const still = { position: [0, 0, 0] as V3, velocity: [0, 0, 0] as V3, strength: HAND_STRENGTH };
    const onSurface = slotField(HAND_SLOT, still);
    expect(reactiveMotion([0, 0, 0], n, onSurface).gain).toBeCloseTo(HAND_PUSH_GAIN, 12);
    expect(reactiveMotion([0, 0, 0], n, slotField(HEAD_SLOT, still)).gain).toBeCloseTo(
      HEAD_PUSH_GAIN,
      12,
    );
    // Against a finite-difference Jacobian of the offset field in the plane, for one disturber in
    // the head slot or a hand slot, at its own strength, at depths 0 to a third of its radius behind
    // the surface (the reach clamp and the cap never bind for one still disturber).
    const h = 1e-6;
    let checked = 0;
    for (const slot of [HEAD_SLOT, HAND_SLOT])
      for (const depth of [0, 1 / 12, 1 / 6, 1 / 3].map((k) => k * DISTURBER_RADII[slot])) {
        const field = slotField(slot, {
          position: [0, 0, -depth],
          velocity: [0, 0, 0],
          strength: DISTURBER_STRENGTHS[slot],
        });
        for (let k = 0; k <= 40; k++) {
          const r = (k / 40) * 1.2 * DISTURBER_RADII[slot];
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
    // A hand over an extended stroke: the lever and the quad distance in the gain's radial term.
    const shape: StrokeShape = { long: [1, 0, 0], halfSize: [0.175, 0.05] };
    for (const depth of [0, 0.02, 0.05]) {
      const field = slotField(HAND_SLOT, {
        position: [0, 0, -depth],
        velocity: [0, 0, 0],
        strength: HAND_STRENGTH,
      });
      for (let k = 1; k <= 40; k++) {
        const r = (k / 40) * 0.35;
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ]) {
          // Along a ray from the hand, the field is radial with a radially varying magnitude:
          // the reference gain is the radial-stretch formula, so check it against the Jacobian.
          const at = (x: number, y: number) => reactiveMotion([x, y, 0], n, field, 1, shape).offset;
          const x0 = r * dx;
          const y0 = r * dy;
          const ux = at(x0 + h, y0);
          const uxm = at(x0 - h, y0);
          const uy = at(x0, y0 + h);
          const uym = at(x0, y0 - h);
          const j11 = 1 + (ux[0] - uxm[0]) / (2 * h);
          const j21 = (ux[1] - uxm[1]) / (2 * h);
          const j12 = (uy[0] - uym[0]) / (2 * h);
          const j22 = 1 + (uy[1] - uym[1]) / (2 * h);
          // On an axis the field's tangential derivative is the radial one's partner only for a
          // centred shape; the quad's symmetry about both axes keeps the off-diagonals at 0.
          expect(Math.abs(j12) + Math.abs(j21)).toBeLessThan(1e-6);
          const area = j11 * j22;
          const expected = Math.min(Math.sqrt(Math.max(area, 1)) - 1, REACTIVE_MAX_GAIN);
          expect(reactiveMotion([x0, y0, 0], n, field, 1, shape).gain).toBeCloseTo(expected, 3);
          checked++;
        }
      }
    }
    expect(checked).toBe(328 + 240);
    // Calm scales the push, so the growth follows it down; none at calm 0.
    const full = reactiveMotion([0.03, 0, 0], n, onSurface, 1).gain;
    const half = reactiveMotion([0.03, 0, 0], n, onSurface, 0.5).gain;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
    expect(reactiveMotion([0.03, 0, 0], n, onSurface, 0).gain).toBe(0);
    // Every disturber stacked on one point is capped.
    expect(1 + HAND_PUSH_GAIN).toBeLessThan(1 + REACTIVE_MAX_GAIN);
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
    const at = (slot: number, strength: number, r: number): number =>
      Math.hypot(
        ...reactiveMotion(
          [r, 0, 0],
          [0, 0, 1],
          slotField(slot, { position: [0, 0, 0], velocity: [0, 0, 0], strength }),
        ).offset,
      );
    for (const slot of [HEAD_SLOT, HAND_SLOT]) {
      // Close in, where the reach clamp does not bind even at strength 1.
      const r = 0.2 * DISTURBER_RADII[slot];
      expect(at(slot, HEAD_STRENGTH, r)).toBeCloseTo(
        HEAD_STRENGTH * at(slot, HAND_STRENGTH, r),
        12,
      );
    }
    // The head's own push, over its radius, is under two-thirds of a hand's over its radius.
    const head = at(HEAD_SLOT, HEAD_STRENGTH, HEAD_RADIUS / Math.sqrt(5)) / HEAD_RADIUS;
    const hand = at(HAND_SLOT, HAND_STRENGTH, HAND_RADIUS / Math.sqrt(5)) / HAND_RADIUS;
    expect(head).toBeLessThan((2 / 3) * hand);
  });

  test('the wake swirls strokes about their normal and turns them with it', () => {
    for (const slot of [HEAD_SLOT, HAND_SLOT]) {
      const radius = DISTURBER_RADII[slot];
      const field = slotField(slot, OFF, [{ position: [0, 0, 0], weight: 1 }]);
      const r = radius / 3;
      const m = reactiveMotion([r, 0, 0], [0, 0, 1], field);
      // A counter-clockwise turn about +z moves a point on +x towards +y.
      expect(m.offset[0]).toBeCloseTo(0, 12);
      expect(m.offset[1]).toBeGreaterThan(0);
      expect(m.offset[1]).toBeCloseTo(r * m.turn, 12);
      // The sample's own slot's swirl and radius.
      expect(m.turn).toBeCloseTo(DISTURBER_SWIRLS[slot] * reactiveFalloff(1 / 9), 12);
      // Nothing past that radius.
      expect(reactiveMotion([radius * 1.001, 0, 0], [0, 0, 1], field).turn).toBe(0);
    }
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
      min: [-HEAD_RADIUS, 1.6 - HEAD_RADIUS, -HEAD_RADIUS],
      max: [HEAD_RADIUS, 1.6 + HEAD_RADIUS, HEAD_RADIUS],
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

  test('the box holds every disturber and weighted sample grown by its own radius; outside it the full function is exactly 0', () => {
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
      // A stroke of any size up to 4 m in its plane: the hand reads it capped.
      const t = norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
      const l = norm([t[0] - n[0] * dot(t, n), t[1] - n[1] * dot(t, n), t[2] - n[2] * dot(t, n)]);
      const shape: StrokeShape = { long: l, halfSize: [2 * rand(), 0.5 * rand()] };
      const m = reactiveMotion(p, n, field, 1, shape);
      if (insideReactiveBox(tracker.uniforms, p)) {
        inside++;
        continue;
      }
      expect(m.offset).toEqual([0, 0, 0]);
      expect(m.turn).toBe(0);
    }
    expect(inside).toBeGreaterThan(100);
    // Every disturber is at least its own box radius inside the box, and every weighted sample
    // its own disturber's radius.
    const box = tracker.diag().box;
    if (!box) throw new Error('expected a box');
    const points: [readonly number[], number][] = [
      ...field.disturbers.flatMap((d, j): [readonly number[], number][] =>
        d.strength > 0 ? [[d.position, DISTURBER_BOX_RADII[j]]] : [],
      ),
      ...field.wake.flatMap((w, k): [readonly number[], number][] =>
        w.weight > 0 ? [[w.position, DISTURBER_RADII[Math.floor(k / WAKE_SAMPLES)]]] : [],
      ),
    ];
    expect(points.length).toBeGreaterThan(3);
    for (const [point, radius] of points) {
      for (let a = 0; a < 3; a++) {
        expect(point[a] - box.min[a]).toBeGreaterThanOrEqual(radius - 1e-9);
        expect(box.max[a] - point[a]).toBeGreaterThanOrEqual(radius - 1e-9);
      }
    }
    // A hand alone grows the box by its own box radius only.
    const handOnly = createReactiveTracker();
    handOnly.frame(0, [null, [1, 1, 1], null]);
    const handBox = handOnly.diag().box;
    if (!handBox) throw new Error('expected a box');
    for (let a = 0; a < 3; a++) {
      expect(handBox.min[a]).toBeCloseTo(1 - DISTURBER_BOX_RADII[HAND_SLOT], 12);
      expect(handBox.max[a]).toBeCloseTo(1 + DISTURBER_BOX_RADII[HAND_SLOT], 12);
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
    // Per-slot constants: head, then the two hands.
    const slots = (name: string): number[] => {
      const value = String(a.defines[name]);
      const match = /^float\[3\]\((.*)\)$/.exec(value);
      if (!match) throw new Error(`${name}: ${value}`);
      return match[1].split(',').map(Number);
    };
    const inv = slots('REACTIVE_INV_RADIUS2');
    DISTURBER_RADII.forEach((r, j) => {
      expect(inv[j]).toBeCloseTo(1 / (r * r), 6);
    });
    expect(slots('REACTIVE_LEVER')).toEqual([...DISTURBER_LEVERS]);
    expect(slots('REACTIVE_HALF_CAP')).toEqual([...DISTURBER_HALF_SIZE_CAPS]);
    expect(slots('REACTIVE_PUSH_GAIN')).toEqual([...DISTURBER_PUSH_GAINS]);
    expect(slots('REACTIVE_DRAG_S')).toEqual([...DISTURBER_DRAGS_S]);
    expect(slots('REACTIVE_SWIRL')).toEqual([...DISTURBER_SWIRLS]);
    expect(a.defines.REACTIVE_WAKE_PER_SLOT).toBe(WAKE_SAMPLES);
    expect(a.defines).toMatchObject(reactiveGlslDefines());
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
      'const float REACTIVE_SLOT_INV_R2[REACTIVE_DISTURBERS] = REACTIVE_INV_RADIUS2;',
      'const float REACTIVE_SLOT_PUSH[REACTIVE_DISTURBERS] = REACTIVE_PUSH_GAIN;',
      'const float REACTIVE_SLOT_DRAG[REACTIVE_DISTURBERS] = REACTIVE_DRAG_S;',
      'const float REACTIVE_SLOT_SWIRL[REACTIVE_DISTURBERS] = REACTIVE_SWIRL;',
      'const float REACTIVE_SLOT_LEVER[REACTIVE_DISTURBERS] = REACTIVE_LEVER;',
      'const float REACTIVE_SLOT_HALF_CAP[REACTIVE_DISTURBERS] = REACTIVE_HALF_CAP;',
      'vec3 sAxis = cross(n, l);',
      'vec2 hs = min(halfSize, vec2(REACTIVE_SLOT_HALF_CAP[j]));',
      'vec2 ax = abs(vec2(dot(e, l), dot(e, sAxis)));',
      'vec2 inPlane = max(ax - hs, 0.0);',
      'if (REACTIVE_SLOT_HALF_CAP[j] > 0.0) {',
      'float q2 = e2;',
      'q2 = e2 - dot(ax - inPlane, ax + inPlane);',
      'float f = max(1.0 - q2 * invR2, 0.0);',
      'm = min(1.0, REACTIVE_SLOT_LEVER[j] * ir);',
      'lever = m < 1.0 ? tangent * ir * ir : 0.0;',
      'float sg = s * g * m;',
      'offset += sg * e + (s * REACTIVE_SLOT_DRAG[j]) * uDisturberVelocities[j].xyz;',
      'spread += sg;',
      'float tangent = e2 - en * en;',
      'qDrop = tangent - dot(ax, ax - inPlane);',
      'squeeze += g * m * (4.0 * invR2 * sf * qDrop + s * lever);',
      'Motion r = reactiveMotion(p, n, l, halfSize);',
      'float invR2 = REACTIVE_SLOT_INV_R2[j];',
      'float k = REACTIVE_SLOT_SWIRL[j];',
      'vec4 w = uWake[j * REACTIVE_WAKE_PER_SLOT + i];',
      'vec3 e = p - w.xyz;',
      'float f = max(1.0 - dot(e, e) * invR2, 0.0);',
      'float t = w.w * k * f * f;',
      'float a = uCalm * spread;',
      'offset += cross(n, swirl);',
      'offset -= n * dot(n, offset);',
      'offset *= min(1.0, REACTIVE_REACH * inversesqrt(max(dot(offset, offset), 1e-12)));',
      'float stretch = (1.0 + a) * (1.0 + a - uCalm * squeeze);',
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
