import {
  DataTexture,
  type InstancedBufferAttribute,
  type InstancedBufferGeometry,
  IntType,
  type Mesh,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  Vector3,
} from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { motionClock } from '../src/motion/clock.ts';
import { MOTION_LAYER_MASK, REACTIVE_MOTION_BIT } from '../src/motion/layers.ts';
import {
  insideReactiveBox,
  REACTIVE_MAX_GAIN,
  REACTIVE_REACH,
  reactiveTracker,
} from '../src/motion/reactive.ts';
import { SKY_RINGS, skyRingReach } from '../src/motion/sky-rings.ts';
import { skySwirlReach } from '../src/motion/sky-swirl.ts';
import { BASE_MESH_RENDER_ORDER } from '../src/paintings/starry-night/base-meshes.ts';
import { createSkyHalo } from '../src/render/sky-halo.ts';
import { DEPTH_BACKDROP_FLAG } from '../src/render/strokes/backdrop-depth.ts';
import {
  bandDrawCount,
  DEFAULT_BAND_DENSITY,
  DEFAULT_BAND_SIZE,
  STROKE_BANDS,
} from '../src/render/strokes/bands.ts';
import {
  BATCH_DEPTH_WRITE,
  createStrokeBatch,
  DEFAULT_ORDER_POLICY,
  drawClassOf,
  holdsHaze,
  interleaveOrders,
  isCypressStroke,
  isPinnedStroke,
  SKY_REACH_MARGIN,
  STROKE_DRAW_CLASSES,
  STROKES_AFTER_BASE,
  type StrokeBatch,
  WRITE_ORDER_POLICY,
} from '../src/render/strokes/batch.ts';
import { cullAndSortInto } from '../src/render/strokes/chunks.ts';
import { DEPTH_TIE_BREAK_FRONT_FLAG } from '../src/render/strokes/depth-tie-break.ts';
import { importanceOrder } from '../src/render/strokes/importance.ts';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  type StrokeBuffers,
  selectStrokes,
} from '../src/render/strokes/instance.ts';
import { HAZE_GROWTH } from '../src/render/strokes/material.ts';
import { SKY_LIGHT_CULL_FLAG } from '../src/render/strokes/sky-light-cull.ts';
import { mulberry32 } from '../src/util/prng.ts';

vi.mock('../src/render/strokes/chunks.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/render/strokes/chunks.ts')>();
  return { ...actual, cullAndSortInto: vi.fn(actual.cullAndSortInto) };
});

/** Sets the app's reactive box, the uniforms every stroke material shares with the tracker. */
function setReactiveBox(centre: [number, number, number], half: [number, number, number]): void {
  reactiveTracker.uniforms.uReactiveCentre.value.set(...centre);
  reactiveTracker.uniforms.uReactiveHalf.value.set(...half);
}

function tinyAtlas(): DataTexture {
  return new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
}

/**
 * Strokes in a row along -z at x = 0, one per metre: 4 m cells give one chunk per 4 strokes. On a
 * still layer, so no motion reach widens the cull spheres the culling tests pin.
 */
function row(count: number, zStart = -1): StrokeBuffers {
  const buffers = createStrokeBuffers(count);
  for (let i = 0; i < count; i++) {
    packInstance(buffers, i, {
      position: [0.5, 1.6, zStart - i],
      normal: [0, 0, 1],
      tangent: 0,
      color: [200, 180, 40, 255],
      size: [0.2, 0.1],
      brush: i % 16,
      layer: STROKE_LAYER.ground,
      phase: 0,
    });
  }
  return buffers;
}

/** `count` strokes within 0.4 m of `center`, facing +z: one chunk at 4 m cells. */
function cluster(
  count: number,
  center: readonly [number, number, number],
  seed = 1,
): StrokeBuffers {
  const rand = mulberry32(seed);
  const buffers = createStrokeBuffers(count);
  for (let i = 0; i < count; i++) {
    packInstance(buffers, i, {
      position: [
        center[0] + (rand() - 0.5) * 0.8,
        center[1] + (rand() - 0.5) * 0.8,
        center[2] + (rand() - 0.5) * 0.8,
      ],
      normal: [0, 0, 1],
      tangent: 0,
      color: [200, 180, 40, 255],
      size: [0.04, 0.02],
      brush: i % 16,
      layer: STROKE_LAYER.ground,
      phase: 0,
    });
  }
  return buffers;
}

function concat(...parts: StrokeBuffers[]): StrokeBuffers {
  const out = createStrokeBuffers(parts.reduce((sum, b) => sum + b.count, 0));
  let at = 0;
  for (const part of parts) {
    out.position.set(part.position, at * 3);
    out.normal.set(part.normal, at * 2);
    out.tangent.set(part.tangent, at);
    out.color.set(part.color, at * 4);
    out.size.set(part.size, at * 2);
    out.meta.set(part.meta, at * 4);
    at += part.count;
  }
  return out;
}

/** A camera at the origin looking down -z with a 90 degree square frustum. */
function originCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(90, 1, 0.05, 1000);
  camera.updateMatrixWorld();
  return camera;
}

/** Chunks of 100, 7 and 1 strokes in the near band, 50 in mid and 40 in far, all in view. */
function bandedBatch(): StrokeBatch {
  // Each cluster sits inside one 4 m cell.
  return createStrokeBatch(
    concat(
      cluster(100, [1, 1, -3]),
      cluster(7, [-1, 1, -3], 2),
      cluster(1, [1, -1, -3], 3),
      cluster(50, [2, 2, -14], 4),
      cluster(40, [2, 2, -42], 5),
    ),
    { cellSize: 4, createAtlas: tinyAtlas },
  );
}

function render(batch: ReturnType<typeof createStrokeBatch>, camera: PerspectiveCamera): void {
  camera.updateMatrixWorld();
  batch.update(camera);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createStrokeBatch', () => {
  test('builds one instanced chunk per grid cell sharing the material and atlas', () => {
    const atlas = tinyAtlas();
    const batch = createStrokeBatch(row(16, -0.5), { cellSize: 4, createAtlas: () => atlas });
    expect(batch.chunks).toHaveLength(4);
    expect(batch.group.children).toHaveLength(4);
    expect(batch.atlas).toBe(atlas);
    for (const chunk of batch.chunks) {
      expect(chunk.band).toBeNull();
      expect(chunk.mesh.material).toBe(batch.materials.near);
      expect(chunk.mesh.frustumCulled).toBe(false);
      expect(chunk.geometry.instanceCount).toBe(chunk.count);
      expect(chunk.drawCount).toBe(chunk.count);
      const meta = chunk.geometry.getAttribute('iMeta') as InstancedBufferAttribute;
      expect(meta.gpuType).toBe(IntType);
      expect(meta.normalized).toBe(false);
      expect(chunk.geometry.getAttribute('iNormal').normalized).toBe(true);
      expect(chunk.geometry.getAttribute('iTangent').normalized).toBe(true);
      expect(chunk.geometry.getAttribute('iColor').normalized).toBe(true);
    }
    expect(batch.chunks.reduce((sum, c) => sum + c.count, 0)).toBe(16);
    for (const band of STROKE_BANDS) {
      const material = batch.materials[band];
      expect(material.uniforms.uAtlas.value).toBe(atlas);
      expect(material.uniforms.uSizeScale.value).toBe(DEFAULT_BAND_SIZE[band]);
      expect(material.alphaToCoverage).toBe(true);
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(BATCH_DEPTH_WRITE);
      expect(material.depthWrite).toBe(false);
      // Same source and defines: three compiles one program for all three bands.
      expect(material.vertexShader).toBe(batch.materials.near.vertexShader);
      expect(material.fragmentShader).toBe(batch.materials.near.fragmentShader);
      expect(material.defines).toEqual(batch.materials.near.defines);
    }
    expect(new Set(STROKE_BANDS.map((b) => batch.materials[b])).size).toBe(3);
    batch.dispose();
  });

  test('reports the atlas generation time', () => {
    const batch = createStrokeBatch(row(2), { createAtlas: tinyAtlas });
    expect(batch.stats().atlasMs).toBeGreaterThanOrEqual(0);
    batch.dispose();
  });

  test('setDrawCount clamps to the chunk and drives instanceCount', () => {
    const batch = createStrokeBatch(row(4), { cellSize: 100, createAtlas: tinyAtlas });
    const [chunk] = batch.chunks;
    chunk.setDrawCount(2);
    expect(chunk.geometry.instanceCount).toBe(2);
    chunk.setDrawCount(99);
    expect(chunk.drawCount).toBe(4);
    chunk.setDrawCount(-3);
    expect(chunk.drawCount).toBe(0);
    batch.dispose();
  });
});

