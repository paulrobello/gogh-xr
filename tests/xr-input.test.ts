import { describe, expect, it } from 'vitest';
import {
  type Actions,
  createInput,
  DEADZONE,
  type InputSourceLike,
  type KeyboardState,
  MAX_DT,
  MENU_BUTTON,
  MOUSE_GRIP,
  MOUSE_SELECT,
  RECENTER_HOLD_SECONDS,
  radialDeadzone,
  SNAP_THRESHOLD,
  TELEPORT_AIM_THRESHOLD,
  XR_BUTTON,
} from '../src/xr/input';

type Hand = 'left' | 'right';

/** A fake xr-standard controller pair: axes [2]/[3] are the thumbstick, buttons by index. */
function fakeControllers() {
  const make = (handedness: Hand) => ({
    handedness,
    gamepad: {
      mapping: 'xr-standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 7 }, () => ({ pressed: false })),
    },
  });
  const left = make('left');
  const right = make('right');
  const sources: InputSourceLike[] = [left, right];
  return {
    sources,
    stick(hand: Hand, x: number, y: number) {
      const pad = (hand === 'left' ? left : right).gamepad;
      pad.axes[2] = x;
      pad.axes[3] = y;
    },
    button(hand: Hand, index: number, pressed: boolean) {
      const pad = (hand === 'left' ? left : right).gamepad;
      const button = pad.buttons[index];
      if (button) button.pressed = pressed;
    },
  };
}

function fakeKeyboard() {
  const keys = new Set<string>();
  const mouseButtons = new Set<number>();
  const state: KeyboardState = { keys, mouseButtons };
  return {
    state,
    key(code: string, down: boolean) {
      if (down) keys.add(code);
      else keys.delete(code);
    },
    mouse(button: number, down: boolean) {
      if (down) mouseButtons.add(button);
      else mouseButtons.delete(button);
    },
  };
}

const DT = 1 / 90;

function setup() {
  const input = createInput();
  const xr = fakeControllers();
  const kb = fakeKeyboard();
  const read = (dt = DT): Actions => input.read(xr.sources, kb.state, dt);
  return { input, xr, kb, read };
}

describe('radialDeadzone', () => {
  it('is zero inside the 0.15 radius and starts from zero at its edge', () => {
    expect(DEADZONE).toBe(0.15);
    expect(radialDeadzone(0.1, 0.1)).toEqual({ x: 0, y: 0 });
    const edge = radialDeadzone(0.15, 0);
    expect(edge.x).toBeCloseTo(0, 10);
    expect(radialDeadzone(0.575, 0).x).toBeCloseTo(0.5, 10);
    expect(radialDeadzone(1, 0).x).toBeCloseTo(1, 10);
  });

  it('keeps the direction and caps the magnitude at 1', () => {
    const v = radialDeadzone(1, 1);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 10);
    expect(v.x).toBeCloseTo(v.y, 10);
    const half = radialDeadzone(0, -0.575);
    expect(half.x).toBe(0);
    expect(half.y).toBeCloseTo(-0.5, 10);
  });
});

describe('createInput: sticks', () => {
  it('maps the left stick to move, forward positive, after the deadzone', () => {
    const { xr, read } = setup();
    xr.stick('left', 0.1, -0.1);
    expect(read().move).toEqual({ x: 0, y: 0 });
    // xr-standard: pushing the stick forward makes axes[3] negative.
    xr.stick('left', 0, -1);
    const a = read();
    expect(a.move.x).toBeCloseTo(0, 10);
    expect(a.move.y).toBeCloseTo(1, 10);
    xr.stick('left', 1, 1);
    const diag = read().move;
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(1, 10);
    expect(diag.x).toBeGreaterThan(0);
    expect(diag.y).toBeLessThan(0);
  });

  it('maps right stick X to turn and right stick Y to vertical, up positive', () => {
    const { xr, read } = setup();
    xr.stick('right', 0.1, 0);
    expect(read().turn.x).toBe(0);
    xr.stick('right', 0.575, 0);
    expect(read().turn.x).toBeCloseTo(0.5, 10);
    xr.stick('right', 0, -1);
    expect(read().vertical).toBeCloseTo(1, 10);
    xr.stick('right', 0, 1);
    expect(read().vertical).toBeCloseTo(-1, 10);
  });

  it('ignores a gamepad without the xr-standard mapping', () => {
    const { xr, read } = setup();
    for (const source of xr.sources) {
      if (source.gamepad) (source.gamepad as { mapping: string }).mapping = '';
    }
    xr.stick('left', 0, -1);
    xr.button('right', XR_BUTTON.TRIGGER, true);
    const a = read();
    expect(a.move).toEqual({ x: 0, y: 0 });
    expect(a.select.down).toBe(false);
  });

  it('reports sprint while either Shift key is held, and never from a controller', () => {
    const { xr, kb, read } = setup();
    xr.stick('left', 0, -1);
    expect(read().sprint).toBe(false);
    kb.key('ShiftLeft', true);
    expect(read().sprint).toBe(true);
    kb.key('ShiftLeft', false);
    kb.key('ShiftRight', true);
    expect(read().sprint).toBe(true);
    kb.key('ShiftRight', false);
    expect(read().sprint).toBe(false);
  });

  it('reads nothing from null or empty sources', () => {
    const input = createInput();
    const kb = fakeKeyboard();
    expect(input.read(null, kb.state, DT).move).toEqual({ x: 0, y: 0 });
    expect(input.read([], kb.state, DT).select.down).toBe(false);
    expect(input.read([{ handedness: 'right', gamepad: null }], kb.state, DT).turn.x).toBe(0);
  });
});

