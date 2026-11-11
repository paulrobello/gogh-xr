/**
 * The sky river (src/motion/sky-river.ts, Paul's drawn flow) on the seed-1 Starry Night sky, from a
 * real `build()` with the rasters decoded by sharp: every sky stroke (dome and haze) baked from its
 * direction and its own long axis as the GPU decodes it. Measures how well the river follows Paul's
 * seven polylines and how coherent its sign is, in the canvas view, in the band past the frame
 * edge and over the rest of the dome.
 */
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decode } from '../scripts/scatter-time.ts';
import { buildFlowField } from '../src/demo/canvas/field.ts';
import { buildDiagPayload } from '../src/diag/diag.ts';
import { type SkyWrapStats, skyWrapStats } from '../src/diag/sky-wrap-stats.ts';
import {
  buildSkyRiverField,
  SKY_RIVER_DRIFT_SHARE,
  SKY_RIVER_EDGE_BAND,
  SKY_RIVER_MAX_TURN,
  SKY_RIVER_PATHS,
  SKY_RIVER_SPEED,
  SKY_RIVER_WHEELS,
  type SkyRiverBake,
  type SkyRiverField,
  skyRiverBake,
  skyRiverTangent,
} from '../src/motion/sky-river.ts';
import {
  SKY_RIVER_FLOW_SCALE,
  SKY_SWIRL_PERIOD,
  SKY_WHEELS,
  skySwirl,
  skyWheelAt,
  skyWheelEdge,
  skyWheelFlowTravel,
} from '../src/motion/sky-swirl.ts';
import {
  CANVAS_ASPECT,
  PAINTER_EYE,
  projectToCanvas,
} from '../src/paintings/starry-night/canvas-camera.ts';
import * as starryNight from '../src/paintings/starry-night/index.ts';
import { strokeAxes } from '../src/render/strokes/frame.ts';
import { octDecode, STROKE_LAYER } from '../src/render/strokes/instance.ts';
import { HAZE_GROWTH } from '../src/render/strokes/material.ts';
import { SKY_LIGHT_CULL_FLAG } from '../src/render/strokes/sky-light-cull.ts';
import { createXrState } from '../src/xr/session.ts';
import { COVERAGE_POSES } from './world-poses.ts';

type Vec3 = [number, number, number];

const deg = Math.PI / 180;
const SNORM16 = 32767;
const TWO_PI_OVER_UNORM16 = (2 * Math.PI) / 65535;

