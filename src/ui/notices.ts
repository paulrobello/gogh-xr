/**
 * The notices host (P5.6): one queue (`notice-queue.ts`) drawn on two surfaces. The 2D page shows
 * it as DOM notices, which are invisible in immersive mode; in XR the notice stack
 * (`notice-hud.ts`) shows it on the HUD. Dismissing on either surface removes the notice from both.
 * A kind given an action (P7.1: `update-ready`'s Reload) shows its button on both surfaces.
 *
 * The stack is built on the first presenting frame with a notice queued, like the HUD (R17), so a
 * session that never shows a notice in XR loads no troika, font or meshes for it. Free of three and
 * troika: `main.ts` passes the lazy import as `build`.
 */
import type { Actions, Hand } from '../xr/input';
import { type NoticeActionButton, showNotice, syncNotices } from './notice';
import type { NoticeHudDiag, NoticeHudFrame } from './notice-hud';
import {
  arbitrateNoticeTrigger,
  createNoticeQueue,
  createNoticeTriggerState,
  type Notice,
  type NoticeHit,
  type NoticeKind,
  type NoticeQueue,
  type NoticeQueueDiag,
  UPDATE_NOTICE,
} from './notice-queue';
import type { PanelHold } from './panel-toggle';

declare global {
  interface Window {
    /** `?diag` only: raises a notice of `kind`, as its real source would (P5.6). */
    __goghNotice?: (kind: string, text?: string) => boolean;
  }
}

/** The built XR stack, as the host drives it. */
export interface NoticeView {
  frame(input: NoticeHudFrame): Record<Hand, NoticeHit | null>;
  setHover(hover: Record<Hand, NoticeHit | null>): void;
  diag(): NoticeHudDiag;
}

/** A notice shown on the page: its action, when its kind has one. */
export interface DomNotice extends Notice {
  readonly action?: NoticeActionButton;
}

export interface NoticesDeps {
  build(): Promise<NoticeView>;
  /** A failed build is reported here, and the next presenting frame with a notice tries again. */
  onError?(error: unknown): void;
  /** Mirrors the shown notices onto the page. Default `syncNotices` on `document`. */
  syncDom?(shown: readonly DomNotice[], onDismiss: (kind: NoticeKind) => void): void;
  queue?: NoticeQueue;
  /**
   * Action buttons by kind, shown before Dismiss on both surfaces (P7.1: `update-ready`'s Reload).
   * Pressing one runs it and leaves the notice up.
   */
  actions?: Partial<Record<NoticeKind, NoticeActionButton>>;
}

export interface NoticesDiag extends NoticeQueueDiag {
  /** The XR stack: null until it is built. */
  view: NoticeHudDiag | null;
}

export interface Notices {
  readonly queue: NoticeQueue;
  raise(kind: NoticeKind, text: string): void;
  dismiss(kind: NoticeKind): boolean;
  /** The pending update reload's hook (P7.1): its poller calls this once a new build is live. */
  raiseUpdate(text?: string): void;
  /**
   * One frame, after the settings panel's: draws the XR stack and lets a trigger dismiss a notice
   * under the arbitration rule. Returns the hands whose trigger a notice holds, for `Input.claim`.
   */
  frame(presenting: boolean, actions: Actions, panel: PanelHold): Readonly<Record<Hand, boolean>>;
  diag(): NoticesDiag;
}

const NONE: Readonly<Record<Hand, boolean>> = Object.freeze({ left: false, right: false });

/**
 * The governor's 72 Hz notice (its `notify`): on the notices host once it exists, which in XR shows
 * it on the notice stack whether the perf HUD shows or not, else as a DOM notice. It never touches
 * the perf HUD.
 */
export function raiseRateFallback(
  notices: Pick<Notices, 'raise'> | null,
  message: string,
  dom: (message: string) => void = showNotice,
): void {
  if (notices) notices.raise('rate-fallback', message);
  else dom(message);
}

export function createNotices(deps: NoticesDeps): Notices {
  const queue = deps.queue ?? createNoticeQueue();
  const syncDom =
    deps.syncDom ??
    ((shown, onDismiss) => syncNotices(shown, (kind) => onDismiss(kind as NoticeKind)));
  const trigger = createNoticeTriggerState();
  const noticeActions = deps.actions ?? {};
  const actionLabels: Partial<Record<NoticeKind, string>> = {};
  for (const [kind, action] of Object.entries(noticeActions) as [NoticeKind, NoticeActionButton][])
    actionLabels[kind] = action.label;
  const withActions = (shown: readonly Notice[]): DomNotice[] =>
    shown.map((n) => (noticeActions[n.kind] ? { ...n, action: noticeActions[n.kind] } : n));
  let view: NoticeView | null = null;
  let building = false;
  /** The stack drew last frame, so a frame with nothing to show still hides it once. */
  let viewShown = false;

  const dismiss = (kind: NoticeKind): boolean => queue.dismiss(kind);
  queue.subscribe(() => syncDom(withActions(queue.shown), dismiss));
  syncDom(withActions(queue.shown), dismiss);

  function build(): void {
    building = true;
    deps.build().then(
      (built) => {
        view = built;
      },
      (error: unknown) => {
        building = false;
        deps.onError?.(error);
      },
    );
  }

  return {
    queue,
    raise: (kind, text) => queue.raise(kind, text),
    dismiss,
    raiseUpdate: (text = UPDATE_NOTICE) => queue.raise('update-ready', text),
    frame(presenting, actions, panel) {
      const shown = queue.shown;
      const pressing = trigger.pressing.left || trigger.pressing.right;
      if (shown.length === 0 && !pressing && !viewShown) return NONE;
      if (presenting && shown.length > 0 && !view && !building) build();
      let targets: Record<Hand, NoticeHit | null> | null = null;
      if (view) {
        targets = view.frame({ presenting, shown, panelPose: panel.pose, actions: actionLabels });
        viewShown = presenting && shown.length > 0;
      }
      const result = arbitrateNoticeTrigger(
        {
          left: {
            trigger: actions.hands.left.trigger,
            panelHit: panel.hits.left,
            panelClaimed: panel.left,
            target: targets?.left ?? null,
          },
          right: {
            trigger: actions.hands.right.trigger,
            panelHit: panel.hits.right,
            panelClaimed: panel.right,
            target: targets?.right ?? null,
          },
        },
        trigger,
      );
      view?.setHover(result.hover);
      for (const kind of result.dismiss) queue.dismiss(kind);
      for (const kind of result.act) noticeActions[kind]?.run();
      return result.claimed;
    },
    diag: () => ({ ...queue.diag(), view: view?.diag() ?? null }),
  };
}
