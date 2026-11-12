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
  SRGBColorSpace,
  Vector3,
} from 'three';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { loadRealSource, loadSkyScan } from '../scripts/scatter-time.ts';
import { REGION } from '../src/demo/canvas/field.ts';
import { strokeShade } from '../src/demo/canvas/placement.ts';
import { MAX_ALTITUDE, MAX_FLIGHT_RADIUS } from '../src/locomotion/flight.ts';
import {
  BARE_COLOR,
  createBaseMeshes,
  disposeBaseMeshes,
  TINT_UNDERPAINT_SHADE,
  UNDERPAINT_SHADE,
  underpaintColor,
} from '../src/paintings/starry-night/base-meshes.ts';
import {
  CANVAS_ASPECT,
  CANVAS_FOV_Y_DEG,
  CANVAS_PITCH,
  PAINTER_EYE,
  projectToCanvas,
  type Vec2,
} from '../src/paintings/starry-night/canvas-camera.ts';
import {
  ANGLE_BINS,
  type CanvasHistogram,
  COLOR_BITS,
} from '../src/paintings/starry-night/canvas-histogram.ts';
import { EAVE_UNDERSIDE_SHADE } from '../src/paintings/starry-night/eave-undersides.ts';
import { painterSpot, spawnPose } from '../src/paintings/starry-night/index.ts';
import {
  facesEye,
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
  WORLD_DOME_SECTOR_DEG,
  WORLD_FLIGHT_REACH_M,
  WORLD_SCATTER_SIZE,
  WORLD_SIZE_SCALE,
  type WorldGeometry,
  type WorldStrokes,
  worldBatchOptions,
  worldPartGroup,
  worldScatterKeyInputs,
  worldSeeds,
} from '../src/paintings/starry-night/world.ts';
import { DEPTH_BACKDROP_FLAG } from '../src/render/strokes/backdrop-depth.ts';
import {
  BAND_HYSTERESIS_M,
  DEFAULT_BAND_SIZE,
  MID_BAND_MAX_M,
  STROKE_BUDGET,
} from '../src/render/strokes/bands.ts';
import { createStrokeBatch, drawClassOf, type StrokeBatch } from '../src/render/strokes/batch.ts';
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
  CORNER_OUTLINE_REACH,
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
import { gableSlopeNormal, toLocal, toWorld } from '../src/world/house-geometry.ts';
import { WINDOW_COLOR } from '../src/world/village.ts';
import {
  FAR_MAX_RADIUS_M,
  farPose,
  PROBE_FOV_DEG,
  PROBE_VIEW,
  panes,
  project,
  sightTest,
} from './pane-poses.ts';
import { COVERAGE_POSES, CREST_POSES } from './world-poses.ts';

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

/**
 * ΔE2000 within which a tinted under-paint ÷ TINT_UNDERPAINT_SHADE is one of its owner's stroke
 * colours: the byte rounding of a stroke's divided-out shade.
 */
