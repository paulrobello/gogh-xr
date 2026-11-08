import { Texture } from 'three';
import { describe, expect, test } from 'vitest';
import motionGlsl from '../src/motion/motion.glsl?raw';
import {
  hashSkyDirections,
  SKY_COUNTER_FLOW_RADIUS,
  skyCounterFlow,
} from '../src/motion/sky-counter-flow.ts';
import {
  SKY_SWIRL_FADE,
  SKY_SWIRL_PERIOD,
  SKY_VORTICES,
  SKY_WAVE_FADE_RADIUS,
  SKY_WAVE_JITTER,
  SKY_WAVE_PER_TURN,
  SKY_WAVE_POLES,
  SKY_WAVE_TURNS,
  skyStagnation,
  skySwirl,
  skySwirlGlslDefines,
  skySwirlReach,
  skyVelocity,
  skyVortexCentre,
  skyWaveFade,
  skyWaveFadePoles,
  skyWavePhase,
  skyWavePolesFor,
  skyWaveProductPhase,
  skyWrapLoop,
  skyWrapPhase,
} from '../src/motion/sky-swirl.ts';
import { createMotionVariants, motionVariants } from '../src/motion/variant-uniforms.ts';
import { motionVariantGlslDefines, SKY_WRAPS, type SkyWrap } from '../src/motion/variants.ts';
import { PAINTER_EYE } from '../src/paintings/starry-night/canvas-camera.ts';
import type { Vec3 } from '../src/render/strokes/frame.ts';
import { createStrokeMaterial } from '../src/render/strokes/material.ts';
import strokeFrag from '../src/render/strokes/stroke.frag.glsl?raw';
import strokeVert from '../src/render/strokes/stroke.vert.glsl?raw';
import { mulberry32 } from '../src/util/prng.ts';
import { SKY_DOME_RADIUS } from '../src/world/sky.ts';

/** Share of a uniform phase sweep at which the stroke draws below `limit` of its rest size. */
function smallShare(wrap: SkyWrap, limit: number, time: number): number {
  const n = 256;
  let small = 0;
  for (let i = 0; i < n; i++) if (1 + skyWrapLoop(wrap, i / n, time).gain < limit) small++;
  return small / n;
}

const fract = (x: number): number => x - Math.floor(x);
/** A dome stroke ahead of and above the painter's eye, inside the central swirl's sweep. */
const DOME: [number, number, number] = [-30, 50, -60];
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const onDome = (d: Vec3): Vec3 => [
  PAINTER_EYE[0] + SKY_DOME_RADIUS * d[0],
  PAINTER_EYE[1] + SKY_DOME_RADIUS * d[1],
  PAINTER_EYE[2] + SKY_DOME_RADIUS * d[2],
];
const angle = (a: Vec3, b: Vec3): number =>
  Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));

/**
 * Dome strokes at a sky stroke's spacing: a Fibonacci sphere of 60000 points (0.83° apart), from
 * 10° below the horizon up, each with a seeded phase byte.
 */
function domeStrokes(): { directions: Vec3[]; phases: number[] } {
  const n = 60000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const rand = mulberry32(7);
  const directions: Vec3[] = [];
  const phases: number[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    if (y < -Math.sin((10 * Math.PI) / 180)) continue;
    const r = Math.sqrt(1 - y * y);
    directions.push([r * Math.cos(golden * i), y, r * Math.sin(golden * i)]);
    phases.push(Math.floor(rand() * 256) / 256);
  }
  return { directions, phases };
}
const DOME_STROKES = domeStrokes();
const DOME_HASH = hashSkyDirections(new Float32Array(DOME_STROKES.directions.flat()));
/** The painter's view: ahead of the eye and above the horizon, below 48° up. */
const inFront = (d: Vec3): boolean => d[2] < -0.5 && d[1] > 0 && d[1] < 0.75;

/** The counter-flow of the dome strokes under `wrap`, averaged over 16 times across the loop. */
function domeCounterFlow(
  wrap: SkyWrap,
  region: (d: Vec3) => boolean = () => true,
  jitter = true,
): number {
  const { directions, phases } = DOME_STROKES;
  const loop = directions.map((d, i) => {
    const p = skyWrapPhase(wrap, onDome(d), phases[i]);
    return jitter || wrap !== 'wave' ? p : p - SKY_WAVE_JITTER * (phases[i] - 0.5);
  });
  const centres = directions.flatMap((d, i) => (region(d) ? [i] : []));
  let pairs = 0;
  let opposed = 0;
  for (let k = 0; k < 16; k++) {
    const time = (k * SKY_SWIRL_PERIOD) / 16;
    const returning = Uint8Array.from(loop, (p) => (skyWrapLoop(wrap, p, time).returning ? 1 : 0));
    const flow = skyCounterFlow(DOME_HASH, returning, centres);
    pairs += flow.pairs;
    opposed += flow.opposed;
  }
  return opposed / pairs;
}