describe('createInput: elapsed time', () => {
  it('carries dt in seconds, clamped to [0, 0.1]', () => {
    const { read } = setup();
    expect(MAX_DT).toBe(0.1);
    expect(read(0.016).dt).toBeCloseTo(0.016, 10);
    expect(read(0.5).dt).toBe(0.1);
    expect(read(-1).dt).toBe(0);
    expect(read(Number.NaN).dt).toBe(0);
  });

  it('moves a consumer in units per second whatever the frame rate', () => {
    // A full forward stick at 2 m/s for one second, split into 72 Hz or 120 Hz frames.
    const distance = (hz: number): number => {
      const { xr, read } = setup();
      xr.stick('left', 0, -1);
      let z = 0;
      for (let i = 0; i < hz; i += 1) {
        const a = read(1 / hz);
        z += a.move.y * 2 * a.dt;
      }
      return z;
    };
    expect(distance(72)).toBeCloseTo(2, 6);
    expect(distance(120)).toBeCloseTo(2, 6);
  });
});

describe('createInput: snap turn', () => {
  it('requests one snap per push past the threshold', () => {
    const { xr, read } = setup();
    expect(SNAP_THRESHOLD).toBe(0.7);
    xr.stick('right', 0.5, 0);
    expect(read().turn.snap).toBe(0);
    xr.stick('right', 0.9, 0);
    expect(read().turn.snap).toBe(1);
    expect(read().turn.snap).toBe(0);
    expect(read().turn.snap).toBe(0);
  });

  it('re-arms only once the stick returns inside the deadzone', () => {
    const { xr, read } = setup();
    xr.stick('right', -1, 0);
    expect(read().turn.snap).toBe(-1);
    // Easing back to 0.2 is still outside the deadzone, so a second push must not snap.
    xr.stick('right', -0.2, 0);
    expect(read().turn.snap).toBe(0);
    xr.stick('right', -1, 0);
    expect(read().turn.snap).toBe(0);
    xr.stick('right', -0.1, 0);
    expect(read().turn.snap).toBe(0);
    xr.stick('right', -1, 0);
    expect(read().turn.snap).toBe(-1);
  });

  it('does not re-arm while the stick rolls right, forward and right again', () => {
    const { xr, read } = setup();
    let snaps = 0;
    const roll: [number, number][] = [
      [1, 0],
      [Math.SQRT1_2, -Math.SQRT1_2],
      [0, -1],
      [Math.SQRT1_2, -Math.SQRT1_2],
      [1, 0],
    ];
    for (const [x, y] of roll) {
      xr.stick('right', x, y);
      if (read().turn.snap !== 0) snaps += 1;
    }
    expect(snaps).toBe(1);
  });

  it('re-arms on Q or E key-up', () => {
    const { kb, read } = setup();
    kb.key('KeyE', true);
    expect(read().turn.snap).toBe(1);
    expect(read().turn.snap).toBe(0);
    kb.key('KeyE', false);
    expect(read().turn.snap).toBe(0);
    kb.key('KeyQ', true);
    expect(read().turn.snap).toBe(-1);
  });
});

