/**
 * The switcher's own state machine (P5.5 review F11, F2, F3): the fly and fade paths end to end,
 * dispose before build, no trigger consumed or repeated while busy, nothing left running when idle,
 * and the failure paths, against fake worlds and a fake renderer.
 */
import {
  DataTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { describe, expect, test, vi } from 'vitest';
import type { Raster } from '../src/demo/canvas/field.ts';
import { HANGINGS } from '../src/paintings/gallery/layout.ts';
import type { WorldModule, WorldPose } from '../src/paintings/world-module.ts';
import { insidePortal, livePortals, PORTAL_DEPTH, portalOf } from '../src/portal/portal.ts';
import { createSwitcher, GALLERY_ID, type LiveWorld } from '../src/portal/switcher.ts';
import type { StrokeBatch } from '../src/render/strokes/batch.ts';
import { createSlicer } from '../src/util/slicer.ts';

const FRAME_MS = 1000 / 60;

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('missing');
  return value;
}

interface FakeWorld extends LiveWorld {
  readonly root: Group;
  readonly reveals: number[];
  disposed: boolean;
}

/** A world with one textured mesh and an empty batch, added to `scene` as a build would. */
function fakeWorld(id: string, scene: Scene, log: string[]): FakeWorld {
  const root = new Group();
  const map = new DataTexture(new Uint8Array(4), 1, 1);
  root.add(new Mesh(new PlaneGeometry(), new MeshBasicMaterial({ map })));
  scene.add(root);
  const reveals: number[] = [];
  const batch = {
    chunks: [],
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
  readonly scene: Scene;
  readonly rig: Group;
  readonly log: string[];
  readonly veils: number[];
  readonly worlds: Map<string, FakeWorld>;
  readonly uploads: Texture[];
  readonly spawns: WorldPose[];
  readonly calls: { suppress: number; bare: number; compile: number };
  /** Ids whose build throws. */
  readonly failing: Set<string>;
  loadRaster: (url: string) => Promise<Raster>;
  calm: number;
}

function setup(): Rig {
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
  const failing = new Set<string>();
  const renderer = {
    compileAsync: async () => {
      calls.compile += 1;
    },
    initTexture: (texture: Texture) => uploads.push(texture),
  } as unknown as WebGLRenderer;
  const state: { loadRaster: (url: string) => Promise<Raster>; calm: number } = {
    loadRaster: vi.fn(async (_url: string) => raster()),
    calm: 1,
  };
  const switcher = createSwitcher({
    renderer,
    scene,
    camera,
    rig,
    slicer: createSlicer(6),
    atlas: () => new DataTexture(new Uint8Array(4), 1, 1),
    build: async (id) => {
      log.push(`build ${id}`);
      await Promise.resolve();
      if (failing.has(id)) throw new Error(`no world for ${id}`);
      const world = fakeWorld(id, scene, log);
      worlds.set(id, world);
      return world;
    },
    bind: (world) => log.push(`bind ${world.id}`),
    unbind: () => log.push('unbind'),
    spawn: (pose) => spawns.push(pose),
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
    scene,
    rig,
    log,
    veils,
    worlds,
    uploads,
    spawns,
    calls,
    failing,
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

const starryPortal = portalOf(must(HANGINGS.find((h) => h.painting.id === 'starry-night')));
const standing = (pose: WorldPose): [number, number, number] => [
  pose.position[0],
  1.6,
  pose.position[2],
];

describe('createSwitcher', () => {
  test('fly: disposes the old world before building the new one, which stays hidden until ready', async () => {
    const r = setup();
    const gallery = must(r.worlds.get(GALLERY_ID));
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    expect(r.switcher.busy).toBe(true);
    expect(r.rig.children.some((c) => c.name === 'portal-fly')).toBe(true);
    let hiddenWhileWaiting = false;
    let shown = false;
    for (let i = 0; i < 600 && r.switcher.busy; i++) {
      r.switcher.frame(FRAME_MS);
      r.switcher.endFrame(1, 0.5);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const next = r.worlds.get('starry-night');
      if (next && r.uploads.length === 0 && !next.root.visible) hiddenWhileWaiting = true;
      if (next?.root.visible) shown = true;
    }
    expect(r.switcher.busy).toBe(false);
    // `go` unbinds at the trigger and again before the dispose at the end of `out`.
    expect(r.log).toEqual([
      'unbind',
      'unbind',
      'dispose gallery',
      'build starry-night',
      'bind starry-night',
    ]);
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

  test('fade (calm below 0.3): no fly strokes, and the same order in about 0.6 s', async () => {
    const r = setup();
    r.calm = 0.2;
    expect(r.switcher.go('starry-night', 'api')).toBe(true);
    expect(r.switcher.diag().style).toBe('fade');
    expect(r.rig.children.some((c) => c.name === 'portal-fly')).toBe(false);
    const frames = await run(r);
    expect(r.log).toEqual([
      'unbind',
      'unbind',
      'dispose gallery',
      'build starry-night',
      'bind starry-night',
    ]);
    // 0.3 s out and 0.3 s in, plus the wait's few frames for the build, upload and show.
    expect(frames * FRAME_MS).toBeGreaterThan(600);
    expect(frames * FRAME_MS).toBeLessThan(800);
    expect(r.loadRaster).not.toHaveBeenCalled();
    expect(r.rig.children.some((c) => c.name === 'portal-fly')).toBe(false);
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
  });

  test('a failed scan load ends the transition, and is fetched again next time (F2)', async () => {
    const r = setup();
    const offline = vi.fn(async (): Promise<Raster> => {
      throw new Error('offline');
    });
    r.loadRaster = offline;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Out of the gallery the strokes leave the frame: the first leg needs the scan.
    r.switcher.go('starry-night', 'api');
    await run(r);
    expect(r.switcher.active?.id).toBe('starry-night');
    expect(r.veils.at(-1)).toBe(0);
    // Back into the gallery they land on the frame: the second leg needs it, and fails again.
    r.switcher.go(GALLERY_ID, 'return');
    await run(r);
    expect(r.switcher.active?.id).toBe(GALLERY_ID);
    expect(r.switcher.busy).toBe(false);
    expect(r.veils.at(-1)).toBe(0);
    expect(offline).toHaveBeenCalledTimes(2);
    // Neither failure was kept: once the network is back, the next transition fetches it.
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
    expect(r.log).toEqual([
      'unbind',
      'unbind',
      'dispose gallery',
      'build starry-night',
      'build gallery',
      'bind gallery',
    ]);
    expect(r.switcher.active?.id).toBe(GALLERY_ID);
    expect(r.switcher.diag().fallback).toBe('gallery');
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
