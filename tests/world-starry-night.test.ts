import {
  MeshBasicMaterial as BasicMaterial,
  Box3,
  type BufferAttribute,
  type BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  FrontSide,
  Mesh,
  type MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  RGBAFormat,
  Vector3,
} from 'three';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { loadRealSource, loadSkyScan } from '../scripts/scatter-time.ts';
import { REGION } from '../src/demo/canvas/field.ts';
import {
  BARE_COLOR,
  createBaseMeshes,
  TINT_UNDERPAINT_SHADE,
  UNDERPAINT_SHADE,
  underpaintColor,
} from '../src/paintings/starry-night/base-meshes.ts';
import {
  PAINTER_EYE,
  projectToCanvas,
  type Vec2,
} from '../src/paintings/starry-night/canvas-camera.ts';
import {
  ANGLE_BINS,
  type CanvasHistogram,
  COLOR_BITS,
} from '../src/paintings/starry-night/canvas-histogram.ts';
import { painterSpot, spawnPose } from '../src/paintings/starry-night/index.ts';
import {
  pickTint,
  splitTintBands,
  type TintRole,
  type TintTags,
  tintSeed,
} from '../src/paintings/starry-night/village-tint.ts';
import {
  assembleWorldStrokes,
  createWorldGeometry,
  RIDGE_SCATTER,
  scatterWorld,
  strokeLayerCounts,
  WORLD_CELL_SIZE,
  WORLD_SCATTER_SIZE,
  WORLD_SIZE_SCALE,
  type WorldGeometry,
  type WorldStrokes,
  worldScatterKeyInputs,
  worldSeeds,
} from '../src/paintings/starry-night/world.ts';
import { DEPTH_BACKDROP_FLAG } from '../src/render/strokes/backdrop-depth.ts';
import { DEFAULT_BAND_SIZE, STROKE_BUDGET } from '../src/render/strokes/bands.ts';
import { createStrokeBatch, type StrokeBatch } from '../src/render/strokes/batch.ts';
import {
  ATLAS_SIZE,
  BRUSH_CHANNEL,
  BRUSH_COUNT,
  BRUSHES,
  brushTexelRect,
  DEFAULT_BRUSH_SEED,
  generateBrushAtlas,
} from '../src/render/strokes/brush-atlas-data.ts';
import { DEPTH_TIE_BREAK_FRONT_FLAG } from '../src/render/strokes/depth-tie-break.ts';
import {
  BRUSH_FOOTPRINT,
  FACE_CLAMP_MARGIN,
  FIT_SCALE_MAX,
  fitScaleLimit,
} from '../src/render/strokes/face-clamp.ts';
import { strokeAxes, type Vec3 } from '../src/render/strokes/frame.ts';
import {
  STROKE_ATTRIBUTES,
  STROKE_LAYER,
  type StrokeBuffers,
  selectStrokes,
  unpackInstance,
} from '../src/render/strokes/instance.ts';
import {
  FACE_CLAMPED_LAYERS,
  LAYER_DENSITY,
  LAYER_SIZE,
  WORLD_LAYERS,
} from '../src/render/strokes/scatter.ts';
import { hashStrokeBuffers } from '../src/render/strokes/scatter-cache.ts';
import { SKY_LIGHT_CULL_FLAG } from '../src/render/strokes/sky-light-cull.ts';
import { deltaE2000, srgb8ToLab } from '../src/util/cielab.ts';
import { boundaryFactor } from '../src/world/boundary.ts';
import { CYPRESS_OUTLINE } from '../src/world/cypress.ts';
import { WINDOW_COLOR } from '../src/world/village.ts';
import { COVERAGE_POSES } from './world-poses.ts';

/** Painted footprint area into and out of the face fit, per world layer, while `on`. */
const fitLog = vi.hoisted(() => ({
  on: false,
  layerOf: new WeakMap<object, string>(),
  layers: new Map<string, { before: number; after: number; strokes: number; small: number }>(),
}));

