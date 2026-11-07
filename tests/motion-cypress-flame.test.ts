/**
 * Cypress flame (P4.4): the encode, the TS mirror of cypressMotion and its bounds, checked against
 * the seed-1 cypress strokes as the world scatters them (the real canvas source).
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { Texture } from 'three';
import { describe, expect, test } from 'vitest';
import { loadRealSource } from '../scripts/scatter-time.ts';
import {
  CYPRESS_FLAME_FADE,
  CYPRESS_FLAME_HALF_ARC,
  CYPRESS_FLAME_NONE,
  CYPRESS_FLAME_PERIOD,
  CYPRESS_FLAME_TIP,
  CYPRESS_FLICKER_MAX,
  CYPRESS_FLICKER_WAVES,
  CYPRESS_HEIGHT_LEVELS,
  CYPRESS_MAX_LOBES,
  cypressFlame,
  cypressFlameGlslDefines,
  cypressFlameReach,
  decodeFlame,
  encodeFlame,
  flameTaper,
  flickerAmplitude,
  flickerWave,
} from '../src/motion/cypress-flame.ts';
import { MOTION_LAYER_MASK, motionOffset } from '../src/motion/motion.ts';
import { SKY_SWIRL_FADE, SKY_SWIRL_PERIOD, skySwirl } from '../src/motion/sky-swirl.ts';
import { PAINTER_EYE, projectToCanvas } from '../src/paintings/starry-night/canvas-camera.ts';
import { WORLD_SCATTER_SIZE } from '../src/paintings/starry-night/world.ts';
import { motionReachesOf, SKY_REACH_MARGIN } from '../src/render/strokes/batch.ts';
import type { Vec3 } from '../src/render/strokes/frame.ts';
import {
  STROKE_LAYER,
  type StrokeBuffers,
  unpackInstance,
} from '../src/render/strokes/instance.ts';
import { createStrokeMaterial } from '../src/render/strokes/material.ts';
import { SCATTER_DEPTH_JITTER, scatterSurfaces } from '../src/render/strokes/scatter.ts';
import {
  CYPRESS_HEIGHT_ATTRIBUTE,
  CYPRESS_LOBE_ATTRIBUTE,
  CYPRESS_LOBES,
  CYPRESS_LOWER_LOBES,
  CYPRESS_LOWER_RINGS,
  CYPRESS_LOWER_SEGMENTS,
  CYPRESS_RINGS,
  CYPRESS_SEGMENTS,
  type CypressMass,
  createCypress,
} from '../src/world/cypress.ts';
import { createTerrain } from '../src/world/terrain.ts';

const SOURCE = await loadRealSource();
const TERRAIN = createTerrain(1);
const CYPRESS = createCypress(1, TERRAIN);

/** The world's own cypress strokes: one mesh draws from the same streams alone (scatter.ts). */
function scatterCypress(): StrokeBuffers {
  const flat = CYPRESS.geometry.clone();
  flat.deleteAttribute('normal');
  flat.userData = CYPRESS.geometry.userData;
  expect(flat.getAttribute(CYPRESS_HEIGHT_ATTRIBUTE)).toBeDefined();
  expect(flat.getAttribute(CYPRESS_LOBE_ATTRIBUTE)).toBeDefined();
  const strokes = scatterSurfaces([flat], SOURCE, { size: WORLD_SCATTER_SIZE, seed: 1 });
  flat.dispose();
  return strokes;
}

const STROKES = scatterCypress();
interface Stroke {
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly phase: number;
  readonly alpha: number;
  readonly size: number;
}
const ALL: readonly Stroke[] = Array.from({ length: STROKES.count }, (_, i) => {
  const s = unpackInstance(STROKES, i);
  return {
    position: s.position,
    normal: s.normal,
    phase: s.phase,
    alpha: s.color[3],
    size: s.size[0],
  };
});
/** Every 7th stroke: the sweeps over time stay quick. */
const SAMPLE = ALL.filter((_, i) => i % 7 === 0);
/** Times over two rise periods, never on a wrap of the coherent grid. */
const TIMES = Array.from({ length: 64 }, (_, k) => 0.0371 + (k * 2 * CYPRESS_FLAME_PERIOD) / 64);

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const upOf = ([x, y, z]: Vec3): Vec3 => [-x * y, 1 - y * y, -z * y];
const sideOf = ([x, , z]: Vec3): Vec3 => [z, 0, -x];

