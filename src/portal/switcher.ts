/**
 * Runtime world switching through the portal (P5.5): walking or teleporting into a live frame of
 * the gallery enters its world, and "Return to gallery" reverses it. One transition at a time
 * (transition.ts): input is suppressed and locomotion frozen while it runs. The new world builds
 * on the slicer from the trigger, behind the old one, which is disposed under the veil at the end
 * of its `out` phase. Until then the new world keeps the old background showing and leaves the
 * rig alone. It stays out of the draw until its programs are compiled and its textures uploaded,
 * one texture per frame. Then its chunks are revealed on a time budget
 * (`nextRevealQuota`), each drawn once under the veil whether or not it is in view, so its buffers
 * upload before the `in` phase shows it. A world that fails to build, or stalls on a fetch
 * (`STALL_TIMEOUT_S`), falls back to the gallery once the old world is gone, then to the bare
 * scene.
 *
 * The view is never still while the world builds (wait-motion.ts): in the fly style the strokes
 * swirl where they hover, from liftoff into the `in` leg, and in the fade style a dim, fixed field
 * of night-coloured strokes (`portal-cue`) breathes under the veil.
 *
 * main.ts owns every binding to a world (governor, zdiag, A/B, reactive batch, HUD, diag keys,
 * locomotion) and hands them in as `bind` and `unbind`.
 */
import {
  Frustum,
  Matrix4,
  type Object3D,
  type PerspectiveCamera,
  Quaternion,
  type Scene,
  type Texture,
  Vector3,
  type WebGLRenderer,
} from 'three';
import type { Raster } from '../demo/canvas/field';
import {
  CROP_BIAS,
  coverCrop,
  HANGINGS,
  type Hanging,
  wallPoint,
} from '../paintings/gallery/layout';
import type { WorldHandle, WorldModule, WorldPose } from '../paintings/world-module';
import { STROKE_BANDS } from '../render/strokes/bands';
import type { StrokeBatch } from '../render/strokes/batch';
import type { Vec3 } from '../render/strokes/frame';
import type { Slicer } from '../util/slicer';
import {
  createFlyStrokes,
  createLeg,
  FLY_COUNT,
  type FlightLeg,
  type FlyStrokes,
} from './fly-strokes';
import {
  createPortalDetector,
  livePortals,
  type PortalDetector,
  type PortalFrame,
  portalOf,
  returnPose,
} from './portal';
import {
  createTransition,
  ease,
  type PortalState,
  type Transition,
  type TransitionStyle,
  transitionStyle,
  veilAt,
} from './transition';
import {
  CUE_COUNT,
  type CueField,
  createCueField,
  cueBrightness,
  cueFrame,
  planSwirl,
  type Swirl,
  swirlOffsets,
} from './wait-motion';

export const GALLERY_ID = 'gallery';
/**
 * The reveal runs on a time budget. Each frame reveals, and so draws and uploads, whole chunks up
 * to a stroke quota, and at least one. Counted in strokes, not chunks, because a Starry Night dome
 * sector holds up to 39k strokes against about 1k in a 24 m chunk. The quota starts here, which
 * was the fixed quota before the budget (65 frames for Starry Night at seed 1), and then follows
 * what each reveal frame cost (`nextRevealQuota`).
 */
export const REVEAL_START_STROKES = 8192;
/**
 * The fewest strokes a frame's quota falls to: the old fixed quota, so the reveal is never slower
 * than it was before the budget. A chunk over it still reveals alone.
 */
export const REVEAL_MIN_STROKES = REVEAL_START_STROKES;
/**
 * The most strokes a frame's quota reaches: 8 frames of the old fixed quota. The upload and the
 * one forced draw of each revealed chunk land partly off the main thread, where `renderMs` cannot
 * see them, so the quota is capped whatever the main thread reports.
 */
export const REVEAL_MAX_STROKES = 65_536;
/** The render time a reveal frame may add on the main thread, ms. */
export const REVEAL_BUDGET_MS = 4;
/** The most the quota grows from one frame to the next. */
export const REVEAL_GROWTH = 2;
/**
 * A reveal frame followed by an interval over this many times the recent median halves the
 * quota. The upload runs mostly in the GPU process, so it can show there and not in `renderMs`.
 */
export const REVEAL_SLOW_INTERVAL = 1.5;

/**
 * The chunk index one frame's reveal ends at, starting from `start` (below `chunks.length`): the
 * whole chunks that fit `quota` strokes, and at least one.
 */
export function revealEnd(
  chunks: readonly { readonly count: number }[],
  start: number,
  quota: number = REVEAL_START_STROKES,
): number {
  let end = start;
  let strokes = 0;
  do {
    strokes += chunks[end].count;
    end++;
  } while (end < chunks.length && strokes + chunks[end].count <= quota);
  return end;
}

/**
 * What a reveal frame's `strokes` new strokes cost to render, ms (`revealCost`).
 *
 * - Against the frame before, which drew every chunk revealed before it, the difference prices
 *   only the new strokes when the cost is in drawing what is revealed.
 * - The difference misses a cost that is all in the new strokes (their upload and forced draw),
 *   which recurs every frame. So it is never less than `perStrokeMs`: the lowest price per stroke
 *   any reveal frame so far has shown against the frame before the first reveal. A later frame's
 *   price also carries the draw of what was revealed before it, so it only overstates, and a
 *   one-off slow frame stops counting once a cheaper one follows.
 */
export function revealCost(
  strokes: number,
  renderMs: number,
  priorRenderMs: number,
  perStrokeMs: number,
): number {
  return Math.max(renderMs - priorRenderMs, perStrokeMs * strokes);
}

