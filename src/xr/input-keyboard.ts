/**
 * Captures the desktop keyboard and mouse into the live `KeyboardState` that `input.ts` reads
 * each frame. Holds levels only; `input.ts` derives every edge.
 */
import type { KeyboardState } from './input';

/** The parts of `document` the adapter reads. */
export interface KeyboardDocument extends EventTarget {
  readonly pointerLockElement: unknown;
  readonly visibilityState: DocumentVisibilityState;
}

export interface KeyboardInput {
  readonly state: KeyboardState;
  /** Removes every listener. The state keeps whatever it last held. */
  dispose(): void;
}

/** Keys whose browser default (scrolling, pressing a focused button) is cancelled under lock. */
const LOCKED_KEYS: ReadonlySet<string> = new Set([
  'Space',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyC',
]);

/**
 * Listens for keys on `win` and mouse presses on `canvas` (released anywhere on `win`).
 * - A mouse press counts only while `canvas` holds pointer lock: an unlocked click is the one
 *   that requests the lock (src/desktop/controls.ts), and it must not select.
 * - Losing window focus or hiding the page releases everything, so no key stays held.
 */
export function installKeyboardInput(
  win: EventTarget,
  canvas: EventTarget,
  doc: KeyboardDocument,
): KeyboardInput {
  const keys = new Set<string>();
  const mouseButtons = new Set<number>();
  const locked = (): boolean => doc.pointerLockElement === canvas;
  const clear = (): void => {
    keys.clear();
    mouseButtons.clear();
  };

  const onKeyDown = (event: Event): void => {
    const { code } = event as KeyboardEvent;
    keys.add(code);
    if (locked() && LOCKED_KEYS.has(code)) event.preventDefault();
  };
  const onKeyUp = (event: Event): void => {
    keys.delete((event as KeyboardEvent).code);
  };
  const onMouseDown = (event: Event): void => {
    if (locked()) mouseButtons.add((event as MouseEvent).button);
  };
  const onMouseUp = (event: Event): void => {
    mouseButtons.delete((event as MouseEvent).button);
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') clear();
  };
  // The right button is desktop grip, so the canvas keeps its context menu closed.
  const onContextMenu = (event: Event): void => event.preventDefault();

  const listeners: [EventTarget, string, (event: Event) => void][] = [
    [win, 'keydown', onKeyDown],
    [win, 'keyup', onKeyUp],
    [canvas, 'mousedown', onMouseDown],
    [win, 'mouseup', onMouseUp],
    [win, 'blur', clear],
    [doc, 'visibilitychange', onVisibility],
    [canvas, 'contextmenu', onContextMenu],
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);

  return {
    state: { keys, mouseButtons },
    dispose() {
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    },
  };
}
