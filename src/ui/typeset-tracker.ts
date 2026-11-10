/**
 * Tracks whether a troika `BatchedText` has typeset every text change (P5.3). Troika runs a
 * `sync` callback only when some member actually changed, so a sync requested with nothing
 * changed never reports back. The tracker therefore starts a sync, and drops `typeset`, only when
 * a text changed since the last one.
 */
export interface TypesetTracker {
  /** True once every changed text has been typeset. */
  readonly typeset: boolean;
  /** Records that a text changed, so the next `sync` has something to typeset. */
  markDirty(): void;
  /** Starts a sync through `run` if a text changed since the last one; otherwise does nothing. */
  sync(run: (done: () => void) => void): void;
}

export function createTypesetTracker(): TypesetTracker {
  // Dirty from the start: the texts built before the first sync have never been typeset.
  let dirty = true;
  let typeset = false;
  // A callback from a sync superseded by a later one must not report the later texts typeset.
  let generation = 0;
  return {
    get typeset() {
      return typeset;
    },
    markDirty() {
      dirty = true;
    },
    sync(run) {
      if (!dirty) return;
      dirty = false;
      typeset = false;
      const mine = ++generation;
      run(() => {
        if (mine === generation) typeset = true;
      });
    },
  };
}
