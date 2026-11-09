import type { TurnMode } from '../locomotion/settings';
import { REACTIVE_MOTION_BIT } from '../motion/layers';
import { SKY_WAVE_TURNS, SKY_WRAPS, type SkyWaveTurns, type SkyWrap } from '../motion/variants';
import { STROKE_LAYER, type StrokeLayerName } from '../render/strokes/instance';

export interface Flags {
  readonly seed: number | null;
  /** `?noanim`: freezes the motion clock, so every stroke sits at rest and time holds. */
  readonly noanim: boolean;
  /** `?calm=0..1`: the motion calm, clamped. null means the default (1, full motion). */
  readonly calm: number | null;
  /**
   * `?motiont=<s>`: pins the motion time at s seconds, wrapped at 3600, with the gate open. Only
   * honoured in `--mode e2e` builds. null when absent, negative or not a number.
   */
  readonly motiont: number | null;
  /**
   * `?motionphase=<f>`: every stroke's motion phase, wrapped to [0, 1), in place of its phase byte,
   * so a pinned `?motiont` moves the whole sky coherently. Only honoured in `--mode e2e` builds.
   * null when absent, negative or not a number.
   */
  readonly motionphase: number | null;
  /**
   * `?motionlayers=<list>`: a comma-separated list of stroke layer names (`STROKE_LAYER`) and
   * `reactive` (the reactive gate bit, P4.5), as a bit mask that main.ts ANDs with the world's
   * motion layers, so it can only close layers. Only honoured in `--mode e2e` builds. Unknown names
   * are ignored. null when absent.
   */
  readonly motionlayers: number | null;
  /** `?nohalo`: hides the star and moon halo pass, for a headset A/B of its cost. */
  readonly nohalo: boolean;
  /** Enables `__goghShot()` in diag mode; carries no value. */
  readonly shot: boolean;
  readonly diag: boolean;
  /** `?hud` (or `?hud=1`) is true, `?hud=0` or `?hud=false` is false, absent is null. */
  readonly hud: boolean | null;
  readonly iwer: boolean;
  readonly bench: string | null;
  readonly benchMode: BenchMode;
  readonly benchSize: number | null;
  /** null means the mode's default order. */
  readonly benchOrder: BenchOrder | null;
  /** Requested XR target frame rate; null means the default. */
  readonly hz: TargetHz | null;
  /** Builds the small deterministic stroke-engine test scene. */
  readonly strokesTest: boolean;
  /** `?demo=canvas`: the P1 test canvas, the painting re-painted in strokes. */
  readonly demo: DemoName | null;
  /** `?beauty`: max-beauty mode, 72 Hz with the 500k budget. Overrides `?hz`. */
  readonly beauty: boolean;
  /** `?slow=<ms>`: CPU busy-wait per frame, 0-50 ms, for testing the governor. 0 means off. */
  readonly slow: number;
  /** `?nogov`: keeps the quality governor off, so e2e checks see fixed densities. */
  readonly nogov: boolean;
  /**
   * `?update`: the build poller (P7.1, `src/update/policy.ts`). True polls in an e2e build too,
   * `?update=0` turns it off in any build, and absent (null) polls only in a production build.
   */
  readonly update: boolean | null;
  /** `&count=N`: the `?demo=canvas` stroke target, 10k-1M. null means the canvas default. */
  readonly count: number | null;
  /** `?nocache`: skips the IndexedDB scatter cache, so the world re-scatters on every load. */
  readonly nocache: boolean;
  /** `?cache`: uses the scatter cache in a non-production build. `?nocache` wins over it. */
  readonly cache: boolean;
  /** `?painting=<id>`: boots straight into that painting's world. Lower-cased; null when absent. */
  readonly painting: string | null;
  /** `?bare`, with `?diag` only: base meshes and clear colour magenta, strokes hidden. */
  readonly bare: boolean;
  /** `?coverage`, with `?diag` only: base meshes and clear colour magenta under the strokes. */
  readonly coverage: boolean;
  /** `?painter`, with `?diag` and a world only: the desktop camera becomes the painter camera. */
  readonly painter: boolean;
  /**
   * `?seated`: seated mode, calibrated from the head height on the first XR frame. Like `?hud`,
   * `?seated=0` is false, which turns a stored true off, and absent is null.
   */
  readonly seated: boolean | null;
  /** `?turn=snap|smooth`: the turn mode. null means the settings default (snap). */
  readonly turn: TurnMode | null;
  /** `?zdiag=<mode>`: a stroke depth and filtering diagnostic (src/render/zdiag.ts). null is off. */
  readonly zdiag: ZdiagMode | null;
  /** `?ab=<group>`: the A/B group the A/B button cycles (src/diag/ab.ts). Lower-cased; null when absent. */
  readonly ab: string | null;
  /** `?wrap=<variant>`: the sky swirl's wrap treatment (src/motion/variants.ts). null is the default, wave. */
  readonly wrap: SkyWrap | null;
  /** `?waveturns=1|2|3`: the wave wrap's waves per turn (SKY_WAVE_TURNS). null is the default. */
  readonly waveTurns: SkyWaveTurns | null;
  /** `?scene=bare`: boots the bare scene instead of the default gallery (src/boot-mode.ts). */
  readonly scene: SceneName | null;
  /**
   * `?densitylaw=area|count`: how a governor density shed sizes the survivors (src/render/governor.ts).
   * null is the default, `area`.
   */
  readonly densityLaw: DensityLaw | null;
  /**
   * `?fov=0|0.5|1`: testing only, honoured in production like `?slow`. The fixed foveation an XR
   * session starts at (src/xr/session.ts), in place of `FOVEATION`. null (absent or any other value)
   * keeps the default. A running governor still sets its own foveation.
   */
  readonly fov: Fov | null;
}

