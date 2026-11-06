export const FIRE_THRESHOLD = 0.7;
export const REARM_THRESHOLD = 0.3;
/** xr-standard gamepad mapping: axes[2] is thumbstick X. */
const THUMBSTICK_X = 2;

export interface StickStep {
  readonly armed: boolean;
  readonly step: -1 | 0 | 1;
}

/** Edge-triggered: one step per push past the fire threshold, re-armed once the stick recentres. */
export function stickStep(armed: boolean, x: number): StickStep {
  if (armed && Math.abs(x) >= FIRE_THRESHOLD) return { armed: false, step: x > 0 ? 1 : -1 };
  if (!armed && Math.abs(x) <= REARM_THRESHOLD) return { armed: true, step: 0 };
  return { armed, step: 0 };
}

export interface StickSource {
  readonly handedness: string;
  readonly gamepad?: {
    readonly axes: readonly number[];
    readonly buttons?: readonly { readonly pressed: boolean }[];
  } | null;
}

/** xr-standard gamepad mapping: buttons[4] is the lower face button, X on the left controller. */
const FACE_BUTTON_LOWER = 4;

export interface ButtonEdge {
  readonly down: boolean;
  readonly fired: boolean;
}

/** Fires once on the press, not again until the button is released. */
export function buttonEdge(wasDown: boolean, isDown: boolean): ButtonEdge {
  return { down: isDown, fired: isDown && !wasDown };
}

export function leftXPressed(sources: Iterable<StickSource> | null | undefined): boolean {
  if (!sources) return false;
  for (const source of sources) {
    if (source.handedness === 'left' && source.gamepad) {
      return source.gamepad.buttons?.[FACE_BUTTON_LOWER]?.pressed ?? false;
    }
  }
  return false;
}

export function leftStickX(sources: Iterable<StickSource> | null | undefined): number {
  if (!sources) return 0;
  for (const source of sources) {
    if (source.handedness === 'left' && source.gamepad) {
      return source.gamepad.axes[THUMBSTICK_X] ?? 0;
    }
  }
  return 0;
}