describe('createInput: dominant axis', () => {
  it('a 45° push on the right stick neither snaps nor aims', () => {
    const { xr, read } = setup();
    xr.stick('right', Math.SQRT1_2, -Math.SQRT1_2);
    const a = read();
    expect(a.turn.snap).toBe(0);
    expect(a.teleportAim).toBe(false);
  });

  it('a push just off 45°, past both thresholds, does only the dominant one', () => {
    // Both components clear 0.7 after the deadzone, so only the dominant-axis rule decides.
    const turnSide = setup();
    turnSide.xr.stick('right', 0.713, -0.701);
    let a = turnSide.read();
    expect(a.turn.snap).toBe(1);
    expect(a.teleportAim).toBe(false);

    const aimSide = setup();
    aimSide.xr.stick('right', 0.701, -0.713);
    a = aimSide.read();
    expect(a.turn.snap).toBe(0);
    expect(a.teleportAim).toBe(true);
  });
});

describe('createInput: teleport', () => {
  it('aims while the right stick is forward past the threshold and commits on release', () => {
    const { xr, read } = setup();
    expect(TELEPORT_AIM_THRESHOLD).toBe(0.7);
    xr.stick('right', 0, -0.5);
    expect(read().teleportAim).toBe(false);
    xr.stick('right', 0, -1);
    let a = read();
    expect(a.teleportAim).toBe(true);
    expect(a.teleportCommit).toBe(false);
    a = read();
    expect(a.teleportAim).toBe(true);
    expect(a.teleportCommit).toBe(false);
    xr.stick('right', 0, 0);
    a = read();
    expect(a.teleportAim).toBe(false);
    expect(a.teleportCommit).toBe(true);
    expect(read().teleportCommit).toBe(false);
  });

  it('does not aim from a backward push', () => {
    const { xr, read } = setup();
    xr.stick('right', 0, 1);
    expect(read().teleportAim).toBe(false);
  });
});

describe('createInput: buttons', () => {
  it('edge-detects flight toggle on right B, once per press', () => {
    const { xr, read } = setup();
    xr.button('right', XR_BUTTON.B, true);
    expect(read().flightToggle).toBe(true);
    expect(read().flightToggle).toBe(false);
    expect(read().flightToggle).toBe(false);
    xr.button('right', XR_BUTTON.B, false);
    expect(read().flightToggle).toBe(false);
    xr.button('right', XR_BUTTON.B, true);
    expect(read().flightToggle).toBe(true);
  });

  it('does not map left X or left Y; right A is menu (P5.3)', () => {
    const { xr, read } = setup();
    xr.button('left', 4, true);
    xr.button('left', 5, true);
    let a = read();
    expect(a.flightToggle).toBe(false);
    expect(a.menu).toBe(false);
    expect(a.select.down).toBe(false);
    expect(a.grip.down).toBe(false);
    xr.button('right', XR_BUTTON.A, true);
    a = read();
    expect(a.menu).toBe(true);
    expect(a.flightToggle).toBe(false);
  });

  it('edge-detects menu on the left controller button index 6', () => {
    const { xr, read } = setup();
    expect(MENU_BUTTON).toBe(6);
    xr.button('right', MENU_BUTTON, true);
    expect(read().menu).toBe(false);
    xr.button('left', MENU_BUTTON, true);
    expect(read().menu).toBe(true);
    expect(read().menu).toBe(false);
  });

  it('reports select and grip as a level plus a press edge from either hand', () => {
    const { xr, read } = setup();
    xr.button('left', XR_BUTTON.TRIGGER, true);
    let a = read();
    expect(a.select).toEqual({ down: true, fired: true });
    // A second hand joining an already-held select is not a new press.
    xr.button('right', XR_BUTTON.TRIGGER, true);
    expect(read().select).toEqual({ down: true, fired: false });
    xr.button('left', XR_BUTTON.TRIGGER, false);
    xr.button('right', XR_BUTTON.TRIGGER, false);
    expect(read().select).toEqual({ down: false, fired: false });

    xr.button('right', XR_BUTTON.SQUEEZE, true);
    a = read();
    expect(a.grip).toEqual({ down: true, fired: true });
    expect(a.select.down).toBe(false);
  });

  it('fires recenter once when both stick clicks are held for 1 s', () => {
    const { xr, read } = setup();
    expect(RECENTER_HOLD_SECONDS).toBe(1);
    xr.button('left', XR_BUTTON.THUMBSTICK, true);
    for (let i = 0; i < 20; i += 1) expect(read(0.1).recenter).toBe(false);
    xr.button('right', XR_BUTTON.THUMBSTICK, true);
    // The first held frame's dt is time from before the press, so it starts the hold at 0. Ten
    // more 0.1 s frames make 1 s, even though the float sum lands just under 1.
    for (let i = 0; i < 10; i += 1) expect(read(0.1).recenter).toBe(false);
    expect(read(0.1).recenter).toBe(true);
    for (let i = 0; i < 20; i += 1) expect(read(0.1).recenter).toBe(false);
    // Releasing either click re-arms and restarts the hold.
    xr.button('left', XR_BUTTON.THUMBSTICK, false);
    expect(read(0.1).recenter).toBe(false);
    xr.button('left', XR_BUTTON.THUMBSTICK, true);
    for (let i = 0; i < 10; i += 1) expect(read(0.1).recenter).toBe(false);
    expect(read(0.1).recenter).toBe(true);
  });

  it('never fires recenter before 1 s of hold has elapsed', () => {
    const { xr, read } = setup();
    xr.button('left', XR_BUTTON.THUMBSTICK, true);
    xr.button('right', XR_BUTTON.THUMBSTICK, true);
    // At 20 Hz the first frame's 0.05 s predates the press, so 1 s of hold is the 21st frame.
    for (let i = 0; i < 20; i += 1) expect(read(0.05).recenter).toBe(false);
    expect(read(0.05).recenter).toBe(true);
  });

  it('times the recenter hold with clamped dt, so one long frame cannot fire it', () => {
    const { xr, read } = setup();
    xr.button('left', XR_BUTTON.THUMBSTICK, true);
    xr.button('right', XR_BUTTON.THUMBSTICK, true);
    expect(read(5).recenter).toBe(false);
    expect(read(0.5).recenter).toBe(false);
  });
});

