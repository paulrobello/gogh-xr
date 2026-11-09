import { describe, expect, it } from 'vitest';
import {
  CHUNK_BUDGETS,
  type ChunkBudget,
  checkBudgets,
  chunkStem,
  formatReport,
} from '../scripts/bundle-budget';

const budgets: ChunkBudget[] = [{ pattern: /^index$/, label: 'index', maxGzipBytes: 1000 }];

describe('chunkStem', () => {
  it('strips the content hash and any directory', () => {
    expect(chunkStem('index-DVmV6lk6.js')).toBe('index');
    expect(chunkStem('assets/three.core-Dxy2Mv33.js')).toBe('three.core');
    expect(chunkStem('test-scene-B2gCNTE-.js')).toBe('test-scene');
  });
});

describe('checkBudgets', () => {
  it('passes when every chunk and the total are under budget', () => {
    const result = checkBudgets(
      [
        { name: 'index-AAAAAAAA.js', gzipBytes: 900 },
        { name: 'misc-BBBBBBBB.js', gzipBytes: 100 },
      ],
      budgets,
      200,
      1100,
    );
    expect(result.ok).toBe(true);
    expect(result.rows.map((r) => r.over)).toEqual([false, false]);
  });

  it('fails a chunk over its own budget', () => {
    const result = checkBudgets(
      [{ name: 'index-AAAAAAAA.js', gzipBytes: 1001 }],
      budgets,
      200,
      5000,
    );
    expect(result.ok).toBe(false);
    expect(result.rows[0]).toMatchObject({ budget: 1000, over: true });
    expect(formatReport(result)[0]).toContain('OVER index-AAAAAAAA.js 1001 / 1000');
  });

  it('fails when the total is over budget though every chunk is under', () => {
    const result = checkBudgets(
      [
        { name: 'index-AAAAAAAA.js', gzipBytes: 900 },
        { name: 'misc-BBBBBBBB.js', gzipBytes: 150 },
      ],
      budgets,
      200,
      1000,
    );
    expect(result.rows.every((r) => !r.over)).toBe(true);
    expect(result.total.over).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('holds an unmatched new chunk to the default per-chunk budget', () => {
    const under = checkBudgets([{ name: 'fresh-CCCCCCCC.js', gzipBytes: 200 }], budgets, 200, 5000);
    expect(under.rows[0]).toMatchObject({ budget: 200, over: false });
    const over = checkBudgets([{ name: 'fresh-CCCCCCCC.js', gzipBytes: 201 }], budgets, 200, 5000);
    expect(over.ok).toBe(false);
  });
});

describe('the real budget table', () => {
  const budgetOf = (name: string): number | undefined =>
    checkBudgets([{ name, gzipBytes: 0 }]).rows[0]?.budget;

  it('gives the index chunk its own 160,000 byte budget', () => {
    expect(CHUNK_BUDGETS.length).toBeGreaterThan(0);
    expect(budgetOf('index-XXXXXXXX.js')).toBe(160_000);
  });

  it('gives a named vendor chunk its own budget and a lazy world chunk the default', () => {
    expect(budgetOf('troika-config-XXXXXXXX.js')).toBe(50_000);
    expect(budgetOf('starry-night-XXXXXXXX.js')).toBe(30_000);
  });

  it('passes a chunk exactly at its budget and fails one byte over', () => {
    expect(checkBudgets([{ name: 'index-XXXXXXXX.js', gzipBytes: 160_000 }]).rows[0]?.over).toBe(
      false,
    );
    expect(checkBudgets([{ name: 'index-XXXXXXXX.js', gzipBytes: 160_001 }]).rows[0]?.over).toBe(
      true,
    );
  });

  it('passes a total exactly at its budget and fails one byte over', () => {
    const at = checkBudgets(
      [{ name: 'index-XXXXXXXX.js', gzipBytes: 160_000 }],
      [],
      200_000,
      160_000,
    );
    const over = checkBudgets(
      [{ name: 'index-XXXXXXXX.js', gzipBytes: 160_001 }],
      [],
      200_000,
      160_000,
    );
    expect(at.ok).toBe(true);
    expect(over.ok).toBe(false);
  });
});