describe('sky wrap variants', () => {
  test('the variants are base, pingpong and wave, base first: opacity is retired and flow not built', () => {
    expect(SKY_WRAPS).toEqual(['base', 'pingpong', 'wave']);
  });

  test('base is the P4.2 loop exactly', () => {
    for (const phase of [0, 0.01, 0.03, 0.5, 0.97, 0.999]) {
      for (const time of [0, 0.5, 3.7, 7.99]) {
        const f = fract(time / SKY_SWIRL_PERIOD + phase);
        const loop = skyWrapLoop('base', phase, time);
        expect(loop.tau).toBeCloseTo((f - 0.5) * SKY_SWIRL_PERIOD, 12);
        expect(loop.returning).toBe(false);
      }
    }
    expect(skyWrapLoop('base', 0, 0).gain).toBe(-1);
    expect(skySwirl(DOME, [0, -1, 0], 0.2, 3.7)).toEqual(
      skySwirl(DOME, [0, -1, 0], 0.2, 3.7, undefined, 'base'),
    );
    // Only wave reads the position for the loop phase.
    expect(skyWrapPhase('base', DOME, 0.2)).toBe(0.2);
    expect(skyWrapPhase('pingpong', DOME, 0.2)).toBe(0.2);
  });

  test('pingpong: no stroke changes size and none jumps, the position is continuous across the loop', () => {
    const n = 8000;
    // smoothstep's slope peaks at 1.5, and 1 − |2f − 1| has slope 2: 3 PERIOD per unit of f.
    const maxStep = (3 * SKY_SWIRL_PERIOD) / n;
    let previous = skyWrapLoop('pingpong', 0, 0).tau;
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let i = 1; i <= n; i++) {
      const loop = skyWrapLoop('pingpong', i / n, 0);
      expect(loop.gain).toBe(0);
      expect(Math.abs(loop.tau)).toBeLessThanOrEqual(0.5 * SKY_SWIRL_PERIOD + 1e-12);
      expect(Math.abs(loop.tau - previous)).toBeLessThanOrEqual(maxStep * (1 + 1e-9));
      expect(loop.returning).toBe(fract(i / n) > 0.5);
      previous = loop.tau;
      low = Math.min(low, loop.tau);
      high = Math.max(high, loop.tau);
    }
    // It sweeps base's whole arc, and the two ends of the loop meet.
    expect(low).toBeCloseTo(-0.5 * SKY_SWIRL_PERIOD, 12);
    expect(high).toBeCloseTo(0.5 * SKY_SWIRL_PERIOD, 12);
    expect(skyWrapLoop('pingpong', 1 - 1e-9, 0).tau).toBeCloseTo(
      skyWrapLoop('pingpong', 0, 0).tau,
      6,
    );
    // A real stroke's centre, frame to frame at 90 Hz across the loop's end, moves by a sliver of its
    // reach, where base jumps the whole arc.
    const reach = skySwirlReach(...DOME);
    const step = (wrap: SkyWrap): number => {
      const a = skySwirl(DOME, [0, -1, 0], 0, SKY_SWIRL_PERIOD - 1 / 180, undefined, wrap).offset;
      const b = skySwirl(DOME, [0, -1, 0], 0, SKY_SWIRL_PERIOD + 1 / 180, undefined, wrap).offset;
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    };
    expect(step('pingpong')).toBeLessThan(1e-3 * reach);
    expect(step('base')).toBeGreaterThan(1.9 * reach);
    // Within base's reach, which the cull growth and the haze thin cover.
    for (let i = 0; i <= 200; i++) {
      const o = skySwirl(DOME, [0, -1, 0], i / 200, 0, undefined, 'pingpong').offset;
      expect(Math.hypot(...o)).toBeLessThanOrEqual(reach * (1 + 1e-9));
    }
  });

  test('the size modulation: only base draws strokes below 0.8 of their rest size', () => {
    const base = smallShare('base', 0.8, 3.7);
    expect(base).toBeGreaterThan(0.07);
    expect(base).toBeLessThan(0.1);
    expect(smallShare('pingpong', 0.8, 3.7)).toBe(0);
    expect(smallShare('wave', 0.8, 3.7)).toBe(0);
    expect(SKY_SWIRL_FADE).toBe(0.06);
  });

  test('the variant uniform switches live', () => {
    const variants = createMotionVariants();
    expect(variants.diag()).toEqual({ wrap: 'base' });
    variants.setWrap('wave');
    expect(variants.uniforms.uSkyWrap.value).toBe(2);
    expect(variants.diag()).toEqual({ wrap: 'wave' });
    variants.setWrap('pingpong');
    expect(variants.uniforms.uSkyWrap.value).toBe(1);
    variants.setWrap('base');
    expect(variants.uniforms.uSkyWrap.value).toBe(0);
    // The wave's waves per turn is a uniform too, so ?waveturns links no new program.
    expect(variants.waveTurns()).toBe(SKY_WAVE_PER_TURN);
    expect(variants.uniforms.uWaveTurns.value).toBe(2);
    variants.setWaveTurns(3);
    expect(variants.uniforms.uWaveTurns.value).toBe(3);
    expect(variants.waveTurns()).toBe(3);
    expect(variants.diag()).toEqual({ wrap: 'base' });
    expect(Object.keys(variants.uniforms)).toEqual(['uSkyWrap', 'uWaveTurns']);
  });
});

