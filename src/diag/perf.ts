/**
 * The `?perf` frame recorder: every animation frame's interval goes into a preallocated ring, and
 * the session is cut into windows. A window closes, and the next opens, on `__goghPerfMark`, on
 * every A/B switch, on XR session start and end, and on a quality-level change (main.ts). Each
 * window leaves out its first `PERF_SETTLE_MS` of frames, then closes into a summary. Summaries
 * persist to localStorage once per close, never per frame.
 *
 * Loaded only behind the flag (a dynamic import in main.ts), so a boot without `?perf` carries
 * none of it and does no per-frame work for it.
 */

/** Intervals the ring holds: about 24 minutes at 90 Hz, 512 KB of float32. */
export const PERF_RING_FRAMES = 131_072;
/** Each window's first frames, by their timestamps from its first frame, are not counted. */
export const PERF_SETTLE_MS = 1000;
/** Summaries kept in memory and in storage. */
export const PERF_MAX_WINDOWS = 200;
/** A frame counts as over budget past this multiple of the budget: at least one missed vsync. */
export const PERF_OVER_FACTOR = 1.5;
/** A frame counts as over twice the budget past this multiple: at least two missed vsyncs. */
export const PERF_OVER_2X_FACTOR = 2.5;
/** A hand counts toward its speed spread above this speed, m/s. */
export const PERF_HAND_MIN_SPEED = 0.3;
export const PERF_STORAGE_NAME = 'gogh-xr.perf.v1';
/** The stored list never passes this many characters of JSON: the oldest windows go first. */
export const PERF_STORAGE_MAX_CHARS = 400_000;

export interface HandSpeedStats {
  /** Frames this hand was tracked above PERF_HAND_MIN_SPEED. */
  readonly n: number;
  readonly meanMps: number | null;
  readonly sdMps: number | null;
  /** sd / mean. */
  readonly cv: number | null;
  /**
   * RMS of the speed's change between consecutive counted frames, over the mean speed. Only pairs
   * of back-to-back frames both above the threshold count.
   */
  readonly jitterRms: number | null;
}

/** What main.ts reports about the app around a window. */
export interface PerfContext {
  /** The active A/B group and its variant, or null with none. */
  readonly group: string | null;
  readonly variant: string | null;
  /** The XR target frame rate, or null on the desktop. */
  readonly targetHz: number | null;
  /** The governor's fixed level, or 'auto'. null with no governor. */
  readonly level: number | 'auto' | null;
  /** The governor's live level (steps shed), or null with no governor. */
  readonly liveLevel: number | null;
  readonly foveation: number | null;
  readonly painting: string | null;
  readonly buildId: string | null;
}

export interface PerfSummary {
  /** Why the window opened: `boot`, a mark's label, `ab <group>=<variant>`, `xr-start`, ... */
  readonly label: string;
  /** Why it closed, the next window's label; null for the live window. */
  readonly closedBy: string | null;
  readonly group: string | null;
  readonly variant: string | null;
  /** performance.now() at the window's first frame. Resets on a reload. */
  readonly startMs: number;
  /** Date.now() at the window's first frame, which survives a reload. */
  readonly wallMs: number;
  /** Sum of the counted intervals. */
  readonly durationMs: number;
  /** Counted frames: after the settle. */
  readonly frames: number;
  /** True when every counted frame presented in XR. */
  readonly presenting: boolean;
  readonly targetHz: number | null;
  readonly budgetMs: number | null;
  readonly meanMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number | null;
  /** Share of counted frames over PERF_OVER_FACTOR × budget, percent; null without a budget. */
  readonly overBudgetPct: number | null;
  /** Share over PERF_OVER_2X_FACTOR × budget, percent. */
  readonly over2xBudgetPct: number | null;
  readonly fps: number | null;
  readonly level: number | 'auto' | null;
  readonly liveLevel: number | null;
  readonly foveation: number | null;
  readonly painting: string | null;
  readonly buildId: string | null;
  /** Per hand disturber: reactive tracker slots 1 and 2, in that order. */
  readonly handSpeed: readonly [HandSpeedStats, HandSpeedStats];
  /** The window held more frames than the ring: its stats cover the last PERF_RING_FRAMES. */
  readonly truncated: boolean;
}