describe('flame byte', () => {
  test('round-trips lobe and height, rounds the height up, never makes the 255 sentinel', () => {
    for (let lobe = 0; lobe < 8; lobe++) {
      for (let k = 0; k <= 100; k++) {
        const h = k / 100;
        const byte = encodeFlame(lobe, h);
        expect(byte).not.toBe(CYPRESS_FLAME_NONE);
        const decoded = decodeFlame(byte);
        expect(decoded?.lobe).toBe(lobe);
        expect(decoded?.height).toBeGreaterThanOrEqual(h - 1e-12);
        expect(decoded?.height).toBeLessThan(h + 1 / CYPRESS_HEIGHT_LEVELS + 1e-12);
      }
    }
    expect(decodeFlame(CYPRESS_FLAME_NONE)).toBeNull();
    expect(() => encodeFlame(8, 0.5)).toThrow(RangeError);
  });

  test('the generator can never make more lobe ids than the three lobe bits hold', () => {
    expect(CYPRESS_LOBES.max + CYPRESS_LOWER_LOBES.max).toBeLessThanOrEqual(CYPRESS_MAX_LOBES);
    expect(CYPRESS.lobeCount).toBeLessThanOrEqual(CYPRESS_MAX_LOBES);
  });

  test('the scatter bakes every cypress stroke from its mesh, with the world count', () => {
    expect(STROKES.count).toBe(36_964);
    for (const s of ALL) {
      const flame = decodeFlame(s.alpha);
      expect(flame).not.toBeNull();
      expect(flame?.lobe).toBeLessThan(CYPRESS.lobeCount);
    }
    // The heights span the tree: both the base and the apex levels occur.
    const levels = new Set(ALL.map((s) => s.alpha & 31));
    expect(levels.has(0) || levels.has(1)).toBe(true);
    expect(levels.has(CYPRESS_HEIGHT_LEVELS)).toBe(true);
    // A stroke with no flame data stays at rest.
    expect(cypressFlame([0, 1, 0], [1, 0, 0], 0.3, CYPRESS_FLAME_NONE, 1.3).offset).toEqual([
      0, 0, 0,
    ]);
  });
});

/** The e2e probe's tolerance per shift component: px plus share of the predicted value. */
const PROBE_TOLERANCE = { px: 2, share: 0.25 } as const;
const record = (line: string): void => {
  console.log(line);
  if (process.env.P44_REPORT) appendFileSync(process.env.P44_REPORT, `${line}\n`);
};

