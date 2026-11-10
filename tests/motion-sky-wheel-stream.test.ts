/**
 * The `wheel`, `stream` and `wheelflow` sky wraps (2026-11-09, 2026-11-10, src/motion/variants.ts,
 * sky-swirl.ts): the wheel's rigid, periodic turn, its sense, rate and cull bound, and the GLSL's
 * quaternion form of it; the stream's layer weights, contrast compensation and fixed footprint;
 * wheelflow's per-stroke selection, edge fade and speed.
 */
import { Texture } from 'three';
import { describe, expect, test } from 'vitest';
import motionGlsl from '../src/motion/motion.glsl?raw';
import {
  perpendicular,
  rotateAbout,
  SKY_STREAM_FADE_LEVELS,
  SKY_STREAM_PERIOD,
  SKY_STREAM_RHOS,
  SKY_STREAM_SHIFT,
  SKY_STREAM_TONE_MEAN,
  SKY_SWIRL_PERIOD,
  SKY_VORTICES,
  SKY_WHEEL_CORE_SCALE,
  SKY_WHEEL_HAZE_FEATHER,
  SKY_WHEEL_RIM_GAIN,
  SKY_WHEEL_STROKE_HALF,
  SKY_WHEELFLOW_ALIGN,
  SKY_WHEELFLOW_ALIGN_BAND,
  SKY_WHEELFLOW_ALIGN_BLEND,
  SKY_WHEELFLOW_ALIGN_EASE,
  SKY_WHEELFLOW_BAND,
  SKY_WHEELFLOW_GAP,
  SKY_WHEELFLOW_MIN_SPEED,
  SKY_WHEELFLOW_PERIOD,
  SKY_WHEELS,
  type SkyWheel,
  skyStreamLevel,
  skyStreamPack,
  skyStreamPhase,
  skyStreamTone,
  skyStreamUnpack,
  skyStreamWeights,
  skySwirl,
  skySwirlGlslDefines,
  skySwirlReach,
  skyVelocity,
  skyWheelAngle,
  skyWheelAt,
  skyWheelCap,
  skyWheelEdge,
  skyWheelFlowGapFade,
  skyWheelFlowOuter,
  skyWheelFlowShift,
  skyWheelHazeThin,
  skyWheelReach,
  skyWheelSpin,
  skyWrapLoop,
} from '../src/motion/sky-swirl.ts';
import { motionVariants } from '../src/motion/variant-uniforms.ts';
import { SKY_WRAPS } from '../src/motion/variants.ts';
import { PAINTER_EYE } from '../src/paintings/starry-night/canvas-camera.ts';
import { WORLD_DOME_SIZE } from '../src/paintings/starry-night/world.ts';
import { DEFAULT_BAND_SIZE } from '../src/render/strokes/bands.ts';
import {
  ATLAS_SIZE,
  BRUSH_COUNT,
  brushTexelRect,
  DEFAULT_BRUSH_SEED,
  generateBrushAtlas,
} from '../src/render/strokes/brush-atlas-data.ts';
import type { Vec3 } from '../src/render/strokes/frame.ts';
import { createStrokeMaterial } from '../src/render/strokes/material.ts';
import strokeFrag from '../src/render/strokes/stroke.frag.glsl?raw';
import strokeVert from '../src/render/strokes/stroke.vert.glsl?raw';
import { mulberry32 } from '../src/util/prng.ts';
import { SKY_DOME_RADIUS } from '../src/world/sky.ts';

const fract = (x: number): number => x - Math.floor(x);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const onDome = (d: Vec3): Vec3 => [
  PAINTER_EYE[0] + SKY_DOME_RADIUS * d[0],
  PAINTER_EYE[1] + SKY_DOME_RADIUS * d[1],
  PAINTER_EYE[2] + SKY_DOME_RADIUS * d[2],
];
/** The angle from the axis of a direction at chord `chord` from it. */
const chordAngle = (chord: number): number => 2 * Math.asin(chord / 2);

/** The direction at `share` of wheel `w`'s radius from its axis, `turn` radians round it. */
function inWheel(w: SkyWheel, share: number, turn: number): Vec3 {
  const tilt = rotateAbout(w.axis, perpendicular(w.axis), share * chordAngle(w.radius));
  return rotateAbout(tilt, w.axis, turn);
}

/** The moved centre of the dome stroke in direction `dir` under wheel at motion time `time`. */
function wheelCentre(dir: Vec3, time: number): Vec3 {
  const p = onDome(dir);
  const m = skySwirl(p, [-dir[0], -dir[1], -dir[2]], 0, time, undefined, 'wheel');
  return [p[0] + m.offset[0], p[1] + m.offset[1], p[2] + m.offset[2]];
}

