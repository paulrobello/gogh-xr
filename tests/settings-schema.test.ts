import { expect, test } from 'vitest';
import {
  MAX_MOVE_SPEED,
  MAX_STANDING_HEIGHT,
  MIN_MOVE_SPEED,
  MIN_STANDING_HEIGHT,
} from '../src/locomotion/settings.ts';
import {
  applyUrlFlags,
  DEFAULT_SETTINGS,
  loadSettings,
  parseSettings,
  SETTINGS_KEY,
  type Settings,
  type SettingsFlags,
  type SettingsStorage,
  saveSettings,
  toLocomotionSettings,
} from '../src/settings/schema.ts';

function memoryStorage(initial?: string): SettingsStorage & { text: string | null } {
  const store = { text: initial ?? null } as SettingsStorage & { text: string | null };
  store.getItem = (key) => (key === SETTINGS_KEY ? store.text : null);
  store.setItem = (key, value) => {
    if (key === SETTINGS_KEY) store.text = value;
  };
  return store;
}

const noFlags: SettingsFlags = {
  beauty: false,
  hz: null,
  seated: false,
  turn: null,
  hud: false,
  calm: null,
};

test('the key is gogh-xr.settings.v1 and nothing positional is stored', () => {
  expect(SETTINGS_KEY).toBe('gogh-xr.settings.v1');
  expect(Object.keys(DEFAULT_SETTINGS).some((k) => /pos|pose|yaw|rig/i.test(k))).toBe(false);
});

test('first run: nothing stored gives the defaults and no recovery', () => {
  expect(loadSettings(memoryStorage())).toEqual({ settings: DEFAULT_SETTINGS, recovered: null });
});

test('the defaults reproduce the pre-settings boot (fidelity)', () => {
  const loco = toLocomotionSettings(DEFAULT_SETTINGS);
  expect(loco).toEqual({
    moveSpeed: 2,
    seated: false,
    standingHeight: 1.6,
    turnMode: 'snap',
    snapAngleDeg: 30,
    smoothTurnDegPerSec: 90,
    vignette: 0.6,
  });
  expect(DEFAULT_SETTINGS.calm).toBe(1);
  expect(DEFAULT_SETTINGS.quality).toBe('adaptive-90');
  expect(DEFAULT_SETTINGS.hud).toBe(false);
  expect(applyUrlFlags(DEFAULT_SETTINGS, noFlags)).toEqual(DEFAULT_SETTINGS);
});

test('toLocomotionSettings carries every locomotion field end to end', () => {
  const loco = toLocomotionSettings({
    ...DEFAULT_SETTINGS,
    moveSpeed: 2.5,
    turnMode: 'smooth',
    snapAngleDeg: 45,
    vignette: 0.25,
    seated: true,
    standingHeight: 1.8,
  });
  expect(loco).toMatchObject({
    moveSpeed: 2.5,
    turnMode: 'smooth',
    snapAngleDeg: 45,
    vignette: 0.25,
    seated: true,
    standingHeight: 1.8,
  });
});

test('round trip: a saved settings object loads back equal', () => {
  const settings: Settings = {
    moveSpeed: 2.5,
    turnMode: 'smooth',
    snapAngleDeg: 45,
    vignette: 0.25,
    seated: true,
    standingHeight: 1.8,
    calm: 0.4,
    quality: 'beauty-72',
    hud: true,
    musicVolume: 0.3,
    sfxVolume: 0.9,
  };
  const storage = memoryStorage();
  expect(saveSettings(settings, storage)).toBe(true);
  expect(JSON.parse(storage.text ?? '').version).toBe(1);
  expect(loadSettings(storage)).toEqual({ settings, recovered: null });
});

test('out-of-range and wrong-typed values are clamped or defaulted', () => {
  const text = JSON.stringify({
    version: 1,
    settings: {
      moveSpeed: 99,
      turnMode: 'spin',
      snapAngleDeg: 60,
      vignette: -3,
      seated: 'yes',
      standingHeight: 0.2,
      calm: 7,
      quality: 'ultra',
      hud: 1,
      musicVolume: 5,
      sfxVolume: 'loud',
      lastPosition: [1, 2, 3],
    },
  });
  const { settings, recovered } = parseSettings(text);
  expect(recovered).toBeNull();
  expect(settings.moveSpeed).toBe(MAX_MOVE_SPEED);
  expect(settings.turnMode).toBe('snap');
  expect(settings.snapAngleDeg).toBe(30);
  expect(settings.vignette).toBe(0);
  expect(settings.seated).toBe(false);
  expect(settings.standingHeight).toBe(MIN_STANDING_HEIGHT);
  expect(settings.calm).toBe(1);
  expect(settings.quality).toBe('adaptive-90');
  expect(settings.hud).toBe(false);
  expect(settings.musicVolume).toBe(1);
  expect(settings.sfxVolume).toBe(DEFAULT_SETTINGS.sfxVolume);
  expect('lastPosition' in settings).toBe(false);
  const low = parseSettings(
    JSON.stringify({ version: 1, settings: { moveSpeed: 0, standingHeight: 9, calm: -1 } }),
  ).settings;
  expect([low.moveSpeed, low.standingHeight, low.calm]).toEqual([
    MIN_MOVE_SPEED,
    MAX_STANDING_HEIGHT,
    0,
  ]);
});

