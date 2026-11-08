import { flags } from '../diag/flags';
import type { QualityMode } from '../settings/schema';

/** The bench's default target, and the adaptive-90 quality's. */
export const TARGET_FRAME_RATE = 90;

/** The target of max beauty (ruling R12) and of the default adaptive-72 quality. */
export const BEAUTY_FRAME_RATE = 72;

/**
 * The rate a session requests. Max beauty forces 72 Hz over any `?hz`. Otherwise `?hz` wins, then
 * the quality: 72 for adaptive-72, 90 for adaptive-90. The bench passes no quality and defaults
 * to 90.
 */
export function resolveTargetFrameRate(
  hz: number | null,
  quality: QualityMode | null = null,
): number {
  if (quality === 'beauty-72') return BEAUTY_FRAME_RATE;
  if (hz !== null) return hz;
  return quality === 'adaptive-72' ? BEAUTY_FRAME_RATE : TARGET_FRAME_RATE;
}
/**
 * Off at session start: P0.8 showed shimmer at 0.5 and 1.0. P0.8's bench measured no frame-time
 * gain from either, but the Starry Night world does gain on Quest 3 (2026-11-06: 0.84 of the base
 * frame at 0.5 and 0.81 at 1), so the governor sheds to 0.5 and then 1 when a frame overruns.
 */
export const FOVEATION = 0;

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

/**
 * Applies frame rate and foveation after the session is bound to the renderer. `foveation` is
 * `?fov` when set (testing only), else `FOVEATION`.
 */
export async function applySessionSettings(
  session: XRSession,
  renderer: SessionRenderer,
  state: XrState,
  targetFrameRate: number = TARGET_FRAME_RATE,
  foveation: number = flags.fov ?? FOVEATION,
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
  renderer.xr.setFoveation(foveation);
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
      const endedSession = session;
      session.addEventListener('end', () => {
        state.presenting = false;
        state.sessionMode = null;
        state.frameRate = null;
        state.supportedFrameRates = null;
      });
      session.addEventListener('frameratechange', () => {
        state.frameRate = endedSession.frameRate ?? null;
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
