import { expect, test } from 'vitest';
import {
  BENCH_MAX,
  CHUNK_SIZE,
  chunkCounts,
  DEFAULT_BENCH_N,
  DEFAULT_SEED,
  DEFAULT_SIZE_PX,
  defaultOrder,
  parseBenchCount,
  resolveBenchConfig,
  resolveSeed,
  stepCount,
} from '../src/bench/config.ts';
import { parseFlags } from '../src/diag/flags.ts';

test('chunk size is 64k', () => {
  expect(CHUNK_SIZE).toBe(65536);
});

test('chunking splits N into full 64k chunks plus a remainder', () => {
  expect(chunkCounts(0)).toEqual([]);
  expect(chunkCounts(1)).toEqual([1]);
  expect(chunkCounts(65535)).toEqual([65535]);
  expect(chunkCounts(65536)).toEqual([65536]);
  expect(chunkCounts(65537)).toEqual([65536, 1]);
  expect(chunkCounts(100000)).toEqual([65536, 34464]);
  expect(chunkCounts(131073)).toEqual([65536, 65536, 1]);
  const million = chunkCounts(1_000_000);
  expect(million).toHaveLength(16);
  expect(million.slice(0, 15).every((c) => c === 65536)).toBe(true);
  expect(million[15]).toBe(16960);
});

test('chunk counts always sum to N', () => {
  for (const n of [0, 7, 65536, 99999, 250000, 1_048_576]) {
    expect(chunkCounts(n).reduce((a, b) => a + b, 0)).toBe(n);
  }
});

test('chunking clamps negatives and floors fractions', () => {
  expect(chunkCounts(-5)).toEqual([]);
  expect(chunkCounts(10.9)).toEqual([10]);
  expect(chunkCounts(10, 4)).toEqual([4, 4, 2]);
});

test('bench count parses a non-negative integer, otherwise the default', () => {
  expect(parseBenchCount('100000')).toBe(100000);
  expect(parseBenchCount('0')).toBe(0);
  for (const bad of ['strokes', '1e5', '-5', '12.5', '100k']) {
    expect(parseBenchCount(bad)).toBe(DEFAULT_BENCH_N);
  }
});

test('seed coerces to uint32 and defaults when absent', () => {
  expect(resolveSeed(null)).toBe(DEFAULT_SEED);
  expect(resolveSeed(42)).toBe(42);
  expect(resolveSeed(1.9)).toBe(1);
  expect(resolveSeed(-1)).toBe(4294967295);
});

test('config is null without ?bench and resolves defaults with it', () => {
  expect(resolveBenchConfig(parseFlags('?diag'))).toBeNull();
  expect(resolveBenchConfig(parseFlags('?bench=100000'))).toEqual({
    n: 100000,
    mode: 'a2c',
    order: 'random',
    sizePx: DEFAULT_SIZE_PX,
    seed: DEFAULT_SEED,
  });
  expect(resolveBenchConfig(parseFlags('?bench=5000&mode=blend&size=8&seed=3'))).toEqual({
    n: 5000,
    mode: 'blend',
    order: 'sorted',
    sizePx: 8,
    seed: 3,
  });
});

test('order defaults to random for a2c and sorted for blend, and ?order overrides it', () => {
  expect(defaultOrder('a2c')).toBe('random');
  expect(defaultOrder('blend')).toBe('sorted');
  expect(resolveBenchConfig(parseFlags('?bench=1&order=sorted'))?.order).toBe('sorted');
  expect(resolveBenchConfig(parseFlags('?bench=1&mode=blend&order=random'))?.order).toBe('random');
});

test('stick steps move N by 25k and clamp at zero', () => {
  expect(stepCount(100000, 1)).toBe(125000);
  expect(stepCount(100000, -1)).toBe(75000);
  expect(stepCount(10000, -1)).toBe(0);
  expect(stepCount(0, -1)).toBe(0);
});

test('bench count and stick stepping clamp to BENCH_MAX', () => {
  expect(BENCH_MAX).toBe(2_000_000);
  expect(parseBenchCount('2000000')).toBe(BENCH_MAX);
  expect(parseBenchCount('999999999999')).toBe(BENCH_MAX);
  expect(parseBenchCount('1999999')).toBe(1_999_999);
  expect(stepCount(BENCH_MAX - 1, 1)).toBe(BENCH_MAX);
  expect(stepCount(BENCH_MAX, 4)).toBe(BENCH_MAX);
  expect(resolveBenchConfig(parseFlags('?bench=9999999999'))?.n).toBe(BENCH_MAX);
});