describe('wave', () => {
  test('the wavelength: 2 waves per turn round the central swirl by default, 1 to 3 by ?waveturns, each other vortex with a velocity zero its circulation share', () => {
    expect(SKY_WAVE_PER_TURN).toBe(2);
    expect(SKY_WAVE_TURNS).toEqual([1, 2, 3]);
    // The two small eddies hold no velocity zero, so they wind 0.
    expect(SKY_WAVE_POLES.map((p) => p.winding)).toEqual([2, 1, 0, 0, -3]);
    expect(SKY_WAVE_TURNS.map((t) => skyWavePolesFor(t).map((p) => p.winding))).toEqual([
      [1, 1, 0, 0, -2],
      [2, 1, 0, 0, -3],
      [3, 1, 0, 0, -4],
    ]);
    expect(SKY_VORTICES.map((v) => skyVortexCentre(v) !== null)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    // The windings cancel, so the phase is single-valued over the whole sphere.
    expect(SKY_WAVE_POLES.reduce((sum, p) => sum + p.winding, 0)).toBe(0);
    // The last pole is the field's stagnation point above and behind the painter.
    const stagnation = skyStagnation();
    expect(SKY_WAVE_POLES[4].direction).toEqual(stagnation);
    expect(Math.hypot(...skyVelocity(stagnation))).toBeLessThan(1e-12);
    expect(stagnation[1]).toBeGreaterThan(0.8);
    expect(stagnation[2]).toBeGreaterThan(0.5);
    expect(SKY_WAVE_JITTER).toBe(1 / 32);
  });

  test('each vortex winding sits at a velocity zero of the field inside its core, where the strokes stand still', () => {
    const { directions } = DOME_STROKES;
    const front = directions
      .filter(inFront)
      .map((d) => Math.hypot(...skyVelocity(d)))
      .sort((a, b) => a - b);
    const median = front[front.length >> 1];
    SKY_VORTICES.forEach((vortex, i) => {
      const pole = SKY_WAVE_POLES[i];
      if (pole.winding === 0) return;
      // The zero sits off the painted axis, where the vortex's own turn cancels the flow across it.
      expect(Math.hypot(...skyVelocity(pole.direction))).toBeLessThan(1e-12);
      const chord = Math.hypot(
        pole.direction[0] - vortex.axis[0],
        pole.direction[1] - vortex.axis[1],
        pole.direction[2] - vortex.axis[2],
      );
      expect(chord).toBeLessThan(vortex.core);
      expect(chord).toBeGreaterThan(0.01);
      // Every phase meets at a winding, but the strokes nearest it barely move: within 1.5° of it
      // they average under a third of the front's median speed, where the painted axis moves at
      // about the median.
      const near = directions.filter((d) => angle(d, pole.direction) < (1.5 * Math.PI) / 180);
      const speed = near.reduce((sum, d) => sum + Math.hypot(...skyVelocity(d)), 0) / near.length;
      expect(speed / median).toBeLessThan(1 / 3);
      expect(Math.hypot(...skyVelocity(vortex.axis)) / median).toBeGreaterThan(0.5);
    });
    // The eddies' slowest point inside their core still moves: no zero, so no winding.
    for (const vortex of SKY_VORTICES.slice(2)) expect(skyVortexCentre(vortex)).toBeNull();
  });

  test('near each painted vortex centre wave counter-flows far less than pingpong', () => {
    const shares = SKY_VORTICES.map((vortex) => {
      const near = (d: Vec3): boolean => angle(d, vortex.axis) <= (3 * Math.PI) / 180;
      return { wave: domeCounterFlow('wave', near), pingpong: domeCounterFlow('pingpong', near) };
    });
    console.log(
      `[wave] counter-flow among centres within 3° of each vortex centre: ${shares.map((s, i) => `${SKY_VORTICES[i].note.slice(0, 28)} wave ${(100 * s.wave).toFixed(1)}%, pingpong ${(100 * s.pingpong).toFixed(1)}%`).join('; ')}`,
    );
    for (const s of shares) {
      expect(s.wave).toBeLessThan(0.2);
      expect(s.wave).toBeLessThan(0.4 * s.pingpong);
    }
  });

  test('the travel fades to nothing at each pole and is full from SKY_WAVE_FADE_RADIUS out', () => {
    expect(SKY_WAVE_FADE_RADIUS).toBeCloseTo((3 * Math.PI) / 180, 12);
    // The poles with a winding at any wavelength: the two central zeros and the stagnation point.
    const poles = skyWaveFadePoles();
    const windingPoles = SKY_WAVE_POLES.filter((p) => p.winding !== 0).map((p) => p.direction);
    expect(poles).toEqual(windingPoles);
    for (const pole of poles) expect(skyWaveFade(pole)).toBe(0);
    let faded = 0;
    for (const d of DOME_STROKES.directions) {
      const nearest = Math.min(...poles.map((p) => angle(d, p)));
      const fade = skyWaveFade(d);
      if (nearest >= SKY_WAVE_FADE_RADIUS * (1 + 1e-9)) expect(fade).toBe(1);
      else {
        expect(fade).toBeGreaterThanOrEqual(0);
        expect(fade).toBeLessThan(1);
        faded++;
      }
      // The faded travel is the wave's own, scaled: within its share of the stroke's reach.
      const p = onDome(d);
      const m = skySwirl(p, [0, -1, 0], 0.3, 1.7, undefined, 'wave');
      expect(Math.hypot(...m.offset)).toBeLessThanOrEqual(fade * skySwirlReach(...p) * (1 + 1e-9));
    }
    // About 3 × (1 − cos 3°) / 2 of the sphere: a few dozen of the 60000.
    expect(faded).toBeGreaterThan(20);
    expect(faded).toBeLessThan(200);
    // Base and pingpong do not fade.
    const p = onDome(poles[0]);
    expect(skySwirl(p, [0, -1, 0], 0.3, 1.7, undefined, 'pingpong').offset).not.toEqual(
      skySwirl(p, [0, -1, 0], 0.3, 1.7, undefined, 'wave').offset,
    );
  });

  test('the phase is single-valued: a closed loop round each pole and round the nadir returns to its phase', () => {
    const loopRound = (centre: Vec3, radius: number): number => {
      const side = unit(Math.abs(centre[1]) < 0.9 ? [-centre[2], 0, centre[0]] : [1, 0, 0]);
      const other: Vec3 = [
        centre[1] * side[2] - centre[2] * side[1],
        centre[2] * side[0] - centre[0] * side[2],
        centre[0] * side[1] - centre[1] * side[0],
      ];
      const at = (a: number): Vec3 => {
        const c = radius * Math.cos(a);
        const s = radius * Math.sin(a);
        return unit([
          centre[0] + c * side[0] + s * other[0],
          centre[1] + c * side[1] + s * other[1],
          centre[2] + c * side[2] + s * other[2],
        ]);
      };
      let turned = 0;
      let previous = skyWavePhase(at(0));
      for (let i = 1; i <= 720; i++) {
        const d = at((2 * Math.PI * i) / 720);
        const phase = skyWavePhase(d);
        const step = phase - previous;
        // Along a fine loop the phase never steps by a large fraction of a loop.
        expect(Math.abs(step - Math.round(step))).toBeLessThan(0.05);
        turned += step - Math.round(step);
        previous = phase;
      }
      return turned;
    };
    for (const pole of SKY_WAVE_POLES) {
      // A small loop round a pole turns the phase by its winding (sign by the loop's sense).
      expect(Math.abs(loopRound(pole.direction, 0.01))).toBeCloseTo(Math.abs(pole.winding), 6);
    }
    // Round the nadir the windings cancel, so the phase has no seam below the ground either.
    expect(loopRound([0, -1, 0], 0.3)).toBeCloseTo(0, 6);
  });

  test('no stroke changes size or jumps, and every offset stays within the reach the cull and the haze thin cover', () => {
    const rand = mulberry32(11);
    for (let s = 0; s < 400; s++) {
      const d = unit([rand() * 2 - 1, rand() * 1.2 - 0.2, rand() * 2 - 1]);
      const p = onDome(d);
      const phase = Math.floor(rand() * 256) / 256;
      const reach = skySwirlReach(...p);
      // 90 Hz frames across two loops: the centre moves at most pingpong's peak step.
      let previous = skySwirl(p, [0, -1, 0], phase, 0, undefined, 'wave').offset;
      for (let i = 1; i <= 1440; i++) {
        const m = skySwirl(p, [0, -1, 0], phase, i / 90, undefined, 'wave');
        expect(m.gain).toBe(0);
        expect(Math.hypot(...m.offset)).toBeLessThanOrEqual(reach * (1 + 1e-9));
        const step = Math.hypot(
          m.offset[0] - previous[0],
          m.offset[1] - previous[1],
          m.offset[2] - previous[2],
        );
        // reach is half a loop at the stroke's speed; pingpong's peak is 3x base's.
        expect(step).toBeLessThanOrEqual(
          ((3 * reach) / (0.5 * SKY_SWIRL_PERIOD)) * (1 / 90) * 1.001,
        );
        previous = m.offset;
      }
    }
  });

  test('neighbours along the arc move together, where pingpong splits half of them', () => {
    // Each front stroke and the point 0.5° ahead along its flow, about one sky stroke spacing and a
    // fiftieth of a wave at the central swirl's core edge.
    const { directions, phases } = DOME_STROKES;
    let pairs = 0;
    const split: Record<'wave' | 'pingpong', number> = { wave: 0, pingpong: 0 };
    const rand = mulberry32(3);
    directions.forEach((d, i) => {
      if (!inFront(d)) return;
      const v = skyVelocity(d);
      const speed = Math.hypot(...v);
      const step = (0.5 * Math.PI) / 180;
      const ahead = unit([
        d[0] + (step * v[0]) / speed,
        d[1] + (step * v[1]) / speed,
        d[2] + (step * v[2]) / speed,
      ]);
      const other = Math.floor(rand() * 256) / 256;
      for (const time of [0, 2, 4, 6]) {
        pairs += time === 0 ? 1 : 0;
        for (const wrap of ['wave', 'pingpong'] as const) {
          const a = skyWrapLoop(wrap, skyWrapPhase(wrap, onDome(d), phases[i]), time).returning;
          const b = skyWrapLoop(wrap, skyWrapPhase(wrap, onDome(ahead), other), time).returning;
          if (a !== b) split[wrap] += 0.25;
        }
      }
    });
    console.log(
      `[wave] neighbours 0.5° apart along the flow, front: wave splits ${((100 * split.wave) / pairs).toFixed(2)}%, pingpong ${((100 * split.pingpong) / pairs).toFixed(2)}% of ${pairs}`,
    );
    expect(split.wave / pairs).toBeLessThan(0.06);
    expect(split.pingpong / pairs).toBeGreaterThan(0.45);
  });

  test('the bands travel forward along the flow in front of the painter, behind and to the sides', () => {
    const regions: Record<string, (d: Vec3) => boolean> = {
      front: inFront,
      behind: (d) => d[2] > 0.5 && d[1] > 0 && d[1] < 0.75,
      up: (d) => d[1] >= 0.75 && angle(d, SKY_WAVE_POLES[4].direction) > 0.05,
    };
    for (const [name, region] of Object.entries(regions)) {
      let along = 0;
      let count = 0;
      for (const d of DOME_STROKES.directions) {
        if (!region(d)) continue;
        const v = skyVelocity(d);
        const speed = Math.hypot(...v);
        const step = 1e-4;
        const ahead = unit([
          d[0] + (step * v[0]) / speed,
          d[1] + (step * v[1]) / speed,
          d[2] + (step * v[2]) / speed,
        ]);
        let dp = skyWavePhase(ahead) - skyWavePhase(d);
        dp -= Math.round(dp);
        // A band of equal loop fraction moves to where the phase is smaller: downstream when the
        // phase falls along the flow.
        if (dp < 0) along++;
        count++;
      }
      console.log(
        `[wave] bands travel downstream at ${((100 * along) / count).toFixed(1)}% of ${name} strokes`,
      );
      expect(along / count, name).toBeGreaterThan(0.9);
    }
  });

  test('the local counter-flow: pingpong near half, wave far lower', () => {
    const pingpong = domeCounterFlow('pingpong');
    const wave = domeCounterFlow('wave');
    const waveFront = domeCounterFlow('wave', inFront);
    const waveNoJitter = domeCounterFlow('wave', () => true, false);
    const waveFrontNoJitter = domeCounterFlow('wave', inFront, false);
    console.log(
      `[wave] counter-flow within ${((SKY_COUNTER_FLOW_RADIUS * 180) / Math.PI).toFixed(1)}° (Fibonacci dome, 0.83° spacing, 16 times): pingpong ${(100 * pingpong).toFixed(2)}%, wave ${(100 * wave).toFixed(2)}% (front ${(100 * waveFront).toFixed(2)}%), without jitter ${(100 * waveNoJitter).toFixed(2)}% (front ${(100 * waveFrontNoJitter).toFixed(2)}%), base ${(100 * domeCounterFlow('base')).toFixed(2)}%`,
    );
    expect(pingpong).toBeGreaterThan(0.48);
    expect(pingpong).toBeLessThan(0.52);
    expect(wave).toBeLessThan(0.06);
    expect(waveFront).toBeLessThan(0.1);
    expect(waveNoJitter).toBeLessThan(wave);
    expect(domeCounterFlow('base')).toBe(0);
  });

  test('skyCounterFlow counts each nearby pair and skips the undrawn', () => {
    const d = (deg: number): number[] => [
      Math.sin((deg * Math.PI) / 180),
      0,
      -Math.cos((deg * Math.PI) / 180),
    ];
    const hash = hashSkyDirections(new Float32Array([...d(0), ...d(1), ...d(1.5), ...d(5)]));
    // 0 and 1 and 1.5 are within 2° of each other, 5 is alone.
    expect(skyCounterFlow(hash, Uint8Array.from([0, 1, 0, 1]))).toEqual({
      pairs: 6,
      opposed: 4,
      share: 4 / 6,
    });
    expect(skyCounterFlow(hash, Uint8Array.from([0, 1, 255, 1]))).toEqual({
      pairs: 2,
      opposed: 2,
      share: 1,
    });
    expect(skyCounterFlow(hash, Uint8Array.from([0, 0, 0, 1]), [3])).toEqual({
      pairs: 0,
      opposed: 0,
      share: 0,
    });
  });
});

describe('GLSL', () => {
  test('uSkyWrap is read only in the sky motion: one compare under base, a second inside skyWrapMotion', () => {
    const sky = motionGlsl.slice(
      motionGlsl.indexOf('Motion skyMotion('),
      motionGlsl.indexOf('Motion ringMotion('),
    );
    expect(sky).toContain('if (uSkyWrap != 0u) return skyWrapMotion(');
    // The declaration, skyWrapMotion's wave test and skyMotion's compare.
    expect(motionGlsl.match(/uSkyWrap/g)).toHaveLength(3);
    // uWaveTurns: the declaration and skyWavePhase's loop, which only the wave branch calls.
    expect(motionGlsl.replace(/\/\/.*$/gm, '').match(/uWaveTurns/g)).toHaveLength(2);
    const wrap = motionGlsl.slice(
      motionGlsl.indexOf('Motion skyWrapMotion('),
      motionGlsl.indexOf('Motion skyMotion('),
    );
    // The formulas skyWrapPhase and skyWrapLoop mirror. tests/e2e/ab.spec.ts checks what the GPU
    // draws with them.
    expect(wrap).toContain('float amplitude = SKY_SWIRL_PERIOD;');
    expect(wrap).toContain('if (uSkyWrap == SKY_WRAP_WAVE) {');
    expect(wrap).toContain('phase = skyWavePhase(dir) + SKY_WAVE_JITTER * (phase - 0.5);');
    expect(wrap).toContain('amplitude *= skyWaveFade(dir);');
    expect(wrap).toContain(
      'float tau = (smoothstep(0.0, 1.0, 1.0 - abs(2.0 * f - 1.0)) - 0.5) * amplitude;',
    );
    // Neither variant changes the size.
    expect(wrap).toContain('return Motion(tau * cross(omega, d), tau * dot(omega, n), 0.0, 0.0);');
    const phase = motionGlsl.slice(
      motionGlsl.indexOf('float skyWavePhase('),
      motionGlsl.indexOf('Motion skyWrapMotion('),
    );
    expect(phase).toContain('vec2 z = dir.xz / max(1.0 + dir.y, 1e-6);');
    expect(phase).toContain('SKY_WAVE_PRODUCT');
    expect(phase).toContain('for (int i = 0; i < SKY_WAVE_MAX_TURNS; i++) {');
    expect(phase).toContain('if (i >= uWaveTurns) break;');
    expect(phase).toContain('q = skyCmul(q, a);');
    expect(phase).toContain('fade *= smoothstep(0.0, SKY_WAVE_FADE_CHORD2, dot(e, e));');
    expect(phase).toContain('return atan(q.y, q.x) * SKY_WAVE_INV_TAU;');
    // One atan for the whole phase, however many windings.
    expect(phase.match(/\batan\(/g)).toHaveLength(1);
    expect(motionGlsl).not.toMatch(/SKY_WRAP_OPACITY|SKY_WRAP_PINGPONG|inout float alpha/);
  });

  test('the opacity weight is gone: the colour varying is the colour', () => {
    expect(strokeVert).toContain('flat out vec3 vColor;');
    expect(strokeVert).toContain('vColor = color;');
    expect(strokeFrag).toContain('flat in vec3 vColor;');
    expect(strokeFrag).toContain('fragColor = vec4(vColor * tone * shade, alpha);');
    expect(strokeFrag).not.toMatch(/vColor\.a|vAlpha/);
  });

  test('the stroke material shares the variant uniform and carries its defines', () => {
    const a = createStrokeMaterial(new Texture());
    const b = createStrokeMaterial(new Texture());
    expect(a.uniforms.uSkyWrap).toBe(b.uniforms.uSkyWrap);
    for (const [key, value] of Object.entries(motionVariantGlslDefines())) {
      expect(a.defines[key]).toBe(value);
    }
    expect(motionVariantGlslDefines()).toEqual({ SKY_WRAP_WAVE: '2u' });
    const defines = skySwirlGlslDefines();
    // A factor per non-zero winding: the central pair and the stagnation point.
    expect(String(defines.SKY_WAVE_PRODUCT).match(/= z - vec2\(/g)).toHaveLength(3);
    expect(defines.SKY_WAVE_INV_TAU).toBe((1 / (2 * Math.PI)).toExponential(8));
    expect(a.defines.SKY_WAVE_PRODUCT).toBe(defines.SKY_WAVE_PRODUCT);
    expect(a.defines.SKY_WAVE_INV_TAU).toBe(defines.SKY_WAVE_INV_TAU);
    expect(a.defines.SKY_WAVE_JITTER).toBe(defines.SKY_WAVE_JITTER);
    expect(a.uniforms.uWaveTurns).toBe(b.uniforms.uWaveTurns);
    expect(defines.SKY_WAVE_MAX_TURNS).toBe(3);
    // The fade's poles: the two central zeros and the stagnation point.
    expect(defines.SKY_WAVE_FADE_COUNT).toBe(3);
    expect(String(defines.SKY_WAVE_FADE_POLES).match(/vec3\(/g)).toHaveLength(3);
    const chord = 2 * Math.sin(SKY_WAVE_FADE_RADIUS / 2);
    expect(defines.SKY_WAVE_FADE_CHORD2).toBe((chord * chord).toExponential(8));
    for (const key of ['SKY_WAVE_MAX_TURNS', 'SKY_WAVE_FADE_COUNT', 'SKY_WAVE_FADE_POLES']) {
      expect(a.defines[key]).toBe(defines[key]);
    }
  });

  test('?waveturns is a uniform: the stroke material links the same program at every wavelength', () => {
    const before = createStrokeMaterial(new Texture());
    const defines = { ...before.defines };
    try {
      for (const turns of SKY_WAVE_TURNS) {
        motionVariants.setWaveTurns(turns);
        const after = createStrokeMaterial(new Texture());
        expect(after.defines).toEqual(defines);
        expect(after.vertexShader).toBe(before.vertexShader);
        expect(after.fragmentShader).toBe(before.fragmentShader);
        // The value reaches every material through the shared uniform object.
        expect(before.uniforms.uWaveTurns).toBe(after.uniforms.uWaveTurns);
        expect(before.uniforms.uWaveTurns.value).toBe(turns);
      }
    } finally {
      motionVariants.setWaveTurns(SKY_WAVE_PER_TURN);
    }
  });

  test("the shader's one-atan product is the mirror's sum of windings, up to whole loops", () => {
    // Runs SKY_WAVE_PRODUCT's statements as written, then motion.glsl's return line.
    const statements = String(skySwirlGlslDefines().SKY_WAVE_PRODUCT)
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const glslPhase = (dir: Vec3, turns: number): number => {
      const k = 1 / Math.max(1 + dir[1], 1e-6);
      const z = [dir[0] * k, dir[2] * k];
      const env = new Map<string, number[]>();
      const get = (name: string): number[] => {
        const v = env.get(name);
        if (!v) throw new Error(`unset ${name}`);
        return v;
      };
      const mul = (a: number[], b: number[]): number[] => [
        a[0] * b[0] - a[1] * b[1],
        a[0] * b[1] + a[1] * b[0],
      ];
      const rules: [RegExp, (m: RegExpMatchArray) => void][] = [
        [
          /^vec2 (\w+) = z - vec2\(([^,]+), ([^)]+)\)$/,
          (m) => env.set(m[1], [z[0] - Number(m[2]), z[1] - Number(m[3])]),
        ],
        [
          /^(\w+) \*= inversesqrt\(max\(dot\((\w+), (\w+)\), ([^)]+)\)\)$/,
          (m) => {
            expect([m[2], m[3]]).toEqual([m[1], m[1]]);
            const e = get(m[1]);
            const r = 1 / Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1], Number(m[4])));
            env.set(m[1], [e[0] * r, e[1] * r]);
          },
        ],
        [
          /^vec2 (\w+) = vec2\((\w+)\.x, -(\w+)\.y\)$/,
          (m) => {
            expect(m[3]).toBe(m[2]);
            const e = get(m[2]);
            env.set(m[1], [e[0], -e[1]]);
          },
        ],
        [/^vec2 (\w+) = skyCmul\((\w+), (\w+)\)$/, (m) => env.set(m[1], mul(get(m[2]), get(m[3])))],
        [
          /^([qa]) = skyCmul\(([qa]), (\w+)\)$/,
          (m) => {
            expect(m[2]).toBe(m[1]);
            env.set(m[1], mul(get(m[1]), get(m[3])));
          },
        ],
        [/^vec2 ([qa]) = vec2\(1\.0, 0\.0\)$/, (m) => env.set(m[1], [1, 0])],
        [/^vec2 ([qa]) = (\w+)$/, (m) => env.set(m[1], get(m[2]))],
      ];
      for (const s of statements) {
        const rule = rules.find(([pattern]) => pattern.test(s));
        if (!rule) throw new Error(`unexpected statement: ${s}`);
        rule[1](s.match(rule[0]) as RegExpMatchArray);
      }
      // motion.glsl's loop: q times a, uWaveTurns times.
      let q = get('q');
      for (let t = 0; t < turns; t++) q = mul(q, get('a'));
      return Math.atan2(q[1], q[0]) / (2 * Math.PI);
    };
    const rand = mulberry32(5);
    const loopGap = (a: number, b: number): number => Math.abs(a - b - Math.round(a - b));
    let product = 0;
    let shader = 0;
    for (let i = 0; i < 20000; i++) {
      const d = unit([rand() * 2 - 1, rand() * 1.2 - 0.2, rand() * 2 - 1]);
      for (const turns of SKY_WAVE_TURNS) {
        const sum = skyWavePhase(d, skyWavePolesFor(turns));
        product = Math.max(product, loopGap(skyWaveProductPhase(d, turns), sum));
        shader = Math.max(shader, loopGap(glslPhase(d, turns), sum));
      }
    }
    expect(product).toBeLessThan(1e-9);
    // The defines carry 9 significant digits, far finer than the GPU's float.
    expect(shader).toBeLessThan(1e-6);
  });
});
