import { readFileSync } from 'node:fs';
import { Texture } from 'three';
import { expect, test } from 'vitest';
import { loadRealSource, loadSkyScan } from '../scripts/scatter-time.ts';
import { REGION, regionAt } from '../src/demo/canvas/field.ts';
import { decodedNormal, strokeShade } from '../src/demo/canvas/placement.ts';
import {
  CANVAS_ASPECT,
  PAINTER_EYE,
  projectToCanvas,
} from '../src/paintings/starry-night/canvas-camera.ts';
import {
  backdropRank,
  backdropTier,
  DEPTH_BACKDROP_FLAG,
} from '../src/render/strokes/backdrop-depth.ts';
import {
  DEPTH_RANKED_FLAG,
  DEPTH_TIE_BREAK_FRONT_FLAG,
} from '../src/render/strokes/depth-tie-break.ts';
import { FIT_SCALE_MASK, FIT_SCALE_SHIFT } from '../src/render/strokes/face-clamp.ts';
import type { Vec3 } from '../src/render/strokes/frame.ts';
import { STROKE_LAYER } from '../src/render/strokes/instance.ts';
import { createStrokeMaterial } from '../src/render/strokes/material.ts';
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
  RankPicker,
  SKY_LIGHT_RANK_REACH,
  skyLightCones,
  skyLightMaxLength,
} from '../src/world/sky-lights.ts';
import { sampleSkyScan, skyScanCrops } from '../src/world/sky-scan.ts';

const SOURCE = await loadRealSource();
const SCAN = await loadSkyScan();
const ANCHORS = skyAnchors();
const RESULT = createSkyLights(SOURCE, SCAN, 1);
const LIGHTS = RESULT.strokes;
const CONES = skyLightCones(ANCHORS);

/** Painting-width distance between two canvas uvs: v units are CANVAS_ASPECT longer. */
function widthDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], (a[1] - b[1]) / CANVAS_ASPECT);
}

/** The strokes of each anchor, by the anchor nearest to each stroke's projected uv. */
function byAnchor(): number[][] {
  const groups: number[][] = ANCHORS.map(() => []);
  LIGHTS.forEach((s, i) => {
    const uv = projectToCanvas(s.position).uv ?? [9, 9];
    let best = 0;
    for (let a = 1; a < ANCHORS.length; a++) {
      if (widthDistance(uv, ANCHORS[a].uv) < widthDistance(uv, ANCHORS[best].uv)) best = a;
    }
    groups[best].push(i);
  });
  return groups;
}

test('the moon and every star get strokes on their own stroke layers', () => {
  const groups = byAnchor();
  ANCHORS.forEach((anchor, a) => {
    expect(groups[a].length, anchor.note).toBeGreaterThan(100);
    const layer = anchor.kind === 'moon' ? STROKE_LAYER.moon : STROKE_LAYER.star;
    for (const i of groups[a]) expect(LIGHTS[i].layer).toBe(layer);
  });
  expect(LIGHTS.filter((s) => s.layer === STROKE_LAYER.moon).length).toBeGreaterThan(1_000);
  expect(LIGHTS.filter((s) => s.layer === STROKE_LAYER.star).length).toBeGreaterThan(1_000);
});

test('each disc sits on its projected anchor and inside its circle', () => {
  const groups = byAnchor();
  ANCHORS.forEach((anchor, a) => {
    let su = 0;
    let sv = 0;
    for (const i of groups[a]) {
      const s = LIGHTS[i];
      // On the dome, x moved by a few float32 steps (micrometres each) to take its rank.
      const d = s.position.map((p, k) => p - PAINTER_EYE[k]);
      const r = Math.hypot(d[0], d[1], d[2]);
      expect(Math.abs(r - SKY_DOME_RADIUS)).toBeLessThan(0.01);
      const uv = projectToCanvas(s.position).uv ?? [9, 9];
      // Ring jitter reaches 0.3 of a ring spacing past the rim.
      expect(widthDistance(uv, anchor.uv), anchor.note).toBeLessThanOrEqual(anchor.radius * 1.05);
      su += uv[0];
      sv += uv[1];
    }
    const n = groups[a].length;
    expect(widthDistance([su / n, sv / n], anchor.uv), anchor.note).toBeLessThan(
      0.05 * anchor.radius,
    );
  });
});

