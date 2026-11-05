export function createEnterVrButton(
  supported: boolean,
  onEnter: () => void,
  doc: Document = document,
): HTMLButtonElement {
  const button = doc.createElement('button');
  button.id = 'enter-vr';
  button.type = 'button';
  button.textContent = supported ? 'Enter VR' : 'VR not available';
  button.disabled = !supported;
  Object.assign(button.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    padding: '10px 18px',
    font: '16px system-ui, sans-serif',
    zIndex: '10',
  });
  button.addEventListener('click', onEnter);
  doc.body.appendChild(button);
  return button;
}
