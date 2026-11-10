/**
 * The `wheelflow` and `wheelrun` sky wraps on the seed-1 Starry Night world, from a real `build()`
 * (rasters decoded with sharp, as in stroke-reach-world.test.ts): the travel bound on the real sky
 * strokes at the sizes the bands draw them, the still ring the bound leaves round each disc, the
 * travel in the gap between the central wheels, and wheelrun's reset phase. The bound holds the
 * moved centre of a dome stroke outside every members' edge, so its paint overlaps a disc by at most
 * its own half extent, as resting paint just outside the edge does (the controller's ruling of
 * 2026-11-10); the haze keeps its whole drawn extent clear, as its rest thin does.
 */
import { PerspectiveCamera, Scene } from 'three';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decode } from '../scripts/scatter-time.ts';
import { skyWrapStats } from '../src/diag/sky-wrap-stats.ts';
import {
  SKY_SWIRL_PERIOD,
  SKY_WHEELS,
  skySwirl,
  skyVelocity,
  skyWavePhase,
  skyWheelAt,
  skyWheelEdge,
  skyWheelFlowTravel,
  skyWheelRunGain,
} from '../src/motion/sky-swirl.ts';
import { PAINTER_EYE } from '../src/paintings/starry-night/canvas-camera.ts';
import * as starryNight from '../src/paintings/starry-night/index.ts';
import type { WorldHandle } from '../src/paintings/world-module.ts';
import { STROKE_LAYER } from '../src/render/strokes/instance.ts';
import { HAZE_GROWTH } from '../src/render/strokes/material.ts';
import { SKY_LIGHT_CULL_FLAG } from '../src/render/strokes/sky-light-cull.ts';

type Vec3 = [number, number, number];

const deg = Math.PI / 180;
const FAR = 1.6;
/** The far band's size at the default fixed level 5 (far density 0.2 from 0.4). */
const LEVEL_5 = FAR * Math.sqrt(0.4 / 0.2);
/** The largest: far at its 0.1 floor, under the `vtx` arm `sparse` (1 / sqrt 0.7). */
const LARGEST = FAR * Math.sqrt(0.4 / 0.1) * (1 / Math.sqrt(0.7));
/** Max beauty's far size. */
const BEAUTY = 1.12;

interface SkyStroke {
  readonly position: Vec3;
  readonly dir: Vec3;
  readonly distance: number;
  /** Half diagonal at band size 1, metres. */
  readonly half: number;
  readonly haze: boolean;
  readonly phase: number;
}

let handle: WorldHandle;
const strokes: SkyStroke[] = [];

beforeAll(async () => {
  handle = await starryNight.build({
    scene: new Scene(),
    seed: null,
    loadRaster: (url) => decode(url.slice(url.lastIndexOf('/') + 1)),
  });
  for (const chunk of handle.batch.chunks) {
    const meta = chunk.geometry.getAttribute('iMeta').array;
    const position = chunk.geometry.getAttribute('iPosition').array;
    const size = chunk.geometry.getAttribute('iSize').array;
    for (let i = 0; i < chunk.count; i++) {
      if (meta[i * 4 + 1] !== STROKE_LAYER.sky) continue;
      const p: Vec3 = [position[3 * i], position[3 * i + 1], position[3 * i + 2]];
      const d: Vec3 = [p[0] - PAINTER_EYE[0], p[1] - PAINTER_EYE[1], p[2] - PAINTER_EYE[2]];
      const distance = Math.hypot(...d);
      strokes.push({
        position: p,
        dir: [d[0] / distance, d[1] / distance, d[2] / distance],
        distance,
        half: 0.5 * Math.hypot(size[2 * i], size[2 * i + 1]),
        haze: (meta[i * 4 + 3] & SKY_LIGHT_CULL_FLAG) !== 0,
        phase: meta[i * 4 + 2] / 256,
      });
    }
  }
}, 120_000);

afterAll(() => starryNight.dispose());

/** A stroke's angular half extent at band size `m`, the haze at its full flight growth. */
const halfAngle = (s: SkyStroke, m: number): number =>
  (s.half * m * (s.haze ? 1 + HAZE_GROWTH : 1)) / s.distance;

/**
 * The angular extent the travel keeps clear on top of the moved centre (stroke.vert.glsl
 * flowExtent): the haze's drawn half extent, 0 for a dome stroke.
 */
const flowAngle = (s: SkyStroke, m: number): number => (s.haze ? halfAngle(s, m) : 0);

