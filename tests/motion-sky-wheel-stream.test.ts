/**
 * The `wheel`, `stream`, `wheelflow` and `wheelrun` sky wraps (2026-11-09, 2026-11-10,
 * src/motion/variants.ts, sky-swirl.ts): the wheel's rigid, periodic turn, its sense, rate and cull
 * bound, and the GLSL's quaternion form of it; the stream's layer weights, contrast compensation and
 * fixed footprint; wheelflow's and wheelrun's travel outside the wheels, its bound, fades and seams.
 */
import { Texture } from 'three';
import { describe, expect, test } from 'vitest';
import motionGlsl from '../src/motion/motion.glsl?raw';
import { SKY_RIVER_MAX_CURVATURE } from '../src/motion/sky-river.ts';
import {
  perpendicular,
  rotateAbout,
  SKY_RIVER_FIRST_WHEEL,
  SKY_RIVER_FLOW_SCALE,
  SKY_RIVER_JITTER,
  SKY_RIVER_SPEED,
  SKY_RIVER_WHEELS,
  SKY_STREAM_PERIOD,
  SKY_STREAM_RHOS,
  SKY_STREAM_SHIFT,
  SKY_STREAM_TONE_MEAN,
  SKY_SWIRL_FADE,
  SKY_SWIRL_PERIOD,
  SKY_VORTICES,
  SKY_WHEEL_CORE_SCALE,
  SKY_WHEEL_HAZE_FEATHER,
  SKY_WHEEL_RIM_GAIN,
  SKY_WHEEL_STROKE_HALF,
  SKY_WHEELFLOW_ALIGN_BAND,
  SKY_WHEELFLOW_ALIGN_BLEND,
  SKY_WHEELFLOW_ALIGN_EASE,
  SKY_WHEELFLOW_APPROACH_FLOOR,
  SKY_WHEELFLOW_MIN_SPEED,
  SKY_WHEELFLOW_RAMP,
  SKY_WHEELRUN_CALM_FADE,
  SKY_WHEELRUN_GAIN_TRAVEL,
  SKY_WHEELS,
  type SkyWheel,
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
  skyWheelFlowTravel,
  skyWheelHazeThin,
  skyWheelReach,
  skyWheelRunGain,
  skyWheelSpin,
  skyWrapLoop,
} from '../src/motion/sky-swirl.ts';
import { motionVariants } from '../src/motion/variant-uniforms.ts';
import { DEFAULT_SKY_WRAP, SKY_WRAPS } from '../src/motion/variants.ts';
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
      'uSkyWrap != SKY_WRAP_WHEEL && uSkyWrap != SKY_WRAP_WHEELFLOW && uSkyWrap != SKY_WRAP_WHEELRUN\n  ) {',
      'return member >= 0 || uSkyWrap == SKY_WRAP_WHEEL;',
      'if (i >= first && 1.0 - dot(SKY_VORTEX_AXIS[i].xyz, dir) < SKY_WHEEL_CORE[i]) member = i;',
      'skyWheelMotion(d, dir, n, l, s, uTime, rigid, first);',
      'vec3 seen = normalize(d + rigid);',
      'float h = halfExtent * inv;',
      'if (j == member || j < first) continue;',
      'int first = uSkyWrap == SKY_WRAP_WHEEL ? 0 : SKY_RIVER_FIRST_WHEEL;',
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
      'float span = (vRect.z - vRect.x) * SKY_STREAM_SHIFT * sign(vStream);',
      'vec4 a = texture(uAtlas, clamp(vUv - vec2((fA - 0.5) * span, 0.0), vRect.xy, vRect.zw));',
      'vec4 b = texture(uAtlas, clamp(vUv - vec2((fB - 0.5) * span, 0.0), vRect.xy, vRect.zw));',
      'float ta = mix(rest, a.b, a.r);',
      'float rho2 = SKY_STREAM_RHO2S[min(int(packed), BRUSH_COUNT - 1)];',
      'float gain = mix(1.0, inversesqrt(wA * wA + wB * wB + rho2 * wA * wB), a.r * b.r);',
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
    expect(motionGlsl).toContain('stream = skyStream(cross(omega, d), l, brush, phase, t);');
    expect(motionGlsl).toContain(
      'return (dot(l, v) < 0.0 ? -1.0 : 1.0) * (1.0 + float(brush) + f);',
    );
  });

  test('the packed varying sign × (1 + brush + f) decodes to the brush, f and sign in float32', () => {
    for (let brush = 0; brush < SKY_STREAM_RHOS.length; brush++) {
      for (const sign of [-1, 1]) {
        for (let k = 0; k < 256; k++) {
          const f = k / 256 + 0.001;
          const out = skyStreamUnpack(skyStreamPack(sign, brush, f));
          expect(out.brush).toBe(brush);
          expect(out.sign).toBe(sign);
          // 17 in float32 keeps f to 2^-19, about 2e-6.
          expect(Math.abs(out.f - f)).toBeLessThan(4e-6);
        }
        // f rounding up to the next whole number reads the next brush with f 0, where layer A's
        // weight is 0 and the gain is 1 for any rho.
        const top = skyStreamUnpack(skyStreamPack(sign, brush, 1 - 1e-8));
        expect(top.brush === brush || (top.brush === brush + 1 && top.f === 0)).toBe(true);
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

const unit = (a: Vec3): Vec3 => scale(a, 1 / len(a));

/**
 * A river rotation at unit direction `dir` as skyRiverBake shapes one: ω = σ A v (κ d̂ + d̂ × t̂)
 * for a random tangent t̂, sign σ, amplitude A in [0, 1] and curvature κ up to
 * SKY_RIVER_MAX_CURVATURE, so ω × d̂ = σ A v t̂, and a random packed iRiver.w: a winding fade
 * level 1-255 plus a phase in [0, 1).
 */
function riverAt(dir: Vec3, rand: () => number): { omega: Vec3; phase: number } {
  const e1 = perpendicular(dir);
  const t = rotateAbout(e1, dir, 2 * Math.PI * rand());
  const m = cross(dir, t);
  const k = (rand() < 0.5 ? -1 : 1) * rand() * SKY_RIVER_SPEED;
  const kappa = (2 * rand() - 1) * SKY_RIVER_MAX_CURVATURE;
  return {
    omega: [k * (kappa * dir[0] + m[0]), k * (kappa * dir[1] + m[1]), k * (kappa * dir[2] + m[2])],
    phase: 1 + Math.floor(254.999 * rand()) + Math.min(rand(), 1 - 2 ** -12),
  };
}

/** A field velocity of `speed` rad/s along wheel `w`'s turn at `dir` (against it when negative). */
const along = (w: SkyWheel, dir: Vec3, speed: number): Vec3 =>
  scale(unit(cross(w.axis, dir)), Math.sign(w.rate) * speed);

describe('wheelflow and wheelrun', () => {
  test('the river arms: a kept wheel member turns exactly as under wheel, and every other stroke, the big swirl included, travels along its river omega scaled by its travel', () => {
    const rand = mulberry32(11);
    let inside = 0;
    let big = 0;
    let moving = 0;
    for (let k = 0; k < 4000; k++) {
      const y = rand();
      const a = 2 * Math.PI * rand();
      const r = Math.sqrt(1 - y * y);
      const dir: Vec3 = [r * Math.cos(a), y, r * Math.sin(a)];
      const p = onDome(dir);
      const n: Vec3 = [-dir[0], -dir[1], -dir[2]];
      const time = 3600 * rand();
      const half = 2 * rand();
      const river = riverAt(dir, rand);
      const options = { halfDiagonal: half, calm: 1, river };
      const flow = skySwirl(p, n, 0.3, time, undefined, 'wheelflow', undefined, options);
      const run = skySwirl(p, n, 0.3, time, undefined, 'wheelrun', undefined, options);
      const v = cross(river.omega, dir);
      const travel = skyWheelFlowTravel(dir, v, half / SKY_DOME_RADIUS, SKY_RIVER_WHEELS);
      if (skyWheelAt(dir, SKY_RIVER_WHEELS) >= 0) {
        inside++;
        expect(travel).toBe(-1);
        const wheel = skySwirl(p, n, 0.3, time, undefined, 'wheel');
        expect(flow).toEqual(wheel);
        expect(run).toEqual(wheel);
        expect(flow.spin).not.toBeNull();
        continue;
      }
      if (skyWheelAt(dir) === 0) big++;
      expect(travel).toBeGreaterThanOrEqual(0);
      expect(travel).toBeLessThanOrEqual(1);
      if (travel > 0.5) moving++;
      expect(flow.spin).toBeNull();
      expect(run.spin).toBeNull();
      const d = sub(p, PAINTER_EYE);
      const w = cross(river.omega, d);
      const fRun = fract(time / SKY_SWIRL_PERIOD + 0.3);
      const tauRun = (fRun - 0.5) * SKY_SWIRL_PERIOD * travel;
      const fFlow = fract(time / SKY_SWIRL_PERIOD + river.phase + SKY_RIVER_JITTER * (0.3 - 0.5));
      const tauFlow =
        (smoothstepTs(0, 1, 1 - Math.abs(2 * fFlow - 1)) - 0.5) *
        SKY_SWIRL_PERIOD *
        SKY_RIVER_FLOW_SCALE *
        travel *
        (Math.floor(river.phase) / 255);
      for (let i = 0; i < 3; i++) {
        expect(flow.offset[i]).toBeCloseTo(tauFlow * w[i], 9);
        expect(run.offset[i]).toBeCloseTo(tauRun * w[i], 9);
      }
      expect(flow.turn).toBeCloseTo(tauFlow * dot(river.omega, n), 12);
      expect(run.turn).toBeCloseTo(tauRun * dot(river.omega, n), 12);
      expect(flow.gain).toBe(0);
      const share = len(v) / SKY_RIVER_SPEED;
      expect(share).toBeLessThanOrEqual(1 + 1e-12);
      expect(run.gain).toBeCloseTo(skyWheelRunGain(fRun, travel * share, 1), 12);
      // Never smaller than base's shrink at the same phase (Addition C).
      const base = skySwirl(p, n, 0.3, time, undefined, 'base');
      expect(run.gain).toBeGreaterThanOrEqual(base.gain - 1e-12);
    }
    expect(inside).toBeGreaterThan(10);
    expect(big).toBeGreaterThan(5);
    expect(moving).toBeGreaterThan(3000);
    // Their loops before the travel: wheelflow is pingpong's curve, wheelrun base's.
    for (const f of [0.1, 0.3, 0.7, 0.97]) {
      expect(skyWrapLoop('wheelflow', f, 4.1)).toEqual(skyWrapLoop('pingpong', f, 4.1));
      expect(skyWrapLoop('wheelrun', f, 4.1)).toEqual(skyWrapLoop('base', f, 4.1));
    }
    // A river stroke outside the kept wheels needs its baked river.
    const off = onDome(fromAxis(SKY_RIVER_WHEELS[0], 0.3, 0));
    expect(() => skySwirl(off, [0, -1, 0], 0, 1, undefined, 'wheelrun')).toThrow(/options.river/);
  });

  test('the bound: no moved centre, widened by the kept extent, reaches a kept wheel members edge it was clear of at rest, so a dome stroke overlaps a disc by at most its own half extent', () => {
    const rand = mulberry32(5);
    const deg = Math.PI / 180;
    let clearAtRest = 0;
    let moved = 0;
    let closest = Number.POSITIVE_INFINITY;
    let overlapShare = 0;
    const kept = (dir: Vec3): number[] =>
      SKY_RIVER_WHEELS.map(
        (w) => Math.acos(Math.min(1, Math.max(-1, dot(w.axis, dir)))) - skyWheelEdge(w),
      );
    for (const wrap of ['wheelflow', 'wheelrun'] as const) {
      for (const kind of ['dome', 'haze'] as const) {
        SKY_RIVER_WHEELS.forEach((w) => {
          for (let k = 0; k < 600; k++) {
            const dir = fromAxis(w, skyWheelEdge(w) + rand() * 8 * deg, 2 * Math.PI * rand());
            if (skyWheelAt(dir, SKY_RIVER_WHEELS) >= 0) continue;
            const p = onDome(dir);
            const n: Vec3 = [-dir[0], -dir[1], -dir[2]];
            const h = rand() * 4 * deg;
            const keptExtent = kind === 'haze' ? h : 0;
            const rest = kept(dir).map((e) => e - keptExtent);
            if (rest.every((e) => e >= 0)) clearAtRest++;
            const phase = rand();
            const river = riverAt(dir, rand);
            for (let s = 0; s <= 32; s++) {
              const time = (s / 32) * SKY_SWIRL_PERIOD + 0.0137;
              const m = skySwirl(p, n, phase, time, undefined, wrap, undefined, {
                halfDiagonal: keptExtent * SKY_DOME_RADIUS,
                river,
              });
              const d = sub(add(p, m.offset), PAINTER_EYE);
              const centre = kept(unit(d));
              if (len(m.offset) > 1e-9) moved++;
              centre.forEach((e, j) => {
                expect(e - keptExtent, `${wrap} ${kind} wheel ${j}`).toBeGreaterThanOrEqual(
                  Math.min(rest[j], 0) - 1e-12,
                );
                if (rest[j] < 0) return;
                closest = Math.min(closest, e - keptExtent);
                const over = Math.max(0, h - e);
                expect(over).toBeLessThanOrEqual(h + 1e-12);
                if (kind === 'haze') expect(over).toBeLessThanOrEqual(1e-12);
                if (h > 0) overlapShare = Math.max(overlapShare, over / h);
              });
            }
          }
        });
      }
    }
    expect(clearAtRest).toBeGreaterThan(3000);
    expect(moved).toBeGreaterThan(70000);
    expect(closest).toBeGreaterThanOrEqual(0);
    expect(overlapShare).toBeLessThanOrEqual(1);
  });

  test('the edge fade: travel is 0 while the kept extent reaches the edge, rises with the clearance and is full where the flow cannot bring it nearer', () => {
    const deg = Math.PI / 180;
    expect(SKY_WHEELFLOW_RAMP).toBe(1.25);
    // smoothstep(0, 1.25, x) <= 0.9 x for every x >= 0, so travel × approach < clearance.
    for (let x = 0; x <= 3; x += 0.001) {
      const t = Math.min(1, x / SKY_WHEELFLOW_RAMP);
      expect(t * t * (3 - 2 * t)).toBeLessThanOrEqual(0.9 * x + 1e-15);
    }
    SKY_WHEELS.forEach((w, i) => {
      const h = 1.5 * deg;
      for (let t = 0; t < 32; t++) {
        const turn = (2 * Math.PI * t) / 32;
        expect(skyWheelFlowTravel(fromAxis(w, skyWheelEdge(w) - 1e-6, turn))).toBe(-1);
        // A flow along the disc's turn, so the alignment fade is 1, against this wheel alone.
        const at = (off: number): number => {
          const dir = fromAxis(w, skyWheelEdge(w) + off, turn);
          const tangent = along(w, dir, 0.004);
          const inward = scale(sub(w.axis, scale(dir, dot(w.axis, dir))), -0.002);
          return skyWheelFlowTravel(dir, add(tangent, inward), h, [w]);
        };
        expect(at(0.5 * h), `wheel ${i}`).toBe(0);
        expect(at(h - 1e-6), `wheel ${i}`).toBe(0);
        let last = 0;
        for (let s = 1; s <= 40; s++) {
          const now = at(h + (s / 40) * 4 * deg);
          expect(now, `wheel ${i}`).toBeGreaterThanOrEqual(last);
          last = now;
        }
        expect(last).toBe(1);
        // A flow straight along the rim brings the stroke no nearer, so it travels in full once
        // its quad clears the edge by SKY_WHEELFLOW_RAMP of the approach floor, and eases in
        // before that rather than jumping from still to full.
        const arc = 0.5 * SKY_SWIRL_PERIOD * 0.004;
        const ramp = SKY_WHEELFLOW_RAMP * SKY_WHEELFLOW_APPROACH_FLOOR * arc;
        const rimAt = (clear: number): number => {
          const dir = fromAxis(w, skyWheelEdge(w) + h + clear, turn);
          return skyWheelFlowTravel(dir, along(w, dir, 0.004), h, [w]);
        };
        expect(rimAt(1.05 * ramp)).toBe(1);
        expect(rimAt(0.5 * ramp)).toBeGreaterThan(0.3);
        expect(rimAt(0.5 * ramp)).toBeLessThan(0.7);
        expect(rimAt(0.02 * ramp)).toBeLessThan(0.01);
      }
    });
  });

  test('the alignment fade: no paint travels against the turn of the disc it is nearest, aligned paint is untouched', () => {
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
            expect(skyWheelFlowTravel(dir), `wheel ${i} +${off}° turn ${k}`).toBe(0);
          }
          // Along the turn the alignment is 1; against it the stroke holds still.
          expect(skyWheelFlowTravel(dir, along(w, dir, -0.002), 0, [w])).toBe(0);
          expect(skyWheelFlowTravel(dir, along(w, dir, 0.002), 0, [w])).toBe(1);
        }
        report.push(
          `wheel ${i} +${off}°: ${((100 * opposed) / Math.max(1, judged)).toFixed(1)}% opposed, now still`,
        );
      }
    });
    console.log(report.join('\n'));
    // Past the ease the alignment no longer counts: a flow against the turn travels in full where
    // it is far enough out that it cannot reach the edge.
    for (const w of SKY_WHEELS) {
      const dir = fromAxis(
        w,
        skyWheelEdge(w) + SKY_WHEELFLOW_ALIGN_BAND + SKY_WHEELFLOW_ALIGN_EASE + 0.01 * deg,
        0.3,
      );
      expect(skyWheelFlowTravel(dir, along(w, dir, -0.002), 0, [w])).toBe(1);
    }
  });

  test('no seam: across the central pair and round every rim, strokes 0.02° apart differ in how far they travel by a small share of a stroke', () => {
    const deg = Math.PI / 180;
    // A dome stroke keeps no extent clear (the bound holds its centre).
    const h = 0;
    // How far a dome stroke at `dir` travels each way along the flow, radians: its travel
    // share of the half-loop arc. A stroke outside the wheels moves along this arc, so two
    // neighbours that differ by much here part or pile up.
    const reach = (dir: Vec3): number => {
      const v = skyVelocity(dir);
      const travel = skyWheelFlowTravel(dir, v, h);
      return travel < 0 ? -1 : travel * 0.5 * SKY_SWIRL_PERIOD * len(v);
    };
    const [left, right] = SKY_WHEELS;
    const centre = unit(add(left.axis, right.axis));
    const e1 = unitCross(unitCross(left.axis, right.axis), centre);
    const e2 = unitCross(centre, e1);
    const step = 0.02 * deg;
    const span = 12 * deg;
    const n = Math.round((2 * span) / step);
    const at = (i: number, j: number): Vec3 =>
      unit(add(centre, add(scale(e1, -span + i * step), scale(e2, -span + j * step))));
    let worstPair = 0;
    let largest = 0;
    for (let r = 0; r <= n; r += 10) {
      let rowPrev = reach(at(0, r));
      let colPrev = reach(at(r, 0));
      for (let k = 1; k <= n; k++) {
        const row = reach(at(k, r));
        const col = reach(at(r, k));
        largest = Math.max(largest, row, col);
        if (row >= 0 && rowPrev >= 0) worstPair = Math.max(worstPair, Math.abs(row - rowPrev));
        if (col >= 0 && colPrev >= 0) worstPair = Math.max(worstPair, Math.abs(col - colPrev));
        rowPrev = row;
        colPrev = col;
      }
    }
    let worstRim = 0;
    for (const w of SKY_WHEELS) {
      for (const off of [0, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3, 4]) {
        const a = skyWheelEdge(w) + h + off * deg;
        const count = Math.ceil((2 * Math.PI * Math.sin(a)) / step);
        let prev = reach(fromAxis(w, a, 0));
        for (let t = 1; t <= count; t++) {
          const s = reach(fromAxis(w, a, (2 * Math.PI * t) / count));
          if (s >= 0 && prev >= 0) worstRim = Math.max(worstRim, Math.abs(s - prev));
          prev = s;
        }
      }
    }
    console.log(
      `travel seam per 0.02°: central pair ${(worstPair / deg).toFixed(4)}°, rims ${(worstRim / deg).toFixed(4)}°, largest reach ${(largest / deg).toFixed(3)}°`,
    );
    expect(largest).toBeGreaterThan(0.5 * deg);
    expect(worstPair).toBeLessThanOrEqual(SEAM_LIMIT);
    expect(worstRim).toBeLessThanOrEqual(SEAM_LIMIT);
  });

  test('calm 0: outside the wheels wheelflow and wheelrun draw the rest sky, with no stroke frozen mid-shrink', () => {
    expect(SKY_WHEELRUN_CALM_FADE).toBe(0.1);
    expect(SKY_WHEELRUN_GAIN_TRAVEL).toBe(4);
    for (const f of [0, 0.01, 0.03, 0.5, 0.97, 0.999]) {
      for (const travel of [0, 0.1, 0.25, 0.6, 1]) {
        expect(Math.abs(skyWheelRunGain(f, travel, 0))).toBe(0);
        const base = smoothstepTs(0, SKY_SWIRL_FADE, Math.min(f, 1 - f)) - 1;
        expect(skyWheelRunGain(f, travel, 1)).toBeCloseTo(base * Math.min(1, 4 * travel), 15);
      }
      expect(skyWheelRunGain(f, 0.3, 0.05)).toBeCloseTo(0.5 * skyWheelRunGain(f, 0.3, 1), 15);
    }
    // The offset and turn scale by calm in motionOffset (scaleMotion), and the gain is the only
    // part it leaves, so at calm 0 an outside stroke is at rest.
    expect(motionGlsl).toContain('smoothstep(0.0, SKY_WHEELRUN_CALM_FADE, uCalm)');
  });

  test('the wheelrun gain: motion.glsl skyWheelRunGain, run as JavaScript, matches the mirror on an (f, travel, calm) grid', () => {
    const shader = glslWheelRunGain();
    let worst = 0;
    let samples = 0;
    for (let i = 0; i <= 40; i++) {
      // Dense near the wrap, where the shrink runs, and across the loop.
      const f = i < 20 ? (i / 20) * 2 * SKY_SWIRL_FADE : (i - 20) / 20;
      for (const travel of [0, 0.05, 0.1, 0.2, 0.25, 0.3, 0.6, 1]) {
        for (const calm of [0, 0.02, 0.05, 0.1, 0.5, 1]) {
          const d = Math.abs(shader(f, travel, calm) - skyWheelRunGain(f, travel, calm));
          worst = Math.max(worst, d);
          samples++;
        }
      }
    }
    expect(samples).toBe(41 * 8 * 6);
    expect(worst).toBeLessThan(1e-12);
    // The grid reaches the shrink: the shader's gain is not trivially 0 everywhere.
    expect(shader(0.01, 1, 1)).toBeLessThan(-0.5);
  });

  test('GLSL: skyWheelFlowTravel in motion.glsl, run on its own defines, matches the TS mirror: edge, alignment and blend', () => {
    const shader = glslWheelFlowTravel();
    const rand = mulberry32(23);
    const deg = Math.PI / 180;
    let compared = 0;
    let faded = 0;
    // All four wheels from index 0 (the field's velocity, as any velocity), and the river arms'
    // kept three from SKY_RIVER_FIRST_WHEEL on, at river velocities.
    for (const first of [0, SKY_RIVER_FIRST_WHEEL]) {
      const wheels = SKY_WHEELS.slice(first);
      for (const w of SKY_WHEELS) {
        for (let k = 0; k < 1500; k++) {
          const angle = skyWheelEdge(w) + (rand() * 9 - 0.5) * deg;
          const dir = fromAxis(w, angle, 2 * Math.PI * rand());
          if (SKY_WHEELS.some((o) => Math.abs(1 - dot(o.axis, dir) - 0.5 * o.radius ** 2) < 1e-7)) {
            continue;
          }
          const h = rand() * 3 * deg;
          const v = first === 0 ? skyVelocity(dir) : cross(riverAt(dir, rand).omega, dir);
          const expected = skyWheelFlowTravel(dir, v, h, wheels);
          const got = shader(dir, v, h, first);
          expect(
            got,
            `first ${first} wheel ${SKY_WHEELS.indexOf(w)} at ${(angle / deg).toFixed(3)}°`,
            // The river velocities come near the speed floor, where the defines' 9 significant
            // figures differ from the mirror's float64 by a few parts in a million.
          ).toBeCloseTo(expected, first === 0 ? 5 : 4);
          compared++;
          if (expected > 0.05 && expected < 0.95) faded++;
        }
      }
    }
    expect(compared).toBeGreaterThan(11800);
    expect(faded).toBeGreaterThan(600);
    const defines = skySwirlGlslDefines();
    expect(parseGlsl(String(defines.SKY_WHEELFLOW_SENSES))).toEqual(
      SKY_WHEELS.map((w) => Math.sign(w.rate)),
    );
    const cosines = parseGlsl(String(defines.SKY_WHEEL_EDGE_COSS)) as number[];
    const sines = parseGlsl(String(defines.SKY_WHEEL_EDGE_SINS)) as number[];
    SKY_WHEELS.forEach((w, i) => {
      expect(cosines[i]).toBeCloseTo(Math.cos(skyWheelEdge(w)), 8);
      expect(sines[i]).toBeCloseTo(Math.sin(skyWheelEdge(w)), 8);
    });
    expect(parseGlsl(String(defines.SKY_SWIRL_HALF_PERIOD))).toBe(0.5 * SKY_SWIRL_PERIOD);
  });

  test('GLSL: both skyMotion paths call the one river motion first, the hoist included, and every wrap links the same program with the iRiver default', () => {
    const call =
      'if (uSkyWrap >= SKY_WRAP_WHEELFLOW) {\n    return skyRiverMotion(p, n, l, s, phase, t, flowExtent, rigid);\n  }';
    expect(motionGlsl.split(call)).toHaveLength(3);
    expect(motionGlsl.match(/Motion skyRiverMotion\(/g)).toHaveLength(1);
    expect(motionGlsl.indexOf('Motion skyRiverMotion(')).toBeLessThan(
      motionGlsl.indexOf('#ifdef VTX_HOIST\n// The `vtx` group'),
    );
    expect(motionGlsl).not.toContain('halfAngles');
    expect(motionGlsl).toContain(
      'm = skyMotion(p, n, l, s, brush, phase, t, flowExtent, rigid, stream);',
    );
    expect(motionGlsl).toContain(
      'if (layer != STROKE_LAYER_SKY || uSkyWrap == SKY_WRAP_STREAM) return 0.0;',
    );
    expect(strokeVert).toContain('in vec4 iRiver;');
    expect(strokeVert.indexOf('in vec4 iRiver;')).toBeLessThan(
      strokeVert.indexOf('#ifdef VTX_HOIST'),
    );
    const defines = skySwirlGlslDefines();
    expect(defines.SKY_RIVER_FIRST_WHEEL).toBe(SKY_RIVER_FIRST_WHEEL);
    expect(Number(defines.SKY_RIVER_INV_SPEED)).toBeCloseTo(1 / SKY_RIVER_SPEED, 4);
    expect(Number(defines.SKY_RIVER_JITTER)).toBe(SKY_RIVER_JITTER);
    expect(SKY_RIVER_WHEELS).toEqual(SKY_WHEELS.slice(SKY_RIVER_FIRST_WHEEL));
    const material = createStrokeMaterial(new Texture());
    expect((material.defaultAttributeValues as Record<string, number[]>).iRiver).toEqual([
      0, 0, 0, 0,
    ]);
    const before = createStrokeMaterial(new Texture());
    const shaders = [before.vertexShader, before.fragmentShader, { ...before.defines }];
    try {
      expect(SKY_WRAPS).toContain('wheelrun');
      for (const wrap of SKY_WRAPS) {
        motionVariants.setWrap(wrap);
        const after = createStrokeMaterial(new Texture());
        expect([after.vertexShader, after.fragmentShader, after.defines]).toEqual(shaders);
        expect(after.uniforms.uSkyWrap).toBe(before.uniforms.uSkyWrap);
      }
    } finally {
      motionVariants.setWrap(DEFAULT_SKY_WRAP);
    }
  });
});

