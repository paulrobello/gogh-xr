/**
 * The persisted settings (P5.2, PRD D12): a versioned object under one `localStorage` key. Each
 * range comes from the code that enforces it (locomotion settings, the motion clock), so there is
 * one source of truth per range. The last position is never stored.
 */
import {
  clampLocomotionSettings,
  DEFAULT_LOCOMOTION_SETTINGS,
  type SnapAngleDeg,
  type TurnMode,
} from '../locomotion/settings';
import { clampCalm } from '../motion/clock';
import type { GovernorMode } from '../render/governor';

export const SETTINGS_KEY = 'gogh-xr.settings.v1';
export const SETTINGS_VERSION = 2;

/**
 * 72 Hz (the default) or 90 Hz with the adaptive governor, or 72 Hz with the max-beauty budget
 * (`?beauty`).
 */
export type QualityMode = 'adaptive-72' | 'adaptive-90' | 'beauty-72';

const QUALITY_MODES: readonly QualityMode[] = ['adaptive-72', 'adaptive-90', 'beauty-72'];

/**
 * The governor's quality level: 'auto' adapts, a number N pins the first N steps of its shed order
 * (`qualityLadder` in `render/governor.ts`), 0 to `MAX_QUALITY_LEVEL`.
 */
export type QualityLevel = 'auto' | number;

/**
 * The highest fixed level of any mode, beauty's ladder length (`qualityLadder` in
 * `render/governor.ts`). A constant, so the boot chunk builds no governor machine to know it.
 * `tests/governor-fixed.test.ts` checks it against the ladders.
 */
export const MAX_QUALITY_LEVEL = 18;

/** The governor mode a quality runs: max beauty, or the default budget. */
export function governorModeOf(quality: QualityMode): GovernorMode {
  return quality === 'beauty-72' ? 'beauty' : 'default';
}

export interface Settings {
  /** Smooth movement speed, m/s. */
  readonly moveSpeed: number;
  readonly turnMode: TurnMode;
  /** The snap turn step, degrees. */
  readonly snapAngleDeg: SnapAngleDeg;
  /** Tunnel vignette strength, 0-1. */
  readonly vignette: number;
  readonly seated: boolean;
  /** The eye height seated mode raises the viewer to, metres. */
  readonly standingHeight: number;
  /** Motion calm, 0-1 (1 is full motion). */
  readonly calm: number;
  readonly quality: QualityMode;
  /** Auto, or a fixed governor level. `?nogov` keeps the governor off whatever this says. */
  readonly qualityLevel: QualityLevel;
  /** The perf HUD's starting visibility. */
  readonly hud: boolean;
  /** 0-1. Stored for P6; nothing consumes it yet. */
  readonly musicVolume: number;
  /** 0-1. Stored for P6; nothing consumes it yet. */
  readonly sfxVolume: number;
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  moveSpeed: DEFAULT_LOCOMOTION_SETTINGS.moveSpeed,
  turnMode: DEFAULT_LOCOMOTION_SETTINGS.turnMode,
  snapAngleDeg: DEFAULT_LOCOMOTION_SETTINGS.snapAngleDeg,
  vignette: DEFAULT_LOCOMOTION_SETTINGS.vignette,
  seated: DEFAULT_LOCOMOTION_SETTINGS.seated,
  standingHeight: DEFAULT_LOCOMOTION_SETTINGS.standingHeight,
  calm: 1,
  quality: 'adaptive-72',
  qualityLevel: 'auto',
  hud: false,
  musicVolume: 0.7,
  sfxVolume: 0.7,
});

/** Why `loadSettings` fell back to the defaults. A first run, with nothing stored, is not one. */
export type RecoveredReason =
  | 'corrupt-json'
  | 'bad-shape'
  | 'future-version'
  | 'storage-unavailable';

export interface LoadedSettings {
  readonly settings: Settings;
  readonly recovered: RecoveredReason | null;
}

/** A step that lifts a stored `settings` object from version N to N + 1, keyed by N. */
export type Migrations = Readonly<
  Record<number, (settings: Record<string, unknown>) => Record<string, unknown>>
>;

/** The migrations from each old version to the next. */
export const MIGRATIONS: Migrations = Object.freeze({
  // v2 adds adaptive-72 as the default. v1 saved the whole object on any change, so a stored
  // adaptive-90 is almost always the old default rather than a choice.
  1: (settings) =>
    settings.quality === 'adaptive-90' ? { ...settings, quality: 'adaptive-72' } : settings,
});

export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function unit(value: unknown, fallback: number): number {
  const n = num(value, fallback);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** 'auto', or a finite number rounded and clamped to 0..`MAX_QUALITY_LEVEL`; else the fallback. */
function qualityLevel(value: unknown, fallback: QualityLevel): QualityLevel {
  if (value === 'auto') return 'auto';
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_QUALITY_LEVEL, Math.max(0, Math.round(value)));
}