describe('wheel', () => {
  test('one wheel per vortex, half a far dome stroke inside SKY_WHEEL_CORE_SCALE of its core, with a still ring wider than a stroke between every pair', () => {
    expect(SKY_WHEELS).toHaveLength(SKY_VORTICES.length);
    expect(SKY_WHEEL_CORE_SCALE).toBe(0.95);
    // Half the dome stroke's angular length at the far band's size, the largest a dome stroke draws.
    expect(SKY_WHEEL_STROKE_HALF).toBeCloseTo(
      0.5 * WORLD_DOME_SIZE.slope * DEFAULT_BAND_SIZE.far,
      12,
    );
    const length = 2 * SKY_WHEEL_STROKE_HALF;
    const gaps: string[] = [];
    SKY_WHEELS.forEach((w, i) => {
      expect(chordAngle(w.radius)).toBeCloseTo(
        chordAngle(SKY_WHEEL_CORE_SCALE * SKY_VORTICES[i].core) - SKY_WHEEL_STROKE_HALF,
        12,
      );
      expect(w.axis).toBe(SKY_VORTICES[i].axis);
      for (let j = i + 1; j < SKY_WHEELS.length; j++) {
        const o = SKY_WHEELS[j];
        const apart = Math.acos(Math.min(1, dot(w.axis, o.axis)));
        // Between the two wheels' member centres, and between the farthest any of their strokes
        // reaches (half a stroke past a member centre, at any angle to the rim).
        const gap = apart - chordAngle(w.radius) - chordAngle(o.radius);
        const reach = gap - length;
        gaps.push(
          `${i}-${j} ${((gap * 180) / Math.PI).toFixed(3)} deg (reach ${((reach * 180) / Math.PI).toFixed(3)})`,
        );
        // More than one stroke length parts the members, so no two turning strokes can meet,
        // with at least 1 degree to spare.
        expect(reach, `${w.note} / ${o.note}`).toBeGreaterThan(Math.PI / 180);
      }
    });
    // The authored central cores nearly touch: under half a degree apart.
    const [a, b] = SKY_VORTICES;
    const coreGap = Math.acos(dot(a.axis, b.axis)) - chordAngle(a.core) - chordAngle(b.core);
    expect(coreGap).toBeLessThan((0.5 * Math.PI) / 180);
    console.log(
      `wheel gaps: ${gaps.join(', ')}; central cores ${((coreGap * 180) / Math.PI).toFixed(3)} deg apart`,
    );
  });

  test('the rate: a whole number of turns per hour, so a turn divides the uTime wrap, at about twice the field speed round the rim, the wave mean', () => {
    const rows: string[] = [];
    SKY_WHEELS.forEach((w, i) => {
      expect(Number.isInteger(w.turns)).toBe(true);
      expect(w.turns).toBeGreaterThan(0);
      // All four vortices turn clockwise as displayed, positive gamma.
      expect(Math.sign(w.turns)).toBe(Math.sign(SKY_VORTICES[i].gamma));
      expect(w.rate).toBe(w.turns / 3600);
      expect((3600 / w.period) % 1).toBeCloseTo(0, 9);
      const gain = w.rimSpeed / w.fieldRimSpeed;
      expect(gain).toBeGreaterThan(SKY_WHEEL_RIM_GAIN * 0.95);
      expect(gain).toBeLessThan(SKY_WHEEL_RIM_GAIN * 1.05);
      // The wave's own mean speed round the rim, from the TS mirror: mean |d offset / dt| over
      // one loop at 32 rim points, as seen from the eye (rad/s).
      let sum = 0;
      let count = 0;
      for (let k = 0; k < 32; k++) {
        const dir = inWheel(w, 1, (k / 32) * 2 * Math.PI);
        const p = onDome(dir);
        const n: Vec3 = [-dir[0], -dir[1], -dir[2]];
        const steps = 160;
        let prev = skySwirl(p, n, 0, 0, undefined, 'wave').offset;
        for (let s = 1; s <= steps; s++) {
          const o = skySwirl(p, n, 0, (s * SKY_SWIRL_PERIOD) / steps, undefined, 'wave').offset;
          sum += len(sub(o, prev)) / SKY_DOME_RADIUS;
          prev = o;
        }
        count++;
      }
      const waveMean = sum / count / SKY_SWIRL_PERIOD;
      rows.push(
        `${w.note}: ${w.turns} turns/h, ${w.period.toFixed(1)} s/turn, rim ${(w.rimSpeed * 1000).toFixed(2)} mrad/s (${(w.rimSpeed * SKY_DOME_RADIUS).toFixed(2)} m/s at the dome), field ${(w.fieldRimSpeed * 1000).toFixed(2)}, wave mean ${(waveMean * 1000).toFixed(2)}`,
      );
      // Calm: within 40% of the wave's measured mean speed at the same rim.
      expect(w.rimSpeed / waveMean).toBeGreaterThan(0.6);
      expect(w.rimSpeed / waveMean).toBeLessThan(1.4);
    });
    console.log(`wheel rates:\n${rows.join('\n')}`);
  });

  test('rigid inside a wheel: the distance between any two of its strokes holds at every time, so there is no shear', () => {
    const rand = mulberry32(11);
    SKY_WHEELS.forEach((w) => {
      for (let k = 0; k < 20; k++) {
        const a = inWheel(w, 0.98 * rand(), 2 * Math.PI * rand());
        const b = inWheel(w, 0.98 * rand(), 2 * Math.PI * rand());
        const rest = len(sub(onDome(a), onDome(b)));
        for (const time of [0.3, 17, 611.5, 3599.2]) {
          const moved = len(sub(wheelCentre(a, time), wheelCentre(b, time)));
          expect(Math.abs(moved - rest)).toBeLessThan(1e-9 * SKY_DOME_RADIUS);
        }
      }
    });
  });

  test('periodic: one turn per period, and no seam where uTime wraps at 3600 s', () => {
    SKY_WHEELS.forEach((w) => {
      const dir = inWheel(w, 0.7, 1.1);
      for (const time of [0, 5.5, 100]) {
        const a = wheelCentre(dir, time);
        const b = wheelCentre(dir, time + w.period);
        expect(len(sub(a, b))).toBeLessThan(1e-7 * SKY_DOME_RADIUS);
      }
      // Across the wrap: the step from 3600 - 1/180 to 1/180 is one 90 Hz frame's.
      const before = wheelCentre(dir, 3600 - 1 / 180);
      const after = wheelCentre(dir, 1 / 180);
      const step = len(sub(after, before));
      const frame = (w.rimSpeed * SKY_DOME_RADIUS) / 90;
      expect(step).toBeLessThan(1.01 * frame);
      expect(step).toBeGreaterThan(0);
    });
  });

  test('a stroke advances monotonically about its centre over a full turn with no reset, in the sense of the field', () => {
    SKY_WHEELS.forEach((w) => {
      for (const share of [0.2, 0.6, 0.95]) {
        const dir = inWheel(w, share, 0.4);
        const e1 = perpendicular(w.axis);
        const e2 = cross(w.axis, e1);
        const angleOf = (p: Vec3): number => {
          const d = sub(p, PAINTER_EYE);
          return Math.atan2(dot(d, e2), dot(d, e1));
        };
        const samples = 97;
        let previous = angleOf(wheelCentre(dir, 0));
        let total = 0;
        for (let k = 1; k <= samples; k++) {
          const now = angleOf(wheelCentre(dir, (k * w.period) / samples));
          let step = now - previous;
          step -= 2 * Math.PI * Math.round(step / (2 * Math.PI));
          // Every step forward, at the same size: no reset.
          expect(step).toBeCloseTo((2 * Math.PI) / samples, 6);
          total += step;
          previous = now;
        }
        expect(total).toBeCloseTo(2 * Math.PI, 6);
        // The vortex's own sense: clockwise as displayed, right-handed about its axis.
        const v = sub(wheelCentre(dir, 0.5), wheelCentre(dir, 0));
        expect(dot(v, cross(w.axis, dir)) * Math.sign(w.turns), w.note).toBeGreaterThan(0);
      }
    });
  });

  test('the stroke turns with the wheel: its axes turn rigidly, exactly, at any angle', () => {
    const w = SKY_WHEELS[0];
    const dir = inWheel(w, 0.5, 0.2);
    const spin = skyWheelSpin(dir, 0.37 * w.period);
    expect(spin?.wheel).toBe(0);
    if (!spin) return;
    expect(spin.angle).toBeCloseTo(0.37 * 2 * Math.PI, 9);
    const long: Vec3 = perpendicular(dir);
    const turned = rotateAbout(long, spin.axis, spin.angle);
    expect(len(turned)).toBeCloseTo(1, 12);
    // The turned axis keeps its angle to the turned direction: still tangent to the dome.
    const moved = rotateAbout(dir, spin.axis, spin.angle);
    expect(dot(turned, moved)).toBeCloseTo(dot(long, dir), 12);
  });

  test('outside the wheels every stroke holds still; stream moves no stroke; neither has an arc loop', () => {
    const rand = mulberry32(5);
    let outside = 0;
    for (let k = 0; k < 4000; k++) {
      const y = rand();
      const a = 2 * Math.PI * rand();
      const r = Math.sqrt(1 - y * y);
      const dir: Vec3 = [r * Math.cos(a), y, r * Math.sin(a)];
      const p = onDome(dir);
      const n: Vec3 = [-dir[0], -dir[1], -dir[2]];
      const time = 3600 * rand();
      const m = skySwirl(p, n, rand(), time, undefined, 'stream');
      expect(m.offset).toEqual([0, 0, 0]);
      expect([m.turn, m.gain, m.spin]).toEqual([0, 0, null]);
      if (skyWheelAt(dir) < 0) {
        outside++;
        expect(skySwirl(p, n, 0, time, undefined, 'wheel').offset).toEqual([0, 0, 0]);
        expect(skyWheelReach(...p)).toBe(0);
      }
    }
    expect(outside).toBeGreaterThan(3000);
    for (const wrap of ['wheel', 'stream'] as const) {
      expect(skyWrapLoop(wrap, 0.3, 4.1)).toEqual({ tau: 0, gain: 0, returning: false });
    }
  });

  test('the haze thin under wheel: no drawn haze quad crosses into a wheel it does not turn with (N1, N2)', () => {
    // Haze strokes 45-55 m out (boundary.ts), half diagonals from the near band's 1.6 m to the far
    // band's with full haze growth, about 4.1 m, centred within 6° of each wheel's rim, so both
    // the still strokes outside and the turning ones inside cross the edges.
    const rand = mulberry32(21);
    const angle = (a: Vec3, b: Vec3): number => Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
    let still = 0;
    let turning = 0;
    let thinned = 0;
    SKY_WHEELS.forEach((w) => {
      const edge = skyWheelEdge(w);
      for (let k = 0; k < 400; k++) {
        const off = edge + ((rand() * 2 - 1) * 6 * Math.PI) / 180;
        const e1 = perpendicular(w.axis);
        const dir = rotateAbout(
          rotateAbout(w.axis, e1, Math.max(0, off)),
          w.axis,
          2 * Math.PI * rand(),
        );
        const dist = 45 + 10 * rand();
        const p: Vec3 = [
          PAINTER_EYE[0] + dist * dir[0],
          PAINTER_EYE[1] + dist * dir[1],
          PAINTER_EYE[2] + dist * dir[2],
        ];
        const half = 1.6 + 2.5 * rand();
        const time = 3600 * rand();
        const thin = skyWheelHazeThin(p, half, time);
        expect(thin).toBeGreaterThanOrEqual(0);
        expect(thin).toBeLessThanOrEqual(1);
        const member = skyWheelAt(dir);
        member < 0 ? still++ : turning++;
        if (thin === 0) {
          thinned++;
          continue;
        }
        // The quad's angular half extent is at most atan(half / dist) < half / dist.
        const h = Math.atan(half / dist);
        const seen =
          member < 0
            ? dir
            : rotateAbout(dir, SKY_WHEELS[member].axis, skyWheelAngle(SKY_WHEELS[member], time));
        SKY_WHEELS.forEach((o, j) => {
          if (j === member) return;
          // Still haze clears every wheel's turning members; turning haze clears the other
          // wheels' 0.95 caps, which their turning dome strokes reach.
          const bound = member < 0 ? skyWheelEdge(o) : skyWheelCap(o);
          expect(angle(o.axis, seen) - h, `wheel ${j}`).toBeGreaterThan(bound);
        });
      }
    });
    expect(still).toBeGreaterThan(200);
    expect(turning).toBeGreaterThan(200);
    expect(thinned).toBeGreaterThan(100);
    // At rest outside every wheel's reach, the thin is 1.
    const far = SKY_WHEELS[0].axis.map((x) => -x) as unknown as Vec3;
    expect(
      skyWheelHazeThin(
        onDome(far).map((x, i) => PAINTER_EYE[i] + (x - PAINTER_EYE[i]) * 0.4) as unknown as Vec3,
        2,
        10,
      ),
    ).toBe(1);
    // The GLSL tables and steps are the mirror's.
    const defines = skySwirlGlslDefines();
    const table = (name: string): number[] =>
      String(defines[name])
        .replace(/^float\[\d+\]\(|\)$/g, '')
        .split(', ')
        .map(Number);
    SKY_WHEELS.forEach((o, i) => {
      expect(table('SKY_WHEEL_EDGES')[i]).toBeCloseTo(skyWheelEdge(o), 8);
      expect(table('SKY_WHEEL_CAPS')[i]).toBeCloseTo(skyWheelEdge(o) + SKY_WHEEL_STROKE_HALF, 8);
    });
    expect(Number(defines.SKY_WHEEL_HAZE_FEATHER)).toBeCloseTo(SKY_WHEEL_HAZE_FEATHER, 9);
    for (const line of [
      'if (uSkyWrap != SKY_WRAP_WHEEL && uSkyWrap != SKY_WRAP_WHEELFLOW) return false;',
      'return member >= 0 || uSkyWrap == SKY_WRAP_WHEEL;',
      'if (1.0 - dot(SKY_VORTEX_AXIS[i].xyz, dir) < SKY_WHEEL_CORE[i]) member = i;',
      'skyWheelMotion(d, dir, n, l, s, uTime, rigid);',
      'vec3 seen = normalize(d + rigid);',
      'float h = halfExtent * inv;',
      'if (j == member) continue;',
      'float edge = member < 0 ? SKY_WHEEL_EDGE[j] : SKY_WHEEL_CAP[j];',
      'float theta = acos(clamp(dot(SKY_VORTEX_AXIS[j].xyz, seen), -1.0, 1.0));',
      'thin *= smoothstep(0.0, SKY_WHEEL_HAZE_FEATHER, theta - h - edge);',
    ]) {
      expect(motionGlsl).toContain(line);
    }
  });

  test('the boundary haze in front of a wheel turns with it: same axis, angle and rate, at its own distance', () => {
    // The haze shell sits 45-55 m from the spot (boundary.ts), well inside the 120 m dome.
    const rand = mulberry32(9);
    SKY_WHEELS.forEach((w, i) => {
      for (let k = 0; k < 20; k++) {
        const dir = inWheel(w, 0.999 * Math.sqrt(rand()), 2 * Math.PI * rand());
        const dist = 45 + 10 * rand();
        const d: Vec3 = [dist * dir[0], dist * dir[1], dist * dir[2]];
        const p: Vec3 = [PAINTER_EYE[0] + d[0], PAINTER_EYE[1] + d[1], PAINTER_EYE[2] + d[2]];
        const time = 3600 * rand();
        const haze = skySwirl(p, [-dir[0], -dir[1], -dir[2]], 0, time, undefined, 'wheel');
        const dome = skyWheelSpin(dir, time);
        expect(haze.spin).toEqual(dome);
        expect(haze.spin?.wheel).toBe(i);
        const moved = rotateAbout(d, w.axis, skyWheelAngle(w, time));
        for (let a = 0; a < 3; a++) expect(haze.offset[a]).toBeCloseTo(moved[a] - d[a], 9);
        expect(len(moved)).toBeCloseTo(dist, 9);
        expect(len(haze.offset)).toBeLessThanOrEqual(skyWheelReach(...p) * (1 + 1e-9));
      }
    });
  });

  test('the cull bound: each wheel stroke stays within skyWheelReach, 2ρ, which a half turn reaches', () => {
    const rand = mulberry32(3);
    const rows: string[] = [];
    SKY_WHEELS.forEach((w) => {
      let largest = 0;
      for (let k = 0; k < 40; k++) {
        const dir = inWheel(w, 0.999 * Math.sqrt(rand()), 2 * Math.PI * rand());
        const p = onDome(dir);
        const reach = skyWheelReach(...p);
        let far = 0;
        for (let s = 0; s < 64; s++) {
          far = Math.max(far, len(sub(wheelCentre(dir, (s / 64) * w.period), p)));
        }
        // A half turn, s = 32, is the farthest point exactly.
        expect(far).toBeLessThanOrEqual(reach * (1 + 1e-9));
        expect(far).toBeGreaterThan(reach * (1 - 1e-6));
        largest = Math.max(largest, reach);
      }
      const bound = 2 * SKY_DOME_RADIUS * Math.sin(chordAngle(w.radius));
      expect(largest).toBeLessThanOrEqual(bound);
      rows.push(`${w.note}: ${largest.toFixed(1)} m (bound 2 R sin(radius) ${bound.toFixed(1)} m)`);
    });
    // Far above the wave's: the batch grows a wheel chunk's sphere only under wheel (batch.ts).
    const dir = inWheel(SKY_WHEELS[0], 0.9, 0);
    expect(skyWheelReach(...onDome(dir))).toBeGreaterThan(5 * skySwirlReach(...onDome(dir)));
    console.log(`wheel reach: ${rows.join('; ')}`);
  });

  test("GLSL: the shader's quaternion turn is the mirror's Rodrigues turn, from the same tables", () => {
    const defines = skySwirlGlslDefines();
    const cores = String(defines.SKY_WHEEL_CORES)
      .replace(/^float\[\d+\]\(|\)$/g, '')
      .split(', ')
      .map(Number);
    const rates = String(defines.SKY_WHEEL_RATES)
      .replace(/^float\[\d+\]\(|\)$/g, '')
      .split(', ')
      .map(Number);
    SKY_WHEELS.forEach((w, i) => {
      expect(cores[i]).toBeCloseTo(0.5 * w.radius * w.radius, 9);
      expect(Math.abs(rates[i] / w.rate - 1)).toBeLessThan(1e-8);
    });
    expect(Number(defines.SKY_HALF_TURN)).toBeCloseTo(Math.PI, 7);
    // The GLSL, transcribed line for line.
    for (const line of [
      'vec3 u = 2.0 * cross(q, v);',
      'return v + w * u + cross(q, u);',
      'if (1.0 - dot(c, dir) >= SKY_WHEEL_CORE[i]) continue;',
      'float h = SKY_HALF_TURN * fract(t * SKY_WHEEL_RATE[i]);',
      'vec3 q = sin(h) * c;',
      'float w = cos(h);',
      'l = skyQuatRotate(q, w, l);',
      's = skyQuatRotate(q, w, s);',
      'n = skyQuatRotate(q, w, n);',
      'rigid = skyQuatRotate(q, w, d) - d;',
    ]) {
      expect(motionGlsl).toContain(line);
    }
    const quat = (q: Vec3, w: number, v: Vec3): Vec3 => {
      const u = cross(q, v).map((x) => 2 * x) as unknown as Vec3;
      const c = cross(q, u);
      return [v[0] + w * u[0] + c[0], v[1] + w * u[1] + c[1], v[2] + w * u[2] + c[2]];
    };
    const glslWheel = (d: Vec3, t: number): { offset: Vec3; normal: Vec3 } => {
      const dir = d.map((x) => x / len(d)) as unknown as Vec3;
      for (let i = 0; i < SKY_WHEELS.length; i++) {
        const c = SKY_VORTICES[i].axis;
        if (1 - dot(c, dir) >= cores[i]) continue;
        const h = Math.PI * fract(t * rates[i]);
        const q = c.map((x) => Math.sin(h) * x) as unknown as Vec3;
        const moved = quat(q, Math.cos(h), d);
        // motionOffset adds the rigid offset after its calm scaling, so calm never reaches it.
        const n: Vec3 = [-dir[0], -dir[1], -dir[2]];
        return { offset: sub(moved, d), normal: quat(q, Math.cos(h), n) };
      }
      return { offset: [0, 0, 0], normal: [-dir[0], -dir[1], -dir[2]] };
    };
    const rand = mulberry32(9);
    for (let k = 0; k < 400; k++) {
      const w = SKY_WHEELS[k % SKY_WHEELS.length];
      const dir = inWheel(w, 1.02 * rand(), 2 * Math.PI * rand());
      const time = 3600 * rand();
      const p = onDome(dir);
      const shader = glslWheel(sub(p, PAINTER_EYE), time);
      const mirror = skySwirl(p, [-dir[0], -dir[1], -dir[2]], 0, time, undefined, 'wheel').offset;
      // The defines carry 9 significant figures, so the rate errs by under 1e-8 of itself: under
      // 10 microns at the dome after an hour.
      expect(len(sub(shader.offset, mirror))).toBeLessThan(1e-5);
      // The normal turns with the disc, so it stays the dome's inward normal at the moved centre.
      const moved = sub(add(p, mirror), PAINTER_EYE);
      const inward = moved.map((x) => -x / len(moved)) as unknown as Vec3;
      expect(len(sub(shader.normal, inward))).toBeLessThan(1e-6);
    }
    // The vertex shader hands the wheel both axes, and draws the rest corner.
    expect(strokeVert).toContain('longAxis,\n      shortAxis,');
    expect(strokeVert).toContain(
      'local = iPosition + wheel + m.offset + longAxis * (position.x * size.x) +',
    );
  });

  test('every wrap angle stays in [0, 2π): the shader never takes the sine of an unbounded angle', () => {
    for (const w of SKY_WHEELS) {
      for (const time of [0, 1, 1799.5, 3599.999]) {
        const a = skyWheelAngle(w, time);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(2 * Math.PI);
      }
    }
  });
});

