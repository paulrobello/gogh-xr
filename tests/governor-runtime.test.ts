import { Scene } from 'three';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { buildDiagPayload, type DiagDeps } from '../src/diag/diag.ts';
import { RATE_NOTICE } from '../src/render/governor.ts';
import {
  type GovernedBatch,
  type GovernorDiag,
  type GovernorRuntime,
  type GovernorXr,
  startGovernor,
} from '../src/render/governor-runtime.ts';
import { DEFAULT_BAND_DENSITY, type StrokeBand } from '../src/render/strokes/bands.ts';
import type { StrokeBatchStats } from '../src/render/strokes/batch.ts';
import { createXrState } from '../src/xr/session.ts';

class FakeXr implements GovernorXr {
  isPresenting = false;
  readonly listeners = new Map<string, Set<() => void>>();
  readonly session = { updateTargetFrameRate: vi.fn(async (_rate: number) => undefined) };
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
    stats: (): StrokeBatchStats => {
      const near = Math.floor(visibleNear * densities.near);
      return {
        chunks: 1,
        visibleChunks: 1,
        total: visibleNear,
        visible: near,
        atlasMs: 0,
        bands: {
          near: { d: densities.near, size: sizes.near, chunks: 1, visible: near },
          mid: { d: densities.mid, size: sizes.mid, chunks: 0, visible: 0 },
          far: { d: densities.far, size: sizes.far, chunks: 0, visible: 0 },
        },
      };
    },
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

test('in XR an overrun drives batch density, viewport scale, foveation and the 72 Hz request', () => {
  const xr = new FakeXr();
  const batch = fakeBatch(200_000);
  const { runtime: rt, notify } = start(xr, batch);
  xr.isPresenting = true;
  xr.emit('sessionstart');
  expect(diagOf().fbScalePath).toBe('base-layer');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  frames(rt, 0, 20_000, 16);
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
  expect(diag).toMatchObject({ targetHz: 72, notice: RATE_NOTICE, gpuTimer: 'unavailable' });
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
  expect(diagOf()).toMatchObject({ level: 0, history: [], fbScalePath: null });
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