describe('bands', () => {
  test('update puts each chunk in the band of its nearest point, with that band material', () => {
    const batch = bandedBatch();
    batch.update(originCamera());
    expect(batch.chunks.map((c) => [c.count, c.band])).toEqual([
      [7, 'near'],
      [1, 'near'],
      [40, 'far'],
      [50, 'mid'],
      [100, 'near'],
    ]);
    for (const chunk of batch.chunks) {
      expect(chunk.mesh.material).toBe(batch.materials[chunk.band ?? 'near']);
    }
    batch.dispose();
  });

  test('setDensity sets every chunk in the band to exactly floor(d * count)', () => {
    const batch = bandedBatch();
    batch.update(originCamera());
    const byCount = (n: number) => batch.chunks.find((c) => c.count === n);
    const versions = batch.chunks.map(
      (c) => (c.geometry.getAttribute('iPosition') as InstancedBufferAttribute).version,
    );
    expect(byCount(50)?.drawCount).toBe(Math.floor(DEFAULT_BAND_DENSITY.mid * 50));
    expect(byCount(40)?.drawCount).toBe(Math.floor(DEFAULT_BAND_DENSITY.far * 40));

    batch.setDensity('near', 0.29);
    expect(batch.density('near')).toBe(0.29);
    expect(byCount(100)?.drawCount).toBe(29);
    expect(byCount(7)?.drawCount).toBe(2);
    expect(byCount(1)?.drawCount).toBe(0);
    expect(byCount(50)?.drawCount).toBe(Math.floor(DEFAULT_BAND_DENSITY.mid * 50));

    batch.setDensity('near', 0.5);
    expect(byCount(100)?.drawCount).toBe(50);
    expect(byCount(7)?.drawCount).toBe(3);
    batch.setDensity('mid', 2);
    expect(batch.density('mid')).toBe(1);
    expect(byCount(50)?.drawCount).toBe(50);
    batch.setDensity('far', -1);
    expect(batch.density('far')).toBe(0);
    expect(byCount(40)?.drawCount).toBe(0);
    expect(() => batch.setDensity('far', Number.NaN)).toThrow(RangeError);
    expect(() => batch.setDensity('huge' as 'far', 0.5)).toThrow(RangeError);

    // Only instance counts change: no attribute was rewritten or replaced.
    batch.chunks.forEach((c, i) => {
      expect((c.geometry.getAttribute('iPosition') as InstancedBufferAttribute).version).toBe(
        versions[i],
      );
    });
    // Later frames keep the counts while the bands hold.
    batch.update(originCamera());
    expect(byCount(100)?.drawCount).toBe(50);
    batch.dispose();
  });

  test('visibleCount and the per-band stats agree with the drawn chunks', () => {
    const batch = bandedBatch();
    const camera = originCamera();
    batch.update(camera);
    const drawn = batch.chunks
      .filter((c) => c.mesh.visible)
      .reduce((sum, c) => sum + c.drawCount, 0);
    expect(batch.visibleCount()).toBe(drawn);
    const stats = batch.stats();
    expect(stats.visible).toBe(drawn);
    const bands = STROKE_BANDS.map((b) => stats.bands[b]);
    expect(bands.reduce((sum, b) => sum + b.visible, 0)).toBe(stats.visible);
    expect(bands.reduce((sum, b) => sum + b.chunks, 0)).toBe(stats.visibleChunks);
    expect(batch.visibleChunkCount()).toBe(stats.visibleChunks);
    expect(stats.visibleChunks).toBeGreaterThan(0);
    expect(stats.bands.near).toEqual({
      d: 1,
      size: DEFAULT_BAND_SIZE.near,
      chunks: 3,
      visible: 108,
    });
    const perBand = (): Record<string, number> =>
      Object.fromEntries(STROKE_BANDS.map((b) => [b, batch.stats().bands[b].visible]));
    expect({ ...batch.visibleByBand() }).toEqual(perBand());
    const record = batch.visibleByBand();
    batch.setDensity('near', 0.5);
    expect(batch.visibleCount()).toBe(drawn - 108 + 53);
    expect(batch.stats().bands.near.d).toBe(0.5);
    // The same record, recounted after a density change outside update.
    expect(batch.visibleByBand()).toBe(record);
    expect({ ...batch.visibleByBand() }).toEqual(perBand());
    expect(batch.visibleByBand().near).toBe(53);

    // Facing away culls everything: nothing is drawn, whatever the densities.
    camera.rotation.set(0, Math.PI, 0);
    camera.updateMatrixWorld();
    batch.update(camera);
    expect(batch.visibleCount()).toBe(0);
    expect(batch.visibleChunkCount()).toBe(0);
    expect(batch.stats().bands.near).toMatchObject({ chunks: 0, visible: 0 });
    expect(batch.visibleByBand()).toEqual({ near: 0, mid: 0, far: 0 });
    batch.dispose();
  });

  test('before the first update nothing draws and the band sums already hold', () => {
    const batch = bandedBatch();
    for (const chunk of batch.chunks) expect(chunk.mesh.visible).toBe(false);
    const stats = batch.stats();
    expect(batch.visibleCount()).toBe(0);
    expect(stats).toMatchObject({ chunks: 5, visibleChunks: 0, total: 198, visible: 0 });
    for (const band of STROKE_BANDS) {
      expect(stats.bands[band]).toMatchObject({ chunks: 0, visible: 0 });
    }
    expect(batch.visibleChunkCount()).toBe(0);
    batch.update(originCamera());
    expect(batch.stats().visibleChunks).toBe(5);
    expect(batch.visibleChunkCount()).toBe(5);
    batch.dispose();
  });

  test('a density set while chunks are culled holds once they come into view', () => {
    const batch = bandedBatch();
    const camera = originCamera();
    camera.rotation.set(0, Math.PI, 0);
    camera.updateMatrixWorld();
    batch.update(camera);
    expect(batch.visibleCount()).toBe(0);
    batch.setDensity('near', 0.29);
    const near = batch.chunks.filter((c) => c.band === 'near');
    expect(near.map((c) => [c.count, c.drawCount])).toEqual([
      [7, 2],
      [1, 0],
      [100, 29],
    ]);
    camera.rotation.set(0, 0, 0);
    camera.updateMatrixWorld();
    batch.update(camera);
    expect(near.map((c) => [c.mesh.visible, c.drawCount])).toEqual([
      [true, 2],
      [true, 0],
      [true, 29],
    ]);
    expect(batch.stats().bands.near).toMatchObject({ chunks: 3, visible: 31 });
    batch.dispose();
  });

  test('setSizeMultiplier drives the band uniform and widens its cull sphere', () => {
    // One 1 x 1 m stroke in the mid band whose 1x bounds sit 0.7 m outside the left frustum plane.
    const buffers = createStrokeBuffers(1);
    packInstance(buffers, 0, {
      position: [-7, 0.1, -5],
      normal: [0, 0, 1],
      tangent: 0,
      color: [255, 255, 255, 255],
      size: [1, 1],
      brush: 0,
      layer: STROKE_LAYER.ground,
      phase: 0,
    });
    const batch = createStrokeBatch(buffers, { cellSize: 4, createAtlas: tinyAtlas });
    const [chunk] = batch.chunks;
    batch.setSizeMultiplier('mid', 1);
    batch.update(originCamera());
    expect(chunk.band).toBe('mid');
    expect(chunk.mesh.visible).toBe(false);
    batch.setSizeMultiplier('mid', 2.5);
    expect(batch.sizeMultiplier('mid')).toBe(2.5);
    expect(batch.materials.mid.uniforms.uSizeScale.value).toBe(2.5);
    expect(batch.materials.near.uniforms.uSizeScale.value).toBe(DEFAULT_BAND_SIZE.near);
    expect(batch.stats().bands.mid.size).toBe(2.5);
    batch.update(originCamera());
    expect(chunk.mesh.visible).toBe(true);
    expect(() => batch.setSizeMultiplier('mid', 0)).toThrow(RangeError);
    expect(() => batch.setSizeMultiplier('mid', Number.POSITIVE_INFINITY)).toThrow(RangeError);
    batch.dispose();
  });

  test('a star chunk grows by calm times its ring reach while the star gate is open (P4.3)', () => {
    // A star stroke halfway out its ring, where it moves farthest, and a sky stroke far from it.
    const ring = SKY_RINGS[10];
    const star: [number, number, number] = [
      ring.centre[0] + 0.5 * ring.outer,
      ring.centre[1],
      ring.centre[2],
    ];
    const buffers = createStrokeBuffers(2);
    for (const [i, position, layer, phase] of [
      [0, star, STROKE_LAYER.star, 10],
      [1, [60, 40, -60], STROKE_LAYER.sky, 0],
    ] as const) {
      packInstance(buffers, i, {
        position,
        normal: [0, 0, 1],
        tangent: 0,
        color: [255, 255, 255, 255],
        size: [2, 1],
        brush: 0,
        layer,
        phase,
      });
    }
    const batch = createStrokeBatch(buffers, { cellSize: 24, createAtlas: tinyAtlas });
    expect(batch.chunks).toHaveLength(2);
    const cull = vi.mocked(cullAndSortInto);
    const radii = (): number[] => {
      batch.update(originCamera());
      return (cull.mock.calls.at(-1)?.[0] ?? []).map((sphere) => sphere.radius);
    };
    const starChunk = batch.chunks.findIndex((c) => c.bounds.center.x < 30);
    const skyChunk = 1 - starChunk;
    const starReach = SKY_REACH_MARGIN * skyRingReach(ring, ...star);
    const skyReach = SKY_REACH_MARGIN * skySwirlReach(60, 40, -60);
    expect(starReach).toBeCloseTo(0.25 * ring.swell * ring.outer * SKY_REACH_MARGIN, 4);
    const rest = radii();
    try {
      motionClock.setLayerMask(1 << STROKE_LAYER.star);
      motionClock.setCalm(0.5);
      const star = radii();
      expect(star[starChunk]).toBeCloseTo(rest[starChunk] + 0.5 * starReach, 4);
      expect(star[skyChunk]).toBe(rest[skyChunk]);
      motionClock.setLayerMask(1 << STROKE_LAYER.sky);
      const sky = radii();
      expect(sky[starChunk]).toBe(rest[starChunk]);
      expect(sky[skyChunk]).toBeCloseTo(rest[skyChunk] + 0.5 * skyReach, 9);
      motionClock.setLayerMask(MOTION_LAYER_MASK & ~REACTIVE_MOTION_BIT);
      motionClock.setCalm(1);
      const all = radii();
      expect(all[starChunk]).toBeCloseTo(rest[starChunk] + starReach, 4);
      // The reactive bit grows a chunk whose rest centres the reactive box reaches by calm times
      // the reactive reach on top (P4.5, R-P4a), and its half-diagonal term by the stretch growth's
      // cap (P4.6). Each chunk holds one stroke, so its rest radius is that stroke's half-diagonal
      // times the band size. An empty box grows none of them.
      const grown = (i: number): number => REACTIVE_MAX_GAIN * rest[i];
      motionClock.setLayerMask(MOTION_LAYER_MASK);
      const reactiveReach = SKY_REACH_MARGIN * REACTIVE_REACH;
      setReactiveBox([0, 0, 0], [-1, -1, -1]);
      const empty = radii();
      expect(empty[starChunk]).toBeCloseTo(rest[starChunk] + starReach, 4);
      expect(empty[skyChunk]).toBeCloseTo(rest[skyChunk] + skyReach, 9);
      // A box round the sky stroke alone grows its chunk and leaves the star chunk as it was.
      setReactiveBox([60, 40, -60], [0.6, 0.6, 0.6]);
      const skyOnly = radii();
      expect(skyOnly[starChunk]).toBeCloseTo(rest[starChunk] + starReach, 4);
      expect(skyOnly[skyChunk]).toBeCloseTo(
        rest[skyChunk] + skyReach + reactiveReach + grown(skyChunk),
        9,
      );
      // A box round both grows both.
      setReactiveBox([0, 0, 0], [1e4, 1e4, 1e4]);
      const live = radii();
      expect(live[starChunk]).toBeCloseTo(
        rest[starChunk] + starReach + reactiveReach + grown(starChunk),
        4,
      );
      expect(live[skyChunk]).toBeCloseTo(
        rest[skyChunk] + skyReach + reactiveReach + grown(skyChunk),
        9,
      );
      motionClock.setLayerMask(REACTIVE_MOTION_BIT);
      motionClock.setCalm(0.5);
      const reactiveOnly = radii();
      expect(reactiveOnly[starChunk]).toBeCloseTo(
        rest[starChunk] + 0.5 * reactiveReach + grown(starChunk),
        9,
      );
      expect(reactiveOnly[skyChunk]).toBeCloseTo(
        rest[skyChunk] + 0.5 * reactiveReach + grown(skyChunk),
        9,
      );
      motionClock.setCalm(1);
      motionClock.setLayerMask(MOTION_LAYER_MASK);
      motionClock.setFrozen(true);
      expect(radii()).toEqual(rest);
    } finally {
      motionClock.setFrozen(false);
      motionClock.setCalm(1);
      motionClock.setLayerMask(0);
      setReactiveBox([0, 0, 0], [-1, -1, -1]);
    }
    batch.dispose();
  });

  test('every chunk holding a stroke the reactive box reaches grows, at random boxes (P4.6)', () => {
    // 2000 strokes scattered over a 40 m cube in 4 m cells: about 900 chunks of a few strokes each.
    const random = mulberry32(46);
    const count = 2000;
    const buffers = createStrokeBuffers(count);
    for (let i = 0; i < count; i++) {
      const position: [number, number, number] = [
        40 * random() - 20,
        40 * random() - 20,
        40 * random() - 20,
      ];
      packInstance(buffers, i, {
        position,
        normal: [0, 0, 1],
        tangent: 0,
        color: [255, 255, 255, 255],
        size: [0.4, 0.2],
        brush: 0,
        layer: STROKE_LAYER.ground,
        phase: 0,
      });
    }
    const batch = createStrokeBatch(buffers, { cellSize: 4, createAtlas: tinyAtlas });
    const cull = vi.mocked(cullAndSortInto);
    const radii = (): number[] => {
      batch.update(originCamera());
      return (cull.mock.calls.at(-1)?.[0] ?? []).map((sphere) => sphere.radius);
    };
    const rest = radii();
    const reactiveReach = SKY_REACH_MARGIN * REACTIVE_REACH;
    // A ground chunk has no layer reach, so a grown sphere is the rest one plus the reactive reach
    // and the stretch cap times the half-diagonal term (every stroke is 0.4 x 0.2 m).
    const halfDiagonal = 0.5 * Math.hypot(0.4, 0.2);
    const stretch = (c: number): number => {
      const band = batch.chunks[c].band;
      if (!band) throw new Error(`chunk ${c} has no band`);
      return REACTIVE_MAX_GAIN * halfDiagonal * batch.sizeMultiplier(band);
    };
    const grownBy = (c: number): number => reactiveReach + stretch(c);
    // Each chunk's own rest centres, from its instance attribute.
    const strokesOf = batch.chunks.map((chunk) => {
      const attribute = chunk.geometry.getAttribute('iPosition') as InstancedBufferAttribute;
      return Array.from({ length: chunk.count }, (_, k): [number, number, number] => [
        attribute.array[k * 3],
        attribute.array[k * 3 + 1],
        attribute.array[k * 3 + 2],
      ]);
    });
    expect(strokesOf.reduce((n, list) => n + list.length, 0)).toBe(count);
    let reached = 0;
    let spared = 0;
    try {
      motionClock.setLayerMask(MOTION_LAYER_MASK);
      for (let trial = 0; trial < 60; trial++) {
        const centre: [number, number, number] = [
          30 * random() - 15,
          30 * random() - 15,
          30 * random() - 15,
        ];
        const half: [number, number, number] = [
          1 + 4 * random(),
          1 + 4 * random(),
          1 + 4 * random(),
        ];
        setReactiveBox(centre, half);
        const live = radii();
        const inside = new Set<number>();
        strokesOf.forEach((list, c) => {
          if (list.some((p) => insideReactiveBox(reactiveTracker.uniforms, p))) inside.add(c);
        });
        for (const c of inside) {
          expect(live[c], `trial ${trial} chunk ${c}`).toBeCloseTo(rest[c] + grownBy(c), 6);
        }
        reached += inside.size;
        // A chunk the box misses by more than its own extent keeps its rest sphere.
        batch.chunks.forEach((chunk, c) => {
          const gap = [0, 1, 2].map(
            (k) =>
              Math.abs(
                [chunk.bounds.center.x, chunk.bounds.center.y, chunk.bounds.center.z][k] -
                  centre[k],
              ) -
              half[k] -
              chunk.bounds.radius,
          );
          if (Math.max(...gap) > 0) {
            expect(live[c], `trial ${trial} chunk ${c}`).toBe(rest[c]);
            spared++;
          }
        });
      }
      // The calm scales the reactive reach, and calm 0 closes the gate.
      setReactiveBox([0, 0, 0], [1e4, 1e4, 1e4]);
      motionClock.setCalm(0.5);
      const half = radii();
      batch.chunks.forEach((_, c) => {
        expect(half[c]).toBeCloseTo(rest[c] + 0.5 * reactiveReach + stretch(c), 6);
      });
      motionClock.setCalm(0);
      expect(radii()).toEqual(rest);
    } finally {
      motionClock.setCalm(1);
      motionClock.setLayerMask(0);
      setReactiveBox([0, 0, 0], [-1, -1, -1]);
    }
    expect(reached).toBeGreaterThan(100);
    expect(spared).toBeGreaterThan(1000);
    batch.dispose();
  });

  test('a haze chunk culls with its strokes grown by the full haze growth (P3.5)', () => {
    // A 3 x 1.2 m haze stroke at x = -7 and a plain sky stroke of the same size at x = +7.
    const buffers = createStrokeBuffers(2);
    for (const [i, x, flags] of [
      [0, -7, SKY_LIGHT_CULL_FLAG],
      [1, 7, 0],
    ] as const) {
      packInstance(buffers, i, {
        position: [x, 0.5, -5],
        normal: [0, 0, 1],
        tangent: 0,
        color: [255, 255, 255, 255],
        size: [3, 1.2],
        brush: 0,
        layer: STROKE_LAYER.sky,
        phase: 0,
        flags,
      });
    }
    expect(holdsHaze(selectStrokes(buffers, [0]))).toBe(true);
    expect(holdsHaze(selectStrokes(buffers, [1]))).toBe(false);
    const batch = createStrokeBatch(buffers, { cellSize: 4, createAtlas: tinyAtlas });
    for (const band of STROKE_BANDS) batch.setSizeMultiplier(band, 1.7);
    const cull = vi.mocked(cullAndSortInto);
    const halfDiagonal = 0.5 * Math.hypot(3, 1.2);
    const radii = (): number[] => {
      batch.update(originCamera());
      const spheres = cull.mock.calls.at(-1)?.[0] ?? [];
      expect(spheres).toHaveLength(2);
      return spheres.map((sphere) => sphere.radius);
    };
    // The app clock's gate starts closed: the spheres are the rest spheres.
    const rest = radii();
    try {
      motionClock.setLayerMask(MOTION_LAYER_MASK & ~REACTIVE_MOTION_BIT);
      motionClock.setCalm(0.5);
      const half = radii();
      motionClock.setCalm(1);
      const full = radii();
      // Calm 0 closes the gate again.
      motionClock.setCalm(0);
      expect(radii()).toEqual(rest);
      motionClock.setCalm(1);
      motionClock.setFrozen(true);
      expect(radii()).toEqual(rest);
      batch.chunks.forEach((chunk, i) => {
        const position = chunk.bounds.center.x < 0 ? [-7, 0.5, -5] : [7, 0.5, -5];
        // Both chunks are sky: an open gate grows the sphere by calm times the exact reach (R-P4a).
        const reach = 1.001 * skySwirlReach(position[0], position[1], position[2]);
        expect(reach).toBeGreaterThan(0);
        expect(half[i]).toBeCloseTo(rest[i] + 0.5 * reach, 9);
        expect(full[i]).toBeCloseTo(rest[i] + reach, 9);
      });
    } finally {
      motionClock.setFrozen(false);
      motionClock.setCalm(1);
      motionClock.setLayerMask(0);
    }
    batch.chunks.forEach((chunk, i) => {
      const haze = chunk.bounds.center.x < 0;
      const grown = halfDiagonal * 1.7 * (haze ? 1 + HAZE_GROWTH : 1);
      const sphere = { radius: rest[i], center: chunk.bounds.center };
      expect(sphere.radius).toBeCloseTo(grown, 6);
      // Every corner of the fully grown stroke, at any tangent angle in its plane, is inside.
      const position = haze ? [-7, 0.5, -5] : [7, 0.5, -5];
      const theta0 = Math.atan2(1.2, 3);
      for (let k = 0; k < 64; k += 1) {
        const a = (k / 64) * 2 * Math.PI;
        for (const corner of [a + theta0, a - theta0, a + Math.PI + theta0, a + Math.PI - theta0]) {
          const x = position[0] + Math.cos(corner) * grown;
          const y = position[1] + Math.sin(corner) * grown;
          const d = Math.hypot(
            x - sphere.center.x,
            y - sphere.center.y,
            position[2] - sphere.center.z,
          );
          expect(d).toBeLessThanOrEqual(sphere.radius + 1e-9);
        }
      }
    });
    batch.dispose();
  });

  test.each([
    [6, 'near', 'mid'],
    [25, 'mid', 'far'],
  ] as const)(
    'a camera swaying 0.4 m across %s m keeps the band; crossing switches it once',
    (edge, inner, outer) => {
      const batch = createStrokeBatch(cluster(10, [2, 2, 2]), {
        cellSize: 4,
        createAtlas: tinyAtlas,
      });
      const [chunk] = batch.chunks;
      const { center, radius } = chunk.bounds;
      const camera = new PerspectiveCamera(90, 1, 0.05, 1000);
      const at = (distance: number) => {
        camera.position.set(center.x, center.y, center.z + radius + distance);
        camera.updateMatrixWorld();
        batch.update(camera);
        return chunk.band;
      };
      expect(at(edge + 0.2)).toBe(outer);
      for (let step = 0; step < 100; step++) {
        expect(at(edge + 0.4 * Math.sin(step))).toBe(outer);
      }
      const bands: (string | null)[] = [];
      const materials: unknown[] = [];
      for (const offset of [-0.2, -0.6, -0.2, 0.4, 0.6, 0.2, -0.4, -0.6]) {
        bands.push(at(edge + offset));
        materials.push(chunk.mesh.material);
      }
      expect(bands).toEqual([outer, inner, inner, inner, outer, outer, outer, inner]);
      expect(materials[1]).toBe(batch.materials[inner]);
      expect(materials[4]).toBe(batch.materials[outer]);
      expect(chunk.drawCount).toBe(bandDrawCount(DEFAULT_BAND_DENSITY[inner], 10));
      batch.dispose();
    },
  );
});

