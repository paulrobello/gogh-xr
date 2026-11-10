/**
 * The stroke reach field on the seed-1 Starry Night world, from a real `build()` (rasters decoded
 * with sharp, as in world-handle.test.ts): where it reads paint for the hand orbs and the rustle,
 * and what it costs.
 */
import { Scene, Vector4 } from 'three';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decode } from '../scripts/scatter-time.ts';
import { createRustleTrigger, nearStrokes, RUSTLE_SPEED } from '../src/audio/rustle.ts';
import {
  type Disturber,
  HAND_HALF_SIZE_CAP,
  HAND_RADIUS,
  reactiveMotion,
} from '../src/motion/reactive.ts';
import * as starryNight from '../src/paintings/starry-night/index.ts';
import type { WorldHandle } from '../src/paintings/world-module.ts';
import { createHandOrbs } from '../src/render/hand-orbs.ts';
import { type Vec3 as FrameVec3, strokeAxes } from '../src/render/strokes/frame.ts';
import { octDecode } from '../src/render/strokes/instance.ts';
import {
  buildStrokeReachSteps,
  chunkSources,
  REACH_STEP_UNITS,
  type StrokeReach,
} from '../src/render/strokes/reach-field.ts';
import { createCypress } from '../src/world/cypress.ts';
import { createTerrain } from '../src/world/terrain.ts';
import { createVillage, type HouseRecord } from '../src/world/village.ts';

type Vec3 = [number, number, number];

let handle: WorldHandle;
let field: StrokeReach;
const terrain = createTerrain(1);
const cypress = createCypress(1, terrain);
const village = createVillage(1, terrain);

beforeAll(async () => {
  handle = await starryNight.build({
    scene: new Scene(),
    seed: null,
    loadRaster: (url) => decode(url.slice(url.lastIndexOf('/') + 1)),
  });
  if (!handle.strokeReach) throw new Error('the Starry Night handle has no stroke reach field');
  field = handle.strokeReach;
}, 120_000);

afterAll(() => starryNight.dispose());

/** Every cypress hull vertex and its outward normal, both masses. */
function cypressVertices(): { p: Vec3; n: Vec3 }[] {
  const pos = cypress.geometry.getAttribute('position');
  const nor = cypress.geometry.getAttribute('normal');
  const out: { p: Vec3; n: Vec3 }[] = [];
  for (const mass of [cypress.main, cypress.lower]) {
    for (let i = mass.firstVertex; i < mass.firstVertex + mass.vertexCount; i++) {
      out.push({
        p: [pos.getX(i), pos.getY(i), pos.getZ(i)],
        n: [nor.getX(i), nor.getY(i), nor.getZ(i)],
      });
    }
  }
  return out;
}

const along = ({ p, n }: { p: Vec3; n: Vec3 }, k: number): Vec3 => [
  p[0] + n[0] * k,
  p[1] + n[1] * k,
  p[2] + n[2] * k,
];

/** The midpoint of each of a house's four walls, at half the eave height, `out` metres off it. */
function wallPoints(h: HouseRecord, out: number): Vec3[] {
  const c = Math.cos(h.yaw);
  const s = Math.sin(h.yaw);
  const sides: [number, number][] = [
    [0, h.depth / 2],
    [0, -h.depth / 2],
    [h.width / 2, 0],
    [-h.width / 2, 0],
  ];
  return sides.map(([lx, lz]) => {
    const len = Math.hypot(lx, lz);
    const px = lx + (lx / len) * out;
    const pz = lz + (lz / len) * out;
    return [
      h.center[0] + px * c + pz * s,
      h.center[1] + h.eaveHeight / 2,
      h.center[2] - px * s + pz * c,
    ];
  });
}

/** Open meadow round the painter's spot, clear of the village and the cypress. */
const MEADOW: readonly [number, number][] = [
  [0, 0],
  [4, 3],
  [-5, 4],
  [6, -4],
  [-2, 7],
];