describe('motion', () => {
  test('the vertical speed is positive along the lobes for every stroke that rises', () => {
    let rising = 0;
    for (const s of ALL) {
      const h = (decodeFlame(s.alpha) as { height: number }).height;
      const taper = flameTaper(h);
      // f = 0.25 and 0.75 of the loop, far from the wrap.
      const t0 = (0.25 - s.phase / 256 + 4) * CYPRESS_FLAME_PERIOD;
      const dt = 0.01;
      const a = cypressFlame(s.position, s.normal, s.phase / 256, s.alpha, t0);
      const b = cypressFlame(s.position, s.normal, s.phase / 256, s.alpha, t0 + dt);
      const rise = dot(b.offset, upOf(s.normal)) - dot(a.offset, upOf(s.normal));
      const vy =
        ((2 * CYPRESS_FLAME_HALF_ARC * taper) / CYPRESS_FLAME_PERIOD) * (1 - s.normal[1] ** 2);
      if (taper === 0) {
        expect(rise).toBeCloseTo(0, 12);
        continue;
      }
      rising++;
      // Measured: the sway is horizontal, so the offset's y change is the climb alone.
      const climbed = b.offset[1] - a.offset[1];
      expect(climbed).toBeGreaterThan(0);
      expect(climbed).toBeCloseTo(dt * vy, 12);
      // The rise share alone (up is orthogonal to the sway) climbs at exactly vy.
      expect(rise / dot(upOf(s.normal), upOf(s.normal))).toBeCloseTo(
        (dt * 2 * CYPRESS_FLAME_HALF_ARC * taper) / CYPRESS_FLAME_PERIOD,
        9,
      );
    }
    // Only the apex level is still.
    expect(rising).toBeGreaterThan(0.95 * ALL.length);
    record(`[cypress] rising strokes ${rising} of ${ALL.length}`);
  });

  test('the flicker amplitude rises with height, bounded by CYPRESS_FLICKER_MAX', () => {
    const weights = CYPRESS_FLICKER_WAVES.reduce((sum, w) => sum + w.weight, 0);
    expect(weights).toBeCloseTo(1, 12);
    for (let k = 1; k <= 30; k++) {
      expect(flickerAmplitude(k / 30)).toBeGreaterThan(flickerAmplitude((k - 1) / 30));
    }
    expect(flickerAmplitude(1)).toBe(CYPRESS_FLICKER_MAX);
    for (let lobe = 0; lobe < 8; lobe++) {
      for (let y = -6; y < 14; y += 0.37) {
        for (const t of TIMES) expect(Math.abs(flickerWave(lobe, y, t))).toBeLessThanOrEqual(1);
      }
    }
    // Measured on the strokes: the widest sway per tenth of the height rises up the tree.
    const band = new Float64Array(10);
    for (const s of SAMPLE) {
      const h = (decodeFlame(s.alpha) as { height: number }).height;
      const side = sideOf(s.normal);
      const len2 = dot(side, side);
      if (len2 < 0.25) continue;
      for (const t of TIMES) {
        const m = cypressFlame(s.position, s.normal, s.phase / 256, s.alpha, t);
        const sway = Math.abs(dot(m.offset, side)) / Math.sqrt(len2);
        const b = Math.min(9, Math.floor(h * 10));
        band[b] = Math.max(band[b], sway);
      }
    }
    for (let b = 1; b < 10; b++) expect(band[b]).toBeGreaterThan(band[b - 1]);
  });

  test('every period divides the 3600 s wrap (R-P4d)', () => {
    for (const p of [CYPRESS_FLAME_PERIOD, ...CYPRESS_FLICKER_WAVES.map((w) => w.period)]) {
      expect(Math.abs(3600 / p - Math.round(3600 / p))).toBeLessThan(1e-9);
    }
  });

  test('a stroke shrinks to nothing at its wrap at every calm the gate is open at, and calm scales the offset', () => {
    const s = ALL.find(
      (x) => flameTaper((decodeFlame(x.alpha) as { height: number }).height) === 1,
    );
    if (!s) throw new Error('no full-arc stroke');
    const wrap = (1 - s.phase / 256) * CYPRESS_FLAME_PERIOD;
    for (const calm of [1e-3, 0.25, 0.5, 1]) {
      const uniforms = { time: wrap, calm, layerMask: MOTION_LAYER_MASK };
      const at = motionOffset(
        STROKE_LAYER.cypress,
        s.phase,
        s.position,
        s.normal,
        uniforms,
        undefined,
        s.alpha,
      );
      expect(1 + at.gain).toBeCloseTo(0, 6);
      const mid = { ...uniforms, time: wrap + 0.3 * CYPRESS_FLAME_PERIOD };
      const full = motionOffset(
        STROKE_LAYER.cypress,
        s.phase,
        s.position,
        s.normal,
        { ...mid, calm: 1 },
        undefined,
        s.alpha,
      );
      const scaled = motionOffset(
        STROKE_LAYER.cypress,
        s.phase,
        s.position,
        s.normal,
        mid,
        undefined,
        s.alpha,
      );
      for (let k = 0; k < 3; k++) expect(scaled.offset[k]).toBeCloseTo(calm * full.offset[k], 12);
      expect(scaled.gain).toBe(full.gain);
      expect(1 + full.gain).toBe(1);
    }
    expect(CYPRESS_FLAME_FADE).toBeLessThan(0.5);
  });
});

/** Each ring of a mass, from the base up, then the tip, as xz points with the ring's y. */
function massRings(
  mass: CypressMass,
  rings: number,
  segs: number,
): { y: number; pts: [number, number][] }[] {
  const pos = CYPRESS.geometry.getAttribute('position');
  const out: { y: number; pts: [number, number][] }[] = [];
  for (let i = 0; i < rings; i++) {
    const pts: [number, number][] = [];
    for (let k = 0; k < segs; k++) {
      const v = mass.firstVertex + i * segs + k;
      pts.push([pos.getX(v), pos.getZ(v)]);
    }
    out.push({ y: pos.getY(mass.firstVertex + i * segs), pts });
  }
  out.push({ y: mass.tip[1], pts: Array.from({ length: segs }, () => [mass.tip[0], mass.tip[2]]) });
  return out;
}

