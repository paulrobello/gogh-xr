import { DataTexture, PerspectiveCamera, RGBAFormat, Scene } from 'three';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GpuTimer } from '../src/bench/gpu-timer.ts';
import { buildDiagPayload, type DiagDeps } from '../src/diag/diag.ts';
import { RATE_NOTICE } from '../src/render/governor.ts';
import {
  type GovernedBatch,
  type GovernorDiag,
  type GovernorRuntime,
  type GovernorXr,
  startGovernor,
} from '../src/render/governor-runtime.ts';
import { type BoundBatch, createStrokeBinding } from '../src/render/stroke-binding.ts';
import { DEFAULT_BAND_DENSITY, type StrokeBand } from '../src/render/strokes/bands.ts';
import { createStrokeBatch } from '../src/render/strokes/batch.ts';
import { createStrokeBuffers, packInstance, STROKE_LAYER } from '../src/render/strokes/instance.ts';
import { createXrState } from '../src/xr/session.ts';

class Listeners {
  readonly map = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.map.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const listener of this.map.get(type) ?? []) listener();
  }
}

type RateBehaviour = 'resolve' | 'reject' | 'missing';

class FakeSession extends Listeners {
  frameRate: number | undefined = 90;
  visibilityState: XRVisibilityState = 'visible';
  updateTargetFrameRate?: (rate: number) => Promise<void>;
  constructor(behaviour: RateBehaviour) {
    super();
    if (behaviour === 'resolve') {
      this.updateTargetFrameRate = vi.fn(async (rate: number) => {
        this.frameRate = rate;
      });
    } else if (behaviour === 'reject') {
      this.updateTargetFrameRate = vi.fn(async () => {
        throw new DOMException('Requested frame rate not supported.', 'InvalidStateError');
      });
    }
  }
}

class FakeXr implements GovernorXr {
  isPresenting = false;
  readonly listeners = new Map<string, Set<() => void>>();
  readonly session: FakeSession;
  constructor(behaviour: RateBehaviour = 'resolve') {
    this.session = new FakeSession(behaviour);
  }
  readonly layer = { getViewport: vi.fn(() => ({ x: 0, y: 0, width: 1, height: 1 })) };
  readonly setFoveation = vi.fn();
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  getSession() {
    return this.isPresenting ? this.session : null;
  }
  getBaseLayer() {
    return this.isPresenting ? this.layer : null;
  }
  getBinding() {
    return null;
  }
}

function fakeBatch(visibleNear: number): GovernedBatch & {
  densities: Record<StrokeBand, number>;
  sizes: Record<StrokeBand, number>;
} {
  const densities = { ...DEFAULT_BAND_DENSITY };
  const sizes = { near: 1, mid: 1, far: 1 };
  return {
    densities,
    sizes,
    setDensity: (band, d) => {
      densities[band] = d;
    },
    setSizeMultiplier: (band, m) => {
      sizes[band] = m;
    },
    visibleByBand: () => ({ near: Math.floor(visibleNear * densities.near), mid: 0, far: 0 }),
  };
}

const noTimer = { getContext: () => ({ getExtension: () => null }) };

