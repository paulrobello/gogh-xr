import { PerspectiveCamera, Scene } from 'three';
import { afterEach, expect, test, vi } from 'vitest';
import { type BenchDeps, startBench } from '../src/bench/bench.ts';
import {
  GPU_WARMUP_SAMPLES,
  GpuTimer,
  TIMER_EXTENSION,
  type TimerGl,
} from '../src/bench/gpu-timer.ts';
import { type BenchSnapshot, formatHudLines } from '../src/bench/hud.ts';
import { FrameStats, WARMUP_INTERVALS } from '../src/bench/stats.ts';
import { leftStickX, stickStep } from '../src/bench/stick.ts';
import { buildDiagPayload, type DiagRenderer } from '../src/diag/diag.ts';
import { createXrState } from '../src/xr/session.ts';

test('frame stats: fps counts callbacks in the last second, p99 is nearest-rank', () => {
  const stats = new FrameStats(100, 0);
  expect(stats.meanMs()).toBeNull();
  expect(stats.p99Ms()).toBeNull();
  for (let i = 0; i <= 90; i++) stats.record(i * (1000 / 90));
  expect(stats.fps()).toBe(90);
  expect(stats.meanMs()).toBeCloseTo(1000 / 90);
  const p99 = new FrameStats(100, 0);
  let t = 0;
  for (let i = 0; i < 100; i++) {
    t += i === 50 ? 40 : 10;
    p99.record(t);
  }
  // 99 intervals: 98 of 10 ms and one of 40 ms; nearest rank 99 picks the 40.
  expect(p99.p99Ms()).toBe(40);
});

test('frame stats keep a bounded window', () => {
  const stats = new FrameStats(3, 0);
  for (const t of [0, 10, 20, 30, 70]) stats.record(t);
  expect(stats.meanMs()).toBeCloseTo((10 + 10 + 40) / 3);
});

/** Records a first stamp at 0, then returns a stepper that advances time by `dt` and records. */
function clock(stats: FrameStats): (dt: number, times?: number) => void {
  let t = 0;
  stats.record(t);
  return (dt, times = 1) => {
    for (let i = 0; i < times; i++) {
      t += dt;
      stats.record(t);
    }
  };
}

test('frame stats ignore the warm-up intervals after start and after reset', () => {
  expect(WARMUP_INTERVALS).toBe(10);
  const stats = new FrameStats(100);
  let step = clock(stats);
  step(50, WARMUP_INTERVALS);
  expect(stats.meanMs()).toBeNull();
  step(10, 5);
  expect(stats.meanMs()).toBe(10);
  stats.reset();
  step = clock(stats);
  step(80, WARMUP_INTERVALS);
  step(11);
  expect(stats.meanMs()).toBe(11);
  expect(stats.p99Ms()).toBe(11);
});

test('excluded intervals (HUD redraws) stay out of mean and p99 but count toward fps', () => {
  const stats = new FrameStats(100, 0);
  const step = clock(stats);
  step(10, 20);
  stats.exclude(2);
  step(30);
  step(25);
  step(10);
  expect(stats.meanMs()).toBe(10);
  expect(stats.p99Ms()).toBe(10);
  expect(stats.fps()).toBe(24);
});

test('settling holds until the window refills', () => {
  const stats = new FrameStats(4, 1);
  expect(stats.settling()).toBe(true);
  for (const t of [0, 10, 20, 30, 40]) stats.record(t);
  expect(stats.settling()).toBe(true);
  stats.record(50);
  expect(stats.settling()).toBe(false);
  stats.reset();
  expect(stats.settling()).toBe(true);
});

test('stick fires once per push and re-arms after recentring', () => {
  let armed = true;
  const steps: number[] = [];
  for (const x of [0, 0.5, 0.9, 1, 0.8, 0.5, 0.2, 0.95, 0, -0.75, -0.2]) {
    const r = stickStep(armed, x);
    armed = r.armed;
    steps.push(r.step);
  }
  expect(steps).toEqual([0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0]);
});

test('left stick X reads axes[2] of the left-handed gamepad only', () => {
  const sources = [
    { handedness: 'right', gamepad: { axes: [0, 0, 0.9, 0] } },
    { handedness: 'left', gamepad: { axes: [0, 0, -0.8, 0.1] } },
  ];
  expect(leftStickX(sources)).toBe(-0.8);
  expect(leftStickX([{ handedness: 'left', gamepad: null }])).toBe(0);
  expect(leftStickX(null)).toBe(0);
});