/**
 * The mesh's own horizontal cross-section at y: each quad's two triangles cut between their
 * rings, two points per segment. Below the base ring the base ring's footprint, under the ground.
 */
function section(
  rings: { y: number; pts: [number, number][] }[],
  y: number,
): [number, number][] | null {
  if (y > rings[rings.length - 1].y) return null;
  if (y <= rings[0].y) return rings[0].pts;
  let i = 0;
  while (rings[i + 1].y < y) i++;
  const a = rings[i];
  const b = rings[i + 1];
  const s = (y - a.y) / (b.y - a.y);
  const lerp = (p: [number, number], q: [number, number]): [number, number] => [
    p[0] + s * (q[0] - p[0]),
    p[1] + s * (q[1] - p[1]),
  ];
  const n = a.pts.length;
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    out.push(lerp(a.pts[k], b.pts[k]), lerp(a.pts[(k + 1) % n], b.pts[k]));
  }
  return out;
}

/** How far (x, z) lies outside the polygon, metres: 0 inside. */
function outside(poly: [number, number][], x: number, z: number): number {
  let inside = false;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const ex = xj - xi;
    const ez = zj - zi;
    const len2 = ex * ex + ez * ez;
    const u = len2 > 0 ? Math.min(1, Math.max(0, ((x - xi) * ex + (z - zi) * ez) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (xi + u * ex), z - (zi + u * ez)));
  }
  return inside ? 0 : best;
}

const HULLS = [
  massRings(CYPRESS.main, CYPRESS_RINGS, CYPRESS_SEGMENTS),
  massRings(CYPRESS.lower, CYPRESS_LOWER_RINGS, CYPRESS_LOWER_SEGMENTS),
];

/** How far p lies outside both masses, metres. */
function hullExcess(p: Vec3): number {
  let best = Number.POSITIVE_INFINITY;
  for (const rings of HULLS) {
    const poly = section(rings, p[1]);
    if (poly) best = Math.min(best, outside(poly, p[0], p[2]));
  }
  return best;
}

describe('hull', () => {
  /** The rest lift: SCATTER_DEPTH_JITTER of the graded length, at most the far clamp. */
  const LIFT = SCATTER_DEPTH_JITTER * (WORLD_SCATTER_SIZE.cypress?.far ?? 0.9);
  const quantile = (a: number[], q: number): number =>
    [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))];
  /**
   * The climb runs in each stroke's own face plane, and the faceted, lobed hull bends away from
   * it, so a moved centre can leave the hull. Bounds: 99% of the moved centres stay within a
   * quarter of their own stroke length of the hull and every one within one stroke length. That
   * bounds how far a stroke strays; it does not prove every stroke still overlaps the tree, since a
   * centre more than half a stroke length out leaves its quad clear of the hull. The excursions are
   * recorded.
   */
  test('the rise arc, wrap included, keeps 99% of strokes within a quarter stroke length of the hull and every one within one', () => {
    const excess: number[] = [];
    const shares: number[] = [];
    let atRest = 0;
    let worstShare = 0;
    for (const s of ALL) {
      atRest = Math.max(atRest, hullExcess(s.position));
      const up = upOf(s.normal);
      const up2 = dot(up, up);
      if (up2 === 0) continue;
      let worst = 0;
      for (let k = 0; k <= 16; k++) {
        // f from just past the wrap to just before it: the respawn at the arc's low end included.
        const f = k === 0 ? 1e-6 : k === 16 ? 1 - 1e-6 : k / 16;
        const t = (f - s.phase / 256 + 1) * CYPRESS_FLAME_PERIOD;
        const m = cypressFlame(s.position, s.normal, s.phase / 256, s.alpha, t);
        const rise = dot(m.offset, up) / up2;
        worst = Math.max(
          worst,
          hullExcess([
            s.position[0] + rise * up[0],
            s.position[1] + rise * up[1],
            s.position[2] + rise * up[2],
          ]),
        );
      }
      excess.push(worst);
      shares.push(worst / s.size);
      worstShare = Math.max(worstShare, worst / s.size);
    }
    record(
      `[cypress] hull excess at rest max ${(atRest * 100).toFixed(2)} cm; rise arc p50 ${(quantile(excess, 0.5) * 100).toFixed(2)} cm, p99 ${(quantile(excess, 0.99) * 100).toFixed(2)} cm, max ${(quantile(excess, 1) * 100).toFixed(2)} cm, max ${(worstShare * 100).toFixed(1)}% of the stroke length, p99 ${(quantile(shares, 0.99) * 100).toFixed(1)}%`,
    );
    expect(atRest).toBeLessThanOrEqual(LIFT + 1e-3);
    expect(quantile(shares, 0.99)).toBeLessThanOrEqual(0.25);
    expect(worstShare).toBeLessThanOrEqual(1);
  });

  test('the full motion, sway included, keeps 99% of strokes within a quarter stroke length of the hull and every one within one', () => {
    const excess: number[] = [];
    const shares: number[] = [];
    let worstShare = 0;
    for (const s of SAMPLE) {
      let worst = 0;
      for (const t of TIMES) {
        const m = cypressFlame(s.position, s.normal, s.phase / 256, s.alpha, t);
        worst = Math.max(
          worst,
          hullExcess([
            s.position[0] + m.offset[0],
            s.position[1] + m.offset[1],
            s.position[2] + m.offset[2],
          ]),
        );
      }
      excess.push(worst);
      shares.push(worst / s.size);
      worstShare = Math.max(worstShare, worst / s.size);
    }
    record(
      `[cypress] hull excess with the sway p99 ${(quantile(excess, 0.99) * 100).toFixed(2)} cm, max ${(quantile(excess, 1) * 100).toFixed(2)} cm, max ${(worstShare * 100).toFixed(1)}% of the stroke length, p99 ${(quantile(shares, 0.99) * 100).toFixed(1)}%`,
    );
    expect(quantile(shares, 0.99)).toBeLessThanOrEqual(0.25);
    expect(worstShare).toBeLessThanOrEqual(1);
  });
});