/**
 * The tone channel of the default atlas, coverage-weighted over every brush: its mean, and its
 * correlation with itself `lag` texels along u, over the texel pairs both inside a shape.
 */
function toneStats(lag: number): { mean: number; rho: number; perBrush: number[] } {
  const atlas = generateBrushAtlas(DEFAULT_BRUSH_SEED);
  let w = 0;
  let sum = 0;
  for (let b = 0; b < BRUSH_COUNT; b++) {
    const r = brushTexelRect(b);
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) {
        const i = (y * ATLAS_SIZE + x) * 4;
        const cov = atlas[i] / 255;
        w += cov;
        sum += cov * (atlas[i + 2] / 255);
      }
    }
  }
  const mean = sum / w;
  const perBrush: number[] = [];
  let num = 0;
  let va = 0;
  let vb = 0;
  for (let b = 0; b < BRUSH_COUNT; b++) {
    const r = brushTexelRect(b);
    let bn = 0;
    let ba = 0;
    let bb = 0;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x + lag < r.x + r.width; x++) {
        const i = (y * ATLAS_SIZE + x) * 4;
        const j = i + lag * 4;
        const k = (atlas[i] / 255) * (atlas[j] / 255);
        if (k === 0) continue;
        const ta = atlas[i + 2] / 255 - mean;
        const tb = atlas[j + 2] / 255 - mean;
        bn += k * ta * tb;
        ba += k * ta * ta;
        bb += k * tb * tb;
      }
    }
    perBrush.push(bn / Math.sqrt(ba * bb));
    num += bn;
    va += ba;
    vb += bb;
  }
  return { mean, rho: num / Math.sqrt(va * vb), perBrush };
}

