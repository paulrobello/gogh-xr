/**
 * Shows and hides the perf HUD at runtime (ruling R17): the left controller's X button in XR, the
 * H key on desktop. The HUD is built on its first show, so troika, the font fetch, the panel and
 * the `frame` diag key cost nothing in a session that never shows it. Hiding keeps the HUD built
 * and stops its per-frame work, including the 4 Hz recompute.
 *
 * Free of troika and WebGL: `main.ts` passes the lazy import as `build`.
 */
import { buttonEdge } from '../bench/stick';

/** The built HUD, as the toggle drives it (`perf-hud.ts`). */
export interface ToggleableHud {
  frame(time: number): void;
  setVisible(visible: boolean): void;
  diag(): Record<string, unknown>;
}

export interface HudToggleDeps {
  /** True starts the build at once (`?hud`). */
  visible: boolean;
  build(): Promise<ToggleableHud>;
  /** A failed build is reported here, and the next show tries again. */
  onError?(error: unknown): void;
}

export interface HudToggleDiag extends Record<string, unknown> {
  visible: boolean;
  /** False until the first show's build lands; the HUD's own fields join once it has. */
  built: boolean;
}

export interface HudToggle {
  /**
   * Call once per animation frame, after rendering. `leftXDown` is the left X button's state this
   * frame; a press toggles once, however many frames it is held.
   */
  frame(time: number, leftXDown: boolean): void;
  toggle(): void;
  /** Shows or hides the HUD, building it on the first show. */
  setVisible(visible: boolean): void;
  readonly visible: boolean;
  diag(): HudToggleDiag;
}

export function createHudToggle(deps: HudToggleDeps): HudToggle {
  let visible = false;
  let hud: ToggleableHud | null = null;
  let building = false;
  let xDown = false;

  function setVisible(next: boolean): void {
    visible = next;
    if (hud) {
      hud.setVisible(next);
      return;
    }
    if (!next || building) return;
    building = true;
    deps.build().then(
      (built) => {
        hud = built;
        built.setVisible(visible);
      },
      (error: unknown) => {
        building = false;
        deps.onError?.(error);
      },
    );
  }

  setVisible(deps.visible);

  return {
    frame(time, leftXDown) {
      const x = buttonEdge(xDown, leftXDown);
      xDown = x.down;
      if (x.fired) setVisible(!visible);
      if (visible) hud?.frame(time);
    },
    toggle: () => setVisible(!visible),
    setVisible,
    get visible() {
      return visible;
    },
    // Once built, the HUD's own fields win, so `visible` is the panel's actual state.
    diag: () => ({ visible, built: hud !== null, ...hud?.diag() }),
  };
}

/** The desktop toggle: H, once per physical press (auto-repeat keydowns are ignored). */
export function isHudToggleKey(event: Pick<KeyboardEvent, 'code' | 'repeat'>): boolean {
  return event.code === 'KeyH' && !event.repeat;
}
