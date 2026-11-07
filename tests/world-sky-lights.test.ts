import { readFileSync } from 'node:fs';
import { Texture } from 'three';
import { expect, test } from 'vitest';
import { loadRealSource, loadSkyScan } from '../scripts/scatter-time.ts';
import { REGION, regionAt, sampleColor, sampleFlow } from '../src/demo/canvas/field.ts';
import {
  COLOR_INSET,
  decodedNormal,
  REGION_STYLES,
  strokeShade,
} from '../src/demo/canvas/placement.ts';
import { ringOf, SKY_RING_REACH, SKY_RINGS, skyRing } from '../src/motion/sky-rings.ts';
import {
  CANVAS_ASPECT,
  PAINTER_EYE,
  projectToCanvas,
} from '../src/paintings/starry-night/canvas-camera.ts';
import { WORLD_DOME_SIZE } from '../src/paintings/starry-night/world.ts';
import {
  backdropRank,
  backdropTier,
  DEPTH_BACKDROP_FLAG,
} from '../src/render/strokes/backdrop-depth.ts';
import { DEFAULT_BAND_SIZE } from '../src/render/strokes/bands.ts';
import {
  DEPTH_RANKED_FLAG,
  DEPTH_TIE_BREAK_FRONT_FLAG,
} from '../src/render/strokes/depth-tie-break.ts';
import { FIT_SCALE_MASK, FIT_SCALE_SHIFT } from '../src/render/strokes/face-clamp.ts';
import { strokeAxes, type Vec3 } from '../src/render/strokes/frame.ts';
import { STROKE_LAYER } from '../src/render/strokes/instance.ts';
import { createStrokeMaterial, HAZE_GROWTH } from '../src/render/strokes/material.ts';
import { SCATTER_SIZE_JITTER, strokeSizeAt } from '../src/render/strokes/scatter.ts';
import {
  SKY_LIGHT_CONES,
  SKY_LIGHT_CULL_FLAG,
  SKY_LIGHT_MIN_FEATHER,
  type SkyLightCone,
  skyLightConeUniforms,
  skyLightCulled,
  skyLightFeatherUniforms,
  skyLightThin,
} from '../src/render/strokes/sky-light-cull.ts';
import { HAZE_RADIUS, HAZE_STROKE_SIZE } from '../src/world/boundary.ts';
import { SKY_DOME_RADIUS, skyAnchors } from '../src/world/sky.ts';
import {
  createSkyLights,
  metresPerWidth,
  RankPicker,
  SKY_LIGHT_FEATHER,
  SKY_LIGHT_FINE_LEVELS,
  SKY_LIGHT_MOON_EDGE_LEVEL,
  SKY_LIGHT_RIM,
  skyLightCones,
} from '../src/world/sky-lights.ts';
import { sampleSkyScan, skyScanCrops } from '../src/world/sky-scan.ts';

const SOURCE = await loadRealSource();
const SCAN = await loadSkyScan();
const ANCHORS = skyAnchors();
const RESULT = createSkyLights(SOURCE, SCAN, 1, WORLD_DOME_SIZE);
const LIGHTS = RESULT.strokes;
const CONES = skyLightCones(WORLD_DOME_SIZE, ANCHORS);
/** The dome's stored stroke length at the dome radius, metres: the lights' full size. */
const DOME_LENGTH = strokeSizeAt(WORLD_DOME_SIZE, SKY_DOME_RADIUS);

/** Painting-width distance between two canvas uvs: v units are CANVAS_ASPECT longer. */
function widthDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], (a[1] - b[1]) / CANVAS_ASPECT);
}

/** A stroke's distance from an anchor in anchor radii. */
function rhoOf(uv: readonly number[], a: number): number {
  return widthDistance(uv, ANCHORS[a].uv) / ANCHORS[a].radius;
}

/**
 * The strokes of each anchor, by the anchor nearest to each stroke's projected uv in anchor radii.
 * Neighbouring stars' rims overlap, so a rim stroke may land with the neighbour; it is then no
 * farther from that anchor, in its radii, than from its own.
 */
function byAnchorOf(uv: readonly number[]): number {
  let best = 0;
  for (let a = 1; a < ANCHORS.length; a++) if (rhoOf(uv, a) < rhoOf(uv, best)) best = a;
  return best;
}

function byAnchor(): number[][] {
  const groups: number[][] = ANCHORS.map(() => []);
  LIGHTS.forEach((s, i) => {
    const uv = projectToCanvas(s.position).uv ?? [9, 9];
    let best = 0;
    for (let a = 1; a < ANCHORS.length; a++) {
      if (rhoOf(uv, a) < rhoOf(uv, best)) best = a;
    }
    groups[best].push(i);
  });
  return groups;
}

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Drawn half diagonal in metres of a stored stroke, without the picker's margin. */
function halfDiagonal(s: { readonly size: readonly number[] }): number {
  return 0.5 * Math.hypot(s.size[0], s.size[1]) * DEFAULT_BAND_SIZE.far;
}

/**
 * Same-rank pairs that can overlap, measured from the stored strokes alone: their positions on the
 * dome, their sizes and the shader's rank hash, all in metres, independent of the generator's
 * metric. Also every stroke's count of earlier strokes it can overlap, and the overlapping pairs.
 */
