import {
  DataTexture,
  type InstancedBufferAttribute,
  IntType,
  type Mesh,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
} from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { motionClock } from '../src/motion/clock.ts';
import { MOTION_LAYER_MASK, REACTIVE_MOTION_BIT } from '../src/motion/layers.ts';
import { REACTIVE_MAX_GAIN, REACTIVE_REACH } from '../src/motion/reactive.ts';
import { SKY_RINGS, skyRingReach } from '../src/motion/sky-rings.ts';
import { skySwirlReach } from '../src/motion/sky-swirl.ts';
import { DEPTH_BACKDROP_FLAG } from '../src/render/strokes/backdrop-depth.ts';
import {
  bandDrawCount,
  DEFAULT_BAND_DENSITY,
  DEFAULT_BAND_SIZE,
  STROKE_BANDS,
} from '../src/render/strokes/bands.ts';
import {
  createStrokeBatch,
  holdsHaze,
  isPinnedStroke,
  SKY_REACH_MARGIN,
  type StrokeBatch,
} from '../src/render/strokes/batch.ts';
import { cullAndSortInto } from '../src/render/strokes/chunks.ts';
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
      expect(material.depthWrite).toBe(true);
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
      // The reactive bit grows every chunk by calm times the reactive reach on top (P4.5, R-P4a),
      // and its half-diagonal term by the stretch growth's cap. Each chunk holds one stroke, so its
      // rest radius is that stroke's half-diagonal times the band size.
      const grown = (i: number): number => REACTIVE_MAX_GAIN * rest[i];
      motionClock.setLayerMask(MOTION_LAYER_MASK);
      const reactiveReach = SKY_REACH_MARGIN * REACTIVE_REACH;
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
    }
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
  test('culls chunks behind the camera and orders the rest front to back', () => {
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
    expect(distances).toEqual([...distances].sort((a, b) => a - b));

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
    // Pinning adds no chunk, so no draw call.
    expect(batch.chunks).toHaveLength(plain.chunks.length);
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