describe('update', () => {
  test('culls chunks behind the camera and orders the rest back to front after the base meshes', () => {
    // Strokes from z = +7 to z = -8: four chunks, two behind a camera at the origin looking -z.
    const batch = createStrokeBatch(row(16, 7.5), { cellSize: 4, createAtlas: tinyAtlas });
    const camera = new PerspectiveCamera(70, 1, 0.05, 100);
    camera.position.set(0, 1.6, 0);
    render(batch, camera);

    const visible = batch.chunks.filter((c) => c.mesh.visible);
    const hidden = batch.chunks.filter((c) => !c.mesh.visible);
    expect(visible.length).toBeGreaterThan(0);
    expect(hidden.length).toBeGreaterThan(0);
    for (const chunk of hidden) expect(chunk.bounds.center.z).toBeGreaterThan(0);
    const byOrder = [...visible].sort((a, b) => a.mesh.renderOrder - b.mesh.renderOrder);
    const distances = byOrder.map((c) => c.bounds.center.distanceTo(camera.position));
    expect(distances).toEqual([...distances].sort((a, b) => b - a));
    // Every chunk here is `world`, the third class block.
    const block = STROKE_DRAW_CLASSES.indexOf('world') * 2 * batch.chunks.length;
    expect(byOrder.map((c) => c.mesh.renderOrder)).toEqual(
      byOrder.map((_, rank) => STROKES_AFTER_BASE + block + rank),
    );

    // The old depth-writing policy: front to back from 0.
    batch.setOrderPolicy(WRITE_ORDER_POLICY);
    render(batch, camera);
    const written = [...visible].sort((a, b) => a.mesh.renderOrder - b.mesh.renderOrder);
    expect(written.map((c) => c.mesh.renderOrder)).toEqual(written.map((_, rank) => rank));
    const near = written.map((c) => c.bounds.center.distanceTo(camera.position));
    expect(near).toEqual([...near].sort((a, b) => a - b));
    batch.setOrderPolicy(DEFAULT_ORDER_POLICY);
    render(batch, camera);

    const stats = batch.stats();
    expect(stats.chunks).toBe(4);
    expect(stats.total).toBe(16);
    expect(stats.visibleChunks).toBe(visible.length);
    expect(stats.visible).toBe(visible.reduce((sum, c) => sum + c.drawCount, 0));

    visible[0].setDrawCount(1);
    expect(batch.stats().visible).toBe(stats.visible - visible[0].count + 1);

    camera.rotation.set(0, Math.PI, 0);
    render(batch, camera);
    for (const chunk of hidden) expect(chunk.mesh.visible).toBe(true);
    batch.dispose();
  });

  test('attach culls with the camera three passes to scene.onBeforeRender', () => {
    const batch = createStrokeBatch(row(16, 7.5), { cellSize: 4, createAtlas: tinyAtlas });
    const scene = new Scene();
    const previous = vi.fn();
    scene.onBeforeRender = previous;
    batch.attach(scene);
    expect(batch.group.parent).toBe(scene);
    expect(() => batch.attach(scene)).toThrow();
    const camera = new PerspectiveCamera(70, 1, 0.05, 100);
    camera.position.set(0, 1.6, 20);
    camera.rotation.set(0, Math.PI, 0);
    camera.updateMatrixWorld();
    // Looking +z from z = 20: every chunk is behind.
    // three passes (renderer, scene, camera, renderTarget); the rest are unused here.
    const args = [{}, scene, camera, null] as unknown as Parameters<Scene['onBeforeRender']>;
    scene.onBeforeRender(...args);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(batch.stats().visibleChunks).toBe(0);
    expect(batch.stats().visible).toBe(0);
    batch.dispose();
    expect(scene.onBeforeRender).toBe(previous);
    expect(batch.group.parent).toBeNull();
  });
});