describe('stream', () => {
  test('the loop divides the uTime wrap, and each layer slides SKY_STREAM_SHIFT per loop, half a loop apart', () => {
    expect(SKY_STREAM_PERIOD).toBe(2);
    expect(3600 % SKY_STREAM_PERIOD).toBe(0);
    expect(SKY_STREAM_SHIFT).toBe(0.5);
    expect(skyStreamPhase(0.25, 0)).toBe(0.25);
    expect(skyStreamPhase(0.25, 3600)).toBeCloseTo(skyStreamPhase(0.25, 0), 9);
    expect(skyStreamPhase(0.25, 0.5)).toBeCloseTo(0.5, 12);
    for (let i = 0; i <= 64; i++) {
      const w = skyStreamWeights(i / 64);
      expect(w.shiftA - w.shiftB).toBeCloseTo(
        w.fA >= 0.5 ? 0.5 * SKY_STREAM_SHIFT : -0.5 * SKY_STREAM_SHIFT,
        12,
      );
      expect(Math.abs(w.shiftA)).toBeLessThanOrEqual(0.5 * SKY_STREAM_SHIFT);
    }
  });

  test('the weights sum to 1, and each layer resets only where its weight is 0, so nothing pops', () => {
    const n = 4096;
    let previous = skyStreamWeights(0);
    for (let i = 1; i <= n; i++) {
      const w = skyStreamWeights(i / n);
      expect(w.wA + w.wB).toBeCloseTo(1, 15);
      expect(w.wA).toBeGreaterThanOrEqual(0);
      expect(w.wB).toBeGreaterThanOrEqual(0);
      // Each layer's weighted slide is continuous: a jump in its slide carries weight 0.
      const jumpA = Math.abs(w.shiftA - previous.shiftA) > 0.25 * SKY_STREAM_SHIFT;
      const jumpB = Math.abs(w.shiftB - previous.shiftB) > 0.25 * SKY_STREAM_SHIFT;
      if (jumpA) expect(Math.max(w.wA, previous.wA)).toBeLessThan(2 / n + 1e-12);
      if (jumpB) expect(Math.max(w.wB, previous.wB)).toBeLessThan(2 / n + 1e-12);
      expect(Math.abs(w.wA - previous.wA)).toBeLessThanOrEqual(2 / n + 1e-12);
      previous = w;
    }
  });

  test('the contrast compensation keeps one layer contrast at every weight: the stream does not breathe', () => {
    const rand = mulberry32(21);
    for (const rho of [-0.08, 0, 0.34, 0.72]) {
      // Pairs of unit-variance tones with correlation rho round the mean.
      const pairs: [number, number][] = [];
      for (let k = 0; k < 20000; k++) {
        const g1 = Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
        const g2 = Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
        const a = g1;
        const b = rho * g1 + Math.sqrt(1 - rho * rho) * g2;
        pairs.push([a, b]);
      }
      const variances: number[] = [];
      for (const f of [0.02, 0.15, 0.3, 0.5, 0.65, 0.85]) {
        const w = skyStreamWeights(f, rho);
        let s2 = 0;
        for (const [a, b] of pairs) {
          const t = (w.wA * a + w.wB * b) * w.gain;
          s2 += t * t;
        }
        variances.push(s2 / pairs.length);
      }
      for (const v of variances) expect(v, `rho ${rho}`).toBeCloseTo(1, 1);
      // Uncompensated, the 50/50 blend would keep only (1 + rho) / 2 of it.
      expect(skyStreamWeights(0.25, rho).gain).toBeCloseTo(1 / Math.sqrt(0.5 * (1 + rho)), 12);
    }
  });

  test('the atlas tone: its mean is SKY_STREAM_TONE_MEAN, and SKY_STREAM_RHOS each brush tone correlation half a shift apart', () => {
    const lag = Math.round(0.5 * SKY_STREAM_SHIFT * brushTexelRect(0).width);
    const stats = toneStats(lag);
    console.log(
      `stream tone: mean ${stats.mean.toFixed(4)}, rho at ${lag} texels ${stats.rho.toFixed(4)}, per brush ${stats.perBrush.map((r) => r.toFixed(2)).join(' ')}`,
    );
    expect(Math.abs(stats.mean - SKY_STREAM_TONE_MEAN)).toBeLessThan(0.01);
    expect(SKY_STREAM_RHOS).toHaveLength(BRUSH_COUNT);
    stats.perBrush.forEach((rho, b) => {
      expect(Math.abs(rho - SKY_STREAM_RHOS[b]), `brush ${b}`).toBeLessThan(0.05);
    });
  });

  test('streamTone is the mirror: the layer taps fall back to the rest tone outside the shape, and the result stays in [0, 1]', () => {
    for (const line of [
      'float fB = fract(fA + 0.5);',
      'float wA = 1.0 - abs(2.0 * fA - 1.0);',
      'float packed = abs(vStream) - 1.0;',
      'float fA = fract(packed);',
      'float span = (vRect.z - vRect.x) * SKY_STREAM_SHIFT * sign(vStream) * k;',
      'vec4 a = texture(uAtlas, clamp(vUv - vec2((fA - 0.5) * span, 0.0), vRect.xy, vRect.zw));',
      'vec4 b = texture(uAtlas, clamp(vUv - vec2((fB - 0.5) * span, 0.0), vRect.xy, vRect.zw));',
      'float ta = mix(rest, a.b, a.r);',
      'int whole = int(packed);',
      'int level = whole / BRUSH_COUNT;',
      'float k = 1.0 - float(level) * SKY_STREAM_INV_FADE_LEVELS;',
      'float rho2 = SKY_STREAM_RHO2S[whole - level * BRUSH_COUNT];',
      'float rho2k = rho2 * k + 2.0 * (1.0 - k);',
      'float gain = mix(1.0, inversesqrt(wA * wA + wB * wB + rho2k * wA * wB), a.r * b.r);',
      'return clamp(m + (wA * (ta - m) + wB * (tb - m)) * gain, 0.0, 1.0);',
    ]) {
      expect(strokeFrag).toContain(line);
    }
    // Outside the shape both taps fall back to the rest tone, and the gain fades to 1 with their
    // coverage, so the tips keep the rest tone at every rho and loop fraction: no breathing.
    const rest = 0.62;
    const out = { tone: 0.5, coverage: 0 };
    for (const rho of [-0.08, 0, 0.72]) {
      for (const f of [0.1, 0.25, 0.4]) {
        expect(skyStreamTone(rest, out, out, f, rho)).toBeCloseTo(rest, 12);
      }
    }
    // Inside the shape the full gain applies.
    const inside = { tone: 0.3, coverage: 1 };
    expect(skyStreamTone(rest, inside, inside, 0.25, 0.34)).toBeCloseTo(
      SKY_STREAM_TONE_MEAN + (0.3 - SKY_STREAM_TONE_MEAN) * skyStreamWeights(0.25, 0.34).gain,
      12,
    );
    // One layer at full weight is that layer's tone exactly.
    expect(skyStreamTone(rest, { tone: 0.8, coverage: 1 }, { tone: 0.1, coverage: 1 }, 0.5)).toBe(
      0.8,
    );
    expect(skyStreamTone(0.5, { tone: 1, coverage: 1 }, { tone: 1, coverage: 1 }, 0.25)).toBe(1);
  });

  test('the footprint is fixed: coverage and alpha read only the rest tap, and only the tone streams', () => {
    expect(strokeFrag).toContain('vec4 t = texture(uAtlas, vUv);\n  float cov = t.r;');
    expect(strokeFrag).toContain(
      'float tone = 0.75 + 0.5 * (vStream != 0.0 ? streamTone(t.b) : t.b);',
    );
    const body = strokeFrag.slice(
      strokeFrag.indexOf('float streamTone('),
      strokeFrag.indexOf('void main()'),
    );
    expect(body).not.toMatch(/alpha|cov\b|fragColor/);
    // The stream's varying is one flat float, 0 for every stroke the stream branch does not set.
    expect(strokeVert).toContain('float stream = 0.0;');
    expect(strokeVert).toContain('flat out float vStream;');
    expect(strokeFrag).toContain('flat in float vStream;');
    expect(strokeVert).toContain('vStream = stream;');
    expect(motionGlsl).toContain(
      'stream = skyStream(cross(omega, d), l, brush, phase, t, SKY_STREAM_INV_PERIOD, 1.0);',
    );
    expect(motionGlsl).toContain('float f = fract(t * invPeriod + phase);');
    expect(motionGlsl).toContain(
      'float level = floor((1.0 - shift) * SKY_STREAM_FADE_LEVELS + 0.5);',
    );
    expect(motionGlsl).toContain('(1.0 + float(brush) + float(BRUSH_COUNT) * level + f);');
  });

  test('the packed varying sign × (1 + brush + BRUSH_COUNT level + f) decodes to the brush, level, f and sign in float32', () => {
    for (let brush = 0; brush < SKY_STREAM_RHOS.length; brush++) {
      for (const sign of [-1, 1]) {
        for (let k = 0; k < 256; k++) {
          const f = k / 256 + 0.001;
          // Level 0, stream's, packs exactly as before the levels.
          expect(skyStreamPack(sign, brush, f, 0)).toBe(skyStreamPack(sign, brush, f));
          for (const level of [0, 7, SKY_STREAM_FADE_LEVELS]) {
            const out = skyStreamUnpack(skyStreamPack(sign, brush, f, level));
            expect(out.brush).toBe(brush);
            expect(out.level).toBe(level);
            expect(out.shift).toBeCloseTo(1 - level / SKY_STREAM_FADE_LEVELS, 12);
            expect(out.sign).toBe(sign);
            // 256 in float32 keeps f to 2^-15, about 3e-5.
            expect(Math.abs(out.f - f)).toBeLessThan(4e-5);
          }
        }
        // f rounding up to the next whole number reads the next brush (or the next level's brush
        // 0) with f 0, where layer A's weight is 0, layer B sits on the rest tap and the gain is 1
        // for any rho.
        for (const level of [0, SKY_STREAM_FADE_LEVELS]) {
          const top = skyStreamUnpack(skyStreamPack(sign, brush, 1 - 1e-8, level));
          const whole = top.brush + SKY_STREAM_RHOS.length * top.level;
          const packedWhole = brush + SKY_STREAM_RHOS.length * level;
          expect(whole === packedWhole || (whole === packedWhole + 1 && top.f === 0)).toBe(true);
          expect(1 + whole).toBeLessThanOrEqual(257);
        }
        expect(skyStreamWeights(0, -0.08).gain).toBe(1);
        expect(skyStreamWeights(0, 0.72).gain).toBe(1);
      }
    }
    expect(skyStreamPack(1, 0, 0)).not.toBe(0);
  });
});