let runtime: GovernorRuntime | null = null;
beforeEach(() => {
  vi.stubGlobal(
    'XRView',
    class {
      requestViewportScale(_scale: number): void {}
    },
  );
});
afterEach(() => {
  runtime?.dispose();
  runtime = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function start(xr: FakeXr, batch: GovernedBatch, notify = vi.fn()) {
  const scene = new Scene();
  runtime = startGovernor({
    renderer: { xr, ...noTimer },
    scene,
    batch,
    mode: 'default',
    targetHz: 90,
    notify,
  });
  return { runtime, scene, notify };
}

function frames(rt: GovernorRuntime, from: number, ms: number, interval: number): number {
  let t = from;
  while (t < from + ms) {
    t += interval;
    rt.frame(t);
  }
  return t;
}

function diagOf(): GovernorDiag {
  const deps = {
    build: 'test',
    renderer: {
      info: {
        render: { calls: 0, triangles: 0, points: 0, lines: 0, frame: 0 },
        memory: { geometries: 0, textures: 0 },
      },
      getContext: () => ({ getExtension: () => null, getParameter: () => null }),
      xr: { isPresenting: true },
    },
    camera: { position: { toArray: () => [0, 0, 0] }, quaternion: { toArray: () => [0, 0, 0, 1] } },
    getXrState: createXrState,
  } satisfies DiagDeps;
  return buildDiagPayload(deps).governor as GovernorDiag;
}

test('desktop frames are not judged: a slow page sheds nothing', () => {
  const xr = new FakeXr();
  const batch = fakeBatch(200_000);
  const { runtime: rt } = start(xr, batch);
  frames(rt, 0, 10_000, 16.7);
  expect(diagOf().history).toEqual([]);
  expect(batch.densities.near).toBe(1);
});

/** Enters XR and runs overrun frames to the 72 Hz request, then lets its promise settle. */
async function toRateRequest(xr: FakeXr, batch = fakeBatch(200_000)) {
  const started = start(xr, batch);
  xr.isPresenting = true;
  xr.emit('sessionstart');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  let t = 0;
  while (!diagOf().history.some((e) => e.action === 'rate') && t < 20_000) {
    t = frames(started.runtime, t, 16, 16);
  }
  await Promise.resolve();
  await Promise.resolve();
  return { ...started, batch, t };
}

test('in XR an overrun drives batch density, viewport scale, foveation and the 72 Hz request', async () => {
  const xr = new FakeXr();
  const { batch, notify } = await toRateRequest(xr);
  expect(diagOf().fbScalePath).toBe('base-layer');
  const diag = diagOf();
  expect(diag.history.map((e) => `${e.action} ${e.step}`)).toEqual([
    'shed near-density',
    'shed fb-scale',
    'shed foveation',
    'rate frame-rate',
  ]);
  expect(batch.densities.near).toBeCloseTo(0.75, 10);
  expect(batch.sizes.near).toBeCloseTo(Math.sqrt(1 / 0.75), 10);
  expect(diag.fbScale).toBe(0.85);
  const view = { requestViewportScale: vi.fn() };
  (xr.layer.getViewport as (v: unknown) => unknown)(view);
  expect(view.requestViewportScale).toHaveBeenCalledWith(0.85);
  expect(xr.setFoveation).toHaveBeenLastCalledWith(0.5);
  expect(xr.session.updateTargetFrameRate).toHaveBeenCalledWith(72);
  expect(notify).toHaveBeenCalledWith(RATE_NOTICE);
  expect(diag).toMatchObject({
    targetHz: 72,
    frameRate: 72,
    rateRequest: 'applied',
    notice: RATE_NOTICE,
    gpuTimer: 'unavailable',
  });
  expect(diag.budgetMs).toBeCloseTo(1000 / 72, 10);
});

test('fbScaleApplied reports the measured width ratio, not the requested scale', () => {
  const xr = new FakeXr();
  // The fake layer ignores the request: its width stays 1 at any scale.
  const query = () =>
    (xr.layer.getViewport as (v: unknown) => unknown)({ requestViewportScale() {} });
  const { runtime: rt } = start(xr, fakeBatch(200_000));
  expect(diagOf().fbScaleApplied).toBeNull();
  xr.isPresenting = true;
  xr.emit('sessionstart');
  expect(diagOf().fbScaleApplied).toBeNull();
  query();
  expect(diagOf()).toMatchObject({ fbScale: 1, fbScaleApplied: 1 });
  let t = 0;
  while (!diagOf().history.some((e) => e.step === 'fb-scale') && t < 20_000) {
    t = frames(rt, t, 16, 16);
  }
  query();
  // The governor still counts the step as taken.
  expect(diagOf()).toMatchObject({ fbScale: 0.85, fbScaleApplied: 1, step: 'fb-scale' });
});

test.each(['reject', 'missing'] as const)(
  'a %s updateTargetFrameRate leaves 90 Hz: rate unavailable, exhausted, no notice',
  async (behaviour) => {
    const xr = new FakeXr(behaviour);
    const { runtime: rt, notify, t } = await toRateRequest(xr);
    frames(rt, t, 3000, 16);
    const diag = diagOf();
    expect(diag.history.map((e) => e.action).slice(-2)).toEqual(['rate', 'rate-failed']);
    expect(diag).toMatchObject({
      targetHz: 90,
      frameRate: 90,
      rateRequest: 'unavailable',
      notice: null,
      exhausted: true,
    });
    expect(diag.budgetMs).toBeCloseTo(1000 / 90, 10);
    expect(notify).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/72 Hz fallback unavailable/));
  },
);

