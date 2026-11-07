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
import { cypressFlameReach } from '../../motion/cypress-flame';
import { motionGate, REACTIVE_MOTION_BIT, reactiveGate } from '../../motion/layers';
import { REACTIVE_MAX_GAIN, REACTIVE_REACH } from '../../motion/reactive';
import { ringOf, skyRingReach } from '../../motion/sky-rings';
import { skySwirlReach } from '../../motion/sky-swirl';
import { addBeforeRender } from '../scene-hooks';
import { DEPTH_BACKDROP_FLAG } from './backdrop-depth';
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
import { computeBounds, cullAndSortInto, DEFAULT_CELL_SIZE, partitionIndices } from './chunks';
import { DEPTH_TIE_BREAK_FRONT_FLAG } from './depth-tie-break';
import { importanceOrder } from './importance';
import {
  octDecode,
  STROKE_ATTRIBUTES,
  STROKE_LAYER,
  type StrokeBuffers,
  selectStrokes,
} from './instance';
import { createStrokeMaterial, HAZE_GROWTH, type StrokeMaterial } from './material';
import { SKY_LIGHT_CULL_FLAG } from './sky-light-cull';

/** Default seed of the per-chunk importance order. */
export const STROKE_ORDER_SEED = 1889;

export interface StrokeChunk {
  readonly mesh: Mesh<InstancedBufferGeometry, StrokeMaterial>;
  readonly geometry: InstancedBufferGeometry;
  /** Instances stored in the chunk, in importance order. */
  readonly count: number;
  /**
   * Pinned instances (`isPinnedStroke`): the chunk's first `pinned`, which every band density
   * draws in full. 0 for a chunk with none, which then orders and draws as if pinning did not
   * exist.
   */
  readonly pinned: number;
  /** Instances drawn: a prefix of the chunk, `geometry.instanceCount`. */
  readonly drawCount: number;
  /** World-space bounds at size multiplier 1; chunk meshes stay at the identity transform. */
  readonly bounds: Sphere;
  /** Every stroke in the chunk has this draw class. */
  readonly drawClass: StrokeDrawClass;
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
  /** Per draw class, chunks that passed the last cull and the instances they draw. */
  classes: Record<StrokeDrawClass, { chunks: number; visible: number }>;
}

/**
 * How `update` sets the visible chunks' `renderOrder`. `base` offsets every rank, `reverse` draws
 * back to front instead of front to back, and `freeze` keeps each chunk's first rank for good (a
 * chunk first seen later takes `chunks.length` plus its rank then). `layered` draws the chunks
 * class by class in STROKE_DRAW_CLASSES order, each class in its own block of ranks. The `?zdiag`
 * modes change it (src/render/zdiag.ts).
 */
export interface StrokeOrderPolicy {
  readonly base: number;
  readonly reverse: boolean;
  readonly freeze: boolean;
  readonly layered: boolean;
}

/**
 * Render order base of the strokes under the default policy: above the base meshes'
 * BASE_MESH_RENDER_ORDER (1e6), so the strokes draw over the depth the base meshes wrote.
 */
export const STROKES_AFTER_BASE = 2_000_000;

/**
 * Whether batch strokes write depth. They do not (Paul's headset A/B, 2026-11-07,
 * docs/verification.md, nowrite default): overlapping strokes of one surface then never tie in
 * depth, and draw order decides between them. They still test against the base meshes' depth.
 */
export const BATCH_DEPTH_WRITE = false;

/**
 * The policy a batch starts with: after the base meshes, class by class, back to front within
 * each class, so with no stroke depth writes a nearer chunk paints over a farther one.
 */
export const DEFAULT_ORDER_POLICY: StrokeOrderPolicy = Object.freeze({
  base: STROKES_AFTER_BASE,
  reverse: true,
  freeze: false,
  layered: true,
});

/**
 * The depth-writing policy the batch shipped with before the nowrite default: front to back from
 * 0, before the base meshes, so early depth rejects hidden strokes. `?zdiag=write` restores it.
 */
