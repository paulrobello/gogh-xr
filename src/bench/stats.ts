export const FRAME_WINDOW = 360;
/** Intervals ignored after construction or reset: shader compile, buffer upload, first-draw stalls. */
export const WARMUP_INTERVALS = 10;
const FPS_WINDOW_MS = 1000;

/**
 * Rolling frame timing. FPS counts render callbacks in the last second. Mean and p99 use the last
 * 360 measured intervals, skipping warm-up intervals and any interval excluded with `exclude()`.
 */
export class FrameStats {
  private readonly intervals: number[] = [];
  private readonly stamps: number[] = [];
  private last: number | null = null;
  private skip: number;
  private sinceExclude = 0;

  constructor(
    private readonly capacity: number = FRAME_WINDOW,
    private readonly warmup: number = WARMUP_INTERVALS,
  ) {
    this.skip = warmup;
  }

  record(timeMs: number): void {
    if (this.last !== null) {
      if (this.skip > 0) {
        this.skip--;
      } else {
        this.intervals.push(timeMs - this.last);
        if (this.intervals.length > this.capacity) this.intervals.shift();
      }
    }
    this.last = timeMs;
    this.sinceExclude++;
    this.stamps.push(timeMs);
    while (this.stamps.length > 0 && (this.stamps[0] ?? timeMs) <= timeMs - FPS_WINDOW_MS) {
      this.stamps.shift();
    }
  }

  /**
   * Leaves the next `count` intervals out of mean and p99 (FPS still counts them). A call made
   * with no more than `count` frames since the last one is ignored: a HUD redraw that lands every
   * frame, below about 4 fps, would otherwise exclude every interval and starve the window.
   */
  exclude(count: number): void {
    if (this.sinceExclude <= count) return;
    this.sinceExclude = 0;
    this.skip = Math.max(this.skip, count);
  }

  reset(): void {
    this.intervals.length = 0;
    this.stamps.length = 0;
    this.last = null;
    this.skip = this.warmup;
    this.sinceExclude = 0;
  }

  /** True until the measured window has refilled after construction or reset. */
  settling(): boolean {
    return this.intervals.length < this.capacity;
  }

  fps(): number {
    return this.stamps.length;
  }

  meanMs(): number | null {
    if (this.intervals.length === 0) return null;
    return this.intervals.reduce((sum, ms) => sum + ms, 0) / this.intervals.length;
  }

  /** Nearest-rank p95. */
  p95Ms(): number | null {
    return this.percentile(0.95);
  }

  /** Nearest-rank p99. */
  p99Ms(): number | null {
    return this.percentile(0.99);
  }

  private percentile(q: number): number | null {
    if (this.intervals.length === 0) return null;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * q) - 1] ?? null;
  }
}
