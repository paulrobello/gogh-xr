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
}

export type BenchMode = 'a2c' | 'blend';
export type BenchOrder = 'sorted' | 'random';
export type TargetHz = 72 | 90 | 120;

const TARGET_HZ: readonly number[] = [72, 90, 120];

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
  });
}

export const flags: Flags = parseFlags(typeof location === 'undefined' ? '' : location.search);
