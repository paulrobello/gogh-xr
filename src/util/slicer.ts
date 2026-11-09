/**
 * Frame-budgeted work (P5.5). A world build behind a portal transition runs as generator steps,
 * and the animation loop calls `frame()` once per frame, which runs queued steps until the frame's
 * budget is spent, so no frame stalls on the build. A step is the work between two `yield`s, so
 * the longest step bounds how far one frame can overrun the budget.
 *
 * Without a slicer (the boot) a build drains its steps at once with `drain`, which is the same
 * work in the same order, so the result is identical.
 */

/** Work split at its `yield`s, returning `T`. */
export type Steps<T> = Generator<void, T, void>;

/** Runs `steps` to the end at once. */
export function drain<T>(steps: Steps<T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

export interface SlicerStats {
  /** Steps run since the last `resetStats`. */
  steps: number;
  /** The longest single step since the last `resetStats`, ms. */
  longestStepMs: number;
  /** The most step time spent in one frame since the last `resetStats`, ms. */
  longestFrameWorkMs: number;
  /** The label of the job whose step was the longest, or null. */
  longestStepLabel: string | null;
  /** The longest single step of each job label since the last `resetStats`, ms; `-` is unlabelled. */
  longestStepByLabel: Record<string, number>;
  /** The step time spent in the last `frame()`, ms. */
  lastFrameWorkMs: number;
}

export interface Slicer {
  /** Runs `steps` across frames, resolving with its result. Jobs run in the order queued. */
  run<T>(steps: Steps<T>, label?: string): Promise<T>;
  /** Runs `work` as one step, on the first frame with budget left. */
  step<T>(work: () => T, label?: string): Promise<T>;
  /** Resolves at the next `frame()` call: the next animation frame. */
  nextFrame(): Promise<void>;
  /**
   * Call once per animation frame: runs queued steps until `budgetMs` is spent, or this frame's
   * own budget when given (the portal's `out` phase, `OUT_BUILD_BUDGET_MS`).
   */
  frame(frameBudgetMs?: number): void;
  /** Queued jobs, the one running included. */
  readonly pending: number;
  readonly stats: SlicerStats;
  resetStats(): void;
}

interface Job {
  readonly steps: Steps<unknown>;
  readonly label: string | null;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export function createSlicer(
  budgetMs: number,
  now: () => number = () => performance.now(),
): Slicer {
  if (!(budgetMs > 0)) throw new RangeError(`slice budget ${budgetMs} must be above 0`);
  const queue: Job[] = [];
  let waiters: (() => void)[] = [];
  const stats: SlicerStats = {
    steps: 0,
    longestStepMs: 0,
    longestFrameWorkMs: 0,
    longestStepLabel: null,
    longestStepByLabel: {},
    lastFrameWorkMs: 0,
  };

  return {
    run<T>(steps: Steps<T>, label?: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          steps,
          label: label ?? null,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });
    },
    step<T>(work: () => T, label?: string): Promise<T> {
      return this.run(
        // biome-ignore lint/correctness/useYield: one step, which runs `work` and returns.
        (function* (): Steps<T> {
          return work();
        })(),
        label,
      );
    },
    nextFrame(): Promise<void> {
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    frame(frameBudgetMs) {
      const woken = waiters;
      waiters = [];
      for (const wake of woken) wake();
      const budget = frameBudgetMs ?? budgetMs;
      const start = now();
      while (queue.length > 0 && now() - start < budget) {
        const job = queue[0];
        const stepStart = now();
        let next: IteratorResult<void, unknown>;
        try {
          next = job.steps.next();
        } catch (error) {
          queue.shift();
          job.reject(error);
          continue;
        }
        stats.steps += 1;
        const took = now() - stepStart;
        if (took > stats.longestStepMs) {
          stats.longestStepMs = took;
          stats.longestStepLabel = job.label;
        }
        const key = job.label ?? '-';
        const longest = stats.longestStepByLabel[key];
        if (longest === undefined || took > longest) stats.longestStepByLabel[key] = took;
        if (next.done) {
          queue.shift();
          job.resolve(next.value);
        }
      }
      stats.lastFrameWorkMs = now() - start;
      stats.longestFrameWorkMs = Math.max(stats.longestFrameWorkMs, stats.lastFrameWorkMs);
    },
    get pending() {
      return queue.length;
    },
    stats,
    resetStats() {
      stats.steps = 0;
      stats.longestStepMs = 0;
      stats.longestFrameWorkMs = 0;
      stats.longestStepLabel = null;
      stats.longestStepByLabel = {};
    },
  };
}
