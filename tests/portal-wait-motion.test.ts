/**
 * The portal's wait cues (wait-motion.ts): the fly style's swirl keeps its strokes moving with no
 * net rotation about the eye, and the fade style's pulse field never moves.
 */
import { describe, expect, test } from 'vitest';
import { createLeg, FLY_COUNT, flightFrame, legProgress } from '../src/portal/fly-strokes.ts';
import {
  CUE_DIM_HIGH,
  CUE_DIM_LOW,
  createCueField,
  cueBrightness,
  cueFrame,
  planSwirl,
  type Swirl,
  swirlOffsets,
} from '../src/portal/wait-motion.ts';
import type { Vec3 } from '../src/render/strokes/frame.ts';

const EYE: Vec3 = [0, 1.6, 0];
const COUNT = 3000;

/** A deterministic random in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points on a `width` × `height` frame `distance` ahead of the eye along `yaw`. */
function framePoints(
  distance: number,
  width: number,
  height: number,
  yaw = 0,
  seed = 1,
): Float32Array {
  const random = rng(seed);
  const out = new Float32Array(COUNT * 3);
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  for (let i = 0; i < COUNT; i++) {
    const s = (random() - 0.5) * width;
    const h = (random() - 0.5) * height;
    out[i * 3] = EYE[0] + fx * distance + fz * -s;
    out[i * 3 + 1] = EYE[1] + h;
    out[i * 3 + 2] = EYE[2] + fz * distance + fx * s;
  }
  return out;
}

/** Points in a view frustum 2-20 m out, as a return from a world samples its strokes. */
function viewPoints(halfFovX: number, halfFovY: number, seed = 2): Float32Array {
  const random = rng(seed);
  const out = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    const x = Math.tan(halfFovX) * (2 * random() - 1);
    const y = Math.tan(halfFovY) * (2 * random() - 1);
    const l = Math.hypot(x, y, 1);
    const d = 2 + 18 * random();
    out[i * 3] = EYE[0] + (x / l) * d;
    out[i * 3 + 1] = EYE[1] + (y / l) * d;
    out[i * 3 + 2] = EYE[2] - (1 / l) * d;
  }
  return out;
}

/** The swirl the switcher plans for strokes leaving `from`, and the anchors it hovers them at. */
function plan(from: Float32Array, seed = 7): { swirl: Swirl; anchors: Float32Array } {
  const anchors = new Float32Array(from.length);
  const swirl = planSwirl(from, EYE, 0.9, 1.6, rng(seed), anchors);
  return { swirl, anchors };
}

interface Spin {
  /** |mean over strokes of (r × v) / |r|²|, rad/s, averaged over the sampled times. */
  netOmega: number;
  /** Mean over strokes of |(r × v) / |r|²|, rad/s. */
  meanOmega: number;
  /** |mean over strokes of v|, m/s, the worst sampled time. */
  netVelocity: number;
  /** Mean over strokes of |v|, m/s. */
  meanSpeed: number;
  /** The worst sampled |mean ω|, rad/s. */
  worstNetOmega: number;
  /** Mean |ω| of the strokes within 30° of straight ahead, rad/s. */
  centralOmega: number;
}

