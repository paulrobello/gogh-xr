import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_ID_META } from '../src/update/build-id';
import { readRunningBuildId, shouldAutoReload, shouldPoll } from '../src/update/policy';
import { RELOAD_PARAM } from '../src/update/reload';
import {
  createUpdates,
  LAST_RELOAD_KEY,
  LOOP_GUARD_MS,
  RELOAD_FAILED_NOTICE,
  type UpdatesDeps,
} from '../src/update/updates';

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);

describe('poll policy', () => {
  const base = { runningBuildId: ID_A, flag: null, bench: false, mode: 'production' };

  it('a production build polls unless ?update=0', () => {
    expect(shouldPoll(base)).toBe(true);
    expect(shouldPoll({ ...base, flag: true })).toBe(true);
    expect(shouldPoll({ ...base, flag: false })).toBe(false);
  });

  it('an e2e build polls only with ?update, so other specs never see a reload', () => {
    expect(shouldPoll({ ...base, mode: 'e2e' })).toBe(false);
    expect(shouldPoll({ ...base, mode: 'e2e', flag: true })).toBe(true);
  });

  it('the dev server has no build id and never polls; the bench never polls', () => {
    expect(shouldPoll({ ...base, runningBuildId: null, mode: 'development', flag: true })).toBe(
      false,
    );
    expect(shouldPoll({ ...base, bench: true, flag: true })).toBe(false);
  });

  it('reads the running id from index.html, and only a 64-hex one', () => {
    const doc = document.implementation.createHTMLDocument('t');
    expect(readRunningBuildId(doc)).toBeNull();
    const meta = doc.createElement('meta');
    meta.setAttribute('name', BUILD_ID_META);
    meta.setAttribute('content', 'dev');
    doc.head.append(meta);
    expect(readRunningBuildId(doc)).toBeNull();
    meta.setAttribute('content', ID_A);
    expect(readRunningBuildId(doc)).toBe(ID_A);
  });

  it('reloads by itself only on the desktop', () => {
    expect(shouldAutoReload(true, false, false)).toBe(true);
    expect(shouldAutoReload(false, false, false)).toBe(false);
    expect(shouldAutoReload(true, true, false)).toBe(false);
    expect(shouldAutoReload(true, false, true)).toBe(false);
  });
});

const response = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

function harness(overrides: Partial<UpdatesDeps> = {}) {
  let served = ID_A;
  const state = { presenting: false, busy: false };
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  };
  const events: string[] = [];
  let endResolve: (() => void) | undefined;
  const notices = {
    raiseUpdate: vi.fn(() => events.push('raise')),
    dismiss: vi.fn(() => {
      events.push('dismiss');
      return true;
    }),
    raise: vi.fn((_kind: 'xr-error', text: string) => events.push(`xr-error ${text}`)),
  };
  const location = {
    href: 'https://host/?painting=starry-night#here',
    replace: vi.fn((url: string) => events.push(`replace ${url}`)),
  };
  const updates = createUpdates({
    runningBuildId: ID_A,
    url: 'https://host/version.json',
    notices,
    presenting: () => state.presenting,
    busy: () => state.busy,
    storage,
    endSession: () =>
      new Promise<void>((resolve) => {
        events.push('end');
        endResolve = () => {
          state.presenting = false;
          events.push('ended');
          resolve();
        };
      }),
    beforeNavigate: () => events.push('flush'),
    location,
    fetch: vi.fn(async () => response({ buildId: served })),
    now: () => 77,
    ...overrides,
  });
  return {
    updates,
    state,
    events,
    notices,
    location,
    stored,
    serve: (id: string) => {
      served = id;
    },
    endSession: () => endResolve?.(),
  };
}

const expectedUrl = `https://host/?painting=starry-night&${RELOAD_PARAM}=77#here`;