function rankOverlaps(lights: ReturnType<typeof createSkyLights>['strokes']): {
  pairs: number;
  shared: number;
  mostEarlier: number;
} {
  const half = lights.map(halfDiagonal);
  const rank = lights.map((s) => backdropRank(s.position, s.layer));
  const cell = 2 * Math.max(...half);
  const cellOf = (p: readonly number[]): number[] => p.map((c) => Math.floor(c / cell));
  const cells = new Map<string, number[]>();
  lights.forEach((s, i) => {
    const key = cellOf(s.position).join(',');
    cells.set(key, [...(cells.get(key) ?? []), i]);
  });
  let pairs = 0;
  let shared = 0;
  let mostEarlier = 0;
  lights.forEach((s, i) => {
    const [cx, cy, cz] = cellOf(s.position);
    let earlier = 0;
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (let z = cz - 1; z <= cz + 1; z++) {
          for (const j of cells.get(`${x},${y},${z}`) ?? []) {
            const p = lights[j].position;
            const d = Math.hypot(p[0] - s.position[0], p[1] - s.position[1], p[2] - s.position[2]);
            if (j === i || d >= half[i] + half[j]) continue;
            if (j < i) {
              earlier++;
              continue;
            }
            pairs++;
            if (rank[i] === rank[j]) shared++;
          }
        }
      }
    }
    mostEarlier = Math.max(mostEarlier, earlier);
  });
  return { pairs, shared, mostEarlier };
}

test('the moon and every star get strokes on their own stroke layers', () => {
  const groups = byAnchor();
  ANCHORS.forEach((anchor, a) => {
    expect(groups[a].length, anchor.note).toBeGreaterThan(80);
    const layer = anchor.kind === 'moon' ? STROKE_LAYER.moon : STROKE_LAYER.star;
    for (const i of groups[a]) expect(LIGHTS[i].layer).toBe(layer);
  });
  expect(LIGHTS.filter((s) => s.layer === STROKE_LAYER.moon).length).toBeGreaterThan(200);
  expect(LIGHTS.filter((s) => s.layer === STROKE_LAYER.star).length).toBeGreaterThan(3_000);
});

test('each light sits on its projected anchor, inside its rim band, densest inside its circle', () => {
  const groups = byAnchor();
  ANCHORS.forEach((anchor, a) => {
    let su = 0;
    let sv = 0;
    let sw = 0;
    for (const i of groups[a]) {
      const s = LIGHTS[i];
      // On the dome, x moved by a few float32 steps (micrometres each) to take its rank.
      const d = s.position.map((p, k) => p - PAINTER_EYE[k]);
      const r = Math.hypot(d[0], d[1], d[2]);
      expect(Math.abs(r - SKY_DOME_RADIUS)).toBeLessThan(0.01);
      const uv = projectToCanvas(s.position).uv ?? [9, 9];
      expect(rhoOf(uv, a), anchor.note).toBeLessThan(SKY_LIGHT_RIM);
      // The quad-area centroid inside the circle: finer strokes crowd along colour edges, and
      // the rim band is thinned at random, so neither a stroke count nor the band is centred.
      if (rhoOf(uv, a) >= 1) continue;
      const w = s.size[0] * s.size[1];
      su += w * uv[0];
      sv += w * uv[1];
      sw += w;
    }
    expect(widthDistance([su / sw, sv / sw], anchor.uv), anchor.note).toBeLessThan(
      0.15 * anchor.radius,
    );
  });
  // The rim band thins out: quad area per unit disc area falls from the circle to the band's edge.
  const area = [0, 0, 0];
  groups.forEach((group, a) => {
    for (const i of group) {
      const rho = rhoOf(projectToCanvas(LIGHTS[i].position).uv ?? [9, 9], a);
      area[rho < 1 ? 0 : rho < 1.25 ? 1 : 2] += LIGHTS[i].size[0] * LIGHTS[i].size[1];
    }
  });
  const ring = [1, 1.25 ** 2 - 1, SKY_LIGHT_RIM ** 2 - 1.25 ** 2];
  const coverage = area.map((x, k) => x / ring[k]);
  expect(coverage[1]).toBeLessThan(coverage[0]);
  expect(coverage[2]).toBeLessThan(0.5 * coverage[1]);
});

test('lights are brushed like the dome: its size, length jitter, brushes and flow direction', () => {
  const sky = REGION_STYLES[REGION.sky].brushes;
  const groups = byAnchor();
  let along = 0;
  groups.forEach((group) => {
    for (const i of group) {
      const s = LIGHTS[i];
      expect(sky).toContain(s.brush);
      // Full, half or quarter the dome's length, each within the dome's length jitter.
      const level = Math.round(Math.log2(DOME_LENGTH / s.size[0]));
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(SKY_LIGHT_FINE_LEVELS);
      const share = s.size[0] / (DOME_LENGTH * 0.5 ** level);
      expect(Math.abs(share - 1)).toBeLessThanOrEqual(SCATTER_SIZE_JITTER + 1e-6);
      // The long axis, projected onto the canvas, runs along the flow at the stroke's uv.
      const uv = projectToCanvas(s.position).uv ?? [9, 9];
      const { long } = strokeAxes(decodedNormal(s.normal), s.tangent);
      const tip = projectToCanvas([
        s.position[0] + long[0] * 0.05,
        s.position[1] + long[1] * 0.05,
        s.position[2] + long[2] * 0.05,
      ]).uv ?? [9, 9];
      const angle = Math.atan2((tip[1] - uv[1]) / CANVAS_ASPECT, tip[0] - uv[0]);
      let off = Math.abs(angle - sampleFlow(SOURCE.flow, uv[0], uv[1]).angle) % Math.PI;
      if (off > Math.PI / 2) off = Math.PI - off;
      if (off < 0.02) along++;
    }
    expect(group.length).toBeGreaterThan(0);
  });
  // Off by more only where the stroke's uv sits on the next flow texel to the one it was cut by.
  expect(along).toBeGreaterThan(LIGHTS.length * 0.99);
  // Every size level is used.
  const levels = [0, 0, 0];
  for (const s of LIGHTS) levels[Math.round(Math.log2(DOME_LENGTH / s.size[0]))]++;
  expect(levels.every((n) => n > 0)).toBe(true);
});

