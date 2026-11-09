/**
 * The HUD notice queue (P5.6), pure: no three, troika or DOM. A notice of a kind already queued
 * replaces the older one and moves to the front, so each kind appears at most once and the queue
 * is newest first. `shown` is the newest `maxShown` of it, which both surfaces draw: the XR notice
 * stack (`notice-hud.ts`) and the DOM notices of the 2D page (`notice.ts`).
 *
 * `arbitrateNoticeTrigger` is the trigger rule between the settings panel and a notice.
 */
import type { RecoveredReason } from '../settings/schema';
import type { ButtonAction, Hand } from '../xr/input';

export type NoticeKind =
  | 'rate-fallback'
  | 'settings-recovered'
  | 'xr-error'
  | 'update-ready'
  | 'world-failed';

export const NOTICE_KINDS: readonly NoticeKind[] = Object.freeze([
  'rate-fallback',
  'settings-recovered',
  'xr-error',
  'update-ready',
  'world-failed',
]);

export function isNoticeKind(value: unknown): value is NoticeKind {
  return typeof value === 'string' && (NOTICE_KINDS as readonly string[]).includes(value);
}

/** At most this many notices show at once, newest first. */
export const MAX_SHOWN = 2;

/** The update notice's text (P7.1 raises it once its poller sees a new build). */
export const UPDATE_NOTICE = 'Update: a new version is ready.';

/** The label of the update notice's action button, which reloads (P7.1). */
export const RELOAD_LABEL = 'Reload';

/**
 * The world-failed notice's text (cards 01a1c05ae68c, 01a1c05452e4): `name` is the painting's
 * display name. A stall is a build that gave up waiting on a fetch, and `loading` a retry refused while that build is still in flight; any other failure is a throw,
 * an import or raster timeout, or a boot that could not load the world.
 */
export function worldFailedText(
  name: string,
  reason: 'build' | 'stall' | 'loading' = 'build',
): string {
  switch (reason) {
    case 'stall':
      return `${name} took too long to load. Try again, or reload the page.`;
    case 'loading':
      return `${name} is still loading. Try again in a moment.`;
    default:
      return `${name} could not load. Try again, or reload the page.`;
  }
}

/** A notice's buttons: every notice has Dismiss, and a kind with an action also has its action. */
export type NoticeButton = 'dismiss' | 'action';

/** The button a ray meets: which notice, and which of its buttons. */
export interface NoticeHit {
  readonly kind: NoticeKind;
  readonly button: NoticeButton;
}

/** The settings-recovered notice's text for each reason `loadSettings` falls back with. */
export function settingsRecoveredText(reason: RecoveredReason): string {
  switch (reason) {
    case 'future-version':
      return 'Saved settings are from a newer version, so the defaults are in use.';
    case 'storage-unavailable':
      return 'Settings cannot be saved in this browser, so changes last this session only.';
    default:
      return 'Saved settings could not be read, so the defaults are in use.';
  }
}

export interface Notice {
  readonly kind: NoticeKind;
  readonly text: string;
}

export interface NoticeQueueDiag {
  queue: Notice[];
  shown: Notice[];
}

