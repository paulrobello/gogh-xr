/**
 * Gzip size budget for the production bundle, run by `make bundle-check`.
 * Limits: only top-level `.js` files in `<dir>/assets/` are measured (no subdirectories, no CSS
 * or other assets). The chunk stem strips a trailing `-` plus 8 alphanumeric/`_`/`-` characters,
 * which assumes Vite's content-hash naming; a different hash length would leave the hash in the
 * stem and every chunk would fall to the default budget.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export type ChunkSize = { name: string; gzipBytes: number };

/** Gzip budget in bytes for one chunk, keyed by its name with the content hash stripped. */
export type ChunkBudget = { pattern: RegExp; label: string; maxGzipBytes: number };

/**
 * Measured 2026-11-09 on debc2bd at the default gzip level: index 136,527, three.core 48,715,
 * troika-config 43,634, tie-key 25,230 (largest of the rest), JS total 323,714 bytes.
 * Each budget is the measured size plus a margin, rounded up to a clean number. After rounding the
 * margins are 14.6% (troika-config) to 18.9% (default, over tie-key): index 17.2%, three.core
 * 14.9%, JS total 15.8%.
 */
export const CHUNK_BUDGETS: readonly ChunkBudget[] = [
  { pattern: /^index$/, label: 'index', maxGzipBytes: 160_000 },
  { pattern: /^three\.core$/, label: 'three.core', maxGzipBytes: 56_000 },
  { pattern: /^troika-config$/, label: 'troika-config', maxGzipBytes: 50_000 },
];
/** Applies to every chunk no pattern above matches, new chunks included. */
export const DEFAULT_CHUNK_BUDGET_BYTES = 30_000;
export const TOTAL_BUDGET_BYTES = 375_000;

export type BudgetRow = { name: string; gzipBytes: number; budget: number; over: boolean };
export type BudgetResult = {
  ok: boolean;
  rows: BudgetRow[];
  total: { gzipBytes: number; budget: number; over: boolean };
};

/** `assets/index-DVmV6lk6.js` and `index-DVmV6lk6.js` both give `index`. Vite hashes are 8 chars. */
export function chunkStem(name: string): string {
  const file = name.slice(name.lastIndexOf('/') + 1);
  const match = /^(.*)-[A-Za-z0-9_-]{8}\.js$/.exec(file);
  return match?.[1] ?? file.replace(/\.js$/, '');
}

export function checkBudgets(
  chunks: readonly ChunkSize[],
  budgets: readonly ChunkBudget[] = CHUNK_BUDGETS,
  defaultBudget: number = DEFAULT_CHUNK_BUDGET_BYTES,
  totalBudget: number = TOTAL_BUDGET_BYTES,
): BudgetResult {
  const rows = chunks.map(({ name, gzipBytes }) => {
    const stem = chunkStem(name);
    const budget = budgets.find((b) => b.pattern.test(stem))?.maxGzipBytes ?? defaultBudget;
    return { name, gzipBytes, budget, over: gzipBytes > budget };
  });
  const totalBytes = rows.reduce((sum, row) => sum + row.gzipBytes, 0);
  const total = { gzipBytes: totalBytes, budget: totalBudget, over: totalBytes > totalBudget };
  return { ok: !total.over && rows.every((row) => !row.over), rows, total };
}

export function measureChunks(dir: string): ChunkSize[] {
  const assets = join(dir, 'assets');
  return readdirSync(assets)
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => ({ name: file, gzipBytes: gzipSync(readFileSync(join(assets, file))).length }));
}

export function formatReport(result: BudgetResult): string[] {
  const line = (name: string, bytes: number, budget: number, over: boolean): string =>
    `bundle-budget: ${over ? 'OVER' : 'ok  '} ${name} ${bytes} / ${budget} gzip bytes`;
  const lines = result.rows.map((r) => line(r.name, r.gzipBytes, r.budget, r.over));
  const t = result.total;
  lines.push(line('JS total', t.gzipBytes, t.budget, t.over));
  return lines;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? 'dist';
  const result = checkBudgets(measureChunks(dir));
  console.log(formatReport(result).join('\n'));
  if (!result.ok) {
    console.error(
      'bundle-budget: over budget, see scripts/bundle-budget.ts and CLAUDE.md gate rules',
    );
    process.exit(1);
  }
}