describe('createInput: held-button suppression', () => {
  it('silences a button held across a mode switch until it is released once', () => {
    const { input, xr, read } = setup();
    xr.button('right', XR_BUTTON.TRIGGER, true);
    expect(read().select).toEqual({ down: true, fired: true });
    input.suppressHeld();
    expect(read().select).toEqual({ down: false, fired: false });
    expect(read().select).toEqual({ down: false, fired: false });
    xr.button('right', XR_BUTTON.TRIGGER, false);
    expect(read().select).toEqual({ down: false, fired: false });
    xr.button('right', XR_BUTTON.TRIGGER, true);
    expect(read().select).toEqual({ down: true, fired: true });
  });

  it('keeps right B held across a flight toggle from toggling again', () => {
    const { input, xr, read } = setup();
    xr.button('right', XR_BUTTON.B, true);
    expect(read().flightToggle).toBe(true);
    input.suppressHeld();
    xr.button('right', XR_BUTTON.B, false);
    read();
    xr.button('right', XR_BUTTON.B, true);
    expect(read().flightToggle).toBe(true);
  });

  it('keeps F held across a flight toggle silent until released', () => {
    const { input, kb, read } = setup();
    kb.key('KeyF', true);
    expect(read().flightToggle).toBe(true);
    input.suppressHeld();
    expect(read().flightToggle).toBe(false);
    kb.key('KeyF', false);
    expect(read().flightToggle).toBe(false);
    kb.key('KeyF', true);
    expect(read().flightToggle).toBe(true);
  });

  it('leaves buttons pressed after the switch alone', () => {
    const { input, xr, read } = setup();
    input.suppressHeld();
    xr.button('left', XR_BUTTON.SQUEEZE, true);
    expect(read().grip).toEqual({ down: true, fired: true });
  });

  it('drops a held teleport aim without committing it', () => {
    const { input, xr, read } = setup();
    xr.stick('right', 0, -1);
    expect(read().teleportAim).toBe(true);
    input.suppressHeld();
    let a = read();
    expect(a.teleportAim).toBe(false);
    expect(a.teleportCommit).toBe(false);
    xr.stick('right', 0, 0);
    a = read();
    expect(a.teleportAim).toBe(false);
    expect(a.teleportCommit).toBe(false);
    xr.stick('right', 0, -1);
    expect(read().teleportAim).toBe(true);
  });

  it('restarts a recenter hold whose clicks were held across the switch', () => {
    const { input, xr, read } = setup();
    xr.button('left', XR_BUTTON.THUMBSTICK, true);
    xr.button('right', XR_BUTTON.THUMBSTICK, true);
    for (let i = 0; i < 5; i += 1) read(0.1);
    input.suppressHeld();
    for (let i = 0; i < 20; i += 1) expect(read(0.1).recenter).toBe(false);
  });

  it('does not suppress the continuous stick axes', () => {
    const { input, xr, read } = setup();
    xr.stick('left', 0, -1);
    read();
    input.suppressHeld();
    expect(read().move.y).toBeCloseTo(1, 10);
  });
});