test('strokes face the eye, run along their ring and carry the backdrop flag in the front tier', () => {
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

test('strokes that can overlap never share a front-tier rank', () => {
  // Same-rank strokes sit at one NDC z, where the GPU's rounding can flip them under head motion.
  // Two quads of the widest brush (aspect 0.833) can overlap only when their centres are closer
  // than sqrt(1 + 0.833²), about 1.3, times the longest drawn length after jitter: 0.0179
  // painting widths for a star, 0.0090 for the half-length moon strokes.
  const groups = byAnchor();
  let pairs = 0;
  let shared = 0;
  let mostNeighbours = 0;
  groups.forEach((group, a) => {
    const reach = skyLightMaxLength(ANCHORS[a].kind) * SKY_LIGHT_RANK_REACH;
    const uv = group.map((i) => projectToCanvas(LIGHTS[i].position).uv ?? [9, 9]);
    const rank = group.map((i) => backdropRank(LIGHTS[i].position, LIGHTS[i].layer));
    const cells = new Map<string, number[]>();
    const cellOf = (p: readonly number[]): [number, number] => [
      Math.floor(p[0] / reach),
      Math.floor(p[1] / CANVAS_ASPECT / reach),
    ];
    uv.forEach((p, i) => {
      const key = cellOf(p).join(',');
      cells.set(key, [...(cells.get(key) ?? []), i]);
    });
    uv.forEach((p, i) => {
      const [cx, cy] = cellOf(p);
      let neighbours = 0;
      for (let x = cx - 1; x <= cx + 1; x++) {
        for (let y = cy - 1; y <= cy + 1; y++) {
          for (const j of cells.get(`${x},${y}`) ?? []) {
            if (j === i || widthDistance(p, uv[j]) >= reach) continue;
            neighbours++;
            if (j < i) continue;
            pairs++;
            if (rank[i] === rank[j]) shared++;
          }
        }
      }
      mostNeighbours = Math.max(mostNeighbours, neighbours);
    });
  });
  expect(pairs).toBeGreaterThan(50_000);
  expect(shared).toBe(0);
  // Under the 256 front-tier ranks, so the greedy picker always finds a free one.
  expect(mostNeighbours).toBeLessThan(256);
  expect(RESULT.rankTies).toBe(0);
  expect(createSkyLights(SOURCE, SCAN, 2).rankTies).toBe(0);
});

test('the rank picker counts a tie once all 256 ranks are held within reach', () => {
  const picker = new RankPicker(1);
  const ranks = new Set<number>();
  for (let k = 0; k < 256; k++) ranks.add(picker.pick(0, 0, 17));
  expect(ranks.size).toBe(256);
  expect(picker.ties).toBe(0);
  // Every rank is held at this point: the stroke falls back to its start rank and counts a tie.
  expect(picker.pick(0, 0, 40)).toBe(40);
  expect(picker.ties).toBe(1);
  // Out of reach, ranks are free again.
  expect(picker.pick(5, 5, 40)).toBe(40);
  expect(picker.ties).toBe(1);
});

test('colours come from the full-resolution scan under each stroke, in every channel', () => {
  const crops = skyScanCrops(ANCHORS);
  const groups = byAnchor();
  let checked = 0;
  groups.forEach((group, a) => {
    for (const i of group) {
      const s = LIGHTS[i];
      const { uv, inFrustum } = projectToCanvas(s.position);
      // Off the frame the generator draws from the region histogram instead.
      const scan = uv && inFrustum ? sampleSkyScan(SCAN, crops[a], uv) : null;
      if (!scan) continue;
      // Partly circular: this samples the crop with the generator's own `sampleSkyScan`, so it
      // checks the crop choice, the projection and the shade division, not that lights.webp
      // matches the scan. asset-check only pins its hash in PROVENANCE.md; the per-pixel moon
      // ΔE against the scan (docs/verification.md) is the independent check.
      // The stored colour is the scan's divided by strokeShade.
      const shade = strokeShade(decodedNormal(s.normal));
      for (let k = 0; k < 3; k++) expect(s.color[k] * shade).toBeCloseTo(scan[k], 6);
      checked++;
    }
  });
  expect(checked).toBeGreaterThan(LIGHTS.length * 0.95);
});

test('regions.png reads stars and moon at every anchor centre', () => {
  for (const anchor of ANCHORS) {
    const region = anchor.kind === 'moon' ? REGION.moon : REGION.stars;
    expect(regionAt(SOURCE.regions, anchor.uv[0], anchor.uv[1]), anchor.note).toBe(region);
  }
});

test('each cone holds its whole disc, seen from the painter eye', () => {
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
  const again = createSkyLights(SOURCE, SCAN, 1).strokes;
  expect(again).toEqual(LIGHTS);
  const other = createSkyLights(SOURCE, SCAN, 2).strokes;
  expect(other.length).toBe(LIGHTS.length);
  expect(other[0].position).not.toEqual(LIGHTS[0].position);
});
