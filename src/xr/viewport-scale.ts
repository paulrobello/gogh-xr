/**
 * Framebuffer-scale adapter for the governor (ruling R4). three r186 refuses
 * `setFramebufferScaleFactor` while presenting, so the scale is applied per view with
 * `XRView.requestViewportScale`, which takes effect at the next viewport query for that view.
 * three queries the viewport inside its own XR frame handler, before the app's callback runs:
 * `XRWebGLLayer.getViewport(view)` on the base-layer path, or `XRWebGLBinding.getViewSubImage
 * (layer, view)` when the runtime has `createProjectionLayer` (Quest Browser). The adapter wraps
 * that query on the session's layer or binding instance to request the scale first.
 */

export type ViewportScalePath = 'base-layer' | 'projection-layer' | 'unavailable';

/** The parts of three's `WebXRManager` the adapter reads. */
export interface ViewportScaleXr {
  getBaseLayer(): unknown;
  getBinding(): unknown;
}

export interface ViewportScaler {
  readonly path: ViewportScalePath;
  /** Requested scale in (0, 1], applied from the next frame. */
  scale: number;
  /**
   * The scale the runtime applied: the last viewport width over the width seen at scale 1. null
   * until both are measured. A runtime may ignore `requestViewportScale`, so this can read 1 while
   * `scale` is lower.
   */
  readonly applied: number | null;
  /** Restores the wrapped method. */
  uninstall(): void;
}

interface ScalableView {
  requestViewportScale?(scale: number): void;
}

type Method = (...args: unknown[]) => unknown;

/** `XRViewport.width`, or null when the result carries none. */
type ReadWidth = (result: unknown) => number | null;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}

const viewportWidth: ReadWidth = (viewport) =>
  numberOrNull((viewport as { width?: unknown } | null | undefined)?.width);

const subImageWidth: ReadWidth = (subImage) =>
  viewportWidth((subImage as { viewport?: unknown } | null | undefined)?.viewport);

function wrap(
  target: Record<string, unknown>,
  name: string,
  viewArg: number,
  scale: () => number,
  readWidth: ReadWidth,
  measured: (requested: number, width: number | null) => void,
): () => void {
  const own = Object.getOwnPropertyDescriptor(target, name);
  const original = target[name] as Method;
  target[name] = function (this: unknown, ...args: unknown[]) {
    const requested = scale();
    (args[viewArg] as ScalableView | undefined)?.requestViewportScale?.(requested);
    const result = original.apply(this, args);
    measured(requested, readWidth(result));
    return result;
  };
  return () => {
    if (own) Object.defineProperty(target, name, own);
    else delete target[name];
  };
}

function hasMethod(value: unknown, name: string): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[name] === 'function'
  );
}

/**
 * Installs the adapter on the current session's layer. Call after three has bound the session
 * (its `sessionstart` event). `viewPrototype` defaults to the global `XRView.prototype`; without
 * `requestViewportScale` there, or with no layer to wrap, the path is 'unavailable' and setting
 * the scale does nothing.
 */
export function installViewportScale(
  xr: ViewportScaleXr,
  viewPrototype: unknown = (globalThis as { XRView?: { prototype: unknown } }).XRView?.prototype,
): ViewportScaler {
  let scale = 1;
  const current = (): number => scale;
  /** Viewport width at scale 1, and the width of the latest query. */
  let fullWidth: number | null = null;
  let lastWidth: number | null = null;
  const measured = (requested: number, width: number | null): void => {
    if (width === null) return;
    if (requested === 1) fullWidth = width;
    lastWidth = width;
  };
  let path: ViewportScalePath = 'unavailable';
  let uninstall = (): void => undefined;
  if (hasMethod(viewPrototype, 'requestViewportScale')) {
    const layer = xr.getBaseLayer();
    if (hasMethod(layer, 'getViewport')) {
      uninstall = wrap(layer, 'getViewport', 0, current, viewportWidth, measured);
      path = 'base-layer';
    } else {
      const binding = xr.getBinding();
      if (layer && hasMethod(binding, 'getViewSubImage')) {
        uninstall = wrap(binding, 'getViewSubImage', 1, current, subImageWidth, measured);
        path = 'projection-layer';
      }
    }
  }
  return {
    path,
    get scale() {
      return scale;
    },
    get applied() {
      return fullWidth === null || lastWidth === null ? null : lastWidth / fullWidth;
    },
    set scale(value: number) {
      if (!(value > 0 && value <= 1))
        throw new RangeError(`viewport scale ${value} must be in (0, 1]`);
      scale = value;
    },
    uninstall() {
      uninstall();
      uninstall = () => undefined;
    },
  };
}
