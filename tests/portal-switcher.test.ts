/**
 * The switcher's own state machine (P5.5 review F11, F2, F3): the fly and fade paths end to end,
 * the next world built from the trigger behind the old one, which is disposed when `out` ends, no
 * trigger consumed or repeated while busy, nothing left running when idle, the reveal's time
 * budget, and the failure paths, against fake worlds and a fake renderer.
 */
import {
  Color,
  DataTexture,
  Euler,
  Group,
  Mesh,
  MeshBasicMaterial,
  NoBlending,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  type Texture,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { describe, expect, test, vi } from 'vitest';
import type { Raster } from '../src/demo/canvas/field.ts';
import { HANGINGS } from '../src/paintings/gallery/layout.ts';
import {
  boundedImport,
  WORLD_IMPORT_TIMEOUT_MS,
  type WorldModule,
  type WorldPose,
} from '../src/paintings/world-module.ts';
import { createFlyStrokes } from '../src/portal/fly-strokes.ts';
import { insidePortal, livePortals, PORTAL_DEPTH, portalOf } from '../src/portal/portal.ts';
import {
  createSwitcher,
  GALLERY_ID,
  type LiveWorld,
  nextRevealQuota,
  OUT_BUILD_BUDGET_MS,
  REVEAL_BUDGET_MS,
  REVEAL_GROWTH,
  REVEAL_MAX_STROKES,
  REVEAL_MIN_STROKES,
  REVEAL_START_STROKES,
  revealCost,
  revealEnd,
  STALL_TIMEOUT_S,
} from '../src/portal/switcher.ts';
import type { StrokeBatch } from '../src/render/strokes/batch.ts';
import { createNoticeQueue, type NoticeQueue } from '../src/ui/notice-queue.ts';
import { VIGNETTE_RENDER_ORDER } from '../src/ui/vignette.ts';
import { createSlicer } from '../src/util/slicer.ts';

const FRAME_MS = 1000 / 60;

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('missing');
  return value;
}

const BACKGROUNDS: Record<string, number> = { [GALLERY_ID]: 0x202020, 'starry-night': 0x102040 };
/** A fake world's own background: a fresh colour each build, as a module makes one. */
const backgroundOf = (id: string): Color => new Color(BACKGROUNDS[id] ?? 0x777777);

interface FakeWorld extends LiveWorld {
  readonly root: Group;
  readonly reveals: number[];
  disposed: boolean;
}

/**
 * A world with one textured mesh and a batch of chunks of these stroke counts (none by default),
 * added to `scene` as a build would.
 */
function fakeWorld(
  id: string,
  scene: Scene,
  log: string[],
  counts: readonly number[] = [],
): FakeWorld {
  const root = new Group();
  const map = new DataTexture(new Uint8Array(4), 1, 1);
  root.add(new Mesh(new PlaneGeometry(), new MeshBasicMaterial({ map })));
  // As a world module does: its own background in `build`, the one it found back in `dispose`.
  const found = scene.background;
  scene.background = backgroundOf(id);
  scene.add(root);
  const reveals: number[] = [];
  const batch = {
    chunks: counts.map((count) => ({ count })),
    reveal: (n: number) => reveals.push(n),
    setDensity: () => {},
  } as unknown as StrokeBatch;
  const pose: WorldPose = { position: [0, 0, 0], yaw: 0 };
  const world: FakeWorld = {
    id,
    root,
    reveals,
    disposed: false,
    module: {
      build: async () => world.handle,
      update: () => {},
      dispose: () => {
        log.push(`dispose ${id}`);
        world.disposed = true;
        root.removeFromParent();
        scene.background = found;
      },
      spawnPose: () => pose,
      painterSpot: () => pose,
      painterCamera: () => ({ eye: [0, 1.6, 0], yaw: 0, pitch: 0, fovYDeg: 60, aspect: 1 }),
    } as WorldModule,
    handle: {
      batch,
      ground: { heightAt: () => 0, normalAt: () => [0, 1, 0] },
      boundaryFactor: () => 0,
    },
  };
  return world;
}

function raster(): Raster {
  return { width: 2, height: 2, data: new Uint8Array(16).fill(128) };
}

interface Rig {
  readonly switcher: ReturnType<typeof createSwitcher>;
  readonly camera: PerspectiveCamera;
  readonly scene: Scene;
  readonly rig: Group;
  readonly log: string[];
  readonly veils: number[];
  readonly worlds: Map<string, FakeWorld>;
  readonly uploads: Texture[];
  readonly spawns: WorldPose[];
  readonly calls: { suppress: number; bare: number; compile: number };
  /** Every object `compileAsync` was handed, in order. */
  readonly compiled: Object3D[];
  /** Ids whose build throws. */
  readonly failing: Set<string>;
  /** Per id, the stroke counts of the built world's batch chunks. */
  readonly chunkCounts: Map<string, readonly number[]>;
  /** Per id, a promise the build waits on before it builds. */
  readonly gates: Map<string, Promise<void>>;
  /** Per id, the built world's `ready`. */
  readonly readies: Map<string, Promise<void>>;
  /** Per id, a chunk import the build awaits through `boundedImport`, as main.ts does. */
  readonly imports: Map<string, Promise<unknown>>;
  readonly slicer: ReturnType<typeof createSlicer>;
  /** Every `loadFailed` call, in order. */
  readonly failures: { target: string; reason: string }[];
  /** Every `entered` call, in order. */
  readonly entered: string[];
  /** The notice queue `loadFailed` and `entered` drive, as main.ts wires them. */
  readonly notices: NoticeQueue;
  loadRaster: (url: string) => Promise<Raster>;
  calm: number;
}

function setup(
  options: {
    loadRaster?: (url: string) => Promise<Raster>;
    /** Runs inside `spawn`, as a desktop spawn resets the look. */
    onSpawn?: (camera: PerspectiveCamera) => void;
    /** The renderer reports an XR session presenting. */
    presenting?: boolean;
  } = {},
): Rig {
  const scene = new Scene();
  const rig = new Group();
  scene.add(rig);
  const camera = new PerspectiveCamera();
  rig.add(camera);
  const log: string[] = [];
  const veils: number[] = [];
  const worlds = new Map<string, FakeWorld>();
  const uploads: Texture[] = [];
  const spawns: WorldPose[] = [];
  const calls = { suppress: 0, bare: 0, compile: 0 };
  const compiled: Object3D[] = [];
  const failing = new Set<string>();
  const chunkCounts = new Map<string, readonly number[]>();
  const gates = new Map<string, Promise<void>>();
  const readies = new Map<string, Promise<void>>();
  const imports = new Map<string, Promise<unknown>>();
  const failures: { target: string; reason: string }[] = [];
  const entered: string[] = [];
  const notices = createNoticeQueue();
  const slicer = createSlicer(6);
  const renderer = {
    compileAsync: async (object: Object3D) => {
      calls.compile += 1;
      compiled.push(object);
    },
    initTexture: (texture: Texture) => uploads.push(texture),
    xr: { isPresenting: options.presenting === true },
  } as unknown as WebGLRenderer;
  const state: { loadRaster: (url: string) => Promise<Raster>; calm: number } = {
    loadRaster: options.loadRaster ?? vi.fn(async (_url: string) => raster()),
    calm: 1,
  };
  const switcher = createSwitcher({
    renderer,
    scene,
    camera,
    rig,
    slicer,
    atlas: () => new DataTexture(new Uint8Array(4), 1, 1),
    build: async (id) => {
      log.push(`build ${id}`);
      await Promise.resolve();
      const imported = imports.get(id);
      if (imported) await boundedImport(imported);
      const gate = gates.get(id);
      if (gate) await gate;
      if (failing.has(id)) throw new Error(`no world for ${id}`);
      const world = fakeWorld(id, scene, log, chunkCounts.get(id));
      const ready = readies.get(id);
      if (ready) Object.assign(world.handle, { ready });
      worlds.set(id, world);
      return world;
    },
    bind: (world) => log.push(`bind ${world.id}`),
    unbind: () => log.push('unbind'),
    spawn: (pose) => {
      spawns.push(pose);
      options.onSpawn?.(camera);
    },
    loadFailed: (target, reason) => {
      failures.push({ target, reason });
      notices.raise('world-failed', `${target} ${reason}`);
    },
    entered: (target) => {
      entered.push(target);
      notices.dismiss('world-failed');
    },
    bare: () => {
      calls.bare += 1;
    },
    suppressInput: () => {
      calls.suppress += 1;
    },
    setVeil: (alpha) => veils.push(alpha),
    calm: () => state.calm,
    loadRaster: (url) => state.loadRaster(url),
    now: () => performance.now(),
  });
  const r: Rig = {
    switcher,
    camera,
    scene,
    rig,
    log,
    veils,
    worlds,
    uploads,
    spawns,
    calls,
    compiled,
    failing,
    chunkCounts,
    gates,
    readies,
    imports,
    slicer,
    failures,
    entered,
    notices,
    get loadRaster() {
      return state.loadRaster;
    },
    set loadRaster(next) {
      state.loadRaster = next;
    },
    get calm() {
      return state.calm;
    },
    set calm(next) {
      state.calm = next;
    },
  };
  const gallery = fakeWorld(GALLERY_ID, scene, log);
  worlds.set(GALLERY_ID, gallery);
  switcher.adopt(gallery);
  log.length = 0;
  return r;
}