test('strokes face the eye and carry the backdrop flag in the front tier', () => {
  for (const s of LIGHTS) {
    expect(s.flags).toBe(DEPTH_BACKDROP_FLAG);
    expect(backdropTier(s.layer)).toBe('front');
    expect(backdropRank(s.position, s.layer)).toBeLessThan(256);
    const d = s.position.map((p, k) => PAINTER_EYE[k] - p);
    const len = Math.hypot(d[0], d[1], d[2]);
    const dot = (s.normal[0] * d[0] + s.normal[1] * d[1] + s.normal[2] * d[2]) / len;
    expect(dot).toBeGreaterThan(0.9999);
  }
});

test('strokes that can overlap never share a front-tier rank, across every anchor', () => {
  // Same-rank strokes sit at one NDC z, where the GPU's rounding can flip them under head motion.
  // Two quads can overlap only when their centres are closer than the sum of their drawn half
  // diagonals. Neighbouring stars' rim bands overlap, so the check spans every anchor at once.
  for (const [seed, result] of [
    [1, RESULT],
    [2, createSkyLights(SOURCE, SCAN, 2, WORLD_DOME_SIZE)],
  ] as const) {
    const { pairs, shared, mostEarlier } = rankOverlaps(result.strokes);
    expect(pairs, `seed ${seed}`).toBeGreaterThan(100_000);
    expect(shared, `seed ${seed}`).toBe(0);
    // The picker ranks strokes in this order, each against the earlier strokes it can overlap.
    // Fewer than 256 of those means one of the 256 front-tier ranks is always free. A full-size
    // stroke beside quarter-size ones can overlap more than 256 in all, so the bound is on the
    // earlier ones.
    expect(mostEarlier, `seed ${seed}`).toBeLessThan(256);
    expect(result.rankTies, `seed ${seed}`).toBe(0);
  }
});

test('no two same-rank strokes ever overlap as the rings move them (I3)', () => {
  // The rings move each stroke by up to its own reach, so two strokes apart at rest can meet at a
  // crest. The census runs the TS mirror over every same-rank pair within reach of each other, at
  // 64 samples per period of the shortest ring over 60 s.
  const minPeriod = Math.min(...SKY_RINGS.map((r) => r.period));
  const times = Array.from(
    { length: Math.ceil((60 * 64) / minPeriod) },
    (_, i) => (i * minPeriod) / 64,
  );
  for (const [seed, result] of [
    [1, RESULT],
    [2, createSkyLights(SOURCE, SCAN, 2, WORLD_DOME_SIZE)],
  ] as const) {
    const lights = result.strokes;
    const half = lights.map(halfDiagonal);
    const rank = lights.map((s) => backdropRank(s.position, s.layer));
    const ring = lights.map((s) => ringOf(s.layer === STROKE_LAYER.moon, s.phase));
    const cell = 2 * (Math.max(...half) + SKY_RING_REACH);
    const cellOf = (p: readonly number[]): number[] => p.map((c) => Math.floor(c / cell));
    const cells = new Map<string, number[]>();
    lights.forEach((s, i) => {
      const key = cellOf(s.position).join(',');
      cells.set(key, [...(cells.get(key) ?? []), i]);
    });
    const moved = (i: number, t: number): number[] => {
      const p = lights[i].position;
      const o = skyRing(ring[i], p, t).offset;
      return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
    };
    let candidates = 0;
    let overlaps = 0;
    lights.forEach((s, i) => {
      const [cx, cy, cz] = cellOf(s.position);
      for (let x = cx - 1; x <= cx + 1; x++) {
        for (let y = cy - 1; y <= cy + 1; y++) {
          for (let z = cz - 1; z <= cz + 1; z++) {
            for (const j of cells.get(`${x},${y},${z}`) ?? []) {
              if (j <= i || rank[i] !== rank[j]) continue;
              const reach = half[i] + half[j];
              if (dist(s.position, lights[j].position) >= reach + 2 * SKY_RING_REACH) continue;
              candidates++;
              if (times.some((t) => dist(moved(i, t), moved(j, t)) < reach)) overlaps++;
            }
          }
        }
      }
    });
    expect(candidates, `seed ${seed}`).toBeGreaterThan(1_000);
    expect(overlaps, `seed ${seed}`).toBe(0);
  }
}, 120_000);

test('the rank picker counts a tie once all 256 ranks are held within reach', () => {
  const picker = new RankPicker(0.5);
  const ranks = new Set<number>();
  for (let k = 0; k < 256; k++) ranks.add(picker.pick([0, 0, 0], 0.5, 17));
  expect(ranks.size).toBe(256);
  expect(picker.ties).toBe(0);
  // Every rank is held at this point: the stroke falls back to its start rank and counts a tie.
  expect(picker.pick([0, 0, 0], 0.5, 40)).toBe(40);
  expect(picker.ties).toBe(1);
  // Out of reach, ranks are free again. Reach is the sum of the two half diagonals: 0.9 apart,
  // a 0.5 and a 0.3 stroke cannot overlap, a 0.5 and a 0.5 can, in any direction.
  expect(picker.pick([5, 5, 5], 0.5, 40)).toBe(40);
  expect(picker.ties).toBe(1);
  expect(picker.pick([5.9, 5, 5], 0.3, 40)).toBe(40);
  expect(picker.pick([5, 5, 5.9], 0.5, 40)).toBe(41);
  expect(() => picker.pick([0, 0, 0], 0.6, 0)).toThrow();
  // Step -1 from the top rank takes the highest free one, over every neighbour in reach.
  const top = new RankPicker(0.5);
  top.pick([0, 0, 0], 0.5, 255);
  top.pick([0, 0, 0], 0.5, 254);
  expect(top.pick([0, 0, 0], 0.5, 255, -1)).toBe(253);
  // Ring reach widens the overlap test by both strokes' reach (P4.3): 1.5 apart, two 0.5 strokes
  // cannot overlap at rest, but can once each may move 0.3 towards the other.
  const ringed = new RankPicker(0.5, 0.3);
  expect(ringed.pick([0, 0, 0], 0.5, 9, 1, 0.3)).toBe(9);
  expect(ringed.pick([1.5, 0, 0], 0.5, 9, 1, 0)).toBe(9);
  expect(ringed.pick([1.5, 0, 0], 0.5, 9, 1, 0.3)).toBe(10);
  expect(() => ringed.pick([0, 0, 0], 0.5, 0, 1, 0.31)).toThrow();
});