export const WRITE_ORDER_POLICY: StrokeOrderPolicy = Object.freeze({
  base: 0,
  reverse: false,
  freeze: false,
  layered: false,
});

/**
 * A chunk's draw class, in draw order. Without stroke depth writes a chunk's strokes draw in
 * instance order, and the chunks by distance, so a stroke that must stay under or over its
 * neighbours whatever the distance order gets a class of its own:
 * - `dome`: sky dome strokes (DEPTH_BACKDROP_FLAG), which sit behind everything, first;
 * - `lights`: the moon and stars (`isPinnedStroke`), over the dome, with depth writes on
 *   (`writeDepthWhileDrawn`), so their own rank order holds among them;
 * - `cypress`: with `cypressChunk`, the cypress as one chunk, with depth writes on, because its
 *   moving strokes must keep the stacking the I3 flame check measures. It draws before the world,
 *   so the ground strokes drawn after it test against its depth: ground in front of its foot
 *   stays visible, and ground behind it is hidden;
 * - `world`: every other stroke;
 * - `overlay`: lit windows (DEPTH_TIE_BREAK_FRONT_FLAG), over their walls, last.
 * A grid cell holding strokes of several classes becomes one chunk per class.
 */
export const STROKE_DRAW_CLASSES = ['dome', 'lights', 'cypress', 'world', 'overlay'] as const;
export type StrokeDrawClass = (typeof STROKE_DRAW_CLASSES)[number];

/**
 * The moon and stars keep depth writes, whatever the band material says: their front-tier ranks
 * never tie between strokes that can overlap (`RankPicker`, src/world/sky-lights.ts, ties 0 at
 * seed 1), and the moon's crescent edges rely on that rank order to sit on top. The band
 * materials are shared, so the mesh sets depthWrite for its own draw and puts it back after;
 * depthWrite is render state, not part of the program, so nothing recompiles. The cypress chunk
 * keeps depth writes too: without them its instance order, not depth, decides which overlapping
 * flame stroke shows, and the visible texture no longer moves with the facing strokes
 * (docs/verification.md, nowrite default, fix round 1).
 */
function writeDepthWhileDrawn(mesh: Mesh<InstancedBufferGeometry, StrokeMaterial>): void {
  let saved = false;
  mesh.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
    saved = material.depthWrite;
    material.depthWrite = true;
  };
  mesh.onAfterRender = (_renderer, _scene, _camera, _geometry, material) => {
    material.depthWrite = saved;
  };
}