export interface NoticeQueue {
  /** Queues a notice at the front; one of the same kind already queued is replaced. */
  raise(kind: NoticeKind, text: string): void;
  /** Removes the notice of `kind`. False when none was queued. */
  dismiss(kind: NoticeKind): boolean;
  /** Every queued notice, newest first. */
  readonly queue: readonly Notice[];
  /** The newest `maxShown`, the ones drawn. A new array on every change, so a view compares it. */
  readonly shown: readonly Notice[];
  /** Called after every change. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  diag(): NoticeQueueDiag;
}

export function createNoticeQueue(maxShown: number = MAX_SHOWN): NoticeQueue {
  let queue: Notice[] = [];
  let shown: Notice[] = [];
  const listeners = new Set<() => void>();

  function changed(next: Notice[]): void {
    queue = next;
    shown = queue.slice(0, maxShown);
    for (const listener of listeners) listener();
  }

  return {
    raise(kind, text) {
      changed([{ kind, text }, ...queue.filter((n) => n.kind !== kind)]);
    },
    dismiss(kind) {
      if (!queue.some((n) => n.kind === kind)) return false;
      changed(queue.filter((n) => n.kind !== kind));
      return true;
    },
    get queue() {
      return queue;
    },
    get shown() {
      return shown;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    diag: () => ({
      queue: queue.map((n) => ({ kind: n.kind, text: n.text })),
      shown: shown.map((n) => ({ kind: n.kind, text: n.text })),
    }),
  };
}

/** One hand's frame, as the trigger arbitration reads it. */
export interface NoticeHandFrame {
  /** That controller's own trigger (`Actions.hands[hand].trigger`). */
  readonly trigger: ButtonAction;
  /** The settings panel's ray from this hand meets the panel this frame (backing or control). */
  readonly panelHit: boolean;
  /** The panel holds this hand: a grab or a press that started on it. */
  readonly panelClaimed: boolean;
  /** The notice button this hand's ray meets, or null. */
  readonly target: NoticeHit | null;
}

export interface NoticeTriggerState {
  /** The trigger went down on a dismiss button and is still held: the notice's until released. */
  readonly pressing: Record<Hand, boolean>;
}

export function createNoticeTriggerState(): NoticeTriggerState {
  return { pressing: { left: false, right: false } };
}

export interface NoticeTriggerResult {
  /** Notices dismissed this frame, at most one per hand. */
  readonly dismiss: NoticeKind[];
  /** Notices whose action button was pressed this frame, at most one per hand. */
  readonly act: NoticeKind[];
  /** Hands whose trigger the notices hold this frame, for `Input.claim`. */
  readonly claimed: Record<Hand, boolean>;
  /** The button each hand may press: its target, unless the panel owns that hand. */
  readonly hover: Record<Hand, NoticeHit | null>;
}

const HANDS: readonly Hand[] = ['left', 'right'];

/**
 * The trigger rule (P5.6). The settings panel owns a hand's trigger whenever that hand's ray meets
 * the panel or the panel holds the hand, whatever notice lies on the same ray. A notice takes the
 * trigger only on the press itself (`fired`), only when that ray meets one of its buttons, and
 * only when the panel neither meets that ray nor holds that hand. Dismiss dismisses the notice,
 * and its action button (P7.1's Reload) acts. A press it takes stays the notice's until the
 * trigger is released, so the hold never reaches `select`. A trigger already held when the ray
 * moves onto a button presses nothing. Each hand is judged on its own.
 */
export function arbitrateNoticeTrigger(
  hands: Partial<Record<Hand, NoticeHandFrame>>,
  state: NoticeTriggerState,
): NoticeTriggerResult {
  const dismiss: NoticeKind[] = [];
  const act: NoticeKind[] = [];
  const claimed: Record<Hand, boolean> = { left: false, right: false };
  const hover: Record<Hand, NoticeHit | null> = { left: null, right: null };
  for (const name of HANDS) {
    const hand = hands[name];
    if (!hand) {
      state.pressing[name] = false;
      continue;
    }
    const panelOwns = hand.panelHit || hand.panelClaimed;
    if (!hand.trigger.down) state.pressing[name] = false;
    hover[name] = panelOwns ? null : hand.target;
    if (hand.trigger.fired && !panelOwns && hand.target !== null) {
      state.pressing[name] = true;
      const list = hand.target.button === 'action' ? act : dismiss;
      if (!list.includes(hand.target.kind)) list.push(hand.target.kind);
    }
    // The panel may claim a hand mid-hold (a grip on it); the panel then has the trigger.
    if (hand.panelClaimed) state.pressing[name] = false;
    claimed[name] = state.pressing[name];
  }
  return { dismiss, act, claimed, hover };
}
