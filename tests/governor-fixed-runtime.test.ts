/**
 * The runtime side of the fixed quality level (2026-11-08): `deps.fixedLevel` is read every frame,
 * in XR and on the desktop, a change applies at once, and Auto rebuilds the adaptive machine.
 */
import { Scene } from 'three';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MIN_BAND_DENSITY, qualityLadder } from '../src/render/governor.ts';
import {
  type GovernedBatch,
  type GovernorRuntime,
  type GovernorXr,
  startGovernor,
} from '../src/render/governor-runtime.ts';
import { createStrokeBinding } from '../src/render/stroke-binding.ts';
import { DEFAULT_BAND_DENSITY, type StrokeBand } from '../src/render/strokes/bands.ts';
import { DEFAULT_SETTINGS, governorModeOf, type Settings } from '../src/settings/schema.ts';
import { createSettingsStore } from '../src/settings/store.ts';
import { qualityLevelLabel } from '../src/ui/panel-layout.ts';
import { createSettingsDom } from '../src/ui/settings-dom.ts';

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

class FakeSession extends Listeners {
  frameRate: number | undefined = 90;
  visibilityState: XRVisibilityState = 'visible';
  readonly updateTargetFrameRate = vi.fn(async (rate: number) => {
    this.frameRate = rate;
  });
}

class FakeXr extends Listeners implements GovernorXr {
  isPresenting = false;
  readonly session = new FakeSession();
  readonly layer = { getViewport: vi.fn(() => ({ x: 0, y: 0, width: 1, height: 1 })) };
  foveation = 0;
  readonly setFoveation = vi.fn((value: number) => {
    this.foveation = value;
  });
  getFoveation() {
    return this.isPresenting ? this.foveation : undefined;
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

function fakeBatch() {
  const densities: Record<StrokeBand, number> = { ...DEFAULT_BAND_DENSITY };
  const batch: GovernedBatch = {
    setDensity: (band, d) => {
      densities[band] = d;
    },
    setSizeMultiplier: () => {},
    visibleByBand: () => ({
      near: Math.floor(1_000_000 * densities.near),
      mid: Math.floor(3_000_000 * densities.mid),
      far: Math.floor(1_000_000 * densities.far),
    }),
  };
  return { batch, densities };
}

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
});

function start(level: { value: number | null }, targetHz = 90) {
  const xr = new FakeXr();
  const { batch, densities } = fakeBatch();
  const notify = vi.fn();
  runtime = startGovernor({
    renderer: { xr, getContext: () => ({ getExtension: () => null }) },
    scene: new Scene(),
    batch,
    mode: 'default',
    targetHz,
    notify,
    get fixedLevel() {
      return level.value;
    },
  });
  return { rt: runtime, xr, densities, notify };
}

function frames(rt: GovernorRuntime, from: number, ms: number, interval: () => number): number {
  let t = from;
  while (t < from + ms) {
    t += interval();
    rt.frame(t);
  }
  return t;
}

const LADDER = qualityLadder('default');

test('on the desktop a fixed level applies on the next frame, and the diag reports it', () => {
  const level = { value: null as number | null };
  const { rt, xr, densities } = start(level);
  expect(rt.diag()).toMatchObject({ fixedLevel: null, level: 0, judging: false });
  level.value = 3;
  rt.frame(16);
  expect(rt.diag()).toMatchObject({ fixedLevel: 3, level: 3, foveation: 1, fbScale: 0.85 });
  expect(xr.setFoveation).toHaveBeenLastCalledWith(1);
  expect(densities).toEqual(DEFAULT_BAND_DENSITY);
  level.value = 16;
  rt.frame(32);
  expect(densities).toEqual(MIN_BAND_DENSITY);
  expect(rt.diag().history).toEqual([]);
});

test('in XR a fixed level never judges: an overrun sheds nothing and asks no rate', () => {
  const level = { value: 2 as number | null };
  const { rt, xr, densities, notify } = start(level);
  xr.isPresenting = true;
  xr.emit('sessionstart');
  // The session start rebuilds the machine at the fixed level.
  expect(rt.diag()).toMatchObject({ fixedLevel: 2, foveation: 0.5, judging: true });
  // A late foveation 0 from the session start is re-asserted on the next judged frame.
  xr.foveation = 0;
  frames(rt, 0, 60_000, () => 40);
  expect(xr.foveation).toBe(0.5);
  const diag = rt.diag();
  expect(diag.history).toEqual([]);
  expect(diag).toMatchObject({ rateRequest: 'none', level: 2, notice: null, targetHz: 90 });
  expect(xr.session.updateTargetFrameRate).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(densities).toEqual(DEFAULT_BAND_DENSITY);
  // A session end keeps the level too.
  xr.isPresenting = false;
  xr.emit('sessionend');
  expect(rt.diag()).toMatchObject({ fixedLevel: 2, foveation: 0.5 });
});

test('back to Auto rebuilds the adaptive machine from the start levels, then it sheds again', () => {
  const level = { value: 9 as number | null };
  const { rt, xr, densities } = start(level);
  xr.isPresenting = true;
  xr.emit('sessionstart');
  let t = frames(rt, 0, 2000, () => 40);
  expect(densities.far).toBe(MIN_BAND_DENSITY.far);
  expect(rt.diag().fixedLevel).toBe(9);
  level.value = null;
  t += 40;
  rt.frame(t);
  expect(rt.diag()).toMatchObject({ fixedLevel: null, level: 0, foveation: 0, history: [] });
  expect(densities).toEqual(DEFAULT_BAND_DENSITY);
  // The adaptive machine judges again: the overrun sheds the first step after its warm-up.
  t = frames(rt, t, 3000, () => 40);
  expect(rt.diag().history[0]).toMatchObject({ action: 'shed', step: LADDER[0]?.step });
  // And pinning a level again drops that machine's history at once.
  level.value = 1;
  rt.frame(t + 40);
  expect(rt.diag()).toMatchObject({ fixedLevel: 1, level: 1, history: [] });
});

