const CONTAINER_ID = 'gogh-notices';

function container(doc: Document): HTMLElement {
  const existing = doc.getElementById(CONTAINER_ID);
  if (existing) return existing;
  const el = doc.createElement('div');
  el.id = CONTAINER_ID;
  Object.assign(el.style, {
    position: 'fixed',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    zIndex: '10',
    font: '14px system-ui, sans-serif',
  });
  doc.body.appendChild(el);
  return el;
}

/** A notice's action button, before Dismiss (P7.1's Reload). */
export interface NoticeActionButton {
  label: string;
  run: () => void;
}

export interface NoticeOptions {
  /** Marks the element, so `syncNotices` can find it again (`data-notice-kind`). */
  kind?: string;
  /** Called when the Dismiss button removes the notice. */
  onDismiss?: () => void;
  /** An action button before Dismiss (`data-notice-action`). It leaves the notice up. */
  action?: NoticeActionButton;
}

export function showNotice(
  message: string,
  doc: Document = document,
  options: NoticeOptions = {},
): HTMLElement {
  const notice = doc.createElement('div');
  notice.setAttribute('role', 'alert');
  Object.assign(notice.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '8px 12px',
    background: '#3a1d1d',
    color: '#f5dede',
    border: '1px solid #8a4040',
    borderRadius: '6px',
  });
  const text = doc.createElement('span');
  text.textContent = message;
  const dismiss = doc.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss notice');
  if (options.kind) notice.dataset.noticeKind = options.kind;
  dismiss.addEventListener('click', () => {
    notice.remove();
    options.onDismiss?.();
  });
  if (options.action) {
    const { label, run } = options.action;
    const act = doc.createElement('button');
    act.type = 'button';
    act.textContent = label;
    act.dataset.noticeAction = label.toLowerCase();
    act.addEventListener('click', () => run());
    notice.append(text, act, dismiss);
  } else {
    notice.append(text, dismiss);
  }
  container(doc).appendChild(notice);
  return notice;
}

export function clearNotices(doc: Document = document): void {
  doc.getElementById(CONTAINER_ID)?.replaceChildren();
}

/**
 * Makes the page's notices match `notices` (newest first, the queue's `shown`): one element per
 * kind, in that order, with its current text. Each Dismiss button calls `onDismiss` with its kind.
 * A notice's `action` is built with its element. Notices shown without a kind are left alone.
 */
export function syncNotices(
  notices: readonly { kind: string; text: string; action?: NoticeActionButton }[],
  onDismiss: (kind: string) => void,
  doc: Document = document,
): void {
  // The container appears with the first notice, not on every boot.
  if (notices.length === 0 && !doc.getElementById(CONTAINER_ID)) return;
  const box = container(doc);
  const existing = new Map<string, HTMLElement>();
  for (const el of Array.from(box.children)) {
    if (!(el instanceof HTMLElement)) continue;
    const kind = el.dataset.noticeKind;
    if (kind === undefined) continue;
    if (notices.some((n) => n.kind === kind)) existing.set(kind, el);
    else el.remove();
  }
  notices.forEach(({ kind, text, action }, index) => {
    let el = existing.get(kind);
    if (el) {
      const span = el.firstElementChild;
      if (span && span.textContent !== text) span.textContent = text;
    } else {
      el = showNotice(text, doc, { kind, onDismiss: () => onDismiss(kind), action });
    }
    const at = box.children[index] ?? null;
    if (at !== el) box.insertBefore(el, at);
  });
}
