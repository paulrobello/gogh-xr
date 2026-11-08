import { expect, test, vi } from 'vitest';
import { clearNotices, showNotice } from '../src/ui/notice.ts';
import {
  applySessionSettings,
  createSessionController,
  createXrState,
  isVrSupported,
  resolveTargetFrameRate,
  SESSION_INIT,
  type SessionRenderer,
  TARGET_FRAME_RATE,
} from '../src/xr/session.ts';

interface FakeOptions {
  updateTargetFrameRate?: ((rate: number) => Promise<void>) | undefined;
  frameRate?: number;
  supportedFrameRates?: Float32Array;
}

function fakeSession(opts: FakeOptions = {}): XRSession {
  const target = new EventTarget();
  const session = {
    addEventListener: target.addEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    end: vi.fn(async () => undefined),
    frameRate: opts.frameRate ?? 72,
    supportedFrameRates: opts.supportedFrameRates ?? new Float32Array([72, 90]),
    updateTargetFrameRate: opts.updateTargetFrameRate,
  };
  return session as unknown as XRSession;
}

function fakeRenderer(setSession?: (s: XRSession) => Promise<void>) {
  const setFoveation = vi.fn();
  const renderer: SessionRenderer = {
    xr: { setSession: setSession ?? (async () => undefined), setFoveation },
  };
  return { renderer, setFoveation };
}

test('applySessionSettings with updateTargetFrameRate present', async () => {
  const update = vi.fn(async () => undefined);
  const session = fakeSession({ updateTargetFrameRate: update, frameRate: 90 });
  const { renderer, setFoveation } = fakeRenderer();
  const state = createXrState();
  await applySessionSettings(session, renderer, state);
  expect(update).toHaveBeenCalledWith(90);
  expect(state.frameRate).toBe(90);
  expect(state.supportedFrameRates).toEqual([72, 90]);
  expect(setFoveation).toHaveBeenCalledWith(0);
});

test('applySessionSettings applies a pinned foveation (?fov) in place of the default', async () => {
  const session = fakeSession({ updateTargetFrameRate: undefined });
  const { renderer, setFoveation } = fakeRenderer();
  await applySessionSettings(session, renderer, createXrState(), TARGET_FRAME_RATE, 1);
  expect(setFoveation).toHaveBeenCalledTimes(1);
  expect(setFoveation).toHaveBeenCalledWith(1);
});

test('applySessionSettings with updateTargetFrameRate absent', async () => {
  const session = fakeSession({ updateTargetFrameRate: undefined });
  const { renderer, setFoveation } = fakeRenderer();
  const state = createXrState();
  await applySessionSettings(session, renderer, state);
  expect(state.frameRate).toBe(72);
  expect(setFoveation).toHaveBeenCalledWith(0);
});

