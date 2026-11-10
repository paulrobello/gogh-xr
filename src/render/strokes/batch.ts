import {
  type ArrayCamera,
  BufferAttribute,
  type Camera,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
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
import { skySwirlReach, skyWheelReach } from '../../motion/sky-swirl';
import { motionVariants } from '../../motion/variant-uniforms';
import { skyWrapCode } from '../../motion/variants';
import { drain, type Steps } from '../../util/slicer';
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
import {
  computeBounds,
  cullAndSortInto,
  DEFAULT_CELL_SIZE,
  holdOrderKeys,
  ORDER_KEY_RESET_M,
  partitionIndicesSteps,
  type StrokeBounds,
} from './chunks';
import { DEPTH_TIE_BREAK_FRONT_FLAG } from './depth-tie-break';
import { FIT_SCALE_MASK, FIT_SCALE_SHIFT, FIT_SCALE_STEP } from './face-clamp';
import type { Vec3 } from './frame';
import { importanceOrderSteps } from './importance';
import {
  octDecode,
  STROKE_ATTRIBUTES,
  STROKE_LAYER,
  type StrokeBuffers,
  selectStrokesSteps,
} from './instance';
import { createStrokeMaterial, HAZE_GROWTH, type StrokeMaterial } from './material';
import { SKY_LIGHT_CULL_FLAG } from './sky-light-cull';
import { tieKeys } from './tie-key';
import { type Footprint, vertexArms } from './vertex-arms';

export { tieKeys } from './tie-key';

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
  /** Instances drawn, `geometry.instanceCount`: the run from `drawStart` on. */
  readonly drawCount: number;
  /**
   * First instance drawn. A dome, world or overlay chunk of a nowrite batch (`drawsSuffix`) draws
   * the last `drawCount` instances, so a density cut drops its earliest-drawn strokes, which lie
   * under the rest, and `drawStart` is `count - drawCount` (0 while it draws none). Any other chunk
   * draws a prefix, from 0.
   */
  readonly drawStart: number;
  /** World-space bounds at size multiplier 1; chunk meshes stay at the identity transform. */
  readonly bounds: Sphere;
  /** Every stroke in the chunk has this draw class. */
  readonly drawClass: StrokeDrawClass;
  /** Distance band, `null` until the first `update`; the mesh stays hidden until then. */
  readonly band: StrokeBand | null;
  /**
   * Draws `n` instances, clamped to 0..count: the last `n` for a `drawsSuffix` chunk, else the
   * first `n`. The band density overwrites it whenever the chunk changes band or its band's
   * density changes.
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
 * A grid cell holding strokes of several classes becomes one chunk per class, and `mergeParts` can
 * merge one class's cells into fewer chunks.
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
   * the band's size multiplier, and sets the survivors' render order by the order policy, from
   * each chunk's held centre distance (`holdOrderKeys`). The held order can put the farther of two
   * chunks on top only while their centre distances are within 2 × ORDER_KEY_HOLD_M of each other.
   * An eye move over ORDER_KEY_RESET_M since the last update resets it to plain distance.
   */
  update(camera: Camera): void;
  /**
   * Sets a band's density, clamped to [0, 1]: each of its chunks draws
   * `pinned + bandDrawCount(d, count - pinned)` instances from now on, a suffix or a prefix
   * (`StrokeChunk.drawStart`). Only instance counts and offsets change. Throws RangeError on a
   * non-finite `d`.
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
  /**
   * Re-applies the band sizes and every banded chunk's draw count and cull radius, after the `vtx`
   * arm's keep share or size factor changes.
   */
  reapplyDensity(): void;
  /** Views the last `update` culled for: the XR ArrayCamera's eyes, else 1. */
  views(): number;
  /**
   * What the drawn strokes cover, summed over the last `update`'s views (vertex-arms.ts
   * `Footprint`): each visible chunk's drawn strokes at their band size, the `sparse` factor
   * included, capped at their fit level as the shader caps it, times `uVtxSize`; the solid angle,
   * area / d² inside each view's frustum from that view's eye, at rest and face-on, so an upper
   * bound on fill that ignores foreshortening, occlusion, haze growth, the sky-light thin and
   * motion. Walks every drawn stroke once per view, and needs the `vtx` group active for per-view
   * matrices (one view, the cull camera's, otherwise).
   */
  drawnFootprint(): Footprint;
  /** The chunk geometries, in chunk order. */
  geometries(): readonly InstancedBufferGeometry[];
  stats(): StrokeBatchStats;
  /**
   * Only chunks below index `n` may show from the next `update` on; Infinity (the default) shows
   * every chunk the cull keeps. A portal transition raises it a few chunks per frame under its
   * veil (P5.5). The next `update` also draws the newly revealed chunks the cull drops, once, so
   * three uploads every chunk's buffers over those frames instead of on the first turn after.
   */
  reveal(n: number): void;
  /** The names of the chunks the last `update` showed, in render order. Allocates. */
  drawOrder(): string[];
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
   * Releases every chunk geometry, the band materials and the atlas texture (unless the caller
   * owns it, `StrokeBatchOptions.atlas`), and removes the
   * batch's own render hook, leaving any other hook on the scene in place.
   */
  dispose(): void;
}