function fakeTimerGl(withExt: boolean) {
  const ext = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
  let next = 0;
  const state = { available: true, disjoint: false, active: 0, disjointReads: 0 };
  const gl = {
    QUERY_RESULT: 1,
    QUERY_RESULT_AVAILABLE: 2,
    getExtension: (name: string) => (withExt && name === TIMER_EXTENSION ? ext : null),
    getParameter: (p: number) => {
      if (p !== ext.GPU_DISJOINT_EXT) return null;
      state.disjointReads++;
      return state.disjoint;
    },
    createQuery: () => ({ id: next++ }) as unknown as WebGLQuery,
    deleteQuery: vi.fn(),
    beginQuery: vi.fn(() => {
      state.active++;
    }),
    endQuery: vi.fn(() => {
      state.active--;
    }),
    getQueryParameter: (_q: WebGLQuery, p: number) => (p === 2 ? state.available : 4_000_000),
  } satisfies TimerGl;
  return { gl, state };
}

test('gpu timer reports null when the extension is missing', () => {
  const { gl } = fakeTimerGl(false);
  const timer = new GpuTimer(gl, 0);
  timer.begin();
  timer.end();
  expect(timer.available).toBe(false);
  expect(timer.meanMs()).toBeNull();
  expect(gl.beginQuery).not.toHaveBeenCalled();
});

test('gpu timer polls results on later frames and drops disjoint ones', () => {
  const { gl, state } = fakeTimerGl(true);
  const timer = new GpuTimer(gl, 0);
  timer.begin();
  timer.end();
  expect(timer.meanMs()).toBeNull();
  timer.begin();
  timer.end();
  expect(timer.meanMs()).toBeCloseTo(4);
  state.disjoint = true;
  state.available = true;
  timer.begin();
  timer.end();
  expect(state.active).toBe(0);
  expect(timer.meanMs()).toBeCloseTo(4);
});

test('gpu timer reads GPU_DISJOINT once per poll and drops every result in a disjoint poll', () => {
  const { gl, state } = fakeTimerGl(true);
  state.available = false;
  const timer = new GpuTimer(gl, 0);
  for (let i = 0; i < 3; i++) {
    timer.begin();
    timer.end();
  }
  state.available = true;
  state.disjoint = true;
  state.disjointReads = 0;
  timer.begin();
  timer.end();
  expect(state.disjointReads).toBe(1);
  expect(timer.meanMs()).toBeNull();
  state.disjoint = false;
  timer.begin();
  timer.end();
  expect(timer.meanMs()).toBeCloseTo(4);
});

test('gpu timer does not consume GPU_DISJOINT before any result is available', () => {
  const { gl, state } = fakeTimerGl(true);
  state.available = false;
  state.disjoint = true;
  const timer = new GpuTimer(gl, 0);
  for (let i = 0; i < 3; i++) {
    timer.begin();
    timer.end();
  }
  expect(state.disjointReads).toBe(0);
  state.available = true;
  timer.begin();
  timer.end();
  expect(state.disjointReads).toBe(1);
  expect(timer.meanMs()).toBeNull();
});

test('gpu timer drops the sample of a frame marked by excludeNext', () => {
  const { gl } = fakeTimerGl(true);
  const timer = new GpuTimer(gl, 0);
  timer.excludeNext();
  timer.begin();
  timer.end();
  timer.begin();
  timer.end();
  expect(timer.meanMs()).toBeNull();
  timer.begin();
  timer.end();
  expect(timer.meanMs()).toBeCloseTo(4);
});

test('gpu timer reset clears samples and discards results still pending', () => {
  const { gl, state } = fakeTimerGl(true);
  const timer = new GpuTimer(gl, 0);
  timer.begin();
  timer.end();
  timer.begin();
  timer.end();
  expect(timer.meanMs()).toBeCloseTo(4);
  timer.reset();
  expect(timer.meanMs()).toBeNull();
  // The query begun before reset resolves now and must be dropped.
  timer.begin();
  timer.end();
  expect(timer.meanMs()).toBeNull();
  timer.begin();
  timer.end();
  expect(timer.meanMs()).toBeCloseTo(4);
  expect(state.active).toBe(0);
});

test('gpu timer discards the first completed results after construction and after reset', () => {
  const { gl } = fakeTimerGl(true);
  const timer = new GpuTimer(gl);
  const frame = () => {
    timer.begin();
    timer.end();
  };
  // Frame 1 only submits a query. Each later frame polls and consumes one result.
  frame();
  for (let i = 0; i < GPU_WARMUP_SAMPLES; i++) {
    frame();
    expect(timer.meanMs()).toBeNull();
  }
  frame();
  expect(timer.meanMs()).toBeCloseTo(4);
  timer.reset();
  expect(timer.meanMs()).toBeNull();
  // One result still in flight is dropped by reset, then the warm-up applies again.
  frame();
  for (let i = 0; i < GPU_WARMUP_SAMPLES; i++) {
    frame();
    expect(timer.meanMs()).toBeNull();
  }
  frame();
  expect(timer.meanMs()).toBeCloseTo(4);
});

test('gpu timer never exceeds its query pool while results are pending', () => {
  const { gl, state } = fakeTimerGl(true);
  state.available = false;
  const timer = new GpuTimer(gl, 0);
  for (let i = 0; i < 10; i++) {
    timer.begin();
    timer.end();
  }
  expect(gl.beginQuery).toHaveBeenCalledTimes(4);
});

