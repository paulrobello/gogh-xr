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
import {
  bandDrawCount,
  chunkDistance,
  DEFAULT_BAND_DENSITY,
  DEFAULT_BAND_SIZE,
  nextBand,
  STROKE_BANDS,
  type StrokeBand,
} from './bands';
import { createBrushAtlas } from './brush-atlas';
import { computeBounds, cullAndSort, DEFAULT_CELL_SIZE, partitionIndices } from './chunks';
import { importanceOrder } from './importance';
import { STROKE_ATTRIBUTES, type StrokeBuffers, selectStrokes } from './instance';
import { createStrokeMaterial, type StrokeMaterial } from './material';

/** Default seed of the per-chunk importance order. */
export const STROKE_ORDER_SEED = 1889;

export interface StrokeChunk {
  readonly mesh: Mesh<InstancedBufferGeometry, StrokeMaterial>;
  readonly geometry: InstancedBufferGeometry;
  /** Instances stored in the chunk, in importance order. */
  readonly count: number;
  /** Instances drawn: a prefix of the chunk, `geometry.instanceCount`. */
  readonly drawCount: number;
  /** World-space bounds at size multiplier 1; chunk meshes stay at the identity transform. */
  readonly bounds: Sphere;
  /** Distance band, `null` until the first `update`; the mesh stays hidden until then. */
  readonly band: StrokeBand | null;
  /**
   * Draws the first `n` instances, clamped to 0..count. The band density overwrites it whenever
   * the chunk changes band or its band's density changes.
   */
  setDrawCount(n: number): void;
}

export interface StrokeBandStats {
  /** Density: the drawn share of each chunk in the band. */
  d: number;
  /** Stroke-size multiplier. */
  size: number;
  /** Chunks in the band that passed the last cull. */
  chunks: number;
  /** Instances those chunks draw. */
  visible: number;
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
  /** Per band; the `chunks` and `visible` fields sum to `visibleChunks` and `visible`. */
  bands: Record<StrokeBand, StrokeBandStats>;
}

export interface StrokeBatch {
  readonly group: Group;
  readonly chunks: readonly StrokeChunk[];
  /**
   * One material per band, each built from the same shader and defines (so three links one
   * program) and sharing the atlas, with its own `uSizeScale`. three skips the uniform upload
   * between consecutive objects that share a material, so a per-mesh multiplier needs its own
   * material (ruling R7).
   */
  readonly materials: Readonly<Record<StrokeBand, StrokeMaterial>>;
  readonly atlas: Texture;
  /**
   * Adds the group to `scene` and culls it in `scene.onBeforeRender`, which three calls after
   * swapping in the XR ArrayCamera (whose frustum covers both eyes) and before it builds its render
   * list. Chains any existing hook. A batch attaches to one scene at most.
   */
  attach(scene: Scene): void;
  /**
   * Moves every chunk, culled or not, between bands by the distance from `camera` to its 1x
   * bounds (with hysteresis). Then culls chunks against the frustum with their bounds widened for
   * the band's size multiplier, and orders the survivors front to back.
   */
  update(camera: Camera): void;
  /**
   * Sets a band's density, clamped to [0, 1]: each of its chunks draws the first
   * `bandDrawCount(d, count)` instances from now on. Only instance counts change. Throws
   * RangeError on a non-finite `d`.
   */
  setDensity(band: StrokeBand, d: number): void;
  density(band: StrokeBand): number;
  /** Sets a band's stroke-size multiplier, a finite number above 0, else RangeError. */
  setSizeMultiplier(band: StrokeBand, m: number): void;
  sizeMultiplier(band: StrokeBand): number;
  /** Instances drawn after the last cull and the current densities: `stats().visible`. */
  visibleCount(): number;
  /**
   * Instances drawn per band, as `stats().bands[band].visible`, without allocating: the record is
   * the batch's own and changes with the next `update`, `setDensity` or `setDrawCount`. `update`
   * counts it during the cull, so a per-frame read walks no chunks.
   */
  visibleByBand(): Readonly<Record<StrokeBand, number>>;
  stats(): StrokeBatchStats;
  /**
   * Releases every chunk geometry, the band materials and the atlas texture, and restores the
   * scene's previous `onBeforeRender`. A hook chained on top after `attach` would be dropped with
   * it.
   */
  dispose(): void;
}