test('the budget follows the session frame rate, falling back to the request when unreported', () => {
  const xr = new FakeXr();
  const { runtime: rt } = start(xr, fakeBatch(200_000));
  xr.isPresenting = true;
  xr.emit('sessionstart');
  // The initial 90 Hz request failed and the headset runs at 72.
  xr.session.frameRate = 72;
  xr.session.emit('frameratechange');
  expect(diagOf()).toMatchObject({ targetHz: 90, frameRate: 72 });
  // 13 ms frames overrun 90 Hz but fit 72.
  frames(rt, 0, 10_000, 13);
  expect(diagOf().history).toEqual([]);
  xr.session.frameRate = undefined;
  frames(rt, 10_000, 16, 16);
  expect(diagOf().frameRate).toBe(90);
});

test('frames are not judged while the session is hidden, and a pause restarts the timers', () => {
  const xr = new FakeXr();
  const { runtime: rt } = start(xr, fakeBatch(100_000));
  xr.isPresenting = true;
  xr.emit('sessionstart');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  // 100k near is under the floor: fb-scale and foveation shed, then the 3 s rate count runs.
  let t = 0;
  while (!diagOf().history.some((e) => e.step === 'foveation')) t = frames(rt, t, 16, 16);
  t = frames(rt, t, 2000, 16);
  xr.session.visibilityState = 'visible-blurred';
  xr.session.emit('visibilitychange');
  t = frames(rt, t, 5000, 16);
  expect(diagOf().history.some((e) => e.action === 'rate')).toBe(false);
  xr.session.visibilityState = 'visible';
  xr.session.emit('visibilitychange');
  const resume = t;
  while (!diagOf().history.some((e) => e.action === 'rate') && t < resume + 10_000) {
    t = frames(rt, t, 16, 16);
  }
  const rate = diagOf().history.find((e) => e.action === 'rate');
  expect((rate?.t ?? 0) - resume).toBeGreaterThanOrEqual(3000);
});

test('a new session starts from full quality again', () => {
  const xr = new FakeXr();
  const batch = fakeBatch(400_000);
  const { runtime: rt } = start(xr, batch);
  xr.isPresenting = true;
  xr.emit('sessionstart');
  frames(rt, 0, 3000, 16);
  expect(batch.densities.near).toBeLessThan(1);
  xr.isPresenting = false;
  xr.emit('sessionend');
  expect(batch.densities.near).toBe(1);
  expect(diagOf()).toMatchObject({
    level: 0,
    history: [],
    fbScalePath: null,
    fbScaleApplied: null,
  });
});

test('dispose unregisters the diag key and unwraps the layer', () => {
  const xr = new FakeXr();
  const original = xr.layer.getViewport;
  const { runtime: rt } = start(xr, fakeBatch(200_000));
  xr.isPresenting = true;
  xr.emit('sessionstart');
  expect(xr.layer.getViewport).not.toBe(original);
  rt.dispose();
  runtime = null;
  expect(xr.layer.getViewport).toBe(original);
  expect(diagOf()).toBeUndefined();
});