describe('createInput: frame reuse', () => {
  it('returns the same Actions object every frame', () => {
    const { read } = setup();
    const first = read();
    const second = read();
    expect(second).toBe(first);
    expect(second.move).toBe(first.move);
  });
});

/**
 * Keyboard parity (ruling 8): each XR action has a keyboard equivalent that produces the same
 * Actions field. select and grip come from the mouse buttons on desktop.
 */
interface ParityRow {
  readonly action: string;
  readonly xr: (c: ReturnType<typeof fakeControllers>) => void;
  readonly desktop: (k: ReturnType<typeof fakeKeyboard>) => void;
  /** The field(s) both inputs must produce on the first frame, and frames to run first. */
  readonly pick: (a: Actions) => unknown;
  /** Optional release step and the frame after it, for edges on release. */
  readonly releaseXr?: (c: ReturnType<typeof fakeControllers>) => void;
  readonly releaseDesktop?: (k: ReturnType<typeof fakeKeyboard>) => void;
  readonly frames?: number;
}

const PARITY: readonly ParityRow[] = [
  {
    action: 'move forward',
    xr: (c) => c.stick('left', 0, -1),
    desktop: (k) => k.key('KeyW', true),
    pick: (a) => [a.move.x, a.move.y],
  },
  {
    action: 'move back',
    xr: (c) => c.stick('left', 0, 1),
    desktop: (k) => k.key('KeyS', true),
    pick: (a) => [a.move.x, a.move.y],
  },
  {
    action: 'move left',
    xr: (c) => c.stick('left', -1, 0),
    desktop: (k) => k.key('KeyA', true),
    pick: (a) => [a.move.x, a.move.y],
  },
  {
    action: 'move right',
    xr: (c) => c.stick('left', 1, 0),
    desktop: (k) => k.key('KeyD', true),
    pick: (a) => [a.move.x, a.move.y],
  },
  {
    action: 'move diagonal',
    xr: (c) => c.stick('left', Math.SQRT1_2, -Math.SQRT1_2),
    desktop: (k) => {
      k.key('KeyW', true);
      k.key('KeyD', true);
    },
    pick: (a) => [a.move.x, a.move.y],
  },
  {
    action: 'snap turn left',
    xr: (c) => c.stick('right', -1, 0),
    desktop: (k) => k.key('KeyQ', true),
    pick: (a) => [a.turn.x, a.turn.snap],
  },
  {
    action: 'snap turn right',
    xr: (c) => c.stick('right', 1, 0),
    desktop: (k) => k.key('KeyE', true),
    pick: (a) => [a.turn.x, a.turn.snap],
  },
  {
    action: 'teleport aim',
    xr: (c) => c.stick('right', 0, -1),
    desktop: (k) => k.key('KeyT', true),
    pick: (a) => [a.teleportAim, a.teleportCommit],
  },
  {
    action: 'teleport commit',
    xr: (c) => c.stick('right', 0, -1),
    desktop: (k) => k.key('KeyT', true),
    releaseXr: (c) => c.stick('right', 0, 0),
    releaseDesktop: (k) => k.key('KeyT', false),
    pick: (a) => [a.teleportAim, a.teleportCommit],
  },
  {
    action: 'flight toggle',
    xr: (c) => c.button('right', XR_BUTTON.B, true),
    desktop: (k) => k.key('KeyF', true),
    pick: (a) => a.flightToggle,
  },
  {
    action: 'vertical up',
    // Teleport aim also reads stick forward; vertical is the field under test.
    xr: (c) => c.stick('right', 0, -1),
    desktop: (k) => k.key('Space', true),
    pick: (a) => a.vertical,
  },
  {
    action: 'vertical down',
    xr: (c) => c.stick('right', 0, 1),
    desktop: (k) => k.key('KeyC', true),
    pick: (a) => a.vertical,
  },
  {
    action: 'menu',
    xr: (c) => c.button('left', MENU_BUTTON, true),
    desktop: (k) => k.key('KeyM', true),
    pick: (a) => a.menu,
  },
  {
    action: 'recenter',
    xr: (c) => {
      c.button('left', XR_BUTTON.THUMBSTICK, true);
      c.button('right', XR_BUTTON.THUMBSTICK, true);
    },
    desktop: (k) => k.key('KeyR', true),
    pick: (a) => a.recenter,
    frames: 11,
  },
  {
    action: 'select',
    xr: (c) => c.button('right', XR_BUTTON.TRIGGER, true),
    desktop: (k) => k.mouse(MOUSE_SELECT, true),
    pick: (a) => ({ ...a.select }),
  },
  {
    action: 'grip',
    xr: (c) => c.button('right', XR_BUTTON.SQUEEZE, true),
    desktop: (k) => k.mouse(MOUSE_GRIP, true),
    pick: (a) => ({ ...a.grip }),
  },
];

