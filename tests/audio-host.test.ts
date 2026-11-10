/**
 * The audio host (P6.5): no context before the first gesture, one context however many gestures,
 * the world's score and ambience replayed at the unlock, the portal's whoosh and crossfade, the
 * page and XR visibility rules, the rustle trigger, and teardown on pagehide.
 */
import { Matrix4, Vector3, Vector4 } from 'three';
import { describe, expect, test } from 'vitest';
import { type AudioHostDeps, createAudioHost } from '../src/audio/audio.ts';
import { CUE_IDS, type CueId, MANIFEST_PATH } from '../src/audio/cues.ts';
import {
  createRustleTrigger,
  nearStrokes,
  RUSTLE_REACH,
  RUSTLE_SPEED,
} from '../src/audio/rustle.ts';
import { audioBytes, FakeAudioContext, settle } from './audio-fake.ts';

interface HostRig {
  host: ReturnType<typeof createAudioHost>;
  contexts: FakeAudioContext[];
  win: EventTarget;
  doc: EventTarget & { hidden: boolean };
  state: { presenting: boolean };
  positions: Vector4[];
  velocities: Vector4[];
}

function hostRig(overrides: Partial<AudioHostDeps> = {}, files = true): HostRig {
  const contexts: FakeAudioContext[] = [];
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const state = { presenting: false };
  const positions = [new Vector4(), new Vector4(), new Vector4()];
  const velocities = [new Vector4(), new Vector4(), new Vector4()];
  const host = createAudioHost({
    base: '/',
    muted: false,
    volumes: () => ({ music: 0.7, sfx: 0.7 }),
    presenting: () => state.presenting,
    disturbers: { positions, velocities },
    createContext: () => {
      const ctx = new FakeAudioContext();
      contexts.push(ctx);
      return ctx;
    },
    canPlayType: () => 'probably',
    fetchBytes: async (url) => {
      if (!files) throw new Error('HTTP 404');
      if (url === `/${MANIFEST_PATH}`) {
        const cues = CUE_IDS.map((id) => ({
          id,
          kind: id.startsWith('score') ? 'music' : 'sfx',
          loop: true,
          files: { ogg: `${id}.ogg` },
        }));
        return new TextEncoder().encode(JSON.stringify({ version: 1, cues })).buffer as ArrayBuffer;
      }
      const id = CUE_IDS.find((c: CueId) => url === `/audio/${c}.ogg`);
      if (!id) throw new Error('HTTP 404');
      return audioBytes(id === 'portal-whoosh' ? 1 : 30);
    },
    random: () => 0.5,
    log: () => {},
    window: win as unknown as Window,
    document: doc as unknown as Document,
    ...overrides,
  });
  return { host, contexts, win, doc, state, positions, velocities };
}

const ground = { heightAt: () => 0 };
/** A painted floor at y = 0: the distance is the height, out to a hand's reach. */
const floorReach = {
  distance: (_x: number, y: number) => (Math.abs(y) < RUSTLE_REACH ? Math.abs(y) : Infinity),
};
const camera = { matrixWorld: new Matrix4() };

