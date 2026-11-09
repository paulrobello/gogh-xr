/**
 * The build poller (P7.1), ported from mux-xr's `update-check.ts`. It fetches the same-origin
 * `version.json` once at `start()` and then every `intervalMs`. Each request bypasses the cache,
 * is aborted after `timeoutMs` (body included) and never overlaps the one before it.
 *
 * The baseline is `runningBuildId`, the id embedded in the running page, never the first poll,
 * which may already describe a newer build. A manifest with another id is reported once through
 * `onChange`, and a later one with the running id again (a rollback) reports null. A failed,
 * timed-out or malformed poll changes nothing, so an existing notice stays.
 */

export interface UpdateManifest {
  buildId: string;
  version?: string;
}

export interface UpdateCheckerOptions {
  runningBuildId: string;
  url: string;
  onChange: (manifest: UpdateManifest | null) => void;
  intervalMs?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** The cache-busting query value. Default `Date.now`. */
  now?: () => number;
}

export interface UpdateChecker {
  start(): void;
  /** One poll now; joins the poll in flight instead of starting a second. */
  poll(): Promise<void>;
  /** Stops the interval and aborts the request in flight. */
  dispose(): void;
  /** Polls that got a valid manifest. */
  readonly checks: number;
}

export const UPDATE_INTERVAL_MS = 30_000;
export const UPDATE_TIMEOUT_MS = 5_000;
const MAX_BUILD_ID_LENGTH = 256;

export function parseManifest(value: unknown): UpdateManifest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as { buildId?: unknown; version?: unknown };
  if (typeof candidate.buildId !== 'string') return null;
  const buildId = candidate.buildId.trim();
  if (buildId.length === 0 || buildId.length > MAX_BUILD_ID_LENGTH) return null;
  if (candidate.version !== undefined && typeof candidate.version !== 'string') return null;
  return candidate.version === undefined ? { buildId } : { buildId, version: candidate.version };
}

const sameManifest = (a: UpdateManifest | null, b: UpdateManifest | null): boolean =>
  a?.buildId === b?.buildId && a?.version === b?.version;

/** `url` with a `t` query that a CDN cannot have cached (GitHub Pages caches for 10 minutes). */
function bustedUrl(url: string, now: number): string {
  const base = typeof location === 'undefined' ? 'http://localhost/' : location.href;
  const target = new URL(url, base);
  target.searchParams.set('t', String(now));
  return target.href;
}

export function createUpdateChecker({
  runningBuildId,
  url,
  onChange,
  intervalMs = UPDATE_INTERVAL_MS,
  timeoutMs = UPDATE_TIMEOUT_MS,
  fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  now = Date.now,
}: UpdateCheckerOptions): UpdateChecker {
  let disposed = false;
  let started = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let controller: AbortController | undefined;
  let inFlight: Promise<void> | null = null;
  let notice: UpdateManifest | null = null;
  let checks = 0;

  const poll = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    const operation = (async () => {
      const own = new AbortController();
      controller = own;
      const timer = setTimeout(() => own.abort(), timeoutMs);
      try {
        const response = await fetchImpl(bustedUrl(url, now()), {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: own.signal,
        });
        if (disposed || !response.ok) return;
        const manifest = parseManifest(await response.json());
        if (disposed || manifest === null) return;
        checks += 1;
        const next = manifest.buildId === runningBuildId ? null : manifest;
        if (!sameManifest(notice, next)) {
          notice = next;
          onChange(next);
        }
      } catch {
        // Network, timeout, abort and malformed-body failures keep the current notice.
      } finally {
        clearTimeout(timer);
        if (controller === own) controller = undefined;
      }
    })();
    const wrapped: Promise<void> = operation.finally(() => {
      if (inFlight === wrapped) inFlight = null;
    });
    inFlight = wrapped;
    return wrapped;
  };

  return {
    start() {
      if (disposed || started) return;
      started = true;
      void poll();
      interval = setInterval(() => void poll(), intervalMs);
    },
    poll,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (interval !== undefined) clearInterval(interval);
      controller?.abort();
      controller = undefined;
    },
    get checks() {
      return checks;
    },
  };
}