vi.mock('../src/render/strokes/face-clamp.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/render/strokes/face-clamp.ts')>();
  return {
    ...real,
    facePolygons: (...args: Parameters<typeof real.facePolygons>) => {
      const set = real.facePolygons(...args);
      for (const face of set.faces) fitLog.layerOf.set(face, String(args[0].userData.layer));
      return set;
    },
    fitStrokeToFace: (...args: Parameters<typeof real.fitStrokeToFace>) => {
      const fitted = real.fitStrokeToFace(...args);
      const layer = fitLog.on ? fitLog.layerOf.get(args[0]) : undefined;
      if (layer !== undefined) {
        const entry = fitLog.layers.get(layer) ?? { before: 0, after: 0, strokes: 0, small: 0 };
        const before = args[1].length * args[1].width;
        const after = fitted.length * fitted.width;
        entry.before += before;
        entry.after += after;
        entry.strokes++;
        if (after < before / 4) entry.small++;
        fitLog.layers.set(layer, entry);
      }
      return fitted;
    },
  };
});

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** In-plane distance from `p` (projected onto the triangle's plane) to triangle abc, metres. */
function distanceToTriangle(p: Vec3, t: { a: Vec3; b: Vec3; c: Vec3; n: Vec3 }): number {
  const h = dot3(sub3(p, t.a), t.n);
  const q: Vec3 = [p[0] - h * t.n[0], p[1] - h * t.n[1], p[2] - h * t.n[2]];
  const corners = [t.a, t.b, t.c];
  let inside = true;
  for (let k = 0; k < 3; k++) {
    const e = sub3(corners[(k + 1) % 3], corners[k]);
    if (dot3(cross3(e, sub3(q, corners[k])), t.n) < 0) inside = false;
  }
  if (inside) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < 3; k++) {
    const a = corners[k];
    const e = sub3(corners[(k + 1) % 3], a);
    const f = Math.min(1, Math.max(0, dot3(sub3(q, a), e) / dot3(e, e)));
    const closest: Vec3 = [a[0] + f * e[0], a[1] + f * e[1], a[2] + f * e[2]];
    best = Math.min(best, Math.hypot(...sub3(q, closest)));
  }
  return best;
}

/** Each brush's opaque mask as a box centred in its quad: shares of the quad's length and width. */
function paintBoxes(seed: number): { length: number; width: number }[] {
  const atlas = generateBrushAtlas(seed);
  return Array.from({ length: BRUSH_COUNT }, (_, i) => {
    const r = brushTexelRect(i);
    let halfU = 0;
    let halfV = 0;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) {
        if (atlas[(y * ATLAS_SIZE + x) * 4 + BRUSH_CHANNEL.coverage] < 128) continue;
        halfU = Math.max(halfU, Math.abs((x + 0.5 - r.x) / r.width - 0.5));
        halfV = Math.max(halfV, Math.abs((y + 0.5 - r.y) / r.height - 0.5));
      }
    }
    return { length: 2 * halfU, width: 2 * halfV };
  });
}

const SOURCE = await loadRealSource();
const SKY_SCAN = await loadSkyScan();
const SEEDS = worldSeeds(1);
const WORLD: WorldGeometry = createWorldGeometry(SEEDS);

const insidePolygon = (p: Vec2, poly: readonly Vec2[]): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
};

test('seed 1 gives every generator seed 1, and the cache key carries seeds and overrides', () => {
  expect(SEEDS).toEqual({ terrain: 1, village: 1, cypress: 1, scatter: 1, haze: 1, lights: 1 });
  const inputs = worldScatterKeyInputs(WORLD, SEEDS);
  expect(inputs.seed).toBe(1);
  expect(WORLD_SCATTER_SIZE.terrain).toEqual({
    near: LAYER_SIZE.terrain.near * WORLD_SIZE_SCALE,
    far: LAYER_SIZE.terrain.far * WORLD_SIZE_SCALE,
    slope: LAYER_SIZE.terrain.slope * WORLD_SIZE_SCALE,
  });
  // The key hashes the fully resolved tables the scatter uses, every layer and field, so a retuned
  // LAYER_DENSITY or LAYER_SIZE misses even without a new build SHA (the dev server's is stale).
  expect(inputs.density).toEqual(LAYER_DENSITY);
  for (const layer of WORLD_LAYERS) {
    expect(inputs.size[layer], layer).toEqual({
      ...LAYER_SIZE[layer],
      ...WORLD_SCATTER_SIZE[layer],
    });
  }
  expect(inputs.size.haze).toEqual(LAYER_SIZE.haze);
  expect(inputs.normals).toBe('face');
  expect(inputs.generators).toEqual({ terrain: 1, village: 1, cypress: 1 });
  expect(inputs.overrides).toEqual([{ layer: 'terrain', mesh: 1, override: RIDGE_SCATTER }]);
  expect(WORLD.terrain.ridge.userData.scatter).toBe(RIDGE_SCATTER);
  expect(WORLD.surfaces.map((g) => g.userData.layer)).toEqual([
    'terrain',
    'terrain',
    'building',
    'roof',
    'window',
    'church',
    'cypress',
    'sky',
  ]);
});

