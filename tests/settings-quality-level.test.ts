/** The quality level setting (2026-11-08, Paul's A2): sanitizing, the `?nogov` lock and the row. */
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SETTINGS,
  governorModeOf,
  loadSettings,
  lockedSettings,
  MAX_QUALITY_LEVEL,
  MIGRATIONS,
  parseSettings,
  SETTINGS_VERSION,
  type SettingsFlags,
  type SettingsStorage,
  sanitizeSettings,
  saveSettings,
} from '../src/settings/schema.ts';
import { createSettingsStore } from '../src/settings/store.ts';
import {
  AUTO_SLIDER,
  CONTROLS,
  controlLayout,
  hitControl,
  ladderMode,
  liveSliderDef,
  qualityLevelLabel,
  qualityLevelMax,
  qualityLevelSummary,
  settingFromSlider,
  sliderPosition,
  sliderSetting,
  sliderValue,
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

function store(flags: SettingsFlags = FLAGS) {
  return createSettingsStore({
    stored: DEFAULT_SETTINGS,
    flags,
    save: () => true,
    schedule: () => 0,
    cancel: () => {},
  });
}

describe('the qualityLevel setting', () => {
  test('defaults to a fixed level 5', () => {
    expect(DEFAULT_SETTINGS.qualityLevel).toBe(5);
    expect(sanitizeSettings({}).qualityLevel).toBe(5);
  });

  test.each([
    ['auto', 'auto'],
    [0, 0],
    [3, 3],
    [3.4, 3],
    [3.6, 4],
    [-2, 0],
    [MAX_QUALITY_LEVEL, MAX_QUALITY_LEVEL],
    [99, MAX_QUALITY_LEVEL],
    [Number.NaN, 5],
    [Number.POSITIVE_INFINITY, 5],
    ['3', 5],
    ['fixed', 5],
    [null, 5],
  ] as const)('sanitizes %s to %s', (value, expected) => {
    expect(sanitizeSettings({ qualityLevel: value }).qualityLevel).toBe(expected);
  });

  test('survives a save and load at the same settings version (no migration needed)', () => {
    expect(SETTINGS_VERSION).toBe(4);
    for (const qualityLevel of ['auto', 0, 7, MAX_QUALITY_LEVEL] as const) {
      const storage = memoryStorage();
      expect(saveSettings({ ...DEFAULT_SETTINGS, qualityLevel }, storage)).toBe(true);
      expect(loadSettings(storage).settings.qualityLevel).toBe(qualityLevel);
    }
    // A blob saved before the field existed loads the default level 5, keeping the rest.
    const storage = memoryStorage();
    storage.text = JSON.stringify({ version: 2, settings: { calm: 0.4 } });
    expect(loadSettings(storage)).toMatchObject({
      settings: { calm: 0.4, qualityLevel: 5 },
      recovered: null,
    });
  });

  test('a stored v2 auto migrates to 5 once; an explicit auto or level at v3 is kept', () => {
    const load = (version: number, qualityLevel: unknown) =>
      parseSettings(JSON.stringify({ version, settings: { qualityLevel } })).settings.qualityLevel;
    expect(load(2, 'auto')).toBe(5);
    expect(load(1, 'auto')).toBe(5);
    expect(load(2, 3)).toBe(3);
    expect(load(2, 0)).toBe(0);
    expect(load(3, 'auto')).toBe('auto');
    expect(load(3, 9)).toBe(9);
    expect(MIGRATIONS[2]?.({ qualityLevel: 'auto', calm: 1 })).toEqual({
      qualityLevel: 5,
      calm: 1,
    });
    expect(MIGRATIONS[2]?.({ qualityLevel: 4 })).toEqual({ qualityLevel: 4 });
  });

  test('a fresh install (nothing stored) boots at the fixed level 5', () => {
    expect(loadSettings(memoryStorage())).toEqual({ settings: DEFAULT_SETTINGS, recovered: null });
    expect(loadSettings(memoryStorage()).settings.qualityLevel).toBe(5);
  });

  test('?nogov wins: it locks the level, and the store refuses an edit', () => {
    expect(lockedSettings(FLAGS).qualityLevel).toBeUndefined();
    expect(lockedSettings({ ...FLAGS, nogov: false }).qualityLevel).toBeUndefined();
    expect(lockedSettings({ ...FLAGS, nogov: true }).qualityLevel).toBe('?nogov');
    const locked = store({ ...FLAGS, nogov: true });
    expect(locked.isLocked('qualityLevel')).toBe(true);
    expect(locked.set('qualityLevel', 3)).toBe(false);
    expect(locked.effective.qualityLevel).toBe(5);
    const open = store();
    expect(open.set('qualityLevel', 3)).toBe(true);
    expect(open.effective.qualityLevel).toBe(3);
  });
});

describe('the quality level row', () => {
  const def = CONTROLS.find((c) => c.id === 'qualityLevel');
  if (!def) throw new Error('no qualityLevel control');

  test('is a slider in the World column, row 5, clear of the music and sound rows', () => {
    expect(def).toMatchObject({ kind: 'slider', field: 'qualityLevel', column: 1, row: 5 });
    expect(def.min).toBe(AUTO_SLIDER);
    expect(def.max).toBe(MAX_QUALITY_LEVEL);
    const taken = CONTROLS.filter((c) => c.kind !== 'button' && c !== def).map(
      (c) => `${c.column}:${c.row}`,
    );
    expect(taken).not.toContain('1:5');
    const layout = controlLayout('qualityLevel');
    if (!layout) throw new Error('no layout');
    expect(hitControl(layout.rect.x, layout.rect.y)?.id).toBe('qualityLevel');
  });

  test('the max follows the governor mode: 16 for the adaptive qualities, 18 for beauty', () => {
    expect(governorModeOf('adaptive-72')).toBe('default');
    expect(governorModeOf('adaptive-90')).toBe('default');
    expect(governorModeOf('beauty-72')).toBe('beauty');
    expect(qualityLevelMax('default')).toBe(16);
    expect(qualityLevelMax('beauty')).toBe(18);
    expect(liveSliderDef(def, 'default').max).toBe(16);
    expect(liveSliderDef(def, 'beauty').max).toBe(18);
    const vignette = CONTROLS.find((c) => c.id === 'vignette');
    if (!vignette) throw new Error('no vignette');
    expect(liveSliderDef(vignette, 'beauty')).toBe(vignette);
  });

  test("the row's mode is the running governor's, else the one the setting starts", () => {
    expect(ladderMode('beauty', 'adaptive-72')).toBe('beauty');
    expect(ladderMode('default', 'beauty-72')).toBe('default');
    expect(ladderMode(null, 'beauty-72')).toBe('beauty');
    expect(ladderMode(null, 'adaptive-90')).toBe('default');
  });

  test('the slider runs Auto, 0, 1 ... max, and Auto sits left of 0', () => {
    const live = liveSliderDef(def, 'default');
    expect(settingFromSlider(def, sliderValue(live, 0))).toBe('auto');
    expect(settingFromSlider(def, sliderValue(live, 1 / 17))).toBe(0);
    expect(settingFromSlider(def, sliderValue(live, 4 / 17))).toBe(3);
    expect(settingFromSlider(def, sliderValue(live, 1))).toBe(16);
    const at = (qualityLevel: 'auto' | number) =>
      sliderPosition(live, sliderSetting(def, { ...DEFAULT_SETTINGS, qualityLevel }, 'default'));
    expect(at('auto')).toBe(0);
    expect(at(3)).toBeCloseTo(4 / 17, 12);
    // A stored beauty level past the adaptive ladder sits at the end, as the governor clamps it.
    expect(at(18)).toBe(1);
    // Other sliders keep their plain values.
    const vignette = CONTROLS.find((c) => c.id === 'vignette');
    if (!vignette) throw new Error('no vignette');
    expect(settingFromSlider(vignette, 0.4)).toBe(0.4);
    expect(sliderSetting(vignette, DEFAULT_SETTINGS, 'default')).toBe(0.6);
  });

  test('a value at the stored level shown clamped keeps the stored level', () => {
    const beauty18 = { ...DEFAULT_SETTINGS, qualityLevel: 18 };
    // A stored beauty 18 shows at 16 on the adaptive ladder; a press there moves nothing.
    expect(settingFromSlider(def, 16, beauty18, 'default')).toBe(18);
    expect(settingFromSlider(def, 15, beauty18, 'default')).toBe(15);
    expect(settingFromSlider(def, -1, beauty18, 'default')).toBe('auto');
    expect(
      settingFromSlider(def, 16, { ...DEFAULT_SETTINGS, qualityLevel: 'auto' }, 'default'),
    ).toBe(16);
  });

  test('the value says what the level adds, for the session quality', () => {
    expect(qualityLevelLabel('auto', 'default')).toBe('Auto');
    expect(qualityLevelLabel(0, 'default')).toBe('0 · full');
    expect(qualityLevelLabel(1, 'default')).toBe('1 · fov 0.5');
    expect(qualityLevelLabel(2, 'default')).toBe('2 · fb 0.85');
    expect(qualityLevelLabel(3, 'default')).toBe('3 · fov 1');
    expect(qualityLevelLabel(4, 'default')).toBe('4 · far 0.28');
    expect(qualityLevelLabel(7, 'default')).toBe('7 · far 0.10');
    expect(qualityLevelLabel(12, 'default')).toBe('12 · mid 0.20');
    expect(qualityLevelLabel(16, 'default')).toBe('16 · near 0.25');
    expect(qualityLevelLabel(18, 'default')).toBe('16 · near 0.25');
    expect(qualityLevelLabel(4, 'beauty')).toBe('4 · far 0.56');
    expect(qualityLevelLabel(18, 'beauty')).toBe('18 · near 0.25');
  });

  test('the summary lists every lever a level sets, at its last value', () => {
    expect(qualityLevelSummary('auto', 'default')).toBe('Auto adapts');
    expect(qualityLevelSummary(0, 'default')).toBe('full quality');
    expect(qualityLevelSummary(1, 'default')).toBe('fov 0.5');
    expect(qualityLevelSummary(3, 'default')).toBe('fov 1, fb 0.85');
    expect(qualityLevelSummary(7, 'default')).toBe('fov 1, fb 0.85, far 0.10');
    expect(qualityLevelSummary(16, 'default')).toBe(
      'fov 1, fb 0.85, far 0.10, mid 0.20, near 0.25',
    );
    expect(qualityLevelSummary(18, 'default')).toBe(qualityLevelSummary(16, 'default'));
  });

  test('the DOM panel sets it with its range input, and shows the label', () => {
    const settings = store();
    const dom = createSettingsDom({
      store: settings,
      recenter: () => {},
      gallery: () => null,
      sessionQuality: () => 'adaptive-72',
      hud: { visible: () => false, setVisible: () => {} },
      onClose: () => {},
    });
    try {
      dom.setOpen(true);
      const row = dom.element.querySelector('[data-control="qualityLevel"]');
      const input = row?.querySelector<HTMLInputElement>('input[type=range]');
      if (!row || !input) throw new Error('no quality level row');
      expect(input).toMatchObject({ min: '-1', max: '16', step: '1', value: '5' });
      expect(row.querySelector('.value')?.textContent).toBe('5 · far 0.20');
      input.value = '3';
      input.dispatchEvent(new Event('input'));
      expect(settings.effective.qualityLevel).toBe(3);
      // The default foveation is a pinned Off, so a foveation step reads as pinned.
      expect(row.querySelector('.value')?.textContent).toBe('3 · fov pinned');
      expect(input.getAttribute('aria-valuetext')).toBe('3 · fov pinned');
      expect((row as HTMLElement).title).toContain('each level keeps every step below it');
      expect((row as HTMLElement).title).toContain('Now: fov 0 (pinned), fb 0.85');
      input.value = '-1';
      input.dispatchEvent(new Event('input'));
      expect(settings.effective.qualityLevel).toBe('auto');
      expect(input.getAttribute('aria-valuetext')).toBe('Auto');
    } finally {
      dom.dispose();
    }
  });
});
