import { Frustum, Matrix4, PerspectiveCamera, Sphere, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { computeBounds, cullAndSort, partitionStrokes } from '../src/render/strokes/chunks.ts';
import { strokeAxes, type Vec3 } from '../src/render/strokes/frame.ts';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  type StrokeBuffers,
  unpackInstance,
} from '../src/render/strokes/instance.ts';
import { mulberry32 } from '../src/util/prng.ts';

function randomBuffers(count: number, seed: number, extent = 10): StrokeBuffers {
  const rand = mulberry32(seed);
  const buffers = createStrokeBuffers(count);
  for (let i = 0; i < count; i++) {
    const z = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    packInstance(buffers, i, {
      position: [(rand() * 2 - 1) * extent, (rand() * 2 - 1) * extent, (rand() * 2 - 1) * extent],
      normal: [r * Math.cos(phi), r * Math.sin(phi), z],
      tangent: rand() * Math.PI * 2,
      color: [i % 256, 0, 0, 255],
      size: [0.05 + rand() * 0.6, 0.02 + rand() * 0.3],
      brush: i % 16,
      layer: STROKE_LAYER.sky,
      phase: (i * 7) % 256,
    });
  }
  return buffers;
}

function corners(buffers: StrokeBuffers, i: number): Vec3[] {
  const s = unpackInstance(buffers, i);
  const { long, short } = strokeAxes(s.normal, s.tangent);
  const out: Vec3[] = [];
  for (const [cx, cy] of [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ]) {
    out.push([
      s.position[0] + long[0] * cx * s.size[0] + short[0] * cy * s.size[1],
      s.position[1] + long[1] * cx * s.size[0] + short[1] * cy * s.size[1],
      s.position[2] + long[2] * cx * s.size[0] + short[2] * cy * s.size[1],
    ]);
  }
  return out;
}