const TINT_MATCH_DE = 1;
/** ΔE2000 within which it lies of the per-channel median of those strokes: a tint's neighbours spread it. */
const TINT_MEDIAN_DE = 8;

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
function strokeRange(buffers: StrokeBuffers, start: number, end = buffers.count): StrokeBuffers {
  const out: Record<string, unknown> = { count: end - start };
  for (const spec of STROKE_ATTRIBUTES) {
    out[spec.key] = buffers[spec.key].subarray(start * spec.itemSize, end * spec.itemSize);
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
    min: [-21.35, -6.04, -40.715],
    max: [23.553, 2.156, -10.214],
  },
  roofs: {
    vertices: 240,
    triangles: 80,
    min: [-21.658, -3.631, -40.973],
    max: [23.87, 2.156, -9.908],
  },
  windows: {
    vertices: 390,
    triangles: 130,
    min: [-19.775, -4.974, -40.682],
    max: [23.05, -1.476, -10.565],
  },
  church: {
    vertices: 78,
    triangles: 26,
    min: [-0.594, -5.535, -41.671],
    max: [5.506, 5.196, -36.221],
  },
  cypress: {
    vertices: 1370,
    triangles: 2688,
    min: [-5.085, -5.344, -11.024],
    max: [-0.203, 9.424, -7.968],
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

  test('the debug paint with the scatter seed, as ?bare and ?coverage build it, has no tint', () => {
    const group = createBaseMeshes(WORLD.surfaces, SOURCE.histogram, 'magenta', SEEDS.scatter);
    expect(group.children).toHaveLength(WORLD.surfaces.length - 1);
    for (const child of group.children) {
      const { geometry, material } = child as Mesh<BufferGeometry, MeshBasicMaterial>;
      const layer = String(geometry.userData.layer);
      expect(material.color.getHex(), layer).toBe(BARE_COLOR);
      expect(material.vertexColors, layer).toBe(false);
      expect(geometry.getAttribute('color'), layer).toBeUndefined();
    }
  });

  test('a tagged surface that cannot be tinted warns once and under-paints in its region mean', () => {
    const walls = WORLD.surfaces.find((g) => g.userData.layer === 'building') as BufferGeometry;
    const tags = walls.userData.tint as TintTags;
    const untagged = walls.clone();
    untagged.userData = {
      ...walls.userData,
      tint: { owner: Array.from(tags.owner), role: Array.from(tags.role) },
    };
    const short = walls.clone();
    short.userData = {
      ...walls.userData,
      tint: { owner: tags.owner.subarray(1), role: tags.role.subarray(1) },
    };
    const indexed = walls.clone();
    indexed.userData = { ...walls.userData };
    indexed.setIndex(Array.from({ length: walls.getAttribute('position').count }, (_, i) => i));
    const mean = underpaintColor(SOURCE.histogram, 'building').map((c) => c / 255);
    const expected = new Color().setRGB(mean[0], mean[1], mean[2], SRGBColorSpace).getHex();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Twice, as a rebuilt world would: still one warning per surface.
      for (let k = 0; k < 2; k++) {
        const group = createBaseMeshes(
          [untagged, indexed, short],
          SOURCE.histogram,
          'underpaint',
          SEEDS.scatter,
        );
        expect(group.children).toHaveLength(3);
        for (const child of group.children) {
          const { geometry, material } = child as Mesh<BufferGeometry, MeshBasicMaterial>;
          expect(material.vertexColors).toBe(false);
          expect(geometry.getAttribute('color')).toBeUndefined();
          expect(material.color.getHex()).toBe(expected);
        }
      }
      expect(warn).toHaveBeenCalledTimes(3);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/building .*not a Uint16Array owner/);
      expect(String(warn.mock.calls[1]?.[0])).toMatch(/building .*indexed/);
      expect(String(warn.mock.calls[2]?.[0])).toMatch(/building .*for 200 triangles/);
    } finally {
      warn.mockRestore();
    }
  });

  test('base meshes own what they dispose: a tinted mesh shares no attribute with a surface', () => {
    // A shared attribute would have its GL buffer released by whichever geometry is disposed first,
    // under any other geometry still drawing it. Each mesh geometry's attributes are its own; an
    // untinted mesh draws the surface itself, which nothing else draws, so it releases that.
    const group = createBaseMeshes(WORLD.surfaces, SOURCE.histogram, 'underpaint', SEEDS.scatter);
    const meshes = [...group.children] as Mesh<BufferGeometry, MeshBasicMaterial>[];
    const holder = new Map<unknown, BufferGeometry>();
    for (const { geometry } of [...meshes, ...WORLD.surfaces.map((g) => ({ geometry: g }))]) {
      for (const attribute of Object.values(geometry.attributes)) {
        const other = holder.get(attribute);
        // Only an untinted mesh, which is its surface, may meet an attribute twice.
        if (other) expect(other, String(geometry.userData.layer)).toBe(geometry);
        holder.set(attribute, geometry);
      }
    }
    const tinted = meshes.filter((m) => m.material.vertexColors).map((m) => m.geometry);
    expect(tinted).toHaveLength(3);
    for (const geometry of tinted) expect(WORLD.surfaces).not.toContain(geometry);

    const disposed = new Map<BufferGeometry, number>();
    const listeners = [...new Set([...WORLD.surfaces, ...meshes.map((m) => m.geometry)])].map(
      (geometry) => {
        const listener = (): void => {
          disposed.set(geometry, (disposed.get(geometry) ?? 0) + 1);
        };
        geometry.addEventListener('dispose', listener);
        return () => geometry.removeEventListener('dispose', listener);
      },
    );
    try {
      disposeBaseMeshes(group);
      disposeBaseMeshes(group);
    } finally {
      for (const remove of listeners) remove();
    }
    expect(group.children).toHaveLength(0);
    for (const { geometry } of meshes) expect(disposed.get(geometry)).toBe(1);
    // The surfaces under a tinted mesh, or merged with a soffit, are never disposed.
    const drawn = new Set(meshes.map((m) => m.geometry));
    for (const surface of WORLD.surfaces) {
      expect(disposed.get(surface) ?? 0, String(surface.userData.layer)).toBe(
        drawn.has(surface) ? 1 : 0,
      );
    }
  });

  test('the roof and church meshes close every overhang from below, facing down, past the walls only', () => {
    // Both paints, so the `?coverage` sweep sees the soffits too. Each triangle past a surface's
    // own is a soffit triangle: wound to face down, in the plane of a roof slope it faces away
    // from, and outside that roof's wall rectangle. Per roof they add up to the band's area: the
    // eave strip and the two rake strips on each slope, times the slope's secant.
    const { roofs, houses } = WORLD.village;
    for (const paint of ['underpaint', 'magenta'] as const) {
      const meshes = materials(paint);
      const area = new Array<number>(roofs.length).fill(0);
      for (const layer of ['roof', 'church'] as const) {
        const own = WORLD.village.geometries[layer].getAttribute('position').count / 3;
        const found = meshes.find(([g]) => g.userData.layer === layer);
        expect(found, layer).toBeDefined();
        const [geometry] = found as NonNullable<typeof found>;
        const pos = geometry.getAttribute('position');
        const added = pos.count / 3 - own;
        expect(added, layer).toBe(12 * (layer === 'roof' ? houses.length : 1));
        for (let t = own; t < pos.count / 3; t++) {
          const [a, b, c] = [0, 1, 2].map(
            (k) => [pos.getX(t * 3 + k), pos.getY(t * 3 + k), pos.getZ(t * 3 + k)] as Vec3,
          );
          const e = cross3(sub3(b, a), sub3(c, a));
          const n = unit3(e);
          expect(n[1], `${layer} ${t}`).toBeLessThan(-0.5);
          const hits = roofs.flatMap((roof, r) =>
            ([1, -1] as const).flatMap((side) => {
              const up = gableSlopeNormal(roof.frame, roof.box, side);
              const ridge = toWorld(roof.frame, 0, roof.box.eave + roof.box.rise, 0);
              const onPlane = [a, b, c].every((p) => Math.abs(dot3(sub3(p, ridge), up)) < 1e-4);
              return dot3(n, up) < -0.9999 && onPlane ? [r] : [];
            }),
          );
          expect(hits, `${layer} ${t}`).toHaveLength(1);
          const r = hits[0] as number;
          const { frame, box } = roofs[r] as (typeof roofs)[number];
          const mid: Vec3 = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3) as unknown as Vec3;
          const [lx, , lz] = toLocal(frame, mid);
          const past = Math.abs(lx) > box.width / 2 || Math.abs(lz) > box.depth / 2;
          expect(past, `${layer} ${t} inside the walls`).toBe(true);
          area[r] += Math.hypot(...e) / 2;
        }
      }
      for (const [r, { box }] of roofs.entries()) {
        const sec = Math.hypot(box.depth / 2, box.rise) / (box.depth / 2);
        const hw = box.width / 2 + box.overhang;
        const band = 2 * sec * box.overhang * (2 * hw + box.depth);
        expect(area[r], `roof ${r}`).toBeCloseTo(band, 4);
      }
    }
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
      const source = WORLD.surfaces.find((g) => g.userData.layer === geometry.userData.layer);
      const soffit = source?.userData.soffit as BufferGeometry | undefined;
      if (soffit) {
        // The surface's triangles, then its soffit's (`withSoffit`).
        const own = source?.getAttribute('position').array as Float32Array;
        const under = soffit.getAttribute('position').array as Float32Array;
        expect(Array.from(geometry.getAttribute('position').array)).toEqual([...own, ...under]);
      } else {
        // A copy, so disposing the mesh releases no buffer of the surface (`tintedUnderpaint`).
        expect(geometry.getAttribute('position')).not.toBe(source?.getAttribute('position'));
        expect(geometry.getAttribute('position').array).toEqual(
          source?.getAttribute('position').array,
        );
      }
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
  /** The app's batch: index.ts builds it with the same `worldBatchOptions`. */
  let batch: StrokeBatch;
  /** The same with every part a chunk of its own, the 24 m layout before `worldPartGroup`. */
  let plain: StrokeBatch;
  /** The app's batch without the eave underside copies. */
  let uncopied: StrokeBatch;

  beforeAll(() => {
    fitLog.on = true;
    scattered = scatterWorld(WORLD, SOURCE, SEEDS);
    fitLog.on = false;
    assembled = assembleWorldStrokes(scattered, WORLD, SOURCE, SKY_SCAN, SEEDS);
    buffers = assembled.buffers;
    const atlas = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
    batch = createStrokeBatch(buffers, worldBatchOptions(WORLD.terrain.heightAt, atlas));
    plain = createStrokeBatch(buffers, { cellSize: WORLD_CELL_SIZE, cypressChunk: true, atlas });
    uncopied = createStrokeBatch(
      strokeRange(buffers, 0, assembled.eavesStart),
      worldBatchOptions(WORLD.terrain.heightAt, atlas),
    );
  }, 120_000);

  afterAll(() => {
    batch?.dispose();
    plain?.dispose();
    uncopied?.dispose();
  });

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

  test('the world counts list the scatter, the moon and stars, the haze and the eave copies once each', () => {
    const { counts, lightsStart, hazeStart, eavesStart, eaveSources } = assembled;
    const lights = strokeLayerCounts(
      selectStrokes(
        buffers,
        Array.from({ length: hazeStart - lightsStart }, (_, i) => lightsStart + i),
      ),
    );
    const scatter = strokeLayerCounts(scattered);
    const eaves = strokeLayerCounts(strokeRange(buffers, eavesStart));
    expect(lightsStart).toBe(scattered.count);
    expect(eavesStart + eaveSources.length).toBe(buffers.count);
    expect(eaves.building).toBe(eaveSources.length);
    expect(counts).toEqual({
      ...scatter,
      star: lights.star,
      moon: lights.moon,
      haze: eavesStart - hazeStart,
      eaves: eaveSources.length,
    });
    expect(lights.star + lights.moon).toBe(hazeStart - lightsStart);
  });

  test('every eave copy is its roof stroke turned to face down, mirrored through the slope', () => {
    const { roofs, church } = WORLD.village;
    const slopes = roofs.flatMap(({ frame, box }) =>
      ([1, -1] as const).map((side) => ({
        frame,
        box,
        n: gableSlopeNormal(frame, box, side),
        ridge: toWorld(frame, 0, box.eave + box.rise, 0),
      })),
    );
    let onChurch = 0;
    let darkest = 1;
    let worst = { normal: -1, long: 1, plane: 0, shade: 0 };
    // Collected, then asserted once: an expect per copy is slow over ~9k copies.
    const bad: string[] = [];
    for (const [k, i] of assembled.eaveSources.entries()) {
      const o = unpackInstance(buffers, i);
      const c = unpackInstance(buffers, assembled.eavesStart + k);
      const same =
        c.size[0] === o.size[0] &&
        c.size[1] === o.size[1] &&
        c.brush === o.brush &&
        c.layer === o.layer &&
        c.phase === o.phase &&
        c.flags === o.flags;
      if (i >= assembled.lightsStart || o.layer !== STROKE_LAYER.building || !same) {
        bad.push(`copy ${k} of ${i} is not a scattered building stroke's twin`);
      }
      const slope = slopes.find(
        (s) => dot3(o.normal, s.n) > 0.999 && Math.abs(dot3(sub3(o.position, s.ridge), s.n)) < 0.1,
      );
      if (!slope) {
        bad.push(`stroke ${i} is on no roof slope`);
        continue;
      }
      // The copy sits as far under the slope as the stroke sits over it.
      const over = dot3(sub3(o.position, slope.ridge), slope.n);
      const under = dot3(sub3(c.position, slope.ridge), slope.n);
      const lo = strokeAxes(o.normal, o.tangent).long;
      const lc = strokeAxes(c.normal, c.tangent).long;
      const lit = o.color[0] + o.color[1] + o.color[2];
      const shown =
        ((c.color[0] + c.color[1] + c.color[2]) * strokeShade(c.normal)) /
        Math.max(1, lit * strokeShade(o.normal));
      worst = {
        normal: Math.max(worst.normal, dot3(c.normal, o.normal)),
        long: Math.min(worst.long, dot3(lo, lc)),
        plane: Math.max(worst.plane, Math.abs(over + under)),
        // Byte rounding moves a dark stroke's ratio by up to 1.5 / its channel sum.
        shade: lit >= 150 ? Math.max(worst.shade, shown) : worst.shade,
      };
      darkest = Math.min(darkest, shown);
      if (insidePolygon([o.position[0], o.position[2]], church.outline)) onChurch++;
    }
    console.log(
      `[world] ${assembled.eaveSources.length} eave copies (${onChurch} on the church), worst ${JSON.stringify(worst)}, darkest ${darkest.toFixed(3)}`,
    );
    expect(bad).toEqual([]);
    expect(worst.normal).toBeLessThan(-0.9999);
    // The long axis survives the flip, the church's yaw π/2 nave (normal z ≈ 0) included.
    expect(worst.long).toBeGreaterThan(0.9999);
    expect(worst.plane).toBeLessThan(1e-4);
    expect(worst.shade).toBeLessThan(EAVE_UNDERSIDE_SHADE + 0.01);
    expect(onChurch).toBeGreaterThan(100);
  });

  test('every roof stroke centred over an overhang band has a copy, and no stroke deep inside does', () => {
    // Independent of the footprint test: a stroke whose centre is itself past the wall line must
    // be copied, and one whose half length cannot reach the wall line must not be.
    const sources = new Set(assembled.eaveSources);
    let centred = 0;
    let deep = 0;
    const missing: number[] = [];
    const extra: number[] = [];
    for (let i = 0; i < scattered.count; i++) {
      if (scattered.meta[i * 4 + 1] !== STROKE_LAYER.building) continue;
      const s = unpackInstance(scattered, i);
      for (const { frame, box } of WORLD.village.roofs) {
        const on = ([1, -1] as const).some((side) => {
          const n = gableSlopeNormal(frame, box, side);
          const ridge = toWorld(frame, 0, box.eave + box.rise, 0);
          return dot3(s.normal, n) > 0.999 && Math.abs(dot3(sub3(s.position, ridge), n)) < 0.1;
        });
        if (!on) continue;
        const [lx, , lz] = toLocal(frame, s.position);
        const reach = Math.hypot(s.size[0], s.size[1]) / 2;
        if (Math.abs(lx) > box.width / 2 || Math.abs(lz) > box.depth / 2) {
          centred++;
          if (!sources.has(i)) missing.push(i);
        } else if (Math.abs(lx) + reach < box.width / 2 && Math.abs(lz) + reach < box.depth / 2) {
          deep++;
          if (sources.has(i)) extra.push(i);
        }
      }
    }
    console.log(`[world] ${centred} roof strokes centred over a band, ${deep} deep inside`);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    expect(centred).toBeGreaterThan(2000);
    expect(deep).toBeGreaterThan(2000);
  });

  test('the eave copies add no chunk and no draw: each joins a part that exists without them', () => {
    expect(batch.chunks.length).toBe(uncopied.chunks.length);
    // A world part is one draw class in one cubic cell (world parts never merge), so a copy whose
    // class and cell some other stroke already has joins that stroke's chunk. A copy of a stroke
    // within its lift of a cell face lands across it, in the neighbouring cell's chunk.
    const part = (n: number): string => {
      const cell = [0, 1, 2].map((a) => Math.floor(buffers.position[n * 3 + a] / WORLD_CELL_SIZE));
      return `${drawClassOf(buffers, n)}:${cell.join(',')}`;
    };
    const parts = new Set<string>();
    for (let i = 0; i < assembled.eavesStart; i++) parts.add(part(i));
    let crossed = 0;
    const alone: number[] = [];
    for (const [k, i] of assembled.eaveSources.entries()) {
      const j = assembled.eavesStart + k;
      if (part(j) !== part(i)) crossed++;
      if (!parts.has(part(j))) alone.push(k);
    }
    console.log(`[world] ${crossed} eave copies land across a cell face from their stroke`);
    expect(alone).toEqual([]);
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
    // their anchor for the P4.3 rings (1e63faa8 before, every other field unchanged), and a moon
    // stroke's carries its still tag or shimmer phase (b4a55fd9 before, every other field
    // unchanged). The cypress strokes' colour alpha carries their flame lobe and height (P4.4):
    // with every alpha back at 255 the scatter hashes as it did before (cf326988). The eave copies
    // are assembled outside the cache too, from the scattered strokes.
    const haze = strokeRange(buffers, assembled.hazeStart, assembled.eavesStart);
    const eaves = strokeRange(buffers, assembled.eavesStart);
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
      eaves: eaves.count,
      eavesHash: hashStrokeBuffers(eaves),
    };
    expect(pins).toEqual({
      total: 555_447,
      layers: {
        sky: 283_858,
        star: 0,
        moon: 0,
        cypress: 37_078,
        ground: 129_925,
        building: 104_586,
      },
      hash: '17b760ed',
      opaqueHash: '05216d51',
      lights: 4_960,
      lightsHash: '8553acd9',
      haze: 30_000,
      hazeUnflagged: 0,
      hazeHash: '01933fb0',
      eaves: 10_098,
      eavesHash: '4c6abbb3',
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

  test('village and church strokes stay inside their host face plus 10% of their width (pane corners CORNER_OUTLINE_REACH more)', () => {
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
    const worstExcess = { near: -1, mid: -1, far: -1, cap: -1 };
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
        // A pane's corner outline strokes reach past the corner along their side by design.
        const allowed = FACE_CLAMP_MARGIN + (pane ? CORNER_OUTLINE_REACH : 0);
        worstExcess[band] = Math.max(worstExcess[band], ratio - allowed);
        if (ratio > allowed + 1e-3) over[band]++;
      }
    }
    console.log(
      `[world] village overhang / footprint width over ${checked} strokes (${panes} on panes, ${unmatched} unmatched): max ${JSON.stringify(worst)}, over the limit ${JSON.stringify(over)}`,
    );
    expect(unmatched).toBe(0);
    expect(checked).toBeGreaterThan(50_000);
    expect(panes).toBeGreaterThan(4000);
    for (const band of bands) {
      expect(worstExcess[band], band).toBeLessThanOrEqual(1e-3);
    }
  });

  test("each tinted under-paint triangle is its owner's scattered stroke colour times the tint shade", () => {
    // Against the scattered strokes, not pickTint: a village stroke on a face turned away from the
    // painter takes its colour from its owner's tint choices alone (no scan mix, no lift), so per
    // owner and role the per-channel median of those strokes, with the shade the scatter divided
    // out restored, is the colour the under-paint must darken. Strokes are hosted by plane and
    // triangle as in the overhang test; a stroke whose hosts disagree on owner or role is skipped.
    // Outline trim strokes share the faces and stay in: no per-instance field tells them apart. They
    // are at most OUTLINE_SHARE of a face's strokes, so the median ignores them, and a trim colour
    // can only make `nearest` easier, never harder, so it cannot fail the own seed. On another seed
    // it can only add matches, which the one-third bound below allows for.
    const LAYERS = ['building', 'roof', 'church'] as const;
    type Tri = { a: Vec3; b: Vec3; c: Vec3; n: Vec3; d: number; key: string; index: number };
    const planes: { n: Vec3; d: number; tris: Tri[] }[] = [];
    for (const layer of LAYERS) {
      const g = WORLD.surfaces.find((s) => s.userData.layer === layer) as BufferGeometry;
      const tags = g.userData.tint as TintTags;
      const pos = g.getAttribute('position');
      for (let t = 0; t * 3 < pos.count; t++) {
        const [a, b, c] = [0, 1, 2].map(
          (k) => [pos.getX(t * 3 + k), pos.getY(t * 3 + k), pos.getZ(t * 3 + k)] as Vec3,
        );
        const n = unit3(cross3(sub3(b, a), sub3(c, a)));
        const key = `${layer}:${tags.owner[t]}:${tags.role[t]}`;
        const tri = { a, b, c, n, d: dot3(n, a), key, index: t };
        const plane = planes.find((q) => dot3(q.n, n) > 1 - 1e-6 && Math.abs(q.d - tri.d) < 1e-4);
        if (plane) plane.tris.push(tri);
        else planes.push({ n, d: tri.d, tris: [tri] });
      }
    }
    const strokes = new Map<string, Vec3[]>();
    let ambiguous = 0;
    for (let i = 0; i < scattered.count; i++) {
      if (scattered.meta[i * 4 + 1] !== STROKE_LAYER.building) continue;
      const s = unpackInstance(scattered, i);
      if (((s.flags ?? 0) & DEPTH_TIE_BREAK_FRONT_FLAG) !== 0) continue;
      const keys = new Set<string>();
      let host: Vec3 | null = null;
      for (const p of planes) {
        if (dot3(p.n, s.normal) < 0.9999) continue;
        const lift = dot3(p.n, s.position) - p.d;
        if (lift < -1e-3 || lift > 0.05) continue;
        for (const t of p.tris) {
          if (distanceToTriangle(s.position, t) < 1e-4) {
            keys.add(t.key);
            host = p.n;
          }
        }
      }
      if (keys.size !== 1 || !host) {
        if (keys.size > 1) ambiguous++;
        continue;
      }
      if (facesEye(s.position, host, PAINTER_EYE)) continue;
      const shade = strokeShade(s.normal);
      const key = [...keys][0] as string;
      const list = strokes.get(key) ?? [];
      list.push([s.color[0] * shade, s.color[1] * shade, s.color[2] * shade]);
      strokes.set(key, list);
    }
    const median = (v: number[]): number => {
      const sorted = [...v].sort((p, q) => p - q);
      return sorted[sorted.length >> 1] as number;
    };
    const strokeMedian = new Map<string, Vec3>();
    for (const [key, list] of strokes) {
      if (list.length < 30) continue;
      strokeMedian.set(key, [0, 1, 2].map((k) => median(list.map((c) => c[k]))) as unknown as Vec3);
    }
    const byte = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));
    const lab8 = (c: readonly number[]) => srgb8ToLab(byte(c[0]), byte(c[1]), byte(c[2]));
    // Per owner and role: ΔE2000 from the under-paint ÷ the shade to the nearest of its strokes and
    // to their median. It matches when it is one of its strokes' own colours, within the byte
    // rounding of the restored shade, and sits among them rather than at an outlier.
    const match = (seed: number): { nearest: number; median: number; matched: number } => {
      const group = createBaseMeshes(WORLD.surfaces, SOURCE.histogram, 'underpaint', seed);
      const worst = { nearest: 0, median: 0, matched: 0 };
      for (const layer of LAYERS) {
        const mesh = group.children.find(
          (m) => (m as Mesh).geometry.userData.layer === layer,
        ) as Mesh<BufferGeometry, MeshBasicMaterial>;
        const colors = mesh.geometry.getAttribute('color');
        const tags = mesh.geometry.userData.tint as TintTags;
        const done = new Set<string>();
        for (let t = 0; t < tags.owner.length; t++) {
          const key = `${layer}:${tags.owner[t]}:${tags.role[t]}`;
          const target = strokeMedian.get(key);
          if (!target || done.has(key)) continue;
          done.add(key);
          const rgb = { r: 0, g: 0, b: 0 };
          new Color(colors.getX(t * 3), colors.getY(t * 3), colors.getZ(t * 3)).getRGB(
            rgb,
            SRGBColorSpace,
          );
          const k = 255 / TINT_UNDERPAINT_SHADE;
          const tint = lab8([rgb.r * k, rgb.g * k, rgb.b * k]);
          let nearest = Number.POSITIVE_INFINITY;
          for (const c of strokes.get(key) ?? []) {
            nearest = Math.min(nearest, deltaE2000(tint, lab8(c)));
          }
          const median = deltaE2000(tint, lab8(target));
          worst.nearest = Math.max(worst.nearest, nearest);
          worst.median = Math.max(worst.median, median);
          if (nearest <= TINT_MATCH_DE && median <= TINT_MEDIAN_DE) worst.matched++;
        }
      }
      return worst;
    };
    const own = match(SEEDS.scatter);
    const others = [1, 2, 3].map((k) => match(SEEDS.scatter + k).matched);
    console.log(
      `[world] tinted under-paint vs strokes over ${strokeMedian.size} owner roles (${ambiguous} ambiguous strokes): worst ΔE2000 nearest ${own.nearest.toFixed(2)}, median ${own.median.toFixed(2)}; other seeds match ${others.join(', ')}`,
    );
    expect(strokeMedian.size).toBeGreaterThan(20);
    expect(own.nearest).toBeLessThanOrEqual(TINT_MATCH_DE);
    expect(own.median).toBeLessThanOrEqual(TINT_MEDIAN_DE);
    expect(own.matched).toBe(strokeMedian.size);
    // A seed or layer mismatch with the scatter must show. Another seed's pick still matches where
    // it lands among the true tint's neighbours (or near a trim colour), which is a minority.
    for (const matched of others) expect(matched).toBeLessThan(strokeMedian.size / 3);
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
    for (const { name, position, yaw, pitch } of [...COVERAGE_POSES, ...CREST_POSES]) {
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

  test('the pane probe far poses see their pane, inside the boundary, from the far band', () => {
    const camera = new PerspectiveCamera(
      PROBE_FOV_DEG,
      PROBE_VIEW.width / PROBE_VIEW.height,
      0.1,
      1000,
    );
    camera.rotation.order = 'YXZ';
    const sight = sightTest(WORLD);
    const all = panes(WORLD);
    expect(all).toHaveLength(15);
    const found: number[] = [];
    for (const pane of all) {
      const pose = farPose(WORLD, pane, sight);
      if (!pose) continue;
      found.push(pane.house);
      expect(Math.hypot(pose.eye[0], pose.eye[2])).toBeLessThanOrEqual(FAR_MAX_RADIUS_M);
      for (const p of [pane.window.center, ...pane.corners]) {
        expect(sight.clear(pose.eye, p, pane.house), `house ${pane.house}`).toBe(true);
      }
      // The e2e boots at the painter spot, then jumps to the pose.
      for (const [position, yaw, pitch] of [
        [[0, 1.6, 0], 0, 0],
        [pose.eye, pose.yaw, pose.pitch],
      ] as const) {
        camera.position.set(...(position as [number, number, number]));
        camera.rotation.set(pitch, yaw, 0);
        camera.updateMatrixWorld();
        batch.update(camera);
      }
      // The probe's own projection agrees with the camera's.
      const quad = project(pose, pane.corners);
      expect(quad).not.toBeNull();
      pane.corners.forEach((corner, k) => {
        const ndc = new Vector3(...corner).project(camera);
        const [x, y] = quad?.[k] ?? [Number.NaN, Number.NaN];
        expect(x).toBeCloseTo(((ndc.x + 1) / 2) * PROBE_VIEW.width, 3);
        expect(y).toBeCloseTo(((1 - ndc.y) / 2) * PROBE_VIEW.height, 3);
      });
      const centre = new Vector3(...pane.window.center);
      const chunks = batch.chunks.filter(
        (c) => c.drawClass === 'overlay' && c.bounds.distanceToPoint(centre) <= 0,
      );
      expect(chunks.length, `house ${pane.house}`).toBeGreaterThan(0);
      for (const c of chunks) expect(c.band, `house ${pane.house}: ${c.mesh.name}`).toBe('far');
    }
    // Seed 1: houses 0, 1, 12 and 14 have no far pose that sees the whole pane inside 44 m.
    expect(found).toEqual([4, 5, 7, 8, 9, 10, 11, 15, 16, 17, 19]);
  });

  test('the dome merges by sky sector and the lights into one chunk, every other part alone', () => {
    const dome = batch.chunks.filter((c) => c.drawClass === 'dome');
    const lights = batch.chunks.filter((c) => c.drawClass === 'lights');
    const of = (b: StrokeBatch, drawClass: string) =>
      b.chunks.filter((c) => c.drawClass === drawClass);
    expect(lights.map((c) => c.mesh.name)).toEqual(['strokes-lights-sky']);
    expect(lights[0].pinned).toBe(lights[0].count);
    expect(lights[0].count).toBe(assembled.counts.star + assembled.counts.moon);
    // Seed 1: 436 dome parts, 34 sky sectors, and the 15 parts flight can bring near kept alone.
    const sectors = dome.filter((c) => c.mesh.name.startsWith('strokes-dome-'));
    const alone = dome.filter((c) => !c.mesh.name.startsWith('strokes-dome-'));
    expect(of(plain, 'dome')).toHaveLength(436);
    expect(sectors).toHaveLength(34);
    expect(alone).toHaveLength(15);
    for (const chunk of alone) {
      expect(plain.chunks.map((c) => c.mesh.name)).toContain(chunk.mesh.name);
    }
    for (const drawClass of ['dome', 'lights'] as const) {
      const sum = (chunks: readonly { count: number }[]) => chunks.reduce((s, c) => s + c.count, 0);
      expect(sum(of(batch, drawClass)), drawClass).toBe(sum(of(plain, drawClass)));
    }
    for (const drawClass of ['cypress', 'world', 'overlay'] as const) {
      expect(
        of(batch, drawClass).map((c) => [c.mesh.name, c.count]),
        drawClass,
      ).toEqual(of(plain, drawClass).map((c) => [c.mesh.name, c.count]));
    }
    console.log(
      `[world] ${batch.chunks.length} chunks (${sectors.length} dome sectors, ${alone.length} dome parts alone), ${plain.chunks.length} before the merge`,
    );
  });

  test('every dome part flight can bring under the far edge stays a chunk of its own', () => {
    // Exact over the envelope's columns on a 0.5 m grid plus its rim: the nearest head position to
    // a part's probe sphere, from the ground to MAX_ALTITUDE above it.
    const r = MAX_FLIGHT_RADIUS;
    const columns: [number, number, number][] = [];
    for (let x = -r; x <= r; x += 0.5) {
      for (let z = -r; z <= r; z += 0.5) {
        if (Math.hypot(x, z) <= r) columns.push([x, z, WORLD.terrain.heightAt(x, z)]);
      }
    }
    for (let k = 0; k < 1440; k++) {
      const a = (k / 1440) * 2 * Math.PI;
      const x = r * Math.sin(a);
      const z = r * Math.cos(a);
      columns.push([x, z, WORLD.terrain.heightAt(x, z)]);
    }
    const names = new Set(batch.chunks.map((c) => c.mesh.name));
    let reachable = 0;
    for (const chunk of plain.chunks) {
      if (chunk.drawClass !== 'dome') continue;
      const { x, y, z } = chunk.bounds.center;
      let nearest = Number.POSITIVE_INFINITY;
      for (const [px, pz, g] of columns) {
        const py = Math.min(g + MAX_ALTITUDE, Math.max(g, y));
        nearest = Math.min(nearest, Math.hypot(x - px, y - py, z - pz));
      }
      // A far chunk drops to mid under this distance.
      if (nearest - chunk.bounds.radius >= MID_BAND_MAX_M - BAND_HYSTERESIS_M) continue;
      reachable++;
      expect(names.has(chunk.mesh.name), chunk.mesh.name).toBe(true);
    }
    expect(reachable).toBeGreaterThan(0);
    expect(WORLD_FLIGHT_REACH_M).toBeGreaterThanOrEqual(MID_BAND_MAX_M - BAND_HYSTERESIS_M + 1);
  });

  test('flying out to the cap, no merged sky chunk leaves the far band and the draws stay in budget', () => {
    const camera = new PerspectiveCamera(QUEST_FOV, QUEST_ASPECT, 0.05, 1000);
    camera.rotation.order = 'YXZ';
    let mid = 0;
    let most = 0;
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * 2 * Math.PI;
      for (const height of [1.6, 20, 38, MAX_ALTITUDE]) {
        for (let r = 40; r <= MAX_FLIGHT_RADIUS; r += 0.5) {
          const x = r * Math.sin(a);
          const z = -r * Math.cos(a);
          camera.position.set(x, WORLD.terrain.heightAt(x, z) + height, z);
          camera.rotation.set(0.5, -a, 0);
          camera.updateMatrixWorld();
          batch.update(camera);
          for (const chunk of batch.chunks) {
            if (chunk.drawClass !== 'dome' && chunk.drawClass !== 'lights') continue;
            if (chunk.band === 'far') continue;
            mid++;
            expect(chunk.mesh.name, `${k} ${height} ${r}`).not.toMatch(/^strokes-(dome|lights)-/);
          }
        }
        // At the cap, every heading of the view: the drawn total holds the default budget.
        for (let yaw = 0; yaw < 8; yaw++) {
          for (const pitch of [-0.4, 0, 0.6]) {
            camera.rotation.set(pitch, (yaw / 8) * 2 * Math.PI, 0);
            camera.updateMatrixWorld();
            batch.update(camera);
            most = Math.max(most, batch.visibleCount());
          }
        }
      }
    }
    console.log(
      `[world] flight sweep: ${mid} single-part sky chunk-frames under far, most drawn ${most}`,
    );
    expect(mid).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(STROKE_BUDGET.default.max);
  });

  test('at every pose every dome and lights chunk is far, before and after the merge', () => {
    const camera = new PerspectiveCamera(QUEST_FOV, QUEST_ASPECT, 0.05, 1000);
    camera.rotation.order = 'YXZ';
    for (const { name, position, yaw, pitch } of COVERAGE_POSES) {
      camera.position.set(...position);
      camera.rotation.set(pitch, yaw, 0);
      camera.updateMatrixWorld();
      for (const b of [batch, plain]) {
        b.update(camera);
        for (const chunk of b.chunks) {
          if (chunk.drawClass !== 'dome' && chunk.drawClass !== 'lights') continue;
          expect(chunk.band, `${name}: ${chunk.mesh.name}`).toBe('far');
        }
      }
    }
  });

  test('the merge halves the visible chunks at the painter and spawn views', () => {
    const views = {
      painter: { fov: CANVAS_FOV_Y_DEG, aspect: CANVAS_ASPECT, pitch: CANVAS_PITCH },
      'painter, Quest-wide': { fov: QUEST_FOV, aspect: QUEST_ASPECT, pitch: CANVAS_PITCH },
      spawn: { fov: 70, aspect: 1280 / 1014, pitch: 0 },
    };
    const seen: Record<string, [number, number]> = {};
    for (const [name, { fov, aspect, pitch }] of Object.entries(views)) {
      const camera = new PerspectiveCamera(fov, aspect, 0.1, 1000);
      camera.rotation.order = 'YXZ';
      camera.position.set(...PAINTER_EYE);
      camera.rotation.set(pitch, 0, 0);
      camera.updateMatrixWorld();
      const counts = [plain, batch].map((b) => {
        b.update(camera);
        return b.visibleChunkCount();
      });
      seen[name] = [counts[0], counts[1]];
      expect(counts[1] * 2, name).toBeLessThanOrEqual(counts[0]);
    }
    console.log(`[world] visible chunks before and after the merge ${JSON.stringify(seen)}`);
  });
});

