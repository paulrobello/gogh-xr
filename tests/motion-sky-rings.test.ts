import { readFileSync } from 'node:fs';
import { CustomBlending, OneFactor, Texture } from 'three';
import { describe, expect, test } from 'vitest';
import { loadRealSource, loadSkyScan } from '../scripts/scatter-time.ts';
import { motionClock } from '../src/motion/clock.ts';
import { MOTION_LAYER_MASK, motionLayerMask, motionOffset } from '../src/motion/motion.ts';
import {
  moonRing,
  moonShimmer,
  ringBump,
  ringHat,
  ringOf,
  ringWave,
  SKY_HALO_NDC,
  SKY_HALO_SWELL,
  SKY_MOON_RING,
  SKY_MOON_SHIMMER,
  SKY_MOON_SHIMMER_PERIOD,
  SKY_MOON_STILL_PHASE,
  SKY_RING_MOON_PERIOD,
  SKY_RING_REACH,
  SKY_RING_STAR_PERIODS,
  SKY_RINGS,
  SKY_STAR_COUNT,
  skyHaloExtent,
  skyHaloGlow,
  skyHaloState,
  skyRing,
  skyRingGlslDefines,
  skyRingReach,
} from '../src/motion/sky-rings.ts';
import { WORLD_DOME_SIZE } from '../src/paintings/starry-night/world.ts';
import {
  createSkyHalo,
  createSkyHaloMaterial,
  SKY_HALO_CORNER,
  SKY_HALO_SIDES,
  skyHaloRing,
} from '../src/render/sky-halo.ts';
import { backdropNdc, DEPTH_BACKDROP_FLAG } from '../src/render/strokes/backdrop-depth.ts';
import { motionReachesOf, motionReachOf, SKY_REACH_MARGIN } from '../src/render/strokes/batch.ts';
import { createStrokeBuffers, packInstance, STROKE_LAYER } from '../src/render/strokes/instance.ts';
import { createStrokeMaterial } from '../src/render/strokes/material.ts';
import { srgb8ToLab } from '../src/util/cielab.ts';
import { skyAnchors } from '../src/world/sky.ts';
import {
  createSkyLights,
  SKY_LIGHT_GOLD_B,
  SKY_LIGHT_RIM,
  skyLightCones,
} from '../src/world/sky-lights.ts';

const motionGlsl = readFileSync('src/motion/motion.glsl', 'utf8');
const ringsGlsl = readFileSync('src/motion/sky-rings.glsl', 'utf8');
const strokeGlsl = readFileSync('src/render/strokes/stroke.vert.glsl', 'utf8');
const haloVert = readFileSync('src/render/sky-halo.vert.glsl', 'utf8');
const haloFrag = readFileSync('src/render/sky-halo.frag.glsl', 'utf8');

