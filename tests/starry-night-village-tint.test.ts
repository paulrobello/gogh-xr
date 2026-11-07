import { beforeAll, describe, expect, test } from 'vitest';
import { loadRealSource } from '../scripts/scatter-time.ts';
import { LAYER_REGION } from '../src/paintings/starry-night/canvas-camera.ts';
import type { CanvasSample, CanvasSource } from '../src/paintings/starry-night/canvas-histogram.ts';
import {
  jitterTint,
  LIFT_PIVOT_QUANTILE,
  liftLightness,
  lightnessQuantile,
  pickTint,
  type Rgb,
  raiseLightness,
  SEEN_WALL_LIFT,
  splitTintBands,
  srgbToLab,
  TINT_NEIGHBOURS,
  TINT_ROLE,
  type TintBands,
  type TintTags,
  tintSeed,
} from '../src/paintings/starry-night/village-tint.ts';
import {
  createWorldGeometry,
  scatterWorld,
  worldSeeds,
} from '../src/paintings/starry-night/world.ts';
import type { Vec3 } from '../src/render/strokes/frame.ts';
import {
  outlinePaint,
  tintLookup,
  villagePaint,
  WORLD_LAYERS,
} from '../src/render/strokes/scatter.ts';
import { mulberry32 } from '../src/util/prng.ts';

const key = (rgb: Rgb): string => rgb.join(',');
const BUILDING = WORLD_LAYERS.indexOf('building');
const ROOF = WORLD_LAYERS.indexOf('roof');

let source: CanvasSource;
let bands: TintBands;
beforeAll(async () => {
  source = await loadRealSource();
  bands = splitTintBands(source.histogram);
});