describe('reach (R-P4a)', () => {
  test('cypressFlameReach bounds every stroke offset, and the batch grows a cypress chunk by the largest', () => {
    let largest = 0;
    let largestReach = 0;
    for (const s of SAMPLE) {
      const reach = cypressFlameReach(s.normal[1], s.alpha);
      largestReach = Math.max(largestReach, reach);
      for (const t of TIMES) {
        const m = cypressFlame(s.position, s.normal, s.phase / 256, s.alpha, t);
        const d = Math.hypot(...m.offset);
        expect(d).toBeLessThanOrEqual(reach + 1e-9);
        largest = Math.max(largest, d);
      }
    }
    expect(largest).toBeGreaterThan(0.9 * largestReach);
    const reaches = motionReachesOf(STROKES);
    expect(reaches.sky).toBe(0);
    expect(reaches.cypress).toBeGreaterThanOrEqual(largestReach);
    expect(reaches.cypress).toBeLessThanOrEqual(
      SKY_REACH_MARGIN * Math.hypot(CYPRESS_FLAME_HALF_ARC, CYPRESS_FLICKER_MAX),
    );
    if (process.env.P44_REPORT) {
      appendFileSync(
        process.env.P44_REPORT,
        `[cypress] largest reach ${reaches.cypress.toFixed(4)} m\n`,
      );
    }
  });
});

