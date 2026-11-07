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
import { createStrokeMaterial } from '../src/render/strokes/material.ts';
import { SCATTER_SIZE_JITTER, strokeSizeAt } from '../src/render/strokes/scatter.ts';
import {
  SKY_LIGHT_CONES,
  SKY_LIGHT_CULL_FLAG,
  skyLightConeUniforms,
  skyLightCulled,
} from '../src/render/strokes/sky-light-cull.ts';
import { HAZE_RADIUS } from '../src/world/boundary.ts';
import { SKY_DOME_RADIUS, skyAnchors } from '../src/world/sky.ts';
import {
  createSkyLights,
  metresPerWidth,
  RankPicker,
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

test('each cone holds its whole disc and rim band, seen from the painter eye', () => {
  const groups = byAnchor();
  groups.forEach((group, a) => {
    for (const i of group) {
      expect(skyLightCulled(PAINTER_EYE, LIGHTS[i].position, 0, [CONES[a]])).toBe(true);
    }
  });
});

test('the cones cull haze in front of every disc, from any eye, and nothing far from one', () => {
  const half = 2.4;
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
    skyLightCulled(PAINTER_EYE, [0, 1.6, -50], half, [{ centre: [0, 1.6, -120], radius: 0 }]),
  ).toBe(false);
});

test('a haze stroke just inside a cone is culled and one just outside is kept, from two eyes', () => {
  // The cone's edge: asin(radius / distance to the centre) plus asin(half extent / distance to the
  // stroke) off the eye's ray to the centre.
  const half = 2.4;
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
  const uniforms = skyLightConeUniforms(CONES);
  CONES.forEach((cone, i) => {
    expect(uniforms[i].toArray()).toEqual([...cone.centre, cone.radius]);
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
    'if (dot(a, h) > (cosA * cosB - sinA * sinB) * lenA * lenH) return true;',
    '(iMeta.w & SKY_LIGHT_CULL_FLAG) != 0u &&',
    // The margin is the drawn quad's half diagonal.
    'skyLightCulled((modelMatrix * vec4(iPosition, 1.0)).xyz, 0.5 * length(size))',
    'gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
  ]) {
    expect(glsl).toContain(line);
  }

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