test('the moon keeps dome-size strokes, with finer edge strokes on top along the crescent', () => {
  const moon = LIGHTS.filter((s) => s.layer === STROKE_LAYER.moon);
  const levelOf = (s: (typeof LIGHTS)[number]): number =>
    Math.round(Math.log2(DOME_LENGTH / s.size[0]));
  const fine = moon.filter((s) => levelOf(s) > 0);
  const area = (list: typeof moon): number =>
    list.reduce((sum, s) => sum + s.size[0] * s.size[1], 0);
  // Paul's ruling: the moon's strokes match the dome's, so most of its paint is at full size.
  expect(area(fine) / area(moon)).toBeLessThan(0.1);
  expect(fine.length).toBeGreaterThan(0);
  expect(fine.every((s) => levelOf(s) === SKY_LIGHT_MOON_EDGE_LEVEL)).toBe(true);
  // Each edge stroke draws over every full-size moon stroke it can overlap.
  const half = (s: (typeof LIGHTS)[number]): number =>
    0.5 * Math.hypot(s.size[0], s.size[1]) * DEFAULT_BAND_SIZE.far;
  for (const f of fine) {
    for (const s of moon) {
      if (levelOf(s) !== 0) continue;
      const d = Math.hypot(...f.position.map((p, k) => p - s.position[k]));
      if (d >= half(f) + half(s)) continue;
      expect(backdropRank(f.position, f.layer)).toBeGreaterThan(backdropRank(s.position, s.layer));
    }
  }
});

test('colours are the scan mean along each stroke, from lights.webp or past it frame.webp', () => {
  const crops = skyScanCrops(ANCHORS);
  // The generator's anchor is not always the nearest one in radii (overlapping rims): match the
  // stroke against every anchor's crop and keep the closest.
  const colourAt = (a: number, uv: readonly [number, number]): readonly number[] =>
    sampleSkyScan(SCAN, crops[a], uv) ??
    sampleColor(
      SOURCE.image,
      COLOR_INSET[0] + uv[0] * (1 - 2 * COLOR_INSET[0]),
      COLOR_INSET[1] + uv[1] * (1 - 2 * COLOR_INSET[1]),
    );
  let close = 0;
  let fromCrop = 0;
  LIGHTS.forEach((s) => {
    const uv = projectToCanvas(s.position).uv ?? [9, 9];
    const { long } = strokeAxes(decodedNormal(s.normal), s.tangent);
    const tip = projectToCanvas([
      s.position[0] + long[0] * 0.05,
      s.position[1] + long[1] * 0.05,
      s.position[2] + long[2] * 0.05,
    ]).uv ?? [9, 9];
    const angle = Math.atan2((tip[1] - uv[1]) / CANVAS_ASPECT, tip[0] - uv[0]);
    // Partly circular: this repeats the generator's sampling (five points along the drawn length
    // on the projected long axis), so it checks the crop choice, the projection, the length and
    // the shade division, not that lights.webp matches the scan. The per-pixel moon ΔE against
    // the scan (docs/verification.md) is the independent check.
    const shade = strokeShade(decodedNormal(s.normal));
    let best = Infinity;
    ANCHORS.forEach((anchor, a) => {
      if (rhoOf(uv, a) > SKY_LIGHT_RIM) return;
      const drawn = (s.size[0] * DEFAULT_BAND_SIZE.far) / metresPerWidth(anchor);
      const mean = [0, 0, 0];
      for (const t of [-0.45, -0.225, 0, 0.225, 0.45]) {
        const c = colourAt(a, [
          uv[0] + t * drawn * Math.cos(angle),
          uv[1] + t * drawn * Math.sin(angle) * CANVAS_ASPECT,
        ]);
        for (let k = 0; k < 3; k++) mean[k] += c[k] / 5;
      }
      best = Math.min(best, Math.max(...mean.map((m, k) => Math.abs(s.color[k] * shade - m))));
    });
    if (best < 2) close++;
    if (sampleSkyScan(SCAN, crops[byAnchorOf(uv)], uv)) fromCrop++;
  });
  expect(close).toBeGreaterThan(LIGHTS.length * 0.97);
  // Most strokes read lights.webp; the outer rim band reads frame.webp past the 1.1 r crops.
  expect(fromCrop).toBeGreaterThan(LIGHTS.length * 0.5);
  expect(fromCrop).toBeLessThan(LIGHTS.length);
});

test('regions.png reads stars and moon at every anchor centre', () => {
  for (const anchor of ANCHORS) {
    const region = anchor.kind === 'moon' ? REGION.moon : REGION.stars;
    expect(regionAt(SOURCE.regions, anchor.uv[0], anchor.uv[1]), anchor.note).toBe(region);
  }
});