/** Angular velocities about the eye by central difference, over `times`. */
function spin(swirl: Swirl, anchors: Float32Array, times: readonly number[]): Spin {
  const h = 1e-3;
  const a = new Float32Array(COUNT * 3);
  const b = new Float32Array(COUNT * 3);
  const p = new Float32Array(COUNT * 3);
  let net = 0;
  let worst = 0;
  let mean = 0;
  let central = 0;
  let centralCount = 0;
  let netVelocity = 0;
  let speed = 0;
  for (const t of times) {
    swirlOffsets(swirl, t - h, a);
    swirlOffsets(swirl, t + h, b);
    swirlOffsets(swirl, t, p);
    let wx = 0;
    let wy = 0;
    let wz = 0;
    let vxs = 0;
    let vys = 0;
    let vzs = 0;
    for (let i = 0; i < COUNT; i++) {
      const i3 = i * 3;
      const rx = anchors[i3] + p[i3] - EYE[0];
      const ry = anchors[i3 + 1] + p[i3 + 1] - EYE[1];
      const rz = anchors[i3 + 2] + p[i3 + 2] - EYE[2];
      const vx = (b[i3] - a[i3]) / (2 * h);
      const vy = (b[i3 + 1] - a[i3 + 1]) / (2 * h);
      const vz = (b[i3 + 2] - a[i3 + 2]) / (2 * h);
      const r2 = rx * rx + ry * ry + rz * rz;
      const ox = (ry * vz - rz * vy) / r2;
      const oy = (rz * vx - rx * vz) / r2;
      const oz = (rx * vy - ry * vx) / r2;
      wx += ox;
      wy += oy;
      wz += oz;
      vxs += vx;
      vys += vy;
      vzs += vz;
      speed += Math.hypot(vx, vy, vz);
      const o = Math.hypot(ox, oy, oz);
      mean += o;
      if (-rz / Math.sqrt(r2) > Math.cos(Math.PI / 6)) {
        central += o;
        centralCount++;
      }
    }
    const n = Math.hypot(wx, wy, wz) / COUNT;
    net += n;
    worst = Math.max(worst, n);
    netVelocity = Math.max(netVelocity, Math.hypot(vxs, vys, vzs) / COUNT);
  }
  return {
    netOmega: net / times.length,
    worstNetOmega: worst,
    meanOmega: mean / (COUNT * times.length),
    netVelocity,
    meanSpeed: speed / (COUNT * times.length),
    centralOmega: central / Math.max(1, centralCount),
  };
}

/** 0.25 s steps over 20 s: several turns of every core. */
const TIMES = Array.from({ length: 80 }, (_, k) => 0.25 * (k + 1));

const CLOUDS: readonly [string, Float32Array][] = [
  // Triggered by a teleport from the gallery spawn, 4 m from Starry Night's frame.
  ['from 4 m', framePoints(4, 0.92 + 0.14, 0.74 + 0.14)],
  // Walked in: the head in the threshold, the frame filling the view.
  ['walked in', framePoints(0.5, 1.06, 0.88, 0, 3)],
  ['walked in at a slant', framePoints(0.8, 1.06, 0.88, 0.5, 4)],
  // A return from a world: its strokes in view.
  ['return', viewPoints(0.6, 0.45)],
];