export interface StrokeBatchOptions {
  /** Spatial grid cell edge in metres. */
  readonly cellSize?: number;
  /** Builds the atlas the batch owns; defaults to `createBrushAtlas()`. */
  readonly createAtlas?: () => Texture;
  /** Seed of the per-chunk importance order; defaults to `STROKE_ORDER_SEED`. */
  readonly seed?: number;
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

/** A chunk's importance-order seed, from its cell so one chunk's order ignores the others. */
function chunkSeed(seed: number, cells: Int32Array, c: number): number {
  return (
    (seed ^
      Math.imul(cells[c * 3], 73856093) ^
      Math.imul(cells[c * 3 + 1], 19349663) ^
      Math.imul(cells[c * 3 + 2], 83492791)) >>>
    0
  );
}

function checkBand(band: StrokeBand): void {
  if (!STROKE_BANDS.includes(band)) throw new RangeError(`unknown stroke band ${String(band)}`);
}

/**
 * Partitions `buffers` into spatial chunks, one `Mesh` + `InstancedBufferGeometry` per chunk, with
 * each chunk's instances in importance order (`importanceOrder`) so a density draws an even
 * prefix. Chunks share the per-band materials and one atlas. Three's own frustum culling is off;
 * call `update(camera)` once per frame with the camera three renders with, which `attach(scene)`
 * arranges.
 */
export function createStrokeBatch(
  buffers: StrokeBuffers,
  options: StrokeBatchOptions = {},
): StrokeBatch {
  const start = performance.now();
  const atlas = (options.createAtlas ?? createBrushAtlas)();
  const atlasMs = performance.now() - start;
  const densities: Record<StrokeBand, number> = { ...DEFAULT_BAND_DENSITY };
  const sizes: Record<StrokeBand, number> = { ...DEFAULT_BAND_SIZE };
  const materials = {} as Record<StrokeBand, StrokeMaterial>;
  for (const band of STROKE_BANDS) {
    materials[band] = createStrokeMaterial(atlas, sizes[band]);
    materials[band].name = `stroke-a2c-${band}`;
  }
  Object.freeze(materials);
  const quad = createQuadAttributes();
  const group = new Group();
  group.name = 'strokes';

  const seed = options.seed ?? STROKE_ORDER_SEED;
  const { cells, offsets, order } = partitionIndices(
    buffers,
    options.cellSize ?? DEFAULT_CELL_SIZE,
  );
  const chunks: StrokeChunk[] = [];
  const bandOf: (StrokeBand | null)[] = [];
  const bandVisible: Record<StrokeBand, number> = { near: 0, mid: 0, far: 0 };
  /** Set when a draw count changes outside `update`, which recounts `bandVisible` itself. */
  let bandVisibleStale = false;
  /** Cull spheres: the bounds with the half-diagonal scaled by the band's size multiplier. */
  const cullSpheres: Sphere[] = [];
  const reaches: number[] = [];
  const halfDiagonals: number[] = [];
  for (let c = 0; c + 1 < offsets.length; c++) {
    const indices = order.subarray(offsets[c], offsets[c + 1]);
    const data = selectStrokes(
      buffers,
      importanceOrder(buffers.position, indices, chunkSeed(seed, cells, c)),
    );
    const box = computeBounds(data);
    const geometry = createChunkGeometry(data, quad);
    const bounds = new Sphere(new Vector3(...box.center), box.radius);
    geometry.boundingSphere = bounds.clone();
    const mesh = new Mesh(geometry, materials.near);
    mesh.name = `strokes-${cells[c * 3]}_${cells[c * 3 + 1]}_${cells[c * 3 + 2]}`;
    mesh.frustumCulled = false;
    // Hidden until the first update has banded and culled it, so stats agree from construction.
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = c;
    group.add(mesh);
    const count = data.count;
    bandOf.push(null);
    cullSpheres.push(bounds.clone());
    reaches.push(box.reach);
    halfDiagonals.push(box.halfDiagonal);
    chunks.push({
      mesh,
      geometry,
      count,
      bounds,
      get drawCount() {
        return geometry.instanceCount;
      },
      get band() {
        return bandOf[c];
      },
      setDrawCount(n: number) {
        geometry.instanceCount = Math.min(count, Math.max(0, Math.floor(n)));
        bandVisibleStale = true;
      },
    });
  }

  function applyDensity(i: number, band: StrokeBand): void {
    chunks[i].setDrawCount(bandDrawCount(densities[band], chunks[i].count));
  }

  function applySize(i: number, band: StrokeBand): void {
    cullSpheres[i].radius = reaches[i] + halfDiagonals[i] * sizes[band];
  }

  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  const eye = new Vector3();

  let detach: (() => void) | null = null;

  const batch: StrokeBatch = {
    group,
    chunks,
    materials,
    atlas,
    attach(scene: Scene) {
      if (detach) throw new Error('stroke batch is already attached to a scene');
      scene.add(group);
      const previous = scene.onBeforeRender;
      scene.onBeforeRender = function (this: Scene, ...args) {
        previous.apply(this, args);
        batch.update(args[2]);
      };
      detach = () => {
        scene.onBeforeRender = previous;
      };
    },
    update(camera: Camera) {
      eye.setFromMatrixPosition(camera.matrixWorld);
      chunks.forEach((chunk, i) => {
        const band = nextBand(
          bandOf[i],
          chunkDistance(chunk.bounds.center, chunk.bounds.radius, eye),
        );
        if (band === bandOf[i]) return;
        bandOf[i] = band;
        chunk.mesh.material = materials[band];
        applyDensity(i, band);
        applySize(i, band);
      });
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(
        viewProjection,
        camera.coordinateSystem,
        camera.reversedDepth,
      );
      for (const chunk of chunks) chunk.mesh.visible = false;
      for (const band of STROKE_BANDS) bandVisible[band] = 0;
      cullAndSort(cullSpheres, frustum, eye).forEach((index, rank) => {
        const { mesh } = chunks[index];
        mesh.visible = true;
        mesh.renderOrder = rank;
        const band = bandOf[index];
        if (band) bandVisible[band] += chunks[index].drawCount;
      });
      bandVisibleStale = false;
    },
    setDensity(band: StrokeBand, d: number) {
      checkBand(band);
      if (!Number.isFinite(d)) throw new RangeError(`density ${d} must be a finite number`);
      densities[band] = Math.min(1, Math.max(0, d));
      bandOf.forEach((b, i) => {
        if (b === band) applyDensity(i, band);
      });
    },
    density(band: StrokeBand) {
      checkBand(band);
      return densities[band];
    },
    setSizeMultiplier(band: StrokeBand, m: number) {
      checkBand(band);
      if (!(m > 0) || !Number.isFinite(m)) {
        throw new RangeError(`size multiplier ${m} must be a finite number above 0`);
      }
      sizes[band] = m;
      materials[band].uniforms.uSizeScale.value = m;
      bandOf.forEach((b, i) => {
        if (b === band) applySize(i, band);
      });
    },
    sizeMultiplier(band: StrokeBand) {
      checkBand(band);
      return sizes[band];
    },
    visibleByBand() {
      if (bandVisibleStale) {
        for (const band of STROKE_BANDS) bandVisible[band] = 0;
        chunks.forEach((chunk, i) => {
          const band = bandOf[i];
          if (band && chunk.mesh.visible) bandVisible[band] += chunk.drawCount;
        });
        bandVisibleStale = false;
      }
      return bandVisible;
    },
    visibleCount() {
      let visible = 0;
      for (const chunk of chunks) if (chunk.mesh.visible) visible += chunk.drawCount;
      return visible;
    },
    stats() {
      const bands = {} as Record<StrokeBand, StrokeBandStats>;
      for (const band of STROKE_BANDS) {
        bands[band] = { d: densities[band], size: sizes[band], chunks: 0, visible: 0 };
      }
      let visibleChunks = 0;
      let total = 0;
      let visible = 0;
      chunks.forEach((chunk, i) => {
        total += chunk.count;
        if (!chunk.mesh.visible) return;
        visibleChunks++;
        visible += chunk.drawCount;
        const band = bandOf[i];
        if (band) {
          bands[band].chunks++;
          bands[band].visible += chunk.drawCount;
        }
      });
      return { chunks: chunks.length, visibleChunks, total, visible, atlasMs, bands };
    },
    dispose() {
      detach?.();
      detach = null;
      group.removeFromParent();
      for (const chunk of chunks) {
        group.remove(chunk.mesh);
        chunk.geometry.dispose();
      }
      chunks.length = 0;
      bandOf.length = 0;
      cullSpheres.length = 0;
      reaches.length = 0;
      halfDiagonals.length = 0;
      for (const band of STROKE_BANDS) materials[band].dispose();
      atlas.dispose();
    },
  };
  return batch;
}