test('a partial object keeps what it has and defaults the rest', () => {
  const { settings } = parseSettings(JSON.stringify({ version: 1, settings: { moveSpeed: 1.5 } }));
  expect(settings).toEqual({ ...DEFAULT_SETTINGS, moveSpeed: 1.5 });
});

test.each([
  ['{not json', 'corrupt-json'],
  ['', 'corrupt-json'],
  ['[1,2]', 'bad-shape'],
  ['null', 'bad-shape'],
  ['{"version":1}', 'bad-shape'],
  ['{"version":"1","settings":{}}', 'bad-shape'],
  ['{"version":0,"settings":{}}', 'bad-shape'],
  ['{"version":2,"settings":{}}', 'future-version'],
])('stored %j falls back to the defaults as %s', (text, reason) => {
  expect(parseSettings(text)).toEqual({ settings: DEFAULT_SETTINGS, recovered: reason });
  expect(loadSettings(memoryStorage(text)).recovered).toBe(reason);
});

test('unavailable storage returns the defaults with a named reason, and save reports false', () => {
  const broken: SettingsStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('full');
    },
  };
  expect(loadSettings(broken)).toEqual({
    settings: DEFAULT_SETTINGS,
    recovered: 'storage-unavailable',
  });
  expect(loadSettings(null).recovered).toBe('storage-unavailable');
  expect(saveSettings(DEFAULT_SETTINGS, broken)).toBe(false);
  expect(saveSettings(DEFAULT_SETTINGS, null)).toBe(false);
});

test('migration runs v1 to a v2 fixture, step by step, then clamps', () => {
  const v1 = JSON.stringify({
    version: 1,
    settings: { moveSpeed: 2.2, comfortTurn: 'smooth', calm: 0.5 },
  });
  const migrations = {
    // v2 renames comfortTurn to turnMode.
    1: (s: Record<string, unknown>) => {
      const { comfortTurn, ...rest } = s;
      return { ...rest, turnMode: comfortTurn };
    },
  };
  const { settings, recovered } = parseSettings(v1, 2, migrations);
  expect(recovered).toBeNull();
  expect(settings).toEqual({ ...DEFAULT_SETTINGS, moveSpeed: 2.2, turnMode: 'smooth', calm: 0.5 });
  // v2 data under a v2 reader needs no migration.
  const v2 = JSON.stringify({ version: 2, settings: { turnMode: 'smooth' } });
  expect(parseSettings(v2, 2, migrations).settings.turnMode).toBe('smooth');
  // A missing step or a throwing step is a bad shape, not a crash.
  expect(parseSettings(v1, 2, {}).recovered).toBe('bad-shape');
  const boom = {
    1: () => {
      throw new Error('x');
    },
  };
  expect(parseSettings(v1, 2, boom).recovered).toBe('bad-shape');
});

test('URL flags override the stored value field by field and the stored object is untouched', () => {
  const stored: Settings = {
    ...DEFAULT_SETTINGS,
    quality: 'beauty-72',
    seated: false,
    turnMode: 'snap',
    hud: false,
    calm: 0.8,
  };
  const frozen = JSON.stringify(stored);
  const on = applyUrlFlags(stored, {
    ...noFlags,
    seated: true,
    turn: 'smooth',
    hud: true,
    calm: 0.2,
  });
  expect([on.seated, on.turnMode, on.hud, on.calm]).toEqual([true, 'smooth', true, 0.2]);
  expect(JSON.stringify(stored)).toBe(frozen);
  // ?hz beats a stored max beauty; ?beauty beats a stored adaptive mode.
  expect(applyUrlFlags(stored, { ...noFlags, hz: 120 }).quality).toBe('adaptive-90');
  expect(applyUrlFlags(DEFAULT_SETTINGS, { ...noFlags, beauty: true }).quality).toBe('beauty-72');
  expect(applyUrlFlags(stored, { ...noFlags, beauty: true, hz: 90 }).quality).toBe('beauty-72');
  // No flag leaves the stored value in force, including a stored true that a flag cannot clear.
  const keep = applyUrlFlags({ ...stored, seated: true, hud: true, turnMode: 'smooth' }, noFlags);
  expect([keep.quality, keep.seated, keep.hud, keep.turnMode, keep.calm]).toEqual([
    'beauty-72',
    true,
    true,
    'smooth',
    0.8,
  ]);
});