/**
 * `skyLightThin` takes the half extent the shader passes: half the drawn diagonal after the haze
 * growth (`HAZE_GROWTH` times `uHazeThickness`). A far-band haze stroke's at thickness 0 and 1. The
 * tests below that use HAZE_HALF_THIN are thickness-0 cases.
 */
const HAZE_HALF_THIN = 0.5 * Math.hypot(...HAZE_STROKE_SIZE) * DEFAULT_BAND_SIZE.far;
const HAZE_HALF_THICK = HAZE_HALF_THIN * (1 + HAZE_GROWTH);

test('each cone holds its whole disc and rim band, seen from the painter eye', () => {
  const groups = byAnchor();
  groups.forEach((group, a) => {
    for (const i of group) {
      expect(skyLightCulled(PAINTER_EYE, LIGHTS[i].position, 0, [CONES[a]])).toBe(true);
    }
  });
});

test('the cones cull haze in front of every disc, from any eye, and nothing far from one', () => {
  const half = HAZE_HALF_THIN;
  const r = (HAZE_RADIUS.min + HAZE_RADIUS.max) / 2;
  for (const eye of [PAINTER_EYE, [20, 1.6, 0] as Vec3, [-15, 30, 25] as Vec3]) {
    for (const cone of CONES) {
      const d: Vec3 = [cone.centre[0] - eye[0], cone.centre[1] - eye[1], cone.centre[2] - eye[2]];
      const len = Math.hypot(...d);
      const p: Vec3 = [
        eye[0] + (d[0] / len) * r,
        eye[1] + (d[1] / len) * r,
        eye[2] + (d[2] / len) * r,
      ];
      expect(skyLightCulled(eye, p, half, CONES)).toBe(true);
    }
  }
  // Straight ahead at the horizon and behind the painter, no disc is near.
  expect(skyLightCulled(PAINTER_EYE, [0, 1.6, -50], half, CONES)).toBe(false);
  expect(skyLightCulled(PAINTER_EYE, [0, 20, 50], half, CONES)).toBe(false);
  // An unused slot (radius 0) culls nothing, even straight at its centre.
  expect(
    skyLightCulled(PAINTER_EYE, [0, 1.6, -50], half, [
      { centre: [0, 1.6, -120], radius: 0, feather: 10 },
    ]),
  ).toBe(false);
  // Behind the painter, no feather reaches either: the haze draws at full size.
  expect(skyLightThin(PAINTER_EYE, [0, 20, 50], half, CONES)).toBe(1);
});

test('a haze stroke just inside a cone is culled and one just outside is kept, from two eyes', () => {
  // The cone's edge: asin(radius / distance to the centre) plus asin(half extent / distance to the
  // stroke) off the eye's ray to the centre.
  const half = HAZE_HALF_THIN;
  const r = (HAZE_RADIUS.min + HAZE_RADIUS.max) / 2;
  const margin = 1e-4;
  for (const eye of [PAINTER_EYE, [20, 1.6, 0] as Vec3]) {
    for (const cone of CONES) {
      const a: Vec3 = [cone.centre[0] - eye[0], cone.centre[1] - eye[1], cone.centre[2] - eye[2]];
      const lenA = Math.hypot(...a);
      const axis: Vec3 = [a[0] / lenA, a[1] / lenA, a[2] / lenA];
      // A unit vector across the axis, in the horizontal plane.
      const across: Vec3 = [-axis[2], 0, axis[0]];
      const lenX = Math.hypot(...across);
      const edge = Math.asin(cone.radius / lenA) + Math.asin(half / r);
      const at = (angle: number): Vec3 => {
        const p = (k: number): number =>
          eye[k] + r * (Math.cos(angle) * axis[k] + (Math.sin(angle) * across[k]) / lenX);
        return [p(0), p(1), p(2)];
      };
      expect(skyLightCulled(eye, at(edge - margin), half, [cone])).toBe(true);
      expect(skyLightCulled(eye, at(edge + margin), half, [cone])).toBe(false);
      expect(skyLightCulled(eye, at(-(edge - margin)), half, [cone])).toBe(true);
      expect(skyLightCulled(eye, at(-(edge + margin)), half, [cone])).toBe(false);
    }
  }
});

