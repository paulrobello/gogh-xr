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
import {
  type BenchResult,
  formatResultLine,
  localResultStore,
  MAX_RESULTS,
  RESULTS_STORAGE_NAME,
  type ResultStore,
  upsertResult,
} from '../src/bench/results.ts';
import { FrameStats, WARMUP_INTERVALS } from '../src/bench/stats.ts';
import {
  BUTTON_X,
  BUTTON_Y,
  buttonEdge,
  leftButtonPressed,
  leftStickX,
  stickStep,
} from '../src/bench/stick.ts';
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
  expect(p99.p95Ms()).toBe(10);
});

test('frame stats: p95 is nearest-rank over the window', () => {
  const stats = new FrameStats(100, 0);
  expect(stats.p95Ms()).toBeNull();
  const step = clock(stats);
  // 100 intervals: 94 of 11 ms and 6 of 22 ms; rank 95 lands on the first 22.
  step(11, 94);
  step(22, 6);
  expect(stats.p95Ms()).toBe(22);
  expect(new FrameStats(100, 0).p95Ms()).toBeNull();
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

test('face buttons fire once per press and read the left gamepad only', () => {
  let down = false;
  const fired: boolean[] = [];
  for (const pressed of [false, true, true, false, true]) {
    const edge = buttonEdge(down, pressed);
    down = edge.down;
    fired.push(edge.fired);
  }
  expect(fired).toEqual([false, true, false, false, true]);
  const press = (pressed: boolean) => ({
    axes: [],
    buttons: [0, 1, 2, 3, 4].map((i) => ({ pressed: pressed && i === 4 })),
  });
  expect(
    leftButtonPressed(
      [
        { handedness: 'right', gamepad: press(true) },
        { handedness: 'left', gamepad: press(false) },
      ],
      BUTTON_X,
    ),
  ).toBe(false);
  expect(leftButtonPressed([{ handedness: 'left', gamepad: press(true) }], BUTTON_X)).toBe(true);
  expect(leftButtonPressed([{ handedness: 'left', gamepad: { axes: [] } }], BUTTON_X)).toBe(false);
  expect(leftButtonPressed(null, BUTTON_X)).toBe(false);
  const y = { axes: [], buttons: [0, 1, 2, 3, 4, 5].map((i) => ({ pressed: i === 5 })) };
  expect(leftButtonPressed([{ handedness: 'left', gamepad: y }], BUTTON_Y)).toBe(true);
  expect(leftButtonPressed([{ handedness: 'left', gamepad: y }], BUTTON_X)).toBe(false);
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
  p95Ms: 11.3,
  p99Ms: 12.5,
  settling: false,
  gpuTimer: 'unavailable',
  gpuMs: null,
};

test('HUD lines show N, mode, rates and the GPU timer state', () => {
  const lines = formatHudLines(snap, { target: 90, current: 90, supported: [72, 90, 120] });
  expect(lines[0]).toBe('N 100,000  mode a2c  order random  size 24px');
  expect(lines[1]).toBe('chunks 2  instances 100,000  eye 1680x1760');
  expect(lines[2]).toBe('FPS 90  mean 11.10  p95 11.30  p99 12.50 ms');
  expect(lines[3]).toBe('target 90 Hz  current 90  supported 72/90/120');
  expect(lines[4]).toBe('GPU timer: unavailable');
  const gpu = formatHudLines(
    { ...snap, gpuTimer: 'available', gpuMs: 3.456, settling: true, viewport: null },
    { target: 90, current: null, supported: null },
  );
  expect(gpu[3]).toBe('target 90 Hz  current n/a  supported n/a');
  expect(gpu[4]).toBe('GPU 3.46 ms');
  expect(gpu[1]).toBe('chunks 2  instances 100,000  eye n/a');
  expect(gpu[2]).toBe('FPS 90  mean 11.10  p95 11.30  p99 12.50 ms  settling');
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

test('toggleMode swaps a2c and blend, resets order to the mode default, and rebuilds', () => {
  const deps = fakeDeps();
  const bench = startBench(deps, { n: 1000, mode: 'a2c', order: 'random', sizePx: 24, seed: 1 });
  if (!bench) throw new Error('bench did not start');
  benches.push(bench);
  const oldGroup = deps.scene.getObjectByName('bench-strokes');
  bench.toggleMode();
  expect(bench.snapshot()).toMatchObject({
    mode: 'blend',
    order: 'sorted',
    n: 1000,
    settling: true,
  });
  expect(oldGroup?.parent).toBeNull();
  const material = (
    deps.scene.getObjectByName('bench-chunk-0') as unknown as { material: { transparent: boolean } }
  ).material;
  expect(material.transparent).toBe(true);
  bench.toggleMode();
  expect(bench.snapshot()).toMatchObject({ mode: 'a2c', order: 'random' });
});

test('cycleFrameRate steps through supported rates, wraps, and requests each from the session', () => {
  const update = vi.fn(() => Promise.resolve());
  const deps = fakeDeps();
  const xr = { ...createXrState(), supportedFrameRates: [120, 70, 90, 80] };
  const session = { updateTargetFrameRate: update };
  const withSession: BenchDeps = {
    ...deps,
    renderer: {
      ...deps.renderer,
      xr: { isPresenting: true, getSession: () => session },
    } as unknown as BenchDeps['renderer'],
    getXrState: () => xr,
  };
  const bench = startBench(withSession, {
    n: 1000,
    mode: 'a2c',
    order: 'random',
    sizePx: 24,
    seed: 1,
  });
  if (!bench) throw new Error('bench did not start');
  benches.push(bench);
  expect(bench.targetFrameRate()).toBe(90);
  const seen: number[] = [];
  for (let i = 0; i < 4; i++) {
    bench.cycleFrameRate();
    seen.push(bench.targetFrameRate());
  }
  expect(seen).toEqual([120, 70, 80, 90]);
  expect(update.mock.calls.map((call) => (call as unknown[])[0])).toEqual([120, 70, 80, 90]);
  expect(bench.snapshot().settling).toBe(true);
});

test('cycleFrameRate keeps the target without a session or supported rates', () => {
  const bench = startBench(fakeDeps(), {
    n: 10,
    mode: 'a2c',
    order: 'random',
    sizePx: 24,
    seed: 1,
  });
  if (!bench) throw new Error('bench did not start');
  benches.push(bench);
  bench.cycleFrameRate();
  expect(bench.targetFrameRate()).toBe(90);
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

function memoryStore(initial: BenchResult[] = []): ResultStore & { saved: BenchResult[][] } {
  const saved: BenchResult[][] = [];
  let current = initial;
  return {
    saved,
    load: () => current,
    save: (results) => {
      current = [...results];
      saved.push(current);
    },
  };
}

function presentingDeps(store: ResultStore): BenchDeps & { scene: Scene } {
  const deps = fakeDeps();
  const xr = { ...createXrState(), frameRate: 90, supportedFrameRates: [70, 80, 90, 120] };
  const session = { inputSources: [], updateTargetFrameRate: () => Promise.resolve() };
  return {
    ...deps,
    renderer: {
      ...deps.renderer,
      xr: { isPresenting: true, getSession: () => session },
    } as unknown as BenchDeps['renderer'],
    getXrState: () => xr,
    results: store,
  };
}

/** Runs `frames` render callbacks 11 ms apart. */
function runFrames(scene: Scene, frames: number, clockState = { t: 0 }): void {
  const now = vi.spyOn(performance, 'now');
  for (let i = 0; i < frames; i++) {
    clockState.t += 11;
    now.mockReturnValue(clockState.t);
    (scene.onBeforeRender as unknown as () => void)();
    (scene.onAfterRender as unknown as () => void)();
  }
  now.mockRestore();
}

test('the bench records one result per settings once the window settles, and re-records on change', () => {
  const store = memoryStore();
  const deps = presentingDeps(store);
  const bench = startBench(deps, { n: 1000, mode: 'a2c', order: 'random', sizePx: 24, seed: 1 });
  if (!bench) throw new Error('bench did not start');
  benches.push(bench);
  const clockState = { t: 0 };
  runFrames(deps.scene, 100, clockState);
  expect(bench.results()).toHaveLength(0);
  runFrames(deps.scene, 500, clockState);
  expect(bench.results()).toHaveLength(1);
  expect(bench.results()[0]).toMatchObject({
    mode: 'a2c',
    n: 1000,
    targetHz: 90,
    currentHz: 90,
    p95Ms: 11,
    p99Ms: 11,
  });
  runFrames(deps.scene, 200, clockState);
  expect(store.saved).toHaveLength(1);

  bench.setCount(26000);
  runFrames(deps.scene, 600, clockState);
  bench.setCount(1000);
  runFrames(deps.scene, 600, clockState);
  expect(bench.results().map((r) => r.n)).toEqual([26000, 1000]);
  expect(store.saved).toHaveLength(3);
});

test('the bench records nothing outside XR, and starts from the stored results', () => {
  const prior: BenchResult = {
    mode: 'blend',
    order: 'sorted',
    n: 5,
    sizePx: 24,
    targetHz: 90,
    currentHz: 90,
    fps: 90,
    meanMs: 11,
    p95Ms: 11,
    p99Ms: 11,
    recordedAt: '2026-11-05T00:00:00.000Z',
  };
  const store = memoryStore([prior]);
  const deps = { ...fakeDeps(), results: store };
  const bench = startBench(deps, { n: 10, mode: 'a2c', order: 'random', sizePx: 24, seed: 1 });
  if (!bench) throw new Error('bench did not start');
  benches.push(bench);
  runFrames(deps.scene, 600);
  expect(bench.results()).toEqual([prior]);
  expect(store.saved).toHaveLength(0);
});

test('results upsert by settings, cap the list, and survive corrupt storage', () => {
  const base: BenchResult = {
    mode: 'a2c',
    order: 'random',
    n: 1,
    sizePx: 24,
    targetHz: 90,
    currentHz: 90,
    fps: 90,
    meanMs: 11,
    p95Ms: 11.25,
    p99Ms: 12.5,
    recordedAt: 'x',
  };
  const other = { ...base, targetHz: 120 };
  const replaced = upsertResult(upsertResult([base, other], { ...base, fps: 80 }), other);
  expect(replaced.map((r) => [r.targetHz, r.fps])).toEqual([
    [90, 80],
    [120, 90],
  ]);
  let many: BenchResult[] = [];
  for (let i = 0; i < MAX_RESULTS + 5; i++) many = upsertResult(many, { ...base, n: i });
  expect(many).toHaveLength(MAX_RESULTS);
  expect(many[0]?.n).toBe(5);
  expect(formatResultLine({ ...base, n: 225000, currentHz: null })).toBe(
    'a2c 225,000 90/?Hz fps 90 p95 11.25 p99 12.50',
  );

  const storage = new Map<string, string>();
  const fake = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  } as unknown as Storage;
  const store = localResultStore(fake);
  expect(store.load()).toEqual([]);
  store.save([base]);
  expect(storage.get(RESULTS_STORAGE_NAME)).toBeDefined();
  expect(store.load()).toEqual([base]);
  storage.set(RESULTS_STORAGE_NAME, '{not json');
  expect(store.load()).toEqual([]);
  storage.set(RESULTS_STORAGE_NAME, JSON.stringify([base, { mode: 1 }, null]));
  expect(store.load()).toEqual([base]);
  expect(localResultStore(undefined).load()).toEqual([]);
});
