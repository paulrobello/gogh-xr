import {
  BufferAttribute,
  type Camera,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  IntType,
  Matrix4,
  Mesh,
  type Scene,
  Sphere,
  type Texture,
  Vector3,
} from 'three';
import { createBrushAtlas } from './brush-atlas';
import { cullAndSort, DEFAULT_CELL_SIZE, partitionStrokes } from './chunks';
import { STROKE_ATTRIBUTES, type StrokeBuffers } from './instance';
import { createStrokeMaterial, type StrokeMaterial } from './material';

export interface StrokeChunk {
  readonly mesh: Mesh<InstancedBufferGeometry, StrokeMaterial>;
  readonly geometry: InstancedBufferGeometry;
  /** Instances stored in the chunk. */
  readonly count: number;
  /** Instances drawn: a prefix of the chunk, `geometry.instanceCount`. */
  readonly drawCount: number;
  /** World-space bounds; chunk meshes stay at the identity transform. */
  readonly bounds: Sphere;
  /** Draws the first `n` instances, clamped to 0..count. */
  setDrawCount(n: number): void;
}

export interface StrokeBatchStats {
  chunks: number;
  /** Chunks that passed the last frustum cull. */
  visibleChunks: number;
  /** Instances stored over all chunks. */
  total: number;
  /** Draw counts summed over chunks that passed the last cull: the instances drawn. */
  visible: number;
  /** Wall time of brush atlas generation, ms. */
  atlasMs: number;
}

export interface StrokeBatch {
  readonly group: Group;
  readonly chunks: readonly StrokeChunk[];
  readonly material: StrokeMaterial;
  readonly atlas: Texture;
  /** Culls chunks against `camera`'s frustum and orders the survivors front to back. */
  update(camera: Camera): void;
  stats(): StrokeBatchStats;
  /** Releases every chunk geometry, the material and the atlas texture. */
  dispose(): void;
}

export interface StrokeBatchOptions {
  /** Spatial grid cell edge in metres. */
  readonly cellSize?: number;
  /** Builds the atlas the batch owns; defaults to `createBrushAtlas()`. */
  readonly createAtlas?: () => Texture;
}

/** Unit quad corners in [-0.5, 0.5]², counter-clockwise seen from +z (the instance normal). */
function createQuadAttributes(): { position: BufferAttribute; index: BufferAttribute } {
  return {
    position: new BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3,
    ),
    index: new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1),
  };
}

function createChunkGeometry(
  buffers: StrokeBuffers,
  quad: ReturnType<typeof createQuadAttributes>,
): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', quad.position);
  geometry.setIndex(quad.index);
  for (const spec of STROKE_ATTRIBUTES) {
    const attribute = new InstancedBufferAttribute(
      buffers[spec.key],
      spec.itemSize,
      spec.normalized,
    );
    if (spec.integer) attribute.gpuType = IntType;
    geometry.setAttribute(spec.name, attribute);
  }
  geometry.instanceCount = buffers.count;
  return geometry;
}

/**
 * Partitions `buffers` into spatial chunks, one `Mesh` + `InstancedBufferGeometry` per chunk,
 * sharing one material and one atlas. Three's own frustum culling is off; call `update(camera)`
 * once per frame with the camera three renders with (see `cullOnRender`).
 */
export function createStrokeBatch(
  buffers: StrokeBuffers,
  options: StrokeBatchOptions = {},
): StrokeBatch {
  const start = performance.now();
  const atlas = (options.createAtlas ?? createBrushAtlas)();
  const atlasMs = performance.now() - start;
  const material = createStrokeMaterial(atlas);
  const quad = createQuadAttributes();
  const group = new Group();
  group.name = 'strokes';

  const chunks: StrokeChunk[] = partitionStrokes(
    buffers,
    options.cellSize ?? DEFAULT_CELL_SIZE,
  ).map((data, index) => {
    const geometry = createChunkGeometry(data.buffers, quad);
    const bounds = new Sphere(new Vector3(...data.bounds.center), data.bounds.radius);
    geometry.boundingSphere = bounds.clone();
    const mesh = new Mesh(geometry, material);
    mesh.name = `strokes-${data.cell.join('_')}`;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = index;
    group.add(mesh);
    const count = data.buffers.count;
    return {
      mesh,
      geometry,
      count,
      bounds,
      get drawCount() {
        return geometry.instanceCount;
      },
      setDrawCount(n: number) {
        geometry.instanceCount = Math.min(count, Math.max(0, Math.floor(n)));
      },
    };
  });

  const spheres = chunks.map((chunk) => chunk.bounds);
  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  const eye = new Vector3();

  return {
    group,
    chunks,
    material,
    atlas,
    update(camera: Camera) {
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(
        viewProjection,
        camera.coordinateSystem,
        camera.reversedDepth,
      );
      eye.setFromMatrixPosition(camera.matrixWorld);
      for (const chunk of chunks) chunk.mesh.visible = false;
      cullAndSort(spheres, frustum, eye).forEach((index, rank) => {
        const { mesh } = chunks[index];
        mesh.visible = true;
        mesh.renderOrder = rank;
      });
    },
    stats() {
      let visibleChunks = 0;
      let total = 0;
      let visible = 0;
      for (const chunk of chunks) {
        total += chunk.count;
        if (!chunk.mesh.visible) continue;
        visibleChunks++;
        visible += chunk.drawCount;
      }
      return { chunks: chunks.length, visibleChunks, total, visible, atlasMs };
    },
    dispose() {
      group.removeFromParent();
      for (const chunk of chunks) {
        group.remove(chunk.mesh);
        chunk.geometry.dispose();
      }
      chunks.length = 0;
      spheres.length = 0;
      material.dispose();
      atlas.dispose();
    },
  };
}

/**
 * Culls `batch` in `scene.onBeforeRender`, which three calls after swapping in the XR ArrayCamera
 * (whose frustum covers both eyes) and before it builds its render list. Chains any existing hook.
 * Returns the uninstaller.
 */
export function cullOnRender(scene: Scene, batch: StrokeBatch): () => void {
  const previous = scene.onBeforeRender;
  scene.onBeforeRender = function (this: Scene, ...args) {
    previous.apply(this, args);
    batch.update(args[2]);
  };
  return () => {
    scene.onBeforeRender = previous;
  };
}