/** The fixed foveation levels `?fov` pins: off, the governor's first step and its last. */
export const FOV_LEVELS = [0, 0.5, 1] as const;
export type Fov = (typeof FOV_LEVELS)[number];

/** `area` grows survivors by sqrt(from / to), `count` keeps their size (governor.ts). */
export const DENSITY_LAWS = ['area', 'count'] as const;
export type DensityLaw = (typeof DENSITY_LAWS)[number];

export type BenchMode = 'a2c' | 'blend';
export type BenchOrder = 'sorted' | 'random';
export type TargetHz = 72 | 90 | 120;
export type DemoName = 'canvas';
export type SceneName = 'bare';
export const ZDIAG_MODES = [
  'write',
  'nowrite',
  'nosort',
  'noa2c',
  'sharp',
  'sharp4',
  'nomip',
  'mip',
  'freeze',
  'strokeorder',
  'paintorder',
] as const;
export type ZdiagMode = (typeof ZDIAG_MODES)[number];

const TARGET_HZ: readonly number[] = [72, 90, 120];

export const MAX_SLOW_MS = 50;
/** `&count` bounds: wide enough for the 325k default budget and the 500k max-beauty budget. */
export const MIN_CANVAS_COUNT = 10_000;
export const MAX_CANVAS_COUNT = 1_000_000;

