/**
 * Runtime world switching through the portal (P5.5): walking or teleporting into a live frame of
 * the gallery enters its world, and "Return to gallery" reverses it. One transition at a time
 * (transition.ts): input is suppressed and locomotion frozen while it runs, the old world is
 * disposed under the veil at the end of its `out` phase, and the new one builds behind it on the
 * slicer. The new world stays out of the draw until its programs are compiled and its textures
 * uploaded, one texture per frame. Then its chunks are revealed a few per frame, each drawn once
 * under the veil whether or not it is in view, so its buffers upload before the `in` phase shows
 * it. A world that fails to build falls back to the gallery, then to the bare scene.
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
 * Strokes revealed, and so drawn and uploaded, per frame while a new world comes up: whole chunks
 * up to this many, and at least one. Counted in strokes, not chunks, because a Starry Night dome
 * sector holds up to 39k strokes against about 1k in a 24 m chunk. At seed 1 Starry Night reveals
 * in 65 frames with at most 39k strokes in one (its largest sector). Eight chunks a frame took 72
 * frames with up to 80k on the 24 m layout, and would take 20 with up to 89k on the merged one.
 */
export const REVEAL_STROKES_PER_FRAME = 8192;

/**
 * The chunk index one frame's reveal ends at, starting from `start` (below `chunks.length`): the
 * whole chunks that fit REVEAL_STROKES_PER_FRAME, and at least one.
 */
export function revealEnd(chunks: readonly { readonly count: number }[], start: number): number {
  let end = start;
  let strokes = 0;
  do {
    strokes += chunks[end].count;
    end++;
  } while (end < chunks.length && strokes + chunks[end].count <= REVEAL_STROKES_PER_FRAME);
  return end;
}
/** A stroke leaving the frame: its quad, metres. */
const FRAME_STROKE: readonly [number, number] = [0.035, 0.014];

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
  let uploads: Texture[] = [];
  /** The arriving world's top-level objects and their own visibility, kept out of the draw. */
  let hidden: [Object3D, boolean][] = [];
  /** The world the arriving one is entered from, for its arrival pose and its strokes' leg. */
  let arrivingFrom = '';
  let startedAt = 0;
  let longest = 0;
  const rasters = new Map<string, Promise<Raster>>();
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
  ): void {
    const h = hangingOf(id);
    if (!h) return;
    const crop = coverCrop(raster.width, raster.height, h.width, h.height, CROP_BIAS[id] ?? 0);
    updateInverse();
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
  async function prepareOut(from: LiveWorld, to: string): Promise<void> {
    const leg = createLeg();
    if (from.id === GALLERY_ID) {
      const load = scanRaster(to);
      if (!load) return;
      const raster = await load;
      if (transition.target !== to) return;
      sampleFrame(to, raster, leg.from, leg.fromColor, leg.fromSize);
    } else {
      sampleWorld(from.handle.batch, leg.from, leg.fromColor, leg.fromSize);
    }
    swirl = planSwirl(leg.from, eye(), 0.9, 1.6, random, leg.to);
    settle(leg);
    outLeg = leg;
    outAt = clock;
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
    if (load) sampleFrame(previous, await load, leg.to, leg.toColor, leg.toSize);
    else sampleWorld(world.handle.batch, leg.to, leg.toColor, leg.toSize);
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

  /**
   * Builds world `id` out of the draw, compiles its programs and queues its textures. On a throw
   * the half-built world is disposed and the scene left as it was.
   */
  async function prepareWorld(id: string, previous: string): Promise<void> {
    const before = new Set(deps.scene.children);
    let world: LiveWorld | null = null;
    try {
      world = await deps.build(id);
      // Nothing the world added draws until its programs and textures are on the GPU.
      hidden = deps.scene.children
        .filter((object) => !before.has(object))
        .map((object): [Object3D, boolean] => [object, object.visible]);
      for (const [object] of hidden) object.visible = false;
      world.handle.batch.reveal(0);
      // The parts a world adds after its build (the gallery's plaques) compile with the rest.
      await world.handle.ready;
      // Programs link in parallel (KHR_parallel_shader_compile), off the frame. `compile` takes
      // hidden objects too.
      await deps.renderer.compileAsync(deps.scene, deps.camera);
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
      if (world) {
        try {
          world.module.dispose();
        } catch (disposeError) {
          console.warn(`portal: world ${id} failed to dispose`, disposeError);
        }
      }
      throw error;
    }
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
    if (!presenting && Math.abs(turn.w) < 1 - 1e-9) carry(eyeBefore, eye());
  }

  /** Turns every waiting stroke by `turn` about the eye, from `before` to `after`, rig-local. */
  function carry(before: Vec3, after: Vec3): void {
    const point = (array: Float32Array): void => {
      for (let i = 0; i + 2 < array.length; i += 3) {
        scratch
          .set(array[i] - before[0], array[i + 1] - before[1], array[i + 2] - before[2])
          .applyQuaternion(turn);
        array[i] = after[0] + scratch.x;
        array[i + 1] = after[1] + scratch.y;
        array[i + 2] = after[2] + scratch.z;
      }
    };
    const vector = (array: Float32Array): void => {
      for (let i = 0; i + 2 < array.length; i += 3) {
        scratch.set(array[i], array[i + 1], array[i + 2]).applyQuaternion(turn);
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
   * Builds `target`; if that throws, rebuilds the gallery in front of `target`'s frame; if that
   * throws too, ends the transition on the bare scene with input restored.
   */
  async function buildNext(target: string, previous: string): Promise<void> {
    try {
      await prepareWorld(target, previous);
      return;
    } catch (error) {
      console.warn(`portal: world ${target} failed to build`, error);
    }
    if (target !== GALLERY_ID) {
      try {
        await prepareWorld(GALLERY_ID, target);
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
      revealed = revealEnd(chunks, revealed);
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

  let previousId = '';
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
          if (from) {
            deps.unbind();
            from.module.dispose();
          }
          const target = transition.target;
          if (target) void buildNext(target, previousId);
        }
      } else if (step.phase === 'wait') {
        if (fly && outLeg) fly.draw(outLeg, 1, at, lateFade(), offsets, 'arrive');
        drawCue(veil, at);
        upload();
      } else if (step.phase === 'in') {
        if (fly && inLeg) {
          fly.draw(inLeg, step.t, at, Math.max(0, (step.t - 0.8) / 0.2), offsets, 'leave');
        } else if (fly && outLeg) {
          // No second leg: the strokes keep swirling where they hover and shrink away as the
          // veil lifts, rather than freeze over the new world.
          fly.draw(outLeg, 1, at, Math.min(1, step.t / 0.6), offsets, 'arrive');
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
      if (!from || from.id === id) return false;
      const style = transitionStyle(deps.calm());
      if (!transition.request(id === GALLERY_ID ? 'returning' : 'entering', id, style)) {
        return false;
      }
      previousId = from.id;
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
      if (style === 'fly') {
        fly = createFlyStrokes(deps.rig, deps.atlas());
        void prepareOut(from, id).catch((error: unknown) => {
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
      return true;
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