describe('scene render hooks (M1)', () => {
  function realBatch() {
    const buffers = createStrokeBuffers(8);
    for (let i = 0; i < 8; i++) {
      packInstance(buffers, i, {
        position: [0.5, 1.6, -1 - i],
        normal: [0, 0, 1],
        tangent: 0,
        color: [200, 180, 40, 255],
        size: [0.2, 0.1],
        brush: i % 16,
        layer: STROKE_LAYER.sky,
        phase: 0,
      });
    }
    return createStrokeBatch(buffers, {
      cellSize: 4,
      createAtlas: () => new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat),
    });
  }

  /** The batch culls, then the governor times the GPU, on one scene, both hooks chained. */
  function setup() {
    const scene = new Scene();
    const before = vi.fn();
    const after = vi.fn();
    scene.onBeforeRender = before;
    scene.onAfterRender = after;
    const batch = realBatch();
    batch.attach(scene);
    const xr = new FakeXr();
    xr.isPresenting = true;
    const rt = startGovernor({
      renderer: { xr, ...noTimer },
      scene,
      batch,
      mode: 'default',
      targetHz: 90,
    });
    xr.emit('sessionstart');
    const update = vi.spyOn(batch, 'update');
    const begin = vi.spyOn(GpuTimer.prototype, 'begin');
    const end = vi.spyOn(GpuTimer.prototype, 'end');
    const camera = new PerspectiveCamera(70, 1, 0.05, 100);
    camera.updateMatrixWorld();
    const args = [{}, scene, camera, null] as unknown as Parameters<Scene['onBeforeRender']>;
    const render = (): void => {
      scene.onBeforeRender(...args);
      scene.onAfterRender(...args);
    };
    const calls = () => ({
      before: before.mock.calls.length,
      after: after.mock.calls.length,
      update: update.mock.calls.length,
      begin: begin.mock.calls.length,
      end: end.mock.calls.length,
    });
    const clear = (): void => {
      for (const spy of [before, after, update, begin, end]) spy.mockClear();
    };
    return { scene, batch, rt, render, calls, clear, before, after };
  }

  test('both run while attached', () => {
    const { batch, rt, render, calls } = setup();
    render();
    expect(calls()).toEqual({ before: 1, after: 1, update: 1, begin: 1, end: 1 });
    rt.dispose();
    batch.dispose();
  });

  test('batch disposed first: the governor keeps its hooks, then the scene gets its own back', () => {
    const { scene, batch, rt, render, calls, clear, before, after } = setup();
    batch.dispose();
    render();
    expect(calls()).toEqual({ before: 1, after: 1, update: 0, begin: 1, end: 1 });
    clear();
    rt.dispose();
    render();
    expect(calls()).toEqual({ before: 1, after: 1, update: 0, begin: 0, end: 0 });
    expect(scene.onBeforeRender).toBe(before);
    expect(scene.onAfterRender).toBe(after);
  });

  test('governor disposed first: the batch keeps culling, then the scene gets its own back', () => {
    const { scene, batch, rt, render, calls, clear, before, after } = setup();
    rt.dispose();
    render();
    expect(calls()).toEqual({ before: 1, after: 1, update: 1, begin: 0, end: 0 });
    clear();
    batch.dispose();
    render();
    expect(calls()).toEqual({ before: 1, after: 1, update: 0, begin: 0, end: 0 });
    expect(scene.onBeforeRender).toBe(before);
    expect(scene.onAfterRender).toBe(after);
  });
});

test('a rate request that settles after dispose neither notifies nor touches the new owner', async () => {
  const xr = new FakeXr();
  const batch = fakeBatch(200_000);
  const { runtime: rt, notify } = start(xr, batch);
  xr.isPresenting = true;
  xr.emit('sessionstart');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  let t = 0;
  while (!diagOf().history.some((e) => e.action === 'rate') && t < 20_000) {
    t = frames(rt, t, 16, 16);
  }
  expect(xr.session.updateTargetFrameRate).toHaveBeenCalledWith(72);
  rt.dispose();
  runtime = null;
  await Promise.resolve();
  await Promise.resolve();
  expect(notify).not.toHaveBeenCalled();
});

