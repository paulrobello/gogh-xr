import { expect, test } from 'vitest';
import { createEnterVrButton } from '../src/ui/enter-vr.ts';
import { showNotice } from '../src/ui/notice.ts';

test('notice is dismissable', () => {
  const notice = showNotice('Could not start VR: denied');
  expect(document.body.contains(notice)).toBe(true);
  expect(notice.textContent).toContain('Could not start VR: denied');
  notice.querySelector('button')?.click();
  expect(document.body.contains(notice)).toBe(false);
});

test('enter VR button reflects support and fires the callback', () => {
  let calls = 0;
  const on = createEnterVrButton(true, () => calls++);
  expect(on.textContent).toBe('Enter VR');
  on.focus();
  on.click();
  expect(calls).toBe(1);
  // Blurred after the click, so Space cannot press it again.
  expect(document.activeElement).not.toBe(on);
  const off = createEnterVrButton(false, () => calls++);
  expect(off.disabled).toBe(true);
});
