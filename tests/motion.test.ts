import { readFileSync } from 'node:fs';
import { Texture } from 'three';
import { describe, expect, test } from 'vitest';
import {
  clampCalm,
  createMotionClock,
  MAX_MOTION_DT_S,
  MOTION_TIME_WRAP_S,
  motionClock,
} from '../src/motion/clock.ts';
import {
  type LayerMotion,
  MOTION_LAYER_MASK,
  MOTION_LAYERS,
  type Motion,
  type MotionFunctions,
  motionGate,
  motionLayerMask,
  motionOffset,
  REACTIVE_MOTION_BIT,
  REST,
  reactiveGate,
  STUB_MOTION,
} from '../src/motion/motion.ts';
import { STROKE_LAYER, type StrokeLayer } from '../src/render/strokes/instance.ts';
import {
  createStrokeMaterial,
  MOTION_INCLUDE,
  pinMotionPhase,
  spliceGlsl,
} from '../src/render/strokes/material.ts';

const ALL_LAYERS = Object.values(STROKE_LAYER) as StrokeLayer[];
const ALL_MASK = motionLayerMask(ALL_LAYERS);
const motionGlsl = readFileSync('src/motion/motion.glsl', 'utf8');
const strokeGlsl = readFileSync('src/render/strokes/stroke.vert.glsl', 'utf8');

describe('motion clock', () => {
  test('defaults: calm 1, not frozen, time 0, gate the live layers', () => {
    const clock = createMotionClock({ layerMask: ALL_MASK });
    expect(clock.diag()).toEqual({ time: 0, calm: 1, frozen: false, layers: ALL_MASK });
    expect(clock.uniforms.uTime.value).toBe(0);
    expect(clock.uniforms.uCalm.value).toBe(1);
    expect(clock.uniforms.uFreeze.value).toBe(0);
    expect(clock.uniforms.uMotionLayers.value).toBe(ALL_MASK);
  });

  test('uTime advances by the frame step in seconds, times calm', () => {
    const clock = createMotionClock();
    clock.frame(1000);
    expect(clock.uniforms.uTime.value).toBe(0);
    clock.frame(1050);
    expect(clock.uniforms.uTime.value).toBeCloseTo(0.05, 12);
    clock.setCalm(0.5);
    clock.frame(1100);
    expect(clock.uniforms.uTime.value).toBeCloseTo(0.075, 12);
    expect(clock.diag().time).toBe(clock.uniforms.uTime.value);
  });

  test('a calm change never jumps the time: speed scales on the CPU', () => {
    const clock = createMotionClock();
    for (let i = 0; i < 100; i++) clock.frame(i * 16);
    const before = clock.uniforms.uTime.value;
    clock.setCalm(0.2);
    expect(clock.uniforms.uTime.value).toBe(before);
  });

  test('frozen holds the time and clears the gate; thawing resumes without a jump', () => {
    const clock = createMotionClock({ frozen: true, layerMask: ALL_MASK });
    expect(clock.uniforms.uFreeze.value).toBe(1);
    expect(clock.uniforms.uMotionLayers.value).toBe(0);
    clock.frame(0);
    clock.frame(500);
    clock.frame(1000);
    expect(clock.uniforms.uTime.value).toBe(0);
    clock.setFrozen(false);
    expect(clock.uniforms.uFreeze.value).toBe(0);
    expect(clock.uniforms.uMotionLayers.value).toBe(ALL_MASK);
    clock.frame(1016);
    expect(clock.uniforms.uTime.value).toBeCloseTo(0.016, 12);
  });

  test('calm 0 holds the time and clears the gate', () => {
    const clock = createMotionClock({ calm: 0, layerMask: ALL_MASK });
    clock.frame(0);
    clock.frame(50);
    expect(clock.uniforms.uTime.value).toBe(0);
    expect(clock.uniforms.uMotionLayers.value).toBe(0);
    clock.setCalm(0.01);
    expect(clock.uniforms.uMotionLayers.value).toBe(ALL_MASK);
  });

  test('a long stall advances at most MAX_MOTION_DT_S, and time never runs backwards', () => {
    const clock = createMotionClock();
    clock.frame(0);
    clock.frame(60_000);
    expect(clock.uniforms.uTime.value).toBeCloseTo(MAX_MOTION_DT_S, 12);
    clock.frame(10);
    expect(clock.uniforms.uTime.value).toBeCloseTo(MAX_MOTION_DT_S, 12);
  });

  test('uTime wraps at MOTION_TIME_WRAP_S', () => {
    const clock = createMotionClock();
    clock.uniforms.uTime.value = MOTION_TIME_WRAP_S - 0.01;
    clock.frame(0);
    clock.frame(50);
    expect(clock.uniforms.uTime.value).toBeCloseTo(0.04, 9);
  });

  test('calm is clamped to 0-1, and a non-finite calm means 1', () => {
    expect(clampCalm(-1)).toBe(0);
    expect(clampCalm(2)).toBe(1);
    expect(clampCalm(0.3)).toBe(0.3);
    expect(clampCalm(Number.NaN)).toBe(1);
    const clock = createMotionClock({ calm: 5 });
    expect(clock.uniforms.uCalm.value).toBe(1);
  });

  test('P4.4 opens the sky, stars, moon and cypress; the app clock starts closed until a world opens it', () => {
    const live: number[] = [
      STROKE_LAYER.sky,
      STROKE_LAYER.star,
      STROKE_LAYER.moon,
      STROKE_LAYER.cypress,
    ];
    expect(MOTION_LAYERS).toEqual(live);
    // P4.5 adds the reactive bit, above the six layer bits, which opens no layer's own motion.
    expect(REACTIVE_MOTION_BIT).toBe(1 << 6);
    expect(MOTION_LAYER_MASK).toBe(
      (1 << STROKE_LAYER.sky) |
        (1 << STROKE_LAYER.star) |
        (1 << STROKE_LAYER.moon) |
        (1 << STROKE_LAYER.cypress) |
        REACTIVE_MOTION_BIT,
    );
    for (const layer of ALL_LAYERS) {
      expect(motionGate(MOTION_LAYER_MASK, layer)).toBe(live.includes(layer));
      expect(motionGate(REACTIVE_MOTION_BIT, layer)).toBe(false);
    }
    expect(reactiveGate(MOTION_LAYER_MASK)).toBe(true);
    expect(reactiveGate(ALL_MASK)).toBe(false);
    expect(motionClock.uniforms.uMotionLayers.value).toBe(0);
    expect(motionClock.diag().layers).toBe(0);
  });

  test('setLayerMask opens and closes layers, and frozen or calm 0 still close them all', () => {
    const clock = createMotionClock({ layerMask: 0 });
    expect(clock.uniforms.uMotionLayers.value).toBe(0);
    clock.setLayerMask(MOTION_LAYER_MASK);
    expect(clock.uniforms.uMotionLayers.value).toBe(MOTION_LAYER_MASK);
    expect(clock.diag().layers).toBe(MOTION_LAYER_MASK);
    clock.setFrozen(true);
    expect(clock.uniforms.uMotionLayers.value).toBe(0);
    clock.setFrozen(false);
    clock.setCalm(0);
    expect(clock.uniforms.uMotionLayers.value).toBe(0);
    clock.setCalm(1);
    clock.setLayerMask(0);
    expect(clock.uniforms.uMotionLayers.value).toBe(0);
  });
});