test('applySessionSettings tolerates a rejecting updateTargetFrameRate', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const session = fakeSession({
    updateTargetFrameRate: async () => {
      throw new Error('unsupported rate');
    },
  });
  const { renderer, setFoveation } = fakeRenderer();
  const state = createXrState();
  await applySessionSettings(session, renderer, state);
  expect(state.frameRate).toBe(72);
  expect(setFoveation).toHaveBeenCalledWith(0);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test('controller requests immersive-vr with the optional features and sets state', async () => {
  const session = fakeSession({ updateTargetFrameRate: async () => undefined });
  const requestSession = vi.fn(async () => session);
  const { renderer } = fakeRenderer();
  const notify = vi.fn();
  const controller = createSessionController({
    renderer,
    xr: { requestSession } as unknown as XRSystem,
    notify,
  });
  expect(await controller.enter()).toBe(true);
  expect(requestSession).toHaveBeenCalledWith('immersive-vr', SESSION_INIT);
  expect(SESSION_INIT.optionalFeatures).toEqual([
    'local-floor',
    'bounded-floor',
    'medium-fixed-foveation-level',
  ]);
  expect(controller.state.presenting).toBe(true);
  expect(controller.state.sessionMode).toBe('immersive-vr');
  expect(notify).not.toHaveBeenCalled();
  session.dispatchEvent(new Event('end'));
  expect(controller.state.presenting).toBe(false);
});

test('frameratechange refreshes frameRate and end clears the frame-rate state', async () => {
  const session = fakeSession({ updateTargetFrameRate: async () => undefined, frameRate: 72 });
  const controller = createSessionController({
    renderer: fakeRenderer().renderer,
    xr: { requestSession: async () => session } as unknown as XRSystem,
    notify: vi.fn(),
  });
  expect(await controller.enter()).toBe(true);
  expect(controller.state.frameRate).toBe(72);
  expect(controller.state.supportedFrameRates).toEqual([72, 90]);
  (session as unknown as { frameRate: number }).frameRate = 90;
  session.dispatchEvent(new Event('frameratechange'));
  expect(controller.state.frameRate).toBe(90);
  session.dispatchEvent(new Event('end'));
  expect(controller.state.frameRate).toBeNull();
  expect(controller.state.supportedFrameRates).toBeNull();
});

test('concurrent enter calls issue a single request', async () => {
  let resolve: (s: XRSession) => void = () => undefined;
  const requestSession = vi.fn(() => new Promise<XRSession>((r) => (resolve = r)));
  const { renderer } = fakeRenderer();
  const controller = createSessionController({
    renderer,
    xr: { requestSession } as unknown as XRSystem,
    notify: vi.fn(),
  });
  const first = controller.enter();
  expect(await controller.enter()).toBe(false);
  resolve(fakeSession());
  expect(await first).toBe(true);
  expect(requestSession).toHaveBeenCalledTimes(1);
});

test('request failure notifies and clears the pending guard', async () => {
  const requestSession = vi
    .fn()
    .mockRejectedValueOnce(new Error('denied'))
    .mockResolvedValueOnce(fakeSession());
  const { renderer } = fakeRenderer();
  const notify = vi.fn();
  const controller = createSessionController({
    renderer,
    xr: { requestSession } as unknown as XRSystem,
    notify,
  });
  expect(await controller.enter()).toBe(false);
  expect(notify).toHaveBeenCalledWith('Could not start VR: denied');
  expect(controller.state.presenting).toBe(false);
  expect(await controller.enter()).toBe(true);
});

test('a successful entry clears a stale failure notice', async () => {
  document.body.replaceChildren();
  const requestSession = vi
    .fn()
    .mockRejectedValueOnce(new Error('denied'))
    .mockResolvedValueOnce(fakeSession());
  const controller = createSessionController({
    renderer: fakeRenderer().renderer,
    xr: { requestSession } as unknown as XRSystem,
    notify: (message) => showNotice(message),
    clearNotices: () => clearNotices(),
  });
  expect(await controller.enter()).toBe(false);
  expect(document.querySelectorAll('[role="alert"]').length).toBe(1);
  expect(await controller.enter()).toBe(true);
  expect(document.querySelectorAll('[role="alert"]').length).toBe(0);
});

test('setSession failure ends the session and notifies', async () => {
  const session = fakeSession();
  const { renderer } = fakeRenderer(async () => {
    throw new Error('gl lost');
  });
  const notify = vi.fn();
  const controller = createSessionController({
    renderer,
    xr: { requestSession: async () => session } as unknown as XRSystem,
    notify,
  });
  expect(await controller.enter()).toBe(false);
  expect(session.end).toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith('Could not start VR: gl lost');
});

test('missing navigator.xr notifies', async () => {
  const notify = vi.fn();
  const controller = createSessionController({
    renderer: fakeRenderer().renderer,
    xr: undefined,
    notify,
  });
  expect(await controller.enter()).toBe(false);
  expect(notify).toHaveBeenCalledOnce();
});

test('isVrSupported feature-detects and swallows errors', async () => {
  expect(await isVrSupported(undefined)).toBe(false);
  expect(await isVrSupported({} as XRSystem)).toBe(false);
  const ok = { isSessionSupported: async (m: string) => m === 'immersive-vr' } as XRSystem;
  expect(await isVrSupported(ok)).toBe(true);
  const bad = {
    isSessionSupported: async () => {
      throw new Error('x');
    },
  } as unknown as XRSystem;
  expect(await isVrSupported(bad)).toBe(false);
});

test('applySessionSettings requests an overridden target frame rate', async () => {
  const update = vi.fn(async () => undefined);
  const session = fakeSession({ updateTargetFrameRate: update, frameRate: 120 });
  const { renderer } = fakeRenderer();
  await applySessionSettings(session, renderer, createXrState(), 120);
  expect(update).toHaveBeenCalledWith(120);
});

test('the controller passes its target frame rate to the session', async () => {
  const update = vi.fn(async () => undefined);
  const session = fakeSession({ updateTargetFrameRate: update });
  const { renderer } = fakeRenderer();
  const controller = createSessionController({
    renderer,
    xr: { requestSession: async () => session } as unknown as XRSystem,
    notify: vi.fn(),
    targetFrameRate: 72,
  });
  expect(await controller.enter()).toBe(true);
  expect(update).toHaveBeenCalledWith(72);
});

test('?hz overrides the bench default target of 90', () => {
  expect(TARGET_FRAME_RATE).toBe(90);
  expect(resolveTargetFrameRate(null)).toBe(90);
  expect(resolveTargetFrameRate(72)).toBe(72);
  expect(resolveTargetFrameRate(120)).toBe(120);
});

test('the quality picks the rate: adaptive-72 and beauty-72 ask 72, adaptive-90 asks 90 or ?hz', () => {
  expect(resolveTargetFrameRate(null, 'adaptive-72')).toBe(72);
  expect(resolveTargetFrameRate(null, 'adaptive-90')).toBe(90);
  expect(resolveTargetFrameRate(null, 'beauty-72')).toBe(72);
  // applyUrlFlags maps ?hz=90 and ?hz=120 to adaptive-90, which keeps asking their rate.
  expect(resolveTargetFrameRate(90, 'adaptive-90')).toBe(90);
  expect(resolveTargetFrameRate(120, 'adaptive-90')).toBe(120);
  expect(resolveTargetFrameRate(72, 'adaptive-72')).toBe(72);
  // Max beauty wins over any ?hz.
  expect(resolveTargetFrameRate(120, 'beauty-72')).toBe(72);
});