/** The direction at angle `angle` from wheel `w`'s axis, `turn` radians round it. */
function fromAxis(w: SkyWheel, angle: number, turn: number): Vec3 {
  return rotateAbout(rotateAbout(w.axis, perpendicular(w.axis), angle), w.axis, turn);
}

describe('wheelflow', () => {
  test('inside a wheel a stroke turns exactly as under wheel; outside it holds still and streams', () => {
    const rand = mulberry32(11);
    let inside = 0;
    let streaming = 0;
    for (let k = 0; k < 4000; k++) {
      const y = rand();
      const a = 2 * Math.PI * rand();
      const r = Math.sqrt(1 - y * y);
      const dir: Vec3 = [r * Math.cos(a), y, r * Math.sin(a)];
      const p = onDome(dir);
      const n: Vec3 = [-dir[0], -dir[1], -dir[2]];
      const time = 3600 * rand();
      const flow = skySwirl(p, n, 0.3, time, undefined, 'wheelflow');
      const shift = skyWheelFlowShift(dir);
      if (skyWheelAt(dir) >= 0) {
        inside++;
        expect(shift).toBe(-1);
        expect(flow).toEqual(skySwirl(p, n, 0.3, time, undefined, 'wheel'));
        expect(flow.spin).not.toBeNull();
      } else {
        expect(flow).toEqual({ offset: [0, 0, 0], turn: 0, gain: 0, spin: null });
        expect(shift).toBeGreaterThanOrEqual(0);
        expect(shift).toBeLessThanOrEqual(1);
        if (skyStreamLevel(shift) < SKY_STREAM_FADE_LEVELS) streaming++;
      }
    }
    expect(inside).toBeGreaterThan(20);
    expect(streaming).toBeGreaterThan(3000);
    expect(skyWrapLoop('wheelflow', 0.3, 4.1)).toEqual({ tau: 0, gain: 0, returning: false });
  });

  test('the edge fade: the shift is 0 at each wheel edge, rises monotonically over SKY_WHEELFLOW_BAND (1°) and is full past it', () => {
    expect((SKY_WHEELFLOW_BAND * 180) / Math.PI).toBeCloseTo(1, 12);
    SKY_WHEELS.forEach((w, i) => {
      for (let t = 0; t < 32; t++) {
        const turn = (2 * Math.PI * t) / 32;
        expect(skyWheelFlowShift(fromAxis(w, skyWheelEdge(w) - 1e-6, turn))).toBe(-1);
        expect(skyWheelFlowShift(fromAxis(w, skyWheelEdge(w) + 1e-7, turn))).toBeLessThan(1e-5);
        // The wheel's own edge factor alone: a flow along the disc's turn, so the alignment fade is
        // 1, and no gap fade.
        let last = 0;
        for (let s = 1; s <= 20; s++) {
          const dir = fromAxis(w, skyWheelEdge(w) + (s / 20) * SKY_WHEELFLOW_BAND, turn);
          const along = scale(cross(w.axis, dir), Math.sign(w.rate));
          const own = skyWheelFlowShift(dir, along, [w], SKY_WHEELFLOW_BAND, null);
          expect(own, `wheel ${i}`).toBeGreaterThan(last);
          expect(Math.max(0, skyWheelFlowShift(dir))).toBeLessThanOrEqual(own);
          last = own;
        }
        expect(last).toBeCloseTo(1, 12);
      }
    });
  });

  test('the gap fade: the noisy gap between the two central wheels stays slow, every other rim streams near full speed', () => {
    const [left, right] = SKY_WHEELS;
    const gap = Math.acos(dot(left.axis, right.axis)) - skyWheelEdge(left) - skyWheelEdge(right);
    expect(SKY_WHEELFLOW_GAP.gap).toBeCloseTo(gap, 12);
    expect([SKY_WHEELFLOW_GAP.a, SKY_WHEELFLOW_GAP.b]).toEqual([0, 1]);
    // Along the great circle between the central axes, edge to edge, under 0.3 of the shift.
    const axis = unitCross(left.axis, right.axis);
    for (let s = 0; s <= 40; s++) {
      const angle = skyWheelEdge(left) + (s / 40) * gap;
      expect(skyWheelFlowShift(rotateAbout(left.axis, axis, angle))).toBeLessThan(0.3);
    }
    // The capsule ends at each axis: on each central wheel's side facing away from the other, the
    // gap fade is 1, and the paint at 1.5° out streams at 0.8 of the shift or more.
    const deg = Math.PI / 180;
    for (const [w, sense] of [
      [left, -1],
      [right, 1],
    ] as const) {
      for (const off of [1.5, 2, 3]) {
        const dir = rotateAbout(w.axis, axis, sense * (skyWheelEdge(w) + off * deg));
        expect(skyWheelFlowGapFade(dir)).toBe(1);
        expect(skyWheelFlowShift(dir)).toBeGreaterThanOrEqual(0.8);
      }
    }
  });

  test('the alignment fade: no paint streams against the turn of the disc it is nearest, aligned paint is untouched', () => {
    const deg = Math.PI / 180;
    expect(SKY_WHEELFLOW_ALIGN_BAND).toBeCloseTo(4 * SKY_WHEEL_STROKE_HALF, 15);
    expect(SKY_WHEELFLOW_ALIGN_EASE).toBeCloseTo(2 * SKY_WHEEL_STROKE_HALF, 15);
    const report: string[] = [];
    SKY_WHEELS.forEach((w, i) => {
      for (const off of [0.25, 0.5, 1, 1.5, 2, 3]) {
        let opposed = 0;
        let judged = 0;
        const N = 256;
        for (let k = 0; k < N; k++) {
          const dir = fromAxis(w, skyWheelEdge(w) + off * deg, (2 * Math.PI * k) / N);
          // Only where this wheel's members' edge is the nearest, in chord, of every wheel by more
          // than the blend, so its alignment alone counts.
          const margin = (o: SkyWheel): number => Math.sqrt(2 * (1 - dot(o.axis, dir))) - o.radius;
          if (
            SKY_WHEELS.some((o) => o !== w && margin(o) < margin(w) + SKY_WHEELFLOW_ALIGN_BLEND)
          ) {
            continue;
          }
          judged++;
          const v = skyVelocity(dir);
          const rim = scale(cross(w.axis, dir), Math.sign(w.rate));
          const cosine =
            dot(rim, v) /
            (Math.hypot(...rim) * Math.max(Math.hypot(...v), SKY_WHEELFLOW_MIN_SPEED));
          if (cosine <= 0) {
            opposed++;
            expect(skyWheelFlowShift(dir), `wheel ${i} +${off}° turn ${k}`).toBe(0);
          }
          // A flow along the disc's turn keeps the edge factor alone; one against it is still.
          const edge = skyWheelFlowShift(dir, rim, [w], SKY_WHEELFLOW_BAND, null);
          expect(skyWheelFlowShift(dir, scale(rim, 2), SKY_WHEELS, SKY_WHEELFLOW_BAND, null)).toBe(
            skyWheelFlowShift(dir, rim, SKY_WHEELS, SKY_WHEELFLOW_BAND, null),
          );
          expect(skyWheelFlowShift(dir, scale(rim, -1), [w], SKY_WHEELFLOW_BAND, null)).toBe(0);
          expect(edge).toBeGreaterThan(0);
          // Past SKY_WHEELFLOW_ALIGN of cosine the alignment fade is exactly 1.
          if (cosine >= SKY_WHEELFLOW_ALIGN) {
            expect(skyWheelFlowShift(dir, v, [w], SKY_WHEELFLOW_BAND, null)).toBe(edge);
          }
        }
        report.push(
          `wheel ${i} +${off}°: ${((100 * opposed) / Math.max(1, judged)).toFixed(1)}% opposed, now still`,
        );
      }
    });
    console.log(report.join('\n'));
    // Near a stagnation point the paint fades to still: a flow along the turn but under the speed
    // floor counts only its share of the floor (a cosine of 0.01, so a smoothstep of 0.0075).
    const w0 = SKY_WHEELS[2];
    const at = fromAxis(w0, skyWheelEdge(w0) + 0.5 * deg, 1.1);
    const rim0 = cross(w0.axis, at);
    const slow = scale(rim0, (Math.sign(w0.rate) * 0.01 * SKY_WHEELFLOW_MIN_SPEED) / len(rim0));
    const full = skyWheelFlowShift(
      at,
      scale(rim0, Math.sign(w0.rate)),
      [w0],
      SKY_WHEELFLOW_BAND,
      null,
    );
    const t = 0.01 / SKY_WHEELFLOW_ALIGN;
    expect(skyWheelFlowShift(at, slow, [w0], SKY_WHEELFLOW_BAND, null)).toBeCloseTo(
      full * t * t * (3 - 2 * t),
      12,
    );
    // Past the ease the alignment no longer counts.
    for (const w of SKY_WHEELS) {
      const dir = fromAxis(
        w,
        skyWheelEdge(w) + SKY_WHEELFLOW_ALIGN_BAND + SKY_WHEELFLOW_ALIGN_EASE + 0.01 * deg,
        0.3,
      );
      const rim = cross(w.axis, dir);
      expect(
        skyWheelFlowShift(dir, scale(rim, -Math.sign(w.rate)), [w], SKY_WHEELFLOW_BAND, null),
      ).toBe(1);
    }
  });

  test('no seam: across the central pair, where the nearest wheel switches, and round every rim, the shift changes by at most one fade level per 0.02°', () => {
    const deg = Math.PI / 180;
    const [left, right] = SKY_WHEELS;
    const centre = scale(add(left.axis, right.axis), 1 / len(add(left.axis, right.axis)));
    const e1 = unitCross(unitCross(left.axis, right.axis), centre);
    const e2 = unitCross(centre, e1);
    const step = 0.02 * deg;
    const span = 12 * deg;
    const n = Math.round((2 * span) / step);
    const at = (i: number, j: number): Vec3 => {
      const u = -span + i * step;
      const v = -span + j * step;
      const p = add(centre, add(scale(e1, u), scale(e2, v)));
      return scale(p, 1 / len(p));
    };
    let worst = 0;
    for (let r = 0; r <= n; r += 10) {
      let rowPrev = skyWheelFlowShift(at(0, r));
      let colPrev = skyWheelFlowShift(at(r, 0));
      for (let k = 1; k <= n; k++) {
        const row = skyWheelFlowShift(at(k, r));
        const col = skyWheelFlowShift(at(r, k));
        if (row >= 0 && rowPrev >= 0) worst = Math.max(worst, Math.abs(row - rowPrev));
        if (col >= 0 && colPrev >= 0) worst = Math.max(worst, Math.abs(col - colPrev));
        rowPrev = row;
        colPrev = col;
      }
    }
    expect(worst).toBeGreaterThan(0.01);
    expect(worst).toBeLessThanOrEqual(1 / SKY_STREAM_FADE_LEVELS);
    for (const w of SKY_WHEELS) {
      for (const off of [0.5, 1, 1.5, 2, 3]) {
        const a = skyWheelEdge(w) + off * deg;
        const count = Math.ceil((2 * Math.PI * Math.sin(a)) / step);
        let prev = skyWheelFlowShift(fromAxis(w, a, 0));
        for (let t = 1; t <= count; t++) {
          const s = skyWheelFlowShift(fromAxis(w, a, (2 * Math.PI * t) / count));
          if (s >= 0 && prev >= 0) {
            expect(Math.abs(s - prev)).toBeLessThanOrEqual(1 / SKY_STREAM_FADE_LEVELS);
          }
          prev = s;
        }
      }
    }
  });

  test('at a zero shift the streamed tone is the rest tone at every loop fraction and rho: the faded edge does not breathe', () => {
    for (const rest of [0.2, 0.62]) {
      for (const rho of [-0.08, 0.15, 0.72]) {
        for (const f of [0, 0.1, 0.25, 0.5, 0.8]) {
          const tap = { tone: rest, coverage: 1 };
          expect(skyStreamTone(rest, tap, tap, f, rho, 0)).toBeCloseTo(rest, 12);
        }
      }
    }
    // At full shift it is stream's tone exactly.
    const a = { tone: 0.3, coverage: 1 };
    const b = { tone: 0.7, coverage: 0.8 };
    expect(skyStreamTone(0.5, a, b, 0.3, 0.34, 1)).toBe(skyStreamTone(0.5, a, b, 0.3, 0.34));
  });

  test('the contrast gain at a partial shift holds the blend variance over the loop, and stream (shift 1) is unchanged', () => {
    const m = SKY_STREAM_TONE_MEAN;
    const d = 0.1;
    const tap = { tone: m + d, coverage: 1 };
    for (const k of [0.25, 0.5, 0.75]) {
      for (const rho of [-0.08, 0, 0.32, 0.72]) {
        // Taps read k of the shift apart are correlated by 1 − k (1 − rho).
        const rhoK = 1 - k * (1 - rho);
        for (const f of [0, 0.1, 0.25, 0.4, 0.5, 0.75, 0.9]) {
          const w = skyStreamWeights(f);
          const gain = (skyStreamTone(m, tap, tap, f, rho, k) - m) / d;
          const variance = w.wA * w.wA + w.wB * w.wB + 2 * rhoK * w.wA * w.wB;
          expect(gain * gain * variance, `k ${k} rho ${rho} f ${f}`).toBeCloseTo(1, 12);
        }
      }
    }
    // The old linear fade of the gain over-boosts at mid-loop: at k 0.5, rho 0 and f 0.25 the
    // gain is 1/sqrt(0.75) = 1.1547, where the linear form gave 1.2071.
    const mid = (skyStreamTone(m, tap, tap, 0.25, 0, 0.5) - m) / d;
    expect(mid).toBeCloseTo(1 / Math.sqrt(0.75), 12);
    // Shift 1 is stream's gain exactly, bit for bit, at any coverage.
    const rand = mulberry32(5);
    for (let i = 0; i < 2000; i++) {
      const a = { tone: rand(), coverage: rand() };
      const b = { tone: rand(), coverage: rand() };
      const rest = rand();
      const f = rand();
      const rho = SKY_STREAM_RHOS[i % SKY_STREAM_RHOS.length];
      const w = skyStreamWeights(f, rho);
      const ta = rest + (a.tone - rest) * a.coverage;
      const tb = rest + (b.tone - rest) * b.coverage;
      const gain = 1 + (w.gain - 1) * a.coverage * b.coverage;
      const before = Math.min(1, Math.max(0, m + (w.wA * (ta - m) + w.wB * (tb - m)) * gain));
      expect(skyStreamTone(rest, a, b, f, rho, 1)).toBe(before);
    }
  });

  test('the speed: the loop divides the uTime wrap and streams at the wheels mean rim speed, where stream runs faster', () => {
    expect(3600 / SKY_WHEELFLOW_PERIOD).toBe(1125);
    // Along a far-band dome stroke, 2 SKY_WHEEL_STROKE_HALF long, rad/s.
    const strokeLength = 2 * SKY_WHEEL_STROKE_HALF;
    const flow = (SKY_STREAM_SHIFT / SKY_WHEELFLOW_PERIOD) * strokeLength;
    const stream = (SKY_STREAM_SHIFT / SKY_STREAM_PERIOD) * strokeLength;
    const rims = SKY_WHEELS.map((w) => w.rimSpeed);
    const mean = rims.reduce((x, y) => x + y) / rims.length;
    console.log(
      `wheelflow ${((flow * 180) / Math.PI).toFixed(3)}°/s, stream ${((stream * 180) / Math.PI).toFixed(3)}°/s, rims ${rims.map((r) => ((r * 180) / Math.PI).toFixed(3)).join(' ')}°/s`,
    );
    expect(Math.abs(flow / mean - 1)).toBeLessThan(0.03);
    expect(stream / mean).toBeGreaterThan(1.5);
  });

  test('GLSL: skyWheelFlowShift in motion.glsl, run on its own defines, matches the TS mirror: edge, alignment, blend and gap fades', () => {
    const shader = glslWheelFlowShift();
    const rand = mulberry32(23);
    const deg = Math.PI / 180;
    let compared = 0;
    let faded = 0;
    for (const w of SKY_WHEELS) {
      for (let k = 0; k < 1500; k++) {
        // Out to past the alignment ease of each wheel, where every fade acts.
        const angle = skyWheelEdge(w) + (rand() * 7 - 0.5) * deg;
        const dir = fromAxis(w, angle, 2 * Math.PI * rand());
        // Skip a direction on a membership boundary, where the defines' rounding decides.
        if (SKY_WHEELS.some((o) => Math.abs(1 - dot(o.axis, dir) - 0.5 * o.radius ** 2) < 1e-7)) {
          continue;
        }
        const expected = skyWheelFlowShift(dir);
        const got = shader(dir, skyVelocity(dir));
        expect(got, `wheel ${SKY_WHEELS.indexOf(w)} at ${(angle / deg).toFixed(3)}°`).toBeCloseTo(
          expected,
          5,
        );
        compared++;
        if (expected > 0.05 && expected < 0.95) faded++;
      }
    }
    expect(compared).toBeGreaterThan(5900);
    expect(faded).toBeGreaterThan(500);
    // The tables themselves: each wheel's turn sense, and the gap's vectors from the central axes.
    const defines = skySwirlGlslDefines();
    expect(parseGlsl(String(defines.SKY_WHEELFLOW_SENSES))).toEqual(
      SKY_WHEELS.map((w) => Math.sign(w.rate)),
    );
    const [left, right] = SKY_WHEELS;
    const normal = unitCross(left.axis, right.axis);
    const vectors: [string, Vec3][] = [
      ['SKY_WHEELFLOW_GAP_NORMAL', normal],
      ['SKY_WHEELFLOW_GAP_FROM_A', cross(normal, left.axis)],
      ['SKY_WHEELFLOW_GAP_FROM_B', cross(right.axis, normal)],
    ];
    for (const [name, value] of vectors) {
      const parsed = parseGlsl(String(defines[name])) as number[];
      for (let i = 0; i < 3; i++) expect(parsed[i], name).toBeCloseTo(value[i], 8);
    }
    expect(parseGlsl(String(defines.SKY_WHEELFLOW_GAP_SIN))).toBeCloseTo(
      Math.sin(SKY_WHEELFLOW_GAP.gap / 2),
      8,
    );
  });

  test('GLSL: the fade table is the mirror, and wheelflow is a uniform: every wrap links the same program', () => {
    const defines = skySwirlGlslDefines();
    expect(defines.SKY_WHEELFLOW_OUTERS).toBe(
      `float[${SKY_WHEELS.length}](${SKY_WHEELS.map((w) => skyWheelFlowOuter(w).toExponential(8)).join(', ')})`,
    );
    expect(defines.SKY_WHEELFLOW_ALIGN_INNERS).toBe(
      `float[${SKY_WHEELS.length}](${SKY_WHEELS.map((w) => skyWheelFlowOuter(w, SKY_WHEELFLOW_ALIGN_BAND).toExponential(8)).join(', ')})`,
    );
    expect(defines.SKY_WHEELFLOW_ALIGN_OUTERS).toBe(
      `float[${SKY_WHEELS.length}](${SKY_WHEELS.map((w) => skyWheelFlowOuter(w, SKY_WHEELFLOW_ALIGN_BAND + SKY_WHEELFLOW_ALIGN_EASE).toExponential(8)).join(', ')})`,
    );
    expect(defines.SKY_WHEELFLOW_ALIGN).toBe(SKY_WHEELFLOW_ALIGN.toExponential(8));
    expect(defines.SKY_WHEELFLOW_ALIGN_BLEND).toBe(SKY_WHEELFLOW_ALIGN_BLEND.toExponential(8));
    expect(defines.SKY_WHEELFLOW_MIN_SPEED2).toBe((SKY_WHEELFLOW_MIN_SPEED ** 2).toExponential(8));
    expect(defines.SKY_WHEELFLOW_GAP_SIN).toBe(
      Math.sin(SKY_WHEELFLOW_GAP.halfWidth).toExponential(8),
    );
    expect(defines.SKY_WHEELFLOW_INV_PERIOD).toBe((1 / SKY_WHEELFLOW_PERIOD).toExponential(8));
    expect(motionGlsl).toContain('if (x < SKY_WHEEL_CORE[i]) return -1.0;');
    expect(motionGlsl).toContain(
      'shift *= smoothstep(SKY_WHEEL_CORE[i], SKY_WHEELFLOW_OUTER[i], x);',
    );
    const before = createStrokeMaterial(new Texture());
    const shaders = [before.vertexShader, before.fragmentShader, { ...before.defines }];
    try {
      for (const wrap of SKY_WRAPS) {
        motionVariants.setWrap(wrap);
        const after = createStrokeMaterial(new Texture());
        expect([after.vertexShader, after.fragmentShader, after.defines]).toEqual(shaders);
        expect(after.uniforms.uSkyWrap).toBe(before.uniforms.uSkyWrap);
      }
    } finally {
      motionVariants.setWrap('wave');
    }
  });
});