describe('partitionStrokes', () => {
  test('every instance lands in exactly one chunk, inside its grid cell', () => {
    const source = randomBuffers(3000, 11);
    const cellSize = 5;
    const chunks = partitionStrokes(source, cellSize);
    const seen = new Uint8Array(source.count);
    let total = 0;
    for (const chunk of chunks) {
      expect(chunk.buffers.count).toBe(chunk.sourceIndices.length);
      expect(chunk.buffers.count).toBeGreaterThan(0);
      total += chunk.buffers.count;
      for (let i = 0; i < chunk.buffers.count; i++) {
        const src = chunk.sourceIndices[i];
        seen[src]++;
        expect(unpackInstance(chunk.buffers, i)).toEqual(unpackInstance(source, src));
        const p = unpackInstance(chunk.buffers, i).position;
        for (let k = 0; k < 3; k++) expect(Math.floor(p[k] / cellSize)).toBe(chunk.cell[k]);
      }
    }
    expect(total).toBe(source.count);
    expect(seen.every((n) => n === 1)).toBe(true);
    // Positions span [-10, 10) per axis: cells -2..1 at 5 m.
    expect(chunks.length).toBe(64);
  });

  test('keeps input order inside a chunk and orders chunks by cell', () => {
    const chunks = partitionStrokes(randomBuffers(2000, 12), 5);
    for (const chunk of chunks) {
      for (let i = 1; i < chunk.sourceIndices.length; i++) {
        expect(chunk.sourceIndices[i]).toBeGreaterThan(chunk.sourceIndices[i - 1]);
      }
    }
    const keys = chunks.map((c) => c.cell.join(','));
    const sorted = [...chunks]
      .sort((a, b) => a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1] || a.cell[2] - b.cell[2])
      .map((c) => c.cell.join(','));
    expect(keys).toEqual(sorted);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('is deterministic', () => {
    const a = partitionStrokes(randomBuffers(500, 13), 3);
    const b = partitionStrokes(randomBuffers(500, 13), 3);
    expect(a.map((c) => [c.cell, Array.from(c.sourceIndices), c.bounds])).toEqual(
      b.map((c) => [c.cell, Array.from(c.sourceIndices), c.bounds]),
    );
  });

  test('handles negative coordinates and an empty input', () => {
    const buffers = createStrokeBuffers(2);
    const base = {
      normal: [0, 0, 1] as const,
      tangent: 0,
      color: [255, 255, 255, 255] as const,
      size: [0.1, 0.05] as const,
      brush: 0,
      layer: STROKE_LAYER.ground,
      phase: 0,
    };
    packInstance(buffers, 0, { ...base, position: [-0.1, 0, 0] });
    packInstance(buffers, 1, { ...base, position: [0.1, 0, 0] });
    const chunks = partitionStrokes(buffers, 4);
    expect(chunks.map((c) => c.cell)).toEqual([
      [-1, 0, 0],
      [0, 0, 0],
    ]);
    expect(partitionStrokes(createStrokeBuffers(0), 4)).toEqual([]);
    expect(() => partitionStrokes(buffers, 0)).toThrow(RangeError);
  });
});

describe('computeBounds', () => {
  test('the sphere contains every quad corner of every stroke', () => {
    for (const chunk of partitionStrokes(randomBuffers(1500, 21), 4)) {
      const { center, radius } = chunk.bounds;
      for (let i = 0; i < chunk.buffers.count; i++) {
        for (const c of corners(chunk.buffers, i)) {
          const d = Math.hypot(c[0] - center[0], c[1] - center[1], c[2] - center[2]);
          expect(d).toBeLessThanOrEqual(radius + 1e-5);
        }
      }
    }
  });

  test('a single stroke centres on its position with its half-diagonal as radius', () => {
    const buffers = createStrokeBuffers(1);
    packInstance(buffers, 0, {
      position: [1, 2, 3],
      normal: [0, 1, 0],
      tangent: 1,
      color: [0, 0, 0, 255],
      size: [0.6, 0.8],
      brush: 3,
      layer: STROKE_LAYER.star,
      phase: 9,
    });
    const bounds = computeBounds(buffers);
    expect(bounds.center).toEqual([1, 2, 3]);
    expect(bounds.radius).toBeCloseTo(0.5, 6);
  });
});

describe('cullAndSort', () => {
  function frustumFor(camera: PerspectiveCamera): Frustum {
    camera.updateMatrixWorld();
    const m = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    return new Frustum().setFromProjectionMatrix(m);
  }

  test('keeps spheres in view, ordered near to far, and drops the rest', () => {
    const camera = new PerspectiveCamera(70, 1, 0.05, 1000);
    camera.position.set(0, 1.6, 0);
    const spheres = [
      new Sphere(new Vector3(0, 1.6, -10), 1), // 0: far, in view
      new Sphere(new Vector3(0, 1.6, 5), 1), // 1: behind
      new Sphere(new Vector3(0, 1.6, -2), 1), // 2: near, in view
      new Sphere(new Vector3(50, 1.6, -3), 1), // 3: far off to the right
      new Sphere(new Vector3(0.5, 1.6, -5), 1), // 4: mid, in view
      new Sphere(new Vector3(0, 1.6, 1.5), 2), // 5: behind but overlaps the near plane
    ];
    const frustum = frustumFor(camera);
    const eye = new Vector3().setFromMatrixPosition(camera.matrixWorld);
    expect(cullAndSort(spheres, frustum, eye)).toEqual([5, 2, 4, 0]);
  });

  test('turning around swaps which spheres survive', () => {
    const camera = new PerspectiveCamera(70, 1, 0.05, 1000);
    camera.position.set(0, 1.6, 0);
    camera.rotation.set(0, Math.PI, 0);
    const spheres = [new Sphere(new Vector3(0, 1.6, -4), 1), new Sphere(new Vector3(0, 1.6, 4), 1)];
    camera.updateMatrixWorld();
    const eye = new Vector3().setFromMatrixPosition(camera.matrixWorld);
    expect(cullAndSort(spheres, frustumFor(camera), eye)).toEqual([1]);
  });

  test('breaks distance ties by chunk index', () => {
    const camera = new PerspectiveCamera(70, 1, 0.05, 1000);
    const spheres = [
      new Sphere(new Vector3(1, 0, -5), 0.5),
      new Sphere(new Vector3(-1, 0, -5), 0.5),
      new Sphere(new Vector3(0, 0, -3), 0.5),
    ];
    camera.updateMatrixWorld();
    expect(cullAndSort(spheres, frustumFor(camera), new Vector3())).toEqual([2, 0, 1]);
  });
});
