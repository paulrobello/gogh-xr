import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createUpdateChecker,
  parseManifest,
  UPDATE_INTERVAL_MS,
  UPDATE_TIMEOUT_MS,
  type UpdateManifest,
} from '../src/update/check';

const response = (body: unknown, ok = true): Response =>
  ({ ok, json: async () => body }) as unknown as Response;

type FetchArgs = [RequestInfo | URL, RequestInit | undefined];

describe('update checker', () => {
  afterEach(() => vi.useRealTimers());

  it('polls at once, then every 30 s, with a 5 s timeout and a cache-bypassing request', async () => {
    vi.useFakeTimers();
    expect(UPDATE_INTERVAL_MS).toBe(30_000);
    expect(UPDATE_TIMEOUT_MS).toBe(5_000);
    const calls: FetchArgs[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push([url, init]);
      return response({ buildId: 'running' });
    });
    let t = 1000;
    const checker = createUpdateChecker({
      runningBuildId: 'running',
      url: 'https://host/version.json',
      fetch: fetchMock,
      onChange: () => {},
      now: () => t++,
    });
    checker.start();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [url, init] = calls[0] as FetchArgs;
    const target = new URL(String(url));
    expect(target.pathname).toBe('/version.json');
    expect(target.searchParams.get('t')).toBe('1000');
    expect(new URL(String(calls[1]?.[0])).searchParams.get('t')).toBe('1001');
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(checker.checks).toBe(4);
    checker.dispose();
  });

  it('never overlaps: a poll in flight is joined, and the interval skips while it runs', async () => {
    vi.useFakeTimers();
    let resolve: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const changes: Array<UpdateManifest | null> = [];
    const checker = createUpdateChecker({
      runningBuildId: 'running',
      url: '/version.json',
      fetch: fetchMock,
      timeoutMs: 60_000,
      onChange: (m) => changes.push(m),
    });
    checker.start();
    const joined = checker.poll();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve?.(response({ buildId: 'new', version: '0.2.0' }));
    await joined;
    expect(changes).toEqual([{ buildId: 'new', version: '0.2.0' }]);
    checker.dispose();
  });

  it('the baseline is the running id, never the first poll', async () => {
    const changes: Array<UpdateManifest | null> = [];
    const checker = createUpdateChecker({
      runningBuildId: 'running',
      url: '/version.json',
      fetch: vi.fn(async () => response({ buildId: 'newer' })),
      onChange: (m) => changes.push(m),
    });
    await checker.poll();
    await checker.poll();
    expect(changes).toEqual([{ buildId: 'newer' }]);
    checker.dispose();
  });

  it('a rollback to the running build clears the notice', async () => {
    const manifests = [{ buildId: 'new' }, { buildId: 'new' }, { buildId: 'running' }];
    const changes: Array<UpdateManifest | null> = [];
    const checker = createUpdateChecker({
      runningBuildId: 'running',
      url: '/version.json',
      fetch: vi.fn(async () => response(manifests.shift())),
      onChange: (m) => changes.push(m),
    });
    await checker.poll();
    await checker.poll();
    await checker.poll();
    expect(changes).toEqual([{ buildId: 'new' }, null]);
    checker.dispose();
  });

  it('keeps an existing notice through HTTP errors, malformed bodies, network errors and timeouts', async () => {
    vi.useFakeTimers();
    let mode: 'good' | 'http' | 'malformed' | 'network' | 'timeout' = 'good';
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      if (mode === 'good') return Promise.resolve(response({ buildId: 'new' }));
      if (mode === 'http') return Promise.resolve(response({}, false));
      if (mode === 'malformed') return Promise.resolve(response({ buildId: '' }));
      if (mode === 'network') return Promise.reject(new TypeError('offline'));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    });
    const changes: Array<UpdateManifest | null> = [];
    const checker = createUpdateChecker({
      runningBuildId: 'running',
      url: '/version.json',
      fetch: fetchMock,
      onChange: (m) => changes.push(m),
    });
    await checker.poll();
    for (const next of ['http', 'malformed', 'network'] as const) {
      mode = next;
      await checker.poll();
    }
    mode = 'timeout';
    const pending = checker.poll();
    await vi.advanceTimersByTimeAsync(UPDATE_TIMEOUT_MS);
    await pending;
    expect(changes).toEqual([{ buildId: 'new' }]);
    expect(checker.checks).toBe(1);
    checker.dispose();
  });

  it('the timeout covers reading the body', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return {
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      } as unknown as Response;
    });
    const onChange = vi.fn();
    const checker = createUpdateChecker({
      runningBuildId: 'running',
      url: '/version.json',
      fetch: fetchMock,
      onChange,
    });
    const pending = checker.poll();
    await vi.advanceTimersByTimeAsync(UPDATE_TIMEOUT_MS);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    checker.dispose();
  });

  it('teardown aborts the request in flight, stops the interval and reports nothing after', async () => {
    vi.useFakeTimers();
    let resolve: ((value: Response) => void) | undefined;
    let aborted = false;
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((done) => {
          resolve = done;
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    );
    const onChange = vi.fn();
    const checker = createUpdateChecker({
      runningBuildId: 'running',
      url: '/version.json',
      fetch: fetchMock,
      onChange,
    });
    checker.start();
    checker.dispose();
    expect(aborted).toBe(true);
    resolve?.(response({ buildId: 'new' }));
    await vi.advanceTimersByTimeAsync(0);
    // Neither the interval nor the settled request's timeout outlives the teardown.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onChange).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await checker.poll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('manifest parsing', () => {
  it('takes a trimmed build id and an optional string version', () => {
    expect(parseManifest({ buildId: ' abc ', version: '1.0.0' })).toEqual({
      buildId: 'abc',
      version: '1.0.0',
    });
    expect(parseManifest({ buildId: 'abc' })).toEqual({ buildId: 'abc' });
  });

  it('rejects anything else', () => {
    for (const bad of [
      null,
      [],
      'abc',
      {},
      { buildId: '' },
      { buildId: 7 },
      { buildId: 'a', version: 1 },
    ])
      expect(parseManifest(bad)).toBeNull();
    expect(parseManifest({ buildId: 'x'.repeat(257) })).toBeNull();
  });
});