interface MeshPin {
  readonly vertices: number;
  readonly triangles: number;
  /** Axis-aligned bounds, metres, rounded to 1 mm. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

const mm = (v: number): number => Math.round(v * 1000) / 1000 + 0;

function meshPin(geometry: BufferGeometry): MeshPin {
  const position = geometry.getAttribute('position');
  const box = new Box3().setFromBufferAttribute(position as BufferAttribute);
  const index = geometry.getIndex();
  return {
    vertices: position.count,
    triangles: (index ? index.count : position.count) / 3,
    min: [mm(box.min.x), mm(box.min.y), mm(box.min.z)],
    max: [mm(box.max.x), mm(box.max.y), mm(box.max.z)],
  };
}

/** The strokes of `buffers` from `start` on, as their own StrokeBuffers. */
function strokeRange(buffers: StrokeBuffers, start: number): StrokeBuffers {
  const out: Record<string, unknown> = { count: buffers.count - start };
  for (const spec of STROKE_ATTRIBUTES) {
    out[spec.key] = buffers[spec.key].subarray(start * spec.itemSize);
  }
  return out as unknown as StrokeBuffers;
}

/**
 * P2-A1: the seed-1 world pinned across commits, as literals. These pins use the real CanvasSource
 * (`loadRealSource`: frame.webp, regions.png and flow.png decoded with sharp), as the rest of this
 * file does.
 *
 * Changing a generator pin needs no SCATTER_VERSION bump, because the scatter cache key carries the
 * build SHA. Changing a scatter pin (the stroke counts or hash in the describe below) requires
 * bumping SCATTER_VERSION in src/render/strokes/scatter.ts, so no cached scatter of the old output
 * is served for the same inputs. The haze is never cached, so a haze pin change needs no bump.
 */
const GENERATOR_PINS: Readonly<Record<string, MeshPin>> = {
  terrain: { vertices: 16384, triangles: 32258, min: [-60, -6.33, -60], max: [60, 13.279, 60] },
  ridge: {
    vertices: 87,
    triangles: 112,
    min: [-71.486, -40, -92.66],
    max: [82.902, 29.065, -14.491],
  },
  houses: {
    vertices: 600,
    triangles: 200,
    min: [-21.562, -6.048, -38.761],
    max: [21.308, 2.217, -12.675],
  },
  roofs: {
    vertices: 240,
    triangles: 80,
    min: [-21.872, -3.654, -39.083],
    max: [21.661, 2.217, -12.406],
  },
  windows: {
    vertices: 426,
    triangles: 142,
    min: [-21.185, -4.988, -38.188],
    max: [20.406, -1.407, -12.763],
  },
  church: {
    vertices: 78,
    triangles: 26,
    min: [-0.676, -5.448, -41.177],
    max: [5.424, 5.203, -35.727],
  },
  cypress: {
    vertices: 1370,
    triangles: 2688,
    min: [-5.048, -5.343, -11.05],
    max: [-0.217, 9.38, -8.015],
  },
  sky: { vertices: 561, triangles: 960, min: [-120, -118.4, -120], max: [120, 121.6, 120] },
};

test('P2-A1: the seed-1 generators match their pinned counts and bounds', () => {
  const { building, roof, window, church } = WORLD.village.geometries;
  const pins = {
    terrain: meshPin(WORLD.terrain.geometry),
    ridge: meshPin(WORLD.terrain.ridge),
    houses: meshPin(building),
    roofs: meshPin(roof),
    windows: meshPin(window),
    church: meshPin(church),
    cypress: meshPin(WORLD.cypress.geometry),
    sky: meshPin(WORLD.dome),
  };
  expect(pins).toEqual(GENERATOR_PINS);
});

test('both poses are the painter spot facing -Z', () => {
  expect(painterSpot()).toEqual({ position: [0, 0, 0], yaw: 0 });
  expect(spawnPose()).toEqual(painterSpot());
});

test('the 24 coverage poses stand inside the boundary, on the ground and outside every building', () => {
  expect(COVERAGE_POSES).toHaveLength(24);
  const { heightAt } = WORLD.terrain;
  const outlines = [...WORLD.village.houses.map((h) => h.outline), WORLD.village.church.outline];
  for (const { name, position } of COVERAGE_POSES) {
    const [x, y, z] = position;
    expect(boundaryFactor(position), name).toBeLessThan(1);
    expect(Math.hypot(x, y, z), name).toBeLessThan(48);
    const above = y - heightAt(x, z);
    if (name.startsWith('high')) expect(y).toBe(30);
    else expect(Math.abs(above - 1.6), name).toBeLessThan(0.01);
    for (const outline of outlines) expect(insidePolygon([x, z], outline), name).toBe(false);
  }
  const far = COVERAGE_POSES.filter((p) => Math.hypot(...p.position) >= 40);
  expect(far.length).toBeGreaterThanOrEqual(6);
  const pitches = COVERAGE_POSES.map((p) => p.pitch);
  expect(pitches).toContain(Math.PI / 2);
  expect(pitches).toContain(-Math.PI / 2);
});

test('from the painter eye, no window facing it shows unoccluded inside the painted cypress', () => {
  const blockers = [WORLD.cypress.geometry, WORLD.terrain.geometry].map(
    (g) => new Mesh(g, new BasicMaterial({ side: DoubleSide })),
  );
  for (const m of blockers) m.updateMatrixWorld();
  const eye = new Vector3(...PAINTER_EYE);
  const raycaster = new Raycaster();
  let checked = 0;
  const visible: string[] = [];
  WORLD.village.windows.forEach((w, i) => {
    const toEye = new Vector3(...PAINTER_EYE).sub(new Vector3(...w.center));
    if (toEye.dot(new Vector3(...w.normal)) <= 0) return;
    const n = new Vector3(...w.normal);
    const across = new Vector3(0, 1, 0).cross(n).normalize();
    const up = new Vector3().crossVectors(n, across).normalize();
    const c = new Vector3(...w.center);
    const points = [
      [0, 0],
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, b]) =>
      c
        .clone()
        .addScaledVector(across, (a * w.width) / 2)
        .addScaledVector(up, (b * w.height) / 2),
    );
    for (const p of points) {
      const { uv, inFrustum } = projectToCanvas([p.x, p.y, p.z]);
      if (!inFrustum || !uv || !insidePolygon(uv, CYPRESS_OUTLINE)) continue;
      checked++;
      const dir = p.clone().sub(eye);
      const distance = dir.length();
      raycaster.set(eye, dir.normalize());
      raycaster.far = distance - 0.05;
      if (raycaster.intersectObjects(blockers, false).length === 0) visible.push(`window ${i}`);
    }
  });
  console.log(`[world] window points inside the painted cypress: ${checked}`);
  expect(visible).toEqual([]);
});