export interface PerfStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PerfRecorderOptions {
  /**
   * The live context. `presenting` is the window's own state (its first frame's when it opens,
   * whether all its counted frames presented when it closes), because three flips
   * `isPresenting` before it dispatches `sessionstart` and `sessionend`, so the state at a close
   * on those events belongs to the next window.
   */
  readonly context: (presenting: boolean) => PerfContext;
  readonly storage?: PerfStorage | null;
  readonly now?: () => number;
  readonly wallNow?: () => number;
  readonly ringFrames?: number;
  readonly settleMs?: number;
  readonly maxWindows?: number;
}

export interface PerfRecorder {
  /** One animation frame at rAF time `timeMs` (XR's while presenting). A few stores, no allocation. */
  frame(timeMs: number, presenting: boolean): void;
  /** Hand slot `hand` (0 or 1) this frame: its tracker speed, or tracked false. */
  hand(hand: number, tracked: boolean, speedMps: number): void;
  /** Closes the open window into a summary and opens the next, labelled `label`. */
  mark(label?: string): void;
  windows(): PerfSummary[];
  /** The open window as it would close now. */
  current(): PerfSummary;
  /** Empties the list, in memory and in storage. The open window keeps running. */
  clear(): void;
}

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted: ArrayLike<number>, p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const rank = Math.ceil((p / 100) * n);
  return sorted[Math.min(n - 1, Math.max(0, rank - 1))];
}

/** Running sums for one hand: Welford mean and variance, plus the frame-to-frame differences. */
class HandAccumulator {
  n = 0;
  mean = 0;
  m2 = 0;
  diffN = 0;
  diffSq = 0;
  private last = Number.NaN;

  add(tracked: boolean, speed: number): void {
    if (!tracked || !(speed > PERF_HAND_MIN_SPEED)) {
      this.last = Number.NaN;
      return;
    }
    this.n += 1;
    const d = speed - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (speed - this.mean);
    if (!Number.isNaN(this.last)) {
      const step = speed - this.last;
      this.diffN += 1;
      this.diffSq += step * step;
    }
    this.last = speed;
  }

  reset(): void {
    this.n = 0;
    this.mean = 0;
    this.m2 = 0;
    this.diffN = 0;
    this.diffSq = 0;
    this.last = Number.NaN;
  }

  stats(): HandSpeedStats {
    if (this.n === 0) return { n: 0, meanMps: null, sdMps: null, cv: null, jitterRms: null };
    const sd = this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0;
    return {
      n: this.n,
      meanMps: this.mean,
      sdMps: sd,
      cv: this.mean > 0 ? sd / this.mean : null,
      jitterRms:
        this.diffN > 0 && this.mean > 0 ? Math.sqrt(this.diffSq / this.diffN) / this.mean : null,
    };
  }
}

function loadStored(storage: PerfStorage | null): PerfSummary[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PERF_STORAGE_NAME);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const windows = (parsed as { version?: unknown; windows?: unknown })?.windows;
    if ((parsed as { version?: unknown }).version !== 1 || !Array.isArray(windows)) return [];
    return windows as PerfSummary[];
  } catch {
    return [];
  }
}

/** The JSON stored for `windows`, dropping the oldest until it fits `maxChars`. */
export function storedJson(windows: readonly PerfSummary[], maxChars: number): string {
  let start = 0;
  let json = JSON.stringify({ version: 1, windows });
  while (json.length > maxChars && start < windows.length) {
    start += Math.max(1, Math.ceil((windows.length - start) / 10));
    json = JSON.stringify({ version: 1, windows: windows.slice(start) });
  }
  return json;
}