describe('the fly swirl', () => {
  test.each(CLOUDS)(
    '%s: no net rotation about the eye, and every stroke still moves visibly',
    (label, from) => {
      const { swirl, anchors } = plan(from);
      const s = spin(swirl, anchors, TIMES);
      if (process.env.SWIRL_REPORT) console.log(label, JSON.stringify(s));
      // Per stroke the swirl reads clearly: about 3° a second or more about the eye, in the
      // middle of the view too.
      expect(s.meanOmega).toBeGreaterThan(0.05);
      expect(s.centralOmega).toBeGreaterThan(0.05);
      // As a whole it turns nowhere: the mirrored fours cancel exactly, so what is left is
      // float rounding, under 1e-4 rad/s at every sampled time and 0.5% of the strokes' own.
      expect(s.worstNetOmega).toBeLessThan(1e-4);
      expect(s.netOmega).toBeLessThan(0.005 * s.meanOmega);
      // Nor does it slide: the strokes' mean velocity stays under 12% of their speed.
      expect(s.netVelocity).toBeLessThan(0.12 * s.meanSpeed);
    },
  );

  test('starts at rest on its anchors, keeps each stroke at its distance and never drifts', () => {
    const { swirl, anchors } = plan(CLOUDS[0][1]);
    const out = new Float32Array(COUNT * 3);
    swirlOffsets(swirl, 0, out);
    expect(Math.max(...out.map(Math.abs))).toBe(0);
    let worstDrift = 0;
    let worstReach = 0;
    for (const t of [0.5, 3, 10, 30, 120]) {
      swirlOffsets(swirl, t, out);
      for (let i = 0; i < COUNT; i++) {
        const i3 = i * 3;
        const ax = anchors[i3] - EYE[0];
        const ay = anchors[i3 + 1] - EYE[1];
        const az = anchors[i3 + 2] - EYE[2];
        const before = Math.hypot(ax, ay, az);
        const after = Math.hypot(ax + out[i3], ay + out[i3 + 1], az + out[i3 + 2]);
        worstDrift = Math.max(worstDrift, Math.abs(after - before));
        const reach = Math.hypot(out[i3], out[i3 + 1], out[i3 + 2]);
        const bound = 2 * Math.hypot(swirl.b[i3], swirl.b[i3 + 1], swirl.b[i3 + 2]);
        worstReach = Math.max(worstReach, reach - bound);
      }
    }
    // A turn about an axis through the eye: no looming.
    expect(worstDrift).toBeLessThan(1e-5);
    // Each stroke stays on its own circle, never farther from its anchor than the circle's
    // diameter, however long.
    expect(worstReach).toBeLessThan(1e-6);
  });

  test.each(CLOUDS)(
    '%s: half the strokes turn each way, and each stays near its own line',
    (label, from) => {
      const { swirl, anchors } = plan(from);
      const positive = swirl.rate.filter((r) => r > 0).length;
      const negative = swirl.rate.filter((r) => r < 0).length;
      // Every stroke here falls in a filled eight: none is left still.
      expect(positive).toBe(negative);
      expect(positive + negative).toBe(COUNT);
      // Each stroke takes the free slot nearest its own view direction, so the hovering cloud keeps
      // the painting's colours where they were: a stroke leaves its own line by under 0.2 rad on
      // average (0.12 to 0.17 here, against 0.73 walked in when each slot took the next stroke).
      // The frame from 4 m is spread to the least half-extent first, so its strokes move out by that.
      if (label === 'from 4 m') return;
      let off = 0;
      for (let i = 0; i < COUNT; i++) {
        const i3 = i * 3;
        const a = [from[i3] - EYE[0], from[i3 + 1] - EYE[1], from[i3 + 2] - EYE[2]];
        const b = [anchors[i3] - EYE[0], anchors[i3 + 1] - EYE[1], anchors[i3 + 2] - EYE[2]];
        const cos =
          (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
        off += Math.acos(Math.min(1, cos));
      }
      expect(off / COUNT).toBeLessThan(0.2);
    },
  );
});

describe('the hand-offs (flightFrame)', () => {
  /** An out leg off a frame 4 m ahead to its anchors, and an in leg from them out to 20 m. */
  function legs() {
    const random = rng(9);
    const out = createLeg();
    const into = createLeg();
    for (let i = 0; i < FLY_COUNT; i++) {
      const i3 = i * 3;
      out.from[i3] = (random() - 0.5) * 0.9;
      out.from[i3 + 1] = 1.6 + (random() - 0.5) * 0.7;
      out.from[i3 + 2] = -4;
    }
    const swirl = planSwirl(out.from, EYE, 0.9, 1.6, rng(7), out.to);
    const anchors = out.to;
    for (let i = 0; i < FLY_COUNT; i++) {
      const i3 = i * 3;
      into.from.set(anchors.subarray(i3, i3 + 3), i3);
      into.to[i3] = (random() - 0.5) * 30;
      into.to[i3 + 1] = random() * 10;
      into.to[i3 + 2] = -random() * 20;
      for (let c = 0; c < 3; c++) {
        out.fromColor[i3 + c] = 40 + c * 50;
        out.toColor[i3 + c] = out.fromColor[i3 + c];
        into.fromColor[i3 + c] = out.toColor[i3 + c];
        into.toColor[i3 + c] = 200 - c * 40;
      }
      out.fromSize.set([0.035, 0.014], i * 2);
      out.toSize.set([0.035, 0.014], i * 2);
      into.fromSize.set([0.035, 0.014], i * 2);
      into.toSize.set([0.2, 0.08], i * 2);
      out.arc[i] = 0.1 * random();
      into.arc[i] = 0.3 * random();
    }
    return { swirl, out, into };
  }

  const frame = () => ({
    positions: new Float32Array(FLY_COUNT * 3),
    colors: new Uint8Array(FLY_COUNT * 3),
    sizes: new Float32Array(FLY_COUNT * 2),
  });

  test.each([
    ['0 ms', 0.6],
    ['1 frame', 0.6 + 1 / 72],
    ['3 s', 3.6],
    ['12 s', 12.6],
  ])('a %s wait: the in leg starts exactly where the wait leaves each stroke', (_label, clock) => {
    const { swirl, out, into } = legs();
    const drift = new Float32Array(FLY_COUNT * 3);
    swirlOffsets(swirl, clock, drift);
    const waiting = frame();
    flightFrame(out, 1, 0, drift, 'arrive', waiting.positions, waiting.colors, waiting.sizes);
    const arriving = frame();
    flightFrame(into, 0, 0, drift, 'leave', arriving.positions, arriving.colors, arriving.sizes);
    for (let i = 0; i < FLY_COUNT * 3; i++) {
      expect(Math.abs(arriving.positions[i] - waiting.positions[i])).toBeLessThan(1e-6);
    }
    expect(arriving.colors).toEqual(waiting.colors);
    expect(arriving.sizes).toEqual(waiting.sizes);
  });

  test('the swirl weighs in from liftoff: at t = 0 out of the frame nothing moves off it', () => {
    const { swirl, out } = legs();
    const drift = new Float32Array(FLY_COUNT * 3);
    swirlOffsets(swirl, 0.3, drift);
    const lifted = frame();
    flightFrame(out, 0, 0, drift, 'arrive', lifted.positions, lifted.colors, lifted.sizes);
    for (let i = 0; i < FLY_COUNT * 3; i++) expect(lifted.positions[i]).toBe(out.from[i]);
    // Every stroke has arrived by the end of the out leg, so the wait gets the whole offset.
    for (let i = 0; i < FLY_COUNT; i++) expect(legProgress(i, 1)).toBe(1);
  });
});

describe('the fade pulse field', () => {
  test('never moves: its positions are fixed, only brightness and size change', () => {
    const field = createCueField(EYE, [0, 0, -1]);
    const before = field.positions.slice();
    const colors = new Uint8Array(field.count * 3);
    const sizes = new Float32Array(field.count * 2);
    const seen = new Set<number>();
    for (let t = 0; t < 12; t += 0.1) {
      cueFrame(field, cueBrightness(t), 1, colors, sizes);
      seen.add(colors[0]);
    }
    expect(field.positions).toEqual(before);
    // It does pulse.
    expect(seen.size).toBeGreaterThan(5);
  });

  test('is dim, breathes slowly from its low and sits in front, 2.6-4 m out', () => {
    expect(cueBrightness(0)).toBeCloseTo(CUE_DIM_LOW, 9);
    for (let t = 0; t < 20; t += 0.05) {
      const b = cueBrightness(t);
      expect(b).toBeGreaterThanOrEqual(CUE_DIM_LOW - 1e-9);
      expect(b).toBeLessThanOrEqual(CUE_DIM_HIGH + 1e-9);
      // Slow: under 0.6 a second (the breath's peak rate is 0.3 × π / 5).
      expect(Math.abs(cueBrightness(t + 0.01) - b) / 0.01).toBeLessThan(0.6);
    }
    const field = createCueField(EYE, [0, 0, -1]);
    for (let i = 0; i < field.count; i++) {
      const x = field.positions[i * 3] - EYE[0];
      const y = field.positions[i * 3 + 1] - EYE[1];
      const z = field.positions[i * 3 + 2] - EYE[2];
      const d = Math.hypot(x, y, z);
      expect(d).toBeGreaterThan(2.6 - 1e-4);
      expect(d).toBeLessThan(4 + 1e-4);
      expect(-z / d).toBeGreaterThan(Math.cos((65 * Math.PI) / 180) - 1e-4);
    }
  });

  test('a grow of 0 hides every quad', () => {
    const field = createCueField(EYE, [1, 0, 0]);
    const colors = new Uint8Array(field.count * 3);
    const sizes = new Float32Array(field.count * 2);
    cueFrame(field, 0.5, 0, colors, sizes);
    expect(Math.max(...sizes)).toBe(0);
  });
});