describe('GLSL', () => {
  test('the stroke material carries every cypress flame define', () => {
    const material = createStrokeMaterial(new Texture());
    for (const [name, value] of Object.entries(cypressFlameGlslDefines())) {
      expect(material.defines[name]).toBe(value);
    }
    expect(material.vertexShader).toContain(
      'Motion cypressMotion(vec3 p, vec3 n, float phase, float flame, float t) {',
    );
    expect(material.vertexShader).toContain('m = cypressMotion(p, n, phase, flame, t);');
  });

  test('cypressMotion decodes the alpha byte and tapers the sway by the height squared, as cypressFlame does (P4.4 N1)', () => {
    const glsl = createStrokeMaterial(new Texture()).vertexShader;
    // The alpha byte: rounded from the normalised alpha, 255 is no flame data, the low five bits
    // the height level over CYPRESS_HEIGHT_LEVELS, the top three the lobe id (decodeFlame).
    for (const line of [
      'uint b = uint(flame * 255.0 + 0.5);',
      'if (b == CYPRESS_FLAME_NONE) return Motion(vec3(0.0), 0.0, 0.0, 0.0);',
      'float h = float(b & 31u) * CYPRESS_INV_HEIGHT_LEVELS;',
      'float lobe = float(b >> 5u);',
      // The rise arc tapers to 0 over the top CYPRESS_FLAME_TIP of each mass (flameTaper).
      'float taper = smoothstep(0.0, CYPRESS_FLAME_TIP, 1.0 - h);',
      'float s = (2.0 * f - 1.0) * CYPRESS_FLAME_HALF_ARC * taper;',
      // The sway: CYPRESS_FLICKER_MAX times the height squared times the two sines.
      'float a = CYPRESS_FLICKER_MAX * h * h * w;',
      'return Motion(s * up + a * side, 0.0, gain, 0.0);',
    ]) {
      expect(glsl, line).toContain(line);
    }
    const defines = cypressFlameGlslDefines();
    expect(defines.CYPRESS_FLAME_NONE).toBe(`${CYPRESS_FLAME_NONE}u`);
    // The amplitudes and the decode scale are the TS constants, so a wrong one fails here.
    expect(CYPRESS_HEIGHT_LEVELS).toBeLessThanOrEqual(31);
    expect(Number(defines.CYPRESS_INV_HEIGHT_LEVELS)).toBeCloseTo(1 / CYPRESS_HEIGHT_LEVELS, 8);
    expect(Number(defines.CYPRESS_FLICKER_MAX)).toBeCloseTo(CYPRESS_FLICKER_MAX, 8);
    expect(Number(defines.CYPRESS_FLAME_HALF_ARC)).toBeCloseTo(CYPRESS_FLAME_HALF_ARC, 8);
    expect(Number(defines.CYPRESS_FLAME_TIP)).toBeCloseTo(CYPRESS_FLAME_TIP, 8);
    // The GLSL decode, run in TS on every byte, matches decodeFlame.
    for (let byte = 0; byte < 256; byte++) {
      const b = Math.trunc((byte / 255) * 255 + 0.5);
      const decoded = decodeFlame(byte);
      if (b === CYPRESS_FLAME_NONE) {
        expect(decoded).toBeNull();
        continue;
      }
      expect((decoded as { lobe: number }).lobe).toBe(b >> 5);
      expect((decoded as { height: number }).height).toBeCloseTo(
        (b & 31) * Number(defines.CYPRESS_INV_HEIGHT_LEVELS),
        6,
      );
    }
  });
});

describe('wrap regrow at 72 Hz (R-P4m)', () => {
  /** Largest change of the size factor 1 + gain between consecutive 72 Hz frames over a wrap. */
  function largestStep(size: (t: number) => number, period: number): number {
    let worst = 0;
    // Two loops at 72 Hz, starting off the frame grid so the wrap falls between frames.
    let prev = size(0.0031);
    for (let k = 1; k <= 2 * 72 * period; k++) {
      const next = size(0.0031 + k / 72);
      worst = Math.max(worst, Math.abs(next - prev));
      prev = next;
    }
    return worst;
  }

  test('the faster regrow changes a stroke by at most the analytic step per frame', () => {
    const sky = largestStep(
      (t) => 1 + skySwirl([0, 60, -100], [0, -0.5, 0.86], 0.3, t).gain,
      SKY_SWIRL_PERIOD,
    );
    const s = ALL.find(
      (x) => flameTaper((decodeFlame(x.alpha) as { height: number }).height) === 1,
    );
    if (!s) throw new Error('no full-arc stroke');
    const flame = largestStep(
      (t) => 1 + cypressFlame(s.position, s.normal, s.phase / 256, s.alpha, t).gain,
      CYPRESS_FLAME_PERIOD,
    );
    // smoothstep's steepest slope is 1.5 over the fade: per frame 1.5 / (FADE × 72 × period).
    const skyBound = 1.5 / (SKY_SWIRL_FADE * 72 * SKY_SWIRL_PERIOD);
    const flameBound = 1.5 / (CYPRESS_FLAME_FADE * 72 * CYPRESS_FLAME_PERIOD);
    record(
      `[cypress] largest 72 Hz size step: sky ${(sky * 100).toFixed(2)}% (bound ${(skyBound * 100).toFixed(2)}%), cypress ${(flame * 100).toFixed(2)}% (bound ${(flameBound * 100).toFixed(2)}%) of the full size`,
    );
    expect(sky).toBeLessThanOrEqual(skyBound + 1e-9);
    expect(flame).toBeLessThanOrEqual(flameBound + 1e-9);
    expect(sky).toBeGreaterThan(0.9 * skyBound);
    expect(flame).toBeGreaterThan(0.9 * flameBound);
  });
});