const SOURCE = await loadRealSource();
const SCAN = await loadSkyScan();
const LIGHTS = createSkyLights(SOURCE, SCAN, 1, WORLD_DOME_SIZE).strokes;
const CONES = skyLightCones(WORLD_DOME_SIZE);
const ALL = motionLayerMask([STROKE_LAYER.sky, STROKE_LAYER.star, STROKE_LAYER.moon]);
const TIMES = Array.from({ length: 97 }, (_, i) => (i * 3600) / 96 + i * 0.173);

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('ring phase maths (R-P4d)', () => {
  test('11 stars then the moon, one ring per sky anchor', () => {
    expect(SKY_RINGS).toHaveLength(skyAnchors().length);
    expect(SKY_STAR_COUNT).toBe(11);
    expect(SKY_MOON_RING).toBe(11);
    SKY_RINGS.forEach((ring, k) => {
      expect(ring.centre).toEqual(skyAnchors()[k].position);
      expect(ring.kind).toBe(k === SKY_MOON_RING ? 'moon' : 'star');
    });
  });

  test('every period divides the 3600 s wrap; stars pulse every 3-7 s and the moon slower', () => {
    const [lo, hi] = SKY_RING_STAR_PERIODS;
    for (const ring of SKY_RINGS) {
      const n = 3600 / ring.period;
      expect(Math.abs(n - Math.round(n)), ring.note).toBeLessThan(1e-9);
      if (ring.kind === 'star') {
        // Quantising moves a period by at most half a step of 3600 / n.
        expect(ring.period).toBeGreaterThan(lo - 0.01);
        expect(ring.period).toBeLessThan(hi + 0.01);
        expect(ring.period).toBeLessThan(SKY_RING_MOON_PERIOD);
      }
    }
    expect(SKY_RINGS[SKY_MOON_RING].period).toBe(10);
    // The moon's shimmer divides the wrap too, and is periodic in its period and the wrap.
    const shimmer = 3600 / SKY_MOON_SHIMMER_PERIOD;
    expect(Math.abs(shimmer - Math.round(shimmer))).toBeLessThan(1e-9);
    for (const byte of [0, 77, 254]) {
      for (const t of [0.3, 1.9, 7.25]) {
        const v = moonShimmer(byte, t);
        expect(Math.abs(v)).toBeLessThanOrEqual(SKY_MOON_SHIMMER + 1e-12);
        expect(moonShimmer(byte, t + SKY_MOON_SHIMMER_PERIOD)).toBeCloseTo(v, 9);
        expect(moonShimmer(byte, t + 3600)).toBeCloseTo(v, 9);
      }
    }
    expect(SKY_RING_MOON_PERIOD).toBeGreaterThanOrEqual(9);
    expect(SKY_RING_MOON_PERIOD).toBeLessThanOrEqual(12);
    // Spread phases and periods: no two stars share both.
    const keys = new Set(SKY_RINGS.map((r) => `${r.period.toFixed(4)}:${r.phase.toFixed(4)}`));
    expect(keys.size).toBe(SKY_RINGS.length);
  });

  test('the bump is 0 at the wrap, 1 at the middle, in [0, 1] and flat across the wrap', () => {
    expect(ringBump(0)).toBe(0);
    expect(ringBump(1)).toBe(0);
    expect(ringBump(0.5)).toBe(1);
    for (let i = 0; i <= 1000; i++) {
      const b = ringBump(i / 1000);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
    // C1 across the wrap: the slope at both ends is 0.
    const h = 1e-6;
    expect(ringBump(h) / h).toBeLessThan(1e-4);
    expect(ringBump(1 - h) / h).toBeLessThan(1e-4);
  });

  test('the wave, the ring motion and the halo are periodic in their period and in the wrap', () => {
    for (const ring of SKY_RINGS) {
      const p: [number, number, number] = [
        ring.centre[0] + 0.5 * ring.outer,
        ring.centre[1] + 0.1,
        ring.centre[2],
      ];
      for (const t of [0, 1.3, 7.77, 1234.5]) {
        for (const r of [0, 0.3 * ring.outer, ring.outer]) {
          for (const later of [t + ring.period, t + 3600, t + 7 * ring.period]) {
            expect(ringWave(ring, r, later)).toBeCloseTo(ringWave(ring, r, t), 9);
          }
        }
        const a = skyRing(ring, p, t);
        const b = skyRing(ring, p, t + ring.period);
        a.offset.forEach((v, i) => {
          expect(b.offset[i]).toBeCloseTo(v, 9);
        });
        expect(b.bright).toBeCloseTo(a.bright, 9);
        const ha = skyHaloState(ring, t, 1);
        const hb = skyHaloState(ring, t + 3600, 1);
        expect(hb.size).toBeCloseTo(ha.size, 9);
        const rho = 0.4 * skyHaloExtent(ring);
        expect(skyHaloGlow(ring, hb, rho)).toBeCloseTo(skyHaloGlow(ring, ha, rho), 9);
      }
    }
  });

  test('a crest travels outward: the wave at a larger radius peaks later', () => {
    for (const ring of SKY_RINGS) {
      const peak = (r: number): number => {
        let best = 0;
        let at = 0;
        for (let i = 0; i < 2000; i++) {
          const t = (i / 2000) * ring.period;
          const w = ringWave(ring, r, t);
          if (w > best) [best, at] = [w, t];
        }
        return at;
      };
      const r0 = 0.2 * ring.outer;
      const r1 = 0.4 * ring.outer;
      const delay = (((peak(r1) - peak(r0)) % ring.period) + ring.period) % ring.period;
      // 0.2 of the rim is 0.2 of a wavelength: 0.2 of a period later.
      expect(delay / ring.period).toBeCloseTo((0.2 * ring.outer) / ring.wavelength, 2);
    }
  });
});

describe('ring brightness and halo brightness are bounded', () => {
  test('a ring stroke brightens by 0 to `bright`, a moon stroke shimmers past it by at most SKY_MOON_SHIMMER, times calm, and never changes size', () => {
    for (const s of LIGHTS) {
      const moon = s.layer === STROKE_LAYER.moon;
      const ring = ringOf(moon, s.phase);
      const shimmer = moon ? SKY_MOON_SHIMMER : 0;
      for (const t of TIMES.slice(0, 24)) {
        for (const calm of [0.25, 1]) {
          const m = motionOffset(s.layer, s.phase, s.position, s.normal, {
            time: t,
            calm,
            layerMask: ALL,
          });
          expect(m.bright).toBeGreaterThanOrEqual(-calm * shimmer - 1e-12);
          expect(m.bright).toBeLessThanOrEqual(
            calm * (Math.max(ring.bright, ring.innerBright) + shimmer) + 1e-12,
          );
          expect(m.gain).toBe(0);
          expect(m.turn).toBe(0);
        }
      }
    }
  });

  test('the halo adds at most rest + ring light, swells at most SKY_HALO_SWELL, rests when closed', () => {
    for (const ring of SKY_RINGS) {
      const extent = skyHaloExtent(ring);
      const rest = skyHaloState(ring, 0, 0);
      expect(rest.size).toBe(ring.haloSize);
      expect(rest.centre).toBe(ring.haloCentre);
      expect(rest.ring).toBe(0);
      for (const t of TIMES) {
        // A closed gate (live 0) is the rest halo at any time.
        const closed = skyHaloState(ring, t, 0);
        expect(closed.size).toBe(rest.size);
        expect(closed.centre).toBe(rest.centre);
        expect(closed.ring).toBe(0);
        for (const q of [0, 0.25, 0.5, 0.9]) {
          expect(skyHaloGlow(ring, closed, q * extent)).toBeCloseTo(
            skyHaloGlow(ring, rest, q * extent),
            12,
          );
        }
        const open = skyHaloState(ring, t, 1);
        expect(open.size).toBeGreaterThanOrEqual(ring.haloSize);
        expect(open.size).toBeLessThanOrEqual(ring.haloSize * (1 + SKY_HALO_SWELL) + 1e-9);
        for (let i = 0; i <= 40; i++) {
          const glow = skyHaloGlow(ring, open, (i / 40) * extent * (1 + SKY_HALO_SWELL));
          expect(glow).toBeGreaterThanOrEqual(0);
          expect(glow).toBeLessThanOrEqual(ring.haloRest + ring.haloRing + 1e-12);
        }
        expect(skyHaloGlow(ring, open, (open.centre + open.size) * 1.0001)).toBe(0);
      }
      // Peak brightness, tint included, stays well under a full channel.
      expect(Math.max(...ring.haloColour) * (ring.haloRest + ring.haloRing)).toBeLessThan(0.3);
    }
  });

  test("the moon's crescent gets no light: the ring brightens the disc by innerBright, a halo band round it", () => {
    const moon = SKY_RINGS[SKY_MOON_RING];
    const disc = moon.inner;
    // The band covers 1.0-1.5 of the moon's circle and peaks at 0.12 at a crest (I1).
    expect(moon.haloCentre - moon.haloSize).toBeCloseTo(disc, 9);
    expect(moon.haloCentre + moon.haloSize).toBeCloseTo(1.5 * disc, 9);
    expect(moon.haloRest + moon.haloRing).toBeCloseTo(0.12, 12);
    for (const t of TIMES) {
      for (const live of [0, 1]) {
        const state = skyHaloState(moon, t, live);
        for (let i = 0; i < 100; i++) {
          // Inside the circle the halo adds nothing at any swell.
          expect(skyHaloGlow(moon, state, (i / 100) * disc)).toBe(0);
        }
        expect(skyHaloGlow(moon, state, disc)).toBeLessThan(1e-12);
      }
      for (let i = 0; i <= 40; i++) {
        const r = (i / 40) * moon.outer;
        const p: [number, number, number] = [moon.centre[0] + r, moon.centre[1], moon.centre[2]];
        const m = skyRing(moon, p, t);
        const gain = r < disc ? moon.innerBright : moon.bright;
        // The mirror clamps the distance to 1 mm, as the shader does, which the centre sample feels.
        expect(m.bright).toBeCloseTo(gain * ringWave(moon, r, t), r < disc ? 4 : 12);
      }
    }
    // The stars keep their centred glow and brighten from the centre out.
    for (const ring of SKY_RINGS) {
      if (ring.kind !== 'star') continue;
      expect(ring.haloCentre).toBe(0);
      const p: [number, number, number] = [ring.centre[0] + 1, ring.centre[1], ring.centre[2]];
      expect(skyRing(ring, p, 1.7).bright).toBeCloseTo(ring.bright * ringWave(ring, 1, 1.7), 12);
      expect(ring.innerBright).toBe(0);
    }
  });
});

describe('ring reach (R-P4a) and the haze cones (R-P4b)', () => {
  test('every light stroke names its anchor in its phase byte and lies inside its rim', () => {
    let star = 0;
    let moon = 0;
    for (const s of LIGHTS) {
      expect(s.flags).toBe(DEPTH_BACKDROP_FLAG);
      const isMoon = s.layer === STROKE_LAYER.moon;
      if (isMoon) {
        moon++;
        expect(s.phase).toBeLessThanOrEqual(SKY_MOON_STILL_PHASE);
      } else {
        star++;
        expect(s.phase).toBeLessThan(SKY_STAR_COUNT);
      }
      // Up to the rim's 32-point sampling, which a stroke can sit just past.
      expect(dist(s.position, ringOf(isMoon, s.phase).centre)).toBeLessThan(
        1.01 * ringOf(isMoon, s.phase).outer,
      );
    }
    expect(star).toBeGreaterThan(0);
    expect(moon).toBeGreaterThan(0);
  });

  test('the shader mirror never moves a light stroke past its exact reach or SKY_RING_REACH', () => {
    let worst = 0;
    let largest = 0;
    for (const s of LIGHTS) {
      const ring = ringOf(s.layer === STROKE_LAYER.moon, s.phase);
      const reach = skyRingReach(ring, ...s.position);
      expect(reach).toBeLessThanOrEqual(SKY_RING_REACH);
      largest = Math.max(largest, reach);
      for (const t of TIMES) {
        const m = motionOffset(s.layer, s.phase, s.position, s.normal, {
          time: t,
          calm: 1,
          layerMask: MOTION_LAYER_MASK,
        });
        const moved = Math.hypot(...m.offset);
        expect(moved).toBeLessThanOrEqual(reach + 1e-9);
        worst = Math.max(worst, moved / Math.max(reach, 1e-12));
      }
    }
    // The sweep reaches near each stroke's crest, so the bound is tight, not loose.
    expect(worst).toBeGreaterThan(0.95);
    expect(largest).toBeGreaterThan(0.5 * SKY_RING_REACH);
    expect(SKY_RING_REACH).toBe(
      Math.max(...SKY_RINGS.map((r) => (r.swell * (r.outer - r.inner)) / 4)),
    );
  });

  test('a moved stroke centre never passes its rim, so the cones keep their rest size', () => {
    for (const ring of SKY_RINGS) {
      expect(ring.swell).toBeLessThanOrEqual(1);
      for (let i = 0; i <= 200; i++) {
        const r = (i / 200) * 1.2 * ring.outer;
        const p: [number, number, number] = [ring.centre[0] + r, ring.centre[1], ring.centre[2]];
        for (const t of TIMES.slice(0, 32)) {
          const m = skyRing(ring, p, t);
          const moved = dist(
            [p[0] + m.offset[0], p[1] + m.offset[1], p[2] + m.offset[2]],
            ring.centre,
          );
          // Outward only, and never past the rim from inside it.
          expect(moved).toBeGreaterThanOrEqual(r - 1e-9);
          if (r <= ring.outer) expect(moved).toBeLessThanOrEqual(ring.outer + 1e-9);
          else expect(moved).toBeCloseTo(r, 9);
        }
      }
      // The cones are sized from the same rim reach, plus a stroke's half diagonal.
      expect(CONES[SKY_RINGS.indexOf(ring)].radius).toBeGreaterThan(ring.outer);
    }
  });

  test("the moon's crescent stays still: its gold strokes carry the still phase and never move or brighten", () => {
    let still = 0;
    let rings = 0;
    for (const s of LIGHTS) {
      if (s.layer !== STROKE_LAYER.moon) continue;
      const [r, g, bl] = s.color.map((c) => Math.min(255, Math.round(c)));
      // A stroke coloured gold is on the crescent.
      if (srgb8ToLab(r, g, bl)[2] > SKY_LIGHT_GOLD_B) expect(s.phase).toBe(SKY_MOON_STILL_PHASE);
      if (s.phase === SKY_MOON_STILL_PHASE) still++;
      else rings++;
      for (const t of TIMES.slice(0, 24)) {
        const m = motionOffset(s.layer, s.phase, s.position, s.normal, {
          time: t,
          calm: 1,
          layerMask: MOTION_LAYER_MASK,
        });
        if (s.phase === SKY_MOON_STILL_PHASE) {
          expect(m.offset).toEqual([0, 0, 0]);
          expect(m.bright).toBe(0);
        } else {
          expect(m.bright).toBeCloseTo(moonRing(s.position, s.phase, t).bright, 12);
        }
      }
    }
    // Both kinds are there: the crescent's strokes and the cream disc and band round it.
    expect(still).toBeGreaterThan(50);
    expect(rings).toBeGreaterThan(still);
    // Only the moon's ring brightens the disc inside its circle; its strokes there never move.
    const moon = SKY_RINGS[SKY_MOON_RING];
    expect(moon.inner).toBeGreaterThan(0.6 * moon.outer);
    expect(moon.inner).toBeLessThan(moon.outer);
    expect(ringHat(moon, 0.5 * moon.inner)).toBe(0);
    expect(ringHat(moon, moon.inner)).toBe(0);
    expect(ringHat(moon, 0.5 * (moon.inner + moon.outer))).toBeGreaterThan(0);
    for (const ring of SKY_RINGS) {
      if (ring.kind === 'star') expect(ring.inner).toBe(0);
    }
    expect(SKY_LIGHT_RIM).toBe(1.5);
  });

  test("a light chunk's cull reach is its strokes' exact ring reach, gated by its own layer", () => {
    const buffers = createStrokeBuffers(LIGHTS.length);
    LIGHTS.forEach((s, i) => {
      packInstance(buffers, i, s);
    });
    const reaches = motionReachesOf(buffers);
    let star = 0;
    let moon = 0;
    for (const s of LIGHTS) {
      const r = skyRingReach(ringOf(s.layer === STROKE_LAYER.moon, s.phase), ...s.position);
      if (s.layer === STROKE_LAYER.moon) moon = Math.max(moon, r);
      else star = Math.max(star, r);
    }
    // Float32 storage moves each centre by micrometres.
    expect(reaches.sky).toBe(0);
    expect(reaches.star).toBeCloseTo(SKY_REACH_MARGIN * star, 5);
    expect(reaches.moon).toBeCloseTo(SKY_REACH_MARGIN * moon, 5);
    expect(motionReachOf(buffers)).toBe(Math.max(reaches.star, reaches.moon));
    expect(Math.max(reaches.star, reaches.moon)).toBeLessThanOrEqual(
      SKY_REACH_MARGIN * SKY_RING_REACH,
    );
  });
});

describe('halo pass', () => {
  test('one instanced additive mesh: 12 instances, one-one blending, depth-tested, no depth write', () => {
    const halo = createSkyHalo();
    const { mesh } = halo;
    const material = mesh.material;
    expect(mesh.geometry.instanceCount).toBe(12);
    expect(mesh.frustumCulled).toBe(false);
    expect(material.transparent).toBe(true);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.alphaToCoverage).toBe(false);
    expect(material.blending).toBe(CustomBlending);
    expect(material.blendSrc).toBe(OneFactor);
    expect(material.blendDst).toBe(OneFactor);
    for (const key of ['uTime', 'uCalm', 'uMotionLayers'] as const) {
      expect(material.uniforms[key]).toBe(motionClock.uniforms[key]);
    }
    // The same ring tables as the stroke shader, from one TS source.
    const strokes = createStrokeMaterial(new Texture());
    for (const [name, value] of Object.entries(skyRingGlslDefines())) {
      expect(material.defines[name]).toBe(value);
      expect(strokes.defines[name]).toBe(value);
    }
    expect(material.vertexShader).toContain(ringsGlsl.trimEnd());
    expect(material.fragmentShader).toContain(ringsGlsl.trimEnd());
    expect(strokes.vertexShader).toContain(ringsGlsl.trimEnd());
    expect(strokes.vertexShader.indexOf('float ringBump(')).toBeLessThan(
      strokes.vertexShader.indexOf('Motion ringMotion('),
    );
    halo.dispose();
  });

  test('the closed gate draws the rest halo; an open one swells it with the clock', () => {
    const halo = createSkyHalo();
    try {
      motionClock.setLayerMask(0);
      motionClock.uniforms.uTime.value = 3.3;
      const closed = halo.state();
      closed.forEach((h, k) => {
        expect(h.size).toBe(SKY_RINGS[k].haloSize);
        expect(h.ring).toBe(0);
      });
      motionClock.setLayerMask(MOTION_LAYER_MASK);
      motionClock.setCalm(0.5);
      const a = halo.state();
      motionClock.uniforms.uTime.value = 5.1;
      const b = halo.state();
      expect(a.map((h) => h.size)).not.toEqual(b.map((h) => h.size));
      a.forEach((h, k) => {
        expect(h.ring).toBeCloseTo(0.5 * SKY_RINGS[k].haloRing, 12);
      });
    } finally {
      motionClock.uniforms.uTime.value = 0;
      motionClock.setCalm(1);
      motionClock.setLayerMask(0);
      halo.dispose();
    }
  });

  test('every halo, swollen and as an octagon, stays inside its haze cone', () => {
    const { position, index } = skyHaloRing();
    const n = SKY_HALO_SIDES;
    expect(position.length).toBe(2 * n * 3);
    expect(index.length).toBe(n * 6);
    let corner = 0;
    for (let k = 0; k < n; k++) {
      // The hole's corners are unit directions, so the hole lies inside the radius they scale to.
      expect(Math.hypot(position[k * 3], position[k * 3 + 1])).toBeCloseTo(1, 6);
      expect(position[k * 3 + 2]).toBe(0);
      const o = (n + k) * 3;
      expect(position[o + 2]).toBe(1);
      corner = Math.max(corner, Math.hypot(position[o], position[o + 1]));
      // Every outer edge's midpoint touches the unit circle: the glow's disc is inscribed.
      const next = (n + ((k + 1) % n)) * 3;
      const mx = 0.5 * (position[o] + position[next]);
      const my = 0.5 * (position[o + 1] + position[next + 1]);
      expect(Math.hypot(mx, my)).toBeCloseTo(1, 6);
    }
    expect(corner).toBeCloseTo(SKY_HALO_CORNER, 6);
    SKY_RINGS.forEach((ring, k) => {
      expect(corner * skyHaloExtent(ring) * (1 + SKY_HALO_SWELL)).toBeLessThan(CONES[k].radius);
    });
  });

  test('the halo draws in front of the backdrop and behind anything within 200 m', () => {
    // main.ts's camera planes, which XR inherits. Every world surface is within about 170 m of any
    // eye the rig can reach (the dome is 120 m round the painter's eye).
    const near = 0.1;
    const far = 1000;
    const ndc = (d: number): number =>
      (far + near) / (far - near) - (2 * far * near) / ((far - near) * d);
    expect(SKY_HALO_NDC).toBeLessThan(backdropNdc(255, 'front'));
    expect(SKY_HALO_NDC).toBeLessThan(backdropNdc(0, 'dome'));
    expect(SKY_HALO_NDC).toBeGreaterThan(ndc(200));
    const material = createSkyHaloMaterial();
    expect(material.defines.SKY_HALO_NDC).toBe(SKY_HALO_NDC.toExponential(8));
  });
});