/** The largest difference, radians, in how far two far-band dome strokes 0.02° apart travel. */
const SEAM_LIMIT = (0.1 * Math.PI) / 180;

function smoothstepTs(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

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
 * skyWheelRunGain from motion.glsl, transliterated to JavaScript and run on the material's own
 * defines, with the uCalm uniform as an argument. The skyMotion branches that call it build vec3
 * expressions with GLSL operator overloading (tau * cross(omega, d)), which a line-for-line
 * transliteration cannot run without a vector-expression rewriter, so they are checked as text.
 */
function glslWheelRunGain(): (f: number, travel: number, calm: number) => number {
  const head = 'float skyWheelRunGain(float f, float travel) {';
  const start = motionGlsl.indexOf(head);
  const end = motionGlsl.indexOf('\n}\n', start);
  expect(start).toBeGreaterThan(0);
  const body = motionGlsl.slice(start + head.length, end);
  const defines = skySwirlGlslDefines();
  const env: Record<string, unknown> = {};
  for (const name of body.match(/\bSKY_[A-Z0-9_]+\b/g) ?? []) {
    env[name] = parseGlsl(String(defines[name]));
  }
  expect(Object.keys(env).sort()).toEqual([
    'SKY_SWIRL_FADE',
    'SKY_WHEELRUN_CALM_FADE',
    'SKY_WHEELRUN_GAIN_TRAVEL',
  ]);
  const math = {
    smoothstep: (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    },
    min: Math.min,
  };
  const names = [...Object.keys(env), ...Object.keys(math)];
  const run = new Function(...names, 'f', 'travel', 'uCalm', body) as (
    ...args: unknown[]
  ) => number;
  const values = [...Object.values(env), ...Object.values(math)];
  return (f, travel, calm) => run(...values, f, travel, calm);
}

/**
 * skyWheelFlowTravel from motion.glsl, transliterated to JavaScript line for line and run on the
 * material's own defines, so a test can evaluate the shader's fades rather than its text.
 */
function glslWheelFlowTravel(): (dir: Vec3, v: Vec3, h: number, first: number) => number {
  const head = 'float skyWheelFlowTravel(vec3 dir, vec3 v, float h, int first) {';
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
  const run = new Function(...names, 'dir', 'v', 'h', 'first', body) as (
    ...args: unknown[]
  ) => number;
  const values = [...Object.values(env), ...Object.values(math)];
  return (dir, v, h, first) => run(...values, dir, v, h, first);
}
