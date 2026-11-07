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
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadRealSource } from '../scripts/scatter-time.ts';
import {
  BARE_COLOR,
  createBaseMeshes,
  UNDERPAINT_SHADE,
  underpaintColor,
} from '../src/paintings/starry-night/base-meshes.ts';
import {
  PAINTER_EYE,
  projectToCanvas,
  type Vec2,
} from '../src/paintings/starry-night/canvas-camera.ts';
import type { CanvasHistogram } from '../src/paintings/starry-night/canvas-histogram.ts';
import { painterSpot, spawnPose } from '../src/paintings/starry-night/index.ts';
import {
  createWorldGeometry,
  RIDGE_SCATTER,
  scatterWorld,
  strokeLayerCounts,
  WORLD_CELL_SIZE,
  WORLD_SCATTER_SIZE,
  WORLD_SIZE_SCALE,
  type WorldGeometry,
  withHaze,
  worldScatterKeyInputs,
  worldSeeds,
} from '../src/paintings/starry-night/world.ts';
import { DEPTH_BACKDROP_FLAG } from '../src/render/strokes/backdrop-depth.ts';
import { STROKE_BUDGET } from '../src/render/strokes/bands.ts';
import { createStrokeBatch, type StrokeBatch } from '../src/render/strokes/batch.ts';
import {
  STROKE_ATTRIBUTES,
  STROKE_LAYER,
  type StrokeBuffers,
  unpackInstance,
} from '../src/render/strokes/instance.ts';
import { LAYER_DENSITY, LAYER_SIZE, WORLD_LAYERS } from '../src/render/strokes/scatter.ts';
import { hashStrokeBuffers } from '../src/render/strokes/scatter-cache.ts';
import { boundaryFactor } from '../src/world/boundary.ts';
import { CYPRESS_OUTLINE } from '../src/world/cypress.ts';
import { WINDOW_COLOR } from '../src/world/village.ts';
import { COVERAGE_POSES } from './world-poses.ts';

const SOURCE = await loadRealSource();
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
  expect(SEEDS).toEqual({ terrain: 1, village: 1, cypress: 1, scatter: 1, haze: 1 });
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
});

/**
 * Quest 3 combined field of view, both eyes, as in tests/strokes-budget.test.ts: about 110 degrees
 * horizontal by 96 vertical. The budget counts instances drawn after culling (ruling R9).
 */
const QUEST_FOV = 96;
const QUEST_ASPECT = Math.tan((55 * Math.PI) / 180) / Math.tan((48 * Math.PI) / 180);

describe('the default-mode budget at the painter spot and the 24 poses', () => {
  let scattered: StrokeBuffers;
  let buffers: StrokeBuffers;
  let batch: StrokeBatch;

  beforeAll(() => {
    scattered = scatterWorld(WORLD, SOURCE, SEEDS);
    buffers = withHaze(scattered, WORLD, SOURCE, SEEDS);
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
    expect(buffers.count - scattered.count).toBeGreaterThan(20_000);
    expect(buffers.count).toBeLessThan(900_000);
    console.log(
      `[world] stored ${buffers.count} (${JSON.stringify(counts)}, haze ${buffers.count - scattered.count}), ${batch.chunks.length} chunks at ${WORLD_CELL_SIZE} m`,
    );
  });

  test('P2-A1: the seed-1 scatter and haze match their pinned counts and hashes', () => {
    // A change here requires bumping SCATTER_VERSION in src/render/strokes/scatter.ts (see
    // GENERATOR_PINS above).
    const haze = strokeRange(buffers, scattered.count);
    const pins = {
      total: scattered.count,
      layers: strokeLayerCounts(scattered),
      hash: hashStrokeBuffers(scattered),
      haze: haze.count,
      hazeHash: hashStrokeBuffers(haze),
    };
    expect(pins).toEqual({
      total: 535_011,
      layers: {
        sky: 283_858,
        star: 0,
        moon: 0,
        cypress: 36_964,
        ground: 129_925,
        building: 84_264,
      },
      hash: 'bb6f674f',
      haze: 30_000,
      hazeHash: '49bf0339',
    });
  });

  test('every dome stroke, and nothing else, carries the backdrop flag', () => {
    let dome = 0;
    for (let i = 0; i < buffers.count; i++) {
      const flags = buffers.meta[i * 4 + 3];
      const layer = buffers.meta[i * 4 + 1];
      const backdrop = (flags & DEPTH_BACKDROP_FLAG) !== 0;
      // Haze is appended after the scattered strokes and keeps its normal depth.
      expect(backdrop, `stroke ${i}`).toBe(i < scattered.count && layer === STROKE_LAYER.sky);
      if (backdrop) dome++;
    }
    expect(dome).toBe(strokeLayerCounts(scattered).sky);
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