describe('unlock', () => {
  test('no context until the first pointerdown, and only one after many gestures', async () => {
    const { host, contexts, win } = hostRig();
    host.setWorld('gallery', { ground });
    host.frame(camera, 1, true);
    expect(contexts).toHaveLength(0);
    expect(host.diag()).toMatchObject({ state: 'none', unlocked: false });
    expect(host.diag().score.target).toBe('score-gallery');
    win.dispatchEvent(new Event('pointerdown'));
    win.dispatchEvent(new Event('pointerdown'));
    host.unlock();
    expect(contexts).toHaveLength(1);
    expect(host.unlocked).toBe(true);
    await settle();
    // The world bound before the unlock is replayed: its score plays.
    expect(host.diag()).toMatchObject({ state: 'running', unlocked: true, manifest: 'loaded' });
    expect(host.diag().score).toMatchObject({ target: 'score-gallery', playing: 'score-gallery' });
  });

  test('a context created suspended is resumed inside the gesture', () => {
    const ctx = new FakeAudioContext();
    ctx.state = 'suspended';
    const { host } = hostRig({ createContext: () => ctx });
    host.unlock();
    expect(ctx.state).toBe('running');
  });

  test('a first gesture without activation leaves one context that the next gesture starts', () => {
    const ctx = new FakeAudioContext();
    ctx.state = 'suspended';
    // A touch pointerdown carries no user activation, so its resume never settles.
    ctx.resumeRefusals = 1;
    const contexts: FakeAudioContext[] = [];
    const { win } = hostRig({
      createContext: () => {
        contexts.push(ctx);
        return ctx;
      },
    });
    win.dispatchEvent(new Event('pointerdown'));
    expect(ctx.state).toBe('suspended');
    win.dispatchEvent(new Event('pointerup'));
    expect(ctx.state).toBe('running');
    expect(contexts).toHaveLength(1);
    // Running, the host stops listening: later gestures resume nothing.
    const resumes = ctx.resumes;
    ctx.state = 'suspended';
    win.dispatchEvent(new Event('touchend'));
    win.dispatchEvent(new Event('keydown'));
    expect(ctx.resumes).toBe(resumes);
  });

  test('with no audio files the unlock still runs, silent', async () => {
    const { host } = hostRig({}, false);
    host.setWorld('starry-night', { ground });
    host.unlock();
    await settle();
    host.transition('gallery');
    host.frame(camera, 1, true);
    expect(host.diag()).toMatchObject({ unlocked: true, manifest: 'missing' });
    expect(host.diag().voices).toMatchObject({ music: 0, sfx: 0 });
  });
});

describe('world changes', () => {
  test('a portal transition plays the whoosh, fades the beds and crossfades the score', async () => {
    const { host, contexts } = hostRig();
    host.unlock();
    host.setWorld('gallery', { ground });
    await settle();
    contexts[0].advance(5);
    host.transition('starry-night');
    await settle();
    const d = host.diag();
    expect(d.score).toMatchObject({
      target: 'score-night',
      playing: 'score-night',
      crossfading: true,
    });
    expect(d.voices.sfx).toBe(1);
    // The world binds: its ambience starts (wind and five crickets).
    host.clearWorld();
    host.setWorld('starry-night', { ground });
    expect(host.diag().voices.sfx).toBe(7);
    // The return: the beds fade out at its trigger.
    host.transition('gallery');
    contexts[0].advance(1.1);
    expect(host.diag().voices.sfx).toBe(0);
    expect(host.diag().score.target).toBe('score-gallery');
  });
});

describe('visibility', () => {
  test('a hidden page suspends outside XR only; a hidden XR session suspends', async () => {
    const { host, contexts, doc, state } = hostRig();
    host.unlock();
    const ctx = contexts[0];
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(ctx.state).toBe('suspended');
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(ctx.state).toBe('running');

    state.presenting = true;
    const session = Object.assign(new EventTarget(), {
      visibilityState: 'visible',
    }) as unknown as XRSession & { visibilityState: string };
    host.sessionStart(session);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(ctx.state).toBe('running');
    (session as { visibilityState: string }).visibilityState = 'hidden';
    session.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(ctx.state).toBe('suspended');
    (session as { visibilityState: string }).visibilityState = 'visible';
    session.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(ctx.state).toBe('running');
  });

  test('pagehide (not into the back-forward cache) disposes and closes the context', async () => {
    const { host, contexts, win } = hostRig();
    host.unlock();
    const hide = Object.assign(new Event('pagehide'), { persisted: false });
    win.dispatchEvent(hide);
    await settle();
    expect(contexts[0].state).toBe('closed');
    host.unlock();
    expect(contexts).toHaveLength(1);
  });
});