test('back to Auto after a 72 Hz fallback keeps the 72 Hz the session runs at, asking no rate', async () => {
  const level = { value: null as number | null };
  const { rt, xr, notify } = start(level, 90);
  xr.isPresenting = true;
  xr.emit('sessionstart');
  // Overrun 90 Hz until the machine sheds everything and falls back to 72.
  let t = 0;
  for (let i = 0; i < 400 && rt.diag().rateRequest !== 'applied'; i++) {
    t = frames(rt, t, 1000, () => 40);
    await Promise.resolve();
  }
  expect(rt.diag()).toMatchObject({ rateRequest: 'applied', targetHz: 72 });
  expect(xr.session.updateTargetFrameRate).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledTimes(1);
  level.value = 3;
  t += 40;
  rt.frame(t);
  expect(rt.diag()).toMatchObject({ fixedLevel: 3, targetHz: 72 });
  level.value = null;
  t += 40;
  rt.frame(t);
  // Auto is a fresh machine, but on the rate the session already runs, not the quality's 90.
  expect(rt.diag()).toMatchObject({ fixedLevel: null, level: 0, targetHz: 72, history: [] });
  frames(rt, t, 5000, () => 1000 / 72);
  await Promise.resolve();
  expect(xr.session.updateTargetFrameRate).toHaveBeenCalledTimes(1);
});

test('the panel row and the governor agree on the ladder through a mid-session quality change', async () => {
  const settings = createSettingsStore({
    stored: { ...DEFAULT_SETTINGS, quality: 'beauty-72', qualityLevel: 18 } as Settings,
    flags: { beauty: false, hz: null, seated: null, turn: null, hud: null, calm: null },
    save: () => true,
    schedule: () => 0,
    cancel: () => {},
  });
  const xr = new FakeXr();
  const boundBatch = () => ({
    ...fakeBatch().batch,
    visibleCount: () => 0,
    visibleChunkCount: () => 0,
  });
  const binding = createStrokeBinding({
    loadGovernor: async () => (batch) =>
      startGovernor({
        renderer: { xr, getContext: () => ({ getExtension: () => null }) },
        scene: new Scene(),
        batch,
        get mode() {
          return governorModeOf(settings.effective.quality);
        },
        targetHz: 72,
        get fixedLevel() {
          const value = settings.effective.qualityLevel;
          return value === 'auto' ? null : value;
        },
      }),
  });
  await binding.bind(boundBatch());
  const dom = createSettingsDom({
    store: settings,
    recenter: () => {},
    gallery: () => null,
    // The quality the session started with: the governor can run another one after a rebind.
    sessionQuality: () => 'beauty-72',
    governorMode: () => binding.governorMode(),
    hud: { visible: () => false, setVisible: () => {} },
    onClose: () => {},
  });
  const row = dom.element.querySelector('[data-control="qualityLevel"]');
  const input = row?.querySelector<HTMLInputElement>('input[type=range]');
  if (!row || !input) throw new Error('no quality level row');
  const agree = (mode: 'default' | 'beauty', shown: number) => {
    dom.setOpen(true);
    const diag = binding.governorDiag();
    expect(diag?.mode).toBe(mode);
    expect(input.max).toBe(String(qualityLadder(mode).length));
    expect(diag?.level).toBe(shown);
    expect(input.value).toBe(String(shown));
    expect(row.querySelector('.value')?.textContent).toBe(qualityLevelLabel(18, mode));
  };
  try {
    agree('beauty', 18);
    xr.isPresenting = true;
    xr.emit('sessionstart');
    // A quality change in XR applies at the next entry: the running governor keeps beauty.
    settings.set('quality', 'adaptive-72');
    agree('beauty', 18);
    // The session end re-reads the live quality; the row follows the governor, not the session's.
    xr.isPresenting = false;
    xr.emit('sessionend');
    agree('default', 16);
    // A rebind (a portal) picks up a changed quality too, and so does the row.
    settings.set('quality', 'beauty-72');
    agree('default', 16);
    await binding.bind(boundBatch());
    agree('beauty', 18);
    // The stored beauty 18 survived the adaptive stretch.
    expect(settings.effective.qualityLevel).toBe(18);
  } finally {
    dom.dispose();
    await binding.bind(null);
  }
});

test('a level change while the 72 Hz request is in flight still takes the rate and its notice', async () => {
  const level = { value: null as number | null };
  const { rt, xr, notify } = start(level, 90);
  let resolve = (): void => {};
  xr.session.updateTargetFrameRate.mockImplementationOnce(
    (rate: number) =>
      new Promise<void>((done) => {
        resolve = () => {
          xr.session.frameRate = rate;
          done();
        };
      }),
  );
  xr.isPresenting = true;
  xr.emit('sessionstart');
  let t = 0;
  for (let i = 0; i < 400 && xr.session.updateTargetFrameRate.mock.calls.length === 0; i++) {
    t = frames(rt, t, 1000, () => 40);
  }
  expect(xr.session.updateTargetFrameRate).toHaveBeenCalledTimes(1);
  level.value = 2;
  t += 40;
  rt.frame(t);
  resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(notify).toHaveBeenCalledTimes(1);
  // The machine running now, built at the level change while 90 was asked, budgets 72 too.
  expect(rt.diag()).toMatchObject({ fixedLevel: 2, targetHz: 72 });
  level.value = null;
  rt.frame(t + 40);
  expect(rt.diag()).toMatchObject({ fixedLevel: null, targetHz: 72 });
});