describe('keyboard parity', () => {
  /** Runs one side of a row and returns the picked field, as plain numbers rounded to 1e-9. */
  function run(row: ParityRow, side: 'xr' | 'desktop'): unknown {
    const { xr, kb, read } = setup();
    if (side === 'xr') row.xr(xr);
    else row.desktop(kb);
    let a = read(0.1);
    for (let i = 1; i < (row.frames ?? 1); i += 1) a = read(0.1);
    const release = side === 'xr' ? row.releaseXr : row.releaseDesktop;
    if (release) {
      if (side === 'xr') row.releaseXr?.(xr);
      else row.releaseDesktop?.(kb);
      a = read(0.1);
    }
    return JSON.parse(
      JSON.stringify(row.pick(a), (_key, value: unknown) =>
        typeof value === 'number' ? Math.round(value * 1e9) / 1e9 : value,
      ),
    ) as unknown;
  }

  it.each(PARITY)('$action: the keyboard matches the controller', (row) => {
    const xr = run(row, 'xr');
    expect(run(row, 'desktop')).toEqual(xr);
    // The row must exercise its action, not compare two idle frames.
    expect(run(row, 'desktop')).not.toEqual(run({ ...row, desktop: () => undefined }, 'desktop'));
  });

  it.each([
    [
      'flight toggle (F)',
      (k: ReturnType<typeof fakeKeyboard>) => k.key('KeyF', true),
      (a: Actions) => a.flightToggle,
    ],
    [
      'menu (M)',
      (k: ReturnType<typeof fakeKeyboard>) => k.key('KeyM', true),
      (a: Actions) => a.menu,
    ],
    [
      'select (mouse)',
      (k: ReturnType<typeof fakeKeyboard>) => k.mouse(MOUSE_SELECT, true),
      (a: Actions) => a.select.fired,
    ],
    [
      'grip (mouse)',
      (k: ReturnType<typeof fakeKeyboard>) => k.mouse(MOUSE_GRIP, true),
      (a: Actions) => a.grip.fired,
    ],
    [
      'snap (E)',
      (k: ReturnType<typeof fakeKeyboard>) => k.key('KeyE', true),
      (a: Actions) => a.turn.snap !== 0,
    ],
  ])('%s: a held key fires once, then stays quiet', (_name, press, edge) => {
    const { kb, read } = setup();
    press(kb);
    expect(edge(read())).toBe(true);
    for (let i = 0; i < 5; i += 1) expect(edge(read())).toBe(false);
  });

  it('Ctrl no longer moves down; C does', () => {
    const { kb, read } = setup();
    kb.key('ControlLeft', true);
    expect(read().vertical).toBe(0);
    kb.key('KeyC', true);
    expect(read().vertical).toBe(-1);
  });

  it('signs match: W, Space and E are forward, up and right', () => {
    const { kb, read } = setup();
    kb.key('KeyW', true);
    kb.key('Space', true);
    kb.key('KeyE', true);
    const a = read();
    expect(a.move.y).toBe(1);
    expect(a.vertical).toBe(1);
    expect(a.turn.x).toBe(1);
    expect(a.turn.snap).toBe(1);
  });

  it('clamps a stick plus keys to magnitude 1', () => {
    const { xr, kb, read } = setup();
    xr.stick('left', 0, -1);
    kb.key('KeyW', true);
    kb.key('KeyD', true);
    const m = read().move;
    expect(Math.hypot(m.x, m.y)).toBeLessThanOrEqual(1 + 1e-12);
    xr.stick('right', 0, -1);
    kb.key('Space', true);
    expect(read().vertical).toBe(1);
  });
});
