import { Texture } from 'three';
import { describe, expect, test } from 'vitest';
import { MOTION_TIME_WRAP_S } from '../src/motion/clock.ts';
import motionGlsl from '../src/motion/motion.glsl?raw';
import {
  SKY_SWIRL_FADE,
  SKY_SWIRL_PERIOD,
  skySwirl,
  skyWrapLoop,
} from '../src/motion/sky-swirl.ts';
import { createMotionVariants } from '../src/motion/variant-uniforms.ts';
import {
  CYPRESS_WIND,
  motionVariantGlslDefines,
  SKY_BASE_SIZE,
  SKY_WRAP_HALF_FLOOR,
  SKY_WRAP_HALF_PERIOD,
  SKY_WRAPS,
  skyBaseMap,
  skyBaseUv,
} from '../src/motion/variants.ts';
import { PAINTER_EYE } from '../src/paintings/starry-night/canvas-camera.ts';
import { STROKE_LAYER } from '../src/render/strokes/instance.ts';
import { createStrokeMaterial } from '../src/render/strokes/material.ts';
import { createCypress } from '../src/world/cypress.ts';
import { createTerrain } from '../src/world/terrain.ts';

/** Share of a uniform phase sweep at which the stroke draws below `limit` of its rest size. */
function smallShare(wrap: (typeof SKY_WRAPS)[number], limit: number, time: number): number {
  const n = 256;
  let small = 0;
  for (let i = 0; i < n; i++) if (1 + skyWrapLoop(wrap, i / n, time).gain < limit) small++;
  return small / n;
}

describe('sky wrap variants', () => {
  test('base is the P4.2 loop exactly', () => {
    for (const phase of [0, 0.01, 0.03, 0.5, 0.97, 0.999]) {
      for (const time of [0, 0.5, 3.7, 7.99]) {
        const f = (((time / SKY_SWIRL_PERIOD + phase) % 1) + 1) % 1;
        const loop = skyWrapLoop('base', phase, time);
        expect(loop.tau).toBeCloseTo((f - 0.5) * SKY_SWIRL_PERIOD, 12);
        expect(loop.fade).toBe(0);
      }
    }
    const p: [number, number, number] = [-30, 50, -60];
    expect(skySwirl(p, [0, -1, 0], 0.2, 3.7)).toEqual(
      skySwirl(p, [0, -1, 0], 0.2, 3.7, undefined, 'base'),
    );
  });

  test('fade never shrinks and is all base colour at the jump; half never shrinks below its floor', () => {
    for (let i = 0; i <= 1000; i++) {
      const phase = i / 1000;
      const fade = skyWrapLoop('fade', phase, 0);
      expect(fade.gain).toBe(0);
      expect(fade.fade).toBeGreaterThanOrEqual(0);
      expect(fade.fade).toBeLessThanOrEqual(1);
      const half = skyWrapLoop('half', phase, 0);
      expect(1 + half.gain).toBeGreaterThanOrEqual(SKY_WRAP_HALF_FLOOR - 1e-12);
      expect(half.fade).toBe(0);
      // Every variant sweeps base's arc, so the reach bounds hold.
      for (const wrap of SKY_WRAPS) {
        expect(Math.abs(skyWrapLoop(wrap, phase, 0).tau)).toBeLessThanOrEqual(
          0.5 * SKY_SWIRL_PERIOD,
        );
      }
    }
    expect(skyWrapLoop('fade', 0, 0).fade).toBe(1);
    expect(skyWrapLoop('fade', 0.5, 0).fade).toBe(0);
    expect(1 + skyWrapLoop('half', 0, 0).gain).toBeCloseTo(SKY_WRAP_HALF_FLOOR, 12);
    expect(MOTION_TIME_WRAP_S % SKY_WRAP_HALF_PERIOD).toBe(0);
    expect(SKY_WRAP_HALF_PERIOD / SKY_SWIRL_PERIOD).toBe(1.5);
  });

  test('the size modulation: the share of strokes below 0.8 of their rest size', () => {
    // smoothstep(x) = 0.8 at x ≈ 0.7136, and 1 − 0.5 (1 − smoothstep) = 0.8 at smoothstep 0.6.
    const base = smallShare('base', 0.8, 3.7);
    const half = smallShare('half', 0.8, 3.7);
    expect(base).toBeGreaterThan(0.07);
    expect(base).toBeLessThan(0.1);
    expect(half).toBeGreaterThan(0.05);
    expect(half).toBeLessThan(base);
    expect(smallShare('fade', 0.8, 3.7)).toBe(0);
    expect(SKY_SWIRL_FADE).toBe(0.06);
  });
});

