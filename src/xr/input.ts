/**
 * The input action layer: XR gamepads and the keyboard/mouse folded into one `Actions` frame per
 * animation frame. Pure: the caller passes the XR input sources (structurally typed, so tests can
 * fake them) and a keyboard/mouse snapshot (`input-keyboard.ts` captures it from the DOM).
 *
 * Not mapped here, by design (P3 ruling Q1): left X (perf HUD), left Y (the bench's frame-rate
 * step), and the desktop H key (HUD). Those keep their own handlers. Right A joins `menu` (P5.3):
 * outside the bench it was free, and the bench, which steps foveation on it, never runs the panel.
 *
 * Ray convention for later ray helpers (vault Patterns/mux-xr-quest-interaction-patterns.md):
 * three's `Object3D.lookAt` on a Group points its +Z at the target, while a controller's
 * target-ray space points along -Z. Reconcile the two explicitly.
 */

/** xr-standard gamepad button indices (WebXR Gamepads Module). */
export const XR_BUTTON = {
  TRIGGER: 0,
  SQUEEZE: 1,
  THUMBSTICK: 3,
  /** A on the right controller (`menu`, P5.3), X on the left (not mapped, Q1). */
  A: 4,
  /** B on the right controller, Y on the left. Right B toggles flight. */
  B: 5,
} as const;

/**
 * Left controller button for `menu`. xr-standard reserves no menu slot. Index 6 is the first
 * non-standard one, and IWER's Quest profile puts the thumbrest there, so only `pressed` is read,
 * never `touched`. Whether Quest exposes its left menu button to WebXR at all is unverified.
 * Revisit with P5.
 */
export const MENU_BUTTON = 6;

/** xr-standard axes: [2] is thumbstick X (right positive), [3] is Y (forward negative). */
const AXIS_X = 2;
const AXIS_Y = 3;

/** `MouseEvent.button` values for desktop select and grip. */
export const MOUSE_SELECT = 0;
export const MOUSE_GRIP = 2;

/** Radial stick deadzone, rescaled so output starts at 0 at its edge. */
export const DEADZONE = 0.15;
/** Turn magnitude, after the deadzone, that fires a snap request. */
export const SNAP_THRESHOLD = 0.7;
/** Forward push, after the deadzone, that starts a teleport aim. */
export const TELEPORT_AIM_THRESHOLD = 0.7;
/** Forward push below which an aim ends and commits. Lower than the start, so it cannot chatter. */
export const TELEPORT_RELEASE_THRESHOLD = 0.3;
/** Seconds both stick clicks (or R) must be held to recenter. */
export const RECENTER_HOLD_SECONDS = 1;
/** dt clamp. src/locomotion/step.ts clamps with it too. */
export const MAX_DT = 0.1;
/** Absorbs float error when summing frame dts toward the hold time (10 × 0.1 < 1). */
const HOLD_EPSILON = 1e-9;

export interface InputSourceLike {
  readonly handedness: string;
  readonly gamepad?: {
    readonly mapping?: string;
    readonly axes: readonly number[];
    readonly buttons?: readonly { readonly pressed: boolean }[];
  } | null;
}

/** Held keys (`KeyboardEvent.code`) and mouse buttons (`MouseEvent.button`). */
export interface KeyboardState {
  readonly keys: ReadonlySet<string>;
  readonly mouseButtons: ReadonlySet<number>;
}

export type Hand = 'left' | 'right';

export interface ButtonAction {
  /** Level: held this frame. */
  down: boolean;
  /** Edge: true only on the frame `down` became true. */
  fired: boolean;
}

