import type { BenchMode, BenchOrder } from '../diag/flags';
import { FOVEATION } from '../xr/session';

export const RESULTS_STORAGE_NAME = 'gogh-xr.bench.results.v1';
/** Oldest results drop off past this many, so localStorage stays small. */
export const MAX_RESULTS = 200;

/** One full measured window (no settling) for one combination of settings. */
export interface BenchResult {
  readonly mode: BenchMode;
  readonly order: BenchOrder;
  readonly n: number;
  readonly sizePx: number;
  readonly targetHz: number;
  /** Fixed foveation, 0 to 1. Results stored before it was recorded ran at the app default. */
  readonly foveation?: number;
  /** The rate the session reported, which differs from the target when the request was refused. */
  readonly currentHz: number | null;
  readonly fps: number;
  readonly meanMs: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly recordedAt: string;
}

export interface ResultStore {
  load(): BenchResult[];
  save(results: readonly BenchResult[]): void;
}

export function resultKey(r: BenchResult): string {
  return [r.mode, r.order, r.n, r.sizePx, r.targetHz, r.foveation ?? FOVEATION].join('|');
}

/** Replaces any earlier result for the same settings and moves it to the end. */
export function upsertResult(results: readonly BenchResult[], next: BenchResult): BenchResult[] {
  const key = resultKey(next);
  const kept = results.filter((r) => resultKey(r) !== key);
  kept.push(next);
  return kept.slice(-MAX_RESULTS);
}

function isResult(value: unknown): value is BenchResult {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.mode === 'string' &&
    typeof r.order === 'string' &&
    typeof r.n === 'number' &&
    typeof r.sizePx === 'number' &&
    typeof r.targetHz === 'number'
  );
}

/** A store over `localStorage`. Unavailable or corrupt storage reads as empty and drops writes. */
export function localResultStore(storage: Storage | undefined): ResultStore {
  return {
    load: () => {
      try {
        const parsed: unknown = JSON.parse(storage?.getItem(RESULTS_STORAGE_NAME) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter(isResult) : [];
      } catch {
        return [];
      }
    },
    save: (results) => {
      try {
        storage?.setItem(RESULTS_STORAGE_NAME, JSON.stringify(results));
      } catch {
        // Quota or private-mode failures lose only the record, never the benchmark.
      }
    },
  };
}

function ms(value: number | null): string {
  return value === null ? '--' : value.toFixed(2);
}

export function formatResultLine(r: BenchResult): string {
  const n = r.n.toLocaleString('en-US');
  const fov = r.foveation ?? FOVEATION;
  return `${r.mode} ${n} ${r.targetHz}/${r.currentHz ?? '?'}Hz f${fov} fps ${r.fps} p95 ${ms(r.p95Ms)} p99 ${ms(r.p99Ms)}`;
}
