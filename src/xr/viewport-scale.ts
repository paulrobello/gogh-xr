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
  /** Restores the wrapped method. */
  uninstall(): void;
}

interface ScalableView {
  requestViewportScale?(scale: number): void;
}

type Method = (...args: unknown[]) => unknown;

function wrap(
  target: Record<string, unknown>,
  name: string,
  viewArg: number,
  scale: () => number,
): () => void {
  const own = Object.getOwnPropertyDescriptor(target, name);
  const original = target[name] as Method;
  target[name] = function (this: unknown, ...args: unknown[]) {
    (args[viewArg] as ScalableView | undefined)?.requestViewportScale?.(scale());
    return original.apply(this, args);
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
  let path: ViewportScalePath = 'unavailable';
  let uninstall = (): void => undefined;
  if (hasMethod(viewPrototype, 'requestViewportScale')) {
    const layer = xr.getBaseLayer();
    if (hasMethod(layer, 'getViewport')) {
      uninstall = wrap(layer, 'getViewport', 0, current);
      path = 'base-layer';
    } else {
      const binding = xr.getBinding();
      if (layer && hasMethod(binding, 'getViewSubImage')) {
        uninstall = wrap(binding, 'getViewSubImage', 1, current);
        path = 'projection-layer';
      }
    }
  }
  return {
    path,
    get scale() {
      return scale;
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