test('past a cone the haze ramps from 0 to full over the feather, and no shrunk quad reaches the disc', () => {
  // The feather: the cone's feather metres past its radius, as an angle from the eye, plus the
  // stroke's half-diagonal angle. The shader scales the drawn size by sqrt(thin).
  const half = HAZE_HALF_THIN;
  const r = (HAZE_RADIUS.min + HAZE_RADIUS.max) / 2;
  const margin = 1e-4;
  // The moon and the smallest star, from the painter eye and off the spot.
  const moon = ANCHORS.findIndex((a) => a.kind === 'moon');
  const small = ANCHORS.reduce((best, a, i) => (a.radius < ANCHORS[best].radius ? i : best), 0);
  for (const eye of [PAINTER_EYE, [-4, 1.6, 3] as Vec3, [20, 1.6, 0] as Vec3]) {
    for (const cone of [CONES[moon], CONES[small]]) {
      const a: Vec3 = [cone.centre[0] - eye[0], cone.centre[1] - eye[1], cone.centre[2] - eye[2]];
      const lenA = Math.hypot(...a);
      const axis: Vec3 = [a[0] / lenA, a[1] / lenA, a[2] / lenA];
      const across: Vec3 = [-axis[2], 0, axis[0]];
      const lenX = Math.hypot(...across);
      const disc = Math.asin(cone.radius / lenA);
      const beta = Math.asin(half / r);
      const edge = disc + beta;
      const feather = Math.asin((cone.radius + cone.feather) / lenA) - disc + beta;
      const at = (angle: number): Vec3 => {
        const p = (k: number): number =>
          eye[k] + r * (Math.cos(angle) * axis[k] + (Math.sin(angle) * across[k]) / lenX);
        return [p(0), p(1), p(2)];
      };
      expect(skyLightThin(eye, at(edge - margin), half, [cone])).toBe(0);
      const justOut = skyLightThin(eye, at(edge + margin), half, [cone]);
      expect(justOut).toBeGreaterThan(0);
      expect(justOut).toBeLessThan(1e-4);
      expect(skyLightThin(eye, at(edge + feather / 2), half, [cone])).toBeCloseTo(0.5, 6);
      expect(skyLightThin(eye, at(edge + feather + margin), half, [cone])).toBe(1);
      let last = 0;
      for (let k = 0; k <= 64; k++) {
        const angle = edge + (feather * k) / 64;
        const thin = skyLightThin(eye, at(angle), half, [cone]);
        expect(thin).toBeGreaterThanOrEqual(last);
        last = thin;
        // The drawn quad reaches sqrt(thin) half diagonals: its widest angle off its centre's ray
        // still clears the disc's cone.
        expect(angle - Math.asin((Math.sqrt(thin) * half) / r)).toBeGreaterThanOrEqual(disc);
      }
    }
  }
});

test('the early-out never changes the factor, around and far beyond every feather', () => {
  // Sweep each cone's ray outward, in four directions across it, from the edge to past the
  // feather's far end, at three half extents (0 and the drawn far-band haze size included). A
  // feather-0 copy of each cone exercises the SKY_LIGHT_MIN_FEATHER floor.
  const cones: SkyLightCone[] = [...CONES, ...CONES.map((c) => ({ ...c, feather: 0 }))];
  let skipped = 0;
  for (const eye of [
    PAINTER_EYE,
    [-4, 1.6, 3] as Vec3,
    [20, 1.6, 0] as Vec3,
    [0, 40, -40] as Vec3,
  ]) {
    for (const r of [HAZE_RADIUS.min, HAZE_RADIUS.max]) {
      for (const half of [0, HAZE_HALF_THIN, HAZE_HALF_THICK, 6]) {
        for (const cone of cones) {
          const a: Vec3 = [
            cone.centre[0] - eye[0],
            cone.centre[1] - eye[1],
            cone.centre[2] - eye[2],
          ];
          const lenA = Math.hypot(...a);
          const axis: Vec3 = [a[0] / lenA, a[1] / lenA, a[2] / lenA];
          const u0: Vec3 = [-axis[2], 0, axis[0]];
          const lu = Math.hypot(...u0);
          const u: Vec3 = [u0[0] / lu, u0[1] / lu, u0[2] / lu];
          const v: Vec3 = [
            axis[1] * u[2] - axis[2] * u[1],
            axis[2] * u[0] - axis[0] * u[2],
            axis[0] * u[1] - axis[1] * u[0],
          ];
          const beta = Math.asin(Math.min(1, half / r));
          const outer = Math.asin(Math.min(1, (cone.radius + cone.feather) / lenA));
          const end = outer + 2 * beta + SKY_LIGHT_MIN_FEATHER;
          for (let k = 0; k <= 200; k++) {
            const angle = (end * 1.6 * k) / 200;
            for (const phi of [0, 1.3, 2.9, 4.4]) {
              const dir = [0, 1, 2].map(
                (j) =>
                  Math.cos(angle) * axis[j] +
                  Math.sin(angle) * (Math.cos(phi) * u[j] + Math.sin(phi) * v[j]),
              );
              const p: Vec3 = [eye[0] + r * dir[0], eye[1] + r * dir[1], eye[2] + r * dir[2]];
              const fast = skyLightThin(eye, p, half, [cone]);
              const slow = skyLightThin(eye, p, half, [cone], false);
              expect(fast).toBe(slow);
              if (angle > end && half < 6) skipped++;
            }
          }
        }
      }
    }
  }
  // The sweep reaches well past the far end, where the early-out takes over.
  expect(skipped).toBeGreaterThan(10_000);
  // The whole cone set at once, over the real haze shell: the same factor either way.
  for (let i = 0; i < 2000; i++) {
    const az = (i * 2.399963) % (2 * Math.PI);
    const el = -0.1 + ((i * 0.618034) % 1) * 0.9;
    const r = HAZE_RADIUS.min + ((i * 0.414214) % 1) * (HAZE_RADIUS.max - HAZE_RADIUS.min);
    const p: Vec3 = [
      PAINTER_EYE[0] + r * Math.cos(el) * Math.sin(az),
      PAINTER_EYE[1] + r * Math.sin(el),
      PAINTER_EYE[2] - r * Math.cos(el) * Math.cos(az),
    ];
    const half = HAZE_HALF_THIN;
    expect(skyLightThin(PAINTER_EYE, p, half, CONES)).toBe(
      skyLightThin(PAINTER_EYE, p, half, CONES, false),
    );
  }
}, 30_000);

