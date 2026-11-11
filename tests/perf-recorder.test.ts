import { describe, expect, it } from 'vitest';
import {
  createPerfRecorder,
  PERF_HAND_MIN_SPEED,
  PERF_MAX_WINDOWS,
  PERF_STORAGE_NAME,
  type PerfContext,
  type PerfStorage,
  percentile,
  storedJson,
} from '../src/diag/perf';

function memoryStorage(): PerfStorage & { map: Map<string, string>; writes: number } {
  const map = new Map<string, string>();
  const store = {
    map,
    writes: 0,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.writes += 1;
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
  return store;
}

const BASE: PerfContext = {
  group: null,
  variant: null,
  targetHz: 72,
  level: 5,
  liveLevel: 5,
  foveation: 0,
  painting: 'starry-night',
  buildId: 'abc/def',
};

/** Runs `count` frames `stepMs` apart from `startMs`, returning the last frame time. */
function run(
  rec: ReturnType<typeof createPerfRecorder>,
  startMs: number,
  count: number,
  stepMs: number | ((i: number) => number),
  presenting = true,
): number {
  let t = startMs;
  for (let i = 0; i < count; i += 1) {
    rec.frame(t, presenting);
    t += typeof stepMs === 'number' ? stepMs : stepMs(i);
  }
  return t - (typeof stepMs === 'number' ? stepMs : stepMs(count - 1));
}

describe('percentile', () => {
  it('is nearest rank on sorted data, null when empty', () => {
    const sorted = Float32Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('createPerfRecorder', () => {
  it('excludes the settle, and summarises intervals, percentiles and the over-budget shares', () => {
    let ctx: PerfContext = BASE;
    const rec = createPerfRecorder({ context: () => ctx, settleMs: 1000, now: () => 0 });
    // 1.2 s of 100 ms frames inside the settle, then 100 frames: 90 at 13.9, 8 at 27.8, 2 at 40.
    let t = run(rec, 0, 13, 100);
    const steps = [...Array(90).fill(13.9), ...Array(8).fill(27.8), 40, 40];
    for (const step of steps) {
      t += step;
      rec.frame(t, true);
    }
    ctx = { ...BASE, liveLevel: 6 };
    rec.mark('next');
    const [w] = rec.windows();
    expect(w.label).toBe('boot');
    expect(w.closedBy).toBe('next');
    // Frames at 1000, 1100 and 1200 ms are 1 s or more past the window's first frame, so their
    // 100 ms intervals count; the ten before them do not.
    expect(w.frames).toBe(103);
    expect(w.presenting).toBe(true);
    expect(w.budgetMs).toBeCloseTo(1000 / 72);
    expect(w.maxMs).toBeCloseTo(100);
    expect(w.p50Ms).toBeCloseTo(13.9, 4);
    // Rank 98 of 103 is the last 27.8, rank 102 one of the 100 ms frames.
    expect(w.p95Ms).toBeCloseTo(27.8, 4);
    expect(w.p99Ms).toBeCloseTo(100, 4);
    // Over 1.5 × budget (20.8 ms): 8 + 2 + 3. Over 2.5 × (34.7 ms): 2 + 3.
    expect(w.overBudgetPct).toBeCloseTo((100 * 13) / 103);
    expect(w.over2xBudgetPct).toBeCloseTo((100 * 5) / 103);
    const sum = 300 + 90 * 13.9 + 8 * 27.8 + 80;
    expect(w.durationMs).toBeCloseTo(sum, 2);
    expect(w.meanMs).toBeCloseTo(sum / 103, 3);
    expect(w.fps).toBeCloseTo((1000 * 103) / sum, 3);
    expect(w.liveLevel).toBe(6);
    expect(w.truncated).toBe(false);
  });

  it('closes on every mark, labels the next window, and keeps the variant each window measured', () => {
    let ctx: PerfContext = { ...BASE, group: 'reactive', variant: 'on' };
    const rec = createPerfRecorder({ context: () => ctx, settleMs: 0 });
    let t = run(rec, 0, 50, 10);
    // An A/B switch: the controller cycles, then main.ts marks.
    ctx = { ...ctx, variant: 'off' };
    rec.mark('ab reactive=off');
    t = run(rec, t + 10, 50, 10);
    rec.mark('mark');
    const windows = rec.windows();
    expect(windows.map((w) => [w.label, w.variant, w.closedBy])).toEqual([
      ['boot', 'on', 'ab reactive=off'],
      ['ab reactive=off', 'off', 'mark'],
    ]);
    // The first frame of each window only opens it: 49 intervals each.
    expect(windows.map((w) => w.frames)).toEqual([49, 49]);
  });

  it('drops a window closed inside its settle, and reports no budget on the desktop', () => {
    const rec = createPerfRecorder({ context: () => ({ ...BASE, targetHz: null }) });
    run(rec, 0, 30, 16.7, false);
    rec.mark('a');
    expect(rec.windows()).toEqual([]);
    run(rec, 1000, 200, 16.7, false);
    rec.mark('b');
    const [w] = rec.windows();
    expect(w.presenting).toBe(false);
    expect(w.budgetMs).toBeNull();
    expect(w.overBudgetPct).toBeNull();
    expect(w.p50Ms).toBeCloseTo(16.7, 4);
  });

  it("takes the budget from the window's own frames when the live state flips before the close", () => {
    // three sets isPresenting before it dispatches sessionstart and sessionend, so a context read
    // of the live state at those closes would give each window the next window's budget.
    let live = false;
    const context = (presenting: boolean): PerfContext => ({
      ...BASE,
      targetHz: presenting ? 72 : null,
    });
    const rec = createPerfRecorder({ context, settleMs: 0 });
    let t = run(rec, 0, 50, 16.7, live);
    live = true;
    rec.mark('xr-start');
    t = run(rec, t + 16.7, 50, 13.9, live);
    live = false;
    rec.mark('xr-end');
    const [desktop, xr] = rec.windows();
    expect(desktop.presenting).toBe(false);
    expect(desktop.budgetMs).toBeNull();
    expect(desktop.overBudgetPct).toBeNull();
    expect(xr.presenting).toBe(true);
    expect(xr.targetHz).toBe(72);
    expect(xr.budgetMs).toBeCloseTo(1000 / 72);
    expect(xr.overBudgetPct).toBe(0);
    expect(t).toBeGreaterThan(0);
  });

  it('keeps only the last ring of a window longer than the ring', () => {
    const rec = createPerfRecorder({ context: () => BASE, settleMs: 0, ringFrames: 16 });
    let t = run(rec, 0, 20, 10);
    t = run(rec, t + 50, 16, 50);
    rec.mark();
    const [w] = rec.windows();
    expect(w.truncated).toBe(true);
    expect(w.frames).toBe(16);
    expect(w.meanMs).toBeCloseTo(50);
  });

  it('persists once per close, bounds the list, survives a reload and clears', () => {
    const storage = memoryStorage();
    const rec = createPerfRecorder({ context: () => BASE, settleMs: 0, storage });
    let t = 0;
    for (let i = 0; i < PERF_MAX_WINDOWS + 5; i += 1) {
      t = run(rec, t + 10, 5, 10);
      rec.mark(`w${i + 1}`);
    }
    expect(storage.writes).toBe(PERF_MAX_WINDOWS + 5);
    expect(rec.windows()).toHaveLength(PERF_MAX_WINDOWS);
    const stored = JSON.parse(storage.map.get(PERF_STORAGE_NAME) ?? '{}');
    expect(stored.version).toBe(1);
    expect(stored.windows).toHaveLength(PERF_MAX_WINDOWS);
    expect(stored.windows[0].label).toBe('w5');
    const reloaded = createPerfRecorder({ context: () => BASE, storage });
    expect(reloaded.windows()).toHaveLength(PERF_MAX_WINDOWS);
    // Frames alone never write.
    const before = storage.writes;
    run(reloaded, 0, 100, 10);
    expect(storage.writes).toBe(before);
    reloaded.clear();
    expect(reloaded.windows()).toEqual([]);
    expect(storage.map.has(PERF_STORAGE_NAME)).toBe(false);
  });

  it('drops the oldest windows when the stored JSON passes the size bound', () => {
    const rec = createPerfRecorder({ context: () => BASE, settleMs: 0 });
    let t = 0;
    for (let i = 0; i < 20; i += 1) {
      t = run(rec, t + 10, 5, 10);
      rec.mark();
    }
    const all = rec.windows();
    const full = storedJson(all, 1e9);
    const bounded = storedJson(all, full.length / 2);
    expect(bounded.length).toBeLessThanOrEqual(full.length / 2);
    const kept = JSON.parse(bounded).windows;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.at(-1)).toEqual(JSON.parse(JSON.stringify(all.at(-1))));
  });

  it('summarises each hand speed above the threshold: mean, sd, cv and frame-to-frame jitter', () => {
    const rec = createPerfRecorder({ context: () => BASE, settleMs: 0 });
    rec.frame(0, true);
    const speeds = [1, 1.2, 0.8, 1.2, 0.8];
    let t = 0;
    for (const s of speeds) {
      t += 10;
      rec.frame(t, true);
      rec.hand(0, true, s);
      rec.hand(1, false, 5);
    }
    // Below the threshold breaks the chain of differences, and adds nothing.
    t += 10;
    rec.frame(t, true);
    rec.hand(0, true, PERF_HAND_MIN_SPEED / 2);
    t += 10;
    rec.frame(t, true);
    rec.hand(0, true, 1);
    rec.mark();
    const [left, right] = rec.windows()[0].handSpeed;
    const all = [...speeds, 1];
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    const sd = Math.sqrt(all.reduce((a, b) => a + (b - mean) ** 2, 0) / (all.length - 1));
    expect(left.n).toBe(6);
    expect(left.meanMps).toBeCloseTo(mean, 10);
    expect(left.sdMps).toBeCloseTo(sd, 10);
    expect(left.cv).toBeCloseTo(sd / mean, 10);
    // Differences 0.2, -0.4, 0.4, -0.4 inside the first run; none across the break.
    const rms = Math.sqrt((0.04 + 0.16 + 0.16 + 0.16) / 4);
    expect(left.jitterRms).toBeCloseTo(rms / mean, 10);
    expect(right).toEqual({ n: 0, meanMps: null, sdMps: null, cv: null, jitterRms: null });
  });

  it('counts no hand speed inside the settle, and restarts the hand stats per window', () => {
    const rec = createPerfRecorder({ context: () => BASE, settleMs: 1000 });
    rec.frame(0, true);
    rec.frame(500, true);
    rec.hand(0, true, 2);
    rec.frame(1200, true);
    rec.hand(0, true, 1);
    rec.mark();
    expect(rec.windows()[0].handSpeed[0].n).toBe(1);
    rec.frame(2000, true);
    rec.frame(3100, true);
    rec.mark();
    expect(rec.windows()[1].handSpeed[0].n).toBe(0);
  });
});
