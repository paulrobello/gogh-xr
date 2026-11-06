export interface Flags {
  readonly seed: number | null;
  readonly noanim: boolean;
  /** Enables `__goghShot()` in diag mode; carries no value. */
  readonly shot: boolean;
  readonly diag: boolean;
  readonly hud: boolean;
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
}

export type BenchMode = 'a2c' | 'blend';
export type BenchOrder = 'sorted' | 'random';
export type TargetHz = 72 | 90 | 120;
export type DemoName = 'canvas';

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

function parseSlow(raw: string | null): number {
  const value = parseNumber(raw);
  return value === null ? 0 : Math.min(MAX_SLOW_MS, Math.max(0, value));
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
    shot: parseBool(params, 'shot'),
    diag: parseBool(params, 'diag'),
    hud: parseBool(params, 'hud'),
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
    count: parseCount(params.get('count')),
    nocache: parseBool(params, 'nocache'),
    cache: parseBool(params, 'cache'),
    painting: parseId(params.get('painting')),
    bare: parseBool(params, 'bare'),
    coverage: parseBool(params, 'coverage'),
    painter: parseBool(params, 'painter'),
  });
}

export const flags: Flags = parseFlags(typeof location === 'undefined' ? '' : location.search);
