/**
 * The foveation setting (2026-11-10): 'auto' or a pin of 0, 0.5 or 1 that wins over the quality
 * level's foveation steps, `?fov` over it, live apply, the governor keeping the pin, and the row.
 */
import { Scene } from 'three';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createGovernor, type GovernorEvent, qualityLadder } from '../src/render/governor.ts';
import {
  type GovernedBatch,
  type GovernorRuntime,
  type GovernorXr,
  startGovernor,
} from '../src/render/governor-runtime.ts';
import { DEFAULT_BAND_DENSITY, type StrokeBand } from '../src/render/strokes/bands.ts';
import { applySettingsChange } from '../src/settings/apply.ts';
import {
  applyUrlFlags,
  DEFAULT_SETTINGS,
  foveationPin,
  loadSettings,
  lockedSettings,
  parseSettings,
  SETTINGS_VERSION,
  type SettingsFlags,
  type SettingsStorage,
  sanitizeSettings,
  saveSettings,
} from '../src/settings/schema.ts';
import { createSettingsStore } from '../src/settings/store.ts';
import {
  CONTROLS,
  controlLayout,
  controlRect,
  formatValue,
  hitControl,
  LAYOUT,
  lockedHelp,
  MIN_TARGET,
  PANEL_H,
  PANEL_W,
  qualityLevelLabel,
  qualityLevelSummary,
} from '../src/ui/panel-layout.ts';
import { createSettingsDom } from '../src/ui/settings-dom.ts';

const FLAGS: SettingsFlags = {
  beauty: false,
  hz: null,
  seated: null,
  turn: null,
  hud: null,
  calm: null,
};

function store(flags: SettingsFlags = FLAGS) {
  return createSettingsStore({
    stored: DEFAULT_SETTINGS,
    flags,
    save: () => true,
    schedule: () => 0,
    cancel: () => {},
  });
}

function memoryStorage(): SettingsStorage & { text: string | null } {
  return {
    text: null,
    getItem() {
      return this.text;
    },
    setItem(_key, value) {
      this.text = value;
    },
  };
}

describe('the foveation setting', () => {
  test('defaults to Off (a pinned 0), and anything outside the set sanitizes to 0', () => {
    expect(DEFAULT_SETTINGS.foveation).toBe(0);
    expect(sanitizeSettings({}).foveation).toBe(0);
    for (const value of ['auto', 0, 0.5, 1] as const) {
      expect(sanitizeSettings({ foveation: value }).foveation).toBe(value);
    }
    for (const value of [0.25, 2, -1, '0.5', 'off', null, Number.NaN, true]) {
      expect(sanitizeSettings({ foveation: value }).foveation).toBe(0);
    }
    expect(foveationPin(DEFAULT_SETTINGS)).toBe(0);
    expect(foveationPin({ foveation: 'auto' })).toBeNull();
    expect(foveationPin({ foveation: 0 })).toBe(0);
    expect(foveationPin({ foveation: 1 })).toBe(1);
  });

  test('v3 to v4: a stored auto, the old default, becomes Off once; a pin and a v4 auto are kept', () => {
    expect(SETTINGS_VERSION).toBe(4);
    const loaded = parseSettings(JSON.stringify({ version: 3, settings: { calm: 0.4 } }));
    expect(loaded).toMatchObject({ settings: { calm: 0.4, foveation: 0 }, recovered: null });
    const migrated = parseSettings(
      JSON.stringify({ version: 3, settings: { calm: 0.4, foveation: 'auto' } }),
    );
    expect(migrated).toMatchObject({ settings: { calm: 0.4, foveation: 0 }, recovered: null });
    for (const foveation of [0.5, 1] as const) {
      const kept = parseSettings(JSON.stringify({ version: 3, settings: { foveation } }));
      expect(kept.settings.foveation).toBe(foveation);
    }
    const chosen = parseSettings(JSON.stringify({ version: 4, settings: { foveation: 'auto' } }));
    expect(chosen.settings.foveation).toBe('auto');
    for (const foveation of ['auto', 0, 0.5, 1] as const) {
      const storage = memoryStorage();
      expect(saveSettings({ ...DEFAULT_SETTINGS, foveation }, storage)).toBe(true);
      expect(loadSettings(storage).settings.foveation).toBe(foveation);
    }
  });

  test('?fov overrides it for the session, locks it, and is never written back', () => {
    expect(lockedSettings(FLAGS).foveation).toBeUndefined();
    expect(lockedSettings({ ...FLAGS, fov: null }).foveation).toBeUndefined();
    expect(lockedSettings({ ...FLAGS, fov: 0 }).foveation).toBe('?fov=0');
    expect(lockedSettings({ ...FLAGS, fov: 0.5 }).foveation).toBe('?fov=0.5');
    expect(lockedHelp('?fov=0.5')).toBe('Set by ?fov=0.5 for this session');
    const stored = { ...DEFAULT_SETTINGS, foveation: 1 as const };
    expect(applyUrlFlags(stored, { ...FLAGS, fov: 0 }).foveation).toBe(0);
    expect(applyUrlFlags(stored, FLAGS).foveation).toBe(1);

    const saved: unknown[] = [];
    const locked = createSettingsStore({
      stored,
      flags: { ...FLAGS, fov: 0.5 },
      save: (s) => {
        saved.push(s.foveation);
        return true;
      },
      schedule: () => 0,
      cancel: () => {},
    });
    expect(locked.effective.foveation).toBe(0.5);
    expect(locked.isLocked('foveation')).toBe(true);
    expect(locked.set('foveation', 0)).toBe(false);
    expect(locked.set('calm', 0.5)).toBe(true);
    locked.commit();
    expect(saved).toEqual([1]);
  });

  test('a change reaches setFoveation live through the store, as the pin or null for auto', () => {
    const s = store();
    const setFoveation = vi.fn();
    s.subscribe((effective, key) =>
      applySettingsChange(effective, key, {
        setLocomotion: () => {},
        setCalm: () => {},
        setFoveation,
        hud: null,
      }),
    );
    s.set('calm', 0.5);
    expect(setFoveation).not.toHaveBeenCalled();
    s.set('foveation', 1);
    expect(setFoveation).toHaveBeenLastCalledWith(1);
    s.set('foveation', 0);
    expect(setFoveation).toHaveBeenLastCalledWith(0);
    s.set('foveation', 'auto');
    expect(setFoveation).toHaveBeenLastCalledWith(null);
    expect(setFoveation).toHaveBeenCalledTimes(3);
  });
});