describe('reveal (P5.5)', () => {
  test('draws each newly revealed chunk once whatever the cull, then only what the cull keeps', () => {
    // Four chunks along z = +7 to -8, two of them behind a camera at the origin looking -z.
    const batch = createStrokeBatch(row(16, 7.5), { cellSize: 4, createAtlas: tinyAtlas });
    const camera = new PerspectiveCamera(70, 1, 0.05, 100);
    camera.position.set(0, 1.6, 0);
    render(batch, camera);
    const inView = batch.chunks.map((c) => c.mesh.visible);
    expect(inView.filter(Boolean).length).toBeGreaterThan(0);
    expect(inView.filter((v) => !v).length).toBeGreaterThan(0);

    batch.reveal(0);
    render(batch, camera);
    expect(batch.chunks.every((c) => !c.mesh.visible)).toBe(true);

    const all = batch.chunks.length;
    batch.reveal(all);
    render(batch, camera);
    // Every chunk the reveal opened draws, in view or not, so its buffers upload this frame.
    expect(batch.chunks.every((c) => c.mesh.visible)).toBe(true);
    render(batch, camera);
    expect(batch.chunks.map((c) => c.mesh.visible)).toEqual(inView);

    // Lowering the cap warms nothing; raising it warms only the chunks it newly opens.
    batch.reveal(1);
    render(batch, camera);
    batch.reveal(2);
    render(batch, camera);
    expect(batch.chunks.map((c) => c.mesh.visible)).toEqual([inView[0], true, false, false]);
    // Infinity warms nothing either.
    batch.reveal(Number.POSITIVE_INFINITY);
    render(batch, camera);
    expect(batch.chunks.map((c) => c.mesh.visible)).toEqual(inView);
    batch.dispose();
  });
});