describe('base meshes', () => {
  test('under-paint is the texel-weighted bin-centre mean times the shade', () => {
    // Two bins of region 0 (sky): (0, 0, 0) x1 and (31, 0, 31) x3, bin step 8 so centres 4 and 252.
    const histogram = {
      regions: [
        {
          count: 4,
          colorBins: new Uint16Array([0, (31 << 10) | 31]),
          colorCdf: new Uint32Array([1, 4]),
          angleCdf: new Uint32Array(64),
        },
      ],
    } as unknown as CanvasHistogram;
    const rgb = underpaintColor(histogram, 'sky');
    expect(rgb[0]).toBeCloseTo(((4 + 3 * 252) / 4) * UNDERPAINT_SHADE, 9);
    expect(rgb[1]).toBeCloseTo(4 * UNDERPAINT_SHADE, 9);
    expect(rgb[2]).toBeCloseTo(((4 + 3 * 252) / 4) * UNDERPAINT_SHADE, 9);
  });

  const materials = (paint: 'underpaint' | 'magenta') =>
    createBaseMeshes(WORLD.surfaces, SOURCE.histogram, paint).children.map(
      (m) =>
        [
          (m as Mesh<BufferGeometry, MeshBasicMaterial>).geometry,
          (m as Mesh<BufferGeometry, MeshBasicMaterial>).material,
        ] as const,
    );

  test('each surface draws flat in its layer under-paint, windows in their warm colour', () => {
    const meshes = materials('underpaint');
    // The dome is a backdrop: no base mesh, the clear colour is its under-paint.
    expect(meshes).toHaveLength(WORLD.surfaces.length - 1);
    expect(meshes.map(([geometry]) => geometry)).not.toContain(WORLD.dome);
    for (const [geometry, material] of meshes) {
      // Front faces only: a back face is where every stroke on it is culled too.
      expect(material.side).toBe(FrontSide);
      expect(material.polygonOffset).toBe(true);
      expect(material.polygonOffsetFactor).toBeGreaterThan(0);
      const layer = geometry.userData.layer;
      const expected =
        layer === 'window'
          ? new Color().setRGB(...WINDOW_COLOR)
          : new Color().setRGB(
              ...(underpaintColor(SOURCE.histogram, layer).map((c) => c / 255) as [
                number,
                number,
                number,
              ]),
              'srgb',
            );
      expect(material.color.getHex()).toBe(expected.getHex());
      expect(material.color.getHex()).not.toBe(BARE_COLOR);
    }
  });

  test('the debug paint is flat magenta on every surface', () => {
    for (const [, material] of materials('magenta'))
      expect(material.color.getHex()).toBe(BARE_COLOR);
  });

  test('with the scatter seed, each tinted village triangle takes its house tint, darkened less', () => {
    const group = createBaseMeshes(WORLD.surfaces, SOURCE.histogram, 'underpaint', SEEDS.scatter);
    const bands = splitTintBands(SOURCE.histogram);
    let tinted = 0;
    for (const child of group.children) {
      const { geometry, material } = child as Mesh<BufferGeometry, MeshBasicMaterial>;
      const tags = geometry.userData.tint as TintTags | undefined;
      if (!tags) {
        expect(material.vertexColors).toBe(false);
        continue;
      }
      tinted++;
      expect(material.vertexColors).toBe(true);
      const source = WORLD.surfaces.find((g) => g.userData === geometry.userData);
      expect(geometry.getAttribute('position')).toBe(source?.getAttribute('position'));
      const layer = WORLD_LAYERS.indexOf(geometry.userData.layer);
      const colors = geometry.getAttribute('color');
      for (let t = 0; t < tags.owner.length; t++) {
        const rgb = pickTint(
          bands[tags.role[t] as TintRole],
          tintSeed(SEEDS.scatter, layer, tags.owner[t], tags.role[t] as TintRole),
        ).rgb;
        const k = TINT_UNDERPAINT_SHADE / 255;
        const expected = new Color().setRGB(rgb[0] * k, rgb[1] * k, rgb[2] * k, 'srgb');
        const got = new Color(colors.getX(t * 3), colors.getY(t * 3), colors.getZ(t * 3));
        expect(got.getHex()).toBe(expected.getHex());
      }
    }
    expect(tinted).toBe(3);
  });
});