describe('the governor machine under a pin', () => {
  /** A steady overrun at 72 Hz: the adaptive machine sheds, then holds each step as no-gain. */
  function overrun(pin: number | null): GovernorEvent[] {
    const gov = createGovernor({ mode: 'default', targetHz: 72, foveationPin: pin });
    const drawn = { near: 1_000_000, mid: 1_000_000, far: 1_000_000 };
    const events: GovernorEvent[] = [];
    for (let t = 0; t < 60_000; t += 32) {
      const event = gov.sample({ t, intervalMs: 32, drawn });
      if (event) events.push(event);
    }
    expect(gov.levels.foveation).toBe(0);
    return events;
  }

  test('the adaptive machine treats its foveation steps as unable to apply', () => {
    const sheds = (events: GovernorEvent[]) => events.filter((e) => e.action === 'shed');
    expect(sheds(overrun(null))[0]?.step).toBe('foveation');
    for (const pin of [0, 0.5, 1]) {
      const events = overrun(pin);
      expect(sheds(events)[0]?.step).toBe('fb-scale');
      expect(sheds(events).some((e) => e.step === 'far-density')).toBe(true);
      expect(events.some((e) => e.step === 'foveation' || e.step === 'foveation-max')).toBe(false);
    }
  });

  test('a fixed level takes the same ladder steps, so level numbers do not shift', () => {
    const ladder = qualityLadder('default');
    for (const level of [1, 3, 5, 16]) {
      for (const pin of [0, 0.5, 1]) {
        const gov = createGovernor({
          mode: 'default',
          targetHz: 72,
          fixedLevel: level,
          foveationPin: pin,
        });
        expect(gov.shedSteps()).toEqual(ladder.slice(0, level));
      }
    }
    expect(
      qualityLadder('default')
        .map((s) => s.step)
        .slice(0, 3),
    ).toEqual(['foveation', 'fb-scale', 'foveation-max']);
  });
});

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
  frameRate: number | undefined = 72;
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