const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function parseNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (!NUMBER_PATTERN.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function parseBool(params: URLSearchParams, key: string): boolean {
  if (!params.has(key)) return false;
  const value = params.get(key)?.trim().toLowerCase();
  return value !== '0' && value !== 'false';
}

/** A boolean that can also say off: null when absent. */
function parseOnOff(params: URLSearchParams, key: string): boolean | null {
  return params.has(key) ? parseBool(params, key) : null;
}

function parseBenchMode(raw: string | null): BenchMode {
  return raw?.trim().toLowerCase() === 'blend' ? 'blend' : 'a2c';
}

function parseBenchOrder(raw: string | null): BenchOrder | null {
  const value = raw?.trim().toLowerCase();
  return value === 'sorted' || value === 'random' ? value : null;
}

function parseHz(raw: string | null): TargetHz | null {
  const value = parseNumber(raw);
  return value !== null && TARGET_HZ.includes(value) ? (value as TargetHz) : null;
}

function parseFov(raw: string | null): Fov | null {
  const value = parseNumber(raw);
  return FOV_LEVELS.find((level) => level === value) ?? null;
}

function parseSlow(raw: string | null): number {
  const value = parseNumber(raw);
  return value === null ? 0 : Math.min(MAX_SLOW_MS, Math.max(0, value));
}

function parseCalm(raw: string | null): number | null {
  const value = parseNumber(raw);
  return value === null ? null : Math.min(1, Math.max(0, value));
}

function parseMotionT(raw: string | null): number | null {
  const value = parseNumber(raw);
  return value === null || value < 0 ? null : value % 3600;
}

function parseMotionPhase(raw: string | null): number | null {
  const value = parseNumber(raw);
  return value === null || value < 0 ? null : value % 1;
}

function parseMotionLayers(raw: string | null): number | null {
  if (raw === null) return null;
  let mask = 0;
  for (const name of raw.split(',')) {
    const key = name.trim().toLowerCase();
    if (key === 'reactive') {
      mask |= REACTIVE_MOTION_BIT;
      continue;
    }
    const layer = STROKE_LAYER[key as StrokeLayerName];
    if (layer !== undefined) mask |= 1 << layer;
  }
  return mask >>> 0;
}

function parseCount(raw: string | null): number | null {
  const value = parseNumber(raw);
  return value === null
    ? null
    : Math.min(MAX_CANVAS_COUNT, Math.max(MIN_CANVAS_COUNT, Math.round(value)));
}

function parseDemo(raw: string | null): DemoName | null {
  return raw?.trim().toLowerCase() === 'canvas' ? 'canvas' : null;
}

function parseScene(raw: string | null): SceneName | null {
  return raw?.trim().toLowerCase() === 'bare' ? 'bare' : null;
}

function parseTurn(raw: string | null): TurnMode | null {
  const value = raw?.trim().toLowerCase();
  return value === 'snap' || value === 'smooth' ? value : null;
}

function parseZdiag(raw: string | null): ZdiagMode | null {
  const value = raw?.trim().toLowerCase();
  return ZDIAG_MODES.find((mode) => mode === value) ?? null;
}

function parseVariant<T extends string>(variants: readonly T[], raw: string | null): T | null {
  const value = raw?.trim().toLowerCase();
  return variants.find((variant) => variant === value) ?? null;
}

function parseWaveTurns(raw: string | null): SkyWaveTurns | null {
  const value = raw?.trim();
  return SKY_WAVE_TURNS.find((turns) => String(turns) === value) ?? null;
}

function parseId(raw: string | null): string | null {
  const value = raw?.trim().toLowerCase();
  return value ? value : null;
}

/** Repeated keys resolve to the first occurrence. */
export function parseFlags(search: string): Flags {
  const params = new URLSearchParams(search);
  const bench = params.get('bench')?.trim();
  const size = parseNumber(params.get('size'));
  return Object.freeze({
    seed: parseNumber(params.get('seed')),
    noanim: parseBool(params, 'noanim'),
    calm: parseCalm(params.get('calm')),
    motiont: parseMotionT(params.get('motiont')),
    motionphase: parseMotionPhase(params.get('motionphase')),
    motionlayers: parseMotionLayers(params.get('motionlayers')),
    nohalo: parseBool(params, 'nohalo'),
    shot: parseBool(params, 'shot'),
    diag: parseBool(params, 'diag'),
    hud: parseOnOff(params, 'hud'),
    iwer: parseBool(params, 'iwer'),
    bench: bench ? bench : null,
    benchMode: parseBenchMode(params.get('mode')),
    benchSize: size !== null && size > 0 ? size : null,
    benchOrder: parseBenchOrder(params.get('order')),
    hz: parseHz(params.get('hz')),
    strokesTest: parseBool(params, 'strokesTest'),
    demo: parseDemo(params.get('demo')),
    beauty: parseBool(params, 'beauty'),
    slow: parseSlow(params.get('slow')),
    nogov: parseBool(params, 'nogov'),
    update: parseOnOff(params, 'update'),
    count: parseCount(params.get('count')),
    nocache: parseBool(params, 'nocache'),
    cache: parseBool(params, 'cache'),
    painting: parseId(params.get('painting')),
    bare: parseBool(params, 'bare'),
    coverage: parseBool(params, 'coverage'),
    painter: parseBool(params, 'painter'),
    seated: parseOnOff(params, 'seated'),
    turn: parseTurn(params.get('turn')),
    zdiag: parseZdiag(params.get('zdiag')),
    ab: parseId(params.get('ab')),
    wrap: parseVariant(SKY_WRAPS, params.get('wrap')),
    waveTurns: parseWaveTurns(params.get('waveturns')),
    scene: parseScene(params.get('scene')),
    densityLaw: parseVariant(DENSITY_LAWS, params.get('densitylaw')),
    fov: parseFov(params.get('fov')),
  });
}

export const flags: Flags = parseFlags(typeof location === 'undefined' ? '' : location.search);