describe('the fade wrap sky base map', () => {
  test('skyBaseUv folds every direction into the unit square, +Y at the centre', () => {
    expect(skyBaseUv(0, 1, 0)).toEqual([0.5, 0.5]);
    for (const [x, y, z] of [
      [1, 0, 0],
      [0, -1, 0],
      [0.3, -0.8, -0.5],
      [-0.6, 0.2, 0.7],
    ]) {
      const [u, v] = skyBaseUv(x, y, z);
      for (const c of [u, v]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
    expect(skyBaseUv(0, -1, 0).map((c) => Math.abs(c - 0.5))).toEqual([0.5, 0.5]);
  });

  test('a single colour maps to that colour everywhere, and other layers are ignored', () => {
    const count = 400;
    const position = new Float32Array(count * 3);
    const color = new Uint8Array(count * 4);
    const meta = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * 2 * Math.PI;
      position.set(
        [PAINTER_EYE[0] + 100 * Math.cos(a), PAINTER_EYE[1] + 30, 100 * Math.sin(a)],
        i * 3,
      );
      const sky = i % 2 === 0;
      color.set(sky ? [40, 80, 160, 255] : [255, 255, 0, 255], i * 4);
      meta[i * 4 + 1] = sky ? 1 : 2;
    }
    const map = skyBaseMap([{ count, position, color, meta }], 1, PAINTER_EYE, 16);
    expect(map.length).toBe(16 * 16 * 4);
    for (let t = 0; t < map.length; t += 4) {
      expect([map[t], map[t + 1], map[t + 2], map[t + 3]]).toEqual([40, 80, 160, 255]);
    }
    expect(SKY_BASE_SIZE).toBe(64);
  });

  test('a scene with no world (the canvas demo) builds the map from its batch, and the first batch wins', () => {
    // ?demo=canvas: sky strokes on a 4 × 3.17 m plane 2.55 m ahead of the eye, as placement.ts lays them.
    const plane = (rgb: [number, number, number]) => {
      const count = 900;
      const position = new Float32Array(count * 3);
      const color = new Uint8Array(count * 4);
      const meta = new Uint8Array(count * 4);
      for (let i = 0; i < count; i++) {
        const u = (i % 30) / 29;
        const v = Math.floor(i / 30) / 29;
        position.set([-2 + 4 * u, 1.6 - 1.585 + 3.17 * v, -2.55], i * 3);
        color.set([...rgb, 255], i * 4);
        meta[i * 4 + 1] = STROKE_LAYER.sky;
      }
      return [{ count, position, color, meta }];
    };
    const variants = createMotionVariants();
    const empty = variants.uniforms.uSkyBase.value;
    expect(variants.buildSkyBase(plane([200, 120, 40]), STROKE_LAYER.sky, PAINTER_EYE)).toBe(true);
    expect(variants.diag().skyBase).toBe(true);
    expect(variants.uniforms.uSkyBase.value).not.toBe(empty);
    const texels = (): Uint8Array =>
      (variants.uniforms.uSkyBase.value.image as { data: Uint8Array }).data;
    // Straight ahead (-Z) is the plane's colour, and every texel holds a colour, none the empty black.
    const [u, v] = skyBaseUv(0, 0, -1);
    const t = (Math.floor(v * SKY_BASE_SIZE) * SKY_BASE_SIZE + Math.floor(u * SKY_BASE_SIZE)) * 4;
    expect([...texels().subarray(t, t + 3)]).toEqual([200, 120, 40]);
    for (let i = 0; i < texels().length; i += 4) {
      expect(texels()[i] + texels()[i + 1] + texels()[i + 2]).toBeGreaterThan(0);
    }
    // A later batch (a second stroke scene) does not replace the first one's map.
    expect(variants.buildSkyBase(plane([10, 20, 30]), STROKE_LAYER.sky, PAINTER_EYE)).toBe(false);
    expect([...texels().subarray(t, t + 3)]).toEqual([200, 120, 40]);
  });

  test('the variant uniforms switch live and upload the base map', () => {
    const variants = createMotionVariants();
    expect(variants.diag()).toEqual({ wrap: 'base', flame: 'base', skyBase: false });
    variants.setWrap('half');
    variants.setFlame('wind');
    expect(variants.uniforms.uSkyWrap.value).toBe(2);
    expect(variants.uniforms.uCypressSway.value).toBe(1);
    variants.setSkyBase(new Uint8Array(4 * 4 * 4), 4);
    expect(variants.diag()).toEqual({ wrap: 'half', flame: 'wind', skyBase: true });
    variants.setWrap('base');
    expect(variants.uniforms.uSkyWrap.value).toBe(0);
  });
});

describe('wind direction', () => {
  test('CYPRESS_WIND is a horizontal unit vector across the painter view of the main cypress', () => {
    const [wx, wy, wz] = CYPRESS_WIND;
    expect(Math.hypot(wx, wy, wz)).toBeCloseTo(1, 4);
    expect(wy).toBe(0);
    const { main } = createCypress(1, createTerrain(1));
    const mid = main.axis[Math.floor(main.axis.length / 2)];
    const dx = mid[0] - PAINTER_EYE[0];
    const dz = mid[2] - PAINTER_EYE[2];
    const length = Math.hypot(dx, dz);
    expect(Math.abs((wx * dx + wz * dz) / length)).toBeLessThan(0.01);
  });
});

describe('GLSL', () => {
  test('each variant uniform is read once, inside its own layer motion, behind a compare with 0', () => {
    const sky = motionGlsl.slice(
      motionGlsl.indexOf('Motion skyMotion('),
      motionGlsl.indexOf('Motion ringMotion('),
    );
    expect(sky).toContain('if (uSkyWrap != 0u) return skyWrapMotion(');
    const cypress = motionGlsl.slice(
      motionGlsl.indexOf('Motion cypressMotion('),
      motionGlsl.indexOf('Motion reactiveMotion('),
    );
    expect(cypress).toContain('if (uCypressSway != 0u) {');
    expect(motionGlsl.match(/uCypressSway/g)).toHaveLength(2);
    // The declaration, skyWrapMotion's slow test and skyMotion's compare.
    expect(motionGlsl.match(/uSkyWrap/g)).toHaveLength(3);
    // The base map is sampled only inside the fade's wrap window.
    expect(motionGlsl.match(/textureLod\(uSkyBase/g)).toHaveLength(1);
  });

  test('the stroke material shares the variant uniforms and carries their defines', () => {
    const a = createStrokeMaterial(new Texture());
    const b = createStrokeMaterial(new Texture());
    expect(a.uniforms.uSkyWrap).toBe(b.uniforms.uSkyWrap);
    expect(a.uniforms.uCypressSway).toBe(b.uniforms.uCypressSway);
    expect(a.uniforms.uSkyBase).toBe(b.uniforms.uSkyBase);
    for (const [key, value] of Object.entries(motionVariantGlslDefines())) {
      expect(a.defines[key]).toBe(value);
    }
  });
});