describe('the governor runtime under a pin', () => {
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

  function start(state: { level: number | null; pin: number | null }) {
    const xr = new FakeXr();
    const densities: Record<StrokeBand, number> = { ...DEFAULT_BAND_DENSITY };
    const batch: GovernedBatch = {
      setDensity: (band, d) => {
        densities[band] = d;
      },
      setSizeMultiplier: () => {},
      visibleByBand: () => ({ near: 1_000_000, mid: 1_000_000, far: 1_000_000 }),
    };
    runtime = startGovernor({
      renderer: { xr, getContext: () => ({ getExtension: () => null }) },
      scene: new Scene(),
      batch,
      mode: 'default',
      targetHz: 72,
      get fixedLevel() {
        return state.level;
      },
      get foveationPin() {
        return state.pin;
      },
    });
    return { rt: runtime, xr, densities };
  }

  test('a fixed level keeps its fb and density steps and applies the pin in place of its fov', () => {
    const unpinned = start({ level: 5, pin: null });
    const expected = { ...unpinned.densities };
    expect(unpinned.rt.diag()).toMatchObject({ level: 5, foveation: 1, foveationPin: null });
    unpinned.rt.dispose();

    const state = { level: 5 as number | null, pin: 0 as number | null };
    const { rt, xr, densities } = start(state);
    expect(rt.diag()).toMatchObject({
      fixedLevel: 5,
      level: 5,
      fbScale: 0.85,
      foveation: 0,
      foveationPin: 0,
    });
    expect(xr.setFoveation).toHaveBeenLastCalledWith(0);
    expect(densities).toEqual(expected);

    state.pin = 0.5;
    rt.frame(16);
    expect(rt.diag()).toMatchObject({ level: 5, foveation: 0.5, foveationPin: 0.5 });
    expect(xr.setFoveation).toHaveBeenLastCalledWith(0.5);
    state.pin = null;
    rt.frame(32);
    expect(rt.diag()).toMatchObject({ level: 5, foveation: 1, foveationPin: null });
    expect(xr.setFoveation).toHaveBeenLastCalledWith(1);
  });

  test('in XR the pin survives the per-frame re-assert and the adaptive sheds', () => {
    const { rt, xr } = start({ level: null, pin: 1 });
    xr.isPresenting = true;
    xr.emit('sessionstart');
    expect(xr.foveation).toBe(1);
    let t = 0;
    rt.frame(t);
    // The session's own start-up foveation lands after the governor's reset.
    xr.foveation = 0;
    t += 16;
    rt.frame(t);
    expect(xr.foveation).toBe(1);
    // A steady overrun: the machine sheds fb scale and density (each undone as no-gain), never
    // foveation.
    for (; t < 30_000; t += 32) rt.frame(t);
    const diag = rt.diag();
    expect(diag.history.find((e) => e.action === 'shed')?.step).toBe('fb-scale');
    expect(diag.history.some((e) => e.step === 'foveation' || e.step === 'foveation-max')).toBe(
      false,
    );
    expect(diag).toMatchObject({ foveation: 1, foveationPin: 1, judging: true });
    expect(xr.foveation).toBe(1);
  });
});