export interface StrokeBatchOptions {
  /** Spatial grid cell edge in metres. */
  readonly cellSize?: number;
  /** Builds the atlas the batch owns; defaults to `createBrushAtlas()`. */
  readonly createAtlas?: () => Texture;
  /**
   * A shared atlas the caller owns (P5.5): the batch uses it, ignores `createAtlas`, and its
   * `dispose` leaves it alone, so a world switch keeps one atlas for every batch and the arc.
   */
  readonly atlas?: Texture;
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
  /**
   * Merges parts into fewer chunks, one draw call per view each. A part is the strokes of one draw
   * class in one `cellSize` cell (or the cypress chunk). The function gets each part's class and the
   * centre and radius of its bounds (the band probe), and parts of one class that it gives the same
   * key become one chunk. null
   * keeps a part a chunk of its own. Each part keeps its own importance order and its own bounds as
   * a band probe: the chunk takes the band of its nearest part, so while its parts share a band each
   * draws at the band it had as a chunk of its own. The chunk interleaves its parts' orders by each
   * stroke's fraction through its part's order, as the cypress chunk does, so a density prefix or
   * suffix stays the union of the parts' prefixes or suffixes, within a stroke per part. The
   * Starry Night world merges its dome by sky sector and its lights into one chunk
   * (`createWorldPartGroup`).
   */
  readonly mergeParts?: StrokePartMerge;
}

/** `StrokeBatchOptions.mergeParts`: a part's merge key from its class and band-probe sphere. */
export type StrokePartMerge = (
  drawClass: StrokeDrawClass,
  centre: Vec3,
  radius: number,
) => string | null;

/** Strokes bounded between two yields of `groupPartsSteps`. */
const BATCH_SLICE = 16_384;
/** Strokes partitioned between two yields of `createStrokeBatchSteps`' cell loop. */
const CELL_SLICE = 4096;
/** Strokes classified between two yields of `createStrokeBatchSteps`' draw class pass. */
const CLASS_SLICE = 16_384;
/** Each draw class's index in STROKE_DRAW_CLASSES. */
const DRAW_CLASS_INDEX: Readonly<Record<StrokeDrawClass, number>> = Object.freeze(
  Object.fromEntries(STROKE_DRAW_CLASSES.map((c, i) => [c, i])) as Record<StrokeDrawClass, number>,
);

/**
 * `indices` split by `classIndex`, one array per class, each in input order: what one
 * `indices.filter((i) => classIndex[i] === d)` per class gives, in a single pass over `indices`.
 */
export function splitByClass(
  indices: Uint32Array,
  classIndex: Uint8Array,
  classes: number,
): Uint32Array[] {
  const counts = new Uint32Array(classes);
  for (let k = 0; k < indices.length; k++) counts[classIndex[indices[k]]]++;
  const empty = new Uint32Array(0);
  const out = Array.from({ length: classes }, (_, d) =>
    counts[d] === 0 ? empty : new Uint32Array(counts[d]),
  );
  const at = new Uint32Array(classes);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const d = classIndex[i];
    out[d][at[d]++] = i;
  }
  return out;
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

/**
 * Whether a chunk draws a suffix of its instances (`StrokeChunk.drawStart`). Without depth writes
 * the stroke drawn last is on top, so a prefix cut would drop the topmost strokes and repaint the
 * surface at every band switch and density shed (docs/verification.md, density cuts from below).
 * A suffix drops the earliest drawn, under the rest. The importance order's keys are symmetric,
 * so a suffix is as evenly stratified as a prefix. Only dome, world and overlay chunks of a nowrite
 * batch take it, so a new draw class keeps the prefix until it opts in:
 *
 * - The lights and the cypress write depth while they draw (`writeDepthWhileDrawn`), where the
 *   depth order and not the draw order decides.
 * - A suffix would drop pinned strokes first, so a chunk holding any keeps the prefix.
 */
export function drawsSuffix(
  depthWrite: boolean,
  drawClass: StrokeDrawClass,
  pinned: number,
): boolean {
  return (
    !depthWrite &&
    pinned === 0 &&
    (drawClass === 'dome' || drawClass === 'world' || drawClass === 'overlay')
  );
}

/**
 * A chunk geometry that can draw from instance `drawStart` on. WebGL2 has no base instance, so
 * each instanced attribute is bound as an InterleavedBufferAttribute `drawStart` items into an
 * InstancedInterleavedBuffer of stride one item, one buffer per attribute, which three uploads
 * once and keys its GPU buffer by. three rebinds a VAO only when an attribute object changes, so a
 * new start sets a new wrapper on every attribute. Instanced attributes set later (vertex-arms.ts
 * adds its sky attributes) are wrapped the same way.
 *
 * `setAttribute` keeps the source attribute's array, item size, divisor, normalisation, GPU type
 * and usage, but not its identity or its `updateRanges`: `needsUpdate` on the attribute passed in
 * uploads nothing. Write through `getAttribute(name)`'s `data` instead.
 */
export class SuffixGeometry extends InstancedBufferGeometry {
  private start = 0;
  private readonly sources = new Map<string, InstancedInterleavedBuffer>();

  get drawStart(): number {
    return this.start;
  }

  override setAttribute<K extends string>(
    name: K,
    attribute: BufferAttribute | InterleavedBufferAttribute,
  ): this {
    if (!(attribute instanceof InstancedBufferAttribute)) {
      this.sources.delete(name);
      return super.setAttribute(name, attribute);
    }
    const data = new InstancedInterleavedBuffer(
      attribute.array,
      attribute.itemSize,
      attribute.meshPerAttribute,
    ).setUsage(attribute.usage);
    this.sources.set(name, data);
    return super.setAttribute(name, this.wrap(data, attribute.normalized, attribute.gpuType));
  }