describe('the village tint bands (ruling Q28)', () => {
  test('the split is deterministic and its bands are ordered by lightness', () => {
    expect(splitTintBands(source.histogram)).toEqual(bands);
    const roof = bands[TINT_ROLE.roof].lightness;
    const wall = bands[TINT_ROLE.wall].lightness;
    const church = bands[TINT_ROLE.churchWall].lightness;
    expect(roof[1]).toBeLessThan(wall[0]);
    expect(wall[1]).toBeLessThan(church[0]);
  });

  test('house walls draw only from the light band, roofs only from the dark band', () => {
    const light = new Set(bands[TINT_ROLE.wall].rgb.map(key));
    const dark = new Set(bands[TINT_ROLE.roof].rgb.map(key));
    for (let house = 0; house < 20; house++) {
      const wall = pickTint(bands[TINT_ROLE.wall], tintSeed(1, BUILDING, house, TINT_ROLE.wall));
      const roof = pickTint(bands[TINT_ROLE.roof], tintSeed(1, ROOF, house, TINT_ROLE.roof));
      for (const c of [wall.rgb, ...wall.choices]) expect(light.has(key(c)), key(c)).toBe(true);
      for (const c of [roof.rgb, ...roof.choices]) expect(dark.has(key(c)), key(c)).toBe(true);
    }
  });

  test('one house is consistent: every stroke is one of the bins nearest its tint', () => {
    const tint = pickTint(bands[TINT_ROLE.wall], tintSeed(1, BUILDING, 3, TINT_ROLE.wall));
    expect(tint.choices).toHaveLength(TINT_NEIGHBOURS);
    expect(key(tint.choices[0])).toBe(key(tint.rgb));
    const again = pickTint(bands[TINT_ROLE.wall], tintSeed(1, BUILDING, 3, TINT_ROLE.wall));
    expect(again).toEqual(tint);
    const allowed = new Set(tint.choices.map(key));
    const rng = mulberry32(9);
    const lab = srgbToLab(tint.rgb);
    for (let i = 0; i < 2000; i++) {
      const c = jitterTint(tint, rng);
      expect(allowed.has(key(c))).toBe(true);
      const d = srgbToLab(c);
      // Bounded jitter: a neighbouring 5-bit bin, well under a just-noticeable step of the band.
      expect(Math.hypot(d[0] - lab[0], d[1] - lab[1], d[2] - lab[2])).toBeLessThan(12);
    }
  });

  test('neighbouring houses differ', () => {
    const tints = Array.from({ length: 20 }, (_, house) =>
      key(pickTint(bands[TINT_ROLE.wall], tintSeed(1, BUILDING, house, TINT_ROLE.wall)).rgb),
    );
    expect(tints[0]).not.toBe(tints[1]);
    expect(new Set(tints).size).toBeGreaterThanOrEqual(10);
  });

  test('the village geometry is tagged per triangle: house walls, roofs, church walls and spire', () => {
    const { village } = createWorldGeometry(worldSeeds(1));
    const tags = (layer: 'building' | 'roof' | 'church'): TintTags =>
      village.geometries[layer].userData.tint as TintTags;
    const triangles = (layer: 'building' | 'roof' | 'church'): number =>
      village.geometries[layer].getAttribute('position').count / 3;
    for (const layer of ['building', 'roof', 'church'] as const) {
      expect(tags(layer).owner).toHaveLength(triangles(layer));
      expect(tags(layer).role).toHaveLength(triangles(layer));
    }
    expect(new Set(tags('building').owner).size).toBe(village.houses.length);
    expect(new Set(tags('building').role)).toEqual(new Set([TINT_ROLE.wall]));
    expect(new Set(tags('roof').role)).toEqual(new Set([TINT_ROLE.roof]));
    // Tower shaft (8), nave walls with gables (10) and spire (4) take the church wall tint (ruling
    // Q30); only the nave roof (4) stays dark.
    const church = Array.from(tags('church').role);
    expect(church.filter((r) => r === TINT_ROLE.churchWall)).toHaveLength(22);
    expect(church.filter((r) => r === TINT_ROLE.roof)).toHaveLength(4);
  });

  test('the church lift moves only L* above the pivot, toward the target, keeping the hue', () => {
    const pivot = 50;
    const trim: Rgb = [60, 70, 90];
    expect(srgbToLab(trim)[0]).toBeLessThan(pivot);
    expect(liftLightness(trim, pivot, 90, 1)).toEqual(trim);
    const pale: Rgb = [150, 160, 170];
    const before = srgbToLab(pale);
    expect(liftLightness(pale, pivot, 90, 0)).toEqual(pale);
    const half = srgbToLab(liftLightness(pale, pivot, 90, 0.5));
    expect(half[0]).toBeCloseTo(before[0] + 0.5 * (90 - before[0]), 0);
    expect(Math.hypot(half[1] - before[1], half[2] - before[2])).toBeLessThan(2);
  });

  // A point the painter faces from 10 m: its stroke is seen when its sample is not extrapolated.
  const SEEN_POINT: Vec3 = [0, 1.6, -10];
  const TOWARD_PAINTER: Vec3 = [0, 0, 1];
  const sample = (rgb: Rgb, extrapolated = false): CanvasSample => ({
    rgb,
    flowAngle: 0,
    extrapolated,
  });

  test('a seen house-wall scan pixel darker than the wall band is raised to its floor', () => {
    const floor = bands[TINT_ROLE.wall].lightness[0];
    const dark: Rgb = [40, 50, 80];
    const before = srgbToLab(dark);
    expect(before[0]).toBeLessThan(floor);
    const raised = srgbToLab(raiseLightness(dark, floor, SEEN_WALL_LIFT));
    // 8-bit rounding moves L* by under 0.6.
    expect(raised[0]).toBeGreaterThan(floor - (1 - SEEN_WALL_LIFT) * (floor - before[0]) - 0.6);
    expect(Math.hypot(raised[1] - before[1], raised[2] - before[2])).toBeLessThan(3);
    const pale: Rgb = [200, 200, 190];
    expect(raiseLightness(pale, floor, 1)).toEqual(pale);

    const { village } = createWorldGeometry(worldSeeds(1));
    const tags = village.geometries.building.userData.tint as TintTags;
    const paintOf = tintLookup(tags, bands, 1, 'building', BUILDING, source);
    const paint = paintOf(0);
    const rng = mulberry32(3);
    const seen = srgbToLab(
      villagePaint(sample(dark), paint, SEEN_POINT, TOWARD_PAINTER, 'building', rng),
    );
    expect(seen[0]).toBeGreaterThan(floor - (1 - SEEN_WALL_LIFT) * (floor - before[0]) - 0.6);
  });

  test('the outlines of every structure draw from their region trim, at or below the pivot (ruling Q31)', () => {
    const { village } = createWorldGeometry(worldSeeds(1));
    const pale = sample([230, 230, 225]);
    const dark: Rgb = [20, 25, 40];
    const rng = mulberry32(5);
    for (const layer of ['building', 'roof', 'church'] as const) {
      const tags = village.geometries[layer].userData.tint as TintTags;
      const paintOf = tintLookup(tags, bands, 1, layer, WORLD_LAYERS.indexOf(layer), source);
      const pivot = lightnessQuantile(source.histogram, LAYER_REGION[layer], LIFT_PIVOT_QUANTILE);
      for (const role of new Set(tags.role)) {
        const paint = paintOf(Array.from(tags.role).indexOf(role));
        for (let i = 0; i < 100; i++) {
          for (const s of [pale, sample(dark), sample([210, 210, 210], true)]) {
            const rgb = outlinePaint(s, paint, SEEN_POINT, TOWARD_PAINTER, rng);
            expect(srgbToLab(rgb)[0]).toBeLessThanOrEqual(pivot);
          }
        }
        // Painted trim the painter sees keeps its scan colour.
        expect(outlinePaint(sample(dark), paint, SEEN_POINT, TOWARD_PAINTER, rng)).toEqual(dark);
      }
    }
  });

  test('the tint changes only stroke colour: placement is bit-identical to untagged geometry', () => {
    const seeds = worldSeeds(1);
    const tagged = createWorldGeometry(seeds);
    const plain = createWorldGeometry(seeds);
    for (const g of [
      plain.village.geometries.building,
      plain.village.geometries.roof,
      plain.village.geometries.church,
    ]) {
      delete g.userData.tint;
    }
    const a = scatterWorld(plain, source, seeds);
    const b = scatterWorld(tagged, source, seeds);
    expect(b.count).toBe(a.count);
    for (const field of ['position', 'normal', 'tangent', 'size', 'meta'] as const) {
      let differ = 0;
      for (let i = 0; i < a[field].length; i++) if (!Object.is(a[field][i], b[field][i])) differ++;
      expect(differ, field).toBe(0);
    }
    let recoloured = 0;
    for (let i = 0; i < a.color.length; i++) if (a.color[i] !== b.color[i]) recoloured++;
    expect(recoloured).toBeGreaterThan(0);
  }, 60_000);
});