describe('sway at the painter eye (R-P4n)', () => {
  test('the tip sway grows from a sixth to nearly half a stroke angle', () => {
    const before = (h: number): number => 0.05 * h;
    let tipStroke = 0;
    let tipBefore = 0;
    let tipAfter = 0;
    let n = 0;
    for (const s of SAMPLE) {
      const h = (decodeFlame(s.alpha) as { height: number }).height;
      if (h < 0.9) continue;
      const d: Vec3 = [
        s.position[0] - PAINTER_EYE[0],
        s.position[1] - PAINTER_EYE[1],
        s.position[2] - PAINTER_EYE[2],
      ];
      const dist = Math.hypot(...d);
      const r: Vec3 = [d[0] / dist, d[1] / dist, d[2] / dist];
      const side = sideOf(s.normal);
      // The sway's share across the view ray, per metre of amplitude.
      const along = dot(side, r);
      const across = Math.hypot(
        side[0] - along * r[0],
        side[1] - along * r[1],
        side[2] - along * r[2],
      );
      tipStroke += s.size / dist;
      tipBefore += (before(h) * across) / dist;
      tipAfter += (flickerAmplitude(h) * across) / dist;
      n++;
    }
    const deg = (rad: number): string => ((rad * 180) / Math.PI).toFixed(2);
    record(
      `[cypress] top-tenth strokes (${n}): mean stroke ${deg(tipStroke / n)}°, sway amplitude across the view ${deg(tipBefore / n)}° before, ${deg(tipAfter / n)}° after; on a face-on vertical face at 10 m, ${deg(0.05 / 10)}° before, ${deg(CYPRESS_FLICKER_MAX / 10)}° after`,
    );
    expect(n).toBeGreaterThan(0);
    expect(tipAfter).toBeGreaterThan(2 * tipBefore);
  });
});

/**
 * The GPU probe (I3): tests/e2e/motion.spec.ts block-matches these trunk patches between pinned
 * times with every phase pinned, and holds the measured shift to this prediction: the mean canvas
 * shift, at CAPTURE_SIZE pixels (y down), of the cypress strokes that face the painter eye and sit
 * in the patch. The fixture is checked here and rewritten with P44_WRITE_PROBE=1.
 */