describe('worldPartGroup', () => {
  /** A part centre 100 m from the painter's eye at this elevation and azimuth from -Z, degrees. */
  const at = (elevation: number, azimuth: number): [number, number, number] => {
    const e = (elevation * Math.PI) / 180;
    const a = (azimuth * Math.PI) / 180;
    const h = 100 * Math.cos(e);
    return [
      PAINTER_EYE[0] + h * Math.sin(a),
      PAINTER_EYE[1] + 100 * Math.sin(e),
      PAINTER_EYE[2] - h * Math.cos(a),
    ];
  };

  test('lights share one key and every class but the dome stays alone', () => {
    expect(worldPartGroup('lights', at(40, 30))).toBe('sky');
    expect(worldPartGroup('lights', at(-10, 170))).toBe('sky');
    for (const drawClass of ['world', 'overlay', 'cypress'] as const) {
      expect(worldPartGroup(drawClass, at(10, 0)), drawClass).toBeNull();
    }
  });

  test('rows count from the horizon in sector steps, negative below it, and the top row is one cap', () => {
    expect(WORLD_DOME_SECTOR_DEG).toBe(36);
    expect(worldPartGroup('dome', at(10, 90))).toMatch(/^0_/);
    expect(worldPartGroup('dome', at(50, 90))).toMatch(/^1_/);
    expect(worldPartGroup('dome', at(-20, 90))).toMatch(/^-1_/);
    for (const azimuth of [-179, -90, 0, 45, 179]) {
      expect(worldPartGroup('dome', at(80, azimuth)), `${azimuth}`).toBe('2_0');
    }
    expect(worldPartGroup('dome', [PAINTER_EYE[0], PAINTER_EYE[1] + 100, PAINTER_EYE[2]])).toBe(
      '2_0',
    );
  });

  test('slices split each row by azimuth, edge straight ahead, in range at ±180°', () => {
    // round(360 cos(row middle) / 36): 10 slices at rows 0 and -1, 6 at row 1.
    for (const [elevation, slices] of [
      [10, 10],
      [-20, 10],
      [50, 6],
    ] as const) {
      const seen = new Set<string>();
      for (let azimuth = -180; azimuth <= 180; azimuth += 0.5) {
        const key = worldPartGroup('dome', at(elevation, azimuth)) as string;
        const slice = Number(key.split('_')[1]);
        expect(slice, `${elevation} ${azimuth}`).toBeGreaterThanOrEqual(0);
        expect(slice, `${elevation} ${azimuth}`).toBeLessThan(slices);
        seen.add(key);
      }
      expect(seen.size, `${elevation}`).toBe(slices);
    }
    expect(worldPartGroup('dome', at(10, -0.5))).not.toBe(worldPartGroup('dome', at(10, 0.5)));
    expect(worldPartGroup('dome', at(10, 180))).toBe('0_9');
    expect(worldPartGroup('dome', at(10, -179.9))).toBe('0_0');
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
