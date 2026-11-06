import { DataTexture, PerspectiveCamera, RGBAFormat } from 'three';
import { expect, test } from 'vitest';
import { createStrokeBatch } from '../src/render/strokes/batch.ts';
import { createStrokeBuffers, packInstance, STROKE_LAYER } from '../src/render/strokes/instance.ts';

/**
 * M3: `update` calls no Array or TypedArray method. This counts method calls; it does not measure
 * heap allocation. Kept apart from `strokes-batch.test.ts`, whose module mock records its calls
 * with `push` and would count here.
 */

/** Strokes on a 9 x 9 x 3 grid of 4 m cells around the origin: 243 chunks over every band. */
function grid() {
  const buffers = createStrokeBuffers(243 * 2);
  let i = 0;
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      for (let y = 0; y < 3; y++) {
        for (let k = 0; k < 2; k++) {
          packInstance(buffers, i++, {
            position: [x * 12 + 1 + k, y * 4 + 1, z * 12 + 1],
            normal: [0, 0, 1],
            tangent: 0,
            color: [200, 180, 40, 255],
            size: [0.2, 0.1],
            brush: i % 16,
            layer: STROKE_LAYER.sky,
            phase: 0,
          });
        }
      }
    }
  }
  return createStrokeBatch(buffers, {
    cellSize: 4,
    createAtlas: () => new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat),
  });
}

test('update calls no Array forEach, map, filter, sort, push, slice or concat, and no TypedArray sort', () => {
  const batch = grid();
  expect(batch.chunks.length).toBe(243);
  const camera = new PerspectiveCamera(90, 1, 0.05, 1000);
  const render = (): void => {
    camera.updateMatrixWorld();
    batch.update(camera);
  };
  render();
  // Plain counters, not vi.spyOn: the spy records its calls with these same methods.
  const methods = ['forEach', 'map', 'filter', 'sort', 'push', 'slice', 'concat'] as const;
  const counts = Object.fromEntries(methods.map((m) => [m, 0])) as Record<string, number>;
  const arrayProto = Array.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const typedProto = Object.getPrototypeOf(Uint32Array.prototype) as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  const originals = methods.map((m) => arrayProto[m]);
  const typedSortOriginal = typedProto.sort;
  let typedSorts = 0;
  let counting = false;
  methods.forEach((m, i) => {
    const original = originals[i];
    arrayProto[m] = function (this: unknown, ...args: unknown[]) {
      if (counting) counts[m]++;
      return original.apply(this, args);
    };
  });
  typedProto.sort = function (this: unknown, ...args: unknown[]) {
    if (counting) typedSorts++;
    return typedSortOriginal.apply(this, args);
  };
  try {
    counting = true;
    for (let i = 0; i < 20; i++) {
      camera.position.set(0, 0, i * 2);
      camera.rotation.set(0, (i * Math.PI) / 10, 0);
      render();
    }
  } finally {
    counting = false;
    for (let i = 0; i < methods.length; i++) arrayProto[methods[i]] = originals[i];
    typedProto.sort = typedSortOriginal;
  }
  expect(counts).toEqual({ forEach: 0, map: 0, filter: 0, sort: 0, push: 0, slice: 0, concat: 0 });
  expect(typedSorts).toBe(0);
  // The last view keeps chunks in sight, so the sort had work to do.
  expect(batch.stats().visibleChunks).toBeGreaterThan(1);
  batch.dispose();
});