describe('per-frame cull buffers (M3)', () => {
  test('update passes the same order and distance arrays to cullAndSortInto every frame', () => {
    const batch = bandedBatch();
    const camera = originCamera();
    const cull = vi.mocked(cullAndSortInto);
    cull.mockClear();
    render(batch, camera);
    camera.position.set(1, 0, 2);
    render(batch, camera);
    camera.rotation.set(0, Math.PI, 0);
    render(batch, camera);
    expect(cull).toHaveBeenCalledTimes(3);
    const [first, ...rest] = cull.mock.calls;
    expect(first[3]).toBeInstanceOf(Uint32Array);
    expect(first[4]).toBeInstanceOf(Float64Array);
    expect(first[3].length).toBe(batch.chunks.length);
    for (const call of rest) {
      expect(call[3]).toBe(first[3]);
      expect(call[4]).toBe(first[4]);
    }
    batch.dispose();
  });
});

describe('pinned strokes', () => {
  /**
   * `cluster` with every `every`-th stroke moved to the star or moon layer, alternately, with
   * DEPTH_BACKDROP_FLAG as the sky lights carry it.
   */
  function withLights(count: number, every: number): StrokeBuffers {
    const buffers = cluster(count, [0, 0, -2], 3);
    for (let i = 0; i < count; i += every) {
      buffers.meta[i * 4 + 1] = (i / every) % 2 ? STROKE_LAYER.moon : STROKE_LAYER.star;
      buffers.meta[i * 4 + 3] = DEPTH_BACKDROP_FLAG;
    }
    return buffers;
  }

  test('star and moon strokes without the backdrop flag (the P1 canvas) are not pinned', () => {
    const buffers = withLights(400, 8);
    for (let i = 0; i < buffers.count; i += 8) buffers.meta[i * 4 + 3] = 0;
    const batch = createStrokeBatch(buffers, { cellSize: 4, createAtlas: tinyAtlas });
    expect(batch.chunks.every((c) => c.pinned === 0)).toBe(true);
    batch.dispose();
  });

  test('a chunk with no pinned stroke keeps the plain importance order and draw counts', () => {
    // One cell at the origin, so the chunk's order seed is the batch seed itself.
    const buffers = cluster(300, [2, 2, 2], 5);
    const batch = createStrokeBatch(buffers, { cellSize: 100, seed: 7, createAtlas: tinyAtlas });
    const [chunk] = batch.chunks;
    expect(chunk.pinned).toBe(0);
    const identity = Uint32Array.from({ length: buffers.count }, (_, i) => i);
    const expected = selectStrokes(buffers, importanceOrder(buffers.position, identity, 7));
    expect(chunk.geometry.getAttribute('iPosition').array).toEqual(expected.position);
    batch.update(originCamera());
    const band = chunk.band ?? 'near';
    for (const d of [0, 0.1, 0.28, 0.4, 1]) {
      batch.setDensity(band, d);
      expect(chunk.drawCount).toBe(bandDrawCount(d, chunk.count));
    }
    batch.dispose();
  });

  test('star and moon strokes come first in their chunk and every density draws them all', () => {
    const buffers = withLights(400, 8);
    let lights = 0;
    for (let i = 0; i < buffers.count; i++) if (isPinnedStroke(buffers, i)) lights++;
    expect(lights).toBe(50);
    const plain = createStrokeBatch(cluster(400, [0, 0, -2], 3), {
      cellSize: 4,
      createAtlas: tinyAtlas,
    });
    const batch = createStrokeBatch(buffers, { cellSize: 4, createAtlas: tinyAtlas });
    // The lights take a chunk of their own per cell (draw class `lights`), every stroke pinned.
    const lightChunks = batch.chunks.filter((c) => c.drawClass === 'lights');
    expect(lightChunks.length).toBeGreaterThan(0);
    expect(batch.chunks).toHaveLength(plain.chunks.length + lightChunks.length);
    for (const chunk of batch.chunks) {
      expect(chunk.pinned).toBe(chunk.drawClass === 'lights' ? chunk.count : 0);
    }
    expect(batch.chunks.reduce((sum, c) => sum + c.pinned, 0)).toBe(lights);
    batch.update(originCamera());
    for (const chunk of batch.chunks) {
      const meta = chunk.geometry.getAttribute('iMeta').array as Uint8Array;
      for (let k = 0; k < chunk.count; k++) {
        const layer = meta[k * 4 + 1];
        const light = layer === STROKE_LAYER.star || layer === STROKE_LAYER.moon;
        const pinned = light && (meta[k * 4 + 3] & DEPTH_BACKDROP_FLAG) !== 0;
        expect(pinned).toBe(k < chunk.pinned);
      }
      const band = chunk.band ?? 'near';
      for (const d of [0, 0.1, 0.28, 0.4, 1]) {
        batch.setDensity(band, d);
        expect(chunk.drawCount).toBe(chunk.pinned + bandDrawCount(d, chunk.count - chunk.pinned));
      }
    }
    plain.dispose();
    batch.dispose();
  });
});

describe('dispose', () => {
  test('releases every chunk geometry, each band material and the atlas once', () => {
    const atlas = tinyAtlas();
    const batch = createStrokeBatch(row(16, -0.5), { cellSize: 4, createAtlas: () => atlas });
    const scene = new Scene();
    const hook = scene.onBeforeRender;
    batch.attach(scene);
    expect(scene.onBeforeRender).not.toBe(hook);
    const geometrySpies = batch.chunks.map((c) => vi.spyOn(c.geometry, 'dispose'));
    const materialSpies = STROKE_BANDS.map((b) => vi.spyOn(batch.materials[b], 'dispose'));
    const atlasSpy = vi.spyOn(atlas, 'dispose');
    const meshes: Mesh[] = batch.chunks.map((c) => c.mesh);

    batch.dispose();

    for (const spy of geometrySpies) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of materialSpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(atlasSpy).toHaveBeenCalledTimes(1);
    expect(batch.group.parent).toBeNull();
    expect(scene.onBeforeRender).toBe(hook);
    for (const mesh of meshes) expect(mesh.parent).toBeNull();
    expect(batch.chunks).toHaveLength(0);
    expect(batch.stats()).toMatchObject({ chunks: 0, visibleChunks: 0, total: 0, visible: 0 });
  });
});

