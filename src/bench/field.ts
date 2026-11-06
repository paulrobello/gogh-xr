import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  type RawShaderMaterial,
} from 'three';
import type { BenchMode, BenchOrder } from '../diag/flags';
import { CHUNK_SIZE, chunkCounts } from './config';
import { createStrokeMaterial } from './material';
import { type Layout, placeStrokes } from './placement';

export interface FieldOptions {
  readonly n: number;
  readonly mode: BenchMode;
  readonly order: BenchOrder;
  readonly sizePx: number;
  readonly seed: number;
  readonly chunkSize?: number;
}

/** Sorted means front-to-back for the opaque a2c pass and back-to-front for blending. */
export function layoutFor(mode: BenchMode, order: BenchOrder): Layout {
  if (order === 'random') return 'random';
  return mode === 'blend' ? 'far-first' : 'near-first';
}

export interface StrokeField {
  readonly group: Group;
  readonly meshes: readonly InstancedMesh[];
  readonly geometry: BufferGeometry;
  readonly material: RawShaderMaterial;
  instanceCount(): number;
  dispose(): void;
}

/** Unit quad in [-0.5, 0.5]; shared by every chunk. */
export function createQuadGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3,
    ),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

export function buildStrokeField(options: FieldOptions): StrokeField {
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;
  const { positions, colors } = placeStrokes(
    options.n,
    options.seed,
    layoutFor(options.mode, options.order),
  );
  const geometry = createQuadGeometry();
  const material = createStrokeMaterial(options.mode, options.sizePx);
  const group = new Group();
  group.name = 'bench-strokes';
  const meshes: InstancedMesh[] = [];

  let offset = 0;
  chunkCounts(options.n, chunkSize).forEach((count, index) => {
    const mesh = new InstancedMesh(geometry, material, count);
    const matrices = mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const src = (offset + i) * 3;
      matrices[i * 16 + 12] = positions[src];
      matrices[i * 16 + 13] = positions[src + 1];
      matrices[i * 16 + 14] = positions[src + 2];
    }
    mesh.instanceColor = new InstancedBufferAttribute(
      colors.slice(offset * 3, (offset + count) * 3),
      3,
    );
    // Quads are sized in screen space and surround the viewer, so chunk bounds never cull.
    mesh.frustumCulled = false;
    // Sorted layouts put the first-drawn strokes in chunk 0, so chunks draw in index order.
    mesh.renderOrder = index;
    mesh.name = `bench-chunk-${index}`;
    meshes.push(mesh);
    group.add(mesh);
    offset += count;
  });

  return {
    group,
    meshes,
    geometry,
    material,
    instanceCount: () => meshes.reduce((sum, mesh) => sum + mesh.count, 0),
    dispose: () => {
      group.removeFromParent();
      for (const mesh of meshes) {
        group.remove(mesh);
        mesh.dispose();
      }
      meshes.length = 0;
      geometry.dispose();
      material.dispose();
    },
  };
}