/** The angle, radians, of each wheel's members' edge past which direction `dir` lies. */
const pastEdges = (dir: Vec3): number[] =>
  SKY_WHEELS.map(
    (w) =>
      Math.acos(Math.min(1, w.axis[0] * dir[0] + w.axis[1] * dir[1] + w.axis[2] * dir[2])) -
      skyWheelEdge(w),
  );

/** The sky strokes outside every wheel within `within` radians of some wheel's members' edge. */
const nearWheels = (within: number): SkyStroke[] =>
  strokes.filter((s) => skyWheelAt(s.dir) < 0 && pastEdges(s.dir).some((e) => e < within));

describe('wheelflow and wheelrun on the seed-1 sky', () => {
  test('the bound: no moved dome centre crosses a members edge, so moved paint overlaps a disc by at most its own half extent; no moved haze quad reaches one, at any band size', () => {
    const near = nearWheels(10 * deg);
    expect(near.length).toBeGreaterThan(2000);
    let moved = 0;
    let closestCentre = Number.POSITIVE_INFINITY;
    let closestHaze = Number.POSITIVE_INFINITY;
    let overlap = 0;
    let overlapShare = 0;
    for (const m of [BEAUTY, FAR, LEVEL_5, LARGEST]) {
      for (const wrap of ['wheelflow', 'wheelrun'] as const) {
        for (const s of near) {
          const h = halfAngle(s, m);
          const k = flowAngle(s, m);
          const rest = pastEdges(s.dir);
          const normal: Vec3 = [-s.dir[0], -s.dir[1], -s.dir[2]];
          for (let t = 0; t < 9; t++) {
            const time = (t / 8) * SKY_SWIRL_PERIOD + 0.031;
            const motion = skySwirl(s.position, normal, s.phase, time, undefined, wrap, undefined, {
              halfDiagonal: k * s.distance,
            });
            const p: Vec3 = [
              s.position[0] + motion.offset[0] - PAINTER_EYE[0],
              s.position[1] + motion.offset[1] - PAINTER_EYE[1],
              s.position[2] + motion.offset[2] - PAINTER_EYE[2],
            ];
            const l = Math.hypot(...p);
            const now = pastEdges([p[0] / l, p[1] / l, p[2] / l]);
            if (Math.hypot(...motion.offset) > 1e-6) moved++;
            now.forEach((e, j) => {
              // The centre, widened by the kept extent, never comes nearer an edge it was clear of.
              expect(e - k).toBeGreaterThanOrEqual(Math.min(rest[j] - k, 0) - 1e-9);
              if (rest[j] - k < 0) return;
              if (s.haze) {
                closestHaze = Math.min(closestHaze, e - h);
                return;
              }
              closestCentre = Math.min(closestCentre, e);
              // The moved quad's overlap past the edge is at most the stroke's own half extent.
              const over = Math.max(0, h - e);
              expect(over).toBeLessThanOrEqual(h + 1e-12);
              overlap = Math.max(overlap, over);
              if (h > 0) overlapShare = Math.max(overlapShare, over / h);
            });
          }
        }
      }
    }
    console.log(
      `bound: ${near.length} strokes within 10° of a disc, ${moved} moved samples, closest moved dome centre ${(closestCentre / deg).toFixed(4)}° clear of an edge, largest dome quad overlap ${(overlap / deg).toFixed(3)}° (${(100 * overlapShare).toFixed(1)}% of its half extent), closest moved haze quad ${(closestHaze / deg).toFixed(4)}° clear`,
    );
    expect(moved).toBeGreaterThan(10000);
    expect(closestCentre).toBeGreaterThanOrEqual(0);
    expect(closestHaze).toBeGreaterThanOrEqual(0);
    expect(overlapShare).toBeLessThanOrEqual(1);
  });

  test('the still ring: how far past each disc the dome strokes travel under half their arc, at every band size', () => {
    const lines: string[] = [];
    for (const [label, m] of [
      ['beauty 1.12', BEAUTY],
      ['full 1.6', FAR],
      ['level 5 2.26', LEVEL_5],
      ['largest 3.82', LARGEST],
    ] as const) {
      SKY_WHEELS.forEach((_w, i) => {
        // Per 0.25° bin past this wheel's members' edge, among dome strokes whose nearest edge it
        // is, the mean travel.
        const bins = new Array(48).fill(0).map(() => ({ sum: 0, n: 0 }));
        for (const s of strokes) {
          if (s.haze || skyWheelAt(s.dir) >= 0) continue;
          const edges = pastEdges(s.dir);
          const nearest = edges.indexOf(Math.min(...edges));
          if (nearest !== i || edges[i] >= 12 * deg) continue;
          const travel = skyWheelFlowTravel(s.dir, skyVelocity(s.dir), flowAngle(s, m));
          const bin = bins[Math.floor(edges[i] / (0.25 * deg))];
          bin.sum += travel;
          bin.n++;
        }
        const half = bins.findIndex((b) => b.n > 0 && b.sum / b.n >= 0.5);
        const ring = half < 0 ? Number.NaN : half * 0.25;
        lines.push(
          `${label}: wheel ${i} still ring ${ring.toFixed(2)}° (mean travel first >= 0.5)`,
        );
        expect(ring).toBeLessThan(8);
      });
    }
    console.log(lines.join('\n'));
  });

  test('the central gap: how far strokes between the two central wheels move, and how far their moved quads reach over either central disc, at level-5 size, with no gap fade', () => {
    const [left, right] = SKY_WHEELS;
    const normal = cross(left.axis, right.axis);
    const nl = Math.hypot(...normal);
    const n: Vec3 = [normal[0] / nl, normal[1] / nl, normal[2] / nl];
    const fromA = cross(n, left.axis);
    const fromB = cross(right.axis, n);
    const gap = Math.acos(dot(left.axis, right.axis)) - skyWheelEdge(left) - skyWheelEdge(right);
    // The old wheelflow gap fade's capsule (half the gap either side of the line between the
    // axes), and its core strip (0.5° either side), where the two fields cancel and the flow's
    // direction across the line flips twice. For each, the largest move and, over a loop, the
    // largest reach of a moved quad past either central members' edge, against the most the same
    // strokes reach past it at rest.
    const measure = (
      width: number,
    ): { count: number; travel: number; reach: number; over: number; restOver: number } => {
      let count = 0;
      let travel = 0;
      let reach = 0;
      let over = 0;
      let restOver = 0;
      for (const s of strokes) {
        if (skyWheelAt(s.dir) >= 0) continue;
        if (dot(fromA, s.dir) <= 0 || dot(fromB, s.dir) <= 0) continue;
        if (Math.abs(dot(n, s.dir)) > Math.sin(width)) continue;
        count++;
        const v = skyVelocity(s.dir);
        const t = skyWheelFlowTravel(s.dir, v, flowAngle(s, LEVEL_5));
        travel = Math.max(travel, t);
        reach = Math.max(reach, t * 0.5 * SKY_SWIRL_PERIOD * Math.hypot(...v));
        const h = halfAngle(s, LEVEL_5);
        const rest = pastEdges(s.dir);
        restOver = Math.max(restOver, h - rest[0], h - rest[1]);
        const normalAt: Vec3 = [-s.dir[0], -s.dir[1], -s.dir[2]];
        for (let k = 0; k < 16; k++) {
          const time = (k / 16) * SKY_SWIRL_PERIOD + 0.031;
          const motion = skySwirl(
            s.position,
            normalAt,
            s.phase,
            time,
            undefined,
            'wheelflow',
            undefined,
            {
              halfDiagonal: flowAngle(s, LEVEL_5) * s.distance,
            },
          );
          const p: Vec3 = [
            s.position[0] + motion.offset[0] - PAINTER_EYE[0],
            s.position[1] + motion.offset[1] - PAINTER_EYE[1],
            s.position[2] + motion.offset[2] - PAINTER_EYE[2],
          ];
          const l = Math.hypot(...p);
          const now = pastEdges([p[0] / l, p[1] / l, p[2] / l]);
          expect(Math.min(now[0], now[1])).toBeGreaterThanOrEqual(-1e-9);
          over = Math.max(over, h - now[0], h - now[1]);
        }
      }
      return { count, travel, reach, over, restOver };
    };
    const capsule = measure(0.5 * gap);
    const strip = measure(0.5 * deg);
    const text = (m: ReturnType<typeof measure>): string =>
      `${m.count} strokes, largest travel ${m.travel.toFixed(3)}, move ${(m.reach / deg).toFixed(4)}°, moved quad over a central disc ${(m.over / deg).toFixed(3)}° (at rest ${(m.restOver / deg).toFixed(3)}°)`;
    console.log(
      `central gap ${(gap / deg).toFixed(2)}° at level 5: capsule ${text(capsule)}; core strip ${text(strip)}`,
    );
    expect(strip.count).toBeGreaterThan(5);
    expect(strip.reach).toBeLessThan(0.5 * deg);
    expect(capsule.reach).toBeLessThan(1.5 * deg);
  });

  test('the wrap diag: wheelflow returning share and counter-flow over a loop, against wave (the e2e bars)', () => {
    let lo = 1;
    let hi = 0;
    let counter = 0;
    let waveCounter = 0;
    // The painter view, as the e2e boots it (`?painter`), so the drawn strokes are the ones it reads.
    const pc = starryNight.painterCamera();
    const camera = new PerspectiveCamera(pc.fovYDeg, pc.aspect, 0.1, 1000);
    camera.position.set(...pc.eye);
    camera.rotation.set(pc.pitch, pc.yaw, 0, 'YXZ');
    camera.updateMatrixWorld(true);
    handle.batch.update(camera);
    for (let k = 0; k < 16; k++) {
      const time = 0.2 + (k / 16) * SKY_SWIRL_PERIOD;
      const flow = skyWrapStats(handle.batch, 'wheelflow', time, null, 2);
      const wave = skyWrapStats(handle.batch, 'wave', time, null, 2);
      expect(flow.small).toBe(0);
      expect(flow.streaming).toBe(0);
      expect(flow.wheeled).toBeGreaterThan(0);
      // The shares leave out the wheel members, which turn rigidly and have no arc.
      expect(flow.returning).toBeLessThanOrEqual(flow.drawn - flow.wheeled);
      expect(flow.returningShare).toBeCloseTo(flow.returning / (flow.drawn - flow.wheeled), 12);
      expect(flow.forwardShare + flow.returningShare).toBeCloseTo(1, 12);
      lo = Math.min(lo, flow.returningShare);
      hi = Math.max(hi, flow.returningShare);
      counter = Math.max(counter, flow.counterFlow.share);
      waveCounter = Math.max(waveCounter, wave.counterFlow.share);
    }
    console.log(
      `wrap diag over a loop: wheelflow returning share ${lo.toFixed(3)}-${hi.toFixed(3)}, counter-flow up to ${counter.toFixed(3)} (wave up to ${waveCounter.toFixed(3)})`,
    );
    // The bars tests/e2e/ab.spec.ts holds wheelflow's live diag to.
    expect(lo).toBeGreaterThan(0.3);
    expect(hi).toBeLessThan(0.7);
    expect(counter).toBeLessThan(0.1);
  });

  test('wheelrun reset phase: the phase byte spreads the shrink, the wave phase empties whole patches', () => {
    // Dome strokes outside the wheels, binned into about 1.5° patches by direction.
    const patch = 1.5 * deg;
    const groups = new Map<string, { phase: number; wave: number; travel: number }[]>();
    for (const s of strokes) {
      if (s.haze || skyWheelAt(s.dir) >= 0) continue;
      const travel = skyWheelFlowTravel(s.dir, skyVelocity(s.dir), flowAngle(s, LEVEL_5));
      if (travel <= 0) continue;
      const key = s.dir.map((x) => Math.floor(x / patch)).join(',');
      const list = groups.get(key) ?? [];
      list.push({ phase: s.phase, wave: skyWavePhase(s.dir), travel });
      groups.set(key, list);
    }
    const patches = [...groups.values()].filter((g) => g.length >= 12);
    expect(patches.length).toBeGreaterThan(500);
    const worst = (pick: (x: { phase: number; wave: number }) => number): number => {
      let w = 0;
      for (let k = 0; k < 80; k++) {
        const time = (k / 80) * SKY_SWIRL_PERIOD;
        for (const g of patches) {
          let shrunk = 0;
          for (const x of g) {
            const f = time / SKY_SWIRL_PERIOD + pick(x);
            if (1 + skyWheelRunGain(f - Math.floor(f), x.travel, 1) < 0.5) shrunk++;
          }
          w = Math.max(w, shrunk / g.length);
        }
      }
      return w;
    };
    const byte = worst((x) => x.phase);
    const wave = worst((x) => x.wave + (x.phase - 0.5) / 32);
    console.log(
      `wheelrun worst ${(patch / deg).toFixed(1)}° patch shrunk under half size: phase byte ${(100 * byte).toFixed(1)}%, wave phase ${(100 * wave).toFixed(1)}% (${patches.length} patches)`,
    );
    expect(byte).toBeLessThan(wave);
  });
});

function dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