describe('draw classes', () => {
  /** Strokes in one 4 m cell: dome, star, window and plain strokes, in that repeating order. */
  function mixed(count: number): StrokeBuffers {
    const buffers = cluster(count, [1, 1, -2], 4);
    for (let i = 0; i < count; i++) {
      const kind = i % 4;
      if (kind === 0) buffers.meta[i * 4 + 3] = DEPTH_BACKDROP_FLAG;
      if (kind === 1) {
        buffers.meta[i * 4 + 1] = STROKE_LAYER.star;
        buffers.meta[i * 4 + 3] = DEPTH_BACKDROP_FLAG;
      }
      if (kind === 2) buffers.meta[i * 4 + 3] = DEPTH_TIE_BREAK_FRONT_FLAG;
    }
    return buffers;
  }

  test('drawClassOf reads the backdrop, pinned and front flags', () => {
    const buffers = mixed(8);
    expect(Array.from({ length: 4 }, (_, i) => drawClassOf(buffers, i))).toEqual([
      'dome',
      'lights',
      'overlay',
      'world',
    ]);
  });

  test('a cell holding every class becomes one chunk per class, each class in its own block', () => {
    const buffers = mixed(80);
    const batch = createStrokeBatch(buffers, { cellSize: 4, createAtlas: tinyAtlas });
    // No cypressChunk option, so no cypress class.
    expect(batch.chunks.map((c) => c.drawClass)).toEqual(
      STROKE_DRAW_CLASSES.filter((c) => c !== 'cypress'),
    );
    expect(batch.chunks.map((c) => c.count)).toEqual([20, 20, 20, 20]);
    expect(batch.chunks.map((c) => c.mesh.name)).toEqual([
      'strokes-0_0_-1-dome',
      'strokes-0_0_-1-lights',
      'strokes-0_0_-1',
      'strokes-0_0_-1-overlay',
    ]);
    for (const chunk of batch.chunks) {
      const meta = chunk.geometry.getAttribute('iMeta').array as Uint8Array;
      const data = { meta, count: chunk.count } as unknown as StrokeBuffers;
      for (let k = 0; k < chunk.count; k++) expect(drawClassOf(data, k)).toBe(chunk.drawClass);
    }
    render(batch, new PerspectiveCamera(90, 1, 0.05, 100));
    const orders = batch.chunks.map((c) => c.mesh.renderOrder);
    // Dome, then the lights, then the world, then the windows, whatever the distances.
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(orders[0]).toBeGreaterThanOrEqual(STROKES_AFTER_BASE);
    for (let k = 1; k < orders.length; k++) {
      expect(orders[k] - orders[k - 1]).toBeGreaterThanOrEqual(2 * batch.chunks.length - 3);
    }
    batch.dispose();
  });

  test('a lights chunk writes depth for its own draw only, and puts the material back', () => {
    const batch = createStrokeBatch(mixed(80), { cellSize: 4, createAtlas: tinyAtlas });
    for (const chunk of batch.chunks) {
      const { mesh } = chunk;
      const material = mesh.material;
      material.depthWrite = false;
      const args = [null, null, null, mesh.geometry, material, null] as unknown as Parameters<
        typeof mesh.onBeforeRender
      >;
      mesh.onBeforeRender(...args);
      expect(material.depthWrite, chunk.drawClass).toBe(chunk.drawClass === 'lights');
      mesh.onAfterRender(...args);
      expect(material.depthWrite).toBe(false);
    }
    batch.dispose();
  });

  test('a nearer dome chunk still draws before a farther world chunk', () => {
    const near = cluster(10, [1, 1, -2], 5);
    const far = cluster(10, [1, 1, -10], 6);
    for (let i = 0; i < near.count; i++) near.meta[i * 4 + 3] = DEPTH_BACKDROP_FLAG;
    // Back to front alone would draw the nearer chunk last.
    const batch = createStrokeBatch(concat(near, far), { cellSize: 4, createAtlas: tinyAtlas });
    render(batch, new PerspectiveCamera(90, 1, 0.05, 100));
    const dome = batch.chunks.find((c) => c.drawClass === 'dome');
    const world = batch.chunks.find((c) => c.drawClass === 'world');
    expect(dome?.mesh.visible).toBe(true);
    expect(world?.mesh.visible).toBe(true);
    expect(dome?.mesh.renderOrder ?? 0).toBeLessThan(world?.mesh.renderOrder ?? 0);
    batch.dispose();
  });

  /** A cypress straddling y = 0 and ground strokes in both of its cells. */
  function seamCypress(): StrokeBuffers {
    const low = cluster(12, [1, -1, -2], 7);
    const high = cluster(12, [1, 1, -2], 8);
    const groundLow = cluster(10, [1, -1, -3], 9);
    const groundHigh = cluster(6, [1, 1, -3], 10);
    for (const part of [low, high]) {
      for (let i = 0; i < part.count; i++) part.meta[i * 4 + 1] = STROKE_LAYER.cypress;
    }
    return concat(low, high, groundLow, groundHigh);
  }
  const positionsOf = (chunk: { geometry: InstancedBufferGeometry; count: number }): string[] => {
    const p = chunk.geometry.getAttribute('iPosition').array as Float32Array;
    return Array.from({ length: chunk.count }, (_, k) =>
      [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]].join(','),
    );
  };

  test('with cypressChunk the cypress is one depth-writing chunk across a cell seam', () => {
    const batch = createStrokeBatch(seamCypress(), {
      cellSize: 4,
      createAtlas: tinyAtlas,
      cypressChunk: true,
    });
    expect(batch.chunks.map((c) => c.mesh.name)).toEqual([
      'strokes-0_-1_-1',
      'strokes-0_0_-1',
      'strokes-0_-1_-1-cypress',
    ]);
    const cypress = batch.chunks[2];
    expect(cypress.drawClass).toBe('cypress');
    expect(cypress.count).toBe(24);
    expect(batch.chunks.map((c) => c.count)).toEqual([10, 6, 24]);
    const meta = cypress.geometry.getAttribute('iMeta').array as Uint8Array;
    const data = { meta, count: cypress.count } as unknown as StrokeBuffers;
    for (let k = 0; k < cypress.count; k++) expect(isCypressStroke(data, k)).toBe(true);
    // The cypress chunk writes depth for its own draw; the rest of its cells do not.
    for (const chunk of batch.chunks) {
      const { mesh } = chunk;
      const material = mesh.material;
      material.depthWrite = false;
      const args = [null, null, null, mesh.geometry, material, null] as unknown as Parameters<
        typeof mesh.onBeforeRender
      >;
      mesh.onBeforeRender(...args);
      expect(material.depthWrite, mesh.name).toBe(chunk === cypress);
      mesh.onAfterRender(...args);
      expect(material.depthWrite).toBe(false);
    }
    // Its class draws after the lights and before the world, whatever the distances.
    render(batch, new PerspectiveCamera(90, 1, 0.05, 100));
    expect(cypress.mesh.visible).toBe(true);
    for (const chunk of batch.chunks.slice(0, 2)) {
      expect(chunk.mesh.visible).toBe(true);
      expect(cypress.mesh.renderOrder).toBeLessThan(chunk.mesh.renderOrder);
    }
    batch.dispose();
  });

  test('the cypress chunk keeps each stroke in its order among its own cell, and the rest too', () => {
    const buffers = seamCypress();
    const plain = createStrokeBatch(buffers, { cellSize: 4, createAtlas: tinyAtlas });
    const merged = createStrokeBatch(buffers, {
      cellSize: 4,
      createAtlas: tinyAtlas,
      cypressChunk: true,
    });
    // Without the option each cell is one world chunk, cypress and ground in importance order.
    expect(plain.chunks.map((c) => c.mesh.name)).toEqual(['strokes-0_-1_-1', 'strokes-0_0_-1']);
    const cypressSet = new Set(positionsOf(merged.chunks[2]));
    const mergedOrder = positionsOf(merged.chunks[2]);
    for (const [k, cell] of plain.chunks.entries()) {
      const order = positionsOf(cell);
      const ofCypress = order.filter((p) => cypressSet.has(p));
      const rest = order.filter((p) => !cypressSet.has(p));
      expect(ofCypress.length).toBe(12);
      // The cell's cypress strokes appear in the merged chunk in the cell's own order.
      expect(mergedOrder.filter((p) => ofCypress.includes(p))).toEqual(ofCypress);
      // The rest of the cell keeps its order exactly.
      expect(positionsOf(merged.chunks[k])).toEqual(rest);
    }
    // Interleaved by fraction: every prefix holds the two cells' strokes within one of even.
    for (let n = 1; n <= mergedOrder.length; n++) {
      const prefix = mergedOrder.slice(0, n);
      const low = prefix.filter((p) => positionsOf(plain.chunks[0]).includes(p)).length;
      expect(Math.abs(low - (n - low))).toBeLessThanOrEqual(1);
    }
    plain.dispose();
    merged.dispose();
  });

  test('the cypress chunk bounds, band and cull span both cells', () => {
    const batch = createStrokeBatch(seamCypress(), {
      cellSize: 4,
      createAtlas: tinyAtlas,
      cypressChunk: true,
    });
    const cypress = batch.chunks[2];
    // The sphere holds every cypress stroke, below and above the seam.
    const p = cypress.geometry.getAttribute('iPosition').array as Float32Array;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < cypress.count; k++) {
      const at = new Vector3(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]);
      expect(cypress.bounds.distanceToPoint(at)).toBeLessThanOrEqual(1e-6);
      minY = Math.min(minY, at.y);
      maxY = Math.max(maxY, at.y);
    }
    expect(minY).toBeLessThan(0);
    expect(maxY).toBeGreaterThan(0);
    // One band for the whole tree.
    render(batch, new PerspectiveCamera(90, 1, 0.05, 100));
    expect(cypress.band).toBe('near');
    // Looking at the upper half only still draws the whole chunk; looking away culls it.
    const up = new PerspectiveCamera(20, 1, 0.05, 100);
    up.position.set(1, 1, 2);
    up.lookAt(1, 1.2, -2);
    render(batch, up);
    expect(cypress.mesh.visible).toBe(true);
    expect(cypress.drawCount).toBe(24);
    const away = new PerspectiveCamera(20, 1, 0.05, 100);
    away.lookAt(0, 0, 10);
    render(batch, away);
    expect(cypress.mesh.visible).toBe(false);
    batch.dispose();
  });

  test('without cypressChunk cypress-layer strokes stay in their cells (the P1 canvas)', () => {
    const batch = createStrokeBatch(seamCypress(), { cellSize: 4, createAtlas: tinyAtlas });
    expect(batch.chunks.every((c) => c.drawClass === 'world')).toBe(true);
    expect(batch.chunks.map((c) => c.count)).toEqual([22, 18]);
    batch.dispose();
  });

  test('depthWrite: true writes depth and starts on the write order', () => {
    const batch = createStrokeBatch(seamCypress(), {
      cellSize: 4,
      createAtlas: tinyAtlas,
      depthWrite: true,
    });
    expect(batch.defaultOrder).toEqual(WRITE_ORDER_POLICY);
    for (const m of Object.values(batch.materials)) expect(m.depthWrite).toBe(true);
    render(batch, new PerspectiveCamera(90, 1, 0.05, 100));
    // Front to back from 0: the nearer chunk first.
    const [low, high] = batch.chunks;
    expect(Math.min(low.mesh.renderOrder, high.mesh.renderOrder)).toBe(0);
    batch.dispose();
  });
});