describe('GPU probe fixture (I3)', () => {
  /** Relative to the project root, where vitest runs. */
  const FIXTURE = 'tests/fixtures/cypress-probe.json';
  const SIZE = { width: 1280, height: 1014 };
  const PHASE = 0;
  const HALF = 16;
  /**
   * Canvas centres (u, v down) on the lower trunks, normalised height about 0.3 to 0.6: the main
   * trunk's projected axis (u 0.2), its flanks at v 0.6 and the lower mass (0.3, 0.9). The upper
   * trunk (v 0.375 and 0.26 on the axis) block-matched with sharpness under 2.2 on the GPU, dark
   * strokes from lobes that sway against each other, so it carries no patch.
   */
  const AXIS: readonly (readonly [number, number])[] = [
    [0.2, 0.8],
    [0.2, 0.64],
    [0.2, 0.51],
    [0.3, 0.9],
  ];
  const FLANKS: readonly (readonly [number, number])[] = [
    [0.15, 0.6],
    [0.25, 0.6],
  ];
  /**
   * The rise pair sits at f = 0.15 and 0.85 of the loop, past both fades and 0.7 of the arc apart,
   * and checks the climb (dy) on the axis patches. The 20 px climb, most of a stroke, reshuffles
   * which stroke shows on top, so its sideways reading is loose, and a flank patch half on the
   * still sky matches the sky. The sway pair sits a whole rise loop apart, at the same f, so the
   * rise cancels and the patch moves by the sway alone: it checks dx and dy everywhere.
   */
  const PAIRS = [
    { name: 'rise', times: [0.6, 3.4], checks: ['dy'], centres: AXIS },
    { name: 'sway', times: [0.6, 4.6], checks: ['dx', 'dy'], centres: [...AXIS, ...FLANKS] },
  ] as const;

  type Decode = (byte: number) => number;
  const pixel = (p: Vec3): [number, number] | null => {
    const { uv } = projectToCanvas(p);
    return uv ? [uv[0] * SIZE.width, (1 - uv[1]) * SIZE.height] : null;
  };
  const FACING = ALL.filter(
    (s) =>
      dot(s.normal, [
        PAINTER_EYE[0] - s.position[0],
        PAINTER_EYE[1] - s.position[1],
        PAINTER_EYE[2] - s.position[2],
      ]) > 0,
  );

  /** The mean shift of a patch's facing strokes, with the alpha byte passed through `decode`. */
  function predict(
    cx: number,
    cy: number,
    times: readonly [number, number],
    decode: Decode,
  ): { dx: number; dy: number; n: number } {
    let dx = 0;
    let dy = 0;
    let n = 0;
    for (const s of FACING) {
      const rest = pixel(s.position);
      if (!rest || Math.abs(rest[0] - cx) > HALF || Math.abs(rest[1] - cy) > HALF) continue;
      const at = (t: number): [number, number] | null => {
        const m = cypressFlame(s.position, s.normal, PHASE, decode(s.alpha), t);
        return pixel([
          s.position[0] + m.offset[0],
          s.position[1] + m.offset[1],
          s.position[2] + m.offset[2],
        ]);
      };
      const a = at(times[0]);
      const b = at(times[1]);
      if (!a || !b) continue;
      dx += b[0] - a[0];
      dy += b[1] - a[1];
      n++;
    }
    return { dx: dx / n, dy: dy / n, n };
  }

  const round = (v: number): number => Math.round(v * 100) / 100;

  test('the probe predicts the trunk rising and swaying, and a wrong decode predicts otherwise', () => {
    const pairs = PAIRS.map(({ name, times, checks, centres }) => ({
      name,
      times,
      checks,
      patches: centres.map(([u, v]) => {
        const cx = Math.round(u * SIZE.width);
        const cy = Math.round(v * SIZE.height);
        const p = predict(cx, cy, times, (b) => b);
        return { u, v, cx, cy, dx: round(p.dx), dy: round(p.dy), strokes: p.n };
      }),
    }));
    const fixture = { phase: PHASE, half: HALF, tolerance: PROBE_TOLERANCE, pairs };
    if (process.env.P44_WRITE_PROBE)
      writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(fixture);
    for (const pair of pairs) {
      for (const p of pair.patches) {
        record(
          `[cypress] probe ${pair.name} (${p.u}, ${p.v}): dx ${p.dx}, dy ${p.dy} px over ${p.strokes} strokes`,
        );
        expect(p.strokes).toBeGreaterThan(20);
        // y down: the climb moves the trunk up the canvas, and a sway pair barely moves it in y.
        if (pair.name === 'rise') expect(p.dy).toBeLessThan(-12);
        else expect(Math.abs(p.dy)).toBeLessThan(2);
      }
    }
    // A rise sign slip reverses every rise dy, well past the e2e tolerance. Each wrong decode of
    // the alpha byte moves at least one patch past it too: the alpha read as 0-1 rather than
    // 0-255, the lobe and height fields swapped, and the lobe dropped.
    const tolerance = (v: number): number =>
      PROBE_TOLERANCE.px + PROBE_TOLERANCE.share * Math.abs(v);
    type Shift = { dx: number; dy: number };
    const misses = (checks: readonly ('dx' | 'dy')[], p: Shift, q: Shift): boolean =>
      checks.some((k) => Math.abs(q[k] - p[k]) > tolerance(p[k]));
    const wrong: Record<string, Decode> = {
      flat: (b) => (b === CYPRESS_FLAME_NONE ? b : 1),
      swapped: (b) => (b === CYPRESS_FLAME_NONE ? b : ((b & 7) << 5) | Math.min(30, b >> 3)),
      lobeless: (b) => (b === CYPRESS_FLAME_NONE ? b : b & 31),
    };
    for (const pair of pairs) {
      for (const p of pair.patches) {
        if (pair.name === 'rise')
          expect(misses(pair.checks, p, { dx: p.dx, dy: -p.dy })).toBe(true);
      }
    }
    for (const [name, decode] of Object.entries(wrong)) {
      const missed = pairs.some((pair) =>
        pair.patches.some((p) => misses(pair.checks, p, predict(p.cx, p.cy, pair.times, decode))),
      );
      expect(missed, name).toBe(true);
    }
  });
});
