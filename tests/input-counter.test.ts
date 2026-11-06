import { expect, test } from 'vitest';
import { createInputCounter, type InputCounterXr } from '../src/xr/input-counter.ts';

function fakeXr(): { xr: InputCounterXr; start: () => void; select: (hand: XRHandedness) => void } {
  const sessionTarget = new EventTarget();
  let onStart: (() => void) | null = null;
  const xr: InputCounterXr = {
    addEventListener: (_type, listener) => {
      onStart = listener;
    },
    getSession: () => sessionTarget as unknown as XRSession,
  };
  return {
    xr,
    start: () => onStart?.(),
    select: (hand) => {
      const event = Object.assign(new Event('selectstart'), { inputSource: { handedness: hand } });
      sessionTarget.dispatchEvent(event);
    },
  };
}

test('counts selectstart per handedness once a session starts', () => {
  const { xr, start, select } = fakeXr();
  const counter = createInputCounter(xr);
  select('right');
  expect(counter.selectstart.right).toBe(0);
  start();
  select('right');
  select('right');
  select('left');
  expect(counter.selectstart).toEqual({ none: 0, left: 1, right: 2 });
});
