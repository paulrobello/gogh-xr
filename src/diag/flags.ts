export interface Flags {
  readonly seed: number | null;
  readonly noanim: boolean;
  readonly shot: number | null;
  readonly diag: boolean;
  readonly hud: boolean;
  readonly iwer: boolean;
  readonly bench: string | null;
}

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

/** Repeated keys resolve to the first occurrence. */
export function parseFlags(search: string): Flags {
  const params = new URLSearchParams(search);
  const shot = parseNumber(params.get('shot'));
  const bench = params.get('bench')?.trim();
  return Object.freeze({
    seed: parseNumber(params.get('seed')),
    noanim: parseBool(params, 'noanim'),
    shot: shot !== null && shot >= 0 ? shot : null,
    diag: parseBool(params, 'diag'),
    hud: parseBool(params, 'hud'),
    iwer: parseBool(params, 'iwer'),
    bench: bench ? bench : null,
  });
}

export const flags: Flags = parseFlags(typeof location === 'undefined' ? '' : location.search);