/**
 * Fills defaults for missing or wrong-typed fields and clamps every range. Unknown fields are
 * dropped, so a field that is removed in a later version does not linger.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const r = isRecord(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  const loco = clampLocomotionSettings({
    ...DEFAULT_LOCOMOTION_SETTINGS,
    moveSpeed: num(r.moveSpeed, d.moveSpeed),
    turnMode: r.turnMode as TurnMode,
    snapAngleDeg: r.snapAngleDeg as SnapAngleDeg,
    vignette: num(r.vignette, d.vignette),
    seated: bool(r.seated, d.seated),
    standingHeight: num(r.standingHeight, d.standingHeight),
  });
  return Object.freeze({
    moveSpeed: loco.moveSpeed,
    turnMode: loco.turnMode,
    snapAngleDeg: loco.snapAngleDeg,
    vignette: loco.vignette,
    seated: loco.seated,
    standingHeight: loco.standingHeight,
    calm: clampCalm(num(r.calm, d.calm)),
    quality: QUALITY_MODES.includes(r.quality as QualityMode)
      ? (r.quality as QualityMode)
      : d.quality,
    qualityLevel: qualityLevel(r.qualityLevel, d.qualityLevel),
    hud: bool(r.hud, d.hud),
    musicVolume: unit(r.musicVolume, d.musicVolume),
    sfxVolume: unit(r.sfxVolume, d.sfxVolume),
  });
}

/** Parses stored text: migrates old versions, then sanitizes. Never throws. */
export function parseSettings(
  text: string | null,
  version = SETTINGS_VERSION,
  migrations: Migrations = MIGRATIONS,
): LoadedSettings {
  const fallback = (recovered: RecoveredReason | null): LoadedSettings => ({
    settings: DEFAULT_SETTINGS,
    recovered,
  });
  if (text === null) return fallback(null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback('corrupt-json');
  }
  if (!isRecord(parsed) || !Number.isInteger(parsed.version) || !isRecord(parsed.settings)) {
    return fallback('bad-shape');
  }
  const stored = parsed.version as number;
  if (stored > version) return fallback('future-version');
  if (stored < 1) return fallback('bad-shape');
  let settings: Record<string, unknown> = parsed.settings;
  try {
    for (let v = stored; v < version; v += 1) {
      const step = migrations[v];
      if (!step) return fallback('bad-shape');
      settings = step(settings);
    }
  } catch {
    return fallback('bad-shape');
  }
  return { settings: sanitizeSettings(settings), recovered: null };
}

function defaultStorage(): SettingsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Reads the stored settings. Never throws: a problem returns the defaults and a named reason. */
export function loadSettings(storage: SettingsStorage | null = defaultStorage()): LoadedSettings {
  if (!storage) return { settings: DEFAULT_SETTINGS, recovered: 'storage-unavailable' };
  let text: string | null;
  try {
    text = storage.getItem(SETTINGS_KEY);
  } catch {
    return { settings: DEFAULT_SETTINGS, recovered: 'storage-unavailable' };
  }
  return parseSettings(text);
}

/** Writes `settings` (sanitized). Returns false when storage is unavailable or full. */
export function saveSettings(
  settings: Settings,
  storage: SettingsStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ version: SETTINGS_VERSION, settings: sanitizeSettings(settings) }),
    );
    return true;
  } catch {
    return false;
  }
}

/** The URL flags that override a stored setting for the session. */
export interface SettingsFlags {
  readonly beauty: boolean;
  readonly hz: number | null;
  /** null when absent; false (`?seated=0`) turns a stored true off. */
  readonly seated: boolean | null;
  readonly turn: TurnMode | null;
  /** null when absent; false (`?hud=0`) turns a stored true off. */
  readonly hud: boolean | null;
  readonly calm: number | null;
  /** `?nogov`: the governor stays off, so the quality level is locked. Absent means false. */
  readonly nogov?: boolean;
}

/**
 * The settings this session runs with: the stored ones with each URL flag laid over its field.
 * Never written back. `?beauty` selects max beauty, `?hz=72` selects adaptive-72, and `?hz=90`
 * or `?hz=120` selects adaptive-90, which then requests that rate (a stored quality yields to an
 * explicit rate). `?seated` and `?hud` set their field either way: bare is on, `=0` is off, and
 * absent leaves the stored value.
 */
export function applyUrlFlags(stored: Settings, f: SettingsFlags): Settings {
  const quality: QualityMode = f.beauty
    ? 'beauty-72'
    : f.hz === 72
      ? 'adaptive-72'
      : f.hz !== null
        ? 'adaptive-90'
        : stored.quality;
  return Object.freeze({
    ...stored,
    quality,
    seated: f.seated ?? stored.seated,
    turnMode: f.turn ?? stored.turnMode,
    hud: f.hud ?? stored.hud,
    calm: f.calm ?? stored.calm,
  });
}

/** The settings a URL flag decides for this session, each with the flag that locks it. */
export type SettingsLocks = Readonly<Partial<Record<keyof Settings, string>>>;

/**
 * The fields `applyUrlFlags` overrides for `f`, mapped to the flag that does it (for the panel's
 * locked state and its hover help). A locked field is never written back.
 */
export function lockedSettings(f: SettingsFlags): SettingsLocks {
  const locks: Partial<Record<keyof Settings, string>> = {};
  if (f.beauty) locks.quality = '?beauty';
  else if (f.hz !== null) locks.quality = `?hz=${f.hz}`;
  if (f.seated !== null) locks.seated = f.seated ? '?seated' : '?seated=0';
  if (f.turn !== null) locks.turnMode = `?turn=${f.turn}`;
  if (f.hud !== null) locks.hud = f.hud ? '?hud' : '?hud=0';
  if (f.calm !== null) locks.calm = `?calm=${f.calm}`;
  if (f.nogov) locks.qualityLevel = '?nogov';
  return Object.freeze(locks);
}

/** The locomotion fields of `settings`. */
export function toLocomotionSettings(settings: Settings) {
  return clampLocomotionSettings({
    ...DEFAULT_LOCOMOTION_SETTINGS,
    moveSpeed: settings.moveSpeed,
    turnMode: settings.turnMode,
    snapAngleDeg: settings.snapAngleDeg,
    vignette: settings.vignette,
    seated: settings.seated,
    standingHeight: settings.standingHeight,
  });
}