  override deleteAttribute(name: string): this {
    this.sources.delete(name);
    return super.deleteAttribute(name);
  }

  /** Binds every instanced attribute from instance `n` on. */
  setDrawStart(n: number): void {
    if (n === this.start) return;
    this.start = n;
    for (const [name, data] of this.sources) {
      const old = this.attributes[name] as InterleavedBufferAttribute & { gpuType: number };
      super.setAttribute(name, this.wrap(data, old.normalized, old.gpuType));
    }
  }

  private wrap(
    data: InstancedInterleavedBuffer,
    normalized: boolean,
    gpuType: number,
  ): InterleavedBufferAttribute {
    const attribute = new InterleavedBufferAttribute(
      data,
      data.stride,
      this.start * data.stride,
      normalized,
    );
    // three's binding reads gpuType off the attribute it binds, to pick the integer pointer.
    (attribute as InterleavedBufferAttribute & { gpuType: number }).gpuType = gpuType;
    return attribute;
  }
}

function createChunkGeometry(
  buffers: StrokeBuffers,
  quad: ReturnType<typeof createQuadAttributes>,
  suffix: boolean,
): InstancedBufferGeometry {
  const geometry = suffix ? new SuffixGeometry() : new InstancedBufferGeometry();
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
  geometry.setAttribute('iTie', new InstancedBufferAttribute(tieKeys(buffers), 1));
  geometry.instanceCount = buffers.count;
  return geometry;
}

/**
 * True when `buffers` (or its strokes at `indices`) holds boundary haze: a sky-layer stroke with
 * SKY_LIGHT_CULL_FLAG, the one stroke.vert.glsl grows by `uHazeThickness` (material.ts).
 */
