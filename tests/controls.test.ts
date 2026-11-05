import { expect, test, vi } from 'vitest';
import { requestLock } from '../src/desktop/controls.ts';

function canvasWith(requestPointerLock: () => unknown): HTMLCanvasElement {
  return { requestPointerLock } as unknown as HTMLCanvasElement;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('a rejecting requestPointerLock raises no unhandled rejection', async () => {
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  const request = vi.fn(() => Promise.reject(new Error('WrongDocumentError')));
  requestLock(canvasWith(request));
  await settle();
  process.off('unhandledRejection', unhandled);
  expect(request).toHaveBeenCalledOnce();
  expect(unhandled).not.toHaveBeenCalled();
});

test('non-promise and throwing variants are tolerated', () => {
  expect(() => requestLock(canvasWith(() => undefined))).not.toThrow();
  expect(() =>
    requestLock(
      canvasWith(() => {
        throw new Error('refused');
      }),
    ),
  ).not.toThrow();
});
