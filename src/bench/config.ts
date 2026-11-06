import type { BenchMode, BenchOrder, Flags } from '../diag/flags';

export const CHUNK_SIZE = 65536;
export const DEFAULT_BENCH_N = 100_000;
export const DEFAULT_SIZE_PX = 24;
export const DEFAULT_SEED = 1;
export const N_STEP = 25_000;
/** Upper bound for N from `?bench=` and stick stepping, so a typo cannot allocate unbounded buffers. */
export const BENCH_MAX = 2_000_000;

export interface BenchConfig {
  readonly n: number;
  readonly mode: BenchMode;
  readonly order: BenchOrder;
  readonly sizePx: number;
  readonly seed: number;
}

/** A non-numeric `?bench` value (e.g. `?bench=strokes`) runs the default count. */
export function parseBenchCount(raw: string): number {
  return /^\d+$/.test(raw) ? Math.min(Number(raw), BENCH_MAX) : DEFAULT_BENCH_N;
}

/** a2c defaults to a seeded shuffle (no early-z luck); blend must draw sorted far-to-near. */
export function defaultOrder(mode: BenchMode): BenchOrder {
  return mode === 'blend' ? 'sorted' : 'random';
}

/** Coerces any finite seed, including negative or fractional ones, to a uint32. */
export function resolveSeed(seed: number | null): number {
  return seed === null ? DEFAULT_SEED : Math.trunc(seed) >>> 0;
}

export function resolveBenchConfig(flags: Flags): BenchConfig | null {
  if (flags.bench === null) return null;
  return {
    n: parseBenchCount(flags.bench),
    mode: flags.benchMode,
    order: flags.benchOrder ?? defaultOrder(flags.benchMode),
    sizePx: flags.benchSize ?? DEFAULT_SIZE_PX,
    seed: resolveSeed(flags.seed),
  };
}

/** Per-chunk instance counts: full chunks of `chunkSize`, then the remainder. */
export function chunkCounts(n: number, chunkSize: number = CHUNK_SIZE): number[] {
  const total = Math.max(0, Math.floor(n));
  const counts: number[] = [];
  for (let start = 0; start < total; start += chunkSize) {
    counts.push(Math.min(chunkSize, total - start));
  }
  return counts;
}

export function stepCount(n: number, step: number): number {
  return Math.min(BENCH_MAX, Math.max(0, n + step * N_STEP));
}

/** The next supported rate above `current`, wrapping to the lowest; `current` when none are known. */
export function nextFrameRate(current: number, supported: readonly number[] | null): number {
  if (!supported?.length) return current;
  const sorted = [...supported].sort((a, b) => a - b);
  return sorted.find((rate) => rate > current) ?? sorted[0] ?? current;
}
