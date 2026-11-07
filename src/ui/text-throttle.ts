/**
 * Throttles troika text changes (P5.3). Troika re-typesets a text on the render after its `text`
 * changes, whoever calls `sync`, so the throttle holds the new strings back and assigns them at
 * most once per interval. A forced flush assigns at once.
 */

/** Anything with a settable `text`, such as a troika `Text`. */
export interface TextTarget {
  text: string;
}

export interface TextThrottle {
  /** Queues `value` for `target`. The last value queued before a flush wins. */
  set(target: TextTarget, value: string): void;
  /** Assigns every queued text when forced or once `intervalMs` has passed; true if it did. */
  flush(now: number, force: boolean): boolean;
  readonly pending: boolean;
}

export function createTextThrottle(intervalMs: number): TextThrottle {
  const queued = new Map<TextTarget, string>();
  let last = Number.NEGATIVE_INFINITY;
  return {
    set(target, value) {
      if (target.text === value) queued.delete(target);
      else queued.set(target, value);
    },
    flush(now, force) {
      if (queued.size === 0) return false;
      if (!force && now - last < intervalMs) return false;
      for (const [target, value] of queued) target.text = value;
      queued.clear();
      last = now;
      return true;
    },
    get pending() {
      return queued.size > 0;
    },
  };
}