/** One frame of actions. `read()` mutates and returns the same object every frame. */
export interface Actions {
  /** Seconds since the previous frame, clamped to [0, 0.1]. Multiply per-second rates by it. */
  dt: number;
  /**
   * Left stick after the radial deadzone, plus WASD. Head-relative stick space: x is right
   * positive, y is forward positive. Magnitude ≤ 1, unitless (locomotion scales it by m/s × dt).
   */
  move: { x: number; y: number };
  /** Level: either Shift key held. Desktop only; locomotion doubles the move speed, capped. */
  sprint: boolean;
  turn: {
    /** Right stick X after the deadzone, plus E (+1) and Q (−1). −1..1, right positive. */
    x: number;
    /**
     * Snap request: +1 right, −1 left, 0 none. Fires once when |x| reaches 0.7 and beats the right
     * stick's |y|, and re-arms only once the whole stick is back inside the radial deadzone and
     * Q/E are up.
     */
    snap: -1 | 0 | 1;
  };
  /**
   * Level: right stick forward past 0.7 with Y beating |X| (then held until Y drops below 0.3),
   * or T held.
   */
  teleportAim: boolean;
  /** Edge: true on the frame `teleportAim` ends. */
  teleportCommit: boolean;
  /** Edge: right B or F pressed. */
  flightToggle: boolean;
  /**
   * Right stick Y after the deadzone, plus Space (+1) and C (−1). −1..1, up positive. Always
   * reported; locomotion uses it only while flying.
   */
  vertical: number;
  /**
   * Edge: left button index 6 (`MENU_BUTTON`), right A or M pressed. Right A is the panel's second
   * XR open gesture (P5.3), since Quest's menu button is unverified and index 6 is a thumbrest in
   * IWER.
   */
  menu: boolean;
  /**
   * Either trigger, or the left mouse button on desktop. A hand the settings panel holds
   * (`claim`) is left out, so a trigger on the panel selects nothing else.
   */
  select: ButtonAction;
  /** Either grip (squeeze), or the right mouse button on desktop. A claimed hand is left out. */
  grip: ButtonAction;
  /**
   * Each controller's own trigger and grip, after suppression and before any claim, and its stick
   * after the radial deadzone (x right, y forward), before `holdSticks`.
   */
  hands: Record<
    Hand,
    { trigger: ButtonAction; grip: ButtonAction; stick: { x: number; y: number } }
  >;
  /** Edge: once, when both stick clicks (or R) have been held for 1 s. */
  recenter: boolean;
  /**
   * Edge: cycles the active A/B group (src/diag/ab.ts). Fires on the release of a single left
   * stick click, unless the right stick was pressed at any point during that hold (both sticks
   * held is recenter), or on a V press.
   */
  abCycle: boolean;
}

export interface Input {
  /** Reads one frame. Returns the same `Actions` object every call. */
  read(
    sources: ArrayLike<InputSourceLike> | null | undefined,
    keyboard: KeyboardState,
    dt: number,
  ): Actions;
  /**
   * Call on a mode switch (flight toggle, teleport commit, panel open). Every button held now,
   * on a controller or the keyboard/mouse, and a held teleport aim, report nothing (no level, no
   * edge) until released once. The continuous axes (move, turn, vertical) are not affected.
   */
  suppressHeld(): void;
  /**
   * Call after `read`, each frame the settings panel holds a hand's trigger or grip: recomputes
   * this frame's `select` and `grip` without the claimed hands, so nothing else acts on them.
   */
  claim(left: boolean, right: boolean): void;
  /**
   * Call after `read`, each frame the settings panel grabs with a hand: that hand's stick drives
   * the panel, so it stops feeding move (left) or turn, vertical and teleport aim (right). A held
   * stick aim is dropped without a commit. The stick stays out until it is back inside the
   * deadzone after the last held frame, so letting go mid-push starts nothing. `hands` keeps it.
   */
  holdSticks(left: boolean, right: boolean): void;
}

/** Applies the radial deadzone in place on `out`, rescaled to start at 0 and capped at 1. */
function deadzoneInto(out: { x: number; y: number }, x: number, y: number): void {
  const magnitude = Math.hypot(x, y);
  if (!(magnitude > DEADZONE)) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const scale = Math.min(1, (magnitude - DEADZONE) / (1 - DEADZONE)) / magnitude;
  out.x = x * scale;
  out.y = y * scale;
}

export function radialDeadzone(x: number, y: number): { x: number; y: number } {
  const out = { x: 0, y: 0 };
  deadzoneInto(out, x, y);
  return out;
}