interface RiverStroke {
  readonly position: Vec3;
  readonly distance: number;
  /** Half diagonal at band size 1, metres. */
  readonly half: number;
  readonly haze: boolean;
  /** The phase byte over 256. */
  readonly phase: number;
  /** The chunk's iRiver for this stroke: omega xyz and the forward-and-back phase. */
  readonly attribute: readonly [number, number, number, number];
  readonly dir: Vec3;
  readonly bake: SkyRiverBake;
  /** Velocity at unit distance, rad/s at calm 1: the kept wheel's turn for a member. */
  readonly velocity: Vec3;
  /** Speed over SKY_RIVER_SPEED. */
  readonly amplitude: number;
  /** The long axis as the GPU decodes it. */
  readonly axis: Vec3;
  /** Length and width at band size 1, metres. */
  readonly size: readonly [number, number];
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const fract = (x: number): number => x - Math.floor(x);
const smoothstepTs = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const strokes: RiverStroke[] = [];

/** The `world` diag the build registered, through the app's own payload, on a stub renderer. */
function getDiag(): Record<string, unknown> {
  return buildDiagPayload({
    build: 'test',
    renderer: {
      info: {
        render: { calls: 0, triangles: 0, points: 0, lines: 0, frame: 0 },
        memory: { geometries: 0, textures: 0 },
        programs: [],
      },
      getContext: () => ({ getExtension: () => null, getParameter: () => null }),
      xr: { isPresenting: false },
    },
    camera: { position: { toArray: () => [0, 0, 0] }, quaternion: { toArray: () => [0, 0, 0, 1] } },
    getXrState: createXrState,
  } as unknown as Parameters<typeof buildDiagPayload>[0]);
}
/** Per chunk: whether it holds a sky stroke, and whether it carries iRiver. */
const chunkRiver: { sky: boolean; river: boolean }[] = [];
let riverStats: unknown = null;
/** The `wrap` diag at the painter view's cull, at 8 times through the 8 s loop. */
const wrapStats: { wrap: string; time: number; stats: SkyWrapStats }[] = [];

let riverField: SkyRiverField;
/** flow.png's own brush axis, unsmoothed: the seam test's > 30° turn class. */
let rawField: SkyRiverField;

beforeAll(async () => {
  const flow = buildFlowField(await decode('flow.png'));
  const field = buildSkyRiverField(flow);
  riverField = field;
  rawField = buildSkyRiverField(flow, 0);
  const handle = await starryNight.build({
    scene: new Scene(),
    seed: null,
    loadRaster: (url) => decode(url.slice(url.lastIndexOf('/') + 1)),
  });
  const world = getDiag().world as { river?: unknown; times?: { riverMs?: number } } | undefined;
  riverStats = { ...(world?.river as object), riverMs: world?.times?.riverMs };
  for (const chunk of handle.batch.chunks) {
    const meta = chunk.geometry.getAttribute('iMeta').array;
    const position = chunk.geometry.getAttribute('iPosition').array;
    const normal = chunk.geometry.getAttribute('iNormal').array;
    const tangent = chunk.geometry.getAttribute('iTangent').array;
    const size = chunk.geometry.getAttribute('iSize').array;
    const iRiver = chunk.geometry.getAttribute('iRiver')?.array;
    let sky = false;
    for (let i = 0; i < chunk.count; i++) {
      if (meta[i * 4 + 1] !== STROKE_LAYER.sky) continue;
      sky = true;
      const d: Vec3 = [
        position[3 * i] - PAINTER_EYE[0],
        position[3 * i + 1] - PAINTER_EYE[1],
        position[3 * i + 2] - PAINTER_EYE[2],
      ];
      const l = Math.hypot(...d);
      const dir: Vec3 = [d[0] / l, d[1] / l, d[2] / l];
      const n = octDecode(
        Math.max(-1, normal[2 * i] / SNORM16),
        Math.max(-1, normal[2 * i + 1] / SNORM16),
      );
      const axis = strokeAxes(n, tangent[i] * TWO_PI_OVER_UNORM16).long as Vec3;
      const bake = skyRiverBake(field, dir, axis);
      let velocity: Vec3;
      if (bake.member >= 0) {
        const w = SKY_RIVER_WHEELS[bake.member];
        const r = 2 * Math.PI * w.rate;
        velocity = cross([w.axis[0] * r, w.axis[1] * r, w.axis[2] * r], dir);
      } else {
        velocity = cross([bake.omega[0], bake.omega[1], bake.omega[2]], dir);
      }
      strokes.push({
        position: [position[3 * i], position[3 * i + 1], position[3 * i + 2]],
        distance: l,
        half: 0.5 * Math.hypot(size[2 * i], size[2 * i + 1]),
        axis: [axis[0], axis[1], axis[2]],
        size: [size[2 * i], size[2 * i + 1]],
        haze: (meta[i * 4 + 3] & SKY_LIGHT_CULL_FLAG) !== 0,
        phase: meta[i * 4 + 2] / 256,
        attribute: iRiver
          ? [iRiver[4 * i], iRiver[4 * i + 1], iRiver[4 * i + 2], iRiver[4 * i + 3]]
          : [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
        dir,
        bake,
        velocity,
        amplitude: Math.hypot(...velocity) / SKY_RIVER_SPEED,
      });
    }
    chunkRiver.push({ sky, river: iRiver !== undefined });
  }
  // The painter view's cull, as the e2e A/B cycle draws it.
  const pc = starryNight.painterCamera();
  const camera = new PerspectiveCamera(pc.fovYDeg, pc.aspect, 0.1, 1000);
  camera.position.set(...pc.eye);
  camera.rotation.set(pc.pitch, pc.yaw, 0, 'YXZ');
  camera.updateMatrixWorld(true);
  handle.batch.update(camera);
  for (const wrap of ['wheelrun', 'wheelflow'] as const) {
    for (const time of [0.5, 1.5, 2.5, 3.7, 4.5, 5.5, 6.5, 7.5]) {
      wrapStats.push({ wrap, time, stats: skyWrapStats(handle.batch, wrap, time, null, 2) });
    }
  }
  starryNight.dispose();
}, 180_000);

afterAll(() => starryNight.dispose());

const uvOf = (d: Vec3): readonly [number, number] | null =>
  projectToCanvas([PAINTER_EYE[0] + d[0], PAINTER_EYE[1] + d[1], PAINTER_EYE[2] + d[2]]).uv;

/** Distance in uv from (u, v) to segment ab, and where along it (0 to 1) the nearest point is. */
function segment(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): { distance: number; t: number } {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const raw = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / (abx * abx + aby * aby);
  const t = Math.min(1, Math.max(0, raw));
  return { distance: Math.hypot(p[0] - a[0] - t * abx, p[1] - a[1] - t * aby), t: raw };
}

/** A stroke still enough to count as not moving: under 5% of the river's speed. */
const STILL = 0.05;

describe('the sky river on the seed-1 sky', { timeout: 180_000 }, () => {
  test('strokes near each of Paul polylines move within 45 degrees of its tangent', () => {
    expect(strokes.length).toBeGreaterThan(50_000);
    const lines: string[] = [];
    const ratios: { near: number; share: number }[] = [];
    SKY_RIVER_PATHS.forEach((path, k) => {
      // All strokes within 0.03 uv, and those whose nearest point is inside the polyline, not
      // past either end, where the end segment's tangent is not what Paul drew (an arrowhead, or
      // the corner between two of his strokes).
      const all = { near: 0, agree: 0, still: 0 };
      const inside = { near: 0, agree: 0, still: 0 };
      for (const s of strokes) {
        const uv = uvOf(s.dir);
        if (uv === null) continue;
        let best = Infinity;
        let seg = 0;
        let along = 0;
        for (let i = 1; i < path.uv.length; i++) {
          const near = segment(uv, path.uv[i - 1], path.uv[i]);
          if (near.distance < best) {
            best = near.distance;
            seg = i;
            along = near.t;
          }
        }
        if (best > 0.03) continue;
        const capped = (seg === 1 && along < 0) || (seg === path.uv.length - 1 && along > 1);
        const tallies = capped ? [all] : [all, inside];
        for (const t of tallies) t.near++;
        if (s.amplitude < STILL) {
          for (const t of tallies) t.still++;
          continue;
        }
        const e = 1e-3 / (s.amplitude * SKY_RIVER_SPEED);
        const q = uvOf([
          s.dir[0] + e * s.velocity[0],
          s.dir[1] + e * s.velocity[1],
          s.dir[2] + e * s.velocity[2],
        ]);
        if (q === null) continue;
        const mx = (q[0] - uv[0]) * CANVAS_ASPECT;
        const my = q[1] - uv[1];
        const a = path.uv[seg - 1];
        const b = path.uv[seg];
        const tx = (b[0] - a[0]) * CANVAS_ASPECT;
        const ty = b[1] - a[1];
        const cosine = (mx * tx + my * ty) / (Math.hypot(mx, my) * Math.hypot(tx, ty));
        if (cosine >= Math.cos(45 * deg)) for (const t of tallies) t.agree++;
      }
      lines.push(
        `path ${k + 1}: inside ${inside.agree}/${inside.near} = ${(inside.agree / inside.near).toFixed(3)} (still ${inside.still}); ` +
          `with the ends ${all.agree}/${all.near} = ${(all.agree / all.near).toFixed(3)} (still ${all.still})`,
      );
      ratios.push({ near: inside.near, share: inside.agree / inside.near });
    });
    console.log(
      `sky river direction agreement (still strokes count as failing):\n${lines.join('\n')}`,
    );
    for (const r of ratios) {
      expect(r.near).toBeGreaterThan(100);
      expect(r.share).toBeGreaterThanOrEqual(0.9);
    }
  });

  test('the sign is coherent: few neighbours within 1 degree move opposite ways, in the canvas view, the edge band and the rest of the dome', () => {
    const cell = 1 * deg;
    const key = (d: Vec3): string =>
      `${Math.floor(d[0] / cell)},${Math.floor(d[1] / cell)},${Math.floor(d[2] / cell)}`;
    // Half the region's full amplitude: 1 in the canvas, the drift's share past the edge.
    const full = (s: RiverStroke): number => (s.bake.frame < 0 ? 1 : SKY_RIVER_DRIFT_SHARE);
    const moving = strokes.filter((s) => s.amplitude > 0.5 * full(s));
    const grid = new Map<string, RiverStroke[]>();
    for (const s of moving) {
      const k = key(s.dir);
      const list = grid.get(k);
      if (list) list.push(s);
      else grid.set(k, [s]);
    }
    const cos1 = Math.cos(cell);
    const regions = {
      canvas: (s: RiverStroke) => s.bake.frame < 0,
      edge: (s: RiverStroke) => s.bake.frame >= 0 && s.bake.frame < SKY_RIVER_EDGE_BAND,
      dome: (s: RiverStroke) => s.bake.frame >= SKY_RIVER_EDGE_BAND,
    };
    const result: Record<
      string,
      { pairs: number; opposed: number; share: number; opposedAligned: number }
    > = {};
    const cos30 = Math.cos(30 * deg);
    for (const [name, inRegion] of Object.entries(regions)) {
      const centres = moving.filter(inRegion);
      const stride = Math.max(1, Math.floor(centres.length / 8000));
      let pairs = 0;
      let opposed = 0;
      // Opposed pairs whose own long axes (the velocity's line) lie within 30° of each other: a
      // reversal the field would make. The rest cross steeply, each stroke moving along its own axis.
      let opposedAligned = 0;
      for (let c = 0; c < centres.length; c += stride) {
        const s = centres[c];
        const fx = Math.floor(s.dir[0] / cell);
        const fy = Math.floor(s.dir[1] / cell);
        const fz = Math.floor(s.dir[2] / cell);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              for (const o of grid.get(`${fx + dx},${fy + dy},${fz + dz}`) ?? []) {
                if (o === s || dot(o.dir, s.dir) < cos1) continue;
                pairs++;
                const along = dot(o.velocity, s.velocity);
                if (along >= 0) continue;
                opposed++;
                if (-along > cos30 * Math.hypot(...o.velocity) * Math.hypot(...s.velocity)) {
                  opposedAligned++;
                }
              }
            }
          }
        }
      }
      result[name] = { pairs, opposed, share: opposed / pairs, opposedAligned };
    }
    console.log(`sky river sign coherence: ${JSON.stringify(result)}`);
    expect(result.canvas.pairs).toBeGreaterThan(10_000);
    expect(result.edge.pairs).toBeGreaterThan(1_000);
    expect(result.dome.pairs).toBeGreaterThan(10_000);
    // Measured 0.0036 (564 of the 862 with axes within 30°), 0 and 0 (fix round 2). The field has
    // no reversal (the seam test); in the canvas each stroke's sign comes from its own long axis
    // against the guide blend, so neighbours whose axes straddle square to the guide, and the S's
    // two lobes, which Paul drew turning opposite ways, still oppose. Past the edge nothing may.
    expect(result.canvas.share).toBeLessThan(0.02);
    expect(result.edge.share).toBeLessThan(0.005);
    expect(result.dome.share).toBeLessThan(0.005);
  });
});

