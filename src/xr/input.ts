/**
 * The input action layer: XR gamepads and the keyboard/mouse folded into one `Actions` frame per
 * animation frame. Pure: the caller passes the XR input sources (structurally typed, so tests can
 * fake them) and a keyboard/mouse snapshot (`input-keyboard.ts` captures it from the DOM).
 *
 * Not mapped here, by design (P3 ruling Q1): left X (perf HUD), left Y (XR frame-rate step),
 * right A (bench), and the desktop H key (HUD). Those keep their own handlers.
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
  /** A on the right controller, X on the left. Not mapped (Q1). */
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
  /** Edge: left button index 6 (`MENU_BUTTON`) or M pressed. */
  menu: boolean;
  /** Either trigger, or the left mouse button on desktop. */
  select: ButtonAction;
  /** Either grip (squeeze), or the right mouse button on desktop. */
  grip: ButtonAction;
  /** Edge: once, when both stick clicks (or R) have been held for 1 s. */
  recenter: boolean;
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
const SLOTS = 13;

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
    recenter: false,
  };
  const raw: boolean[] = new Array<boolean>(SLOTS).fill(false);
  const suppressed: boolean[] = new Array<boolean>(SLOTS).fill(false);
  const right = { x: 0, y: 0 };
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

  /** The slot's level after suppression. */
  function level(slot: number): boolean {
    return raw[slot] === true && !suppressed[slot];
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
      raw[L_MENU] = pressed(left, MENU_BUTTON);
      raw[L_STICK] = pressed(left, XR_BUTTON.THUMBSTICK);
      raw[R_STICK] = pressed(rightPad, XR_BUTTON.THUMBSTICK);
      raw[KEY_F] = keyboard.keys.has('KeyF');
      raw[KEY_M] = keyboard.keys.has('KeyM');
      raw[KEY_R] = keyboard.keys.has('KeyR');
      raw[MOUSE_L] = keyboard.mouseButtons.has(MOUSE_SELECT);
      raw[MOUSE_R] = keyboard.mouseButtons.has(MOUSE_GRIP);
      // A release ends a slot's suppression.
      for (let slot = 0; slot < SLOTS; slot += 1) {
        if (!raw[slot]) suppressed[slot] = false;
      }

      // Move: left stick (forward is -axes[3]) plus WASD, capped at 1.
      const move = actions.move;
      deadzoneInto(move, left?.axes[AXIS_X] ?? 0, -(left?.axes[AXIS_Y] ?? 0));
      const keyX = key(keyboard, 'KeyD') - key(keyboard, 'KeyA');
      const keyY = key(keyboard, 'KeyW') - key(keyboard, 'KeyS');
      if (keyX !== 0 || keyY !== 0) {
        const length = Math.hypot(keyX, keyY);
        move.x += keyX / length;
        move.y += keyY / length;
        capInto(move);
      }
      actions.sprint = keyboard.keys.has('ShiftLeft') || keyboard.keys.has('ShiftRight');

      // Turn and vertical: the right stick, forward/up positive, plus Q/E and Space/C.
      deadzoneInto(right, rightPad?.axes[AXIS_X] ?? 0, -(rightPad?.axes[AXIS_Y] ?? 0));
      const keyTurn = key(keyboard, 'KeyE') - key(keyboard, 'KeyQ');
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
      actions.vertical = clamp1(right.y + key(keyboard, 'Space') - key(keyboard, 'KeyC'));

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

      const menu = level(L_MENU) || level(KEY_M);
      actions.menu = menu && !menuDown;
      menuDown = menu;

      button(actions.select, level(L_TRIGGER) || level(R_TRIGGER) || level(MOUSE_L));
      button(actions.grip, level(L_GRIP) || level(R_GRIP) || level(MOUSE_R));

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

      return actions;
    },
    suppressHeld() {
      for (let slot = 0; slot < SLOTS; slot += 1) {
        if (raw[slot]) suppressed[slot] = true;
      }
      if (aimRaw) {
        aimSuppressed = true;
        aimDown = false;
      }
    },
  };
}