test('at full haze thickness no shrunk quad reaches a disc, from any eye up to the boundary', () => {
  // uHazeThickness 1: the shader judges the 1.5x grown quad, so the half extent is HAZE_HALF_THICK.
  // Eyes include flight's reach: 40 m up and the 55 m boundary clamp, inside the haze shell.
  const half = HAZE_HALF_THICK;
  const moon = ANCHORS.findIndex((a) => a.kind === 'moon');
  const small = ANCHORS.reduce((best, a, i) => (a.radius < ANCHORS[best].radius ? i : best), 0);
  const large = ANCHORS.reduce((best, a, i) => (a.radius > ANCHORS[best].radius ? i : best), 0);
  let ramped = 0;
  const eyes: Vec3[] = [
    PAINTER_EYE,
    [20, 1.6, 0],
    [0, 41.6, -30],
    [-38.9, 30, -38.9],
    [0, 10, -55],
  ];
  for (const eye of eyes) {
    for (const cone of [CONES[moon], CONES[small], CONES[large]]) {
      const a: Vec3 = [cone.centre[0] - eye[0], cone.centre[1] - eye[1], cone.centre[2] - eye[2]];
      const lenA = Math.hypot(...a);
      const axis: Vec3 = [a[0] / lenA, a[1] / lenA, a[2] / lenA];
      const across: Vec3 = [-axis[2], 0, axis[0]];
      const lenX = Math.hypot(...across);
      const disc = Math.asin(cone.radius / lenA);
      for (const r of [8, 25, HAZE_RADIUS.min, HAZE_RADIUS.max]) {
        for (let k = 0; k <= 400; k++) {
          const angle = (Math.PI / 2) * (k / 400);
          const at = (j: number): number =>
            eye[j] + r * (Math.cos(angle) * axis[j] + (Math.sin(angle) * across[j]) / lenX);
          const p: Vec3 = [at(0), at(1), at(2)];
          const thin = skyLightThin(eye, p, half, [cone]);
          if (thin === 0) continue;
          if (thin < 1) ramped++;
          // The drawn quad reaches sqrt(thin) grown half diagonals off its centre: its widest angle
          // off the centre's ray still clears the disc's cone.
          const reach = Math.asin(Math.min(1, (Math.sqrt(thin) * half) / r));
          expect(angle - reach).toBeGreaterThanOrEqual(disc);
        }
      }
    }
  }
  expect(ramped).toBeGreaterThan(100);
});

test('an eye at a cone centre gives a number, not NaN', () => {
  const cone = CONES[0];
  const thin = skyLightThin(cone.centre, [0, 1.6, -50], 2.4, [cone]);
  expect(Number.isNaN(thin)).toBe(false);
});

test('two lights whose feathers overlap combine as the product of their factors', () => {
  // The two nearest cones, and haze strokes inside both of their feathers.
  let best: [number, number] = [0, 1];
  let bestD = Infinity;
  for (let i = 0; i < CONES.length; i++) {
    for (let j = i + 1; j < CONES.length; j++) {
      const d = Math.hypot(
        CONES[i].centre[0] - CONES[j].centre[0],
        CONES[i].centre[1] - CONES[j].centre[1],
        CONES[i].centre[2] - CONES[j].centre[2],
      );
      if (d < bestD) {
        bestD = d;
        best = [i, j];
      }
    }
  }
  const [a, b] = best.map((i) => CONES[i]);
  const half = HAZE_HALF_THIN;
  const r = (HAZE_RADIUS.min + HAZE_RADIUS.max) / 2;
  let both = 0;
  // Haze strokes on a grid of directions over the forward sky, around both lights.
  for (let i = 0; i < 4096; i++) {
    const az = -Math.PI / 2 + (Math.PI * (i % 64)) / 63;
    const el = (Math.PI / 2) * (Math.floor(i / 64) / 63);
    const p: Vec3 = [
      PAINTER_EYE[0] + r * Math.cos(el) * Math.sin(az),
      PAINTER_EYE[1] + r * Math.sin(el),
      PAINTER_EYE[2] - r * Math.cos(el) * Math.cos(az),
    ];
    const fa = skyLightThin(PAINTER_EYE, p, half, [a]);
    const fb = skyLightThin(PAINTER_EYE, p, half, [b]);
    const fab = skyLightThin(PAINTER_EYE, p, half, [a, b]);
    expect(fab).toBe(fa * fb);
    if (fa > 0 && fa < 1 && fb > 0 && fb < 1) both++;
  }
  // The pair's feathers do overlap: some strokes between them are inside both ramps.
  expect(both).toBeGreaterThan(0);
});

test('each feather is SKY_LIGHT_FEATHER anchor radii, at least the halo band', () => {
  expect(SKY_LIGHT_FEATHER).toBeGreaterThanOrEqual(SKY_LIGHT_RIM);
  CONES.forEach((cone, i) => {
    expect(cone.feather).toBeCloseTo(
      SKY_LIGHT_FEATHER * ANCHORS[i].radius * metresPerWidth(ANCHORS[i]),
      9,
    );
    expect(cone.feather).toBeGreaterThan(0);
  });
});