/**
 * Quest 3 combined field of view, both eyes, as in tests/strokes-budget.test.ts: about 110 degrees
 * horizontal by 96 vertical. The budget counts instances drawn after culling (ruling R9).
 */
const QUEST_FOV = 96;
const QUEST_ASPECT = Math.tan((55 * Math.PI) / 180) / Math.tan((48 * Math.PI) / 180);

describe('the default-mode budget at the painter spot and the 24 poses', () => {
  let scattered: StrokeBuffers;
  let assembled: WorldStrokes;
  let buffers: StrokeBuffers;
  let batch: StrokeBatch;

  beforeAll(() => {
    fitLog.on = true;
    scattered = scatterWorld(WORLD, SOURCE, SEEDS);
    fitLog.on = false;
    assembled = assembleWorldStrokes(scattered, WORLD, SOURCE, SKY_SCAN, SEEDS);
    buffers = assembled.buffers;
    batch = createStrokeBatch(buffers, {
      cellSize: WORLD_CELL_SIZE,
      createAtlas: () => new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat),
    });
  }, 120_000);

  afterAll(() => batch?.dispose());

  test('every layer gets strokes and the world stores under the 900k ceiling', () => {
    const counts = strokeLayerCounts(scattered);
    for (const layer of ['sky', 'cypress', 'ground', 'building'] as const) {
      expect(counts[layer], layer).toBeGreaterThan(1000);
    }
    expect(assembled.counts.haze).toBeGreaterThan(20_000);
    expect(assembled.counts.moon).toBeGreaterThan(200);
    expect(assembled.counts.star).toBeGreaterThan(1000);
    expect(buffers.count).toBeLessThan(900_000);
    console.log(
      `[world] stored ${buffers.count} (${JSON.stringify(assembled.counts)}), ${batch.chunks.length} chunks at ${WORLD_CELL_SIZE} m`,
    );
  });

  test('the world counts list the scatter, the moon and stars and the haze once each', () => {
    const { counts, lightsStart, hazeStart } = assembled;
    const lights = strokeLayerCounts(
      selectStrokes(
        buffers,
        Array.from({ length: hazeStart - lightsStart }, (_, i) => lightsStart + i),
      ),
    );
    const scatter = strokeLayerCounts(scattered);
    expect(lightsStart).toBe(scattered.count);
    expect(counts).toEqual({
      ...scatter,
      star: lights.star,
      moon: lights.moon,
      haze: buffers.count - hazeStart,
    });
    expect(lights.star + lights.moon).toBe(hazeStart - lightsStart);
  });

  test('the haze is exactly the sky-layer strokes with SKY_LIGHT_CULL_FLAG, the shader haze marker', () => {
    // stroke.vert.glsl grows these by uHazeThickness (P3.5); the flags byte has no spare bit.
    let marked = 0;
    let first = buffers.count;
    for (let i = 0; i < buffers.count; i++) {
      const sky = buffers.meta[i * 4 + 1] === STROKE_LAYER.sky;
      if (sky && (buffers.meta[i * 4 + 3] & SKY_LIGHT_CULL_FLAG) !== 0) {
        marked++;
        first = Math.min(first, i);
      }
    }
    expect(marked).toBe(assembled.counts.haze);
    expect(first).toBe(assembled.hazeStart);
  });

  test('P2-A1: the seed-1 scatter and haze match their pinned counts and hashes', () => {
    // A change to the scatter pins requires bumping SCATTER_VERSION in
    // src/render/strokes/scatter.ts (see GENERATOR_PINS above). The moon and stars and the haze
    // are generated outside the scatter cache, so their pins move without a bump. The haze is
    // createBoundaryHaze's own output plus SKY_LIGHT_CULL_FLAG on every stroke: with the flag
    // cleared it hashes as it did before the moon and stars (49bf0339). The lights' phase bytes name
    // their anchor for the P4.3 rings (1e63faa8 before, every other field unchanged). The cypress
    // strokes' colour alpha carries their flame lobe and height (P4.4): with every alpha back at
    // 255 the scatter hashes as it did before (cf326988).
    const haze = strokeRange(buffers, assembled.hazeStart);
    let unflagged = 0;
    for (let i = 0; i < haze.count; i++) {
      if ((haze.meta[i * 4 + 3] & SKY_LIGHT_CULL_FLAG) === 0) unflagged++;
    }
    const hazeMeta = haze.meta.slice();
    for (let i = 0; i < haze.count; i++) hazeMeta[i * 4 + 3] &= ~SKY_LIGHT_CULL_FLAG;
    const lights = selectStrokes(
      buffers,
      Array.from(
        { length: assembled.hazeStart - assembled.lightsStart },
        (_, i) => assembled.lightsStart + i,
      ),
    );
    const pins = {
      total: scattered.count,
      layers: strokeLayerCounts(scattered),
      hash: hashStrokeBuffers(scattered),
      opaqueHash: hashStrokeBuffers({
        ...scattered,
        color: scattered.color.map((c, i) => (i % 4 === 3 ? 255 : c)),
      }),
      lights: lights.count,
      lightsHash: hashStrokeBuffers(lights),
      haze: haze.count,
      hazeUnflagged: unflagged,
      hazeHash: hashStrokeBuffers({ ...haze, meta: hazeMeta }),
    };
    expect(pins).toEqual({
      total: 538_116,
      layers: {
        sky: 283_858,
        star: 0,
        moon: 0,
        cypress: 36_964,
        ground: 129_925,
        building: 87_369,
      },
      hash: 'f49484bf',
      opaqueHash: 'cf326988',
      lights: 4_935,
      lightsHash: '0ba1901f',
      haze: 30_000,
      hazeUnflagged: 0,
      hazeHash: '49bf0339',
    });
  });

  test('every dome, moon and star stroke, and nothing else, carries the backdrop flag', () => {
    // One assertion over the whole buffer: a per-stroke expect over ~540k strokes runs past the
    // 5 s test timeout on the CI runner.
    let flagged = 0;
    let wrong = 0;
    let firstWrong = -1;
    for (let i = 0; i < buffers.count; i++) {
      const flags = buffers.meta[i * 4 + 3];
      const layer = buffers.meta[i * 4 + 1];
      const backdrop = (flags & DEPTH_BACKDROP_FLAG) !== 0;
      // Haze is appended after the moon and stars and keeps its normal depth.
      const dome = i < scattered.count && layer === STROKE_LAYER.sky;
      const light =
        i >= assembled.lightsStart &&
        i < assembled.hazeStart &&
        (layer === STROKE_LAYER.star || layer === STROKE_LAYER.moon);
      if (backdrop !== (dome || light)) {
        wrong++;
        if (firstWrong < 0) firstWrong = i;
      }
      if (backdrop) flagged++;
    }
    expect({ wrong, firstWrong }).toEqual({ wrong: 0, firstWrong: -1 });
    const { sky, star, moon } = assembled.counts;
    expect(flagged).toBe(sky + star + moon);
  });

  test('village and church strokes stay inside their host face plus 10% of their width', () => {
    // Independent of the scatter's own face grouping: the village triangles are grouped into planes
    // by normal and offset, panes apart from the rest, and a stroke's hosts are the planes it faces,
    // lies within its lift in front of, and whose triangles hold its centre. A window stroke (the
    // tie-break front flag) is hosted by panes only, since a pane sits 2 cm off its wall and the wall
    // would absorb a stroke spilling past the pane; every other stroke by the rest only. Where a
    // stroke still matches several planes its overhang is the least over its hosts: the furthest
    // corner of its paint's distance outside that plane's triangles. The paint is the brush's opaque
    // mask, measured from the default-seed atlas as a box centred in the quad, and the quad is decoded
    // as the GPU draws it: at the default band size factors (bands.ts) capped by the stroke's fit
    // scale, and at the fit cap itself, the largest factor the governor can grow it to. The margin is
    // a share of the stroke's footprint width (the BRUSH_FOOTPRINT table, which bounds the paint).
    const paint = paintBoxes(DEFAULT_BRUSH_SEED);
    type Tri = { a: Vec3; b: Vec3; c: Vec3; n: Vec3; d: number };
    type Plane = { n: Vec3; d: number; pane: boolean; tris: Tri[] };
    const planes: Plane[] = [];
    const { building, roof, window, church } = WORLD.village.geometries;
    for (const g of [building, roof, window, church]) {
      const pane = g === window;
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i += 3) {
        const [a, b, c] = [0, 1, 2].map(
          (k) => [pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)] as Vec3,
        );
        const n = unit3(cross3(sub3(b, a), sub3(c, a)));
        const t = { a, b, c, n, d: dot3(n, a) };
        const plane = planes.find(
          (q) => q.pane === pane && dot3(q.n, n) > 1 - 1e-6 && Math.abs(q.d - t.d) < 1e-4,
        );
        if (plane) plane.tris.push(t);
        else planes.push({ n, d: t.d, pane, tris: [t] });
      }
    }
    // The lift is at most SCATTER_DEPTH_JITTER of a stroke's length, under 3 cm on these layers.
    const maxLift = 0.05;
    const bands = ['near', 'mid', 'far', 'cap'] as const;
    const scales = { near: 1, mid: DEFAULT_BAND_SIZE.mid, far: DEFAULT_BAND_SIZE.far };
    const worst = { near: 0, mid: 0, far: 0, cap: 0 };
    const over = { near: 0, mid: 0, far: 0, cap: 0 };
    let checked = 0;
    let panes = 0;
    let unmatched = 0;
    for (let i = 0; i < scattered.count; i++) {
      if (scattered.meta[i * 4 + 1] !== STROKE_LAYER.building) continue;
      const s = unpackInstance(scattered, i);
      const n = s.normal;
      const pane = ((s.flags ?? 0) & DEPTH_TIE_BREAK_FRONT_FLAG) !== 0;
      const hosts = planes.filter((p) => {
        if (p.pane !== pane || dot3(p.n, n) < 0.9999) return false;
        const lift = dot3(p.n, s.position) - p.d;
        if (lift < -1e-3 || lift > maxLift) return false;
        return p.tris.some((t) => distanceToTriangle(s.position, t) < 1e-4);
      });
      if (hosts.length === 0) {
        unmatched++;
        continue;
      }
      checked++;
      if (pane) panes++;
      const { long, short } = strokeAxes(n, s.tangent);
      const limit = fitScaleLimit(s.flags ?? 0);
      for (const band of bands) {
        // An unfitted stroke has no cap, so it is measured at the largest cap a fit can encode.
        const cap = Number.isFinite(limit) ? limit : FIT_SCALE_MAX;
        const k = band === 'cap' ? cap : Math.min(scales[band], limit);
        const box = paint[s.brush];
        const [l, w] = [s.size[0] * k * box.length, s.size[1] * k * box.width];
        let least = Number.POSITIVE_INFINITY;
        for (const host of hosts) {
          let reach = 0;
          for (const [sa, sb] of [
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
          ]) {
            const corner = [0, 1, 2].map(
              (q) => s.position[q] + (sa * l * long[q]) / 2 + (sb * w * short[q]) / 2,
            ) as unknown as Vec3;
            let gap = Number.POSITIVE_INFINITY;
            for (const t of host.tris) gap = Math.min(gap, distanceToTriangle(corner, t));
            reach = Math.max(reach, gap);
          }
          least = Math.min(least, reach);
        }
        const ratio = least / (s.size[1] * k * BRUSH_FOOTPRINT[BRUSHES[s.brush].kind].width);
        worst[band] = Math.max(worst[band], ratio);
        if (ratio > FACE_CLAMP_MARGIN + 1e-3) over[band]++;
      }
    }
    console.log(
      `[world] village overhang / footprint width over ${checked} strokes (${panes} on panes, ${unmatched} unmatched): max ${JSON.stringify(worst)}, over 10% ${JSON.stringify(over)}`,
    );
    expect(unmatched).toBe(0);
    expect(checked).toBeGreaterThan(50_000);
    expect(panes).toBeGreaterThan(4000);
    for (const band of bands) {
      expect(worst[band], band).toBeLessThanOrEqual(FACE_CLAMP_MARGIN + 1e-3);
    }
  });

  test('the face fit keeps most of the paint on each village layer and shrinks few strokes away', () => {
    // Painted footprint area out of the fit over the area into it, outline strokes included, and
    // the share of strokes left with under a quarter of their area. Measured on seed 1: building
    // 99.55% kept, 187 of 54,681 under a quarter; roof 99.56%, 68 of 20,496; window 95.50%, 146 of
    // 4,497; church 99.55%, 35 of 7,695. Panes are small, so window strokes lose the most.
    const floors: Readonly<Record<string, { kept: number; small: number }>> = {
      building: { kept: 0.98, small: 0.01 },
      roof: { kept: 0.98, small: 0.01 },
      window: { kept: 0.93, small: 0.05 },
      church: { kept: 0.98, small: 0.01 },
    };
    const kept: Record<string, string> = {};
    for (const layer of FACE_CLAMPED_LAYERS) {
      const entry = fitLog.layers.get(layer);
      expect(entry, layer).toBeDefined();
      if (!entry) continue;
      kept[layer] =
        `${((100 * entry.after) / entry.before).toFixed(2)}% kept, ${entry.small} of ${entry.strokes} under a quarter`;
      expect(entry.strokes, layer).toBeGreaterThan(1000);
      expect(entry.after / entry.before, layer).toBeGreaterThanOrEqual(floors[layer].kept);
      expect(entry.small / entry.strokes, layer).toBeLessThan(floors[layer].small);
    }
    console.log(`[world] face fit area ${JSON.stringify(kept)}`);
  });

  test('ground strokes lie in their triangle with its face normal, not the smooth one', () => {
    const { heightAt, normalAt } = WORLD.terrain;
    let checked = 0;
    let matched = 0;
    for (let i = 0; i < scattered.count && checked < 2000; i += 37) {
      const s = unpackInstance(scattered, i);
      const [x, y, z] = s.position;
      if (Math.abs(x) > 55 || Math.abs(z) > 55 || s.layer !== 4) continue;
      const face = normalAt(x, z);
      const dot = face[0] * s.normal[0] + face[1] * s.normal[1] + face[2] * s.normal[2];
      if (Math.abs(y - heightAt(x, z)) > 0.2) continue;
      checked++;
      // Within the oct16 quantisation; a stroke lifted across a triangle edge may read the
      // neighbouring face, so not every one matches.
      if (dot > 0.99999) matched++;
    }
    expect(checked).toBeGreaterThan(500);
    expect(matched / checked).toBeGreaterThan(0.9);
  });

  test('the defaults draw within the 325k default budget at every pose', () => {
    const camera = new PerspectiveCamera(QUEST_FOV, QUEST_ASPECT, 0.05, 1000);
    camera.rotation.order = 'YXZ';
    const drawn: Record<string, number> = {};
    for (const { name, position, yaw, pitch } of COVERAGE_POSES) {
      camera.position.set(...position);
      camera.rotation.set(pitch, yaw, 0);
      camera.updateMatrixWorld();
      batch.update(camera);
      drawn[name] = batch.visibleCount();
    }
    console.log(`[world] drawn per pose ${JSON.stringify(drawn)}`);
    for (const [name, n] of Object.entries(drawn)) {
      expect(n, name).toBeLessThanOrEqual(STROKE_BUDGET.default.max);
      expect(n, name).toBeGreaterThan(0);
    }
  });
});

test('the real cypress histogram keeps no colour nearer the hill or sky centre than its own', () => {
  const { regions, centres } = SOURCE.histogram;
  const h = regions[REGION.cypress];
  const own = centres[REGION.cypress];
  const hills = centres[REGION.hills];
  const sky = centres[REGION.sky];
  if (!own || !hills || !sky) throw new Error('the scan shows the cypress, the hills and the sky');
  const all = h.angleCdf[ANGLE_BINS - 1];
  // regions.json's polygon takes in about 11% sky and hill paint; the check drops it.
  expect(h.count).toBeLessThan(0.95 * all);
  expect(h.count).toBeGreaterThan(0.8 * all);
  const step = 256 >> COLOR_BITS;
  const mask = (1 << COLOR_BITS) - 1;
  const outside: number[] = [];
  for (const key of h.colorBins) {
    const lab = srgb8ToLab(
      (key >> (2 * COLOR_BITS)) * step + step / 2,
      ((key >> COLOR_BITS) & mask) * step + step / 2,
      (key & mask) * step + step / 2,
    );
    const d = deltaE2000(lab, own);
    if (!(d < deltaE2000(lab, hills) && d < deltaE2000(lab, sky))) outside.push(key);
  }
  expect(outside).toEqual([]);
});
