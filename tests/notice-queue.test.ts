import { describe, expect, it, vi } from 'vitest';
import {
  arbitrateNoticeTrigger,
  createNoticeQueue,
  createNoticeTriggerState,
  isNoticeKind,
  MAX_SHOWN,
  NOTICE_KINDS,
  type NoticeHandFrame,
  type NoticeHit,
  type NoticeKind,
  settingsRecoveredText,
  worldFailedText,
} from '../src/ui/notice-queue';

const UP = { down: false, fired: false };
const PRESS = { down: true, fired: true };
const HELD = { down: true, fired: false };

const dismissHit = (kind: NoticeKind): NoticeHit => ({ kind, button: 'dismiss' });
const actionHit = (kind: NoticeKind): NoticeHit => ({ kind, button: 'action' });

function hand(overrides: Partial<NoticeHandFrame> = {}): NoticeHandFrame {
  return { trigger: UP, panelHit: false, panelClaimed: false, target: null, ...overrides };
}

describe('notice queue', () => {
  it('queues newest first and shows at most two', () => {
    const q = createNoticeQueue();
    expect(MAX_SHOWN).toBe(2);
    q.raise('settings-recovered', 'a');
    q.raise('xr-error', 'b');
    q.raise('rate-fallback', 'c');
    expect(q.queue.map((n) => n.kind)).toEqual(['rate-fallback', 'xr-error', 'settings-recovered']);
    expect(q.shown.map((n) => n.kind)).toEqual(['rate-fallback', 'xr-error']);
  });

  it('dedupes by kind: the newer text replaces the older and moves to the front', () => {
    const q = createNoticeQueue();
    q.raise('xr-error', 'first');
    q.raise('settings-recovered', 'settings');
    q.raise('xr-error', 'second');
    expect(q.diag()).toEqual({
      queue: [
        { kind: 'xr-error', text: 'second' },
        { kind: 'settings-recovered', text: 'settings' },
      ],
      shown: [
        { kind: 'xr-error', text: 'second' },
        { kind: 'settings-recovered', text: 'settings' },
      ],
    });
  });

  it('dismissal removes one kind and reveals the next queued notice', () => {
    const q = createNoticeQueue();
    q.raise('update-ready', 'u');
    q.raise('settings-recovered', 's');
    q.raise('rate-fallback', 'r');
    expect(q.shown.map((n) => n.kind)).toEqual(['rate-fallback', 'settings-recovered']);
    expect(q.dismiss('rate-fallback')).toBe(true);
    expect(q.shown.map((n) => n.kind)).toEqual(['settings-recovered', 'update-ready']);
    expect(q.dismiss('rate-fallback')).toBe(false);
    expect(q.queue.map((n) => n.kind)).toEqual(['settings-recovered', 'update-ready']);
    q.dismiss('settings-recovered');
    q.dismiss('update-ready');
    expect(q.queue).toEqual([]);
    expect(q.shown).toEqual([]);
  });

  it('notifies on every change, with a new shown array, but not on a dismissal of nothing', () => {
    const q = createNoticeQueue();
    const listener = vi.fn();
    const off = q.subscribe(listener);
    q.raise('xr-error', 'x');
    const first = q.shown;
    q.raise('xr-error', 'x');
    expect(q.shown).not.toBe(first);
    const second = q.shown;
    q.dismiss('rate-fallback');
    expect(q.shown).toBe(second);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    q.dismiss('xr-error');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('a one-slot queue shows only the newest', () => {
    const q = createNoticeQueue(1);
    q.raise('xr-error', 'x');
    q.raise('update-ready', 'u');
    expect(q.shown.map((n) => n.kind)).toEqual(['update-ready']);
  });

  it('knows its five kinds and names every settings recovery', () => {
    expect(NOTICE_KINDS).toEqual([
      'rate-fallback',
      'settings-recovered',
      'xr-error',
      'update-ready',
      'world-failed',
    ]);
    expect(isNoticeKind('xr-error')).toBe(true);
    expect(isNoticeKind('panel')).toBe(false);
    expect(isNoticeKind(3)).toBe(false);
    expect(settingsRecoveredText('corrupt-json')).toMatch(/could not be read/);
    expect(settingsRecoveredText('bad-shape')).toMatch(/could not be read/);
    expect(settingsRecoveredText('future-version')).toMatch(/newer version/);
    expect(settingsRecoveredText('storage-unavailable')).toMatch(/cannot be saved/);
  });
});

describe('trigger arbitration: a notice never steals the trigger from the panel', () => {
  it('the panel wins when its ray meets the panel, even with a dismiss button on the same ray', () => {
    const state = createNoticeTriggerState();
    const r = arbitrateNoticeTrigger(
      { right: hand({ trigger: PRESS, panelHit: true, target: dismissHit('xr-error') }) },
      state,
    );
    expect(r.dismiss).toEqual([]);
    expect(r.claimed).toEqual({ left: false, right: false });
    expect(r.hover.right).toBeNull();
  });

  it('the panel wins for a hand it holds, a grab or a press started on it', () => {
    const state = createNoticeTriggerState();
    const r = arbitrateNoticeTrigger(
      { left: hand({ trigger: PRESS, panelClaimed: true, target: dismissHit('rate-fallback') }) },
      state,
    );
    expect(r.dismiss).toEqual([]);
    expect(r.claimed.left).toBe(false);
  });

  it('a press on a dismiss button off the panel dismisses it and holds the trigger until released', () => {
    const state = createNoticeTriggerState();
    const press = arbitrateNoticeTrigger(
      { right: hand({ trigger: PRESS, target: dismissHit('xr-error') }) },
      state,
    );
    expect(press.dismiss).toEqual(['xr-error']);
    expect(press.claimed.right).toBe(true);
    expect(press.hover.right).toEqual(dismissHit('xr-error'));
    // Still held, now pointing at nothing: the notice keeps the trigger, so `select` never sees it.
    const held = arbitrateNoticeTrigger({ right: hand({ trigger: HELD }) }, state);
    expect(held.dismiss).toEqual([]);
    expect(held.claimed.right).toBe(true);
    const released = arbitrateNoticeTrigger({ right: hand({ trigger: UP }) }, state);
    expect(released.claimed.right).toBe(false);
  });

  it('a held trigger dragged onto a dismiss button dismisses nothing', () => {
    const state = createNoticeTriggerState();
    const r = arbitrateNoticeTrigger(
      { right: hand({ trigger: HELD, target: dismissHit('xr-error') }) },
      state,
    );
    expect(r.dismiss).toEqual([]);
    expect(r.claimed.right).toBe(false);
    expect(r.hover.right).toEqual(dismissHit('xr-error'));
  });

  it('a press that misses every button takes nothing', () => {
    const state = createNoticeTriggerState();
    const r = arbitrateNoticeTrigger({ right: hand({ trigger: PRESS }) }, state);
    expect(r).toMatchObject({ dismiss: [], claimed: { left: false, right: false } });
  });

  it('judges each hand alone: left on the panel and right on a notice both act', () => {
    const state = createNoticeTriggerState();
    const r = arbitrateNoticeTrigger(
      {
        left: hand({ trigger: PRESS, panelHit: true, target: dismissHit('xr-error') }),
        right: hand({ trigger: PRESS, target: dismissHit('settings-recovered') }),
      },
      state,
    );
    expect(r.dismiss).toEqual(['settings-recovered']);
    expect(r.claimed).toEqual({ left: false, right: true });
    expect(r.hover).toEqual({ left: null, right: dismissHit('settings-recovered') });
  });

  it('two hands on one button dismiss it once', () => {
    const state = createNoticeTriggerState();
    const r = arbitrateNoticeTrigger(
      {
        left: hand({ trigger: PRESS, target: dismissHit('xr-error') }),
        right: hand({ trigger: PRESS, target: dismissHit('xr-error') }),
      },
      state,
    );
    expect(r.dismiss).toEqual(['xr-error']);
  });

  it('a notice press the panel then claims (a grip on it) is the panel’s', () => {
    const state = createNoticeTriggerState();
    arbitrateNoticeTrigger(
      { right: hand({ trigger: PRESS, target: dismissHit('xr-error') }) },
      state,
    );
    const r = arbitrateNoticeTrigger({ right: hand({ trigger: HELD, panelClaimed: true }) }, state);
    expect(r.claimed.right).toBe(false);
    expect(state.pressing.right).toBe(false);
  });

  it('a press on an action button acts, keeps the notice and holds the trigger', () => {
    const state = createNoticeTriggerState();
    const r = arbitrateNoticeTrigger(
      {
        left: hand({ trigger: PRESS, target: actionHit('update-ready') }),
        right: hand({ trigger: PRESS, target: actionHit('update-ready') }),
      },
      state,
    );
    expect(r.act).toEqual(['update-ready']);
    expect(r.dismiss).toEqual([]);
    expect(r.claimed).toEqual({ left: true, right: true });
    expect(r.hover.right).toEqual(actionHit('update-ready'));
  });

  it('the panel keeps the trigger over an action button on the same ray', () => {
    const state = createNoticeTriggerState();
    const r = arbitrateNoticeTrigger(
      { right: hand({ trigger: PRESS, panelHit: true, target: actionHit('update-ready') }) },
      state,
    );
    expect(r.act).toEqual([]);
    expect(r.claimed.right).toBe(false);
  });

  it('an untracked hand drops its press', () => {
    const state = createNoticeTriggerState();
    arbitrateNoticeTrigger(
      { left: hand({ trigger: PRESS, target: dismissHit('update-ready') }) },
      state,
    );
    expect(state.pressing.left).toBe(true);
    arbitrateNoticeTrigger({}, state);
    expect(state.pressing.left).toBe(false);
  });
});

describe('worldFailedText', () => {
  it('names the painting, for a failed build and for a stall', () => {
    expect(isNoticeKind('world-failed')).toBe(true);
    expect(worldFailedText('The Starry Night')).toBe(
      'The Starry Night could not load. Try again, or reload the page.',
    );
    expect(worldFailedText('The Starry Night', 'loading')).toBe(
      'The Starry Night is still loading. Try again in a moment.',
    );
    expect(worldFailedText('The Starry Night', 'stall')).toBe(
      'The Starry Night took too long to load. Try again, or reload the page.',
    );
  });
});