export function holdsHaze(buffers: StrokeBuffers, indices?: ArrayLike<number>): boolean {
  const n = indices ? indices.length : buffers.count;
  for (let k = 0; k < n; k++) {
    const meta = (indices ? indices[k] : k) * 4;
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
  /** The sky under wave, base and pingpong: `skySwirlReach`. */
  readonly sky: number;
  /** The sky under wheel, the haze included: `skyWheelReach`, 0 outside the wheels. */
  readonly wheel: number;
  readonly star: number;
  readonly moon: number;
  readonly cypress: number;
}

/**
 * Per moving layer, the farthest any stroke in `buffers` (or its strokes at `indices`) moves from
 * rest at calm 1, metres, times
 * SKY_REACH_MARGIN: the largest exact `skySwirlReach` of its sky strokes and, apart, their largest
 * exact `skyWheelReach` (the haze, SKY_LIGHT_CULL_FLAG, included), `skyRingReach` of its
 * star and moon strokes (each round the ring its phase byte names, as motion.glsl reads it) and
 * `cypressFlameReach` of its cypress strokes (from the decoded normal and the alpha byte). The
 * cull sphere of a chunk grows by calm times the largest of these whose layer's gate is open
 * (ruling R-P4a), so a moving stroke never leaves its sphere, and by nothing while all are closed.
 */
export function motionReachesOf(
  buffers: StrokeBuffers,
  indices?: ArrayLike<number>,
): MotionReaches {
  return drain(motionReachesOfSteps(buffers, indices));
}

/** The wheel, stream and wheelflow wraps' `uSkyWrap` codes, which the cull growth reads. */
const WHEEL = skyWrapCode('wheel');
const STREAM = skyWrapCode('stream');
const WHEELFLOW = skyWrapCode('wheelflow');

/** Strokes whose motion reach is measured between two yields of `motionReachesOfSteps`. */
const MOTION_SLICE = 8192;

/** `motionReachesOf` as steps: the same maxima, yielding every MOTION_SLICE strokes. */
export function* motionReachesOfSteps(
  buffers: StrokeBuffers,
  indices?: ArrayLike<number>,
): Steps<MotionReaches> {
  let sky = 0;
  let wheel = 0;
  let star = 0;
  let moon = 0;
  let cypress = 0;
  const p = buffers.position;
  const n = indices ? indices.length : buffers.count;
  for (let k = 0; k < n; k++) {
    if (k > 0 && k % MOTION_SLICE === 0) yield;
    const i = indices ? indices[k] : k;
    const layer = buffers.meta[i * 4 + 1];
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    if (layer === STROKE_LAYER.sky) {
      sky = Math.max(sky, skySwirlReach(x, y, z));
      wheel = Math.max(wheel, skyWheelReach(x, y, z));
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
    }
  }
  return {
    sky: sky * SKY_REACH_MARGIN,
    wheel: wheel * SKY_REACH_MARGIN,
    star: star * SKY_REACH_MARGIN,
    moon: moon * SKY_REACH_MARGIN,
    cypress: cypress * SKY_REACH_MARGIN,
  };
}

/** The largest of `motionReachesOf(buffers)`: the farthest any of its strokes moves at calm 1. */
export function motionReachOf(buffers: StrokeBuffers): number {
  const { sky, wheel, star, moon, cypress } = motionReachesOf(buffers);
  return Math.max(sky, wheel, star, moon, cypress);
}

/**
 * The box round the rest centres of `buffers`' strokes (or its strokes at `indices`): min xyz,
 * then max xyz.
 */
export function centreBox(
  buffers: StrokeBuffers,
  indices?: ArrayLike<number>,
): [number, number, number, number, number, number] {
  const p = buffers.position;
  const n = indices ? indices.length : buffers.count;
  if (n === 0) return [0, 0, 0, 0, 0, 0];
  const first = (indices ? indices[0] : 0) * 3;
  const box: [number, number, number, number, number, number] = [
    p[first],
    p[first + 1],
    p[first + 2],
    p[first],
    p[first + 1],
    p[first + 2],
  ];
  for (let j = 0; j < n; j++) {
    const i = indices ? indices[j] : j;
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
 * order. With none pinned this is `importanceOrder(position, indices, seed)` itself. It yields
 * through each importance order (`importanceOrderSteps`), so a large chunk spans slicer steps.
 */
function* chunkOrderSteps(
  buffers: StrokeBuffers,
  indices: Uint32Array,
  seed: number,
): Steps<{ order: Uint32Array; pinned: number }> {
  let pinned = 0;
  for (let k = 0; k < indices.length; k++) if (isPinnedStroke(buffers, indices[k])) pinned++;
  if (pinned === 0) {
    return { order: yield* importanceOrderSteps(buffers.position, indices, seed), pinned };
  }
  const lights = new Uint32Array(pinned);
  const rest = new Uint32Array(indices.length - pinned);
  let a = 0;
  let b = 0;
  for (let k = 0; k < indices.length; k++) {
    if (isPinnedStroke(buffers, indices[k])) lights[a++] = indices[k];
    else rest[b++] = indices[k];
  }
  const order = new Uint32Array(indices.length);
  order.set(yield* importanceOrderSteps(buffers.position, lights, (seed ^ PINNED_SEED_SALT) >>> 0));
  order.set(yield* importanceOrderSteps(buffers.position, rest, seed), pinned);
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

interface ChunkPart {
  /** Its `cellSize` cell, an index into the partition's cells. */
  readonly cell: number;
  readonly drawClass: StrokeDrawClass;
  readonly indices: Uint32Array;
  /** Its instance order when already set, else the batch orders `indices` by importance. */
  readonly order?: Uint32Array;
}

interface ChunkGroup {
  readonly drawClass: StrokeDrawClass;
  readonly name: string;
  readonly members: ChunkPart[];
  /** Each member's bounds, its band probe. */
  readonly probes: StrokeBounds[];
}

/**
 * The parts as chunks: parts of one class that `merge` gives the same key gather into one chunk,
 * and every other part is a chunk of its own. Chunks come in the order of their first part. It
 * yields after each BATCH_SLICE strokes' bounds, so the pass over every stroke spans slicer steps.
 */
function* groupPartsSteps(
  buffers: StrokeBuffers,
  parts: readonly ChunkPart[],
  cells: Int32Array,
  merge: StrokePartMerge | undefined,
): Steps<ChunkGroup[]> {
  const groups: ChunkGroup[] = [];
  const byKey = new Map<string, ChunkGroup>();
  let sinceYield = 0;
  for (const part of parts) {
    if (sinceYield >= BATCH_SLICE) {
      sinceYield = 0;
      yield;
    }
    sinceYield += part.indices.length;
    const { cell: c, drawClass } = part;
    const bounds = computeBounds(buffers, part.indices);
    const key = merge ? merge(drawClass, bounds.center, bounds.radius) : null;
    if (key === null) {
      const suffix = drawClass === 'world' ? '' : `-${drawClass}`;
      const cell = `${cells[c * 3]}_${cells[c * 3 + 1]}_${cells[c * 3 + 2]}`;
      groups.push({
        drawClass,
        name: `strokes-${cell}${suffix}`,
        members: [part],
        probes: [bounds],
      });
      continue;
    }
    const name = `strokes-${drawClass}-${key}`;
    let group = byKey.get(name);
    if (!group) {
      group = { drawClass, name, members: [], probes: [] };
      byKey.set(name, group);
      groups.push(group);
    }
    group.members.push(part);
    group.probes.push(bounds);
  }
  return groups;
}

/**
 * One instance order from several parts' orders: every part's pinned strokes, then the rest, each
 * tier sorted by a stroke's fraction `(r + 0.5) / n` through its part's tier, ties by part. Every
 * stroke keeps its order among its own part's, so a density prefix (or suffix) of the whole is,
 * within a stroke per part, the union of the parts' prefixes (or suffixes).
 */
export function interleaveOrders(parts: readonly { order: Uint32Array; pinned: number }[]): {
  order: Uint32Array;
  pinned: number;
} {
  let pinned = 0;
  let total = 0;
  for (const part of parts) {
    pinned += part.pinned;
    total += part.order.length;
  }
  const order = new Uint32Array(total);
  let at = 0;
  for (const tier of [0, 1]) {
    // Each part's tier start, next stroke, tier end, and the key of its next stroke.
    const start = parts.map((p) => (tier === 0 ? 0 : p.pinned));
    const next = start.slice();
    const end = parts.map((p) => (tier === 0 ? p.pinned : p.order.length));
    const keyOf = (k: number): number =>
      next[k] < end[k] ? (next[k] - start[k] + 0.5) / (end[k] - start[k]) : Infinity;
    // A binary min-heap of parts by (key, part index), so a tie goes to the earlier part.
    const keys = new Float64Array(parts.length);
    const heap: number[] = [];
    const less = (a: number, b: number): boolean =>
      keys[a] < keys[b] || (keys[a] === keys[b] && a < b);
    const down = (from: number): void => {
      let i = from;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) return;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    };
    for (let k = 0; k < parts.length; k++) {
      keys[k] = keyOf(k);
      if (keys[k] !== Number.POSITIVE_INFINITY) heap.push(k);
    }
    for (let i = (heap.length >> 1) - 1; i >= 0; i--) down(i);
    while (heap.length > 0) {
      const best = heap[0];
      order[at++] = parts[best].order[next[best]++];
      keys[best] = keyOf(best);
      if (keys[best] === Number.POSITIVE_INFINITY) {
        const last = heap.pop() as number;
        if (heap.length === 0) break;
        heap[0] = last;
      }
      down(0);
    }
  }
  return { order, pinned };
}

/** The largest of each field over `reaches`: the reaches of their parts' union. */
function maxReaches(reaches: readonly MotionReaches[]): MotionReaches {
  const out = { sky: 0, wheel: 0, star: 0, moon: 0, cypress: 0 };
  for (const r of reaches) {
    out.sky = Math.max(out.sky, r.sky);
    out.wheel = Math.max(out.wheel, r.wheel);
    out.star = Math.max(out.star, r.star);
    out.moon = Math.max(out.moon, r.moon);
    out.cypress = Math.max(out.cypress, r.cypress);
  }
  return out;
}

function checkBand(band: StrokeBand): void {
  if (!STROKE_BANDS.includes(band)) throw new RangeError(`unknown stroke band ${String(band)}`);
}

/**
 * Partitions `buffers` into spatial chunks, one `Mesh` + `InstancedBufferGeometry` per grid cell
 * and draw class (STROKE_DRAW_CLASSES), or per group of those that `mergeParts` merges, with each
 * chunk's instances in importance order (`importanceOrder`) so a density draws an even
 * suffix or prefix (`drawsSuffix`). Pinned strokes (`isPinnedStroke`) come first and are always
 * drawn. Chunks share the
 * per-band materials and one atlas. Three's own frustum culling is off; call `update(camera)`
 * once per frame with the camera three renders with, which `attach(scene)` arranges.
 */
export function createStrokeBatch(
  buffers: StrokeBuffers,
  options: StrokeBatchOptions = {},
): StrokeBatch {
  return drain(createStrokeBatchSteps(buffers, options));
}

/**
 * `createStrokeBatch` as steps (P5.5): the same work in the same order, yielding after the atlas,
 * through the partition and the draw class pass, every few cells, through each importance order,
 * and between each chunk's order, gather and geometry, so a slicer can spread it over frames.
 */
export function* createStrokeBatchSteps(
  buffers: StrokeBuffers,
  options: StrokeBatchOptions = {},
): Steps<StrokeBatch> {
  const start = performance.now();
  const atlas = options.atlas ?? (options.createAtlas ?? createBrushAtlas)();
  const atlasMs = performance.now() - start;
  yield;
  const depthWrite = options.depthWrite ?? BATCH_DEPTH_WRITE;
  const defaultOrder = depthWrite ? WRITE_ORDER_POLICY : DEFAULT_ORDER_POLICY;
  const densities: Record<StrokeBand, number> = { ...DEFAULT_BAND_DENSITY };
  const sizes: Record<StrokeBand, number> = { ...DEFAULT_BAND_SIZE };
  const materials = {} as Record<StrokeBand, StrokeMaterial>;
  for (const band of STROKE_BANDS) {
    materials[band] = createStrokeMaterial(
      atlas,
      sizes[band] * vertexArms.sizeScale(),
      depthWrite,
      { vtxSize: vertexArms.uniforms.uVtxSize },
    );
    materials[band].name = `stroke-a2c-${band}`;
  }
  Object.freeze(materials);
  const quad = createQuadAttributes();
  const group = new Group();
  group.name = 'strokes';

  const seed = options.seed ?? STROKE_ORDER_SEED;
  const cellSize = options.cellSize ?? DEFAULT_CELL_SIZE;
  yield;
  const { cells, offsets, order } = yield* partitionIndicesSteps(buffers, cellSize);
  yield;
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
  /** The sky wrap's code (`uSkyWrap`) the cull spheres were last grown for. */
  let motionWrap = -1;
  const MOTION_BITS =
    (1 << STROKE_LAYER.sky) |
    (1 << STROKE_LAYER.star) |
    (1 << STROKE_LAYER.moon) |
    (1 << STROKE_LAYER.cypress) |
    REACTIVE_MOTION_BIT;
  const motionUniforms = materials.near.uniforms;
  const halfDiagonals: number[] = [];
  /** Views the last `update` culled for: the XR ArrayCamera's eyes, else 1. */
  let lastViews = 1;
  /**
   * While the `vtx` group is active: each view's projection × view matrix and eye from the last
   * `update`, for `drawnFootprint`. viewCount stays 0 otherwise, so the default path keeps none.
   */
  const viewMatrices: Matrix4[] = [];
  const viewEyes: Vector3[] = [];
  let viewCount = 0;
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
  const parts: ChunkPart[] = [];
  const cypress: { stroke: number; key: number; cell: number }[] = [];
  let cypressCell = -1;
  // Each stroke's draw class (its STROKE_DRAW_CLASSES index) and, with `cypressChunk`, whether it is
  // a cypress stroke, read once, so the cell loop below filters on typed lookups.
  const classIndex = new Uint8Array(buffers.count);
  const cypressMask = options.cypressChunk ? new Uint8Array(buffers.count) : null;
  for (let i = 0; i < buffers.count; i++) {
    if (i > 0 && i % CLASS_SLICE === 0) yield;
    classIndex[i] = DRAW_CLASS_INDEX[drawClassOf(buffers, i)];
    if (cypressMask && isCypressStroke(buffers, i)) cypressMask[i] = 1;
  }
  yield;
  let sinceYield = 0;
  for (let c = 0; c + 1 < offsets.length; c++) {
    if (sinceYield >= CELL_SLICE) {
      sinceYield = 0;
      yield;
    }
    const indices = order.subarray(offsets[c], offsets[c + 1]);
    sinceYield += indices.length;
    const byClass = splitByClass(indices, classIndex, STROKE_DRAW_CLASSES.length);
    for (let d = 0; d < STROKE_DRAW_CLASSES.length; d++) {
      const drawClass = STROKE_DRAW_CLASSES[d];
      const picked = byClass[d];
      if (picked.length === 0) continue;
      if (!cypressMask || drawClass !== 'world' || !picked.some((i) => cypressMask[i] === 1)) {
        parts.push({ cell: c, drawClass, indices: picked });
        continue;
      }
      // A cypress cell orders its whole world part in steps of its own, then splits it in another.
      yield;
      if (cypressCell < 0) cypressCell = c;
      const cellOrder = (yield* chunkOrderSteps(buffers, picked, chunkSeed(seed, cells, c))).order;
      yield;
      sinceYield = 0;
      const ofCypress = cellOrder.filter((i) => cypressMask[i] === 1);
      ofCypress.forEach((stroke, r) => {
        cypress.push({ stroke, key: (r + 0.5) / ofCypress.length, cell: c });
      });
      yield;
      const rest = cellOrder.filter((i) => cypressMask[i] === 0);
      if (rest.length > 0) {
        yield;
        parts.push({ cell: c, drawClass, indices: rest.slice().sort(), order: rest });
      }
    }
  }
  if (cypress.length > 0) {
    yield;
    cypress.sort((a, b) => a.key - b.key || a.cell - b.cell);
    yield;
    const merged = Uint32Array.from(cypress, (s) => s.stroke);
    yield;
    parts.push({
      cell: cypressCell,
      drawClass: 'cypress',
      indices: merged.slice().sort(),
      order: merged,
    });
  }
  const groups = yield* groupPartsSteps(buffers, parts, cells, options.mergeParts);
  /** Per chunk, 1 while its cull sphere carries the reactive growth. */
  const reactiveNear = new Uint8Array(groups.length);
  const classRank = new Uint8Array(groups.length);
  /**
   * Band probes, centre xyz then radius, one per part: chunk `i` owns probes
   * `probeStart[i] .. probeStart[i + 1]`. A one-part chunk's probe is its own bounds.
   */
  const probes: number[] = [];
  const probeStart = new Uint32Array(groups.length + 1);
  for (const { drawClass, name, members, probes: partBounds } of groups) {
    const ordered: { order: Uint32Array; pinned: number }[] = [];
    // A merged chunk's per-stroke scans run part by part, one step each, as a part's chunk did.
    const merged = members.length > 1;
    const partReaches: MotionReaches[] = [];
    let haze = false;
    const centres = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const { cell: c, indices, order: preset } of members) {
      yield;
      const part = preset
        ? { order: preset, pinned: 0 }
        : yield* chunkOrderSteps(buffers, indices, chunkSeed(seed, cells, c));
      ordered.push(part);
      if (!merged) continue;
      partReaches.push(yield* motionReachesOfSteps(buffers, part.order));
      haze ||= holdsHaze(buffers, part.order);
      const b = centreBox(buffers, part.order);
      for (let k = 0; k < 3; k++) {
        centres[k] = Math.min(centres[k], b[k]);
        centres[k + 3] = Math.max(centres[k + 3], b[k + 3]);
      }
    }
    yield;
    const { order: chunkIndices, pinned } = merged ? interleaveOrders(ordered) : ordered[0];
    const data = yield* selectStrokesSteps(buffers, chunkIndices);
    yield;
    const box = computeBounds(data);
    for (const part of partBounds) probes.push(...part.center, part.radius);
    probeStart[chunks.length + 1] = probes.length / 4;
    yield;
    const suffix = drawsSuffix(depthWrite, drawClass, pinned);
    const geometry = createChunkGeometry(data, quad, suffix);
    yield;
    // A lone part's scans run here, so the pushes below are one synchronous block.
    let ownReaches: MotionReaches | undefined;
    if (!merged) {
      ownReaches = yield* motionReachesOfSteps(data);
      yield;
      haze = holdsHaze(data);
      yield;
      centres.splice(0, 6, ...centreBox(data));
      yield;
    }
    const bounds = new Sphere(new Vector3(...box.center), box.radius);
    geometry.boundingSphere = bounds.clone();
    const mesh = new Mesh(geometry, materials.near);
    mesh.name = name;
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
    if (merged) {
      motionReaches.push(maxReaches(partReaches));
    } else {
      motionReaches.push(ownReaches as MotionReaches);
    }
    halfDiagonals.push(box.halfDiagonal * (haze ? 1 + HAZE_GROWTH : 1));
    centreBoxes.push(...centres);
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
      get drawStart() {
        return geometry instanceof SuffixGeometry ? geometry.drawStart : 0;
      },
      get band() {
        return bandOf[index];
      },
      setDrawCount(n: number) {
        geometry.instanceCount = Math.min(count, Math.max(0, Math.floor(n)));
        if (geometry instanceof SuffixGeometry) {
          const drawn = geometry.instanceCount;
          geometry.setDrawStart(drawn === 0 ? 0 : count - drawn);
        }
        bandVisibleStale = true;
      },
    });
  }

  /** Under the `vtx` arm `fewer` (vertex-arms.ts), the band density times its keep share. */
  function applyDensity(i: number, band: StrokeBand): void {
    const { count, pinned } = chunks[i];
    const keep = vertexArms.keep();
    const d = keep === 1 ? densities[band] : densities[band] * keep;
    chunks[i].setDrawCount(pinned + bandDrawCount(d, count - pinned));
  }

  /**
   * Calm times the largest reach of chunk `i`'s layers whose gate is open, plus the reactive reach
   * while chunk `i` carries the reactive growth, metres. Under wheel the sky's reach is the wheel's,
   * which calm never scales (a disc keeps its radius and calm only slows uTime, motion.glsl
   * skyWheelMotion), so it is added outside the calm factor, at calm 0 too, where the clock holds
   * the sky gate open under wheel (clock.ts setHoldMask).
   */
  function motionGrowth(i: number): number {
    if (motionBits === 0) return 0;
    const r = motionReaches[i];
    let reach = 0;
    let rigid = 0;
    if (motionGate(motionBits, STROKE_LAYER.sky)) {
      // Under wheel and wheelflow only the wheels move, and under stream no sky stroke does.
      if (motionWrap === WHEEL || motionWrap === WHEELFLOW) rigid = r.wheel;
      else if (motionWrap !== STREAM) reach = r.sky;
    }
    if (motionGate(motionBits, STROKE_LAYER.star)) reach = Math.max(reach, r.star);
    if (motionGate(motionBits, STROKE_LAYER.moon)) reach = Math.max(reach, r.moon);
    if (motionGate(motionBits, STROKE_LAYER.cypress)) reach = Math.max(reach, r.cypress);
    if (reactiveNear[i]) reach += REACTIVE_REACH * SKY_REACH_MARGIN;
    return motionCalm * reach + rigid;
  }

  /** While chunk `i` carries the reactive growth, a stretched stroke grows by REACTIVE_MAX_GAIN. */
  function applySize(i: number, band: StrokeBand): void {
    const grow = reactiveNear[i] ? 1 + REACTIVE_MAX_GAIN : 1;
    const size = sizes[band] * vertexArms.sizeScale();
    cullSpheres[i].radius = reaches[i] + motionGrowth(i) + halfDiagonals[i] * size * grow;
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
  const probe = new Vector3();

  /** `chunkDistance` from the eye to chunk `i`'s nearest band probe. */
  function probeDistance(i: number): number {
    let nearest = Number.POSITIVE_INFINITY;
    for (let k = probeStart[i]; k < probeStart[i + 1]; k++) {
      probe.set(probes[k * 4], probes[k * 4 + 1], probes[k * 4 + 2]);
      nearest = Math.min(nearest, chunkDistance(probe, probes[k * 4 + 3], eye));
    }
    return nearest;
  }
  /** Cull output, reused every frame: kept chunk indices front to back, and their distances. */
  const cullOrder = new Uint32Array(chunks.length);
  const cullDistances = new Float64Array(chunks.length);
  /** Each chunk's held centre distance (`holdOrderKeys`), the key the cull sorts by. */
  const orderKeys = new Float64Array(chunks.length);
  /** The eye of the last `update`, which resets the keys after a jump; null before the first. */
  let orderEye: Vector3 | null = null;
  let policy: StrokeOrderPolicy = { ...defaultOrder };
  /** Frozen ranks by chunk index, -1 until a chunk first passes the cull under `freeze`. */
  const frozenRank = new Int32Array(chunks.length).fill(-1);
  let frozenOnce = false;

  let detach: (() => void) | null = null;
  /** Chunks below this index may show (`reveal`). */
  let revealed = Number.POSITIVE_INFINITY;
  /** Chunks in [warmFrom, revealed) draw on the next `update` whatever the cull (`reveal`). */
  let warmFrom = Number.POSITIVE_INFINITY;

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
    reveal(n: number) {
      const next = Math.max(0, n);
      warmFrom = Number.isFinite(next) && next > revealed ? revealed : Number.POSITIVE_INFINITY;
      revealed = next;
    },
    attach(scene: Scene) {
      if (detach) throw new Error('stroke batch is already attached to a scene');
      scene.add(group);
      detach = addBeforeRender(scene, (renderer, _scene, camera) => {
        batch.update(camera);
        // After the frame: renderer.compile inside a render would reset the render state.
        if (vertexArms.needsPrepare(batch)) {
          queueMicrotask(() =>
            vertexArms.prepare(batch, (object) => renderer.compile(object, camera, scene)),
          );
        }
      });
    },
    update(camera: Camera) {
      const views = (camera as Partial<ArrayCamera>).cameras;
      lastViews = (camera as Partial<ArrayCamera>).isArrayCamera && views ? views.length : 1;
      if (vertexArms.active()) {
        const cameras: readonly Camera[] = lastViews > 1 && views ? views : [camera];
        cameras.forEach((view, v) => {
          viewMatrices[v] ??= new Matrix4();
          viewMatrices[v].multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
          viewEyes[v] ??= new Vector3();
          viewEyes[v].setFromMatrixPosition(view.matrixWorld);
        });
        viewCount = cameras.length;
      }
      eye.setFromMatrixPosition(camera.matrixWorld);
      const bits = (motionUniforms.uMotionLayers.value >>> 0) & MOTION_BITS;
      const calm = bits === 0 ? 0 : motionUniforms.uCalm.value;
      const wrap = motionVariants.uniforms.uSkyWrap.value;
      const rescale = bits !== motionBits || calm !== motionCalm || wrap !== motionWrap;
      motionBits = bits;
      motionCalm = calm;
      motionWrap = wrap;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const near = reactiveReaches(i) ? 1 : 0;
        const regrow = rescale || near !== reactiveNear[i];
        reactiveNear[i] = near;
        const band = nextBand(bandOf[i], probeDistance(i));
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
      const jumped = !orderEye || orderEye.distanceToSquared(eye) > ORDER_KEY_RESET_M ** 2;
      holdOrderKeys(cullSpheres, eye, orderKeys, jumped);
      orderEye = (orderEye ?? new Vector3()).copy(eye);
      const kept = cullAndSortInto(cullSpheres, frustum, eye, cullOrder, cullDistances, orderKeys);
      for (let rank = 0; rank < kept; rank++) {
        const index = cullOrder[rank];
        const { mesh } = chunks[index];
        if (index >= revealed) continue;
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
      // Newly revealed chunks out of view draw this once, uncounted, so their buffers upload now.
      // A chunk beyond every band has no material to draw with and waits for its first band.
      const warmTo = Math.min(revealed, chunks.length);
      for (let i = warmFrom; i < warmTo; i++) {
        if (bandOf[i] !== null) chunks[i].mesh.visible = true;
      }
      warmFrom = Number.POSITIVE_INFINITY;
    },
    drawOrder() {
      return chunks
        .filter((chunk) => chunk.mesh.visible)
        .sort((a, b) => a.mesh.renderOrder - b.mesh.renderOrder)
        .map((chunk) => chunk.mesh.name);
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
      materials[band].uniforms.uSizeScale.value = m * vertexArms.sizeScale();
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
    reapplyDensity() {
      const scale = vertexArms.sizeScale();
      for (const band of STROKE_BANDS)
        materials[band].uniforms.uSizeScale.value = sizes[band] * scale;
      bandOf.forEach((band, i) => {
        if (!band) return;
        applyDensity(i, band);
        applySize(i, band);
      });
    },
    views: () => lastViews,
    drawnFootprint() {
      const scale = vertexArms.sizeScale();
      const vtx = vertexArms.uniforms.uVtxSize.value;
      const matrices = viewCount > 0 ? viewMatrices.slice(0, viewCount) : [viewProjection];
      const eyes = viewCount > 0 ? viewEyes.slice(0, viewCount) : [eye];
      let areaM2 = 0;
      const srViews = matrices.map(() => 0);
      chunks.forEach((chunk, i) => {
        const band = bandOf[i];
        if (!band || !chunk.mesh.visible) return;
        const attribute = (name: string): ArrayLike<number> =>
          (chunk.geometry.getAttribute(name) as InstancedBufferAttribute).array;
        const p = attribute('iPosition');
        const s = attribute('iSize');
        const meta = attribute('iMeta');
        const factor = sizes[band] * scale;
        const end = chunk.drawStart + chunk.drawCount;
        for (let j = chunk.drawStart; j < end; j++) {
          const level = (meta[j * 4 + 3] >> FIT_SCALE_SHIFT) & FIT_SCALE_MASK;
          const k =
            (level === 0 ? factor : Math.min(factor, 1 + (level - 1) * FIT_SCALE_STEP)) * vtx;
          const area = s[j * 2] * s[j * 2 + 1] * k * k;
          areaM2 += area;
          const x = p[j * 3];
          const y = p[j * 3 + 1];
          const z = p[j * 3 + 2];
          for (let v = 0; v < matrices.length; v++) {
            const m = matrices[v].elements;
            const w = m[3] * x + m[7] * y + m[11] * z + m[15];
            if (w <= 0) continue;
            if (Math.abs(m[0] * x + m[4] * y + m[8] * z + m[12]) > w) continue;
            if (Math.abs(m[1] * x + m[5] * y + m[9] * z + m[13]) > w) continue;
            const e = eyes[v];
            const d2 = (x - e.x) ** 2 + (y - e.y) ** 2 + (z - e.z) ** 2;
            if (d2 > 1e-6) srViews[v] += area / d2;
          }
        }
      });
      return { areaM2, sr: srViews.reduce((a, b) => a + b, 0), srViews };
    },
    geometries: () => chunks.map((chunk) => chunk.geometry),
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
      vertexArms.unregister(batch);
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
      probes.length = 0;
      for (const band of STROKE_BANDS) materials[band].dispose();
      if (!options.atlas) atlas.dispose();
    },
  };
  vertexArms.register(batch);
  return batch;
}