function clamp1(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

/** Caps a vector's magnitude at 1, in place. */
function capInto(v: { x: number; y: number }): void {
  const magnitude = Math.hypot(v.x, v.y);
  if (magnitude > 1) {
    v.x /= magnitude;
    v.y /= magnitude;
  }
}

/** Suppressible button slots, controller and keyboard/mouse alike. */
const L_TRIGGER = 0;
const R_TRIGGER = 1;
const L_GRIP = 2;
const R_GRIP = 3;
const R_B = 4;
const L_MENU = 5;
const L_STICK = 6;
const R_STICK = 7;
const KEY_F = 8;
const KEY_M = 9;
const KEY_R = 10;
const MOUSE_L = 11;
const MOUSE_R = 12;
const R_A = 13;
const KEY_V = 14;
const SLOTS = 15;

type Pad = NonNullable<InputSourceLike['gamepad']>;

function padFor(sources: ArrayLike<InputSourceLike> | null | undefined, hand: string): Pad | null {
  if (!sources) return null;
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    const pad = source?.gamepad;
    if (source?.handedness === hand && pad && pad.mapping === 'xr-standard') return pad;
  }
  return null;
}

function pressed(pad: Pad | null, index: number): boolean {
  return pad?.buttons?.[index]?.pressed ?? false;
}

function key(keyboard: KeyboardState, code: string): number {
  return keyboard.keys.has(code) ? 1 : 0;
}

/** A click that acts on release: `holding` while down, `cancelled` once the hold must not fire. */
export interface ClickState {
  holding: boolean;
  cancelled: boolean;
}

/**
 * One frame of a click that fires on release (the left stick's `abCycle`), updating `state` in
 * place. `cancel` true on any frame of the hold, the release frame included, stops it firing.
 */
export function stickClickStep(state: ClickState, down: boolean, cancel: boolean): boolean {
  if (down) {
    if (!state.holding) state.cancelled = false;
    state.holding = true;
    if (cancel) state.cancelled = true;
    return false;
  }
  const fired = state.holding && !state.cancelled && !cancel;
  state.holding = false;
  state.cancelled = false;
  return fired;
}

