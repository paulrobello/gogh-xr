import { Texture } from 'three';
import { describe, expect, test } from 'vitest';
import motionGlsl from '../src/motion/motion.glsl?raw';
import {
  SKY_SWIRL_FADE,
  SKY_SWIRL_PERIOD,
  skySwirl,
  skySwirlReach,
  skyWrapLoop,
} from '../src/motion/sky-swirl.ts';
import { createMotionVariants } from '../src/motion/variant-uniforms.ts';
import { motionVariantGlslDefines, SKY_WRAPS, type SkyWrap } from '../src/motion/variants.ts';
import { createStrokeMaterial } from '../src/render/strokes/material.ts';
import strokeFrag from '../src/render/strokes/stroke.frag.glsl?raw';
import strokeVert from '../src/render/strokes/stroke.vert.glsl?raw';

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

describe('sky wrap variants', () => {
  test('the variants are base, opacity and pingpong, base first', () => {
    expect(SKY_WRAPS).toEqual(['base', 'opacity', 'pingpong']);
  });

  test('base is the P4.2 loop exactly', () => {
    for (const phase of [0, 0.01, 0.03, 0.5, 0.97, 0.999]) {
      for (const time of [0, 0.5, 3.7, 7.99]) {
        const f = fract(time / SKY_SWIRL_PERIOD + phase);
        const loop = skyWrapLoop('base', phase, time);
        expect(loop.tau).toBeCloseTo((f - 0.5) * SKY_SWIRL_PERIOD, 12);
        expect(loop.alpha).toBe(1);
        expect(loop.returning).toBe(false);
      }
    }
    expect(skyWrapLoop('base', 0, 0).gain).toBe(-1);
    expect(skySwirl(DOME, [0, -1, 0], 0.2, 3.7)).toEqual(
      skySwirl(DOME, [0, -1, 0], 0.2, 3.7, undefined, 'base'),
    );
  });

  test('opacity: no stroke changes size, the alpha is 1 outside the wrap window and 0 at the jump', () => {
    for (let i = 0; i <= 4000; i++) {
      const phase = i / 4000;
      const loop = skyWrapLoop('opacity', phase, 0);
      const f = fract(phase);
      expect(loop.gain).toBe(0);
      // It sweeps base's arc.
      expect(loop.tau).toBe(skyWrapLoop('base', phase, 0).tau);
      expect(loop.alpha).toBeGreaterThanOrEqual(0);
      expect(loop.alpha).toBeLessThanOrEqual(1);
      if (Math.min(f, 1 - f) >= SKY_SWIRL_FADE) expect(loop.alpha).toBe(1);
      else expect(loop.alpha).toBeLessThan(1);
    }
    expect(skyWrapLoop('opacity', 0, 0).alpha).toBe(0);
    // A 90 Hz frame either side of the jump, the alpha is far below one 4x MSAA coverage step.
    expect(skyWrapLoop('opacity', 0, SKY_SWIRL_PERIOD - 1 / 90).alpha).toBeLessThan(0.002);
    expect(skyWrapLoop('opacity', 0, 1 / 90).alpha).toBeLessThan(0.002);
    // The same fade window as base's shrink: alpha is base's size factor.
    for (const phase of [0.005, 0.02, 0.04, 0.96, 0.99]) {
      expect(skyWrapLoop('opacity', phase, 0).alpha).toBeCloseTo(
        1 + skyWrapLoop('base', phase, 0).gain,
        12,
      );
    }
    const m = skySwirl(DOME, [0, -1, 0], 0.97, 0, undefined, 'opacity');
    expect(m.gain).toBe(0);
    expect(m.offset).toEqual(skySwirl(DOME, [0, -1, 0], 0.97, 0).offset);
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
      expect(loop.alpha).toBe(1);
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
    expect(smallShare('opacity', 0.8, 3.7)).toBe(0);
    expect(smallShare('pingpong', 0.8, 3.7)).toBe(0);
    expect(SKY_SWIRL_FADE).toBe(0.06);
  });

  test('the variant uniform switches live', () => {
    const variants = createMotionVariants();
    expect(variants.diag()).toEqual({ wrap: 'base' });
    variants.setWrap('pingpong');
    expect(variants.uniforms.uSkyWrap.value).toBe(2);
    expect(variants.diag()).toEqual({ wrap: 'pingpong' });
    variants.setWrap('opacity');
    expect(variants.uniforms.uSkyWrap.value).toBe(1);
    variants.setWrap('base');
    expect(variants.uniforms.uSkyWrap.value).toBe(0);
    expect(Object.keys(variants.uniforms)).toEqual(['uSkyWrap']);
  });
});