describe('listener and rustle', () => {
  test('the listener follows the camera, forward -Z and up +Y', async () => {
    const { host, contexts } = hostRig();
    host.unlock();
    const m = new Matrix4().makeRotationY(Math.PI / 2).setPosition(new Vector3(1, 1.6, -2));
    host.frame({ matrixWorld: m }, 1, true);
    const l = contexts[0].listener;
    expect([l.positionX.value, l.positionY.value, l.positionZ.value]).toEqual([1, 1.6, -2]);
    // Yaw +90° turns -Z to -X.
    expect(l.forwardX.value).toBeCloseTo(-1, 6);
    expect(l.forwardZ.value).toBeCloseTo(0, 6);
    expect(l.upY.value).toBeCloseTo(1, 6);
  });

  test('a fast hand at the paint rustles in a painting in XR, never in the gallery or at calm 0', async () => {
    const { host, state, positions, velocities } = hostRig();
    host.unlock();
    await settle();
    state.presenting = true;
    positions[1].set(0, 0.1, -1, 1);
    velocities[1].set(RUSTLE_SPEED + 0.5, 0, 0, 0);
    host.setWorld('gallery', { ground, strokeReach: floorReach });
    host.frame(camera, 1, true);
    expect(host.diag().rustle.played).toBe(0);
    host.setWorld('starry-night', { ground, strokeReach: floorReach });
    host.frame(camera, 0, true);
    expect(host.diag().rustle.played).toBe(0);
    host.frame(camera, 1, true);
    expect(host.diag().rustle.played).toBe(1);
  });

  test('no rustle while the reactive gate is shut (?noanim, ?motionlayers), as the orbs stay dim', async () => {
    const { host, state, positions, velocities } = hostRig();
    host.unlock();
    await settle();
    state.presenting = true;
    positions[1].set(0, 0.1, -1, 1);
    velocities[1].set(RUSTLE_SPEED + 0.5, 0, 0, 0);
    host.setWorld('starry-night', { ground, strokeReach: floorReach });
    host.frame(camera, 1, false);
    expect(host.diag().rustle.played).toBe(0);
    host.frame(camera, 0, true);
    expect(host.diag().rustle.played).toBe(0);
    host.frame(camera, 1, true);
    expect(host.diag().rustle.played).toBe(1);
  });

  test('a painting without a stroke reach field never rustles', async () => {
    const { host, state, positions, velocities } = hostRig();
    host.unlock();
    await settle();
    state.presenting = true;
    positions[1].set(0, 0, -1, 1);
    velocities[1].set(RUSTLE_SPEED + 0.5, 0, 0, 0);
    host.setWorld('starry-night', { ground });
    host.frame(camera, 1, true);
    expect(host.diag().rustle.played).toBe(0);
  });

  test('the trigger fires once per push and re-arms when the hand slows', () => {
    const trigger = createRustleTrigger();
    const near = nearStrokes(floorReach);
    const p = [new Vector4(0, 0, 0, 0.4), new Vector4(0, 0.1, 0, 1), new Vector4(0, 2, 0, 1)];
    const v = [new Vector4(), new Vector4(1, 0, 0), new Vector4(1, 0, 0)];
    // The head never rustles, the high hand is not near strokes.
    expect(trigger.frame(p, v, near)).toEqual([[0, 0.1, 0]]);
    expect(trigger.frame(p, v, near)).toEqual([]);
    v[1].set(0.4, 0, 0, 0);
    expect(trigger.frame(p, v, near)).toEqual([]);
    v[1].set(0.1, 0, 0, 0);
    trigger.frame(p, v, near);
    v[1].set(1, 0, 0, 0);
    expect(trigger.frame(p, v, near)).toEqual([[0, 0.1, 0]]);
    // An untracked hand (strength 0) re-arms.
    p[1].w = 0;
    expect(trigger.frame(p, v, near)).toEqual([]);
    p[1].w = 1;
    expect(trigger.frame(p, v, near)).toEqual([[0, 0.1, 0]]);
    // The reach is the hand's paint reach: 0.2 m over the paint does not rustle.
    p[1].set(0, 0.2, 0, 1);
    expect(createRustleTrigger().frame(p, v, near)).toEqual([]);
  });
});
