/**
 * The update flow (P7.1): the poller drives the `update-ready` notice, and its Reload action.
 *
 * - A new build raises `update-ready`; a rollback to the running build dismisses it.
 * - On the desktop (no XR session presenting, and the page not `busy`: no XR entry or portal
 *   transition under way) a new build reloads by itself, unless the loop guard holds it.
 * - In XR it never reloads by itself. The notice's Reload action ends the session, waits for its
 *   end, flushes the settings save and then navigates. A session that will not end within
 *   `exitTimeoutMs` keeps the page and raises `xr-error`.
 * - `settle()` re-checks the desktop rule once the page is no longer busy or presenting, so an
 *   update that arrived in XR or mid-transition reloads then. A Reload selected while busy waits
 *   for the same `settle()`.
 * - Loop guard: every reload records `{ from, at }` in sessionStorage. The page never reloads by
 *   itself again when it came back running the id it reloaded away from (an inconsistent deploy).
 *   When it reloaded less than `LOOP_GUARD_MS` ago, it waits out the rest of that window and then
 *   settles again, because the poller reports a build only once. The notice and its Reload stay
 *   up meanwhile.
 */
import { createUpdateChecker, type UpdateChecker, type UpdateManifest } from './check';
import { shouldAutoReload } from './policy';
import { reloadAfterXR } from './reload';

export const EXIT_TIMEOUT_MS = 10_000;
export const RELOAD_FAILED_NOTICE = 'Could not leave VR to update. Exit VR, then select Reload.';
/** No second automatic reload within this long of the last one. */
export const LOOP_GUARD_MS = 120_000;
/** The sessionStorage key of the last reload, `{ from, at }`. */
export const LAST_RELOAD_KEY = 'gogh-xr.update.lastReload';

export interface UpdateNotices {
  raiseUpdate(): void;
  dismiss(kind: 'update-ready'): boolean;
  raise(kind: 'xr-error', text: string): void;
}

export interface UpdatesDeps {
  runningBuildId: string;
  url: string;
  notices: UpdateNotices;
  presenting(): boolean;
  /** An XR entry or a portal transition is under way: no navigation until `settle()`. */
  busy(): boolean;
  /** Ends the XR session and resolves once it has ended; resolves at once with none. */
  endSession(): Promise<void>;
  /** Runs right before navigation: the settings save is flushed here. */
  beforeNavigate(): void;
  location: Pick<Location, 'href' | 'replace'>;
  /** Where the loop guard keeps the last reload. Default `sessionStorage`; null disables it. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  fetch?: typeof globalThis.fetch;
  intervalMs?: number;
  timeoutMs?: number;
  exitTimeoutMs?: number;
  now?: () => number;
}

export interface UpdatesDiag {
  running: string;
  /** The newer build the server offers, or null. */
  available: string | null;
  reloading: boolean;
  /** The loop guard held the last automatic reload. */
  guarded: boolean;
  /** Polls that got a valid manifest. */
  checks: number;
}

export interface Updates {
  start(): void;
  /** One poll now. */
  check(): Promise<void>;
  /** The notice's Reload action: ends XR first when presenting. */
  reload(): Promise<void>;
  /** Reloads now if the desktop rule allows it. Call once the page is no longer busy or in XR. */
  settle(): void;
  diag(): UpdatesDiag;
  dispose(): void;
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('XR exit timed out')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function createUpdates(deps: UpdatesDeps): Updates {
  let available: UpdateManifest | null = null;
  let reloading = false;
  let deferred = false;
  let guarded = false;
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const exitTimeoutMs = deps.exitTimeoutMs ?? EXIT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;

  /**
   * Whether the guard holds an automatic reload: `'always'` when the last reload came back to the
   * same build, the ms left of the window when it was too recent, or null when it is clear.
   */
  function loopGuard(): 'always' | number | null {
    try {
      const raw = storage?.getItem(LAST_RELOAD_KEY);
      if (!raw) return null;
      const last = JSON.parse(raw) as { from?: unknown; at?: unknown };
      if (last.from === deps.runningBuildId) return 'always';
      if (typeof last.at !== 'number') return null;
      const left = LOOP_GUARD_MS - (now() - last.at);
      return left > 0 ? left : null;
    } catch {
      return null;
    }
  }

  function recordReload(): void {
    try {
      storage?.setItem(LAST_RELOAD_KEY, JSON.stringify({ from: deps.runningBuildId, at: now() }));
    } catch {
      // Storage refused: the reload still goes ahead, unguarded.
    }
  }

  async function reload(): Promise<void> {
    if (reloading) return;
    if (deps.busy()) {
      deferred = true;
      return;
    }
    deferred = false;
    reloading = true;
    try {
      await reloadAfterXR(
        () =>
          deps.presenting() ? withTimeout(deps.endSession(), exitTimeoutMs) : Promise.resolve(),
        deps.location,
        () => {
          recordReload();
          deps.beforeNavigate();
        },
        now,
      );
    } catch {
      reloading = false;
      deps.notices.raise('xr-error', RELOAD_FAILED_NOTICE);
    }
  }

  function settle(): void {
    if (deferred && !deps.busy()) {
      void reload();
      return;
    }
    if (disposed || !shouldAutoReload(available !== null, deps.presenting(), deps.busy())) return;
    const hold = loopGuard();
    guarded = hold !== null;
    if (hold === null) {
      void reload();
      return;
    }
    if (hold === 'always') return;
    if (retry !== undefined) clearTimeout(retry);
    retry = setTimeout(() => {
      retry = undefined;
      settle();
    }, hold);
  }

  const checker: UpdateChecker = createUpdateChecker({
    runningBuildId: deps.runningBuildId,
    url: deps.url,
    fetch: deps.fetch,
    intervalMs: deps.intervalMs,
    timeoutMs: deps.timeoutMs,
    now: deps.now,
    onChange(manifest) {
      available = manifest;
      if (manifest) deps.notices.raiseUpdate();
      else deps.notices.dismiss('update-ready');
      settle();
    },
  });

  return {
    start: () => checker.start(),
    check: () => checker.poll(),
    reload,
    settle,
    diag: () => ({
      running: deps.runningBuildId,
      available: available?.buildId ?? null,
      reloading,
      guarded,
      checks: checker.checks,
    }),
    dispose: () => {
      disposed = true;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      checker.dispose();
    },
  };
}