/**
 * The next frame's stroke quota after a reveal frame that showed `strokes` under `quota` at
 * `costMs` (`revealCost`): the strokes that spend REVEAL_BUDGET_MS at that price, at most
 * REVEAL_GROWTH times the quota and at least half of it, within [REVEAL_MIN_STROKES, `ceiling`].
 */
export function nextRevealQuota(
  quota: number,
  strokes: number,
  costMs: number,
  ceiling: number = REVEAL_MAX_STROKES,
): number {
  const fits = costMs > 0 ? (Math.max(strokes, 1) * REVEAL_BUDGET_MS) / costMs : Infinity;
  const next = Math.min(quota * REVEAL_GROWTH, Math.max(quota * 0.5, fits), ceiling);
  return Math.max(REVEAL_MIN_STROKES, Math.round(next));
}

/** Frame intervals kept for the median a reveal frame's follower is judged against. */
const RECENT_INTERVALS = 15;
/**
 * The slicer's budget during `out`, ms, while the next world builds behind the old one and the
 * old one still draws. The same as the slicer's own 6 ms, which holds the desktop at 16.8 ms
 * frames. The P5.8 headset check may lower it.
 */
export const OUT_BUILD_BUDGET_MS = 6;
/** A stroke leaving the frame: its quad, metres. */
const FRAME_STROKE: readonly [number, number] = [0.035, 0.014];
/**
 * A wait on something off the frame loop (a world's build or its `ready`, a scan for the second
 * leg) is given up after this many seconds of wait frames in which the slicer had nothing queued:
 * no progress the switcher can see. The build's own sliced work never counts, so a slow Quest
 * build is never cut short, and a slow Wi-Fi fetch of a warm build has this long to land. A world
 * given up on fails as a throw would (F3: the gallery, then the bare scene); a second leg given up
 * on is skipped, as a failed one is.
 */
export const STALL_TIMEOUT_S = 15;
/**
 * The most one frame adds to a stall count, ms. The first frame after a paused loop (the Meta
 * button, a doff, a hidden tab) carries the whole pause, which is no evidence of a stall.
 */
export const STALL_FRAME_MAX_MS = 250;

/** One frame's share of a stall count, seconds. */
const stallShare = (dtMs: number): number => Math.min(Math.max(0, dtMs), STALL_FRAME_MAX_MS) / 1000;

/** One wait on something off the frame loop, which the stall watchdog can give up on. */
interface Wait {
  /** True once given up on: whatever lands for it later is discarded. */
  stale: boolean;
  /** Rejects when given up on. */
  readonly expired: Promise<never>;
  expire(): void;
}

export interface LiveWorld {
  readonly id: string;
  readonly module: WorldModule;
  readonly handle: WorldHandle;
}

export interface SwitcherDeps {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly rig: Object3D;
  readonly slicer: Slicer;
  atlas(): Texture;
  /** Builds world `id` on the slicer. */
  build(id: string): Promise<LiveWorld>;
  /** Binds a built world to everything that follows the active world. */
  bind(world: LiveWorld): void;
  /** Releases every binding to the active world, before its module disposes it. */
  unbind(): void;
  /**
   * Places the rig origin on a pose. Not the head: in XR a physical offset from the local-floor
   * origin moves the head off it, and turns the view off its heading by the head yaw.
   */
  spawn(pose: WorldPose): void;
  /** No world could be built: locomotion falls back to the flat ground of the bare scene. */
  bare(): void;
  /** Mode switch: every held button and aim reports nothing until released. */
  suppressInput(): void;
  /** The black veil over the whole view, 0-1. */
  setVeil(alpha: number): void;
  calm(): number;
  loadRaster(url: string): Promise<Raster>;
  /** The time base of `lastTrigger.t`, ms. */
  now(): number;
}

export interface PortalDiag {
  state: PortalState;
  progress: number;
  style: TransitionStyle | null;
  phase: string | null;
  target: string | null;
  lastTrigger: { id: string; cause: 'walk' | 'teleport' | 'return' | 'api'; t: number } | null;
  /** The longest frame interval during the last transition, ms; null before the first. */
  longestFrameMs: number | null;
  /** The slicer's longest single build step during the last transition, ms, and its stage. */
  longestStepMs: number | null;
  longestStep: string | null;
  /** The slicer's longest step of each stage during the last transition, ms; `-` is unlabelled. */
  stepsMs: Record<string, number>;
  /** The last transition's wall time, trigger to done, ms. */
  durationMs: number | null;
  /**
   * What the last transition fell back to after its target failed to build: the gallery, the
   * bare scene, or null when it reached its target.
   */
  fallback: 'gallery' | 'bare' | null;
  /** True while the fly strokes exist: from a fly transition's trigger to its end. */
  flying: boolean;
  /**
   * What keeps the view moving while the world builds: the fly strokes' `swirl`, the fade style's
   * `pulse` field, or null while idle.
   */
  cue: 'swirl' | 'pulse' | null;
  /**
   * The running or last transition's wait, its frame intervals summed, ms; null before the first.
   */
  waitMs: number | null;
  /**
   * The last transition's frames, in order and capped at `MAX_FRAME_RECORDS`: the phase each ran,
   * its frame interval and the main thread's work in it (`renderFrame` start to end), ms. At 60 Hz
   * vsync the interval reads 16.7 or 33.3 ms whatever the work; the work tells them apart.
   */
  frames: FrameRecord[];
  /** The longest `workMs` of the last transition, its phase and its index in `frames`. */
  longestWorkMs: number | null;
  longestWorkPhase: string | null;
  longestWorkFrame: number | null;
  armed: Record<string, boolean>;
}

export interface FrameRecord {
  phase: string;
  intervalMs: number;
  workMs: number;
  /** The slicer's build steps in this frame, ms. */
  slicerMs: number;
  /** `renderer.render`, ms. */
  renderMs: number;
  /** What the switcher did this frame besides drawing, or null. */
  task: string | null;
}