describe('interleaveOrders', () => {
  /** The rule stated plainly: per tier, every stroke by (fraction through its part's tier, part). */
  function reference(parts: readonly { order: Uint32Array; pinned: number }[]): number[] {
    const out: number[] = [];
    for (const tier of [0, 1]) {
      const all: { key: number; part: number; stroke: number }[] = [];
      parts.forEach((p, part) => {
        const start = tier === 0 ? 0 : p.pinned;
        const end = tier === 0 ? p.pinned : p.order.length;
        for (let r = start; r < end; r++) {
          all.push({ key: (r - start + 0.5) / (end - start), part, stroke: p.order[r] });
        }
      });
      all.sort((a, b) => a.key - b.key || a.part - b.part);
      for (const { stroke } of all) out.push(stroke);
    }
    return out;
  }

  test('matches a linear reference on random parts, ties included', () => {
    let state = 7;
    const random = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    let ties = 0;
    for (let trial = 0; trial < 300; trial++) {
      const k = 1 + Math.floor(random() * 12);
      let next = 0;
      const parts = Array.from({ length: k }, () => {
        // Small, often equal sizes so equal fractions (ties) are common.
        const n = Math.floor(random() * 4) * 3 + (random() < 0.2 ? 0 : 1);
        const pinned = random() < 0.4 ? Math.floor(random() * (n + 1)) : 0;
        const order = Uint32Array.from({ length: n }, () => next++);
        return { order, pinned };
      });
      const sizes = parts.map((p) => p.order.length - p.pinned);
      if (new Set(sizes).size < sizes.length) ties++;
      const got = interleaveOrders(parts);
      expect(Array.from(got.order), `trial ${trial}`).toEqual(reference(parts));
      expect(got.pinned).toBe(parts.reduce((s, p) => s + p.pinned, 0));
    }
    expect(ties).toBeGreaterThan(100);
  });
});

describe('mergeParts', () => {
  const positionsOf = (chunk: { geometry: InstancedBufferGeometry; count: number }): string[] => {
    const p = chunk.geometry.getAttribute('iPosition').array as Float32Array;
    return Array.from({ length: chunk.count }, (_, k) =>
      [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]].join(','),
    );
  };
  /** Dome strokes in three 4 m cells about 3, 14 and 42 m down -z, plus a world cell near the eye. */
  function domeCells(): StrokeBuffers {
    const dome = [
      cluster(30, [1, 1, -3], 11),
      cluster(20, [1, 1, -14], 12),
      cluster(10, [1, 1, -42], 13),
    ];
    for (const part of dome) {
      for (let i = 0; i < part.count; i++) part.meta[i * 4 + 3] = DEPTH_BACKDROP_FLAG;
    }
    return concat(...dome, cluster(8, [-1, 1, -3], 14));
  }
  const allDome = (drawClass: string): string | null => (drawClass === 'dome' ? 'all' : null);

  test('parts given one key become one chunk of their class, named by the key', () => {
    const batch = createStrokeBatch(domeCells(), {
      cellSize: 4,
      createAtlas: tinyAtlas,
      mergeParts: allDome,
    });
    expect(batch.chunks.map((c) => [c.mesh.name, c.drawClass, c.count])).toEqual([
      ['strokes--1_0_-1', 'world', 8],
      ['strokes-dome-all', 'dome', 60],
    ]);
    batch.dispose();
  });

  test('a key never merges parts of different classes', () => {
    const batch = createStrokeBatch(domeCells(), {
      cellSize: 4,
      createAtlas: tinyAtlas,
      mergeParts: () => 'x',
    });
    expect(batch.chunks.map((c) => [c.mesh.name, c.count])).toEqual([
      ['strokes-world-x', 8],
      ['strokes-dome-x', 60],
    ]);
    batch.dispose();
  });

  test('a merged chunk takes the band of its nearest part', () => {
    const buffers = domeCells();
    const plain = createStrokeBatch(buffers, { cellSize: 4, createAtlas: tinyAtlas });
    const merged = createStrokeBatch(buffers, {
      cellSize: 4,
      createAtlas: tinyAtlas,
      mergeParts: allDome,
    });
    // Only the two farther parts merge: the 3 m one stays a chunk of its own.
    const far = createStrokeBatch(buffers, {
      cellSize: 4,
      createAtlas: tinyAtlas,
      mergeParts: (drawClass, centre) => (drawClass === 'dome' && centre[2] < -10 ? 'far' : null),
    });
    const camera = originCamera();
    for (const batch of [plain, merged, far]) render(batch, camera);
    const domeBands = (batch: StrokeBatch) =>
      batch.chunks.filter((c) => c.drawClass === 'dome').map((c) => c.band);
    expect(domeBands(plain)).toEqual(['far', 'mid', 'near']);
    expect(domeBands(merged)).toEqual(['near']);
    expect(domeBands(far)).toEqual(['mid', 'near']);
    // 60 m back every part is far, so the merged chunk is too, though its sphere is 40 m across.
    const back = new PerspectiveCamera(90, 1, 0.05, 1000);
    back.position.set(1, 1, 60);
    for (const batch of [plain, merged]) render(batch, back);
    expect(domeBands(plain)).toEqual(['far', 'far', 'far']);
    expect(domeBands(merged)).toEqual(['far']);
    for (const batch of [plain, merged, far]) batch.dispose();
  });

  test("each stroke keeps its order among its part's, and every prefix is the parts' prefixes", () => {
    const buffers = domeCells();
    const plain = createStrokeBatch(buffers, { cellSize: 4, createAtlas: tinyAtlas });
    const merged = createStrokeBatch(buffers, {
      cellSize: 4,
      createAtlas: tinyAtlas,
      mergeParts: allDome,
    });
    const order = positionsOf(merged.chunks[1]);
    const parts = plain.chunks.filter((c) => c.drawClass === 'dome').map(positionsOf);
    for (const part of parts) {
      expect(order.filter((p) => part.includes(p))).toEqual(part);
    }
    for (let n = 1; n <= order.length; n++) {
      const prefix = new Set(order.slice(0, n));
      for (const part of parts) {
        const taken = part.filter((p) => prefix.has(p)).length;
        expect(Math.abs(taken - (n * part.length) / order.length)).toBeLessThanOrEqual(1);
        expect(part.slice(0, taken).every((p) => prefix.has(p))).toBe(true);
      }
    }
    plain.dispose();
    merged.dispose();
  });

  test('a merged chunk culls as one chunk of the same strokes: motion reach, haze and reactive box', () => {
    // Sky strokes in one 4 m cell and haze in another, 20 m apart: a world part each.
    const sky = cluster(6, [10, 30, -50], 17);
    const haze = cluster(6, [30, 30, -50], 18);
    for (const part of [sky, haze]) {
      for (let i = 0; i < part.count; i++) part.meta[i * 4 + 1] = STROKE_LAYER.sky;
    }
    for (let i = 0; i < haze.count; i++) haze.meta[i * 4 + 3] = SKY_LIGHT_CULL_FLAG;
    const buffers = concat(sky, haze);
    const merged = createStrokeBatch(buffers, {
      cellSize: 4,
      createAtlas: tinyAtlas,
      mergeParts: () => 'all',
    });
    // One 1024 m cell holds both, so the plain batch has the one chunk the merge builds.
    const single = createStrokeBatch(buffers, { cellSize: 1024, createAtlas: tinyAtlas });
    expect(merged.chunks.length).toBe(1);
    expect(single.chunks.length).toBe(1);
    const cull = vi.mocked(cullAndSortInto);
    const sphere = (batch: StrokeBatch): [number, number, number, number] => {
      batch.update(originCamera());
      const s = cull.mock.calls.at(-1)?.[0][0];
      if (!s) throw new Error('no cull sphere');
      return [s.center.x, s.center.y, s.center.z, s.radius];
    };
    const same = (): void => {
      const [a, b] = [sphere(merged), sphere(single)];
      for (let k = 0; k < 4; k++) expect(a[k]).toBeCloseTo(b[k], 9);
    };
    try {
      same();
      motionClock.setLayerMask(1 << STROKE_LAYER.sky);
      motionClock.setCalm(0.5);
      same();
      // A reactive box round the haze cell's strokes alone.
      motionClock.setLayerMask(MOTION_LAYER_MASK);
      setReactiveBox([30, 30, -50], [0.6, 0.6, 0.6]);
      same();
      setReactiveBox([0, 0, 0], [-1, -1, -1]);
      same();
    } finally {
      motionClock.setCalm(1);
      motionClock.setLayerMask(0);
      setReactiveBox([0, 0, 0], [-1, -1, -1]);
    }
    merged.dispose();
    single.dispose();
  });

  test('pinned lights from several cells merge into one chunk that draws them all', () => {
    const near = cluster(12, [1, 1, -3], 15);
    const far = cluster(9, [1, 1, -42], 16);
    for (const part of [near, far]) {
      for (let i = 0; i < part.count; i++) {
        part.meta[i * 4 + 1] = STROKE_LAYER.star;
        part.meta[i * 4 + 3] = DEPTH_BACKDROP_FLAG;
      }
    }
    const batch = createStrokeBatch(concat(near, far), {
      cellSize: 4,
      createAtlas: tinyAtlas,
      mergeParts: (drawClass) => (drawClass === 'lights' ? 'sky' : null),
    });
    expect(batch.chunks.map((c) => [c.mesh.name, c.drawClass, c.count, c.pinned])).toEqual([
      ['strokes-lights-sky', 'lights', 21, 21],
    ]);
    render(batch, originCamera());
    for (const band of STROKE_BANDS) batch.setDensity(band, 0);
    expect(batch.chunks[0].drawCount).toBe(21);
    batch.dispose();
  });
});