export function createInput(): Input {
  const actions: Actions = {
    dt: 0,
    move: { x: 0, y: 0 },
    sprint: false,
    turn: { x: 0, snap: 0 },
    teleportAim: false,
    teleportCommit: false,
    flightToggle: false,
    vertical: 0,
    menu: false,
    select: { down: false, fired: false },
    grip: { down: false, fired: false },
    hands: {
      left: {
        trigger: { down: false, fired: false },
        grip: { down: false, fired: false },
        stick: { x: 0, y: 0 },
      },
      right: {
        trigger: { down: false, fired: false },
        grip: { down: false, fired: false },
        stick: { x: 0, y: 0 },
      },
    },
    recenter: false,
    abCycle: false,
  };
  /** `select.down` and `grip.down` as last reported, before this frame's read. */
  let selectWas = false;
  let gripWas = false;
  const raw: boolean[] = new Array<boolean>(SLOTS).fill(false);
  const suppressed: boolean[] = new Array<boolean>(SLOTS).fill(false);
  const right = { x: 0, y: 0 };
  /** Sticks the panel holds (`holdSticks`), out of locomotion until centred. */
  const stickHeld: Record<Hand, boolean> = { left: false, right: false };
  /** This frame's keyboard parts of move, turn and vertical, for `holdSticks`. */
  const keyMove = { x: 0, y: 0 };
  let keyTurnNow = 0;
  let keyVerticalNow = 0;
  let snapArmed = true;
  let stickAim = false;
  let aimRaw = false;
  let aimDown = false;
  let aimSuppressed = false;
  let flightDown = false;
  let menuDown = false;
  let recenterHeld = 0;
  let recenterHolding = false;
  let recenterFired = false;
  const abClick: ClickState = { holding: false, cancelled: false };
  let abKeyDown = false;
  /** This frame's `abCycle` parts, so a claim can take back the stick click's alone. */
  let abClickFired = false;
  let abKeyFired = false;

  /** The slot's level after suppression. */
  function level(slot: number): boolean {
    return raw[slot] === true && !suppressed[slot];
  }

  /**
   * The settings panel holds or grabs with the left hand: a left stick click in progress, or one
   * released this frame, belongs to the panel gesture and does not cycle the A/B group. V still does.
   */
  function cancelLeftClick(): void {
    if (abClick.holding) abClick.cancelled = true;
    if (abClickFired) {
      abClickFired = false;
      actions.abCycle = abKeyFired;
    }
  }

  function button(out: ButtonAction, down: boolean): void {
    out.fired = down && !out.down;
    out.down = down;
  }

  return {
    read(sources, keyboard, dt) {
      actions.dt = dt > 0 ? Math.min(dt, MAX_DT) : 0;
      const left = padFor(sources, 'left');
      const rightPad = padFor(sources, 'right');

      raw[L_TRIGGER] = pressed(left, XR_BUTTON.TRIGGER);
      raw[R_TRIGGER] = pressed(rightPad, XR_BUTTON.TRIGGER);
      raw[L_GRIP] = pressed(left, XR_BUTTON.SQUEEZE);
      raw[R_GRIP] = pressed(rightPad, XR_BUTTON.SQUEEZE);
      raw[R_B] = pressed(rightPad, XR_BUTTON.B);
      raw[R_A] = pressed(rightPad, XR_BUTTON.A);
      raw[L_MENU] = pressed(left, MENU_BUTTON);
      raw[L_STICK] = pressed(left, XR_BUTTON.THUMBSTICK);
      raw[R_STICK] = pressed(rightPad, XR_BUTTON.THUMBSTICK);
      raw[KEY_F] = keyboard.keys.has('KeyF');
      raw[KEY_M] = keyboard.keys.has('KeyM');
      raw[KEY_R] = keyboard.keys.has('KeyR');
      raw[MOUSE_L] = keyboard.mouseButtons.has(MOUSE_SELECT);
      raw[MOUSE_R] = keyboard.mouseButtons.has(MOUSE_GRIP);
      raw[KEY_V] = keyboard.keys.has('KeyV');
      // A release ends a slot's suppression.
      for (let slot = 0; slot < SLOTS; slot += 1) {
        if (!raw[slot]) suppressed[slot] = false;
      }

      // Move: left stick (forward is -axes[3]) plus WASD, capped at 1.
      const leftStick = actions.hands.left.stick;
      deadzoneInto(leftStick, left?.axes[AXIS_X] ?? 0, -(left?.axes[AXIS_Y] ?? 0));
      if (stickHeld.left && leftStick.x === 0 && leftStick.y === 0) stickHeld.left = false;
      const move = actions.move;
      move.x = stickHeld.left ? 0 : leftStick.x;
      move.y = stickHeld.left ? 0 : leftStick.y;
      const keyX = key(keyboard, 'KeyD') - key(keyboard, 'KeyA');
      const keyY = key(keyboard, 'KeyW') - key(keyboard, 'KeyS');
      keyMove.x = 0;
      keyMove.y = 0;
      if (keyX !== 0 || keyY !== 0) {
        const length = Math.hypot(keyX, keyY);
        keyMove.x = keyX / length;
        keyMove.y = keyY / length;
        move.x += keyMove.x;
        move.y += keyMove.y;
        capInto(move);
      }
      actions.sprint = keyboard.keys.has('ShiftLeft') || keyboard.keys.has('ShiftRight');

      // Turn and vertical: the right stick, forward/up positive, plus Q/E and Space/C.
      const rightStick = actions.hands.right.stick;
      deadzoneInto(rightStick, rightPad?.axes[AXIS_X] ?? 0, -(rightPad?.axes[AXIS_Y] ?? 0));
      if (stickHeld.right && rightStick.x === 0 && rightStick.y === 0) stickHeld.right = false;
      right.x = stickHeld.right ? 0 : rightStick.x;
      right.y = stickHeld.right ? 0 : rightStick.y;
      const keyTurn = key(keyboard, 'KeyE') - key(keyboard, 'KeyQ');
      keyTurnNow = keyTurn;
      const turnX = clamp1(right.x + keyTurn);
      actions.turn.x = turnX;
      actions.turn.snap = 0;
      // Dominant axis: a snap needs X to beat Y, and an aim (below) needs Y to beat X, so a 45°
      // push does neither.
      if (snapArmed && Math.abs(turnX) >= SNAP_THRESHOLD && Math.abs(turnX) > Math.abs(right.y)) {
        actions.turn.snap = turnX > 0 ? 1 : -1;
        snapArmed = false;
      } else if (!snapArmed && right.x === 0 && right.y === 0 && keyTurn === 0) {
        // The deadzoned vector is zero only inside the radial deadzone.
        snapArmed = true;
      }
      keyVerticalNow = key(keyboard, 'Space') - key(keyboard, 'KeyC');
      actions.vertical = clamp1(right.y + keyVerticalNow);

      // Teleport: aim with hysteresis on the stick, or T; commit when the aim ends.
      if (!stickAim && right.y >= TELEPORT_AIM_THRESHOLD && right.y > Math.abs(right.x)) {
        stickAim = true;
      }
      if (stickAim && right.y < TELEPORT_RELEASE_THRESHOLD) stickAim = false;
      aimRaw = stickAim || keyboard.keys.has('KeyT');
      if (!aimRaw) aimSuppressed = false;
      const aim = aimRaw && !aimSuppressed;
      actions.teleportCommit = aimDown && !aim;
      actions.teleportAim = aim;
      aimDown = aim;

      const flight = level(R_B) || level(KEY_F);
      actions.flightToggle = flight && !flightDown;
      flightDown = flight;

      const menu = level(L_MENU) || level(R_A) || level(KEY_M);
      actions.menu = menu && !menuDown;
      menuDown = menu;

      selectWas = actions.select.down;
      gripWas = actions.grip.down;
      button(actions.select, level(L_TRIGGER) || level(R_TRIGGER) || level(MOUSE_L));
      button(actions.grip, level(L_GRIP) || level(R_GRIP) || level(MOUSE_R));
      button(actions.hands.left.trigger, level(L_TRIGGER));
      button(actions.hands.left.grip, level(L_GRIP));
      button(actions.hands.right.trigger, level(R_TRIGGER));
      button(actions.hands.right.grip, level(R_GRIP));

      actions.recenter = false;
      if ((level(L_STICK) && level(R_STICK)) || level(KEY_R)) {
        // The first held frame's dt is time from before the press, so the hold starts at 0.
        recenterHeld = recenterHolding ? recenterHeld + actions.dt : 0;
        recenterHolding = true;
        if (!recenterFired && recenterHeld >= RECENTER_HOLD_SECONDS - HOLD_EPSILON) {
          actions.recenter = true;
          recenterFired = true;
        }
      } else {
        recenterHeld = 0;
        recenterHolding = false;
        recenterFired = false;
      }

      // Any right stick press, suppressed or not, belongs to a recenter attempt. A left pad that
      // vanishes mid-click (session end, tracking loss) drops the level without a release.
      const click = stickClickStep(abClick, level(L_STICK), raw[R_STICK] === true || left === null);
      const abKey = level(KEY_V);
      abClickFired = click;
      abKeyFired = abKey && !abKeyDown;
      actions.abCycle = abClickFired || abKeyFired;
      abKeyDown = abKey;

      return actions;
    },
    claim(left, right) {
      if (!left && !right) return;
      if (left) cancelLeftClick();
      const select = (!left && level(L_TRIGGER)) || (!right && level(R_TRIGGER)) || level(MOUSE_L);
      const grip = (!left && level(L_GRIP)) || (!right && level(R_GRIP)) || level(MOUSE_R);
      actions.select.down = select;
      actions.select.fired = select && !selectWas;
      actions.grip.down = grip;
      actions.grip.fired = grip && !gripWas;
    },
    holdSticks(left, right) {
      if (left) cancelLeftClick();
      // A newly held stick also leaves this frame's actions; later frames read it as centred.
      if (left && !stickHeld.left) {
        stickHeld.left = true;
        actions.move.x = keyMove.x;
        actions.move.y = keyMove.y;
      }
      if (right && !stickHeld.right) {
        stickHeld.right = true;
        actions.turn.x = clamp1(keyTurnNow);
        if (keyTurnNow === 0) actions.turn.snap = 0;
        actions.vertical = clamp1(keyVerticalNow);
        if (stickAim) {
          stickAim = false;
          aimDown = false;
          actions.teleportAim = false;
          actions.teleportCommit = false;
        }
      }
    },
    suppressHeld() {
      for (let slot = 0; slot < SLOTS; slot += 1) {
        if (raw[slot]) suppressed[slot] = true;
      }
      if (aimRaw) {
        aimSuppressed = true;
        aimDown = false;
      }
      // Suppression drops the click's level while it is still down, which must not read as a release.
      if (abClick.holding) abClick.cancelled = true;
    },
  };
}