const snap: BenchSnapshot = {
  n: 100000,
  mode: 'a2c',
  order: 'random',
  sizePx: 24,
  viewport: { width: 1680, height: 1760 },
  chunks: 2,
  instances: 100000,
  fps: 90,
  meanMs: 11.1,
  p99Ms: 12.5,
  settling: false,
  gpuTimer: 'unavailable',
  gpuMs: null,
};

test('HUD lines show N, mode, rates and the GPU timer state', () => {
  const lines = formatHudLines(snap, { target: 90, current: 90, supported: [72, 90, 120] });
  expect(lines[0]).toBe('N 100,000  mode a2c  order random  size 24px');
  expect(lines[1]).toBe('chunks 2  instances 100,000  eye 1680x1760');
  expect(lines[2]).toBe('FPS 90  mean 11.10 ms  p99 12.50 ms');
  expect(lines[3]).toBe('target 90 Hz  current 90  supported 72/90/120');
  expect(lines[4]).toBe('GPU timer: unavailable');
  const gpu = formatHudLines(
    { ...snap, gpuTimer: 'available', gpuMs: 3.456, settling: true, viewport: null },
    { target: 90, current: null, supported: null },
  );
  expect(gpu[3]).toBe('target 90 Hz  current n/a  supported n/a');
  expect(gpu[4]).toBe('GPU 3.46 ms');
  expect(gpu[1]).toBe('chunks 2  instances 100,000  eye n/a');
  expect(gpu[2]).toBe('FPS 90  mean 11.10 ms  p99 12.50 ms  settling');
});

const benches: { dispose(): void }[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

function fakeDeps(): BenchDeps & { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const renderer = {
    getContext: () => fakeTimerGl(false).gl,
    xr: { isPresenting: false, getSession: () => null },
  } as unknown as BenchDeps['renderer'];
  return { renderer, scene, camera, getXrState: createXrState };
}

const diagRenderer: DiagRenderer = {
  info: {
    render: { calls: 0, triangles: 0, points: 0, lines: 0, frame: 0 },
    memory: { geometries: 0, textures: 0 },
  },
  getContext: () => ({ getExtension: () => null, getParameter: () => null }),
  xr: { isPresenting: false },
};

test('startBench registers diag, and setCount disposes the old field before rebuilding', () => {
  const deps = fakeDeps();
  const bench = startBench(deps, {
    n: 100000,
    mode: 'a2c',
    order: 'random',
    sizePx: 24,
    seed: 1,
  });
  expect(bench).not.toBeNull();
  if (!bench) return;
  benches.push(bench);
  expect(deps.camera.parent).toBe(deps.scene);

  const payload = buildDiagPayload({
    build: 'test',
    renderer: diagRenderer,
    camera: deps.camera,
    getXrState: createXrState,
  });
  expect(payload.bench).toMatchObject({
    n: 100000,
    mode: 'a2c',
    order: 'random',
    chunks: 2,
    instances: 100000,
    settling: true,
    viewport: null,
    gpuTimer: 'unavailable',
    gpuMs: null,
  });

  const oldGroup = deps.scene.getObjectByName('bench-strokes');
  const oldMeshes = oldGroup?.children ?? [];
  const spies = oldMeshes.map((m) => vi.spyOn(m as unknown as { dispose(): void }, 'dispose'));
  const add = vi.spyOn(deps.scene, 'add');
  bench.setCount(125000);
  for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  // Every old mesh is disposed before the rebuilt group joins the scene.
  expect(add).toHaveBeenCalledTimes(1);
  const addedAt = add.mock.invocationCallOrder[0] ?? 0;
  for (const spy of spies)
    expect(spy.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(addedAt);
  expect(deps.scene.getObjectByName('bench-strokes')).not.toBe(oldGroup);
  expect(oldGroup?.parent).toBeNull();
  expect(bench.snapshot()).toMatchObject({ n: 125000, chunks: 2, instances: 125000 });
  bench.setCount(-10);
  expect(bench.snapshot()).toMatchObject({ n: 0, chunks: 0, instances: 0 });
});

test('dispose removes a camera the bench added, and leaves a camera it did not add', () => {
  const added = fakeDeps();
  const config = { n: 1000, mode: 'a2c', order: 'random', sizePx: 24, seed: 1 } as const;
  const bench = startBench(added, config);
  expect(added.camera.parent).toBe(added.scene);
  bench?.dispose();
  expect(added.camera.parent).toBeNull();
  expect(added.scene.getObjectByName('bench-strokes')).toBeUndefined();

  const own = fakeDeps();
  own.scene.add(own.camera);
  const second = startBench(own, config);
  second?.dispose();
  expect(own.camera.parent).toBe(own.scene);
});

test('startBench returns null without a bench config', () => {
  expect(startBench(fakeDeps())).toBeNull();
});