describe('the halo slot between the lights and the cypress', () => {
  /** Light strokes in four cells ahead and behind the eye, a cypress on both sides, and ground. */
  function sky(): StrokeBuffers {
    const lights = [
      cluster(6, [1, 1, -2], 21),
      cluster(6, [1, 1, -6], 22),
      cluster(6, [1, 1, 2], 23),
      cluster(6, [1, 1, 6], 24),
    ];
    for (const part of lights) {
      for (let i = 0; i < part.count; i++) {
        part.meta[i * 4 + 1] = STROKE_LAYER.star;
        part.meta[i * 4 + 3] = DEPTH_BACKDROP_FLAG;
      }
    }
    const cypress = [cluster(8, [1, -1, -2], 25), cluster(8, [1, -1, 2], 26)];
    for (const part of cypress) {
      for (let i = 0; i < part.count; i++) part.meta[i * 4 + 1] = STROKE_LAYER.cypress;
    }
    const ground = [cluster(8, [1, -1, -6], 27), cluster(8, [1, -1, 6], 28)];
    return concat(...lights, ...cypress, ...ground);
  }
  const ordersOf = (batch: StrokeBatch, drawClass: string): number[] =>
    batch.chunks
      .filter((c) => c.drawClass === drawClass && c.mesh.visible)
      .map((c) => c.mesh.renderOrder);

  test('orderBeforeClass sits above every lights rank, frozen ones too, and below the cypress', () => {
    const batch = createStrokeBatch(sky(), {
      cellSize: 4,
      createAtlas: tinyAtlas,
      cypressChunk: true,
    });
    const n = batch.chunks.length;
    const halo = batch.orderBeforeClass('cypress');
    // Above the whole dome block.
    expect(halo).toBeGreaterThan(STROKES_AFTER_BASE + 2 * n);
    const camera = new PerspectiveCamera(60, 1, 0.05, 100);
    camera.position.set(1, 0, 0);
    const lights: number[] = [];
    const cypress: number[] = [];
    for (const policy of [DEFAULT_ORDER_POLICY, { ...DEFAULT_ORDER_POLICY, freeze: true }]) {
      batch.setOrderPolicy(policy);
      // Facing -Z, then turned round, so under the freeze the chunks behind are first seen late.
      for (const yaw of [0, Math.PI]) {
        camera.rotation.set(0, yaw, 0);
        render(batch, camera);
        lights.push(...ordersOf(batch, 'lights'));
        cypress.push(...ordersOf(batch, 'cypress'));
      }
    }
    // A late-frozen lights chunk takes the top of its block (chunks.length + rank).
    expect(Math.max(...lights)).toBeGreaterThanOrEqual(STROKES_AFTER_BASE + 2 * n + n);
    expect(cypress.length).toBeGreaterThan(0);
    expect(halo).toBeGreaterThan(Math.max(...lights));
    expect(halo).toBeLessThan(Math.min(...cypress));
    batch.dispose();
  });

  test('under the write policy it lands after every chunk and the base meshes', () => {
    const batch = createStrokeBatch(sky(), {
      cellSize: 4,
      createAtlas: tinyAtlas,
      cypressChunk: true,
    });
    batch.setOrderPolicy(WRITE_ORDER_POLICY);
    const halo = batch.orderBeforeClass('cypress');
    const camera = new PerspectiveCamera(60, 1, 0.05, 100);
    camera.position.set(1, 0, 0);
    for (const yaw of [0, Math.PI]) {
      camera.rotation.set(0, yaw, 0);
      render(batch, camera);
      for (const chunk of batch.chunks) {
        if (chunk.mesh.visible) expect(halo).toBeGreaterThan(chunk.mesh.renderOrder);
      }
    }
    expect(halo).toBeGreaterThan(BASE_MESH_RENDER_ORDER);
    batch.dispose();
  });

  test('createSkyHalo(order) puts the halo in the opaque queue at that order', () => {
    const halo = createSkyHalo(1234.5);
    expect(halo.mesh.renderOrder).toBe(1234.5);
    expect(halo.mesh.material.transparent).toBe(false);
    const plain = createSkyHalo();
    expect(plain.mesh.material.transparent).toBe(true);
  });
});

describe('nosort freeze', () => {
  /** Visible chunks' render orders, nearest chunk first. */
  function ordersNearFirst(batch: StrokeBatch, eye: Vector3): number[] {
    return batch.chunks
      .filter((c) => c.mesh.visible)
      .sort((a, b) => a.bounds.center.distanceTo(eye) - b.bounds.center.distanceTo(eye))
      .map((c) => c.mesh.renderOrder);
  }

  test('under the default policy the frozen order is back to front', () => {
    const batch = createStrokeBatch(row(12), { cellSize: 4, createAtlas: tinyAtlas });
    batch.setOrderPolicy({ ...DEFAULT_ORDER_POLICY, freeze: true });
    const camera = new PerspectiveCamera(60, 1, 0.05, 100);
    camera.position.set(0.5, 1.6, 0);
    render(batch, camera);
    const orders = ordersNearFirst(batch, camera.position);
    expect(orders.length).toBe(3);
    // The nearest chunk draws last, as the unfrozen default does.
    expect(orders).toEqual([...orders].sort((a, b) => b - a));
    // Frozen: from the far end, looking back, the ranks hold.
    const byName = new Map(batch.chunks.map((c) => [c.mesh.name, c.mesh.renderOrder]));
    camera.position.set(0.5, 1.6, -20);
    camera.rotation.set(0, Math.PI, 0);
    render(batch, camera);
    for (const c of batch.chunks) {
      if (c.mesh.visible) expect(c.mesh.renderOrder).toBe(byName.get(c.mesh.name));
    }
    batch.dispose();
  });

  test('under the write policy the frozen order stays front to back', () => {
    const batch = createStrokeBatch(row(12), { cellSize: 4, createAtlas: tinyAtlas });
    batch.setOrderPolicy({ ...WRITE_ORDER_POLICY, freeze: true });
    const camera = new PerspectiveCamera(60, 1, 0.05, 100);
    camera.position.set(0.5, 1.6, 0);
    render(batch, camera);
    const orders = ordersNearFirst(batch, camera.position);
    expect(orders.length).toBe(3);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    batch.dispose();
  });
});
