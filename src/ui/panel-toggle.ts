/**
 * Opens and closes the settings panel (P5.3): the `menu` action (left index 6, right A, M) toggles
 * the XR panel while presenting and the DOM panel on the desktop. Each is built lazily on its first
 * open, like the HUD (hud-toggle.ts), so a session that never opens one loads neither. Free of
 * three and troika: `main.ts` passes the lazy imports as `buildXr` and `buildDom`.
 */
import type { Actions, Hand } from '../xr/input';

/** What the XR panel holds this frame: hands to claim, and the grabbing hands' sticks. */
export interface PanelHold {
  readonly left: boolean;
  readonly right: boolean;
  readonly sticks: Readonly<Record<Hand, boolean>>;
}

/** The built XR panel, as the toggle drives it (`settings-panel.ts`). */
export interface XrPanelHost {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  /** One presenting frame; the hands and sticks the panel holds. */
  frame(actions: Actions, now: number): PanelHold;
  recenter(): void;
  savePose(): void;
  diag(): Record<string, unknown>;
}

/** The built DOM panel (`settings-dom.ts`). */
export interface DomPanelHost {
  readonly isOpen: boolean;
  setOpen(open: boolean): void;
}

export interface PanelToggleDeps {
  buildXr(): Promise<XrPanelHost>;
  buildDom(): Promise<DomPanelHost>;
  /** Forgets the saved XR pose while the XR panel is unbuilt (recenter). */
  clearPose(): void;
  /** Called on every open and close, so a held button counts for nothing until released. */
  onChange?(open: boolean): void;
  onError?(error: unknown): void;
  /** The fields locked by URL flags for this session, for the diag. */
  locked: Readonly<Record<string, string>>;
}

export interface PanelToggleDiag extends Record<string, unknown> {
  built: boolean;
  open: boolean;
  /** Which panel is open: the XR panel or the desktop DOM panel. */
  surface: 'xr' | 'dom' | null;
  pose: { position: number[]; quaternion: number[] } | null;
  scale: number | null;
  hover: Record<Hand, string | null> | null;
  locked: Readonly<Record<string, string>>;
}

export interface PanelToggle {
  /** Toggles the panel for the current mode. */
  toggle(presenting: boolean): void;
  /** One frame: what the XR panel holds (nothing on the desktop or while closed). */
  frame(presenting: boolean, actions: Actions, now: number): PanelHold;
  /** Recenter: respawns the XR panel in front of the head, or forgets its saved pose. */
  recenter(): void;
  /** XR exit: saves the XR panel's pose and closes it. */
  sessionEnd(): void;
  /** XR entry: the DOM panel closes. */
  sessionStart(): void;
  diag(): PanelToggleDiag;
}

const NONE: PanelHold = Object.freeze({
  left: false,
  right: false,
  sticks: Object.freeze({ left: false, right: false }),
});

export function createPanelToggle(deps: PanelToggleDeps): PanelToggle {
  let xr: XrPanelHost | null = null;
  let dom: DomPanelHost | null = null;
  let xrBuilding = false;
  let domBuilding = false;
  /** The open request while a build is in flight. */
  let wantXr = false;
  let wantDom = false;

  function notify(open: boolean): void {
    deps.onChange?.(open);
  }

  function setXr(open: boolean): void {
    wantXr = open;
    if (xr) {
      if (open && !xr.isOpen) xr.open();
      else if (!open && xr.isOpen) xr.close();
      notify(open);
      return;
    }
    if (!open || xrBuilding) return;
    xrBuilding = true;
    deps.buildXr().then(
      (built) => {
        xr = built;
        xrBuilding = false;
        if (wantXr) {
          built.open();
          notify(true);
        }
      },
      (error: unknown) => {
        xrBuilding = false;
        wantXr = false;
        deps.onError?.(error);
      },
    );
  }

  function setDom(open: boolean): void {
    wantDom = open;
    if (dom) {
      dom.setOpen(open);
      notify(open);
      return;
    }
    if (!open || domBuilding) return;
    domBuilding = true;
    deps.buildDom().then(
      (built) => {
        dom = built;
        domBuilding = false;
        if (wantDom) {
          built.setOpen(true);
          notify(true);
        }
      },
      (error: unknown) => {
        domBuilding = false;
        wantDom = false;
        deps.onError?.(error);
      },
    );
  }

  return {
    toggle(presenting) {
      if (presenting) setXr(!(xr?.isOpen ?? wantXr));
      else setDom(!(dom?.isOpen ?? wantDom));
    },
    frame(presenting, actions, now) {
      if (!presenting || !xr?.isOpen) return NONE;
      return xr.frame(actions, now);
    },
    recenter() {
      if (xr) xr.recenter();
      else deps.clearPose();
    },
    sessionEnd() {
      if (xr?.isOpen) {
        xr.savePose();
        xr.close();
      }
      wantXr = false;
    },
    sessionStart() {
      if (dom?.isOpen) dom.setOpen(false);
      wantDom = false;
    },
    diag() {
      const open = Boolean(xr?.isOpen || dom?.isOpen);
      const d = xr?.isOpen ? xr.diag() : null;
      return {
        built: xr !== null,
        open,
        surface: xr?.isOpen ? 'xr' : dom?.isOpen ? 'dom' : null,
        domBuilt: dom !== null,
        pose: (d?.pose as PanelToggleDiag['pose']) ?? null,
        scale: (d?.scale as number | undefined) ?? null,
        hover: (d?.hover as PanelToggleDiag['hover']) ?? null,
        tooltip: d?.tooltip ?? null,
        grabbing: d?.grabbing ?? false,
        typeset: d?.typeset ?? false,
        locked: deps.locked,
      };
    },
  };
}

/**
 * main.ts registers the return-to-gallery transition here while a painting's world is active
 * (P5.5), and null otherwise, which hides the button.
 */
let galleryReturn: (() => void) | null = null;
const galleryListeners = new Set<() => void>();

export function registerGalleryReturn(callback: (() => void) | null): void {
  galleryReturn = callback;
  for (const listener of galleryListeners) listener();
}

/** Calls `listener` on every registration, so an open DOM panel shows or hides its button. */
export function onGalleryReturnChange(listener: () => void): () => void {
  galleryListeners.add(listener);
  return () => galleryListeners.delete(listener);
}

export function galleryReturnCallback(): (() => void) | null {
  return galleryReturn;
}