describe('the Foveation row', () => {
  const def = CONTROLS.find((c) => c.id === 'foveation');
  if (!def) throw new Error('no foveation control');

  test('is a segmented control in the World column under Quality level, clear of the rest', () => {
    expect(def).toMatchObject({ kind: 'segmented', field: 'foveation', column: 1, row: 6 });
    expect(def.options?.map((o) => o.value)).toEqual(['auto', 0, 0.5, 1]);
    const ids = CONTROLS.map((c) => c.id);
    expect(ids.indexOf('foveation')).toBe(ids.indexOf('qualityLevel') + 1);
    const taken = CONTROLS.filter((c) => c.kind !== 'button').map((c) => `${c.column}:${c.row}`);
    expect(new Set(taken).size).toBe(taken.length);
    const layout = controlLayout('foveation');
    if (!layout) throw new Error('no layout');
    expect(layout.segments).toHaveLength(4);
    for (const [i, s] of layout.segments.entries()) {
      expect(s.w).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(s.h).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(hitControl(s.x, s.y)).toMatchObject({ id: 'foveation', segment: i });
    }
    const bottom = layout.rect.y - layout.rect.h / 2;
    for (const button of LAYOUT.filter((l) => l.def.kind === 'button')) {
      const r = controlRect(button);
      expect(bottom - (r.y + r.h / 2)).toBeGreaterThanOrEqual(0.006);
    }
    expect(Math.abs(layout.rect.x) + layout.rect.w / 2).toBeLessThanOrEqual(PANEL_W / 2);
    expect(Math.abs(layout.rect.y) + layout.rect.h / 2).toBeLessThanOrEqual(PANEL_H / 2);
  });

  test('the DOM row sets the setting, shows the active segment, and is locked by ?fov', () => {
    const s = store();
    const dom = createSettingsDom({
      store: s,
      recenter: () => {},
      gallery: () => null,
      sessionQuality: () => 'adaptive-72',
      governorMode: () => null,
      hud: { visible: () => false, setVisible: () => {} },
      onClose: () => {},
    });
    dom.setOpen(true);
    const row = dom.element.querySelector('[data-control="foveation"]');
    const buttons = [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    expect(buttons.map((b) => b.textContent)).toEqual(['Auto', 'Off', '0.5', '1']);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    buttons[2]?.click();
    expect(s.effective.foveation).toBe(0.5);
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true');
    buttons[0]?.click();
    expect(s.effective.foveation).toBe('auto');
    dom.dispose();

    const locked = store({ ...FLAGS, fov: 1 });
    const lockedDom = createSettingsDom({
      store: locked,
      recenter: () => {},
      gallery: () => null,
      sessionQuality: () => 'adaptive-72',
      governorMode: () => null,
      hud: { visible: () => false, setVisible: () => {} },
      onClose: () => {},
    });
    lockedDom.setOpen(true);
    const lockedRow = lockedDom.element.querySelector<HTMLElement>('[data-control="foveation"]');
    const lockedButtons = [...(lockedRow?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    expect(lockedButtons.every((b) => b.disabled)).toBe(true);
    expect(lockedRow?.title).toContain('?fov=1');
    expect(lockedButtons[3]?.getAttribute('aria-pressed')).toBe('true');
    lockedDom.dispose();
  });

  test('under a pin the level label marks its foveation step pinned, and other steps read as before', () => {
    expect(qualityLevelLabel(1, 'default', 0)).toBe('1 · fov pinned');
    expect(qualityLevelLabel(3, 'default', 0.5)).toBe('3 · fov pinned');
    expect(qualityLevelLabel(2, 'default', 1)).toBe('2 · fb 0.85');
    expect(qualityLevelLabel(7, 'default', 0)).toBe('7 · far 0.10');
    expect(qualityLevelLabel(0, 'default', 1)).toBe('0 · full');
    expect(qualityLevelLabel('auto', 'default', 1)).toBe('Auto');
    expect(qualityLevelLabel(3, 'default', null)).toBe('3 · fov 1');
    const level = CONTROLS.find((c) => c.id === 'qualityLevel');
    if (!level) throw new Error('no qualityLevel control');
    const settings = { ...DEFAULT_SETTINGS, qualityLevel: 3 };
    expect(formatValue(level, settings, 'default')).toBe('3 · fov pinned');
    expect(formatValue(level, { ...settings, foveation: 'auto' }, 'default')).toBe('3 · fov 1');
    expect(formatValue(level, { ...settings, qualityLevel: 1 }, 'default')).toBe('1 · fov pinned');
  });

  test('under a pin the level summary shows the pinned foveation in place of its own', () => {
    expect(qualityLevelSummary(3, 'default', 0)).toBe('fov 0 (pinned), fb 0.85');
    expect(qualityLevelSummary(7, 'default', 0.5)).toBe('fov 0.5 (pinned), fb 0.85, far 0.10');
    expect(qualityLevelSummary(0, 'default', 1)).toBe('fov 1 (pinned)');
    expect(qualityLevelSummary('auto', 'default', 1)).toBe('Auto adapts, fov 1 (pinned)');
    expect(qualityLevelSummary(3, 'default')).toBe('fov 1, fb 0.85');
    expect(qualityLevelSummary(0, 'default')).toBe('full quality');

    const s = store();
    s.set('qualityLevel', 3);
    s.set('foveation', 'auto');
    const dom = createSettingsDom({
      store: s,
      recenter: () => {},
      gallery: () => null,
      sessionQuality: () => 'adaptive-72',
      governorMode: () => null,
      hud: { visible: () => false, setVisible: () => {} },
      onClose: () => {},
    });
    dom.setOpen(true);
    const row = dom.element.querySelector<HTMLElement>('[data-control="qualityLevel"]');
    expect(row?.title).toContain('Now: fov 1, fb 0.85');
    expect(row?.querySelector('.value')?.textContent).toBe('3 · fov 1');
    s.set('foveation', 0);
    expect(row?.title).toContain('Now: fov 0 (pinned), fb 0.85');
    expect(row?.querySelector('.value')?.textContent).toBe('3 · fov pinned');
    dom.dispose();
  });
});