describe('stroke binding (M2)', () => {
  /** A fake batch whose methods throw once it is disposed, with call counts per method. */
  function countedBatch(visibleNear: number) {
    const inner = fakeBatch(visibleNear);
    let disposed = false;
    const counts = { setDensity: 0, setSizeMultiplier: 0, visibleByBand: 0, visibleCount: 0 };
    const guard = (name: keyof typeof counts): void => {
      if (disposed) throw new Error(`${name} on a disposed batch`);
      counts[name]++;
    };
    const batch: BoundBatch = {
      setDensity: (band, d) => {
        guard('setDensity');
        inner.setDensity(band, d);
      },
      setSizeMultiplier: (band, m) => {
        guard('setSizeMultiplier');
        inner.setSizeMultiplier(band, m);
      },
      visibleByBand: () => {
        guard('visibleByBand');
        return inner.visibleByBand();
      },
      visibleCount: () => {
        guard('visibleCount');
        return inner.visibleByBand().near;
      },
    };
    return {
      batch,
      inner,
      counts,
      dispose: () => {
        disposed = true;
      },
    };
  }

  function binding(xr: FakeXr, governs = true) {
    const scene = new Scene();
    const started: BoundBatch[] = [];
    const strokes = createStrokeBinding({
      loadGovernor: governs
        ? async () => (batch) => {
            started.push(batch as BoundBatch);
            return startGovernor({
              renderer: { xr, ...noTimer },
              scene,
              batch,
              mode: 'default',
              targetHz: 90,
            });
          }
        : null,
    });
    return { strokes, started };
  }

  function drive(strokes: { frame(t: number): void }, from: number, ms: number): number {
    let t = from;
    while (t < from + ms) {
      t += 16;
      strokes.frame(t);
    }
    return t;
  }

  test('after a swap the governor and HUD count drive the new batch, never the disposed one', async () => {
    const xr = new FakeXr();
    const { strokes, started } = binding(xr);
    const a = countedBatch(400_000);
    const b = countedBatch(300_000);
    await strokes.bind(a.batch);
    expect(strokes.batch).toBe(a.batch);
    xr.isPresenting = true;
    xr.emit('sessionstart');
    let t = drive(strokes, 0, 3000);
    expect(a.inner.densities.near).toBeLessThan(1);
    expect(strokes.visibleCount()).toBe(a.batch.visibleCount());

    await strokes.bind(b.batch);
    a.dispose();
    const frozen = { ...a.counts };
    expect(strokes.batch).toBe(b.batch);
    expect(started).toEqual([a.batch, b.batch]);
    // A new world starts from full quality, and the diag key belongs to the new governor.
    expect(b.inner.densities.near).toBe(1);
    expect(diagOf()).toMatchObject({ level: 0, history: [] });

    t = drive(strokes, t, 3000);
    expect(b.inner.densities.near).toBeLessThan(1);
    expect(b.counts.visibleByBand).toBeGreaterThan(0);
    expect(strokes.visibleCount()).toBe(b.batch.visibleCount());
    expect(strokes.governorDiag()?.level).toBeGreaterThan(0);
    expect(a.counts).toEqual(frozen);

    await strokes.bind(null);
    expect(strokes.batch).toBeNull();
    expect(strokes.visibleCount()).toBeNull();
    expect(strokes.governorDiag()).toBeNull();
    expect(diagOf()).toBeUndefined();
    drive(strokes, t, 1000);
    expect(a.counts).toEqual(frozen);
  });

  test('a swap while the governor module loads starts one governor, on the newest batch', async () => {
    const xr = new FakeXr();
    const { strokes, started } = binding(xr);
    const a = countedBatch(400_000);
    const b = countedBatch(300_000);
    const first = strokes.bind(a.batch);
    const second = strokes.bind(b.batch);
    await Promise.all([first, second]);
    expect(started).toEqual([b.batch]);
    expect(a.counts).toEqual({
      setDensity: 0,
      setSizeMultiplier: 0,
      visibleByBand: 0,
      visibleCount: 0,
    });
    await strokes.bind(null);
  });

  test('without a governor the HUD source still rebinds', async () => {
    const xr = new FakeXr();
    const { strokes, started } = binding(xr, false);
    const a = countedBatch(400_000);
    const b = countedBatch(300_000);
    await strokes.bind(a.batch);
    expect(strokes.visibleCount()).toBe(400_000);
    await strokes.bind(b.batch);
    a.dispose();
    expect(strokes.visibleCount()).toBe(300_000);
    expect(strokes.governorDiag()).toBeNull();
    expect(started).toEqual([]);
  });
});