describe('GLSL wiring and cost (R-P4h)', () => {
  test('ringMotion is the mirrored maths, with one inverse square root and no other special function', () => {
    for (const line of [
      'float d2 = max(dot(d, d), 1e-6);',
      'float inv = inversesqrt(d2);',
      'float r = d2 * inv;',
      'float w = ringBump(fract(t * c.w + wave.x - r * wave.y));',
      'float hat = max(r - wave.z, 0.0) * max(wave.w - r, 0.0);',
      'return Motion((gain.x * w * hat * inv) * d, 0.0, 0.0, w * mix(gain.z, gain.y, step(wave.z, r)));',
      'return ringMotion(int(min(phaseByte, uint(SKY_RING_STAR_COUNT - 1))), p, t);',
      'Motion moonMotion(vec3 p, uint phaseByte, float t) {',
      'if (phaseByte == SKY_MOON_STILL_PHASE) return Motion(vec3(0.0), 0.0, 0.0, 0.0);',
      'float f = fract(t * SKY_MOON_SHIMMER_INV_PERIOD + float(phaseByte) * (1.0 / 256.0));',
      'm.bright += SKY_MOON_SHIMMER * (2.0 * ringBump(f) - 1.0);',
      'm = starMotion(p, phaseByte, t);',
      'm = moonMotion(p, phaseByte, t);',
    ]) {
      expect(motionGlsl).toContain(line);
    }
    const ring = motionGlsl.slice(
      motionGlsl.indexOf('Motion ringMotion('),
      motionGlsl.indexOf('Motion cypressMotion('),
    );
    const special = /\b(sin|cos|tan|asin|acos|atan|exp|log|pow|sqrt|length|normalize)\(/g;
    expect(ring.match(special)).toBeNull();
    expect(ring.match(/inversesqrt\(/g)).toHaveLength(1);
    expect(ringsGlsl.match(special)).toBeNull();
    // The halo's fragment shader pays one square root, and nothing else special.
    const frag = haloFrag.slice(haloFrag.indexOf('void main()'));
    expect(frag.match(/\bsqrt\(/g)).toHaveLength(1);
    expect(frag.match(/\b(sin|cos|tan|asin|acos|atan|exp|log|pow|length|normalize)\(/g)).toBeNull();
    expect(haloVert).toContain('gl_Position.z = gl_Position.w * SKY_HALO_NDC;');
  });

  test('the brightness rides inside the motion gate: the default path gains no work', () => {
    const main = strokeGlsl.slice(strokeGlsl.indexOf('void main()'));
    const gate = main.indexOf('if (motionGate(iMeta.y) && thin > 0.0) {');
    const bright = main.indexOf('color *= 1.0 + m.bright;');
    expect(bright).toBeGreaterThan(gate);
    expect(bright).toBeLessThan(main.indexOf('gl_Position = projectionMatrix'));
    expect(main).toContain('vec3 color = iColor.rgb;');
    expect(main).toContain('vColor = color;');
    expect(main.match(/vColor =/g)).toHaveLength(1);
    expect(main).not.toMatch(/SKY_RING_/);
  });

  test('the motion table and mirror agree on the star and moon layers', () => {
    const material = createStrokeMaterial(new Texture());
    expect(material.defines.SKY_RING_COUNT).toBe(12);
    expect(material.defines.SKY_RING_STAR_COUNT).toBe(11);
    expect(material.defines.SKY_RING_MOON).toBe(11);
    expect(String(material.defines.SKY_RING_CENTRES).match(/vec4\(/g)).toHaveLength(12);
    expect(String(material.defines.SKY_RING_GAINS).match(/vec3\(/g)).toHaveLength(12);
    expect(material.defines.SKY_MOON_STILL_PHASE).toBe(`${SKY_MOON_STILL_PHASE}u`);
    // A stray star phase byte clamps to the last star, as the shader's min does.
    expect(ringOf(false, 200)).toBe(SKY_RINGS[SKY_STAR_COUNT - 1]);
    expect(ringOf(true, 3)).toBe(SKY_RINGS[SKY_MOON_RING]);
  });
});