/** A transition's frames kept for the diag: about 10 s at 60 Hz. */
export const MAX_FRAME_RECORDS = 600;

export interface Switcher {
  readonly active: LiveWorld | null;
  /** True while a transition runs: locomotion must not move the rig. */
  readonly busy: boolean;
  /** Binds the boot's world. */
  adopt(world: LiveWorld): void;
  /** One frame before locomotion: advances a running transition. `dtMs` is the frame interval. */
  frame(dtMs: number): void;
  /** At the end of the frame: the main thread's work in it and its render, ms, for `frames`. */
  endFrame(workMs: number, renderMs: number): void;
  /** After locomotion: tests the portals, in the gallery only and never during a transition. */
  detect(input: PortalFrame): void;
  /** Starts a transition to world `id`; false while one runs or `id` is already active. */
  go(id: string, cause: NonNullable<PortalDiag['lastTrigger']>['cause']): boolean;
  /** The slicer's budget for this frame: OUT_BUILD_BUDGET_MS during `out`, else undefined. */
  slicerBudgetMs(): number | undefined;
  diag(): PortalDiag;
}

const hangingOf = (id: string): Hanging | undefined => HANGINGS.find((h) => h.painting.id === id);

export function createSwitcher(deps: SwitcherDeps): Switcher {
  const transition: Transition = createTransition();
  const detector: PortalDetector = createPortalDetector(livePortals());
  let active: LiveWorld | null = null;
  let fly: FlyStrokes | null = null;
  let outLeg: FlightLeg | null = null;
  let inLeg: FlightLeg | null = null;
  /** The out leg's swirl about where its strokes hover, and this frame's offsets from it. */
  let swirl: Swirl | null = null;
  const drift = new Float32Array(FLY_COUNT * 3);
  /** The fade style's pulse field, its mesh and this frame's colours and sizes. */
  let cue: FlyStrokes | null = null;
  let cueField: CueField | null = null;
  const cueColors = new Uint8Array(CUE_COUNT * 3);
  const cueSizes = new Float32Array(CUE_COUNT * 2);
  /** Seconds since the trigger, and seconds spent waiting, by the frames' intervals. */
  let clock = 0;
  /** The clock when the out leg was ready: strokes that land late grow in from it. */
  let outAt = 0;
  let waitClock = 0;
  let leaving: StrokeBatch | null = null;
  let arriving: LiveWorld | null = null;
  let revealed = 0;
  /** This frame's stroke quota for the reveal (`nextRevealQuota`). */
  let revealQuota = REVEAL_START_STROKES;
  /** The strokes this frame revealed and the quota it used, until `endFrame` reads them. */
  let revealing: { strokes: number; quota: number } | null = null;
  /** The quota the last reveal frame used, until the next frame's interval is judged. */
  let revealedUnder: number | null = null;
  /**
   * The quota's ceiling: REVEAL_MAX_STROKES, lowered for good by a long interval after a reveal,
   * never below REVEAL_MIN_STROKES.
   */
  let revealCeiling = REVEAL_MAX_STROKES;
  /** The last frame's render, ms, or null before the transition's first. */
  let lastRenderMs: number | null = null;
  /**
   * The render of the frame before the first reveal, ms, which draws the shown world but none of
   * its strokes, and the lowest price per stroke a reveal frame has shown against it (`revealCost`).
   */
  let revealBaseMs: number | null = null;
  let perStrokeMs = Number.POSITIVE_INFINITY;
  /** The rig's inverse at the trigger: the first leg samples the frame against it. */
  const triggerInverse = new Matrix4();
  /** The spawn's turn of the waiting strokes on the desktop, for a first leg that lands after it. */
  let carried: { before: Vec3; after: Vec3; turn: Quaternion } | null = null;
  const recentIntervals: number[] = [];
  /**
   * The old world is disposed when `out` ends (`outOver`, `outDone`). The next world builds from
   * the trigger, so until then it lands behind the old one and stays out of the draw and the rig.
   */
  let outOver = true;
  let outDone: Promise<void> = Promise.resolve();
  let endOut: () => void = () => {};
  /**
   * World modules swap `scene.background` in `build` and back in `dispose`. A world that lands
   * before the old one is disposed has set its own: it waits here and the old one's stays shown
   * until `out` ends. `base` is the background under every world, read at the first dispose.
   */
  let incoming: { value: Scene['background'] } | null = null;
  let base: { value: Scene['background'] } | null = null;
  let uploads: Texture[] = [];
  /** The arriving world's top-level objects and their own visibility, kept out of the draw. */
  let hidden: [Object3D, boolean][] = [];
  /** The world the arriving one is entered from, for its arrival pose and its strokes' leg. */
  let arrivingFrom = '';
  let startedAt = 0;
  let longest = 0;
  const rasters = new Map<string, Promise<Raster>>();
  /** The wait the watchdog watches, and its wait frames so far with the slicer idle, seconds. */
  let waiting: Wait | null = null;
  let stalledS = 0;
  /**
   * The first leg's wait on its scan, counted over every frame of the transition, since the build
   * does not wait on it. Given up on, a stalled scan leaves the cache.
   */
  let outWait: Wait | null = null;
  let outStalledS = 0;
  /** Counts transitions, so a first leg that settles after its own has ended touches nothing. */
  let generation = 0;
  /**
   * Ids whose build was given up on and has not landed. Worlds are module singletons, so another
   * build of one would interleave with it: none starts until it lands and is disposed.
   */
  const abandoned = new Set<string>();
  const diagState: PortalDiag = {
    state: 'idle',
    progress: 0,
    style: null,
    phase: null,
    target: null,
    lastTrigger: null,
    longestFrameMs: null,
    longestStepMs: null,
    longestStep: null,
    stepsMs: {},
    durationMs: null,
    fallback: null,
    flying: false,
    cue: null,
    waitMs: null,
    frames: [],
    longestWorkMs: null,
    longestWorkPhase: null,
    longestWorkFrame: null,
    armed: {},
  };
  /** This frame's record, from `frame` until `endFrame`. */
  let current: FrameRecord | null = null;
  /** Names a task in this frame's record. */
  const note = (task: string): void => {
    if (current) current.task = current.task ? `${current.task}+${task}` : task;
  };
  const inverse = new Matrix4();
  const turn = new Quaternion();
  const scratch = new Vector3();
  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  let seed = 0x9e3779b9;
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function scanRaster(id: string): Promise<Raster> | null {
    const h = hangingOf(id);
    if (!h) return null;
    let load = rasters.get(id);
    if (!load) {
      const loading = deps.loadRaster(`${import.meta.env.BASE_URL}${h.painting.frameImage}`);
      // A failed load is not kept, so the next transition fetches it again.
      loading.catch(() => {
        if (rasters.get(id) === loading) rasters.delete(id);
      });
      rasters.set(id, loading);
      load = loading;
    }
    return load;
  }

  /** In the gallery, starts loading every live painting's scan, so a trigger finds it ready. */
  function prefetch(world: LiveWorld): void {
    if (world.id !== GALLERY_ID) return;
    for (const portal of livePortals()) scanRaster(portal.id)?.catch(() => {});
  }

  /** World point → rig-local, into `out` at `i`. */
  function toRig(out: Float32Array, i: number, x: number, y: number, z: number): void {
    scratch.set(x, y, z).applyMatrix4(inverse);
    out[i * 3] = scratch.x;
    out[i * 3 + 1] = scratch.y;
    out[i * 3 + 2] = scratch.z;
  }

  function updateInverse(): void {
    deps.rig.updateWorldMatrix(true, false);
    inverse.copy(deps.rig.matrixWorld).invert();
  }

  /** Points on painting `id`'s frame plane, coloured from its scan: rig-local into `pos`. */
  function sampleFrame(
    id: string,
    raster: Raster,
    pos: Float32Array,
    color: Uint8Array,
    size: Float32Array,
    rigInverse: Matrix4 | null = null,
  ): void {
    const h = hangingOf(id);
    if (!h) return;
    const crop = coverCrop(raster.width, raster.height, h.width, h.height, CROP_BIAS[id] ?? 0);
    if (rigInverse) inverse.copy(rigInverse);
    else updateInverse();
    for (let i = 0; i < FLY_COUNT; i++) {
      const fx = random();
      const fy = random();
      const p = wallPoint(h.wall, h.s + (fx - 0.5) * h.width, h.y + (fy - 0.5) * h.height, 0.06);
      toRig(pos, i, p[0], p[1], p[2]);
      const u = crop.u0 + fx * (crop.u1 - crop.u0);
      const v = crop.v0 + fy * (crop.v1 - crop.v0);
      const px = Math.min(raster.width - 1, Math.floor(u * raster.width));
      const py = Math.min(raster.height - 1, Math.floor((1 - v) * raster.height));
      const k = (py * raster.width + px) * 4;
      color[i * 3] = raster.data[k];
      color[i * 3 + 1] = raster.data[k + 1];
      color[i * 3 + 2] = raster.data[k + 2];
      size[i * 2] = FRAME_STROKE[0];
      size[i * 2 + 1] = FRAME_STROKE[1];
    }
  }

  /** Strokes of `batch` in the camera's view, rig-local, with their colours and sizes. */
  function sampleWorld(
    batch: StrokeBatch,
    pos: Float32Array,
    color: Uint8Array,
    size: Float32Array,
  ): void {
    deps.camera.updateWorldMatrix(true, false);
    viewProjection.multiplyMatrices(
      deps.camera.projectionMatrix,
      inverse.copy(deps.camera.matrixWorld).invert(),
    );
    frustum.setFromProjectionMatrix(viewProjection);
    updateInverse();
    // This runs whole in one frame (the bind), so it draws only from chunks the view can see, and
    // finds each pick's chunk by binary search over the running counts.
    const filled = batch.chunks.filter((c) => c.count > 0);
    const seen = filled.filter((c) => frustum.intersectsSphere(c.bounds));
    const chunks = seen.length > 0 ? seen : filled;
    const ends = new Float64Array(chunks.length);
    let total = 0;
    for (let k = 0; k < chunks.length; k++) {
      total += chunks[k].count;
      ends[k] = total;
    }
    for (let i = 0; i < FLY_COUNT; i++) {
      let picked = false;
      for (let tries = 0; tries < 40 && !picked && total > 0; tries++) {
        const pick = Math.floor(random() * total);
        let lo = 0;
        let hi = chunks.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (pick < ends[mid]) hi = mid;
          else lo = mid + 1;
        }
        const chunk = chunks[lo];
        const r = pick - (ends[lo] - chunk.count);
        const p = chunk.geometry.getAttribute('iPosition').array;
        scratch.set(p[r * 3], p[r * 3 + 1], p[r * 3 + 2]);
        if (tries < 39 && !frustum.containsPoint(scratch)) continue;
        const x = scratch.x;
        const y = scratch.y;
        const z = scratch.z;
        toRig(pos, i, x, y, z);
        const c = chunk.geometry.getAttribute('iColor').array;
        color[i * 3] = c[r * 4];
        color[i * 3 + 1] = c[r * 4 + 1];
        color[i * 3 + 2] = c[r * 4 + 2];
        const s = chunk.geometry.getAttribute('iSize').array;
        size[i * 2] = s[r * 2];
        size[i * 2 + 1] = s[r * 2 + 1];
        picked = true;
      }
      if (!picked) {
        pos[i * 3] = 0;
        pos[i * 3 + 1] = 1.6;
        pos[i * 3 + 2] = -3;
        size[i * 2] = 0;
        size[i * 2 + 1] = 0;
      }
    }
  }

  /** Each stroke's end where its swirl hovers it, at the frame's stroke size and its own colour. */
  function settle(leg: FlightLeg): void {
    for (let i = 0; i < FLY_COUNT; i++) {
      const i3 = i * 3;
      leg.toSize[i * 2] = FRAME_STROKE[0];
      leg.toSize[i * 2 + 1] = FRAME_STROKE[1];
      leg.toColor.set(leg.fromColor.subarray(i3, i3 + 3), i3);
      leg.arc[i] = 0.1 * random();
    }
  }

  function eye(): Vec3 {
    const p = deps.camera.position;
    return [p.x, p.y, p.z];
  }

  /** The first leg: the painting off its frame, or the world's strokes in toward the eye. */
  async function prepareOut(from: LiveWorld, to: string, gen: number): Promise<void> {
    const leg = createLeg();
    if (from.id === GALLERY_ID) {
      const load = scanRaster(to);
      if (!load) return;
      const wait = makeWait();
      outWait = wait;
      outStalledS = 0;
      let raster: Raster;
      try {
        raster = await within(wait, load);
      } catch (error) {
        if (wait.stale && rasters.get(to) === load) rasters.delete(to);
        throw error;
      } finally {
        if (outWait === wait) outWait = null;
      }
      if (gen !== generation || transition.target !== to) return;
      // Against the rig at the trigger: by now it may stand in the next world.
      sampleFrame(to, raster, leg.from, leg.fromColor, leg.fromSize, triggerInverse);
    } else {
      sampleWorld(from.handle.batch, leg.from, leg.fromColor, leg.fromSize);
    }
    swirl = planSwirl(leg.from, eye(), 0.9, 1.6, random, leg.to);
    settle(leg);
    outLeg = leg;
    outAt = clock;
    // Landed after a desktop spawn turned the look: turned with it, as earlier strokes were.
    if (carried) carry(carried.before, carried.after, carried.turn);
  }

  /** A wait nothing watches yet. */
  function makeWait(): Wait {
    let reject: (error: Error) => void = () => {};
    const expired = new Promise<never>((_, fail) => {
      reject = fail;
    });
    // Only the race in `within` reads it; a wait that ends in time never rejects.
    expired.catch(() => {});
    const wait: Wait = {
      stale: false,
      expired,
      expire() {
        wait.stale = true;
        reject(new Error(`stalled for ${STALL_TIMEOUT_S} s`));
      },
    };
    return wait;
  }

  /** Starts a wait for the watchdog to watch, in place of any before it. */
  function startWait(): Wait {
    const wait = makeWait();
    waiting = wait;
    stalledS = 0;
    return wait;
  }

  function endWait(wait: Wait): void {
    if (waiting === wait) waiting = null;
  }

  /** `promise`, or a rejection once the watchdog gives up on `wait`. */
  function within<T>(wait: Wait, promise: Promise<T>): Promise<T> {
    return Promise.race([promise, wait.expired]);
  }

  /** The second leg: from where the strokes hover to the new world's strokes or the frame. */
  async function prepareIn(world: LiveWorld, previous: string): Promise<void> {
    const leg = createLeg();
    if (outLeg) {
      leg.from.set(outLeg.to);
      leg.fromColor.set(outLeg.toColor);
      leg.fromSize.set(outLeg.toSize);
    }
    const load = world.id === GALLERY_ID ? scanRaster(previous) : null;
    if (load) {
      const wait = startWait();
      try {
        sampleFrame(previous, await within(wait, load), leg.to, leg.toColor, leg.toSize);
      } catch (error) {
        // A stalled load is not kept either, so the next transition fetches it again.
        if (wait.stale && rasters.get(previous) === load) rasters.delete(previous);
        throw error;
      } finally {
        endWait(wait);
      }
    } else {
      sampleWorld(world.handle.batch, leg.to, leg.toColor, leg.toSize);
    }
    for (let i = 0; i < FLY_COUNT; i++) leg.arc[i] = 0.3 * random();
    inLeg = leg;
  }

  /** The pose a world is entered at: a world's spawn, or the return spot before the frame. */
  function arrivalPose(world: LiveWorld, previous: string): WorldPose {
    if (world.id !== GALLERY_ID) return world.module.spawnPose();
    const h = hangingOf(previous);
    return h ? returnPose(portalOf(h)) : world.module.spawnPose();
  }

  /** Puts the hidden objects back to their own visibility. */
  function showHidden(): void {
    for (const [object, visible] of hidden) object.visible = visible;
    hidden = [];
  }

  /** Disposes a world whose build landed after it was given up on. */
  function disposeLate(id: string, world: LiveWorld): void {
    abandoned.delete(id);
    try {
      world.module.dispose();
    } catch (error) {
      console.warn(`portal: world ${id} failed to dispose`, error);
    }
  }

  /** Puts the background under every world back, once it is known. */
  function restoreBase(): void {
    if (base) deps.scene.background = base.value;
  }

  /**
   * Builds world `id` out of the draw, compiles its programs and queues its textures, then, once
   * `out` has ended (`done`), stands the rig in it. It may start before the old world is disposed.
   * On a throw or a stall the half-built world is disposed and the scene left as it was.
   */
  async function prepareWorld(id: string, previous: string, done: Promise<void>): Promise<void> {
    if (abandoned.has(id)) throw new Error(`a stalled build of ${id} has not landed`);
    const before = new Set(deps.scene.children);
    const shown = deps.scene.background;
    let world: LiveWorld | null = null;
    let landed = false;
    const wait = startWait();
    try {
      const building = deps.build(id);
      // A build given up on is disposed when it lands, and no other build of it starts before.
      building.then(
        (late) => {
          landed = true;
          if (wait.stale) disposeLate(id, late);
        },
        () => {
          landed = true;
          abandoned.delete(id);
        },
      );
      world = await within(wait, building);
      if (!outOver) {
        // Landed behind the old world: the old background shows until its dispose.
        incoming = { value: deps.scene.background };
        deps.scene.background = shown;
      }
      // Nothing the world added draws until its programs and textures are on the GPU.
      hidden = deps.scene.children
        .filter((object) => !before.has(object))
        .map((object): [Object3D, boolean] => [object, object.visible]);
      for (const [object] of hidden) object.visible = false;
      world.handle.batch.reveal(0);
      // The parts a world adds after its build (the gallery's plaques) compile with the rest.
      await within(wait, Promise.resolve(world.handle.ready));
      // Programs link in parallel (KHR_parallel_shader_compile), off the frame. `compile` takes
      // hidden objects too. Only what this world added, lit by the scene, since the old world
      // may still be in it.
      await within(
        wait,
        Promise.all(
          hidden.map(([object]) => deps.renderer.compileAsync(object, deps.camera, deps.scene)),
        ),
      );
      uploads = [];
      for (const [object] of hidden) {
        object.traverse((child) => {
          const material = (child as { material?: { map?: Texture | null } }).material;
          const map = material?.map;
          if (map && !uploads.includes(map)) uploads.push(map);
        });
      }
    } catch (error) {
      showHidden();
      uploads = [];
      incoming = null;
      if (world) {
        try {
          world.module.dispose();
        } catch (disposeError) {
          console.warn(`portal: world ${id} failed to dispose`, disposeError);
        }
        // Its dispose put back the background it found, the old world's if it landed early.
        if (outOver) restoreBase();
      } else if (wait.stale && !landed) {
        abandoned.add(id);
      }
      throw error;
    } finally {
      endWait(wait);
    }
    // The rig moves only once the old world is gone.
    await done;
    arriving = world;
    arrivingFrom = previous;
    revealed = 0;
    // The rig stands in the new world before the strokes' targets are sampled from its view.
    const eyeBefore = eye();
    turn.copy(deps.camera.quaternion).invert();
    deps.spawn(arrivalPose(world, previous));
    // A desktop spawn also resets the look, which turns the camera in the rig: the strokes turn
    // with it, so the field holds still in view. In XR the head pose overwrites the camera at the
    // next render, so the reset never shows there and the strokes stay put.
    turn.premultiply(deps.camera.quaternion);
    const presenting = deps.renderer.xr?.isPresenting === true;
    if (!presenting && Math.abs(turn.w) < 1 - 1e-9) {
      const eyeAfter = eye();
      carry(eyeBefore, eyeAfter);
      carried = { before: eyeBefore, after: eyeAfter, turn: turn.clone() };
    }
  }

  /** Turns every waiting stroke by `by` about the eye, from `before` to `after`, rig-local. */
  function carry(before: Vec3, after: Vec3, by: Quaternion = turn): void {
    const point = (array: Float32Array): void => {
      for (let i = 0; i + 2 < array.length; i += 3) {
        scratch
          .set(array[i] - before[0], array[i + 1] - before[1], array[i + 2] - before[2])
          .applyQuaternion(by);
        array[i] = after[0] + scratch.x;
        array[i + 1] = after[1] + scratch.y;
        array[i + 2] = after[2] + scratch.z;
      }
    };
    const vector = (array: Float32Array): void => {
      for (let i = 0; i + 2 < array.length; i += 3) {
        scratch.set(array[i], array[i + 1], array[i + 2]).applyQuaternion(by);
        array[i] = scratch.x;
        array[i + 1] = scratch.y;
        array[i + 2] = scratch.z;
      }
    };
    if (outLeg) {
      point(outLeg.from);
      point(outLeg.to);
    }
    if (swirl) {
      vector(swirl.b);
      vector(swirl.c);
    }
    if (cueField) point(cueField.positions);
  }

  /**
   * Builds `target` from the trigger; if that throws, rebuilds the gallery in front of `target`'s
   * frame once `out` has ended (`done`), since the old world may be the gallery; if that throws
   * too, ends the transition on the bare scene with input restored.
   */
  async function buildNext(target: string, previous: string, done: Promise<void>): Promise<void> {
    try {
      await prepareWorld(target, previous, done);
      return;
    } catch (error) {
      console.warn(`portal: world ${target} failed to build`, error);
    }
    await done;
    if (target !== GALLERY_ID) {
      try {
        await prepareWorld(GALLERY_ID, target, done);
        diagState.fallback = 'gallery';
        return;
      } catch (error) {
        console.warn('portal: the gallery failed to rebuild', error);
      }
    }
    diagState.fallback = 'bare';
    fly?.dispose();
    fly = null;
    outLeg = null;
    swirl = null;
    disposeCue();
    deps.bare();
    transition.ready();
  }

  /**
   * While waiting: one texture onto the GPU per frame, then the world into the draw, then a few
   * chunks per frame, then the second leg.
   */
  function upload(): void {
    const world = arriving;
    if (!world) return;
    const texture = uploads.shift();
    if (texture) {
      note('texture');
      deps.renderer.initTexture(texture);
      return;
    }
    if (hidden.length > 0) {
      note('show');
      showHidden();
      return;
    }
    const { chunks } = world.handle.batch;
    if (revealed < chunks.length) {
      note('reveal');
      const start = revealed;
      revealed = revealEnd(chunks, start, revealQuota);
      let strokes = 0;
      for (let i = start; i < revealed; i++) strokes += chunks[i].count;
      revealing = { strokes, quota: revealQuota };
      world.handle.batch.reveal(revealed);
      return;
    }
    note('bind');
    world.handle.batch.reveal(Number.POSITIVE_INFINITY);
    arriving = null;
    active = world;
    deps.bind(world);
    prefetch(world);
    const style = transition.style;
    if (style === 'fly') {
      void prepareIn(world, arrivingFrom)
        .catch((error: unknown) => {
          // The strokes skip their second leg; the transition still ends and input comes back.
          inLeg = null;
          console.warn('portal: the strokes could not find their way in', error);
        })
        .then(() => transition.ready());
    } else {
      transition.ready();
    }
  }

  /** Shrinks strokes whose out leg was ready after the trigger, so they grow in over 0.3 s. */
  function lateFade(): number {
    return outAt > 0 ? Math.max(0, 1 - (clock - outAt) / 0.3) : 0;
  }

  function disposeCue(): void {
    cue?.dispose();
    cue = null;
    cueField = null;
  }

  /**
   * The camera's heading, rig-local and level: its forward with the pitch dropped. Straight up or
   * down the forward has no level part, so its up vector, which then points along the heading,
   * stands in: `forward − sign(forward.y) · up` is level-ahead at every pitch.
   */
  function heading(): Vec3 {
    const forward = scratch.set(0, 0, -1).applyQuaternion(deps.camera.quaternion);
    const fy = forward.y;
    const x = forward.x;
    const z = forward.z;
    const up = scratch.set(0, 1, 0).applyQuaternion(deps.camera.quaternion);
    const sign = fy < 0 ? -1 : 1;
    const hx = x - sign * up.x;
    const hz = z - sign * up.z;
    const length = Math.hypot(hx, hz);
    return length > 1e-9 ? [hx / length, 0, hz / length] : [0, 0, -1];
  }

  /** The pulse field at `grow` (0-1) and the wait's breath so far, facing `at`. */
  function drawCue(grow: number, at: Vec3): void {
    if (!cue || !cueField) return;
    cueFrame(cueField, cueBrightness(waitClock), grow, cueColors, cueSizes);
    cue.place(cueField.positions, cueColors, cueSizes, at);
  }

  function finish(): void {
    fly?.dispose();
    fly = null;
    outLeg = null;
    inLeg = null;
    swirl = null;
    outWait = null;
    disposeCue();
    leaving = null;
    deps.setVeil(0);
    deps.suppressInput();
    detector.reset();
    diagState.durationMs = deps.now() - startedAt;
    diagState.longestFrameMs = longest;
    diagState.longestStepMs = deps.slicer.stats.longestStepMs;
    diagState.longestStep = deps.slicer.stats.longestStepLabel;
    diagState.stepsMs = { ...deps.slicer.stats.longestStepByLabel };
  }

  let frames = 0;

  const switcher: Switcher = {
    get active() {
      return active;
    },
    get busy() {
      return transition.state !== 'idle';
    },
    adopt(world) {
      active = world;
      deps.bind(world);
      prefetch(world);
    },
    frame(dtMs) {
      if (transition.state === 'idle') return;
      // The trigger's own frame interval predates the transition.
      if (frames > 0) longest = Math.max(longest, dtMs);
      frames += 1;
      const style = transition.style ?? 'fade';
      // A reveal frame followed by a long interval halves the quota it used, and caps it there
      // for the rest of the transition, so the quota that stalled never comes back.
      if (revealedUnder !== null) {
        const sorted = [...recentIntervals].sort((a, b) => a - b);
        const median = sorted.length > 0 ? sorted[sorted.length >> 1] : dtMs;
        if (dtMs > REVEAL_SLOW_INTERVAL * median) {
          revealCeiling = Math.max(REVEAL_MIN_STROKES, Math.round(revealedUnder * 0.5));
          revealQuota = Math.min(revealQuota, revealCeiling);
        }
        revealedUnder = null;
      }
      recentIntervals.push(dtMs);
      if (recentIntervals.length > RECENT_INTERVALS) recentIntervals.shift();
      const step = transition.advance(dtMs / 1000);
      if (!step) return;
      clock += Math.max(0, dtMs) / 1000;
      if (step.phase === 'wait') {
        waitClock += Math.max(0, dtMs) / 1000;
        diagState.waitMs = (diagState.waitMs ?? 0) + Math.max(0, dtMs);
      }
      current = {
        phase: step.phase,
        intervalMs: dtMs,
        workMs: 0,
        slicerMs: deps.slicer.stats.lastFrameWorkMs,
        renderMs: 0,
        task: null,
      };
      if (outWait) {
        outStalledS += stallShare(dtMs);
        if (outStalledS >= STALL_TIMEOUT_S) {
          note('stall-out');
          const wait = outWait;
          outWait = null;
          wait.expire();
        }
      }
      const veil = veilAt(step, style);
      deps.setVeil(veil);
      const at = eye();
      // The swirl runs on the transition's own clock from the trigger: each leg weighs it by its
      // strokes' progress, so it is continuous across both phase ends whatever the wait.
      const offsets = fly && outLeg && swirl ? drift : null;
      if (offsets && swirl) swirlOffsets(swirl, clock, offsets);
      if (step.phase === 'out') {
        if (leaving) {
          for (const band of STROKE_BANDS) leaving.setDensity(band, 1 - ease(step.t));
        }
        if (fly && outLeg) fly.draw(outLeg, step.t, at, lateFade(), offsets, 'arrive');
        drawCue(veil, at);
        if (step.outEnded) {
          note('dispose');
          const from = active;
          active = null;
          leaving = null;
          try {
            if (from) {
              deps.unbind();
              try {
                from.module.dispose();
              } catch (error) {
                console.warn(`portal: world ${from.id} failed to dispose`, error);
              }
              // Its dispose put back the background it found, which is not the base when it
              // landed behind the world before it.
              if (base) restoreBase();
              else base = { value: deps.scene.background };
            }
            if (incoming) {
              deps.scene.background = incoming.value;
              incoming = null;
            }
          } finally {
            // The next world waits on this, whatever the old world's teardown did.
            outOver = true;
            endOut();
          }
        }
      } else if (step.phase === 'wait') {
        if (fly && outLeg) fly.draw(outLeg, 1, at, lateFade(), offsets, 'arrive');
        drawCue(veil, at);
        upload();
        // The watchdog: wait frames with nothing on the slicer are a wait off the frame loop.
        if (waiting && deps.slicer.pending === 0) {
          stalledS += stallShare(dtMs);
          if (stalledS >= STALL_TIMEOUT_S) {
            note('stall');
            const wait = waiting;
            waiting = null;
            wait.expire();
          }
        } else {
          stalledS = 0;
        }
      } else if (step.phase === 'in') {
        // Strokes whose out leg was ready just before keep growing in.
        const late = lateFade();
        if (fly && inLeg) {
          const fade = Math.max(late, (step.t - 0.8) / 0.2);
          fly.draw(inLeg, step.t, at, fade, offsets, 'leave');
        } else if (fly && outLeg) {
          // No second leg: the strokes keep swirling where they hover and shrink away as the
          // veil lifts, rather than freeze over the new world.
          fly.draw(outLeg, 1, at, Math.max(late, Math.min(1, step.t / 0.6)), offsets, 'arrive');
        }
        // The field shrinks away as the veil lifts, so it is gone when the world is clear.
        drawCue(veil, at);
      } else if (step.phase === 'done') {
        finish();
      }
    },
    endFrame(workMs, renderMs) {
      const record = current;
      if (!record) return;
      current = null;
      record.workMs = workMs;
      record.renderMs = renderMs;
      if (revealing) {
        const { strokes, quota } = revealing;
        const prior = lastRenderMs ?? renderMs;
        revealBaseMs ??= prior;
        const price = Math.max(0, renderMs - revealBaseMs) / Math.max(strokes, 1);
        perStrokeMs = Math.min(perStrokeMs, price);
        const cost = revealCost(strokes, renderMs, prior, perStrokeMs);
        revealQuota = nextRevealQuota(quota, strokes, cost, revealCeiling);
        revealedUnder = quota;
        revealing = null;
      }
      lastRenderMs = renderMs;
      const index = diagState.frames.length;
      if (index < MAX_FRAME_RECORDS) diagState.frames.push(record);
      if (diagState.longestWorkMs === null || workMs > diagState.longestWorkMs) {
        diagState.longestWorkMs = workMs;
        diagState.longestWorkPhase = record.phase;
        diagState.longestWorkFrame = index;
      }
    },
    detect(input) {
      if (transition.state !== 'idle' || active?.id !== GALLERY_ID) {
        detector.reset();
        return;
      }
      const hit = detector.frame(input);
      if (hit) switcher.go(hit.id, input.teleportTo ? 'teleport' : 'walk');
    },
    go(id, cause) {
      const from = active;
      if (!from || from.id === id || abandoned.has(id)) return false;
      const style = transitionStyle(deps.calm());
      if (!transition.request(id === GALLERY_ID ? 'returning' : 'entering', id, style)) {
        return false;
      }
      startedAt = deps.now();
      longest = 0;
      frames = 0;
      clock = 0;
      outAt = 0;
      waitClock = 0;
      diagState.waitMs = 0;
      diagState.frames = [];
      diagState.fallback = null;
      diagState.longestWorkMs = null;
      diagState.longestWorkPhase = null;
      diagState.longestWorkFrame = null;
      deps.slicer.resetStats();
      diagState.lastTrigger = { id, cause, t: startedAt };
      deps.suppressInput();
      leaving = from.handle.batch;
      deps.unbind();
      generation += 1;
      if (style === 'fly') {
        fly = createFlyStrokes(deps.rig, deps.atlas());
        const gen = generation;
        void prepareOut(from, id, gen).catch((error: unknown) => {
          if (gen !== generation) return;
          // No first leg: the strokes stay hidden until the second.
          outLeg = null;
          swirl = null;
          console.warn('portal: the strokes could not leave the frame', error);
        });
      } else {
        // Hidden until its first frame; it grows in with the veil.
        cue = createFlyStrokes(deps.rig, deps.atlas(), CUE_COUNT, 'portal-cue');
        cueField = createCueField(eye(), heading());
      }
      revealQuota = REVEAL_START_STROKES;
      revealing = null;
      revealedUnder = null;
      revealCeiling = REVEAL_MAX_STROKES;
      lastRenderMs = null;
      revealBaseMs = null;
      perStrokeMs = Number.POSITIVE_INFINITY;
      recentIntervals.length = 0;
      carried = null;
      updateInverse();
      triggerInverse.copy(inverse);
      incoming = null;
      outOver = false;
      outDone = new Promise<void>((resolve) => {
        endOut = resolve;
      });
      // The build runs on the slicer through `out`, behind the old world, under
      // OUT_BUILD_BUDGET_MS a frame (`slicerBudgetMs`).
      void buildNext(id, from.id, outDone);
      return true;
    },
    slicerBudgetMs() {
      return transition.phase === 'out' ? OUT_BUILD_BUDGET_MS : undefined;
    },
    diag() {
      diagState.state = transition.state;
      diagState.progress = transition.state === 'idle' ? 0 : transition.progress;
      diagState.style = transition.style;
      diagState.phase = transition.phase;
      diagState.target = transition.target;
      diagState.armed = detector.armed();
      diagState.flying = fly !== null;
      diagState.cue = swirl !== null ? 'swirl' : cue !== null ? 'pulse' : null;
      return diagState;
    },
  };
  return switcher;
}