export function createPerfRecorder(options: PerfRecorderOptions): PerfRecorder {
  const ringFrames = options.ringFrames ?? PERF_RING_FRAMES;
  const settleMs = options.settleMs ?? PERF_SETTLE_MS;
  const maxWindows = options.maxWindows ?? PERF_MAX_WINDOWS;
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  const storage = options.storage ?? null;
  const ring = new Float32Array(ringFrames);
  const scratch = new Float32Array(ringFrames);
  const hands = [new HandAccumulator(), new HandAccumulator()];
  const windows: PerfSummary[] = loadStored(storage).slice(-maxWindows);

  /** Frames ever written to the ring. */
  let written = 0;
  let lastTime: number | null = null;
  let label = 'boot';
  /** The open window's first frame time, or null until its first frame. */
  let openTime: number | null = null;
  let startMs = 0;
  let wallMs = 0;
  /** Ring index (in `written`) of the window's first counted frame, or -1 while settling. */
  let countFrom = -1;
  let presentingFrames = 0;
  let open: PerfContext | null = null;

  function frame(timeMs: number, presenting: boolean): void {
    const previous = lastTime;
    lastTime = timeMs;
    if (openTime === null) {
      openTime = timeMs;
      startMs = now();
      wallMs = wallNow();
      open = options.context(presenting);
      return;
    }
    if (previous === null || !(timeMs > previous)) return;
    if (countFrom < 0) {
      if (timeMs - openTime < settleMs) return;
      countFrom = written;
    }
    ring[written % ringFrames] = timeMs - previous;
    written += 1;
    if (presenting) presentingFrames += 1;
  }

  function hand(index: number, tracked: boolean, speed: number): void {
    if (countFrom < 0) return;
    hands[index]?.add(tracked, speed);
  }

  function summarise(closedBy: string | null): PerfSummary {
    const counted = countFrom < 0 ? 0 : written - countFrom;
    const n = Math.min(counted, ringFrames);
    const presenting = n > 0 && presentingFrames >= counted;
    const ctx = options.context(presenting);
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const v = ring[(written - n + i) % ringFrames];
      scratch[i] = v;
      sum += v;
    }
    const sorted = scratch.subarray(0, n).sort();
    const targetHz = ctx.targetHz;
    const budgetMs = targetHz && targetHz > 0 ? 1000 / targetHz : null;
    let over = 0;
    let over2 = 0;
    if (budgetMs !== null) {
      for (let i = 0; i < n; i += 1) {
        if (sorted[i] > budgetMs * PERF_OVER_FACTOR) over += 1;
        if (sorted[i] > budgetMs * PERF_OVER_2X_FACTOR) over2 += 1;
      }
    }
    const pct = (k: number): number | null => (budgetMs === null || n === 0 ? null : (100 * k) / n);
    return {
      label,
      closedBy,
      group: open?.group ?? ctx.group,
      variant: open?.variant ?? ctx.variant,
      startMs,
      wallMs,
      durationMs: sum,
      frames: n,
      presenting,
      targetHz,
      budgetMs,
      meanMs: n > 0 ? sum / n : null,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      maxMs: n > 0 ? sorted[n - 1] : null,
      overBudgetPct: pct(over),
      over2xBudgetPct: pct(over2),
      fps: n > 0 && sum > 0 ? (1000 * n) / sum : null,
      level: open?.level ?? ctx.level,
      liveLevel: ctx.liveLevel,
      foveation: ctx.foveation,
      painting: ctx.painting,
      buildId: ctx.buildId,
      handSpeed: [hands[0].stats(), hands[1].stats()],
      truncated: counted > ringFrames,
    };
  }

  function persist(): void {
    if (!storage) return;
    try {
      storage.setItem(PERF_STORAGE_NAME, storedJson(windows, PERF_STORAGE_MAX_CHARS));
    } catch {
      // Quota or storage off: the in-memory list still holds the windows.
    }
  }

  return {
    frame,
    hand,
    mark(next = 'mark') {
      if (openTime !== null) {
        const summary = summarise(next);
        // A window closed inside its settle measured nothing.
        if (summary.frames > 0) {
          windows.push(summary);
          if (windows.length > maxWindows) windows.splice(0, windows.length - maxWindows);
          persist();
        }
      }
      label = next;
      openTime = null;
      countFrom = -1;
      presentingFrames = 0;
      open = null;
      hands[0].reset();
      hands[1].reset();
    },
    windows: () => [...windows],
    current: () => summarise(null),
    clear() {
      windows.length = 0;
      if (!storage) return;
      try {
        storage.removeItem(PERF_STORAGE_NAME);
      } catch {
        // Storage off: nothing to remove.
      }
    },
  };
}
