/**
 * The app's audio host (P6.5): creates no `AudioContext` until the first user gesture (the Enter
 * VR button, or a pointerdown, pointerup, touchend or keydown on the page), then builds the mixer
 * on it, loads the cues and replays what the app asked for before the unlock (the world's score
 * and ambience, the volumes). main.ts drives it from the settings store, the world binding, the
 * portal trigger and the frame loop. The bench never creates one.
 *
 * A touch or pen pointerdown does not grant user activation, so a context made on one may stay
 * suspended. The gesture listeners therefore stay until a gesture finds the context running, and
 * each later gesture asks it to resume.
 *
 * The context suspends while the page is hidden outside XR, or while the XR session's
 * `visibilityState` is `hidden` (for example, the headset taken off). The page's own visibility is
 * ignored while presenting, so an engine that reports the 2D page hidden in immersive mode cannot
 * silence the headset.
 */

import type { StrokeReach } from '../render/strokes/reach-field';
import type { AudioContextLike } from './context';
import { type AudioFormat, CUE_IDS, type CueId, pickFormat, type ScoreId, scoreFor } from './cues';
import { createMixer, MAX_SFX_VOICES, type Mixer, type MixerDiag } from './mixer';
import { type Ambience, ambienceFor, type Vec3 } from './placement';
import { createRustleTrigger, type NearStrokes, nearStrokes } from './rustle';