describe('update flow', () => {
  afterEach(() => vi.useRealTimers());

  it('on the desktop a new build raises the notice and reloads without a click', async () => {
    const h = harness();
    await h.updates.check();
    expect(h.events).toEqual([]);
    h.serve(ID_B);
    await h.updates.check();
    expect(h.events).toEqual(['raise', 'flush', `replace ${expectedUrl}`]);
    expect(h.updates.diag()).toMatchObject({ running: ID_A, available: ID_B, reloading: true });
  });

  it('in XR it shows the notice and reloads only once Reload is selected, after the session ends', async () => {
    const h = harness();
    h.state.presenting = true;
    h.serve(ID_B);
    await h.updates.check();
    await h.updates.check();
    expect(h.events).toEqual(['raise']);
    const reload = h.updates.reload();
    await Promise.resolve();
    expect(h.events).toEqual(['raise', 'end']);
    expect(h.location.replace).not.toHaveBeenCalled();
    h.endSession();
    await reload;
    expect(h.events).toEqual(['raise', 'end', 'ended', 'flush', `replace ${expectedUrl}`]);
  });

  it('a second Reload while one is under way does nothing', async () => {
    const h = harness();
    h.state.presenting = true;
    h.serve(ID_B);
    await h.updates.check();
    const first = h.updates.reload();
    await h.updates.reload();
    h.endSession();
    await first;
    expect(h.events.filter((e) => e === 'end')).toHaveLength(1);
    expect(h.location.replace).toHaveBeenCalledTimes(1);
  });

  it('a rollback while in XR dismisses the notice, and nothing reloads after the session', async () => {
    const h = harness();
    h.state.presenting = true;
    h.serve(ID_B);
    await h.updates.check();
    h.serve(ID_A);
    await h.updates.check();
    expect(h.events).toEqual(['raise', 'dismiss']);
    h.state.presenting = false;
    h.updates.settle();
    expect(h.location.replace).not.toHaveBeenCalled();
  });

  it('a build that arrived in XR reloads once the viewer is back on the page', async () => {
    const h = harness();
    h.state.presenting = true;
    h.serve(ID_B);
    await h.updates.check();
    h.state.presenting = false;
    h.updates.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.location.replace).toHaveBeenCalledWith(expectedUrl);
  });

  it('waits while an XR entry or a portal transition is in progress', async () => {
    const h = harness();
    h.state.busy = true;
    h.serve(ID_B);
    await h.updates.check();
    expect(h.location.replace).not.toHaveBeenCalled();
    h.state.busy = false;
    h.updates.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.location.replace).toHaveBeenCalledTimes(1);
  });

  it('a session that will not end keeps the page, raises xr-error, and Reload can try again', async () => {
    vi.useFakeTimers();
    const h = harness({ exitTimeoutMs: 10_000 });
    h.state.presenting = true;
    h.serve(ID_B);
    await h.updates.check();
    const reload = h.updates.reload();
    await vi.advanceTimersByTimeAsync(10_000);
    await reload;
    expect(h.location.replace).not.toHaveBeenCalled();
    expect(h.events).toContain(`xr-error ${RELOAD_FAILED_NOTICE}`);
    expect(h.updates.diag().reloading).toBe(false);
    const again = h.updates.reload();
    await Promise.resolve();
    h.endSession();
    await again;
    expect(h.location.replace).toHaveBeenCalledWith(expectedUrl);
  });

  it('a Reload selected while busy waits for settle', async () => {
    const h = harness();
    h.state.busy = true;
    await h.updates.reload();
    expect(h.location.replace).not.toHaveBeenCalled();
    h.updates.settle();
    expect(h.location.replace).not.toHaveBeenCalled();
    h.state.busy = false;
    h.updates.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.location.replace).toHaveBeenCalledWith(expectedUrl);
  });

  it('every reload records where it came from and when, before navigating', async () => {
    const h = harness();
    h.serve(ID_B);
    await h.updates.check();
    expect(JSON.parse(h.stored.get(LAST_RELOAD_KEY) ?? '{}')).toEqual({ from: ID_A, at: 77 });
  });

  it('loop guard: back on the build it reloaded away from, it shows the notice instead', async () => {
    const h = harness({ now: () => 77 + LOOP_GUARD_MS * 10 });
    h.stored.set(LAST_RELOAD_KEY, JSON.stringify({ from: ID_A, at: 77 }));
    h.serve(ID_B);
    await h.updates.check();
    expect(h.events).toEqual(['raise']);
    expect(h.location.replace).not.toHaveBeenCalled();
    expect(h.updates.diag().guarded).toBe(true);
    // The explicit Reload still works.
    await h.updates.reload();
    expect(h.location.replace).toHaveBeenCalledTimes(1);
  });

  it('loop guard: no second automatic reload within two minutes of the last', async () => {
    let t = 1_000_000;
    const recent = harness({ now: () => t });
    recent.stored.set(LAST_RELOAD_KEY, JSON.stringify({ from: ID_B, at: t - LOOP_GUARD_MS + 1 }));
    recent.serve(ID_B);
    await recent.updates.check();
    expect(recent.location.replace).not.toHaveBeenCalled();
    t += 1;
    recent.updates.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(recent.location.replace).toHaveBeenCalledTimes(1);
  });

  it('loop guard: a reload held by the window fires once it passes, and not after dispose', async () => {
    vi.useFakeTimers();
    const at = 5_000_000;
    vi.setSystemTime(at);
    const live = harness({ now: Date.now });
    live.stored.set(LAST_RELOAD_KEY, JSON.stringify({ from: ID_B, at: at - 30_000 }));
    live.serve(ID_B);
    await live.updates.check();
    expect(live.updates.diag().guarded).toBe(true);
    await vi.advanceTimersByTimeAsync(LOOP_GUARD_MS - 30_000 - 1);
    expect(live.location.replace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(live.location.replace).toHaveBeenCalledTimes(1);

    const gone = harness({ now: Date.now });
    gone.stored.set(LAST_RELOAD_KEY, JSON.stringify({ from: ID_B, at: Date.now() - 30_000 }));
    gone.serve(ID_B);
    await gone.updates.check();
    expect(vi.getTimerCount()).toBe(1);
    gone.updates.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LOOP_GUARD_MS);
    expect(gone.location.replace).not.toHaveBeenCalled();
  });

  it('teardown stops polling', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => response({ buildId: ID_A }));
    const h = harness({ fetch: fetchMock });
    h.updates.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    h.updates.dispose();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