const FAR = 1.6;
/** The far band's size at the default fixed level 5 (far density 0.2 from 0.4). */
const LEVEL_5 = FAR * Math.sqrt(0.4 / 0.2);
/** The largest: far at its 0.1 floor, under the `vtx` arm `sparse` (1 / sqrt 0.7). */
const LARGEST = FAR * Math.sqrt(0.4 / 0.1) * (1 / Math.sqrt(0.7));
/** Max beauty's far size. */
const BEAUTY = 1.12;

/** A stroke's angular half extent at band size `m`, the haze at its full flight growth. */
const halfAngle = (s: RiverStroke, m: number): number =>
  (s.half * m * (s.haze ? 1 + HAZE_GROWTH : 1)) / s.distance;

/** The angle, radians, past each kept wheel's members' edge at which `dir` lies. */
const pastKept = (dir: Vec3): number[] =>
  SKY_RIVER_WHEELS.map(
    (w) => Math.acos(Math.min(1, Math.max(-1, dot(w.axis as Vec3, dir)))) - skyWheelEdge(w),
  );

/** The river options skySwirl reads, from the chunk's own iRiver as the shader reads it. */
const riverOf = (s: RiverStroke) => ({
  omega: [s.attribute[0], s.attribute[1], s.attribute[2]] as Vec3,
  phase: s.attribute[3],
});

