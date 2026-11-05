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

export function showNotice(message: string, doc: Document = document): HTMLElement {
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
  dismiss.addEventListener('click', () => notice.remove());
  notice.append(text, dismiss);
  container(doc).appendChild(notice);
  return notice;
}