interface XyzW {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/** The built world's parts the audio reads: its ground, and its stroke reach for the rustle. */
export interface AudioWorld {
  readonly ground: { heightAt(x: number, z: number): number };
  /** Omitted: the world's strokes do not react to the hands, so nothing rustles. */
  readonly strokeReach?: Pick<StrokeReach, 'distance'>;
}

/** The camera that rendered the frame: its world matrix (column-major). */
export interface ListenerSource {
  readonly matrixWorld: { readonly elements: ArrayLike<number> };
}

export interface AudioHostDeps {
  /** Vite's base URL. */
  readonly base: string;
  /** `?mute`. */
  readonly muted: boolean;
  volumes(): { music: number; sfx: number };
  presenting(): boolean;
  /** The reactive tracker's disturbers and velocities, slot order (head, then two hands). */
  readonly disturbers: {
    readonly positions: readonly XyzW[];
    readonly velocities: readonly XyzW[];
  };
  /** Default `new AudioContext()`. */
  createContext?: () => AudioContextLike;
  /** Default `fetch`, rejecting on a non-OK status. */
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
  /** Default `HTMLAudioElement.canPlayType`. */
  canPlayType?: (mime: string) => string;
  readonly random?: () => number;
  readonly log?: (message: string) => void;
  /** Where the gesture and page listeners go. Default `window` and `document`. */
  readonly window?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly document?: Pick<
    Document,
    'addEventListener' | 'removeEventListener' | 'hidden' | 'createElement'
  >;
}

export interface AudioDiag extends Omit<MixerDiag, 'state'> {
  /** The context's state, or 'none' before the unlock. */
  state: string;
  unlocked: boolean;
}

export interface AudioHost {
  /** Creates the context. Call inside a user gesture; repeats do nothing. */
  unlock(): void;
  readonly unlocked: boolean;
  /** A world bound: its score and ambience. Null for no world (the bare scene). */
  setWorld(id: string | null, world: AudioWorld | null): void;
  /** The active world is being released: its beds fade out, the score keeps playing. */
  clearWorld(): void;
  /** A portal transition starts toward world `target`: the whoosh, and the score crossfade. */
  transition(target: string | null): void;
  setVolumes(music: number, sfx: number): void;
  /**
   * After the frame's render: the listener, the bell, the rustle. The rustle needs `calm` above 0
   * and `reactive`, the reactive motion's gate (`?noanim`, `?motionlayers`), as the orbs do.
   */
  frame(camera: ListenerSource, calm: number, reactive: boolean): void;
  sessionStart(
    session: Pick<XRSession, 'addEventListener' | 'removeEventListener' | 'visibilityState'>,
  ): void;
  sessionEnd(): void;
  diag(): AudioDiag;
  dispose(): void;
}

/**
 * Fetches a file's bytes. A non-OK status rejects, and so does HTML: Vite's dev and preview servers
 * answer a missing path with index.html and a 200, so a missing cue reads as missing there too.
 */
/** The events that may carry user activation, so may unlock the context. */
const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown'] as const;

async function fetchOk(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (response.headers.get('content-type')?.startsWith('text/html')) {
    throw new Error('HTML fallback, not found');
  }
  return response.arrayBuffer();
}

export function createAudioHost(deps: AudioHostDeps): AudioHost {
  const win = deps.window ?? window;
  const doc = deps.document ?? document;
  let mixer: Mixer | null = null;
  let disposed = false;
  let score: ScoreId | null = null;
  let ambience: Ambience | null = null;
  let near: NearStrokes | null = null;
  let xrHidden = false;
  const trigger = createRustleTrigger();
  const position: [number, number, number] = [0, 0, 0];
  const forward: [number, number, number] = [0, 0, -1];
  const up: [number, number, number] = [0, 1, 0];
  const pose = { position, forward, up };

  let ctx: AudioContextLike | null = null;
  let session: Pick<
    XRSession,
    'addEventListener' | 'removeEventListener' | 'visibilityState'
  > | null = null;
  const onSessionVisibility = (): void => {
    xrHidden = session?.visibilityState === 'hidden';
    updateSuspended();
  };
  let listening = true;
  const onGesture = (): void => {
    host.unlock();
    if (listening && ctx?.state === 'running') stopListening();
  };
  function stopListening(): void {
    listening = false;
    for (const type of GESTURE_EVENTS) {
      win.removeEventListener(type, onGesture, { capture: true });
    }
  }
  const onVisibility = (): void => updateSuspended();
  const onPageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) host.dispose();
  };
  for (const type of GESTURE_EVENTS) win.addEventListener(type, onGesture, { capture: true });
  win.addEventListener('pagehide', onPageHide);
  doc.addEventListener('visibilitychange', onVisibility);

  const wantSuspended = (): boolean => (doc.hidden && !deps.presenting()) || xrHidden;

  function updateSuspended(): void {
    mixer?.setSuspended(wantSuspended());
  }

  function setScore(next: ScoreId | null): void {
    score = next;
    mixer?.setScore(next);
  }

  function setAmbience(next: Ambience | null): void {
    ambience = next;
    mixer?.setAmbience(next);
  }

  const host: AudioHost = {
    unlock() {
      if (disposed) return;
      if (ctx) {
        // A later gesture: a context left suspended by a gesture without activation starts now.
        if (ctx.state === 'suspended' && !wantSuspended()) ctx.resume().catch(() => {});
        return;
      }
      ctx = deps.createContext ? deps.createContext() : new AudioContext();
      // Inside the gesture: an engine that created it suspended starts it here.
      if (ctx.state === 'suspended' && !wantSuspended()) ctx.resume().catch(() => {});
      const canPlay =
        deps.canPlayType ?? ((mime: string) => doc.createElement('audio').canPlayType(mime));
      const format: AudioFormat = pickFormat(canPlay);
      const volumes = deps.volumes();
      mixer = createMixer({
        ctx,
        base: deps.base,
        format,
        fetchBytes: deps.fetchBytes ?? fetchOk,
        volumes,
        muted: deps.muted,
        random: deps.random,
        log: deps.log,
      });
      mixer.setScore(score);
      mixer.setAmbience(ambience);
      updateSuspended();
      void mixer.load();
    },
    get unlocked() {
      return mixer !== null;
    },
    setWorld(id, world) {
      setScore(scoreFor(id));
      setAmbience(world ? ambienceFor(id, world.ground) : null);
      // Only a painting's strokes react (the gallery's motion mask is 0).
      near =
        world?.strokeReach && id !== null && id !== 'gallery'
          ? nearStrokes(world.strokeReach)
          : null;
      trigger.reset();
    },
    clearWorld() {
      near = null;
      setAmbience(null);
    },
    transition(target) {
      near = null;
      mixer?.playWhoosh();
      setAmbience(null);
      setScore(scoreFor(target));
    },
    setVolumes(music, sfx) {
      mixer?.setVolumes(music, sfx);
    },
    frame(camera, calm, reactive) {
      if (!mixer || mixer.disposed) return;
      const e = camera.matrixWorld.elements;
      position[0] = e[12];
      position[1] = e[13];
      position[2] = e[14];
      const fl = Math.hypot(e[8], e[9], e[10]) || 1;
      forward[0] = -e[8] / fl;
      forward[1] = -e[9] / fl;
      forward[2] = -e[10] / fl;
      const ul = Math.hypot(e[4], e[5], e[6]) || 1;
      up[0] = e[4] / ul;
      up[1] = e[5] / ul;
      up[2] = e[6] / ul;
      mixer.setListener(pose);
      mixer.frame();
      if (near && calm > 0 && reactive && deps.presenting()) {
        const fired = trigger.frame(deps.disturbers.positions, deps.disturbers.velocities, near);
        for (const p of fired) mixer.rustle(p as Vec3);
      }
    },
    sessionStart(next) {
      session?.removeEventListener('visibilitychange', onSessionVisibility);
      session = next;
      session.addEventListener('visibilitychange', onSessionVisibility);
      onSessionVisibility();
    },
    sessionEnd() {
      session?.removeEventListener('visibilitychange', onSessionVisibility);
      session = null;
      xrHidden = false;
      trigger.reset();
      updateSuspended();
    },
    diag() {
      if (mixer) return { ...mixer.diag(), unlocked: true };
      const v = deps.volumes();
      return {
        state: 'none',
        unlocked: false,
        muted: deps.muted,
        manifest: 'pending',
        buses: { music: v.music, sfx: v.sfx },
        voices: { music: 0, sfx: 0, max: MAX_SFX_VOICES, dropped: 0 },
        score: { target: score, playing: null, crossfading: false },
        cues: Object.fromEntries(CUE_IDS.map((id) => [id, 'pending'])) as Record<CueId, 'pending'>,
        buffers: 0,
        rustle: { played: 0, limited: 0 },
        bell: { rung: 0, nextS: null },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopListening();
      session?.removeEventListener('visibilitychange', onSessionVisibility);
      session = null;
      win.removeEventListener('pagehide', onPageHide);
      doc.removeEventListener('visibilitychange', onVisibility);
      mixer?.dispose();
    },
  };
  return host;
}