describe('the river on the GPU path (stage 2)', { timeout: 180_000 }, () => {
  test('every chunk holding a sky stroke carries iRiver, and it equals the CPU bake to float32', () => {
    console.log(`sky river instances: ${JSON.stringify(riverStats)}`);
    const withSky = chunkRiver.filter((c) => c.sky);
    expect(withSky.length).toBeGreaterThan(30);
    expect(withSky.every((c) => c.river)).toBe(true);
    expect(chunkRiver.filter((c) => !c.sky).every((c) => !c.river)).toBe(true);
    let worst = 0;
    let worstPhase = 0;
    let maxAmplitude = 0;
    let maxTurn = 0;
    for (const s of strokes) {
      for (let k = 0; k < 3; k++) {
        worst = Math.max(worst, Math.abs(s.attribute[k] - s.bake.omega[k]));
      }
      worstPhase = Math.max(worstPhase, Math.abs(s.attribute[3] - s.bake.packed));
      if (s.bake.member >= 0) {
        expect(s.attribute.slice(0, 3)).toEqual([0, 0, 0]);
        continue;
      }
      const v = cross(riverOf(s).omega, s.dir);
      maxAmplitude = Math.max(maxAmplitude, Math.hypot(...v) / SKY_RIVER_SPEED);
      maxTurn = Math.max(maxTurn, 0.5 * SKY_SWIRL_PERIOD * Math.abs(dot(riverOf(s).omega, s.dir)));
    }
    const outside = strokes.filter((s) => s.bake.member < 0);
    const faded = (x: number) => outside.filter((s) => s.bake.phaseFade < x).length;
    console.log(
      `sky river winding fade: ${outside.length} strokes outside the kept wheels, ${faded(1e-9)} at 0, ${faded(0.5)} under 0.5, ${faded(1)} under 1`,
    );
    console.log(
      `sky river iRiver vs bake: omega ${worst.toExponential(2)} rad/s, phase ${worstPhase.toExponential(2)}, max amplitude ${maxAmplitude.toFixed(6)}`,
    );
    expect(worst).toBeLessThan(1e-7);
    // iRiver.w carries the fade level 0-255 in its integer part: float32's half ulp there is 2^-17.
    expect(worstPhase).toBeLessThanOrEqual(2 ** -17 * (1 + 1e-9));
    expect(maxAmplitude).toBeLessThanOrEqual(1 + 1e-6);
    console.log(`sky river turn: half-loop peak ${maxTurn.toFixed(4)} rad`);
    expect(maxTurn).toBeLessThanOrEqual(SKY_RIVER_MAX_TURN * (1 + 1e-6));
  });

  test('the bound: no moved centre, widened by the haze extent, comes nearer a kept members edge it was clear of, at every band size and in both arms', () => {
    const near = strokes.filter(
      (s) => skyWheelAt(s.dir, SKY_RIVER_WHEELS) < 0 && pastKept(s.dir).some((e) => e < 10 * deg),
    );
    expect(near.length).toBeGreaterThan(2000);
    let moved = 0;
    let closestHaze = Number.POSITIVE_INFINITY;
    let closestDome = Number.POSITIVE_INFINITY;
    for (const m of [BEAUTY, FAR, LEVEL_5, LARGEST]) {
      for (const wrap of ['wheelrun', 'wheelflow'] as const) {
        for (const s of near) {
          const k = s.haze ? halfAngle(s, m) : 0;
          const rest = pastKept(s.dir);
          const normal: Vec3 = [-s.dir[0], -s.dir[1], -s.dir[2]];
          const river = riverOf(s);
          for (let t = 0; t < 9; t++) {
            const time = (t / 8) * SKY_SWIRL_PERIOD + 0.031;
            const motion = skySwirl(s.position, normal, s.phase, time, undefined, wrap, undefined, {
              halfDiagonal: k * s.distance,
              river,
            });
            const p: Vec3 = [
              s.position[0] + motion.offset[0] - PAINTER_EYE[0],
              s.position[1] + motion.offset[1] - PAINTER_EYE[1],
              s.position[2] + motion.offset[2] - PAINTER_EYE[2],
            ];
            const l = Math.hypot(...p);
            const now = pastKept([p[0] / l, p[1] / l, p[2] / l]);
            if (Math.hypot(...motion.offset) > 1e-6) moved++;
            now.forEach((e, j) => {
              expect(e - k).toBeGreaterThanOrEqual(Math.min(rest[j] - k, 0) - 1e-9);
              if (rest[j] - k < 0) return;
              if (s.haze) closestHaze = Math.min(closestHaze, e - k);
              else closestDome = Math.min(closestDome, e);
            });
          }
        }
      }
    }
    console.log(
      `sky river kept-wheel bound: ${near.length} strokes within 10° of a kept edge, ${moved} moved samples, closest haze quad ${(closestHaze / deg).toFixed(4)}°, closest dome centre ${(closestDome / deg).toFixed(4)}° past the edge`,
    );
    expect(moved).toBeGreaterThan(near.length * 20);
    expect(closestHaze).toBeGreaterThanOrEqual(-1e-9);
    expect(closestDome).toBeGreaterThanOrEqual(-1e-9);
  });

  test('Addition C: wheelrun never shrinks the sky more than base, at each of 32 times through the loop', () => {
    // The painted area each stroke loses to its size envelope, (1 - (1 + gain)²) times its rest
    // area, summed over the dome strokes outside the kept wheels (every second one), as a share of
    // their rest area. Base shrinks every stroke to nothing over 6% of each end of its loop;
    // wheelrun scales that envelope by travel × amplitude, so it shrinks no stroke more.
    const sample = strokes.filter(
      (s, i) => i % 2 === 0 && !s.haze && skyWheelAt(s.dir, SKY_RIVER_WHEELS) < 0,
    );
    expect(sample.length).toBeGreaterThan(20_000);
    let rest = 0;
    for (const s of sample) rest += s.half * s.half;
    const shares: { run: number; base: number }[] = [];
    for (let t = 0; t < 32; t++) {
      const time = (t / 32) * SKY_SWIRL_PERIOD + 0.0173;
      let run = 0;
      let base = 0;
      for (const s of sample) {
        const normal: Vec3 = [-s.dir[0], -s.dir[1], -s.dir[2]];
        const a = s.half * s.half;
        const r = skySwirl(s.position, normal, s.phase, time, undefined, 'wheelrun', undefined, {
          river: riverOf(s),
        });
        const b = skySwirl(s.position, normal, s.phase, time, undefined, 'base');
        expect(r.gain).toBeGreaterThanOrEqual(b.gain - 1e-12);
        run += a * (1 - (1 + r.gain) ** 2);
        base += a * (1 - (1 + b.gain) ** 2);
      }
      shares.push({ run: run / rest, base: base / rest });
    }
    const mean = (k: 'run' | 'base') => shares.reduce((x, s) => x + s[k], 0) / shares.length;
    const max = (k: 'run' | 'base') => Math.max(...shares.map((s) => s[k]));
    console.log(
      `sky river Addition C: shrunk area share over the loop, wheelrun mean ${(100 * mean('run')).toFixed(3)}% max ${(100 * max('run')).toFixed(3)}%, base mean ${(100 * mean('base')).toFixed(3)}% max ${(100 * max('base')).toFixed(3)}% (${sample.length} dome strokes)`,
    );
    for (const s of shares) expect(s.run).toBeLessThanOrEqual(s.base + 1e-12);
  });

  test('Addition C per patch: at the 24 coverage poses and the coverage specs 8 motion times, no wheelrun patch shrinks more than the worst base patch', () => {
    // The shrunk area share per 80 px patch of a 1280 × 720 view (the e2e coverage viewport, 70°
    // vertical FOV): over the sky strokes whose centres fall in the patch, each weighted by its
    // screen area (half / its distance from the pose's eye)², the share of that area the size
    // envelope takes, (1 − (1 + gain)²). Patches with under 12 strokes are skipped. Occlusion is
    // ignored, so ground poses count sky that the hills hide. wheelflow has no envelope.
    const W = 1280;
    const H = 720;
    const TILE = 80;
    const cols = W / TILE;
    const tiles = cols * (H / TILE);
    const times = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5];
    const arms = ['base', 'wheelrun', 'wheelflow'] as const;
    // Two sets: every sky stroke (12 or more a patch), and the dome alone (30 or more), since a
    // near haze stroke's screen area can outweigh a whole patch of dome strokes.
    for (const set of ['sky', 'dome'] as const) {
      const minCount = set === 'sky' ? 12 : 30;
      const sky = strokes.filter(
        (s) => skyWheelAt(s.dir, SKY_RIVER_WHEELS) < 0 && (set === 'sky' || !s.haze),
      );
      // shrink[arm][time][stroke]: 1 − (1 + gain)², pose-independent.
      const shrink = arms.map((wrap) =>
        times.map((time) => {
          const out = new Float64Array(sky.length);
          sky.forEach((s, i) => {
            const normal: Vec3 = [-s.dir[0], -s.dir[1], -s.dir[2]];
            const m =
              wrap === 'base'
                ? skySwirl(s.position, normal, s.phase, time, undefined, 'base')
                : skySwirl(s.position, normal, s.phase, time, undefined, wrap, undefined, {
                    river: riverOf(s),
                  });
            out[i] = 1 - (1 + m.gain) ** 2;
          });
          return out;
        }),
      );
      const worst = arms.map(() => ({ share: 0, pose: '', time: 0, tile: -1, count: 0 }));
      const ahead = arms.map(() => 0);
      const p = new Vector3();
      for (const pose of COVERAGE_POSES) {
        const camera = new PerspectiveCamera(70, W / H, 0.1, 1000);
        camera.position.set(...pose.position);
        camera.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
        camera.updateMatrixWorld(true);
        const tileOf = new Int32Array(sky.length).fill(-1);
        const weight = new Float64Array(sky.length);
        sky.forEach((s, i) => {
          p.set(...s.position).project(camera);
          if (p.z < -1 || p.z > 1 || Math.abs(p.x) >= 1 || Math.abs(p.y) >= 1) return;
          const x = Math.floor(((p.x + 1) / 2) * W);
          const y = Math.floor(((1 - p.y) / 2) * H);
          tileOf[i] = Math.floor(y / TILE) * cols + Math.floor(x / TILE);
          const d = Math.hypot(
            s.position[0] - pose.position[0],
            s.position[1] - pose.position[1],
            s.position[2] - pose.position[2],
          );
          weight[i] = (s.half / d) ** 2;
        });
        const count = new Int32Array(tiles);
        const rest = new Float64Array(tiles);
        for (let i = 0; i < sky.length; i++) {
          if (tileOf[i] < 0) continue;
          count[tileOf[i]]++;
          rest[tileOf[i]] += weight[i];
        }
        arms.forEach((_, a) => {
          times.forEach((time, t) => {
            const lost = new Float64Array(tiles);
            const row = shrink[a][t];
            for (let i = 0; i < sky.length; i++) {
              if (tileOf[i] >= 0) lost[tileOf[i]] += weight[i] * row[i];
            }
            for (let k = 0; k < tiles; k++) {
              if (count[k] < minCount) continue;
              const share = lost[k] / rest[k];
              if (pose.name === 'spot ahead') ahead[a] = Math.max(ahead[a], share);
              if (share > worst[a].share) {
                worst[a] = { share, pose: pose.name, time, tile: k, count: count[k] };
              }
            }
          });
        });
      }
      console.log(
        `sky river Addition C per patch, ${set}: ${arms
          .map(
            (wrap, a) =>
              `${wrap} worst ${(100 * worst[a].share).toFixed(2)}% (${worst[a].pose}, t ${worst[a].time}, tile ${worst[a].tile % cols},${Math.floor(worst[a].tile / cols)}, ${worst[a].count} strokes)`,
          )
          .join('; ')}; spot ahead worst ${arms
          .map((wrap, a) => `${wrap} ${(100 * ahead[a]).toFixed(2)}%`)
          .join(', ')}`,
      );
      expect(worst[0].share).toBeGreaterThan(0);
      expect(ahead[1]).toBeLessThanOrEqual(ahead[0]);
      expect(worst[1].share).toBeLessThanOrEqual(worst[0].share);
      expect(worst[2].share).toBe(0);
    }
  });

  test('seams in the river field: over the canvas sky, the far sky, round the kept wheels and over the big swirl, no two points 0.02° apart reverse or step past 0.1° in either arm', () => {
    // The river field at a point (skyRiverBake with the smoothed painted orientation, no own axis)
    // and its travel share against the kept wheels, at a dome stroke's h = 0. Each arm's
    // displacement at loop phase f is g(f) × PERIOD × A, radians on the sphere, with A = travel ×
    // (ω × d̂) under wheelrun and travel × fade × (ω × d̂) under wheelflow. wheelrun's f is the
    // stroke's phase byte, so a pair is taken at its worst common phase, |g| = 1/2. wheelflow's f is
    // fract(t / PERIOD + phase(d̂)), which the field sets, so a pair is taken at its worst of 32
    // times through the loop.
    const step = 0.02 * deg;
    const P = SKY_SWIRL_PERIOD;
    const TIMES = 32;
    interface Sample {
      readonly d: Vec3;
      readonly run: Vec3;
      readonly flow: Vec3;
      readonly phase: number;
      readonly axis: Vec3 | null;
    }
    const ZERO3: Vec3 = [0, 0, 0];
    const sample = (d: Vec3): Sample => {
      const bake = skyRiverBake(riverField, d);
      const raw = skyRiverTangent(rawField, d);
      const axis: Vec3 | null = raw ? [raw.tangent[0], raw.tangent[1], raw.tangent[2]] : null;
      if (bake.member >= 0) return { d, run: ZERO3, flow: ZERO3, phase: 0, axis };
      const v = cross([bake.omega[0], bake.omega[1], bake.omega[2]], d);
      const travel = Math.max(0, skyWheelFlowTravel(d, v, 0, SKY_RIVER_WHEELS));
      const f = travel * bake.phaseFade * SKY_RIVER_FLOW_SCALE;
      return {
        d,
        run: [travel * v[0], travel * v[1], travel * v[2]],
        flow: [f * v[0], f * v[1], f * v[2]],
        phase: bake.phase,
        axis,
      };
    };
    const g = (f: number): number => smoothstepTs(0, 1, 1 - Math.abs(2 * f - 1)) - 0.5;
    const diff = (a: Vec3, ka: number, b: Vec3, kb: number): number =>
      Math.hypot(ka * a[0] - kb * b[0], ka * a[1] - kb * b[1], ka * a[2] - kb * b[2]);
    /** A reversal: opposed directions where both move more than half the 0.1° bar. */
    const REVERSE_MIN = 0.05 * deg;
    interface Step {
      readonly arm: string;
      readonly jump: number;
      readonly where: string;
    }
    interface Region {
      readonly name: string;
      pairs: number;
      worst: number;
      over: number;
      reversed: number;
      turned: number;
      turnedWorst: number;
      turnedReversed: number;
      top: Step[];
    }
    const regions: Region[] = [];
    let region: Region;
    const open = (name: string): void => {
      region = {
        name,
        pairs: 0,
        worst: 0,
        over: 0,
        reversed: 0,
        turned: 0,
        turnedWorst: 0,
        turnedReversed: 0,
        top: [],
      };
      regions.push(region);
    };
    const where = (d: Vec3): string => {
      const uv = uvOf(d);
      if (uv) return `uv (${uv[0].toFixed(3)}, ${uv[1].toFixed(3)})`;
      const az = Math.atan2(d[0], -d[2]) / deg;
      const el = Math.asin(Math.max(-1, Math.min(1, d[1]))) / deg;
      return `az ${az.toFixed(1)}° el ${el.toFixed(1)}°`;
    };
    const pair = (a: Sample, b: Sample): void => {
      region.pairs++;
      // wheelrun at |g| = 1/2.
      const run = 0.5 * P * diff(a.run, 1, b.run, 1);
      const runReversed =
        dot(a.run, b.run) < 0 && 0.5 * P * Math.min(len(a.run), len(b.run)) > REVERSE_MIN;
      // wheelflow at its worst time.
      let flow = 0;
      let flowReversed = false;
      if (len(a.flow) > 0 || len(b.flow) > 0) {
        for (let k = 0; k < TIMES; k++) {
          const t = (k / TIMES) * P;
          const ga = g(fract(t / P + a.phase));
          const gb = g(fract(t / P + b.phase));
          flow = Math.max(flow, P * diff(a.flow, ga, b.flow, gb));
          const oa = P * Math.abs(ga) * len(a.flow);
          const ob = P * Math.abs(gb) * len(b.flow);
          if (ga * gb * dot(a.flow, b.flow) < 0 && Math.min(oa, ob) > REVERSE_MIN) {
            flowReversed = true;
          }
        }
      }
      const jump = Math.max(run, flow);
      const reversed = runReversed || flowReversed;
      const turned =
        a.axis !== null &&
        b.axis !== null &&
        Math.acos(Math.min(1, Math.abs(dot(a.axis, b.axis)))) > 30 * deg;
      if (turned) {
        region.turned++;
        region.turnedWorst = Math.max(region.turnedWorst, jump);
        if (reversed) region.turnedReversed++;
        return;
      }
      region.worst = Math.max(region.worst, jump);
      if (jump > 0.1 * deg) region.over++;
      if (reversed) region.reversed++;
      if (region.top.length < 5 || jump > region.top[region.top.length - 1].jump) {
        region.top.push({ arm: run >= flow ? 'wheelrun' : 'wheelflow', jump, where: where(a.d) });
        region.top.sort((x, y) => y.jump - x.jump);
        if (region.top.length > 5) region.top.pop();
      }
    };
    const line = (points: (k: number) => Vec3, count: number): void => {
      let prev = sample(points(0));
      for (let k = 1; k <= count; k++) {
        const s = sample(points(k));
        pair(prev, s);
        prev = s;
      }
    };
    const fromAzEl = (az: number, el: number): Vec3 => [
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      -Math.cos(el) * Math.cos(az),
    ];
    const basis = (axis: Vec3): [Vec3, Vec3] => {
      const seed: Vec3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const u = unit(cross(axis, seed));
      return [u, cross(axis, u)];
    };
    const at = (axis: Vec3, [e1, e2]: [Vec3, Vec3], a: number, phi: number): Vec3 => {
      const c = Math.cos(a);
      const s = Math.sin(a);
      return [0, 1, 2].map(
        (i) => c * axis[i] + s * (Math.cos(phi) * e1[i] + Math.sin(phi) * e2[i]),
      ) as Vec3;
    };
    // 1. The canvas sky and the band past its frame: rows of constant elevation and columns of
    // constant azimuth from the painter's eye, 0.5° apart, sampled at 0.02° along each, over
    // azimuth ±50° and elevation 0° to 60°, which hold the canvas and its 10° edge band.
    open('canvas and edge band');
    const AZ = 50 * deg;
    const EL = 60 * deg;
    for (let el = 0; el <= EL + 1e-9; el += 0.5 * deg) {
      const n = Math.ceil((2 * AZ * Math.cos(el)) / step);
      line((k) => fromAzEl(-AZ + (2 * AZ * k) / n, el), n);
    }
    for (let az = -AZ; az <= AZ + 1e-9; az += 0.5 * deg) {
      const n = Math.ceil(EL / step);
      line((k) => fromAzEl(az, (EL * k) / n), n);
    }
    // 2. The far sky: whole rings of constant elevation round the dome, 5° apart.
    open('far sky rings');
    for (let el = 0; el <= 85 * deg + 1e-9; el += 5 * deg) {
      const n = Math.ceil((2 * Math.PI * Math.cos(el)) / step);
      line((k) => fromAzEl((2 * Math.PI * k) / n, el), n);
    }
    // 3. Rings round each kept wheel, from its members' edge to 4° out.
    for (const w of SKY_RIVER_WHEELS) {
      open(`ring ${w.note.slice(0, 24)}`);
      const e = basis(w.axis as Vec3);
      for (const off of [0, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3, 4]) {
        const a = skyWheelEdge(w) + off * deg;
        const count = Math.ceil((2 * Math.PI * Math.sin(a)) / step);
        line((k) => at(w.axis as Vec3, e, a, (2 * Math.PI * k) / count), count);
      }
    }
    // 4. The dropped big swirl's old disc and 1° past its members' edge: rows and columns of a
    // grid at 0.02°, every tenth row and column.
    open('big swirl disc');
    const big = SKY_WHEELS[0];
    const e = basis(big.axis as Vec3);
    const span = skyWheelEdge(big) + 1 * deg;
    const n = Math.round((2 * span) / step);
    const grid = (i: number, j: number): Vec3 =>
      unit(
        [0, 1, 2].map(
          (k) => big.axis[k] + (-span + i * step) * e[0][k] + (-span + j * step) * e[1][k],
        ) as Vec3,
      );
    for (let r = 0; r <= n; r += 10) {
      line((k) => grid(k, r), n);
      line((k) => grid(r, k), n);
    }
    const report = regions.map(
      (r) =>
        `${r.name}: ${r.pairs} pairs, largest ${(r.worst / deg).toFixed(4)}°, ${r.over} over 0.1°, ${r.reversed} reversals; ` +
        `brush axis turned > 30°: ${r.turned} pairs, largest ${(r.turnedWorst / deg).toFixed(4)}°, ${r.turnedReversed} reversals; ` +
        `top: ${r.top.map((s) => `${(s.jump / deg).toFixed(4)}° ${s.arm} at ${s.where}`).join(', ')}`,
    );
    console.log(`sky river seam per 0.02°:\n  ${report.join('\n  ')}`);
    for (const r of regions) {
      expect(r.reversed, `${r.name} reversals`).toBe(0);
      expect(r.worst, `${r.name} largest step`).toBeLessThanOrEqual(0.1 * deg);
      // The pairs across a > 30° turn of flow.png's brush axis are counted apart, and hold the bar
      // too (fix round 2, seed 1).
      expect(r.turnedReversed, `${r.name} reversals across a brush turn`).toBe(0);
      expect(r.turnedWorst, `${r.name} largest step across a brush turn`).toBeLessThanOrEqual(
        0.1 * deg,
      );
    }
  });

  test('coverage proxy: the painter view moving sky shift ranks the wraps as the e2e coverage reads them, and predicts wheelflow under the bar', () => {
    // The MiniMac coverage spec (tests/e2e/sky-wheel-stream.spec.ts, MAX_BARE 0.5%) read the worst
    // bare share of the painter view at 0.303% under wave, 0.363% under wheelrun (0.480% at the
    // wheel seams) and 0.515% under wheelflow (0.697% at the seams), with SKY_RIVER_FLOW_SCALE 1.
    // Proxy: the mean angular shift of the painter view's moving dome strokes (canvas view, outside
    // the kept wheels), at the spec's 8 times. Wheelflow shrinks nothing, so its gaps open where
    // the moving paint pulls away from what holds still (the kept discs, the lights, the cypress,
    // the hills), in proportion to how far it moves. The pair drift between neighbouring dome
    // strokes was tried first and ranks wheelrun, whose phase bytes are independent, far above
    // wheelflow, against the e2e.
    const view = strokes.filter((s) => {
      if (s.haze || s.bake.member >= 0) return false;
      const uv = uvOf(s.dir);
      return uv !== null && uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1;
    });
    const times = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5];
    const shift: Record<string, number[]> = {};
    for (const wrap of ['wave', 'wheelrun', 'wheelflow'] as const) {
      shift[wrap] = times.map((time) => {
        let sum = 0;
        for (const s of view) {
          const m = skySwirl(
            s.position,
            [-s.dir[0], -s.dir[1], -s.dir[2]],
            s.phase,
            time,
            undefined,
            wrap,
            undefined,
            { river: riverOf(s) },
          );
          sum += Math.hypot(...m.offset) / s.distance;
        }
        return sum / view.length / deg;
      });
    }
    // wheelflow's shift is linear in SKY_RIVER_FLOW_SCALE, so its value at 1 is the shift over it.
    const flowAt1 = shift.wheelflow.map((x) => x / SKY_RIVER_FLOW_SCALE);
    const max = (xs: number[]): number => Math.max(...xs);
    // Two lines through the e2e rows: the painter view through wave and wheelflow at 1, the wheel
    // seams through wheelrun and wheelflow at 1.
    const line = (x0: number, y0: number, x1: number, y1: number) => (x: number) =>
      y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    const painter = line(max(shift.wave), 0.303, max(flowAt1), 0.515);
    const seams = line(max(shift.wheelrun), 0.48, max(flowAt1), 0.697);
    const fmt = (xs: number[]) => xs.map((x) => x.toFixed(3)).join(' ');
    const before = { painter: flowAt1.map(painter), seams: flowAt1.map(seams) };
    const after = { painter: shift.wheelflow.map(painter), seams: shift.wheelflow.map(seams) };
    console.log(
      `sky river coverage proxy, ${view.length} painter-view dome strokes, t ${times.join(' ')}:\n` +
        `  shift (°): wave ${fmt(shift.wave)}; wheelrun ${fmt(shift.wheelrun)}; wheelflow at 1 ${fmt(flowAt1)}; wheelflow at ${SKY_RIVER_FLOW_SCALE} ${fmt(shift.wheelflow)}\n` +
        `  predicted bare %, painter: before ${fmt(before.painter)}, after ${fmt(after.painter)}\n` +
        `  predicted bare %, seams: before ${fmt(before.seams)}, after ${fmt(after.seams)}`,
    );
    // The ranking the e2e measured: wave < wheelrun < wheelflow.
    expect(max(shift.wave)).toBeLessThan(max(shift.wheelrun));
    expect(max(shift.wheelrun)).toBeLessThan(max(flowAt1));
    // The calibrated worst wheelflow row, painter view and seams, at 0.42% or less.
    expect(max([...after.painter, ...after.seams])).toBeLessThanOrEqual(0.42);
  });

  test('the wrap diag under the river arms: the shares the e2e A/B cycle bounds, at the painter view', () => {
    const rows = wrapStats.map(
      ({ wrap, time, stats: w }) =>
        `${wrap} t ${time}: drawn ${w.drawn} wheeled ${w.wheeled} small ${w.small} returning ${w.returningShare.toFixed(3)} counter-flow ${w.counterFlow.share.toFixed(4)} within30 ${w.alignment.within30.toFixed(3)}`,
    );
    console.log(`sky river wrap diag: ${rows.join('; ')}`);
    for (const { wrap, stats: w } of wrapStats) {
      expect(w.drawn).toBeGreaterThan(1000);
      expect(w.wheeled).toBeGreaterThan(0);
      expect(w.streaming).toBe(0);
      expect(w.counterFlow.pairs).toBeGreaterThan(10_000);
      if (wrap === 'wheelrun') {
        expect(w.small).toBeGreaterThan(0);
        expect([w.returning, w.counterFlow.opposed]).toEqual([0, 0]);
      } else {
        expect(w.small).toBe(0);
        // Measured 0.473-0.496 returning and 0.077-0.088 counter-flow: the phase is the phasor
        // blend (SkyRiverGuide.phase) at SKY_RIVER_WAVELENGTH 30°, so the half-bands are 13.5°
        // wide at the median. The wave-like bars of tests/e2e/ab.spec.ts.
        expect(w.returningShare).toBeGreaterThan(0.3);
        expect(w.returningShare).toBeLessThan(0.7);
        expect(w.counterFlow.share).toBeLessThan(0.1);
      }
    }
  });

  test('calibration for the e2e disc bars: the big swirl core moves, and what reaches the kept cores', () => {
    const angle = (axis: readonly number[], d: Vec3): number =>
      Math.acos(Math.min(1, Math.max(-1, dot(axis as Vec3, d))));
    // The big swirl's core within 0.6 of its members' edge (the e2e's 0.6 radius core).
    const big = SKY_WHEELS[0];
    const core = strokes.filter((s) => !s.haze && angle(big.axis, s.dir) < 0.6 * skyWheelEdge(big));
    const moving = core.filter((s) => s.amplitude > 0.05).length;
    // Each kept disc's inner half: its members there, and the outside dome strokes whose rest quad
    // at the far band's 1.6 reaches into it.
    const kept = SKY_RIVER_WHEELS.map((w) => {
      const r = 0.5 * skyWheelEdge(w);
      const inner = strokes.filter((s) => !s.haze && angle(w.axis, s.dir) < r);
      const reaching = strokes.filter(
        (s) =>
          !s.haze && s.bake.member < 0 && angle(w.axis, s.dir) - (1.6 * s.half) / s.distance < r,
      );
      return {
        inner: inner.length,
        members: inner.filter((s) => s.bake.member >= 0).length,
        reaching: reaching.length,
      };
    });
    console.log(
      `sky river disc calibration: big swirl core ${core.length} dome strokes, ${moving} with amplitude over 0.05 (${((100 * moving) / core.length).toFixed(1)}%); kept inner halves ${JSON.stringify(kept)}`,
    );
    expect(core.length).toBeGreaterThan(100);
  });
});