describe('uniform plumbing', () => {
  test('every stroke material shares the clock uniform objects by reference', () => {
    const a = createStrokeMaterial(new Texture());
    const b = createStrokeMaterial(new Texture(), 2);
    for (const key of ['uTime', 'uCalm', 'uFreeze', 'uMotionLayers'] as const) {
      expect(a.uniforms[key]).toBe(motionClock.uniforms[key]);
      expect(b.uniforms[key]).toBe(motionClock.uniforms[key]);
    }
    const before = motionClock.uniforms.uTime.value;
    motionClock.uniforms.uTime.value = 12.5;
    expect(a.uniforms.uTime.value).toBe(12.5);
    expect(b.uniforms.uTime.value).toBe(12.5);
    motionClock.uniforms.uTime.value = before;
  });

  test('motion.glsl is spliced into the vertex shader in place of its marker', () => {
    const material = createStrokeMaterial(new Texture());
    expect(material.vertexShader).not.toContain(MOTION_INCLUDE);
    expect(material.vertexShader).toContain(motionGlsl.trimEnd());
    expect(material.vertexShader.indexOf('Motion motionOffset(')).toBeLessThan(
      material.vertexShader.indexOf('void main()'),
    );
    for (const name of ['STROKE_LAYER_SKY', 'STROKE_LAYER_STAR', 'STROKE_LAYER_MOON']) {
      expect(material.defines[name]).toBeDefined();
    }
    expect(material.defines.STROKE_LAYER_CYPRESS).toBe(`${STROKE_LAYER.cypress}u`);
  });

  test('spliceGlsl needs exactly one marker line', () => {
    expect(spliceGlsl('a\n// #m x\nb', '// #m', 'C\n')).toBe('a\nC\nb');
    expect(() => spliceGlsl('a\nb', '// #m', 'C')).toThrow(/found 0/);
    expect(() => spliceGlsl('// #m\n// #m', '// #m', 'C')).toThrow(/found 2/);
  });

  test('the vertex shader gates motion once, after the rest quad and the haze thin', () => {
    // The two gates are read once each, before the haze thin, and only these two read the
    // uniforms: the layer's own bit and the reactive bit with the box (P4.5).
    const gates = strokeGlsl.indexOf('bool layerMoves = motionGate(iMeta.y);');
    expect(gates).toBeGreaterThan(0);
    expect(strokeGlsl.indexOf('bool reacts = reactiveGate(iPosition);')).toBeGreaterThan(gates);
    expect(strokeGlsl.match(/motionGate\(/g)).toHaveLength(1);
    expect(strokeGlsl.match(/reactiveGate\(/g)).toHaveLength(1);
    const gate = strokeGlsl.indexOf('if ((layerMoves || reacts) && thin > 0.0) {');
    expect(gate).toBeGreaterThan(strokeGlsl.indexOf('vec3 local = iPosition'));
    expect(gate).toBeGreaterThan(strokeGlsl.indexOf('thin = skyLightThin('));
    expect(gate).toBeLessThan(strokeGlsl.indexOf('gl_Position = projectionMatrix'));
    expect(strokeGlsl).toContain(
      'Motion m = motionOffset(iMeta.y, iPosition, n, iMeta.z, iColor.a, layerMoves, reacts);',
    );
    expect(strokeGlsl.match(/motionOffset\(/g)).toHaveLength(1);
    // The haze thin widens by each reach only behind its own gate (R-P4b).
    expect(strokeGlsl).toContain(
      'float reach = (layerMoves ? motionReach(iMeta.y, iPosition) : 0.0) +\n      (reacts ? reactiveReach() : 0.0);',
    );
    // Nothing else in main reads the motion uniforms: the closed gate is the whole default path.
    const main = strokeGlsl.slice(strokeGlsl.indexOf('void main()'));
    expect(main).not.toMatch(/uTime|uCalm|uMotionLayers/);
  });

  test('motion.glsl scales the offset and turn by uCalm once, after every layer and reactive', () => {
    const start = motionGlsl.indexOf('Motion motionOffset(');
    const body = motionGlsl.slice(start, motionGlsl.indexOf('float motionReach('));
    for (const layer of ['SKY', 'STAR', 'MOON', 'CYPRESS']) {
      expect(body).toContain(`layer == STROKE_LAYER_${layer}`);
    }
    expect(body.match(/uCalm/g)).toHaveLength(1);
    expect(body.indexOf('return scaleMotion(m, uCalm);')).toBeGreaterThan(
      body.indexOf('Motion r = reactiveMotion('),
    );
    // Each motion runs behind its own gate (P4.5): the layer dispatch behind layerMoves, the
    // reactive term behind reacts. The gains combine as size factors, so the wrap envelope still
    // scales a stroke the reactive stretch grows.
    expect(body).toContain('if (!layerMoves) {\n  } else if (layer == STROKE_LAYER_SKY) {');
    expect(body).toContain('if (reacts) {\n    Motion r = reactiveMotion(p, n);');
    expect(body).toContain('m.bright += r.bright;');
    expect(body).toContain('m.gain = (1.0 + m.gain) * (1.0 + r.gain) - 1.0;');
    expect(body.match(/m\.gain/g)).toHaveLength(2);
    // The gain is the wrap envelope: full depth whenever the gate is open (amended R-P4e). The
    // brightness is an amplitude, so it fades with calm like the offset and turn (P4.3).
    expect(motionGlsl).toContain('return Motion(k * m.offset, k * m.turn, m.gain, k * m.bright);');
    expect(motionGlsl).toContain('return (uMotionLayers & (1u << layer)) != 0u;');
  });

  test('pinMotionPhase defines MOTION_PHASE_PIN for later materials only (e2e, R-P4g)', () => {
    expect(createStrokeMaterial(new Texture()).defines.MOTION_PHASE_PIN).toBeUndefined();
    pinMotionPhase(0.25);
    try {
      expect(createStrokeMaterial(new Texture()).defines.MOTION_PHASE_PIN).toBe('2.50000000e-1');
    } finally {
      pinMotionPhase(null);
    }
    expect(createStrokeMaterial(new Texture()).defines.MOTION_PHASE_PIN).toBeUndefined();
    expect(motionGlsl).toContain('#ifdef MOTION_PHASE_PIN\n  float phase = MOTION_PHASE_PIN;');
  });
});

describe('calm scaling', () => {
  const unit =
    (axis: 0 | 1 | 2): LayerMotion =>
    ({ phase, time }) => {
      const v: [number, number, number] = [0, 0, 0];
      v[axis] = 1 + phase + time;
      return { offset: v, turn: 0.1 + phase, gain: -0.25, bright: 0.2 + phase };
    };
  const live: MotionFunctions = {
    sky: unit(0),
    star: unit(1),
    moon: unit(2),
    cypress: unit(0),
    // A reactive gain is a stretch growth, never negative (reactive.ts).
    reactive: () => ({ offset: [0, 0, 0.5], turn: 0.05, gain: 0.1, bright: 0.05 }),
  };
  const p = [1, 2, 3] as const;
  const n = [0, 0, 1] as const;
  const flat = (m: Motion): number[] => [...m.offset, m.turn, m.gain, m.bright];
  /** Indices into `flat` of the fields calm scales: the offset, the turn and the brightness. */
  const SCALED = [0, 1, 2, 3, 5];

  test('reaches every layer and every field: offset, turn and brightness are linear in calm, the gain is not', () => {
    // Every layer's bit and the reactive bit, so the ground and building get the reactive term.
    const ALL_WITH_REACTIVE = motionLayerMask(ALL_LAYERS) | REACTIVE_MOTION_BIT;
    for (const layer of ALL_LAYERS) {
      const full = motionOffset(
        layer,
        64,
        p,
        n,
        { time: 2, calm: 1, layerMask: ALL_WITH_REACTIVE },
        live,
      );
      expect(Math.hypot(...full.offset)).toBeGreaterThan(0);
      expect(full.turn).not.toBe(0);
      expect(full.gain).not.toBe(0);
      expect(full.bright).not.toBe(0);
      for (const calm of [0, 0.25, 0.5]) {
        const scaled = motionOffset(
          layer,
          64,
          p,
          n,
          { time: 2, calm, layerMask: ALL_WITH_REACTIVE },
          live,
        );
        for (const k of SCALED) expect(flat(scaled)[k]).toBeCloseTo(calm * flat(full)[k], 12);
        // At calm 0 the clock closes the gate, so the unscaled gain never draws there.
        expect(scaled.gain).toBeCloseTo(full.gain, 12);
      }
    }
  });

  test('the sky shrinks to nothing at its wrap for every calm the gate is open at (I1)', () => {
    const position = [0, 60, -100] as const;
    const normal = [0, -0.5, 0.86] as const;
    for (const calm of [1e-3, 0.1, 0.25, 0.5, 0.75, 1]) {
      const uniforms = { time: 0, calm, layerMask: MOTION_LAYER_MASK };
      // Phase byte 0 at time 0 is the wrap itself: f = 0.
      const at = motionOffset(STROKE_LAYER.sky, 0, position, normal, uniforms);
      expect(1 + at.gain).toBe(0);
      // Just before it: f = 1 - 1e-6.
      const before = motionOffset(STROKE_LAYER.sky, 0, position, normal, {
        ...uniforms,
        time: 8 * (1 - 1e-6),
      });
      expect(1 + before.gain).toBeCloseTo(0, 6);
    }
  });

  test('a closed gate bit leaves the stroke at rest whatever the motion', () => {
    for (const layer of ALL_LAYERS) {
      const mask = ALL_MASK & ~(1 << layer);
      expect(motionOffset(layer, 64, p, n, { time: 2, calm: 1, layerMask: mask }, live)).toBe(REST);
      expect(motionOffset(layer, 64, p, n, { time: 2, calm: 1, layerMask: 0 }, live)).toBe(REST);
    }
  });

  test('the layer motion sees the phase byte as a fraction, the normal and uTime', () => {
    const seen: unknown[] = [];
    const spy: MotionFunctions = {
      ...STUB_MOTION,
      sky: ({ phase, time, normal }) => {
        seen.push(phase, time, normal);
        return REST;
      },
    };
    motionOffset(STROKE_LAYER.sky, 128, p, n, { time: 7, calm: 1, layerMask: ALL_MASK }, spy);
    expect(seen).toEqual([0.5, 7, n]);
  });

  test('the ground and buildings are still in P4.4, and so is a cypress stroke with no flame byte', () => {
    for (const layer of [STROKE_LAYER.cypress, STROKE_LAYER.ground, STROKE_LAYER.building]) {
      const m = motionOffset(layer, 200, p, n, { time: 3, calm: 1, layerMask: ALL_MASK });
      expect(flat(m)).toEqual([0, 0, 0, 0, 0, 0]);
    }
    const flame = motionOffset(
      STROKE_LAYER.cypress,
      200,
      p,
      [1, 0, 0],
      { time: 3, calm: 1, layerMask: ALL_MASK },
      undefined,
      (2 << 5) | 15,
    );
    expect(Math.hypot(...flame.offset)).toBeGreaterThan(0);
    const sky = motionOffset(STROKE_LAYER.sky, 200, [0, 60, -100], [0, -0.5, 0.86], {
      time: 3,
      calm: 1,
      layerMask: ALL_MASK,
    });
    expect(Math.hypot(...sky.offset)).toBeGreaterThan(0);
  });
});