function unitCross(a: Vec3, b: Vec3): Vec3 {
  const c = cross(a, b);
  const l = len(c);
  return [c[0] / l, c[1] / l, c[2] / l];
}

/** A GLSL define value (a float, or a vec or float array literal) as numbers. */
function parseGlsl(text: string): number | number[] | number[][] {
  return JSON.parse(text.replace(/(vec[234]|float)(\[\d+\])?\(/g, '[').replace(/\)/g, ']'));
}

/**
 * skyWheelFlowShift from motion.glsl, transliterated to JavaScript line for line and run on the
 * material's own defines, so a test can evaluate the shader's fades rather than its text.
 */
function glslWheelFlowShift(): (dir: Vec3, v: Vec3) => number {
  const head = 'float skyWheelFlowShift(vec3 dir, vec3 v) {';
  const start = motionGlsl.indexOf(head);
  const end = motionGlsl.indexOf('\n}\n', start);
  expect(start).toBeGreaterThan(0);
  const body = motionGlsl
    .slice(start + head.length, end)
    .replace(/\.xyz\b/g, '')
    .replace(/\b(float|vec3|int)\s+(?=[A-Za-z_])/g, 'let ');
  const defines = skySwirlGlslDefines();
  const env: Record<string, unknown> = {};
  for (const m of motionGlsl.matchAll(/^const \w+ (\w+)\[SKY_VORTEX_COUNT\] = (\w+);$/gm)) {
    env[m[1]] = parseGlsl(String(defines[m[2]]));
  }
  for (const name of body.match(/\bSKY_[A-Z0-9_]+\b/g) ?? []) {
    if (!(name in env)) env[name] = parseGlsl(String(defines[name]));
  }
  const math = {
    dot: (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a: number[], b: number[]) => cross([a[0], a[1], a[2]], [b[0], b[1], b[2]]),
    smoothstep: (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    },
    mix: (a: number, b: number, t: number) => a * (1 - t) + b * t,
    sqrt: Math.sqrt,
    inversesqrt: (x: number) => 1 / Math.sqrt(x),
    max: Math.max,
    abs: Math.abs,
  };
  const names = [...Object.keys(env), ...Object.keys(math)];
  const run = new Function(...names, 'dir', 'v', body) as (...args: unknown[]) => number;
  const values = [...Object.values(env), ...Object.values(math)];
  return (dir, v) => run(...values, dir, v);
}