describe('the seed-1 stroke reach field', () => {
  test('holds every stroke but the dome and its moon and stars, in a few MB', () => {
    let reachable = 0;
    for (const chunk of handle.batch.chunks) {
      if (chunk.drawClass !== 'dome' && chunk.drawClass !== 'lights') reachable += chunk.count;
    }
    const { stats } = field;
    console.log(`[reach] field ${JSON.stringify(stats)}`);
    expect(stats.strokes).toBe(reachable);
    expect(stats.strokes).toBeGreaterThan(300_000);
    expect(stats.bytes).toBeLessThan(3_000_000);
  });

  test('builds in slicer steps of at most REACH_STEP_UNITS visits each', () => {
    const sources = chunkSources(
      handle.batch.chunks.filter((c) => c.drawClass !== 'dome' && c.drawClass !== 'lights'),
    );
    const units: number[] = [];
    const steps = buildStrokeReachSteps(sources, { onYield: (u) => units.push(u) });
    const times: number[] = [];
    const start = performance.now();
    for (;;) {
      const t = performance.now();
      const next = steps.next();
      times.push(performance.now() - t);
      if (next.done) {
        expect(next.value.stats).toEqual(field.stats);
        break;
      }
    }
    const total = performance.now() - start;
    const sorted = [...times].sort((a, b) => a - b);
    const longest = sorted[sorted.length - 1] as number;
    const p99 = sorted[Math.floor(0.99 * (sorted.length - 1))] as number;
    console.log(
      `[reach] build ${total.toFixed(1)} ms in ${times.length} steps, longest ${longest.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, ${units.reduce((a, b) => a + b, 0)} visits`,
    );
    // Every step but the last ends at a yield, and no yield follows more than the budget.
    expect(units).toHaveLength(times.length - 1);
    expect(Math.max(...units)).toBeLessThanOrEqual(REACH_STEP_UNITS);
    // Every pass counts into the budget: the tier pass, one scan per tier, at least one radix
    // pass (count and scatter) and the run pass over each tier's entries.
    const strokes = sources.reduce((sum, s) => sum + s.count, 0);
    const tiers = field.stats.tiers.length;
    expect(units.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(
      strokes * (1 + tiers) + 3 * field.stats.strokes - REACH_STEP_UNITS,
    );
  });

  test('reads paint 2 cm over the ground across the walkable world, and what a query costs', () => {
    // A 110 x 110 grid over +-40 m round the painter, 0.73 m apart.
    const n = 110;
    let misses = 0;
    let nearestMiss = Infinity;
    for (let a = 0; a < n; a += 1) {
      for (let b = 0; b < n; b += 1) {
        const x = -40 + (80 * a) / (n - 1);
        const z = -40 + (80 * b) / (n - 1);
        if (field.distance(x, terrain.heightAt(x, z) + 0.02, z) === Infinity) {
          misses += 1;
          nearestMiss = Math.min(nearestMiss, Math.hypot(x, z));
        }
      }
    }
    let visited = 0;
    let maxVisited = 0;
    let queries = 0;
    const start = performance.now();
    for (const h of [0.02, 0.1, 0.5, 1.5]) {
      for (let a = 0; a < n; a += 1) {
        for (let b = 0; b < n; b += 1) {
          const x = -40 + (80 * a) / (n - 1);
          const z = -40 + (80 * b) / (n - 1);
          field.distance(x, terrain.heightAt(x, z) + h, z);
          visited += field.lastVisited;
          maxVisited = Math.max(maxVisited, field.lastVisited);
          queries += 1;
        }
      }
    }
    const us = ((performance.now() - start) * 1000) / queries;
    console.log(
      `[reach] ground sweep 2 cm up: ${misses} of ${n * n} miss, the nearest ${nearestMiss.toFixed(1)} m from the painter; ${queries} queries at 4 heights, ${us.toFixed(2)} us each (terrain height included), ${(visited / queries).toFixed(0)} strokes tested on average, ${maxVisited} at most`,
    );
    // Misses lie far out, where ground strokes grow past the 0.4 m capped half-size and the
    // shader cannot push them either.
    expect(misses / (n * n)).toBeLessThan(0.01);
    expect(nearestMiss).toBeGreaterThan(30);
  });

  test('reads paint beside the cypress and a house wall, and none 1.5 m over the meadow', () => {
    const vertices = cypressVertices();
    expect(vertices).toHaveLength(cypress.main.vertexCount + cypress.lower.vertexCount);
    let visited = 0;
    let maxVisited = 0;
    const start = performance.now();
    for (const v of vertices) {
      expect(field.distance(...v.p)).toBeLessThan(HAND_RADIUS);
      expect(field.distance(...along(v, 0.05))).toBeLessThan(HAND_RADIUS);
      visited += field.lastVisited;
      maxVisited = Math.max(maxVisited, field.lastVisited);
    }
    const us = ((performance.now() - start) * 1000) / (2 * vertices.length);
    console.log(
      `[reach] cypress queries: ${us.toFixed(2)} us each, ${(visited / vertices.length).toFixed(0)} strokes tested on average, ${maxVisited} at most`,
    );
    for (const house of village.houses.slice(0, 6)) {
      for (const p of wallPoints(house, 0.05))
        expect(field.distance(...p)).toBeLessThan(HAND_RADIUS);
      for (const p of wallPoints(house, 0.3)) expect(field.distance(...p)).toBe(Infinity);
    }
    for (const [x, z] of MEADOW) {
      const y = terrain.heightAt(x, z);
      expect(field.distance(x, y + 0.05, z)).toBeLessThan(HAND_RADIUS);
      expect(field.distance(x, y + 0.3, z)).toBe(Infinity);
      expect(field.distance(x, y + 1.5, z)).toBe(Infinity);
    }
  });

  test('an orb is bright beside the cypress and a house wall, at rest 1.5 m over the meadow', () => {
    // Left hand parked far above the world (no paint), right hand at the point under test.
    const disturbers = [new Vector4(0, 1.6, 0, 0.4), new Vector4(0, 200, 0, 1), new Vector4()];
    const boostAt = (p: Vec3): [number, number | null] => {
      const orbs = createHandOrbs(new Scene());
      disturbers[2]?.set(p[0], p[1], p[2], 1);
      for (let i = 0; i < 36; i += 1) {
        orbs.frame({
          enabled: true,
          presenting: true,
          disturbers,
          slots: [1, 2],
          strokeReach: field,
          reactive: true,
          calm: 1,
          dt: 1 / 72,
        });
      }
      const d = orbs.diag();
      expect(d.reach[0]).toBeNull();
      expect(d.boost[0]).toBe(0);
      return [d.boost[1], d.reach[1]];
    };
    const vertex = cypressVertices()[200] as { p: Vec3; n: Vec3 };
    const [cypressBoost, cypressReach] = boostAt(along(vertex, 0.05));
    const [wallBoost, wallReach] = boostAt(
      wallPoints(village.houses[0] as HouseRecord, 0.05)[0] as Vec3,
    );
    const [x, z] = MEADOW[1] as [number, number];
    const [meadowBoost, meadowReach] = boostAt([x, terrain.heightAt(x, z) + 1.5, z]);
    console.log(
      `[reach] orb boost: cypress ${cypressBoost.toFixed(3)} at ${cypressReach}, wall ${wallBoost.toFixed(3)} at ${wallReach}, meadow ${meadowBoost} at ${meadowReach}`,
    );
    // Within 0.05 m of paint the target is at least 1 - (0.05 / 0.13)^2 = 0.85, and 0.5 s of easing
    // reaches 96% of it. Measured on seed 1: 0.909 at the cypress, 0.872 at the wall.
    expect(cypressBoost).toBeGreaterThan(0.75);
    expect(wallBoost).toBeGreaterThan(0.75);
    expect(meadowReach).toBeNull();
    expect(meadowBoost).toBe(0);
  });

  test('the field reads paint in reach exactly where the shader mirror moves a stroke', () => {
    const sources = chunkSources(
      handle.batch.chunks.filter((c) => c.drawClass !== 'dome' && c.drawClass !== 'lights'),
    );
    const parked: Disturber = { position: [0, 1e4, 0], velocity: [0, 0, 0], strength: 0 };
    // Strokes whose centre lies past the reach plus the largest capped half-diagonal cannot move.
    const pre = HAND_RADIUS + Math.SQRT2 * HAND_HALF_SIZE_CAP;
    const movesAny = (h: Vec3): boolean => {
      const field2 = {
        disturbers: [parked, { position: h, velocity: [0, 0, 0] as Vec3, strength: 1 }, parked],
        wake: [],
      };
      for (const s of sources) {
        for (let i = 0; i < s.count; i += 1) {
          const c: Vec3 = [
            s.position[3 * i] as number,
            s.position[3 * i + 1] as number,
            s.position[3 * i + 2] as number,
          ];
          if (Math.hypot(c[0] - h[0], c[1] - h[1], c[2] - h[2]) > pre) continue;
          const raw = octDecode(
            Math.max(-1, (s.normal[2 * i] as number) / 32767),
            Math.max(-1, (s.normal[2 * i + 1] as number) / 32767),
          );
          const l = Math.hypot(...raw);
          const n: FrameVec3 = [raw[0] / l, raw[1] / l, raw[2] / l];
          const { long } = strokeAxes(n, ((s.tangent[i] as number) * 2 * Math.PI) / 65535);
          const m = reactiveMotion(c, n, field2, 1, {
            long,
            halfSize: [0.5 * (s.size[2 * i] as number), 0.5 * (s.size[2 * i + 1] as number)],
          });
          if (Math.hypot(...m.offset) > 1e-9 || m.gain > 1e-9) return true;
        }
      }
      return false;
    };
    const points: Vec3[] = [];
    const vertices = cypressVertices();
    for (let v = 0; v < vertices.length; v += 137) {
      for (const k of [0.02, 0.08, 0.2, 0.5])
        points.push(along(vertices[v] as (typeof vertices)[0], k));
    }
    for (const out of [0.05, 0.1, 0.3]) {
      points.push(...wallPoints(village.houses[0] as HouseRecord, out));
    }
    for (const [x, z] of MEADOW) {
      for (const up of [0.05, 0.1, 0.2, 1.5]) points.push([x, terrain.heightAt(x, z) + up, z]);
    }
    let inReach = 0;
    for (const h of points) {
      const reads = field.distance(...h) < HAND_RADIUS;
      if (reads) inReach += 1;
      expect({ h, moves: movesAny(h) }).toEqual({ h, moves: reads });
    }
    console.log(`[reach] mirror check: ${inReach} of ${points.length} points in reach, all agree`);
    // Both outcomes are exercised.
    expect(inReach).toBeGreaterThan(10);
    expect(points.length - inReach).toBeGreaterThan(10);
  });

  test('the rustle fires only within the paint reach: the ground, the cypress, a wall', () => {
    const near = nearStrokes(field);
    const fires = (p: Vec3): boolean => {
      const positions = [new Vector4(0, 1.6, 0, 0.4), new Vector4(...p, 1), new Vector4()];
      const velocities = [new Vector4(), new Vector4(RUSTLE_SPEED + 0.4, 0, 0, 0), new Vector4()];
      return createRustleTrigger().frame(positions, velocities, near).length === 1;
    };
    for (const [x, z] of MEADOW) {
      const y = terrain.heightAt(x, z);
      expect(fires([x, y + 0.1, z])).toBe(true);
      expect(fires([x, y + 0.2, z])).toBe(false);
      // 0.5 m over the grass was within the old 0.6 m rustle reach.
      expect(fires([x, y + 0.5, z])).toBe(false);
    }
    // At every cypress vertex (the old capsule check, now against the strokes themselves).
    const vertices = cypressVertices();
    expect(vertices.every((v) => fires(v.p))).toBe(true);
    // 0.5 m out from the hull the old capsules rustled; the paint reach does not, bar points that
    // land by the ground (the base rings) or in the hull's folds, by another lobe's paint.
    const out = vertices.map((v) => along(v, 0.5));
    const aloft = out.filter((p) => p[1] - terrain.heightAt(p[0], p[2]) > 0.5);
    const far = aloft.filter((p) => fires(p)).length;
    console.log(
      `[reach] cypress vertices still in reach 0.5 m out: ${out.filter((p) => fires(p)).length} of ${out.length}, ${far} of the ${aloft.length} 0.5 m or more over the ground`,
    );
    // Measured 59 of 1,246 on seed 1 (4.7%).
    expect(far / aloft.length).toBeLessThan(0.06);
    for (const p of wallPoints(village.houses[0] as HouseRecord, 0.05)) expect(fires(p)).toBe(true);
    for (const p of wallPoints(village.houses[0] as HouseRecord, 0.3)) expect(fires(p)).toBe(false);
  });
});