describe('GLSL', () => {
  test('uSkyWrap is read only in the sky motion, behind one compare with 0', () => {
    const sky = motionGlsl.slice(
      motionGlsl.indexOf('Motion skyMotion('),
      motionGlsl.indexOf('Motion ringMotion('),
    );
    expect(sky).toContain('if (uSkyWrap != 0u) return skyWrapMotion(');
    // The declaration, skyWrapMotion's pingpong test and skyMotion's compare.
    expect(motionGlsl.match(/uSkyWrap/g)).toHaveLength(3);
    const wrap = motionGlsl.slice(
      motionGlsl.indexOf('Motion skyWrapMotion('),
      motionGlsl.indexOf('Motion skyMotion('),
    );
    expect(wrap).toContain('uSkyWrap == SKY_WRAP_PINGPONG');
    // The formulas skyWrapLoop mirrors. tests/e2e/ab.spec.ts checks what the GPU draws with them.
    expect(wrap).toContain(
      'tau = (smoothstep(0.0, 1.0, 1.0 - abs(2.0 * f - 1.0)) - 0.5) * SKY_SWIRL_PERIOD;',
    );
    expect(wrap).toContain('alpha = smoothstep(0.0, SKY_SWIRL_FADE, min(f, 1.0 - f));');
    // Neither variant changes the size.
    expect(wrap).toContain('return Motion(tau * cross(omega, d), tau * dot(omega, n), 0.0, 0.0);');
    expect(motionGlsl).not.toMatch(/uCypressSway|uSkyBase|CYPRESS_WIND|textureLod/);
  });

  test('the alpha weight rides in the colour varying, 1 unless the opacity wrap sets it', () => {
    // vColor.a shares the colour's flat interpolator, so the weight adds no vertex output.
    expect(strokeVert).toContain('flat out vec4 vColor;');
    expect(strokeVert).toContain('float alpha = 1.0;');
    expect(strokeVert).toContain('vColor = vec4(color, alpha);');
    expect(strokeFrag).toContain('flat in vec4 vColor;');
    expect(strokeVert).not.toMatch(/vAlpha/);
    expect(strokeFrag).not.toMatch(/vAlpha/);
    // Before the noa2c alpha test, so the cut-out mode fades too, and with no branch.
    const scaled = strokeFrag.indexOf('alpha *= vColor.a;');
    expect(scaled).toBeGreaterThan(0);
    expect(scaled).toBeLessThan(strokeFrag.indexOf('#ifdef ZDIAG_ALPHA_TEST'));
    expect(strokeFrag).toContain('vec4(vColor.rgb * tone * shade, alpha)');
  });

  test('the stroke material shares the variant uniform and carries its defines', () => {
    const a = createStrokeMaterial(new Texture());
    const b = createStrokeMaterial(new Texture());
    expect(a.uniforms.uSkyWrap).toBe(b.uniforms.uSkyWrap);
    expect(a.uniforms.uCypressSway).toBeUndefined();
    expect(a.uniforms.uSkyBase).toBeUndefined();
    for (const [key, value] of Object.entries(motionVariantGlslDefines())) {
      expect(a.defines[key]).toBe(value);
    }
    expect(motionVariantGlslDefines()).toEqual({
      SKY_WRAP_OPACITY: '1u',
      SKY_WRAP_PINGPONG: '2u',
    });
  });
});