/** Stroke `i`'s draw class (STROKE_DRAW_CLASSES), apart from `cypress`, which the batch option sets. */
export function drawClassOf(buffers: StrokeBuffers, i: number): StrokeDrawClass {
  const flags = buffers.meta[i * 4 + 3];
  if (isPinnedStroke(buffers, i)) return 'lights';
  if ((flags & DEPTH_BACKDROP_FLAG) !== 0) return 'dome';
  if ((flags & DEPTH_TIE_BREAK_FRONT_FLAG) !== 0) return 'overlay';
  return 'world';
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
   * list. The hook goes through `scene-hooks.ts`, so other owners' hooks on the scene stay
   * independent of it. A batch attaches to one scene at most.
   */
  attach(scene: Scene): void;
  /**
   * Moves every chunk, culled or not, between bands by the distance from `camera` to its 1x
   * bounds (with hysteresis). Then culls chunks against the frustum with their bounds widened for
   * the band's size multiplier, and sets the survivors' render order by the order policy.
   */
  update(camera: Camera): void;
  /**
   * Sets a band's density, clamped to [0, 1]: each of its chunks draws the first
   * `pinned + bandDrawCount(d, count - pinned)` instances from now on. Only instance counts
   * change. Throws RangeError on a non-finite `d`.
   */
  setDensity(band: StrokeBand, d: number): void;
  density(band: StrokeBand): number;
  /** Sets a band's stroke-size multiplier, a finite number above 0, else RangeError. */
  setSizeMultiplier(band: StrokeBand, m: number): void;
  sizeMultiplier(band: StrokeBand): number;
  /** Instances drawn after the last cull and the current densities: `stats().visible`. */
  visibleCount(): number;
  /** Chunks that passed the last frustum cull: `stats().visibleChunks`, without allocating. */
  visibleChunkCount(): number;
  /**
   * Instances drawn per band, as `stats().bands[band].visible`, without allocating: the record is
   * the batch's own and changes with the next `update`, `setDensity` or `setDrawCount`. `update`
   * counts it during the cull, so a per-frame read walks no chunks.
   */
  visibleByBand(): Readonly<Record<StrokeBand, number>>;
  stats(): StrokeBatchStats;
  /** Replaces the order policy from the next `update` on. */
  setOrderPolicy(policy: StrokeOrderPolicy): void;
  /** The policy the batch starts with: DEFAULT_ORDER_POLICY, or WRITE_ORDER_POLICY with `depthWrite`. */
  readonly defaultOrder: StrokeOrderPolicy;
  /**
   * A render order just below `drawClass`'s block under DEFAULT_ORDER_POLICY, and above every
   * class before it. It is also above every chunk and base mesh under WRITE_ORDER_POLICY, whose
   * ranks run from 0 below 2 × the chunk count.
   */
  orderBeforeClass(drawClass: StrokeDrawClass): number;
  /**
   * Releases every chunk geometry, the band materials and the atlas texture, and removes the
   * batch's own render hook, leaving any other hook on the scene in place.
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
  /**
   * Whether the strokes write depth; defaults to BATCH_DEPTH_WRITE. A batch whose strokes are
   * offset in depth so that they never tie, as the P1 canvas lays its regions LAYER_STEP apart
   * (src/demo/canvas/placement.ts), passes true: it then starts on WRITE_ORDER_POLICY, so depth,
   * not instance order, keeps its layers in order.
   */
  readonly depthWrite?: boolean;
  /**
   * Keeps every cypress-layer stroke (`isCypressStroke`) in one depth-writing `cypress` chunk,
   * whatever cells it spans. The Starry Night world, which has one cypress tree, sets it.
   */
  readonly cypressChunk?: boolean;
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
 * True when `buffers` holds boundary haze: a sky-layer stroke with SKY_LIGHT_CULL_FLAG, the one
 * stroke.vert.glsl grows by `uHazeThickness` (material.ts).
 */
export function holdsHaze(buffers: StrokeBuffers): boolean {
  for (let i = 0; i < buffers.count; i++) {
    const meta = i * 4;
    if (
      buffers.meta[meta + 1] === STROKE_LAYER.sky &&
      (buffers.meta[meta + 3] & SKY_LIGHT_CULL_FLAG) !== 0
    ) {
      return true;
    }
  }
  return false;
}

/** The farthest a chunk's strokes of each moving layer move from rest at calm 1, metres. */
export interface MotionReaches {
  readonly sky: number;
  readonly star: number;
  readonly moon: number;
  readonly cypress: number;
  /** The cypress reach under the `wind` sway variant (src/motion/variants.ts). */
  readonly cypressWind: number;
}

/**
 * Per moving layer, the farthest any stroke in `buffers` moves from rest at calm 1, metres, times
 * SKY_REACH_MARGIN: the largest exact `skySwirlReach` of its sky strokes, `skyRingReach` of its
 * star and moon strokes (each round the ring its phase byte names, as motion.glsl reads it) and
 * `cypressFlameReach` of its cypress strokes (from the decoded normal and the alpha byte). The
 * cull sphere of a chunk grows by calm times the largest of these whose layer's gate is open
 * (ruling R-P4a), so a moving stroke never leaves its sphere, and by nothing while all are closed.
 */
export function motionReachesOf(buffers: StrokeBuffers): MotionReaches {
  let sky = 0;
  let star = 0;
  let moon = 0;
  let cypress = 0;
  let cypressWind = 0;
  const p = buffers.position;
  for (let i = 0; i < buffers.count; i++) {
    const layer = buffers.meta[i * 4 + 1];
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    if (layer === STROKE_LAYER.sky) {
      sky = Math.max(sky, skySwirlReach(x, y, z));
    } else if (layer === STROKE_LAYER.star || layer === STROKE_LAYER.moon) {
      const isMoon = layer === STROKE_LAYER.moon;
      const reach = skyRingReach(ringOf(isMoon, buffers.meta[i * 4 + 2]), x, y, z);
      if (isMoon) moon = Math.max(moon, reach);
      else star = Math.max(star, reach);
    } else if (layer === STROKE_LAYER.cypress) {
      const ny = octDecode(
        Math.max(-1, buffers.normal[i * 2] / 32767),
        Math.max(-1, buffers.normal[i * 2 + 1] / 32767),
      )[1];
      cypress = Math.max(cypress, cypressFlameReach(ny, buffers.color[i * 4 + 3]));
      cypressWind = Math.max(cypressWind, cypressFlameReach(ny, buffers.color[i * 4 + 3], 'wind'));
    }
  }
  return {
    sky: sky * SKY_REACH_MARGIN,
    star: star * SKY_REACH_MARGIN,
    moon: moon * SKY_REACH_MARGIN,
    cypress: cypress * SKY_REACH_MARGIN,
    cypressWind: cypressWind * SKY_REACH_MARGIN,
  };
}

/** The largest of `motionReachesOf(buffers)`: the farthest any of its strokes moves at calm 1. */
export function motionReachOf(buffers: StrokeBuffers): number {
  const { sky, star, moon, cypress } = motionReachesOf(buffers);
  return Math.max(sky, star, moon, cypress);
}

/** The box round the rest centres of `buffers`' strokes: min xyz, then max xyz. */
export function centreBox(
  buffers: StrokeBuffers,
): [number, number, number, number, number, number] {
  const p = buffers.position;
  if (buffers.count === 0) return [0, 0, 0, 0, 0, 0];
  const box: [number, number, number, number, number, number] = [
    p[0],
    p[1],
    p[2],
    p[0],
    p[1],
    p[2],
  ];
  for (let i = 0; i < buffers.count; i++) {
    for (let k = 0; k < 3; k++) {
      const v = p[i * 3 + k];
      if (v < box[k]) box[k] = v;
      if (v > box[k + 3]) box[k + 3] = v;
    }
  }
  return box;
}

/** Headroom for the shader's float32 motion over the float64 reach. */
export const SKY_REACH_MARGIN = 1.001;

/**
 * The sky's moon and star strokes (src/world/sky-lights.ts) are pinned: a density draws all of
 * them, so a disc stays solid at every governor level. They fill a small part of their dome
 * chunk, so the chunk's stratified order thins them like the dome, and no prefix short of most of
 * the chunk holds them all. A pinned stroke is on the star or moon layer and carries
 * DEPTH_BACKDROP_FLAG: the P1 canvas and the stroke test scene also use those layers, without
 * the flag, and keep their plain order.
 */
export function isPinnedStroke(buffers: StrokeBuffers, i: number): boolean {
  const layer = buffers.meta[i * 4 + 1];
  const backdrop = (buffers.meta[i * 4 + 3] & DEPTH_BACKDROP_FLAG) !== 0;
  return backdrop && (layer === STROKE_LAYER.star || layer === STROKE_LAYER.moon);
}

/** A stroke on the cypress layer, which a `cypressChunk` batch keeps in one chunk. */
export function isCypressStroke(buffers: StrokeBuffers, i: number): boolean {
  return buffers.meta[i * 4 + 1] === STROKE_LAYER.cypress;
}

/** Salt of the pinned group's importance-order seed, so it differs from the rest's. */
const PINNED_SEED_SALT = 0x5bd1e995;

/**
 * A chunk's instance order: its pinned strokes in importance order, then the rest in importance
 * order. With none pinned this is `importanceOrder(position, indices, seed)` itself.
 */
function chunkOrder(
  buffers: StrokeBuffers,
  indices: Uint32Array,
  seed: number,
): { order: Uint32Array; pinned: number } {
  let pinned = 0;
  for (let k = 0; k < indices.length; k++) if (isPinnedStroke(buffers, indices[k])) pinned++;
  if (pinned === 0) return { order: importanceOrder(buffers.position, indices, seed), pinned };
  const lights = new Uint32Array(pinned);
  const rest = new Uint32Array(indices.length - pinned);
  let a = 0;
  let b = 0;
  for (let k = 0; k < indices.length; k++) {
    if (isPinnedStroke(buffers, indices[k])) lights[a++] = indices[k];
    else rest[b++] = indices[k];
  }
  const order = new Uint32Array(indices.length);
  order.set(importanceOrder(buffers.position, lights, (seed ^ PINNED_SEED_SALT) >>> 0));
  order.set(importanceOrder(buffers.position, rest, seed), pinned);
  return { order, pinned };
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
 * Partitions `buffers` into spatial chunks, one `Mesh` + `InstancedBufferGeometry` per grid cell
 * and draw class (STROKE_DRAW_CLASSES), with each chunk's instances in importance order (`importanceOrder`) so a density draws an even
 * prefix. Pinned strokes (`isPinnedStroke`) come first and are always drawn. Chunks share the
 * per-band materials and one atlas. Three's own frustum culling is off; call `update(camera)`
 * once per frame with the camera three renders with, which `attach(scene)` arranges.
 */
export function createStrokeBatch(
  buffers: StrokeBuffers,
  options: StrokeBatchOptions = {},
): StrokeBatch {
  const start = performance.now();
  const atlas = (options.createAtlas ?? createBrushAtlas)();
  const atlasMs = performance.now() - start;
  const depthWrite = options.depthWrite ?? BATCH_DEPTH_WRITE;
  const defaultOrder = depthWrite ? WRITE_ORDER_POLICY : DEFAULT_ORDER_POLICY;
  const densities: Record<StrokeBand, number> = { ...DEFAULT_BAND_DENSITY };
  const sizes: Record<StrokeBand, number> = { ...DEFAULT_BAND_SIZE };
  const materials = {} as Record<StrokeBand, StrokeMaterial>;
  for (const band of STROKE_BANDS) {
    materials[band] = createStrokeMaterial(atlas, sizes[band], depthWrite);
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
  /**
   * Cull spheres: the bounds with the half-diagonal scaled by the band's size multiplier, and for
   * a chunk holding boundary haze also by the haze's full growth (`HAZE_GROWTH`), so a thickened
   * haze stroke never reaches past its sphere. A chunk holding moving strokes also grows by calm
   * times the largest motion reach (`motionReachesOf`) of the layers whose gate is open, unscaled by
   * the band. While the reactive bit is open, a chunk whose rest-centre box overlaps the reactive
   * box (`uReactiveCentre`, `uReactiveHalf`) grows by calm times `REACTIVE_REACH` on top, as the
   * reactive offset adds to the layer motion's (P4.5, ruling R-P4a), and its half-diagonal by
   * 1 + `REACTIVE_MAX_GAIN`, the reactive stretch growth's cap. The shader moves a stroke only when
   * its rest centre is inside the reactive box, so no other chunk can hold a moved stroke (P4.6).
   */
  const cullSpheres: Sphere[] = [];
  const reaches: number[] = [];
  const motionReaches: MotionReaches[] = [];
  /**
   * The calm and the sky, star, moon, cypress and reactive gate bits the cull spheres were last
   * grown for.
   */
  let motionCalm = 0;
  let motionBits = 0;
  /** The cypress sway variant (`uCypressSway`) the cull spheres were last grown for. */
  let motionSway = 0;
  const MOTION_BITS =
    (1 << STROKE_LAYER.sky) |
    (1 << STROKE_LAYER.star) |
    (1 << STROKE_LAYER.moon) |
    (1 << STROKE_LAYER.cypress) |
    REACTIVE_MOTION_BIT;
  const motionUniforms = materials.near.uniforms;
  const halfDiagonals: number[] = [];
  /** Per chunk, the box round its strokes' rest centres: min xyz then max xyz, six per chunk. */
  const centreBoxes: number[] = [];
  /**
   * Each cell's strokes split by draw class, each part in ascending source order, or with its
   * instance order already set (`order`). With `cypressChunk`, the cypress (`isCypressStroke`) is
   * one `cypress` chunk whatever cells it spans: two chunks of one surface stack as whole blocks without stroke depth
   * writes, so a flame stroke moving across a cell seam would slide under the other chunk's
   * strokes (docs/verification.md, nowrite default). A cell holding cypress strokes orders its
   * whole `world` part as before, then splits it: the rest keeps its order, and the cypress chunk
   * interleaves each cell's cypress strokes by their fraction through that cell's order, so every
   * stroke keeps its order among its own cell's strokes and a density prefix stays even.
   */
  const parts: {
    cell: number;
    drawClass: StrokeDrawClass;
    indices: Uint32Array;
    order?: Uint32Array;
  }[] = [];
  const cypress: { stroke: number; key: number; cell: number }[] = [];
  let cypressCell = -1;
  for (let c = 0; c + 1 < offsets.length; c++) {
    const indices = order.subarray(offsets[c], offsets[c + 1]);
    const classOf = Array.from(indices, (i) => drawClassOf(buffers, i));
    for (const drawClass of STROKE_DRAW_CLASSES) {
      const picked = indices.filter((_, k) => classOf[k] === drawClass);
      if (picked.length === 0) continue;
      if (
        !options.cypressChunk ||
        drawClass !== 'world' ||
        !picked.some((i) => isCypressStroke(buffers, i))
      ) {
        parts.push({ cell: c, drawClass, indices: picked });
        continue;
      }
      if (cypressCell < 0) cypressCell = c;
      const cellOrder = chunkOrder(buffers, picked, chunkSeed(seed, cells, c)).order;
      const ofCypress = cellOrder.filter((i) => isCypressStroke(buffers, i));
      ofCypress.forEach((stroke, r) => {
        cypress.push({ stroke, key: (r + 0.5) / ofCypress.length, cell: c });
      });
      const rest = cellOrder.filter((i) => !isCypressStroke(buffers, i));
      if (rest.length > 0) {
        parts.push({ cell: c, drawClass, indices: rest.slice().sort(), order: rest });
      }
    }
  }
  if (cypress.length > 0) {
    cypress.sort((a, b) => a.key - b.key || a.cell - b.cell);
    const merged = Uint32Array.from(cypress, (s) => s.stroke);
    parts.push({
      cell: cypressCell,
      drawClass: 'cypress',
      indices: merged.slice().sort(),
      order: merged,
    });
  }
  /** Per chunk, 1 while its cull sphere carries the reactive growth. */
  const reactiveNear = new Uint8Array(parts.length);
  const classRank = new Uint8Array(parts.length);
  for (const { cell: c, drawClass, indices, order: preset } of parts) {
    const { order: chunkIndices, pinned } = preset
      ? { order: preset, pinned: 0 }
      : chunkOrder(buffers, indices, chunkSeed(seed, cells, c));
    const data = selectStrokes(buffers, chunkIndices);
    const box = computeBounds(data);
    const geometry = createChunkGeometry(data, quad);
    const bounds = new Sphere(new Vector3(...box.center), box.radius);
    geometry.boundingSphere = bounds.clone();
    const mesh = new Mesh(geometry, materials.near);
    const suffix = drawClass === 'world' ? '' : `-${drawClass}`;
    mesh.name = `strokes-${cells[c * 3]}_${cells[c * 3 + 1]}_${cells[c * 3 + 2]}${suffix}`;
    mesh.frustumCulled = false;
    // Hidden until the first update has banded and culled it, so stats agree from construction.
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    // The chunk index, set before the push below.
    const index = chunks.length;
    mesh.renderOrder = index;
    classRank[index] = STROKE_DRAW_CLASSES.indexOf(drawClass);
    if (drawClass === 'lights' || drawClass === 'cypress') writeDepthWhileDrawn(mesh);
    group.add(mesh);
    const count = data.count;
    bandOf.push(null);
    cullSpheres.push(bounds.clone());
    reaches.push(box.reach);
    motionReaches.push(motionReachesOf(data));
    halfDiagonals.push(box.halfDiagonal * (holdsHaze(data) ? 1 + HAZE_GROWTH : 1));
    centreBoxes.push(...centreBox(data));
    chunks.push({
      mesh,
      geometry,
      count,
      pinned,
      bounds,
      drawClass,
      get drawCount() {
        return geometry.instanceCount;
      },
      get band() {
        return bandOf[index];
      },
      setDrawCount(n: number) {
        geometry.instanceCount = Math.min(count, Math.max(0, Math.floor(n)));
        bandVisibleStale = true;
      },
    });
  }

  function applyDensity(i: number, band: StrokeBand): void {
    const { count, pinned } = chunks[i];
    chunks[i].setDrawCount(pinned + bandDrawCount(densities[band], count - pinned));
  }

  /**
   * Calm times the largest reach of chunk `i`'s layers whose gate is open, plus the reactive reach
   * while chunk `i` carries the reactive growth, metres.
   */
  function motionGrowth(i: number): number {
    if (motionBits === 0) return 0;
    const r = motionReaches[i];
    let reach = 0;
    if (motionGate(motionBits, STROKE_LAYER.sky)) reach = Math.max(reach, r.sky);
    if (motionGate(motionBits, STROKE_LAYER.star)) reach = Math.max(reach, r.star);
    if (motionGate(motionBits, STROKE_LAYER.moon)) reach = Math.max(reach, r.moon);
    if (motionGate(motionBits, STROKE_LAYER.cypress)) {
      reach = Math.max(reach, motionSway === 0 ? r.cypress : r.cypressWind);
    }
    if (reactiveNear[i]) reach += REACTIVE_REACH * SKY_REACH_MARGIN;
    return motionCalm * reach;
  }

  /** While chunk `i` carries the reactive growth, a stretched stroke grows by REACTIVE_MAX_GAIN. */
  function applySize(i: number, band: StrokeBand): void {
    const grow = reactiveNear[i] ? 1 + REACTIVE_MAX_GAIN : 1;
    cullSpheres[i].radius = reaches[i] + motionGrowth(i) + halfDiagonals[i] * sizes[band] * grow;
  }

  /**
   * Whether chunk `i` can hold a stroke the reactive motion moves this frame: the reactive bit is
   * open at a calm above 0 and the chunk's rest-centre box overlaps the reactive box. Closed
   * bounds, so it holds every stroke reactiveGate in motion.glsl passes, whose test is strict.
   */
  function reactiveReaches(i: number): boolean {
    if (motionCalm <= 0 || !reactiveGate(motionBits)) return false;
    const c = motionUniforms.uReactiveCentre.value;
    const h = motionUniforms.uReactiveHalf.value;
    if (h.x < 0 || h.y < 0 || h.z < 0) return false;
    const b = i * 6;
    return (
      centreBoxes[b] <= c.x + h.x &&
      centreBoxes[b + 3] >= c.x - h.x &&
      centreBoxes[b + 1] <= c.y + h.y &&
      centreBoxes[b + 4] >= c.y - h.y &&
      centreBoxes[b + 2] <= c.z + h.z &&
      centreBoxes[b + 5] >= c.z - h.z
    );
  }

  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  const eye = new Vector3();
  /** Cull output, reused every frame: kept chunk indices front to back, and their distances. */
  const cullOrder = new Uint32Array(chunks.length);
  const cullDistances = new Float64Array(chunks.length);
  let policy: StrokeOrderPolicy = { ...defaultOrder };
  /** Frozen ranks by chunk index, -1 until a chunk first passes the cull under `freeze`. */
  const frozenRank = new Int32Array(chunks.length).fill(-1);
  let frozenOnce = false;

  let detach: (() => void) | null = null;

  const batch: StrokeBatch = {
    group,
    chunks,
    materials,
    atlas,
    defaultOrder,
    orderBeforeClass(drawClass: StrokeDrawClass) {
      const rank = STROKE_DRAW_CLASSES.indexOf(drawClass);
      return STROKES_AFTER_BASE + rank * 2 * chunks.length - 0.5;
    },
    attach(scene: Scene) {
      if (detach) throw new Error('stroke batch is already attached to a scene');
      scene.add(group);
      detach = addBeforeRender(scene, (_renderer, _scene, camera) => batch.update(camera));
    },
    update(camera: Camera) {
      eye.setFromMatrixPosition(camera.matrixWorld);
      const bits = (motionUniforms.uMotionLayers.value >>> 0) & MOTION_BITS;
      const calm = bits === 0 ? 0 : motionUniforms.uCalm.value;
      const sway = motionUniforms.uCypressSway.value;
      const rescale = bits !== motionBits || calm !== motionCalm || sway !== motionSway;
      motionBits = bits;
      motionCalm = calm;
      motionSway = sway;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const near = reactiveReaches(i) ? 1 : 0;
        const regrow = rescale || near !== reactiveNear[i];
        reactiveNear[i] = near;
        const band = nextBand(
          bandOf[i],
          chunkDistance(chunk.bounds.center, chunk.bounds.radius, eye),
        );
        if (band === bandOf[i]) {
          if (regrow && band) applySize(i, band);
          continue;
        }
        bandOf[i] = band;
        chunk.mesh.material = materials[band];
        applyDensity(i, band);
        applySize(i, band);
      }
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(
        viewProjection,
        camera.coordinateSystem,
        camera.reversedDepth,
      );
      for (let i = 0; i < chunks.length; i++) chunks[i].mesh.visible = false;
      bandVisible.near = 0;
      bandVisible.mid = 0;
      bandVisible.far = 0;
      const kept = cullAndSortInto(cullSpheres, frustum, eye, cullOrder, cullDistances);
      for (let rank = 0; rank < kept; rank++) {
        const index = cullOrder[rank];
        const { mesh } = chunks[index];
        mesh.visible = true;
        // A frozen rank is below 2 * chunks.length, so each class block spans that many ranks.
        const block = policy.layered ? classRank[index] * 2 * chunks.length : 0;
        if (policy.freeze) {
          if (frozenRank[index] < 0) {
            // Back to front under `reverse`, as the unfrozen order; a later chunk goes on top.
            const r = policy.reverse ? kept - 1 - rank : rank;
            frozenRank[index] = frozenOnce ? chunks.length + r : r;
          }
          mesh.renderOrder = policy.base + block + frozenRank[index];
        } else {
          mesh.renderOrder = policy.base + block + (policy.reverse ? kept - 1 - rank : rank);
        }
        const band = bandOf[index];
        if (band) bandVisible[band] += chunks[index].drawCount;
      }
      bandVisibleStale = false;
      if (policy.freeze) frozenOnce = true;
    },
    setOrderPolicy(next: StrokeOrderPolicy) {
      policy = { ...next };
      frozenRank.fill(-1);
      frozenOnce = false;
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
    visibleChunkCount() {
      let visible = 0;
      for (const chunk of chunks) if (chunk.mesh.visible) visible++;
      return visible;
    },
    stats() {
      const bands = {} as Record<StrokeBand, StrokeBandStats>;
      for (const band of STROKE_BANDS) {
        bands[band] = { d: densities[band], size: sizes[band], chunks: 0, visible: 0 };
      }
      const classes = {} as Record<StrokeDrawClass, { chunks: number; visible: number }>;
      for (const drawClass of STROKE_DRAW_CLASSES) classes[drawClass] = { chunks: 0, visible: 0 };
      let visibleChunks = 0;
      let total = 0;
      let visible = 0;
      chunks.forEach((chunk, i) => {
        total += chunk.count;
        if (!chunk.mesh.visible) return;
        visibleChunks++;
        visible += chunk.drawCount;
        classes[chunk.drawClass].chunks++;
        classes[chunk.drawClass].visible += chunk.drawCount;
        const band = bandOf[i];
        if (band) {
          bands[band].chunks++;
          bands[band].visible += chunk.drawCount;
        }
      });
      return { chunks: chunks.length, visibleChunks, total, visible, atlasMs, bands, classes };
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
      motionReaches.length = 0;
      halfDiagonals.length = 0;
      centreBoxes.length = 0;
      for (const band of STROKE_BANDS) materials[band].dispose();
      atlas.dispose();
    },
  };
  return batch;
}