/** Frames until the transition ends, letting the async build settle between frames. */
async function run(r: Rig, maxFrames = 600): Promise<number> {
  for (let i = 0; i < maxFrames; i++) {
    r.switcher.frame(FRAME_MS);
    r.switcher.endFrame(1, 0.5);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!r.switcher.busy) return i + 1;
  }
  throw new Error('the transition never ended');
}

/**
 * 60 chunks larger than any quota grows to in 40 doublings from 8192, so every reveal frame takes
 * one whatever the quota logic does: the wait outlasts a scan landing at frame 50.
 */
const LONG_REVEAL: readonly number[] = Array(60).fill(Number.MAX_SAFE_INTEGER);

const starryPortal = portalOf(must(HANGINGS.find((h) => h.painting.id === 'starry-night')));
const standing = (pose: WorldPose): [number, number, number] => [
  pose.position[0],
  1.6,
  pose.position[2],
];

describe('createSwitcher', () => {
  test('the gallery starts loading every live scan when it binds, before any trigger', async () => {
    const r = setup();
    expect(r.loadRaster).toHaveBeenCalledTimes(1);
    const h = must(HANGINGS.find((x) => x.painting.id === 'starry-night'));
    expect(r.loadRaster).toHaveBeenCalledWith(expect.stringContaining(h.painting.frameImage));
    // The trigger finds it ready: the strokes leave the frame on the first frame.
    r.switcher.go('starry-night', 'api');
    await Promise.resolve();
    await Promise.resolve();
    r.switcher.frame(FRAME_MS);
    expect(r.switcher.diag().cue).toBe('swirl');
    expect(r.loadRaster).toHaveBeenCalledTimes(1);
  });

  test('fly: builds the new world from the trigger behind the old one, hidden, and moves the rig only once the old one is disposed', async () => {
    const r = setup();
    const gallery = must(r.worlds.get(GALLERY_ID));
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    expect(r.switcher.busy).toBe(true);
    expect(r.rig.children.some((c) => c.name === 'portal-fly')).toBe(true);
    // The build starts at the trigger, while the gallery still shows.
    expect(r.log).toEqual(['unbind', 'build starry-night']);
    let hiddenWhileWaiting = false;
    let hiddenBehindGallery = false;
    let spawnedBeforeDispose = false;
    let shown = false;
    for (let i = 0; i < 600 && r.switcher.busy; i++) {
      r.switcher.frame(FRAME_MS);
      r.switcher.endFrame(1, 0.5);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const next = r.worlds.get('starry-night');
      if (next && !gallery.disposed && !next.root.visible) hiddenBehindGallery = true;
      if (r.spawns.length > 0 && !gallery.disposed) spawnedBeforeDispose = true;
      if (next && r.uploads.length === 0 && !next.root.visible) hiddenWhileWaiting = true;
      if (next?.root.visible) shown = true;
    }
    expect(r.switcher.busy).toBe(false);
    // `go` unbinds at the trigger and again before the dispose at the end of `out`.
    expect(r.log).toEqual([
      'unbind',
      'build starry-night',
      'unbind',
      'dispose gallery',
      'bind starry-night',
    ]);
    expect(hiddenBehindGallery).toBe(true);
    expect(spawnedBeforeDispose).toBe(false);
    expect(r.spawns.length).toBe(1);
    expect(gallery.disposed).toBe(true);
    const world = must(r.worlds.get('starry-night'));
    expect(hiddenWhileWaiting).toBe(true);
    expect(shown).toBe(true);
    // Its one texture went up on its own frame, before the world showed.
    const mesh = world.root.children[0] as Mesh<PlaneGeometry, MeshBasicMaterial>;
    expect(r.uploads).toEqual([mesh.material.map]);
    expect(world.reveals[0]).toBe(0);
    expect(world.reveals.at(-1)).toBe(Number.POSITIVE_INFINITY);
    expect(r.switcher.active?.id).toBe('starry-night');
    expect(r.veils.at(-1)).toBe(0);
    const diag = r.switcher.diag();
    expect(diag.fallback).toBe(null);
    expect(diag.lastTrigger?.id).toBe('starry-night');
    expect(diag.frames.length).toBeGreaterThan(0);
    expect(new Set(diag.frames.map((f) => f.phase))).toEqual(
      new Set(['out', 'wait', 'in', 'done']),
    );
    expect(diag.longestWorkMs).toBe(1);
    // The fly strokes are gone and the mode switch suppressed input at the start and the end.
    expect(r.rig.children.some((c) => c.name === 'portal-fly')).toBe(false);
    expect(r.calls.suppress).toBe(2);
  });

  test('the reveal takes whole chunks up to its quota a frame, then binds (revealEnd)', async () => {
    const r = setup();
    // 3000 + 3000 + 2000 fit the first 8192; the 40k chunk goes alone; the last chunk ends it.
    r.chunkCounts.set('starry-night', [3000, 3000, 2000, 40_000, 100]);
    expect(REVEAL_START_STROKES).toBe(8192);
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    await run(r);
    const world = must(r.worlds.get('starry-night'));
    expect(world.reveals).toEqual([0, 3, 4, 5, Number.POSITIVE_INFINITY]);
    expect(r.switcher.active?.id).toBe('starry-night');
  });

  interface RenderModel {
    /** A frame's render during `out`, and during every other phase, ms. */
    readonly outMs?: number;
    readonly baseMs?: number;
    /** Per stroke a reveal frame shows for the first time, ms. */
    readonly perNewMs?: number;
    /** Per revealed stroke drawn, every frame from its reveal on, ms. */
    readonly perSteadyMs?: number;
    /** A one-off extra render on reveal frame `k`, ms. */
    readonly extraMs?: (k: number) => number;
    /** The interval of the frame after reveal frame `k`, ms. */
    readonly interval?: (k: number) => number;
  }

  /** Runs a transition under `model`'s render costs. Returns each reveal frame's strokes. */
  async function revealRun(
    r: Rig,
    counts: readonly number[],
    model: RenderModel = {},
  ): Promise<number[]> {
    const { outMs = 2, baseMs = 0.5, perNewMs = 0, perSteadyMs = 0 } = model;
    const interval = model.interval ?? (() => FRAME_MS);
    const extraMs = model.extraMs ?? (() => 0);
    r.chunkCounts.set('starry-night', counts);
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    const sizes: number[] = [];
    let seen = 0;
    let shown = 0;
    let dt = FRAME_MS;
    for (let i = 0; i < 600 && r.switcher.busy; i++) {
      r.switcher.frame(dt);
      const phase = r.switcher.diag().phase;
      const world = r.worlds.get('starry-night');
      const last = world?.reveals.at(-1) ?? 0;
      let strokes = 0;
      if (world && world.reveals.length > seen && Number.isFinite(last) && last > 0) {
        const from = world.reveals.length >= 2 ? (world.reveals.at(-2) ?? 0) : 0;
        for (let k = from; k < last; k++) strokes += counts[k];
        sizes.push(strokes);
      }
      seen = world?.reveals.length ?? 0;
      shown += strokes;
      const base = phase === 'out' ? outMs : baseMs;
      const extra = strokes > 0 ? extraMs(sizes.length - 1) : 0;
      r.switcher.endFrame(1, base + extra + perNewMs * strokes + perSteadyMs * shown);
      dt = strokes > 0 ? interval(sizes.length - 1) : FRAME_MS;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(r.switcher.busy).toBe(false);
    return sizes;
  }

  /** The reveal frames the old fixed 8192-stroke quota takes over chunks of `size` strokes. */
  const fixedFrames = (total: number, size: number): number =>
    Math.ceil(total / (Math.floor(REVEAL_START_STROKES / size) * size));

  test('on a fast machine the quota doubles a frame up to REVEAL_MAX_STROKES (F2)', async () => {
    const r = setup();
    const sizes = await revealRun(r, Array(100).fill(4000));
    // 8192, then ×2 a frame: 2, 4, 8, 16 chunks, then 16 a frame to the 6 left.
    expect(sizes).toEqual([8000, 16_000, 32_000, 64_000, 64_000, 64_000, 64_000, 64_000, 24_000]);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(REVEAL_MAX_STROKES);
  });

  test('between the floor and the cap, each reveal frame aims at the budget', async () => {
    const r = setup();
    // 0.2 µs a new stroke: the budget fits 20,000. The `out` frames render dearer than the wait,
    // so the price is only right against the frame before the reveal.
    const perNewMs = 0.0002;
    const sizes = await revealRun(r, Array(160).fill(1000), { perNewMs });
    expect(sizes).toEqual([8000, 16_000, ...Array(6).fill(20_000), 16_000]);
    for (const size of sizes) {
      expect(size * perNewMs).toBeLessThanOrEqual(REVEAL_BUDGET_MS + 1e-9);
    }
  });

  test('on a slow machine the quota holds at the old fixed 8192, never below', async () => {
    const r = setup();
    // 1 µs a new stroke: the budget fits only 4000, but the floor is the shipped quota.
    expect(REVEAL_MIN_STROKES).toBe(REVEAL_START_STROKES);
    const sizes = await revealRun(r, Array(160).fill(250), { perNewMs: 0.001 });
    expect(sizes).toEqual(Array(5).fill(8000));
  });

  test('drawing what is already revealed is not charged to each new reveal (F3)', async () => {
    const r = setup();
    // Each revealed stroke keeps costing half its first frame's price. Charged to each reveal,
    // the quota would slide to the floor as the world fills in.
    const sizes = await revealRun(r, Array(400).fill(1000), {
      perNewMs: 0.0001,
      perSteadyMs: 0.00005,
    });
    expect(sizes.length).toBeLessThanOrEqual(20);
    expect(sizes.length).toBeLessThan(fixedFrames(400_000, 1000));
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(400_000);
  });

  test('one slow first reveal frame stops pricing the reveal once a cheaper one follows (N1)', async () => {
    const r = setup();
    // A one-off 30 ms on the first reveal frame (a GC pause, a deferred driver compile), then
    // free renders: priced at that frame for good, the quota would sit at its floor throughout.
    const sizes = await revealRun(r, Array(100).fill(4000), { extraMs: (k) => (k === 0 ? 30 : 0) });
    expect(sizes.slice(0, 2)).toEqual([8000, 8000]);
    expect(Math.max(...sizes)).toBe(64_000);
    expect(sizes.length).toBeLessThanOrEqual(fixedFrames(400_000, 4000));
    expect(sizes.length).toBeLessThanOrEqual(12);
  });

  test('a long interval after a reveal frame caps the rest at half its quota (F1)', async () => {
    const r = setup();
    // Free renders, but the second reveal frame's follower takes three frames.
    const sizes = await revealRun(r, Array(64).fill(1000), {
      interval: (k) => (k === 1 ? 3 * FRAME_MS : FRAME_MS),
    });
    expect(sizes.slice(0, 2)).toEqual([8000, 16_000]);
    for (const size of sizes.slice(2)) expect(size).toBeLessThanOrEqual(8192);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(64_000);
  });

  test('a steady overrun from the third reveal frame on never takes the quota below 8192 (N2)', async () => {
    const r = setup();
    // Every interval from the third reveal frame's follower on is two frames long, as when the
    // revealed world's own draw overruns. Each one halves the ceiling, down to the floor.
    const sizes = await revealRun(r, Array(160).fill(1000), {
      interval: (k) => (k >= 2 ? 2 * FRAME_MS : FRAME_MS),
    });
    expect(sizes.slice(0, 3)).toEqual([8000, 16_000, 32_000]);
    for (const size of sizes.slice(0, -1)) expect(size).toBeGreaterThanOrEqual(8000);
    expect(sizes.length).toBeLessThanOrEqual(fixedFrames(160_000, 1000));
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(160_000);
  });

  test('every transition starts the reveal afresh: quota, cap and price (F4)', async () => {
    const r = setup();
    const a = await revealRun(r, Array(100).fill(4000), { baseMs: 0.1 });
    expect(Math.max(...a)).toBe(64_000);
    expect(r.switcher.go(GALLERY_ID, 'api')).toBe(true);
    await run(r);
    // 0.2 µs a new stroke, with a long follower after its third reveal frame: a price and a cap
    // of its own. Priced at the first trip's free strokes it would grow past 20,000.
    const b = await revealRun(r, Array(160).fill(1000), {
      perNewMs: 0.0002,
      interval: (k) => (k === 2 ? 3 * FRAME_MS : FRAME_MS),
    });
    expect(b).toEqual([8000, 16_000, 20_000, ...Array(11).fill(10_000), 6000]);
    expect(r.switcher.go(GALLERY_ID, 'api')).toBe(true);
    await run(r);
    const c = await revealRun(r, Array(100).fill(4000));
    expect(c[0]).toBe(8000);
    expect(Math.max(...c)).toBe(64_000);
  });

  test('a scan that lands after the spawn is placed against the rig at the trigger (F6)', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const r = setup({
      loadRaster: vi.fn(async () => {
        await held;
        return raster();
      }),
      // The spawn moves the rig 20 m along +X, into the next world.
      onSpawn: (camera) => camera.parent?.position.set(20, 0, 0),
    });
    r.chunkCounts.set('starry-night', LONG_REVEAL);
    r.switcher.go('starry-night', 'api');
    const shots = await record(r, 'portal-fly', FRAME_MS, {
      open: () => release(),
      holdFrames: 50,
    });
    expect(r.spawns.length).toBe(1);
    const wait = shots.filter((s) => s.visible && s.phase === 'wait');
    expect(wait.length).toBeGreaterThan(5);
    const at = wait[2].position;
    let x = 0;
    let z = 0;
    for (let k = 0; k < at.length; k += 3) {
      x += at[k];
      z += at[k + 2];
    }
    x /= at.length / 3;
    z /= at.length / 3;
    // Ahead of the viewer, toward the frame on the north wall. Placed against the spawned rig,
    // the frame's points would sit 20 m along -X and the field would hover off to the left.
    expect(starryPortal.centre[0]).toBeCloseTo(0);
    expect(z).toBeLessThan(0);
    expect(Math.abs(x)).toBeLessThan(0.5 * Math.abs(z));
  });

  test('a scan that lands after a desktop spawn reset the look is turned with it (F6)', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const r = setup({
      loadRaster: vi.fn(async () => {
        await held;
        return raster();
      }),
      onSpawn: (camera) => camera.quaternion.identity(),
    });
    // Looking left and down at the trigger; the spawn faces the view straight ahead again.
    const look = new Quaternion().setFromEuler(new Euler(-0.4, 0.6, 0, 'YXZ'));
    r.camera.quaternion.copy(look);
    r.camera.position.set(0, 1.6, 0);
    r.chunkCounts.set('starry-night', LONG_REVEAL);
    r.switcher.go('starry-night', 'api');
    const shots = await record(r, 'portal-fly', FRAME_MS, {
      open: () => release(),
      holdFrames: 50,
    });
    const wait = shots.filter((s) => s.visible && s.phase === 'wait');
    expect(wait.length).toBeGreaterThan(5);
    const at = wait[2].position;
    const mean = new Vector3();
    for (let k = 0; k < at.length; k += 3) mean.x += at[k];
    for (let k = 1; k < at.length; k += 3) mean.y += at[k] - 1.6;
    for (let k = 2; k < at.length; k += 3) mean.z += at[k];
    mean.normalize();
    // The camera now has no rotation, so the rig frame is its frame. The field sits where the
    // frame stood in the view at the trigger, not straight ahead, where it would sit uncarried.
    const frame = new Vector3(...starryPortal.centre)
      .sub(new Vector3(0, 1.6, 0))
      .normalize()
      .applyQuaternion(look.clone().invert());
    expect(mean.angleTo(frame)).toBeLessThan(0.25);
  });

  test('compiles only the new world, never the scene or the old world (F7)', async () => {
    const r = setup();
    const gallery = must(r.worlds.get(GALLERY_ID));
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    await run(r);
    const world = must(r.worlds.get('starry-night'));
    expect(r.compiled).toContain(world.root);
    expect(r.compiled).not.toContain(r.scene);
    expect(r.compiled).not.toContain(gallery.root);
  });

  test('an old world whose dispose throws still lets the transition end (F8)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = setup();
    const gallery = must(r.worlds.get(GALLERY_ID));
    Object.assign(gallery.module, {
      dispose: () => {
        throw new Error('dispose failed');
      },
    });
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    await run(r);
    expect(r.switcher.active?.id).toBe('starry-night');
    expect(r.spawns.length).toBe(1);
    expect(warn).toHaveBeenCalledWith('portal: world gallery failed to dispose', expect.any(Error));
    warn.mockRestore();
  });

  test('the slicer runs at OUT_BUILD_BUDGET_MS during `out`, at its own budget otherwise', async () => {
    const r = setup();
    expect(r.switcher.slicerBudgetMs()).toBeUndefined();
    let land = (): void => {};
    r.gates.set('starry-night', new Promise<void>((resolve) => (land = resolve)));
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    r.switcher.frame(FRAME_MS);
    expect(r.switcher.diag().phase).toBe('out');
    expect(r.switcher.slicerBudgetMs()).toBe(OUT_BUILD_BUDGET_MS);
    for (let i = 0; i < 60; i++) r.switcher.frame(FRAME_MS);
    expect(r.switcher.diag().phase).toBe('wait');
    expect(r.switcher.slicerBudgetMs()).toBeUndefined();
    land();
    await run(r);
    expect(r.switcher.slicerBudgetMs()).toBeUndefined();
  });

  test('fade (calm below 0.3): no fly strokes, and the same order in about 0.6 s', async () => {
    const r = setup();
    r.calm = 0.2;
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    expect(r.switcher.diag().style).toBe('fade');
    expect(r.rig.children.some((c) => c.name === 'portal-fly')).toBe(false);
    const frames = await run(r);
    expect(r.log).toEqual([
      'unbind',
      'build starry-night',
      'unbind',
      'dispose gallery',
      'bind starry-night',
    ]);
    // 0.3 s out and 0.3 s in, plus the wait's few frames for the build, upload and show.
    expect(frames * FRAME_MS).toBeGreaterThan(600);
    expect(frames * FRAME_MS).toBeLessThan(800);
    // The gallery's prefetch is the only load: the fade needs no scan.
    expect(r.loadRaster).toHaveBeenCalledTimes(1);
    expect(r.rig.children.some((c) => c.name === 'portal-fly')).toBe(false);
  });

  test('a world that lands behind the old one keeps the old background until its dispose', async () => {
    const r = setup();
    const gallery = backgroundOf(GALLERY_ID);
    const starry = backgroundOf('starry-night');
    expect(r.scene.background).toEqual(gallery);
    /** Runs a transition, checking each frame's background against the world that shows. */
    const trip = async (to: string, from: Color, next: Color): Promise<boolean> => {
      expect(r.switcher.go(to, 'api')).toBe(true);
      let landedEarly = false;
      for (let i = 0; i < 600 && r.switcher.busy; i++) {
        const phase = r.switcher.diag().phase;
        r.switcher.frame(FRAME_MS);
        r.switcher.endFrame(1, 0.5);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const built = r.worlds.get(to);
        const outStill = r.switcher.diag().phase === 'out' || phase === null;
        if (outStill && built && !built.disposed) {
          landedEarly = true;
          expect(r.scene.background).toEqual(from);
        }
        if (r.switcher.diag().phase === 'in') expect(r.scene.background).toEqual(next);
      }
      expect(r.switcher.busy).toBe(false);
      expect(r.scene.background).toEqual(next);
      return landedEarly;
    };
    expect(await trip('starry-night', gallery, starry)).toBe(true);
    expect(await trip(GALLERY_ID, starry, gallery)).toBe(true);
    expect(await trip('starry-night', gallery, starry)).toBe(true);
    // Every world gone: the background under all of them, as before the first build.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.failing.add(GALLERY_ID);
    expect(r.switcher.go(GALLERY_ID, 'api')).toBe(true);
    await run(r);
    expect(r.switcher.diag().fallback).toBe('bare');
    expect(r.scene.background).toBe(null);
    warn.mockRestore();
  });

  test('a world that fails after landing behind the old one leaves the backgrounds right', async () => {
    const r = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Starry lands at once and its `ready` rejects during `out`: the gallery is rebuilt after.
    r.readies.set('starry-night', Promise.reject(new Error('plaques')));
    r.readies.get('starry-night')?.catch(() => {});
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    for (let i = 0; i < 600 && r.switcher.busy; i++) {
      r.switcher.frame(FRAME_MS);
      r.switcher.endFrame(1, 0.5);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (r.switcher.diag().phase === 'out') {
        expect(r.scene.background).toEqual(backgroundOf(GALLERY_ID));
      }
    }
    expect(r.switcher.diag().fallback).toBe('gallery');
    expect(r.scene.background).toEqual(backgroundOf(GALLERY_ID));
    // The rebuilt gallery found the base, so leaving it to the bare scene restores the base.
    r.failing.add('starry-night');
    r.failing.add(GALLERY_ID);
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    await run(r);
    expect(r.switcher.diag().fallback).toBe('bare');
    expect(r.scene.background).toBe(null);
    warn.mockRestore();
  });

  test('a trigger during a transition is refused and the detector does not fire', async () => {
    const r = setup();
    expect(r.switcher.go('starry-night', 'walk')).toBe(true);
    const inside: [number, number, number] = [
      starryPortal.centre[0] + starryPortal.normal[0] * (PORTAL_DEPTH / 2),
      1.6,
      starryPortal.centre[2] + starryPortal.normal[2] * (PORTAL_DEPTH / 2),
    ];
    expect(insidePortal(starryPortal, inside)).toBe(true);
    r.switcher.frame(FRAME_MS);
    r.switcher.detect({ head: [0, 1.6, 0], teleportTo: null, jumped: false });
    r.switcher.detect({ head: inside, teleportTo: null, jumped: false });
    r.switcher.detect({ head: [0, 1.6, 0], teleportTo: inside, jumped: false });
    expect(r.switcher.go('gallery', 'return')).toBe(false);
    await run(r);
    expect(r.log.filter((l) => l.startsWith('build'))).toEqual(['build starry-night']);
    expect(r.switcher.diag().lastTrigger?.cause).toBe('walk');
  });

  test('a return lands before the frame, facing it, and walking there does not re-trigger', async () => {
    const r = setup();
    r.switcher.go('starry-night', 'api');
    await run(r);
    r.switcher.go(GALLERY_ID, 'return');
    await run(r);
    const pose = must(r.spawns.at(-1));
    // On the frame's centre line, past the threshold's outer face.
    const out =
      (pose.position[0] - starryPortal.centre[0]) * starryPortal.normal[0] +
      (pose.position[2] - starryPortal.centre[2]) * starryPortal.normal[2];
    expect(out).toBeGreaterThan(PORTAL_DEPTH);
    const head = standing(pose);
    expect(insidePortal(starryPortal, head)).toBe(false);
    for (let i = 0; i < 5; i++) r.switcher.detect({ head, teleportTo: null, jumped: false });
    expect(r.switcher.busy).toBe(false);
    expect(r.switcher.active?.id).toBe(GALLERY_ID);
  });

  test('idle: a frame does nothing, records nothing and leaves no strokes behind', async () => {
    const r = setup();
    r.switcher.go('starry-night', 'api');
    await run(r);
    const veils = r.veils.length;
    const frames = r.switcher.diag().frames.length;
    const children = r.rig.children.length;
    for (let i = 0; i < 30; i++) {
      r.switcher.frame(FRAME_MS);
      r.switcher.endFrame(5, 1);
    }
    expect(r.veils.length).toBe(veils);
    expect(r.switcher.diag().frames.length).toBe(frames);
    expect(r.rig.children.length).toBe(children);
    expect(r.rig.children.some((c) => c.name === 'portal-fly')).toBe(false);
    expect(r.switcher.diag().state).toBe('idle');
    expect(r.switcher.diag().cue).toBe(null);
  });

  test('idle after a fade: the pulse field is gone too', async () => {
    const r = setup();
    r.calm = 0.2;
    r.switcher.go('starry-night', 'api');
    await run(r);
    for (let i = 0; i < 10; i++) r.switcher.frame(FRAME_MS);
    expect(r.rig.children.some((c) => c.name === 'portal-cue')).toBe(false);
    expect(r.rig.children.some((c) => c.name === 'portal-fly')).toBe(false);
    expect(r.switcher.diag().cue).toBe(null);
  });

  test('a failed scan load ends the transition, and is fetched again next time (F2)', async () => {
    const offline = vi.fn(async (): Promise<Raster> => {
      throw new Error('offline');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The gallery's prefetch fails, and is not kept.
    const r = setup({ loadRaster: offline });
    expect(offline).toHaveBeenCalledTimes(1);
    // Out of the gallery the strokes leave the frame: the first leg needs the scan.
    r.switcher.go('starry-night', 'api');
    for (let i = 0; i < 3; i++) {
      r.switcher.frame(FRAME_MS);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // With no first leg nothing swirls.
    expect(r.switcher.diag().flying).toBe(true);
    expect(r.switcher.diag().cue).toBe(null);
    await run(r);
    expect(r.switcher.active?.id).toBe('starry-night');
    expect(r.veils.at(-1)).toBe(0);
    // Back into the gallery they land on the frame: the second leg needs it, and fails again.
    r.switcher.go(GALLERY_ID, 'return');
    await run(r);
    expect(r.switcher.active?.id).toBe(GALLERY_ID);
    expect(r.switcher.busy).toBe(false);
    expect(r.veils.at(-1)).toBe(0);
    // The out leg shared the prefetch's load, and the second leg shared the gallery's prefetch at
    // the bind back: two loads, both failed.
    expect(offline).toHaveBeenCalledTimes(2);
    // No failure was kept: once the network is back, the next transition fetches it.
    const online = vi.fn(async () => raster());
    r.loadRaster = online;
    r.switcher.go('starry-night', 'api');
    await run(r);
    expect(online).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('a world that fails to build falls back to the gallery in front of its frame (F3)', async () => {
    const r = setup();
    r.failing.add('starry-night');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.switcher.go('starry-night', 'api');
    await run(r);
    // The gallery is rebuilt only once the old one is disposed: a world is a module singleton.
    expect(r.log).toEqual([
      'unbind',
      'build starry-night',
      'unbind',
      'dispose gallery',
      'build gallery',
      'bind gallery',
    ]);
    expect(r.switcher.active?.id).toBe(GALLERY_ID);
    expect(r.switcher.diag().fallback).toBe('gallery');
    // The user is told once, as a build failure (card 01a1c05ae68c).
    expect(r.failures).toEqual([{ target: 'starry-night', reason: 'build' }]);
    // In front of the frame it tried to enter, outside the threshold.
    expect(insidePortal(starryPortal, standing(must(r.spawns.at(-1))))).toBe(false);
    expect(r.veils.at(-1)).toBe(0);
    expect(r.calls.bare).toBe(0);
    // Usable again: the portal works once the world builds.
    r.failing.delete('starry-night');
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    await run(r);
    expect(r.switcher.active?.id).toBe('starry-night');
    warn.mockRestore();
  });

  test('when the gallery fails too, the transition ends on the bare scene with input back (F3)', async () => {
    const r = setup();
    r.failing.add('starry-night');
    r.failing.add(GALLERY_ID);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.switcher.go('starry-night', 'api');
    await run(r);
    expect(r.switcher.busy).toBe(false);
    expect(r.switcher.active).toBe(null);
    expect(r.switcher.diag().fallback).toBe('bare');
    expect(r.calls.bare).toBe(1);
    expect(r.veils.at(-1)).toBe(0);
    expect(r.calls.suppress).toBe(2);
    expect(r.rig.children.some((c) => c.name === 'portal-fly')).toBe(false);
    // Nothing the failed builds added is left in the scene.
    expect(r.scene.children).toEqual([r.rig]);
    warn.mockRestore();
  });

  test('the live portals are the frames with a world', () => {
    expect(livePortals().map((p) => p.id)).toEqual(['starry-night']);
  });
});

/** One drawn frame of a mesh of strokes: its phase and copies of its instance data. */
interface Shot {
  phase: string;
  position: Float32Array;
  color: Uint8Array;
  size: Float32Array;
  visible: boolean;
}

function meshOf(r: Rig, name: string): Mesh | undefined {
  return r.rig.children.find((c) => c.name === name) as Mesh | undefined;
}

/**
 * Runs the transition to its end at `dtMs` a frame, opening `gate` (if any) after `holdFrames`, and
 * records `name`'s instances after every frame that drew it.
 */
async function record(
  r: Rig,
  name: string,
  dtMs: number,
  opts: { open?: () => void; holdFrames?: number } = {},
): Promise<Shot[]> {
  const shots: Shot[] = [];
  const mesh = meshOf(r, name);
  for (let i = 0; i < 2000 && r.switcher.busy; i++) {
    if (opts.open && i === opts.holdFrames) opts.open();
    const before = r.switcher.diag().frames.length;
    r.switcher.frame(dtMs);
    r.switcher.endFrame(1, 0.5);
    const frame = r.switcher.diag().frames[before];
    const m = mesh ?? meshOf(r, name);
    // The `done` frame disposes the strokes rather than drawing them.
    if (frame && m && frame.phase !== 'done') {
      const g = m.geometry;
      shots.push({
        phase: frame.phase,
        position: (g.getAttribute('iPosition').array as Float32Array).slice(),
        color: (g.getAttribute('iColor').array as Uint8Array).slice(),
        size: (g.getAttribute('iSize').array as Float32Array).slice(),
        visible: m.visible,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(r.switcher.busy).toBe(false);
  return shots;
}

/** The largest per-stroke change between shots `a` and `b`, by position, colour and size. */
function step(a: Shot, b: Shot): { position: number; color: number; size: number } {
  let position = 0;
  let color = 0;
  let size = 0;
  for (let i = 0; i < a.position.length / 3; i++) {
    const i3 = i * 3;
    position = Math.max(
      position,
      Math.hypot(
        b.position[i3] - a.position[i3],
        b.position[i3 + 1] - a.position[i3 + 1],
        b.position[i3 + 2] - a.position[i3 + 2],
      ),
    );
    for (let c = 0; c < 3; c++) {
      color = Math.max(color, Math.abs(b.color[i * 4 + c] - a.color[i * 4 + c]));
    }
    size = Math.max(
      size,
      Math.abs(b.size[i * 2] - a.size[i * 2]),
      Math.abs(b.size[i * 2 + 1] - a.size[i * 2 + 1]),
    );
  }
  return { position, color, size };
}

/** Stroke `i`'s move from shot `a` to shot `b`, metres. */
function moved(a: Shot, b: Shot, i: number): number {
  const i3 = i * 3;
  return Math.hypot(
    b.position[i3] - a.position[i3],
    b.position[i3 + 1] - a.position[i3 + 1],
    b.position[i3 + 2] - a.position[i3 + 2],
  );
}

/**
 * The step across the boundary from phase `from` to `to` is no larger than the motion's own. Per
 * stroke, its move across the boundary is at most 1.5 times the larger of its moves into the frame
 * before and out of the frame after, plus 0.2 mm: a stroke the `in` leg has not started yet moves
 * only with the swirl on both sides, so a pop of its position shows at once. Colours and sizes
 * step by at most 1.5 times their largest step among the `window` frames on either side, plus a
 * byte and 0.1 mm.
 */
function expectSmooth(shots: Shot[], from: string, to: string, window = 8): void {
  const at = shots.findIndex((s, i) => i > 0 && shots[i - 1].phase === from && s.phase === to);
  expect(at, `${from} → ${to}`).toBeGreaterThan(1);
  expect(at + 1, `${from} → ${to}`).toBeLessThan(shots.length);
  const [before, last, first, after] = [shots[at - 2], shots[at - 1], shots[at], shots[at + 1]];
  let worst = 0;
  for (let i = 0; i < last.position.length / 3; i++) {
    const own = Math.max(moved(before, last, i), moved(first, after, i));
    worst = Math.max(worst, moved(last, first, i) - (1.5 * own + 2e-4));
  }
  expect(worst, `${from} → ${to} position`).toBeLessThanOrEqual(0);
  const across = step(last, first);
  let color = 0;
  let size = 0;
  const lo = Math.max(1, at - window);
  const hi = Math.min(shots.length - 1, at + window);
  for (let i = lo; i <= hi; i++) {
    if (i === at) continue;
    const s = step(shots[i - 1], shots[i]);
    color = Math.max(color, s.color);
    size = Math.max(size, s.size);
  }
  expect(across.color, `${from} → ${to} colour`).toBeLessThanOrEqual(1.5 * color + 1);
  expect(across.size, `${from} → ${to} size`).toBeLessThanOrEqual(1.5 * size + 1e-4);
}

describe('the wait keeps the view moving', () => {
  test('the strokes draw over the veil: transparent, so three sorts them after it', () => {
    const parent = new Group();
    const fly = createFlyStrokes(parent, new DataTexture(new Uint8Array(4), 1, 1));
    // three draws the opaque list before the transparent one, where the veil is, whatever the
    // render order: an opaque mesh would sit under the veil all through the wait.
    expect(fly.mesh.material.transparent).toBe(true);
    expect(fly.mesh.material.blending).toBe(NoBlending);
    expect(fly.mesh.material.alphaToCoverage).toBe(true);
    expect(fly.mesh.renderOrder).toBeGreaterThan(VIGNETTE_RENDER_ORDER);
    fly.dispose();
  });

  test('a frame uploads only what moves: never the brushes, the positions only when they move', () => {
    const parent = new Group();
    const fly = createFlyStrokes(parent, new DataTexture(new Uint8Array(4), 1, 1), 64, 'n2');
    const g = fly.mesh.geometry;
    const versions = () =>
      Object.fromEntries(
        ['iPosition', 'iNormal', 'iTangent', 'iColor', 'iSize', 'iMeta'].map((name) => [
          name,
          (g.getAttribute(name) as { version: number }).version,
        ]),
      );
    const at = new Float32Array(64 * 3).map((_, i) => (i % 3 === 2 ? -2 : 0.01 * i));
    const rgb = new Uint8Array(64 * 3).fill(90);
    const size = new Float32Array(64 * 2).fill(0.03);
    fly.place(at, rgb, size, [0, 0, 0]);
    const first = versions();
    fly.place(at, rgb, size, [0, 0.1, 0]);
    const second = versions();
    expect(second.iPosition).toBe(first.iPosition);
    expect(second.iTangent).toBe(first.iTangent);
    expect(second.iMeta).toBe(first.iMeta);
    expect(second.iNormal).toBe(first.iNormal + 1);
    expect(second.iColor).toBe(first.iColor + 1);
    expect(second.iSize).toBe(first.iSize + 1);
    at[0] += 0.1;
    fly.place(at, rgb, size, [0, 0.1, 0]);
    expect(versions().iPosition).toBe(second.iPosition + 1);
    fly.dispose();
  });

  test.each([
    ['short (the build at once)', FRAME_MS, 0],
    ['about 1 s', FRAME_MS, 96],
    ['over 10 s', 50, 220],
  ] as const)(
    'fly, %s: the strokes swirl through the wait, with no pop at either end',
    async (_label, dtMs, holdFrames) => {
      const r = setup();
      let open = (): void => {};
      if (holdFrames > 0)
        r.gates.set('starry-night', new Promise<void>((resolve) => (open = resolve)));
      expect(r.switcher.go('starry-night', 'api')).toBe(true);
      const shots = await record(r, 'portal-fly', dtMs, { open: () => open(), holdFrames });
      const wait = shots.filter((s) => s.phase === 'wait');
      // The out leg takes its frames (36 at 60 Hz, 12 at 20 Hz) before the wait starts.
      expect(wait.length).toBeGreaterThan(holdFrames > 0 ? holdFrames - 40 : 1);
      expect(r.switcher.diag().waitMs).toBeCloseTo(wait.length * dtMs, 6);
      // Never still: every wait frame moves the strokes.
      for (let i = 1; i < wait.length; i++) {
        expect(step(wait[i - 1], wait[i]).position).toBeGreaterThan(1e-5);
      }
      // And the swirl stays near: each stroke circles a vortex, so none strays more than 1 m from
      // where the out leg left it, about the widest circle 1.6 m from the eye. Half the strokes
      // stray under 0.22 m; the outermost circles grew with the 0.45 rad least half-extent.
      const hover = must(shots.filter((s) => s.phase === 'out').at(-1));
      for (const s of wait) {
        for (let i = 0; i < s.position.length; i++) {
          expect(Math.abs(s.position[i] - hover.position[i])).toBeLessThan(1);
        }
      }
      expectSmooth(shots, 'out', 'wait');
      expectSmooth(shots, 'wait', 'in');
    },
  );

  test('a return whose scan lands frames after the world binds still hands off without a pop', async () => {
    const r = setup();
    r.switcher.go('starry-night', 'api');
    await run(r);
    // Back to the gallery the second leg waits on the scan: hold it for 30 frames.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    r.loadRaster = vi.fn(async () => {
      await held;
      return raster();
    });
    expect(r.switcher.go(GALLERY_ID, 'return')).toBe(true);
    let frames = 0;
    const shots: Shot[] = [];
    const mesh = must(meshOf(r, 'portal-fly'));
    for (let i = 0; i < 1000 && r.switcher.busy; i++) {
      // The scan resolves 30 frames after the bind.
      if (r.log.at(-1) === 'bind gallery' && ++frames === 30) release();
      const before = r.switcher.diag().frames.length;
      r.switcher.frame(FRAME_MS);
      r.switcher.endFrame(1, 0.5);
      const frame = r.switcher.diag().frames[before];
      if (frame && frame.phase !== 'done') {
        const g = mesh.geometry;
        shots.push({
          phase: frame.phase,
          position: (g.getAttribute('iPosition').array as Float32Array).slice(),
          color: (g.getAttribute('iColor').array as Uint8Array).slice(),
          size: (g.getAttribute('iSize').array as Float32Array).slice(),
          visible: mesh.visible,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(r.switcher.busy).toBe(false);
    expect(frames).toBeGreaterThanOrEqual(30);
    expectSmooth(shots, 'out', 'wait');
    expectSmooth(shots, 'wait', 'in');
    expect(r.switcher.active?.id).toBe(GALLERY_ID);
  });

  test('fade, over 10 s: a fixed field breathes under the veil, grows in and shrinks away', async () => {
    const r = setup();
    r.calm = 0.2;
    let open = (): void => {};
    r.gates.set('starry-night', new Promise<void>((resolve) => (open = resolve)));
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    expect(r.switcher.diag().cue).toBe('pulse');
    expect(meshOf(r, 'portal-fly')).toBeUndefined();
    const shots = await record(r, 'portal-cue', 50, { open: () => open(), holdFrames: 220 });
    const wait = shots.filter((s) => s.phase === 'wait');
    expect(wait.length * 50).toBeGreaterThan(10_000);
    // No translation, ever: every drawn frame has the same positions.
    for (const s of shots) expect(s.position).toEqual(shots[0].position);
    // It breathes: the brightness of the wait's frames changes over the wait.
    const reds = new Set(wait.map((s) => s.color[0]));
    expect(reds.size).toBeGreaterThan(5);
    // It grows in with the veil from nothing, is full size while waiting and shrinks to nothing.
    expect(Math.max(...shots[0].size)).toBeLessThan(Math.max(...wait[0].size));
    const last = must(shots.at(-1));
    expect(last.phase).toBe('in');
    expect(Math.max(...last.size)).toBeLessThan(0.25 * Math.max(...wait[0].size));
    expectSmooth(shots, 'out', 'wait');
    expectSmooth(shots, 'wait', 'in');
    // It is gone at the end, and the transition ended where it should.
    expect(meshOf(r, 'portal-cue')).toBeUndefined();
    expect(r.switcher.active?.id).toBe('starry-night');
    expect(r.veils.at(-1)).toBe(0);
  });

  test('a second leg that fails keeps the strokes swirling and shrinks them away (M-1)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Offline throughout: back in the gallery the second leg cannot find the frame's scan.
    const r = setup({
      loadRaster: vi.fn(async (): Promise<Raster> => {
        throw new Error('offline');
      }),
    });
    r.switcher.go('starry-night', 'api');
    await run(r);
    r.switcher.go(GALLERY_ID, 'return');
    const shots = await record(r, 'portal-fly', FRAME_MS);
    const into = shots.filter((s) => s.phase === 'in');
    expect(into.length).toBeGreaterThan(10);
    const largest = (s: Shot) => Math.max(...s.size);
    // They keep moving while they shrink, and are gone well before the veil is.
    for (let i = 1; i < into.length && largest(into[i]) > 0; i++) {
      expect(step(into[i - 1], into[i]).position).toBeGreaterThan(1e-5);
      expect(largest(into[i])).toBeLessThanOrEqual(largest(into[i - 1]));
    }
    expect(largest(must(into.at(-1)))).toBe(0);
    expect(largest(into[0])).toBeGreaterThan(0);
    expectSmooth(shots, 'wait', 'in');
    warn.mockRestore();
  });

  test.each([
    ['desktop', false],
    ['XR', true],
  ])('%s: a spawn that resets the look leaves the field still in view (M-2)', async (_l, xr) => {
    // In XR the head pose comes back at the next render, as three's XR camera writes it.
    let head: Quaternion | null = null;
    const r = setup({
      presenting: xr,
      onSpawn: (camera) => {
        if (xr) head = camera.quaternion.clone();
        camera.quaternion.identity();
      },
    });
    // Looking left and down when the trigger fires.
    r.camera.quaternion.setFromEuler(new Euler(-0.4, 0.6, 0, 'YXZ'));
    r.camera.position.set(0, 1.6, 0);
    r.gates.set('starry-night', new Promise<void>((resolve) => setTimeout(resolve, 200)));
    r.switcher.go('starry-night', 'api');
    const mesh = () => meshOf(r, 'portal-fly');
    const view: { phase: string; at: Float32Array }[] = [];
    const inverse = new Quaternion();
    const p = new Vector3();
    for (let i = 0; i < 2000 && r.switcher.busy; i++) {
      const before = r.switcher.diag().frames.length;
      if (head) {
        r.camera.quaternion.copy(head);
        head = null;
      }
      r.switcher.frame(FRAME_MS);
      r.switcher.endFrame(1, 0.5);
      const frame = r.switcher.diag().frames[before];
      const m = mesh();
      if (frame && m && frame.phase === 'wait') {
        const positions = m.geometry.getAttribute('iPosition').array as Float32Array;
        inverse.copy(r.camera.quaternion).invert();
        const at = new Float32Array(positions.length);
        for (let k = 0; k < positions.length; k += 3) {
          p.set(positions[k], positions[k + 1] - 1.6, positions[k + 2]).applyQuaternion(inverse);
          at.set([p.x, p.y, p.z], k);
        }
        view.push({ phase: frame.phase, at });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(r.spawns.length).toBe(1);
    expect(view.length).toBeGreaterThan(10);
    // In the camera's own frame no wait frame moves a stroke more than the swirl does: a few
    // centimetres. Uncarried, the look's reset would jump the field by about 0.7 m.
    let worst = 0;
    for (let i = 1; i < view.length; i++) {
      for (let k = 0; k < view[i].at.length; k++) {
        worst = Math.max(worst, Math.abs(view[i].at[k] - view[i - 1].at[k]));
      }
    }
    expect(worst).toBeLessThan(0.05);
  });

  test.each([
    ['pitched up', 0.9, 1.2],
    ['looking straight down', -2.1, -Math.PI / 2],
  ])('fade, %s: the field faces the level heading (M-3)', async (_label, yaw, pitch) => {
    const r = setup();
    r.calm = 0.2;
    r.camera.quaternion.setFromEuler(new Euler(pitch, yaw, 0, 'YXZ'));
    r.switcher.go('starry-night', 'api');
    r.switcher.frame(FRAME_MS);
    const cue = must(meshOf(r, 'portal-cue'));
    const positions = cue.geometry.getAttribute('iPosition').array as Float32Array;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < positions.length; k += 3) {
      const l = Math.hypot(positions[k], positions[k + 1], positions[k + 2]);
      x += positions[k] / l;
      y += positions[k + 1] / l;
      z += positions[k + 2] / l;
    }
    const l = Math.hypot(x, y, z);
    // Centred on the horizon, along the yaw: −Z turned by `yaw`.
    expect(Math.abs(y / l)).toBeLessThan(0.05);
    expect(x / l).toBeCloseTo(-Math.sin(yaw), 1);
    expect(z / l).toBeCloseTo(-Math.cos(yaw), 1);
    await run(r);
  });

  test('a scan that lands just before the in phase keeps growing in through it (F2)', async () => {
    let releaseScan = (): void => {};
    const held = new Promise<void>((resolve) => (releaseScan = resolve));
    const r = setup({
      loadRaster: vi.fn(async () => {
        await held;
        return raster();
      }),
    });
    let land = (): void => {};
    r.gates.set('starry-night', new Promise<void>((resolve) => (land = resolve)));
    r.switcher.go('starry-night', 'api');
    // The scan and the world land together, 50 frames in: the in phase starts a few frames
    // after the strokes first show, well inside their 0.3 s grow-in.
    const shots = await record(r, 'portal-fly', FRAME_MS, {
      open: () => {
        releaseScan();
        land();
      },
      holdFrames: 50,
    });
    const first = shots.findIndex((s) => s.visible);
    const into = shots.findIndex((s) => s.phase === 'in');
    expect(into - first).toBeLessThan(10);
    const largest = (s: Shot) => Math.max(...s.size);
    const full = largest(shots[first + 30]);
    // Still growing at the start of the in phase, with no jump to full size there.
    expect(largest(shots[into])).toBeLessThan(0.6 * full);
    for (let i = first + 1; i < first + 18; i++) {
      expect(largest(shots[i]) - largest(shots[i - 1])).toBeLessThan(0.1 * full);
    }
  });

  test('a scan that lands after the trigger grows its strokes in, with no pop (M-5)', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const r = setup({
      loadRaster: vi.fn(async () => {
        await held;
        return raster();
      }),
    });
    r.switcher.go('starry-night', 'api');
    const shots = await record(r, 'portal-fly', FRAME_MS, { open: () => release(), holdFrames: 8 });
    const largest = (s: Shot) => Math.max(...s.size);
    const first = shots.findIndex((s) => s.visible);
    expect(first).toBeGreaterThan(5);
    const full = largest(shots[first + 30]);
    // The first frame shows them at a frame's share of 0.3 s, then they grow steadily.
    expect(largest(shots[first])).toBeLessThan(0.1 * full);
    for (let i = first + 1; i < first + 18; i++) {
      expect(largest(shots[i]) - largest(shots[i - 1])).toBeLessThan(0.1 * full);
    }
  });

  test('a failed build still recovers, and leaves no cue behind', async () => {
    const r = setup();
    r.calm = 0.2;
    r.failing.add('starry-night');
    r.failing.add(GALLERY_ID);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.switcher.go('starry-night', 'api');
    await run(r);
    expect(r.switcher.diag().fallback).toBe('bare');
    expect(r.scene.children).toEqual([r.rig]);
    expect(r.rig.children.some((c) => c.name === 'portal-cue')).toBe(false);
    warn.mockRestore();
  });
});

describe('a fetch that never lands (N1)', () => {
  /** A promise that never settles: a fetch the network never answers. */
  const never = <T>(): Promise<T> => new Promise<T>(() => {});
  /** 100 ms frames, so the watchdog's 15 s take 150 of them. */
  const SLOW_MS = 100;

  async function runSlow(r: Rig, maxFrames = 600): Promise<number> {
    for (let i = 0; i < maxFrames; i++) {
      r.switcher.frame(SLOW_MS);
      r.switcher.endFrame(1, 0.5);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!r.switcher.busy) return i + 1;
    }
    throw new Error('the transition never ended');
  }

  /** The wait's frames, seconds. */
  const waitS = (r: Rig): number => (r.switcher.diag().waitMs ?? 0) / 1000;

  test('a build stalled past the timeout falls back to the gallery with input back (F3)', async () => {
    const r = setup();
    let land = (): void => {};
    r.gates.set('starry-night', new Promise<void>((resolve) => (land = resolve)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.switcher.go('starry-night', 'api');
    await runSlow(r);
    expect(r.switcher.busy).toBe(false);
    expect(r.switcher.diag().fallback).toBe('gallery');
    expect(r.switcher.active?.id).toBe(GALLERY_ID);
    expect(r.veils.at(-1)).toBe(0);
    expect(r.calls.suppress).toBe(2);
    // Given up after the timeout, not before: the wait ran it and a few frames of the fallback.
    expect(waitS(r)).toBeGreaterThanOrEqual(STALL_TIMEOUT_S);
    expect(waitS(r)).toBeLessThan(STALL_TIMEOUT_S + 1);
    expect(r.switcher.diag().frames.some((f) => f.task === 'stall')).toBe(true);
    // The give-up tells the user too, as a stall (card 01a1c05ae68c).
    expect(r.failures).toEqual([{ target: 'starry-night', reason: 'stall' }]);
    // While the stalled build has not landed, the world is not entered again.
    expect(r.switcher.go('starry-night', 'api')).toBe(false);
    // When it lands it is disposed at once: never bound, spawned into or left in the scene.
    const spawns = r.spawns.length;
    land();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(r.log.filter((l) => l === 'bind starry-night')).toEqual([]);
    expect(r.log.at(-1)).toBe('dispose starry-night');
    expect(must(r.worlds.get('starry-night')).disposed).toBe(true);
    expect(r.spawns.length).toBe(spawns);
    const gallery = must(r.worlds.get(GALLERY_ID));
    expect(r.scene.children).toEqual([r.rig, gallery.root]);
    // And the portal works again.
    r.gates.delete('starry-night');
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    await run(r);
    expect(r.switcher.active?.id).toBe('starry-night');
    expect(r.switcher.diag().fallback).toBe(null);
    warn.mockRestore();
  });

  test('a failed entry raises the notice and a retry that succeeds clears it (F1)', async () => {
    const r = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.failing.add('starry-night');
    r.switcher.go('starry-night', 'api');
    await run(r);
    expect(r.switcher.diag().fallback).toBe('gallery');
    // The gallery fallback is not an entry: the notice stays.
    expect(r.entered).toEqual([]);
    expect(r.notices.queue.map((n) => n.kind)).toEqual(['world-failed']);
    r.failing.delete('starry-night');
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    await run(r);
    expect(r.switcher.active?.id).toBe('starry-night');
    expect(r.entered).toEqual(['starry-night']);
    expect(r.notices.queue).toEqual([]);
    warn.mockRestore();
  });

  test('a stall give-up followed by a late build failure raises the notice once (F2)', async () => {
    const r = setup();
    let fail = (_error: Error): void => {};
    r.gates.set('starry-night', new Promise<void>((_, reject) => (fail = reject)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.switcher.go('starry-night', 'api');
    await runSlow(r);
    expect(r.switcher.diag().fallback).toBe('gallery');
    expect(r.failures).toEqual([{ target: 'starry-night', reason: 'stall' }]);
    fail(new Error('late'));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(r.failures).toEqual([{ target: 'starry-night', reason: 'stall' }]);
    warn.mockRestore();
  });

  test('a retry refused while a given-up build is still in flight says it is loading (F3)', async () => {
    const r = setup();
    r.gates.set('starry-night', new Promise<void>(() => {}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.switcher.go('starry-night', 'api');
    await runSlow(r);
    expect(r.failures).toEqual([{ target: 'starry-night', reason: 'stall' }]);
    expect(r.switcher.go('starry-night', 'api')).toBe(false);
    expect(r.failures).toEqual([
      { target: 'starry-night', reason: 'stall' },
      { target: 'starry-night', reason: 'loading' },
    ]);
    // Same kind, so the user sees one notice whose text is the latest.
    expect(r.notices.queue).toHaveLength(1);
    warn.mockRestore();
  });

  test('a world whose `ready` never lands is disposed, and the transition still ends (F3)', async () => {
    const r = setup();
    r.readies.set('starry-night', never());
    r.readies.set(GALLERY_ID, never());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.switcher.go('starry-night', 'api');
    await runSlow(r);
    // Each attempt gets its own timeout: the target, then the gallery, then the bare scene.
    expect(r.switcher.diag().fallback).toBe('bare');
    expect(waitS(r)).toBeGreaterThanOrEqual(2 * STALL_TIMEOUT_S);
    expect(r.switcher.active).toBe(null);
    expect(r.calls.bare).toBe(1);
    expect(r.veils.at(-1)).toBe(0);
    expect(r.calls.suppress).toBe(2);
    expect(must(r.worlds.get('starry-night')).disposed).toBe(true);
    expect(must(r.worlds.get(GALLERY_ID)).disposed).toBe(true);
    expect(r.log.filter((l) => l.startsWith('bind'))).toEqual([]);
    expect(r.scene.children).toEqual([r.rig]);
    warn.mockRestore();
  });

  test('a slow build that keeps the slicer busy is never cut short', async () => {
    const r = setup();
    let land = (): void => {};
    r.gates.set('starry-night', new Promise<void>((resolve) => (land = resolve)));
    // Work queued on the slicer: the build is progressing, however long it takes.
    let working = true;
    void r.slicer.run(
      (function* () {
        while (working) yield;
      })(),
    );
    r.switcher.go('starry-night', 'api');
    for (let i = 0; i < 2.5 * STALL_TIMEOUT_S * (1000 / SLOW_MS); i++) {
      r.switcher.frame(SLOW_MS);
      r.switcher.endFrame(1, 0.5);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(waitS(r)).toBeGreaterThan(2 * STALL_TIMEOUT_S);
    working = false;
    r.slicer.frame();
    land();
    await runSlow(r);
    expect(r.switcher.active?.id).toBe('starry-night');
    expect(r.switcher.diag().fallback).toBe(null);
  });

  test('a return whose scan never lands skips the second leg, ends, and fetches it again', async () => {
    // The gallery's prefetch never lands: the strokes cannot leave the frame (no first leg), and
    // back in the gallery the second leg waits on the same load.
    const stalled = vi.fn(() => never<Raster>());
    const r = setup({ loadRaster: stalled });
    r.switcher.go('starry-night', 'api');
    await run(r);
    expect(r.switcher.active?.id).toBe('starry-night');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(r.switcher.go(GALLERY_ID, 'return')).toBe(true);
    await runSlow(r);
    // The world is fine, so this is no fallback: the strokes skip their way in, as when the
    // second leg fails.
    expect(r.switcher.active?.id).toBe(GALLERY_ID);
    expect(r.switcher.diag().fallback).toBe(null);
    expect(r.veils.at(-1)).toBe(0);
    expect(r.calls.suppress).toBe(4);
    expect(waitS(r)).toBeGreaterThanOrEqual(STALL_TIMEOUT_S);
    expect(warn).toHaveBeenCalledWith(
      'portal: the strokes could not find their way in',
      expect.any(Error),
    );
    // The stalled load is not kept: the next trigger fetches the scan again.
    const online = vi.fn(async () => raster());
    r.loadRaster = online;
    r.switcher.go('starry-night', 'api');
    await run(r);
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(online).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
  test('one long frame after a paused loop does not give up a healthy build (F1)', async () => {
    const r = setup();
    let land = (): void => {};
    r.gates.set('starry-night', new Promise<void>((resolve) => (land = resolve)));
    r.switcher.go('starry-night', 'api');
    for (let i = 0; i < 60; i++) {
      r.switcher.frame(FRAME_MS);
      r.switcher.endFrame(1, 0.5);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // The loop was paused (the Meta button, a doff, a hidden tab): the next frame carries 20 s.
    r.switcher.frame(20_000);
    r.switcher.endFrame(1, 0.5);
    await new Promise((resolve) => setTimeout(resolve, 0));
    land();
    await run(r);
    expect(r.switcher.diag().fallback).toBe(null);
    expect(r.switcher.active?.id).toBe('starry-night');
    expect(r.switcher.diag().frames.some((f) => f.task === 'stall')).toBe(false);
  });

  test('a world given up on can be entered again once its late build fails (F2)', async () => {
    const r = setup();
    let settle = (): void => {};
    r.gates.set('starry-night', new Promise<void>((resolve) => (settle = resolve)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.switcher.go('starry-night', 'api');
    await runSlow(r);
    expect(r.switcher.diag().fallback).toBe('gallery');
    expect(r.switcher.go('starry-night', 'api')).toBe(false);
    // The bounded raster fetch gives up, so the late build rejects rather than hangs.
    r.failing.add('starry-night');
    settle();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Nothing was built, so nothing is disposed, and the gallery stays bound.
    expect(r.worlds.has('starry-night')).toBe(false);
    expect(r.switcher.active?.id).toBe(GALLERY_ID);
    // One build of it at a time again: the portal enters it.
    r.failing.delete('starry-night');
    r.gates.delete('starry-night');
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    await run(r);
    expect(r.switcher.active?.id).toBe('starry-night');
    expect(r.switcher.diag().fallback).toBe(null);
    warn.mockRestore();
  });

  test('the world import bound is below the stall watchdog, so the import fails the build first', () => {
    expect(WORLD_IMPORT_TIMEOUT_MS).toBeLessThan(STALL_TIMEOUT_S * 1000);
  });

  test('a module import that never settles fails the build before the watchdog, and the world can be entered at once (F3)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const r = setup();
      // The chunk fetch never answers.
      r.imports.set('starry-night', never());
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      r.switcher.go('starry-night', 'api');
      const frame = async (): Promise<void> => {
        r.switcher.frame(SLOW_MS);
        r.switcher.endFrame(1, 0.5);
        await vi.advanceTimersByTimeAsync(SLOW_MS);
      };
      for (let i = 0; i < 600 && r.switcher.busy; i++) await frame();
      expect(r.switcher.busy).toBe(false);
      // The plain build-failure path ran: a throw, not a stall give-up.
      expect(warn).toHaveBeenCalledWith(
        'portal: world starry-night failed to build',
        expect.objectContaining({ message: expect.stringContaining('world import timed out') }),
      );
      expect(r.switcher.diag().frames.some((f) => f.task === 'stall')).toBe(false);
      expect(r.failures).toEqual([{ target: 'starry-night', reason: 'build' }]);
      expect(waitS(r)).toBeLessThan(STALL_TIMEOUT_S);
      expect(r.switcher.diag().fallback).toBe('gallery');
      expect(r.switcher.active?.id).toBe(GALLERY_ID);
      expect(r.worlds.has('starry-night')).toBe(false);
      // No give-up refusal: the world can be entered again immediately.
      r.imports.delete('starry-night');
      expect(r.switcher.go('starry-night', 'api')).toBe(true);
      vi.useRealTimers();
      await run(r);
      expect(r.switcher.active?.id).toBe('starry-night');
      expect(r.switcher.diag().fallback).toBe(null);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a stalled scan is evicted when the first leg gives up on it (F5)', async () => {
    // The gallery's prefetch never lands.
    const stalled = vi.fn(() => never<Raster>());
    const r = setup({ loadRaster: stalled });
    let land = (): void => {};
    r.gates.set('starry-night', new Promise<void>((resolve) => (land = resolve)));
    // A long build that keeps the slicer busy, so only the first leg's wait is given up.
    let working = true;
    void r.slicer.run(
      (function* () {
        while (working) yield;
      })(),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.switcher.go('starry-night', 'api');
    for (let i = 0; i < 1.2 * STALL_TIMEOUT_S * (1000 / SLOW_MS); i++) {
      r.switcher.frame(SLOW_MS);
      r.switcher.endFrame(1, 0.5);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(r.switcher.diag().frames.some((f) => f.task === 'stall-out')).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      'portal: the strokes could not leave the frame',
      expect.any(Error),
    );
    working = false;
    r.slicer.frame();
    land();
    await runSlow(r);
    expect(r.switcher.active?.id).toBe('starry-night');
    expect(r.switcher.diag().fallback).toBe(null);
    // Not cached: back in the gallery the second leg fetches the scan afresh, and finds it.
    const online = vi.fn(async () => raster());
    r.loadRaster = online;
    r.switcher.go(GALLERY_ID, 'return');
    await run(r);
    expect(online).toHaveBeenCalled();
    expect(waitS(r)).toBeLessThan(STALL_TIMEOUT_S);
    expect(stalled).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
  test("a stalled prefetch's late settle leaves the next transition alone (fix round 2)", async () => {
    // The gallery's prefetch of the Starry Night scan stalls, then the raster bound aborts it.
    let abort = (_error: Error): void => {};
    const stalled = vi.fn(() => new Promise<Raster>((_resolve, reject) => (abort = reject)));
    const r = setup({ loadRaster: stalled });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // An entry whose build takes 10 s, under the timeout: it ends with its first leg still waiting.
    let land = (): void => {};
    r.gates.set('starry-night', new Promise<void>((resolve) => (land = resolve)));
    r.switcher.go('starry-night', 'api');
    for (let i = 0; i < 10 * (1000 / SLOW_MS); i++) {
      r.switcher.frame(SLOW_MS);
      r.switcher.endFrame(1, 0.5);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    land();
    await runSlow(r);
    expect(r.switcher.active?.id).toBe('starry-night');
    // A return whose gallery build takes 10 s too: the old wait would pass 15 s, then the abort lands.
    let back = (): void => {};
    r.gates.set(GALLERY_ID, new Promise<void>((resolve) => (back = resolve)));
    r.switcher.go(GALLERY_ID, 'return');
    const cues: (string | null)[] = [];
    for (let i = 0; i < 10 * (1000 / SLOW_MS); i++) {
      if (i === 70) abort(new Error('the raster fetch timed out'));
      r.switcher.frame(SLOW_MS);
      r.switcher.endFrame(1, 0.5);
      await new Promise((resolve) => setTimeout(resolve, 0));
      cues.push(r.switcher.diag().cue);
    }
    // The return's swirl is its own: neither the old wait's expiry nor the abort touches it.
    expect(cues.slice(1).every((cue) => cue === 'swirl')).toBe(true);
    expect(r.switcher.diag().frames.some((f) => f.task === 'stall-out')).toBe(false);
    expect(warn).not.toHaveBeenCalledWith(
      'portal: the strokes could not leave the frame',
      expect.anything(),
    );
    back();
    await runSlow(r);
    expect(r.switcher.active?.id).toBe(GALLERY_ID);
    warn.mockRestore();
  });
});

describe('revealEnd', () => {
  const chunks = (...counts: number[]) => counts.map((count) => ({ count }));

  test('reveals whole chunks up to the stroke quota a frame', () => {
    const budget = REVEAL_START_STROKES;
    const list = chunks(3000, 3000, 2000, 500, 5000);
    expect(revealEnd(list, 0)).toBe(3);
    expect(revealEnd(list, 3)).toBe(5);
    expect(revealEnd(chunks(budget, 1), 0)).toBe(1);
  });

  test('reveals one chunk over the budget alone, and stops at the last chunk', () => {
    const list = chunks(100, 40_000, 100);
    expect(revealEnd(list, 0)).toBe(1);
    expect(revealEnd(list, 1)).toBe(2);
    expect(revealEnd(list, 2)).toBe(3);
  });

  test('takes a quota of its own', () => {
    const list = chunks(1000, 1000, 1000, 1000);
    expect(revealEnd(list, 0, 2500)).toBe(2);
    expect(revealEnd(list, 0, 100_000)).toBe(4);
    expect(revealEnd(list, 1, 10)).toBe(2);
  });
});

describe('nextRevealQuota', () => {
  test('grows by at most REVEAL_GROWTH when a reveal frame costs nothing', () => {
    expect(nextRevealQuota(8192, 8000, 0)).toBe(8192 * REVEAL_GROWTH);
    expect(nextRevealQuota(8192, 8000, -0.1)).toBe(8192 * REVEAL_GROWTH);
  });

  test('aims at the budget from the measured cost per stroke', () => {
    // 8000 strokes in 2 ms: 16k fit 4 ms, the growth cap.
    expect(nextRevealQuota(8192, 8000, 2)).toBe(16_000);
    // 32,000 strokes in 6 ms: 21,333 fit 4 ms.
    expect(nextRevealQuota(32_768, 32_000, 6)).toBe(21_333);
  });

  test('falls by at most half a frame, and never below REVEAL_MIN_STROKES', () => {
    expect(nextRevealQuota(32_768, 32_000, 100)).toBe(16_384);
    expect(nextRevealQuota(8192, 8000, 100)).toBe(REVEAL_MIN_STROKES);
    expect(REVEAL_MIN_STROKES).toBe(8192);
  });

  test('prices a chunk over the quota by its own strokes', () => {
    // A 40k sector alone in 4 ms is right on budget: 40k fit, capped at ×2.
    expect(nextRevealQuota(8192, 40_000, 4)).toBe(8192 * REVEAL_GROWTH);
  });

  test('never passes the ceiling, REVEAL_MAX_STROKES by default', () => {
    expect(nextRevealQuota(65_536, 64_000, 0)).toBe(REVEAL_MAX_STROKES);
    expect(nextRevealQuota(8192, 8000, 0, 12_000)).toBe(12_000);
    // A ceiling below the floor still leaves the floor.
    expect(nextRevealQuota(8192, 8000, 0, 10)).toBe(REVEAL_MIN_STROKES);
  });
});

describe('revealCost', () => {
  test('charges the new strokes their difference over the frame before', () => {
    // The frame before drew everything else at 3 ms.
    expect(revealCost(8000, 5, 3, 0)).toBe(2);
  });

  test('never prices the new strokes below their first-frame price per stroke', () => {
    // The frame before cost the same: the steady difference is 0, the first price is 1 µs.
    expect(revealCost(4000, 4.5, 4.5, 0.001)).toBeCloseTo(4);
    expect(revealCost(4000, 4, 6, 0.0005)).toBeCloseTo(2);
  });
});