test('the cull flag bit is free, the defines and uniforms match, and the GLSL holds the mirror steps', () => {
  // Bit 7 is free: no other iMeta.w flag or the fit level field uses it.
  const taken =
    DEPTH_TIE_BREAK_FRONT_FLAG |
    DEPTH_BACKDROP_FLAG |
    DEPTH_RANKED_FLAG |
    (FIT_SCALE_MASK << FIT_SCALE_SHIFT);
  expect(SKY_LIGHT_CULL_FLAG).toBe(128);
  expect(taken & SKY_LIGHT_CULL_FLAG).toBe(0);
  const material = createStrokeMaterial(new Texture());
  expect(material.defines.SKY_LIGHT_CONES).toBe(SKY_LIGHT_CONES);
  expect(material.defines.SKY_LIGHT_CULL_FLAG).toBe('128u');
  expect(material.uniforms.uSkyLightCones.value).toHaveLength(SKY_LIGHT_CONES);
  expect(material.uniforms.uSkyLightCones.value.every((v) => v.w === 0)).toBe(true);
  expect(material.uniforms.uSkyLightFeathers.value).toHaveLength(SKY_LIGHT_CONES);
  expect(material.uniforms.uSkyLightFeathers.value.every((f) => f === 0)).toBe(true);
  const uniforms = skyLightConeUniforms(CONES);
  const feathers = skyLightFeatherUniforms(CONES);
  CONES.forEach((cone, i) => {
    expect(uniforms[i].toArray()).toEqual([...cone.centre, cone.radius]);
    expect(feathers[i]).toBe(cone.feather);
  });
  expect(CONES).toHaveLength(SKY_LIGHT_CONES);

  const glsl = readFileSync('src/render/strokes/stroke.vert.glsl', 'utf8');
  for (const line of [
    'uniform vec4 uSkyLightCones[SKY_LIGHT_CONES];',
    'uniform vec3 cameraPosition;',
    'vec3 eye = cameraPosition;',
    'float sinB = min(1.0, halfExtent / lenH);',
    'float cosB = sqrt(1.0 - sinB * sinB);',
    'if (cone.w <= 0.0) continue;',
    'float sinA = min(1.0, cone.w / lenA);',
    'float cosA = sqrt(1.0 - sinA * sinA);',
    'uniform float uSkyLightFeathers[SKY_LIGHT_CONES];',
    'float beta = asin(sinB);',
    'float d = dot(a, h);',
    'if (d > (cosA * cosB - sinA * sinB) * lenA * lenH) return 0.0;',
    'float alpha = asin(sinA);',
    'float feather = max(SKY_LIGHT_MIN_FEATHER, asin(sinO) - alpha + beta);',
    // The early-out and its guards.
    'float lenA = max(length(a), 1e-3);',
    'float cos2B = 1.0 - 2.0 * sinB * sinB;',
    'float sin2B = 2.0 * sinB * cosB;',
    'float cosK = cos2B * SKY_LIGHT_MIN_FEATHER_COS - sin2B * SKY_LIGHT_MIN_FEATHER_SIN;',
    'float sinK = sin2B * SKY_LIGHT_MIN_FEATHER_COS + cos2B * SKY_LIGHT_MIN_FEATHER_SIN;',
    'bool early = sinB <= 0.5;',
    'float sinO = min(1.0, (cone.w + uSkyLightFeathers[i]) / lenA);',
    'float cosO = sqrt(1.0 - sinO * sinO);',
    'if (early && sinO < 1.0 && d <= (cosO * cosK - sinO * sinK) * lenA * lenH) continue;',
    'float gap = acos(clamp(d / (lenA * lenH), -1.0, 1.0)) - alpha - beta;',
    'thin *= smoothstep(0.0, feather, gap);',
    'if ((iMeta.w & SKY_LIGHT_CULL_FLAG) != 0u) {',
    // The margin is the drawn quad's full half diagonal, before the shrink, plus the motion reach
    // while the gate is open (R-P4b).
    'thin = skyLightThin((modelMatrix * vec4(iPosition, 1.0)).xyz, 0.5 * length(size) + reach);',
    'size *= sqrt(thin);',
    'if (thin <= 0.0) {',
    'gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
  ]) {
    expect(glsl).toContain(line);
  }
  // The haze growth comes first, so the thin judges the grown quad; the shrink comes before the
  // quad's corners are placed.
  expect(glsl.indexOf('sizeScale *= 1.0 + HAZE_GROWTH * uHazeThickness;')).toBeLessThan(
    glsl.indexOf('vec2 size = iSize * sizeScale;'),
  );
  expect(glsl.indexOf('vec2 size = iSize * sizeScale;')).toBeLessThan(
    glsl.indexOf('thin = skyLightThin('),
  );
  expect(glsl.indexOf('size *= sqrt(thin);')).toBeLessThan(glsl.indexOf('vec3 local = iPosition'));
  // The early-out runs before any inverse trigonometry in the loop.
  const loop = glsl.slice(glsl.indexOf('float skyLightThin('));
  expect(loop.indexOf('if (early && sinO < 1.0')).toBeLessThan(loop.indexOf('asin('));
  expect(material.defines.SKY_LIGHT_MIN_FEATHER_COS).toBe(
    Math.cos(SKY_LIGHT_MIN_FEATHER).toExponential(8),
  );
  expect(material.defines.SKY_LIGHT_MIN_FEATHER_SIN).toBe(
    Math.sin(SKY_LIGHT_MIN_FEATHER).toExponential(8),
  );

  // The shader's eye is three's cameraPosition, which the renderer sets from each camera's
  // matrixWorld in the same per-camera block as viewMatrix, so each XR eye (its own camera in the
  // XR ArrayCamera) culls from its own position.
  const three = readFileSync('node_modules/three/build/three.module.js', 'utf8');
  const block = three.indexOf(
    "p_uniforms.setValue( _gl, 'viewMatrix', camera.matrixWorldInverse );",
  );
  expect(block).toBeGreaterThan(0);
  expect(three.slice(block, block + 400)).toContain(
    'uCamPos.setValue( _gl, _vector3.setFromMatrixPosition( camera.matrixWorld ) );',
  );
});

test('the lights are deterministic per seed', () => {
  const again = createSkyLights(SOURCE, SCAN, 1, WORLD_DOME_SIZE).strokes;
  expect(again).toEqual(LIGHTS);
  const other = createSkyLights(SOURCE, SCAN, 2, WORLD_DOME_SIZE).strokes;
  // The rim band keeps strokes at random, so the count moves a little with the seed.
  expect(Math.abs(other.length - LIGHTS.length)).toBeLessThan(LIGHTS.length * 0.05);
  expect(other[0].position).not.toEqual(LIGHTS[0].position);
});
