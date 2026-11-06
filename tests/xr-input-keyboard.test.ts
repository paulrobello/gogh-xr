import { describe, expect, it } from 'vitest';
import { installKeyboardInput } from '../src/xr/input-keyboard';

function keyEvent(type: string, code: string): Event {
  return Object.assign(new Event(type, { cancelable: true }), { code });
}

function mouseEvent(type: string, button: number): Event {
  return Object.assign(new Event(type, { cancelable: true }), { button });
}

function setup({ locked = true }: { locked?: boolean } = {}) {
  const win = new EventTarget();
  const canvas = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: locked ? (canvas as unknown) : null,
    visibilityState: 'visible' as DocumentVisibilityState,
  });
  const { state, dispose } = installKeyboardInput(win, canvas, doc);
  return { win, canvas, doc, state, dispose };
}

describe('installKeyboardInput', () => {
  it('tracks held keys by code', () => {
    const { win, state } = setup();
    win.dispatchEvent(keyEvent('keydown', 'KeyW'));
    win.dispatchEvent(keyEvent('keydown', 'Space'));
    expect([...state.keys].sort()).toEqual(['KeyW', 'Space']);
    win.dispatchEvent(keyEvent('keyup', 'KeyW'));
    expect([...state.keys]).toEqual(['Space']);
  });

  it('tracks mouse buttons pressed on the locked canvas and released anywhere', () => {
    const { win, canvas, state } = setup();
    canvas.dispatchEvent(mouseEvent('mousedown', 0));
    canvas.dispatchEvent(mouseEvent('mousedown', 2));
    expect([...state.mouseButtons].sort()).toEqual([0, 2]);
    win.dispatchEvent(mouseEvent('mouseup', 0));
    expect([...state.mouseButtons]).toEqual([2]);
  });

  it('ignores the click that requests pointer lock, so it never selects', () => {
    const { win, canvas, doc, state } = setup({ locked: false });
    canvas.dispatchEvent(mouseEvent('mousedown', 0));
    expect(state.mouseButtons.size).toBe(0);
    win.dispatchEvent(mouseEvent('mouseup', 0));
    doc.pointerLockElement = canvas;
    canvas.dispatchEvent(mouseEvent('mousedown', 0));
    expect([...state.mouseButtons]).toEqual([0]);
  });

  it('clears everything when the window loses focus', () => {
    const { win, canvas, state } = setup();
    win.dispatchEvent(keyEvent('keydown', 'KeyT'));
    canvas.dispatchEvent(mouseEvent('mousedown', 0));
    win.dispatchEvent(new Event('blur'));
    expect(state.keys.size).toBe(0);
    expect(state.mouseButtons.size).toBe(0);
  });

  it('clears everything when the page is hidden', () => {
    const { win, canvas, doc, state } = setup();
    win.dispatchEvent(keyEvent('keydown', 'KeyW'));
    canvas.dispatchEvent(mouseEvent('mousedown', 2));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(state.keys.size).toBe(1);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(state.keys.size).toBe(0);
    expect(state.mouseButtons.size).toBe(0);
  });

  it('keeps the context menu off the canvas so the right button can grip', () => {
    const { canvas } = setup();
    const event = new Event('contextmenu', { cancelable: true });
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('cancels Space and the movement keys only while the canvas holds pointer lock', () => {
    const locked = setup();
    for (const code of ['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC']) {
      const event = keyEvent('keydown', code);
      locked.win.dispatchEvent(event);
      expect(event.defaultPrevented, code).toBe(true);
    }
    const other = keyEvent('keydown', 'KeyH');
    locked.win.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);

    const unlocked = setup({ locked: false });
    const space = keyEvent('keydown', 'Space');
    unlocked.win.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    expect(unlocked.state.keys.has('Space')).toBe(true);
  });

  it('dispose removes every listener', () => {
    const { win, canvas, doc, state, dispose } = setup();
    win.dispatchEvent(keyEvent('keydown', 'KeyW'));
    canvas.dispatchEvent(mouseEvent('mousedown', 0));
    dispose();
    win.dispatchEvent(keyEvent('keyup', 'KeyW'));
    win.dispatchEvent(keyEvent('keydown', 'KeyS'));
    win.dispatchEvent(mouseEvent('mouseup', 0));
    canvas.dispatchEvent(mouseEvent('mousedown', 2));
    win.dispatchEvent(new Event('blur'));
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect([...state.keys]).toEqual(['KeyW']);
    expect([...state.mouseButtons]).toEqual([0]);
    const menu = new Event('contextmenu', { cancelable: true });
    canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
    const space = keyEvent('keydown', 'Space');
    win.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
  });
});
