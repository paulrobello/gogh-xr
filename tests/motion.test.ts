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
  type MotionFunctions,
  motionGate,
  motionLayerMask,
  motionOffset,
  STUB_MOTION,
} from '../src/motion/motion.ts';
import { STROKE_LAYER, type StrokeLayer } from '../src/render/strokes/instance.ts';
import {
  createStrokeMaterial,
  MOTION_INCLUDE,
  spliceGlsl,
} from '../src/render/strokes/material.ts';

const ALL_LAYERS = Object.values(STROKE_LAYER) as StrokeLayer[];
const ALL_MASK = motionLayerMask(ALL_LAYERS);
const motionGlsl = readFileSync('src/motion/motion.glsl', 'utf8');
const strokeGlsl = readFileSync('src/render/strokes/stroke.vert.glsl', 'utf8');

describe('motion clock', () => {
  test('defaults: calm 1, not frozen, time 0, gate the live layers', () => {
    const clock = createMotionClock({ layerMask: ALL_MASK });
    expect(clock.diag()).toEqual({ time: 0, calm: 1, frozen: false });
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

  test('P4.1 ships no live motion: the default gate is closed for every layer', () => {
    expect(MOTION_LAYERS).toEqual([]);
    expect(MOTION_LAYER_MASK).toBe(0);
    for (const layer of ALL_LAYERS) expect(motionGate(MOTION_LAYER_MASK, layer)).toBe(false);
    expect(motionClock.uniforms.uMotionLayers.value).toBe(0);
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
    expect(material.vertexShader.indexOf('vec3 motionOffset(')).toBeLessThan(
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

  test('the vertex shader gates motion once, after the rest quad, with the rest position', () => {
    const gate = strokeGlsl.indexOf('if (motionGate(iMeta.y)) {');
    expect(gate).toBeGreaterThan(strokeGlsl.indexOf('vec3 local = iPosition'));
    expect(gate).toBeLessThan(strokeGlsl.indexOf('gl_Position = projectionMatrix'));
    expect(strokeGlsl).toContain('local += motionOffset(iMeta.y, iPosition, iMeta.z);');
    expect(strokeGlsl.match(/motionOffset\(/g)).toHaveLength(1);
    // Nothing else in main reads the motion uniforms: the closed gate is the whole default path.
    const main = strokeGlsl.slice(strokeGlsl.indexOf('void main()'));
    expect(main).not.toMatch(/uTime|uCalm|uMotionLayers/);
  });

  test('motion.glsl multiplies by uCalm once, after every layer and the reactive term', () => {
    const body = motionGlsl.slice(motionGlsl.indexOf('vec3 motionOffset('));
    for (const layer of ['SKY', 'STAR', 'MOON', 'CYPRESS']) {
      expect(body).toContain(`layer == STROKE_LAYER_${layer}`);
    }
    expect(body.match(/uCalm/g)).toHaveLength(1);
    expect(body.indexOf('return uCalm * offset;')).toBeGreaterThan(
      body.indexOf('offset += reactiveMotion('),
    );
    expect(motionGlsl).toContain('return (uMotionLayers & (1u << layer)) != 0u;');
  });
});

describe('calm scaling', () => {
  const unit =
    (axis: 0 | 1 | 2): LayerMotion =>
    ({ phase, time }) => {
      const v: [number, number, number] = [0, 0, 0];
      v[axis] = 1 + phase + time;
      return v;
    };
  const live: MotionFunctions = {
    sky: unit(0),
    star: unit(1),
    moon: unit(2),
    cypress: unit(0),
    reactive: () => [0, 0, 0.5],
  };
  const p = [1, 2, 3] as const;

  test('reaches every layer: the offset is linear in calm and 0 at calm 0', () => {
    for (const layer of ALL_LAYERS) {
      const full = motionOffset(layer, 64, p, { time: 2, calm: 1, layerMask: ALL_MASK }, live);
      expect(Math.hypot(...full)).toBeGreaterThan(0);
      for (const calm of [0, 0.25, 0.5]) {
        const scaled = motionOffset(layer, 64, p, { time: 2, calm, layerMask: ALL_MASK }, live);
        for (let k = 0; k < 3; k++) expect(scaled[k]).toBeCloseTo(calm * full[k], 12);
      }
    }
  });

  test('a closed gate bit leaves the stroke at rest whatever the motion', () => {
    for (const layer of ALL_LAYERS) {
      const mask = ALL_MASK & ~(1 << layer);
      expect(motionOffset(layer, 64, p, { time: 2, calm: 1, layerMask: mask }, live)).toEqual([
        0, 0, 0,
      ]);
      expect(motionOffset(layer, 64, p, { time: 2, calm: 1, layerMask: 0 }, live)).toEqual([
        0, 0, 0,
      ]);
    }
  });

  test('the layer motion sees the phase byte as a fraction and uTime', () => {
    const seen: number[] = [];
    const spy: MotionFunctions = {
      ...STUB_MOTION,
      sky: ({ phase, time }) => {
        seen.push(phase, time);
        return [0, 0, 0];
      },
    };
    motionOffset(STROKE_LAYER.sky, 128, p, { time: 7, calm: 1, layerMask: ALL_MASK }, spy);
    expect(seen).toEqual([0.5, 7]);
  });

  test('the P4.1 stubs displace nothing on any layer', () => {
    for (const layer of ALL_LAYERS) {
      expect(motionOffset(layer, 200, p, { time: 3, calm: 1, layerMask: ALL_MASK })).toEqual([
        0, 0, 0,
      ]);
    }
  });
});
