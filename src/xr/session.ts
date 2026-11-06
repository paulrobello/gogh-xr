export const TARGET_FRAME_RATE = 90;

/** The `?hz` override, or the default target. */
export function resolveTargetFrameRate(hz: number | null): number {
  return hz ?? TARGET_FRAME_RATE;
}
export const FOVEATION = 0.5;

export const SESSION_INIT: XRSessionInit = {
  optionalFeatures: ['local-floor', 'bounded-floor', 'medium-fixed-foveation-level'],
};

export interface XrState {
  supported: boolean | null;
  presenting: boolean;
  sessionMode: XRSessionMode | null;
  frameRate: number | null;
  supportedFrameRates: number[] | null;
}

export interface SessionRenderer {
  xr: { setSession(session: XRSession): Promise<void>; setFoveation(value: number): void };
}

export interface SessionDeps {
  renderer: SessionRenderer;
  xr: XRSystem | undefined;
  notify: (message: string) => void;
  clearNotices?: () => void;
  targetFrameRate?: number;
}

export interface SessionController {
  readonly state: XrState;
  enter(): Promise<boolean>;
}

export function createXrState(): XrState {
  return {
    supported: null,
    presenting: false,
    sessionMode: null,
    frameRate: null,
    supportedFrameRates: null,
  };
}

export async function isVrSupported(xr: XRSystem | undefined): Promise<boolean> {
  if (!xr || typeof xr.isSessionSupported !== 'function') return false;
  try {
    return await xr.isSessionSupported('immersive-vr');
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Applies frame rate and foveation after the session is bound to the renderer. */
export async function applySessionSettings(
  session: XRSession,
  renderer: SessionRenderer,
  state: XrState,
  targetFrameRate: number = TARGET_FRAME_RATE,
): Promise<void> {
  if (typeof session.updateTargetFrameRate === 'function') {
    try {
      await session.updateTargetFrameRate(targetFrameRate);
    } catch (error) {
      console.warn(`updateTargetFrameRate(${targetFrameRate}) failed: ${messageOf(error)}`);
    }
  }
  state.supportedFrameRates = session.supportedFrameRates
    ? Array.from(session.supportedFrameRates)
    : null;
  state.frameRate = session.frameRate ?? null;
  renderer.xr.setFoveation(FOVEATION);
}

export function createSessionController(deps: SessionDeps): SessionController {
  const state = createXrState();
  let pending = false;

  async function enter(): Promise<boolean> {
    if (pending || state.presenting) return false;
    if (!deps.xr) {
      deps.notify('WebXR is not available in this browser.');
      return false;
    }
    pending = true;
    let session: XRSession | null = null;
    try {
      session = await deps.xr.requestSession('immersive-vr', SESSION_INIT);
      await deps.renderer.xr.setSession(session);
      state.presenting = true;
      state.sessionMode = 'immersive-vr';
      session.addEventListener('end', () => {
        state.presenting = false;
        state.sessionMode = null;
      });
      await applySessionSettings(session, deps.renderer, state, deps.targetFrameRate);
      deps.clearNotices?.();
      return true;
    } catch (error) {
      state.presenting = false;
      state.sessionMode = null;
      if (session) await session.end().catch(() => undefined);
      deps.notify(`Could not start VR: ${messageOf(error)}`);
      return false;
    } finally {
      pending = false;
    }
  }

  return { state, enter };
}
