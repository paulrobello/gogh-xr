/**
 * The WebAudio mixer (P6.5, plans/phase-6-audio.md). One context, created on the first user
 * gesture (src/audio/audio.ts), feeds:
 *
 *   score voices → per-score gain → music bus ┐
 *   sfx voices → gain → [HRTF panner] → sfx bus ┴→ master (mute) → limiter trim → limiter → destination
 *
 * The music and SFX buses follow the `musicVolume` and `sfxVolume` settings, and the master gain
 * mutes. Every positional cue gets its own HRTF `PannerNode`, and the listener follows the camera
 * that rendered the frame. Scores loop and crossfade with an equal-power ramp when the world
 * changes. SFX voices are capped at `MAX_SFX_VOICES` (a voice past the cap is dropped, never
 * stolen), and the rustle is rate-limited on top. Every time is the context's `currentTime`, which
 * stops while the context is suspended, so the bell and the fades pause with it.
 *
 * Only the active score and a crossfade's target are decoded: a 150 s stereo score is about 58 MB
 * of float32 PCM, so a score's PCM is dropped once its voice has faded out, and its compressed
 * bytes (at most 3 MiB) are kept to decode it again. SFX buffers stay decoded.
 */
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioParamLike,
  BufferSourceLike,
  GainNodeLike,
  PannerNodeLike,
} from './context';
import {
  type AudioFormat,
  type AudioManifest,
  CUE_IDS,
  type CueId,
  cueUrl,
  MANIFEST_PATH,
  parseManifest,
  SCORE_IDS,
  type ScoreId,
} from './cues';
import type { Ambience, Vec3 } from './placement';

/** Concurrent SFX voices, beds included. A voice past the cap is dropped. */
export const MAX_SFX_VOICES = 12;
/** Concurrent score voices: one at full and up to two still fading out. */
export const MAX_MUSIC_VOICES = 3;
/** The score crossfade on a world change, seconds, equal power. */
export const SCORE_CROSSFADE_S = 3;
/** A score's fade-in from silence (the first score after unlock), seconds. */
export const SCORE_FADE_IN_S = 2;
/** Linear segments of an equal-power fade. */
export const FADE_SEGMENTS = 16;
/** Bed fades, seconds. */
export const BED_FADE_IN_S = 2;
export const BED_FADE_OUT_S = 1;
/** The rustle's minimum interval between two starts, seconds, and its own voice cap. */
export const RUSTLE_MIN_INTERVAL_S = 0.25;
export const RUSTLE_MAX_VOICES = 2;
/** The first bell after a world's ambience starts, then each next one, seconds. */
export const BELL_FIRST_S: Readonly<{ min: number; max: number }> = Object.freeze({
  min: 10,
  max: 30,
});
export const BELL_INTERVAL_S: Readonly<{ min: number; max: number }> = Object.freeze({
  min: 60,
  max: 120,
});
/** The longest wait on one suspend or resume before the next state request runs, ms. */
export const STATE_CHANGE_WAIT_MS = 500;
/** Bus and master gain smoothing (setTargetAtTime's time constant), seconds. */
export const GAIN_SMOOTH_S = 0.03;

/** Per-cue voice gain and, for positional cues, the panner's distance model. */
export interface CueSpatial {
  readonly gain: number;
  readonly refDistance: number;
  readonly rolloffFactor: number;
  readonly maxDistance: number;
}

/** dB to linear amplitude. */
const dbToGain = (db: number): number => 10 ** (db / 20);

/**
 * Runtime trims on the mastered beds (Paul, headset, 2026-11-11), applied to each voice's own gain
 * so the files, which `make asset-check` byte-checks against their loudness targets, stay as they
 * are. Wind is +4 dB over its old gain of 1. Crickets are +10 dB over their old 0.6, a gain and
 * not a closer panner, because a smaller refDistance or rolloff would also change how fast the
 * five voices fade as the viewer walks away, where Paul asked only for a louder bed.
 */
export const WIND_HILL_GAIN_DB = 4;
export const CRICKETS_GAIN_DB = 10;
export const WIND_HILL_GAIN = dbToGain(WIND_HILL_GAIN_DB);
export const CRICKETS_BASE_GAIN = 0.6;
export const CRICKETS_GAIN = CRICKETS_BASE_GAIN * dbToGain(CRICKETS_GAIN_DB);

/**
 * The master limiter's settings. The boosted beds can sum past full scale at a high SFX volume,
 * and a DAC clips hard, so a fast compressor with a high ratio sits before the destination.
 */
export const LIMITER = Object.freeze({
  threshold: -3,
  knee: 0,
  ratio: 20,
  attack: 0.003,
  release: 0.15,
});

/**
 * A DynamicsCompressorNode applies automatic makeup gain: (1 / fullRangeGain) ^ 0.6, where
 * fullRangeGain is the compression curve applied to 1.0 (W3C Web Audio, "Computing the makeup
 * gain"). For a hard knee the curve above the threshold is linear in dB with slope 1 / ratio
 * (the spec text only says "linear, based on the ratio" and leaves the shape to the user agent,
 * and Chromium uses this form), so fullRangeGain is threshold + (0 - threshold) / ratio dB.
 * At -3 dB and ratio 20 that is -2.85 dB, a makeup of +1.71 dB. `LIMITER_TRIM` is its inverse,
 * a gain in front of the compressor, so the level below the threshold equals the pre-limiter
 * level. The threshold then acts at `-threshold + makeup` dB above the master level, -1.29 dBFS.
 */
export const LIMITER_MAKEUP_DB =
  -(LIMITER.threshold + (0 - LIMITER.threshold) / LIMITER.ratio) * 0.6;
export const LIMITER_TRIM = dbToGain(-LIMITER_MAKEUP_DB);

export const CUE_SPATIAL: Readonly<Partial<Record<CueId, CueSpatial>>> = Object.freeze({
  'wind-hill': { gain: WIND_HILL_GAIN, refDistance: 6, rolloffFactor: 1, maxDistance: 200 },
  crickets: { gain: CRICKETS_GAIN, refDistance: 3, rolloffFactor: 1.2, maxDistance: 120 },
  'church-bell': { gain: 1, refDistance: 20, rolloffFactor: 1, maxDistance: 400 },
  'stroke-rustle': { gain: 0.8, refDistance: 0.5, rolloffFactor: 1, maxDistance: 20 },
});

export type CueStatus = 'pending' | 'loaded' | 'missing' | 'error';
export type ManifestStatus = 'pending' | 'loaded' | 'missing';

export interface ListenerPose {
  readonly position: Vec3;
  /** Unit forward (the camera's -Z) and up (+Y) in world axes. */
  readonly forward: Vec3;
  readonly up: Vec3;
}

export interface MixerDeps {
  readonly ctx: AudioContextLike;
  /** Vite's base URL. */
  readonly base: string;
  readonly format: AudioFormat;
  /** Fetches a file's bytes; rejects on a network error or a non-OK status. */
  fetchBytes(url: string): Promise<ArrayBuffer>;
  readonly volumes: { readonly music: number; readonly sfx: number };
  readonly muted?: boolean;
  /** 0-1, for the bell's intervals and the beds' loop offsets. Default `Math.random`. */
  readonly random?: () => number;
  /** Default `console.warn`. */
  readonly log?: (message: string) => void;
}

export interface MixerDiag {
  state: string;
  muted: boolean;
  manifest: ManifestStatus;
  buses: { music: number; sfx: number };
  voices: { music: number; sfx: number; max: number; dropped: number };
  score: { target: ScoreId | null; playing: ScoreId | null; crossfading: boolean };
  cues: Record<CueId, CueStatus>;
  /** Decoded buffers held. */
  buffers: number;
  rustle: { played: number; limited: number };
  bell: { rung: number; nextS: number | null };
}

export interface Mixer {
  /** Fetches the manifest and every cue. Never rejects: a missing file leaves its cue silent. */
  load(): Promise<void>;
  setVolumes(music: number, sfx: number): void;
  setMuted(muted: boolean): void;
  /** Crossfades to `id`, or fades the music out for null. Repeating the target does nothing. */
  setScore(id: ScoreId | null): void;
  /** Fades the old beds out and the new ones in; null leaves the world silent but for music. */
  setAmbience(ambience: Ambience | null): void;
  playWhoosh(): void;
  /** A rustle at a hand; false when rate-limited, capped or not loaded. */
  rustle(position: Vec3): boolean;
  setListener(pose: ListenerPose): void;
  /** Once per frame: the bell. */
  frame(): void;
  /** Suspends or resumes the context (page or XR session hidden). */
  setSuspended(suspended: boolean): void;
  /** Stops every voice, disconnects every node, drops every buffer and closes the context. */
  dispose(): void;
  readonly disposed: boolean;
  diag(): MixerDiag;
}

interface Voice {
  readonly kind: 'music' | 'sfx';
  readonly cue: CueId;
  readonly source: BufferSourceLike;
  readonly gain: GainNodeLike;
  readonly panner: PannerNodeLike | null;
  /** Context time of the start, and the buffer offset it started from, seconds. */
  readonly startedAt: number;
  readonly offset: number;
  fadingOut: boolean;
  ended: boolean;
}

const isScore = (id: CueId): id is ScoreId => (SCORE_IDS as readonly CueId[]).includes(id);

/** Equal-power gain at fraction `t` of a fade in (`sin`), scaled. */
const fadeInAt = (t: number): number => Math.sin((Math.PI / 2) * t);

/** Holds `param` at its current value from `now`, cancelling later automation. */
function hold(param: AudioParamLike, now: number): number {
  const current = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(current, now);
  return current;
}

/** An equal-power ramp of `param` from its current value to `to` over `duration` seconds. */
function equalPowerRamp(param: AudioParamLike, now: number, to: number, duration: number): void {
  const from = hold(param, now);
  for (let i = 1; i <= FADE_SEGMENTS; i++) {
    const t = i / FADE_SEGMENTS;
    // Fade in: from + (to − from)·sin(πt/2). Fade out: to + (from − to)·cos(πt/2).
    const v = to >= from ? from + (to - from) * fadeInAt(t) : to + (from - to) * fadeInAt(1 - t);
    param.linearRampToValueAtTime(v, now + duration * t);
  }
}

/**
 * `promise`, or nothing after STATE_CHANGE_WAIT_MS. A resume without user activation stays pending
 * until a gesture, and it must not hold a later suspend behind it.
 */
const within = (promise: Promise<void>): Promise<void> =>
  Promise.race([
    promise,
    new Promise<void>((resolve) => setTimeout(resolve, STATE_CHANGE_WAIT_MS)),
  ]);

const between = (random: () => number, range: { min: number; max: number }): number =>
  range.min + (range.max - range.min) * random();

export function createMixer(deps: MixerDeps): Mixer {
  const { ctx } = deps;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const master = ctx.createGain();
  const musicBus = ctx.createGain();
  const sfxBus = ctx.createGain();
  musicBus.connect(master);
  sfxBus.connect(master);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER.threshold;
  limiter.knee.value = LIMITER.knee;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attack;
  limiter.release.value = LIMITER.release;
  const limiterTrim = ctx.createGain();
  limiterTrim.gain.value = LIMITER_TRIM;
  master.connect(limiterTrim);
  limiterTrim.connect(limiter);
  limiter.connect(ctx.destination);
  let volumes = { music: deps.volumes.music, sfx: deps.volumes.sfx };
  let muted = deps.muted ?? false;
  master.gain.value = muted ? 0 : 1;
  musicBus.gain.value = volumes.music;
  sfxBus.gain.value = volumes.sfx;

  const voices = new Set<Voice>();
  const buffers = new Map<CueId, AudioBufferLike>();
  /** The scores' compressed bytes, kept so a dropped score can decode again. */
  const encoded = new Map<ScoreId, ArrayBuffer>();
  const decoding = new Map<CueId, Promise<AudioBufferLike | null>>();
  const cues = Object.fromEntries(CUE_IDS.map((id) => [id, 'pending'])) as Record<CueId, CueStatus>;
  let manifest: ManifestStatus = 'pending';
  let scoreTarget: ScoreId | null = null;
  /** The voice of `scoreTarget` that is fading in or playing, or null. */
  let scoreVoice: Voice | null = null;
  /** True once any score has played: the next start crossfades instead of fading in. */
  let musicStarted = false;
  let ambience: Ambience | null = null;
  /** One slot per bed of `ambience`, null until its buffer is loaded and the voice started. */
  let bedVoices: (Voice | null)[] = [];
  let nextBellAt: number | null = null;
  let bellsRung = 0;
  let lastRustleAt = Number.NEGATIVE_INFINITY;
  let rustlesPlayed = 0;
  let rustlesLimited = 0;
  let dropped = 0;
  let disposed = false;
  let wantSuspended = false;
  let stateChange: Promise<void> = Promise.resolve();

  const count = (kind: Voice['kind'], cue?: CueId): number => {
    let n = 0;
    for (const v of voices) if (v.kind === kind && (cue === undefined || v.cue === cue)) n++;
    return n;
  };

  function release(voice: Voice): void {
    if (voice.ended) return;
    voice.ended = true;
    voice.source.onended = null;
    voice.source.disconnect();
    voice.gain.disconnect();
    voice.panner?.disconnect();
    voices.delete(voice);
    if (voice === scoreVoice) scoreVoice = null;
    // A score's PCM is dropped once nothing plays it and it is not the target.
    if (isScore(voice.cue) && voice.cue !== scoreTarget && count('music', voice.cue) === 0) {
      buffers.delete(voice.cue);
    }
  }

  function startVoice(
    kind: Voice['kind'],
    cue: CueId,
    buffer: AudioBufferLike,
    loop: boolean,
    gain: number,
    fadeS: number,
    position: Vec3 | null,
    offset = 0,
  ): Voice {
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    const g = ctx.createGain();
    source.connect(g);
    let panner: PannerNodeLike | null = null;
    if (position) {
      const spatial = CUE_SPATIAL[cue];
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = spatial?.refDistance ?? 1;
      panner.rolloffFactor = spatial?.rolloffFactor ?? 1;
      panner.maxDistance = spatial?.maxDistance ?? 10000;
      if (panner.positionX && panner.positionY && panner.positionZ) {
        panner.positionX.value = position[0];
        panner.positionY.value = position[1];
        panner.positionZ.value = position[2];
      } else {
        panner.setPosition?.(position[0], position[1], position[2]);
      }
      g.connect(panner);
      panner.connect(sfxBus);
    } else {
      g.connect(kind === 'music' ? musicBus : sfxBus);
    }
    if (fadeS > 0) {
      g.gain.value = 0;
      equalPowerRamp(g.gain, now, gain, fadeS);
    } else {
      g.gain.value = gain;
    }
    const voice: Voice = {
      kind,
      cue,
      source,
      gain: g,
      panner,
      startedAt: now,
      offset,
      fadingOut: false,
      ended: false,
    };
    source.onended = () => release(voice);
    voices.add(voice);
    source.start(now, offset);
    return voice;
  }

  function fadeOut(voice: Voice, duration: number): void {
    if (voice.fadingOut || voice.ended) return;
    voice.fadingOut = true;
    const now = ctx.currentTime;
    equalPowerRamp(voice.gain.gain, now, 0, duration);
    voice.source.stop(now + duration);
  }

  /** An SFX voice of `cue`, or null when it is not loaded or the SFX voices are at the cap. */
  function playSfx(
    cue: CueId,
    loop: boolean,
    position: Vec3 | null,
    fadeS = 0,
    offset = 0,
  ): Voice | null {
    if (disposed) return null;
    const buffer = buffers.get(cue);
    if (!buffer) return null;
    if (count('sfx') >= MAX_SFX_VOICES) {
      dropped++;
      return null;
    }
    const gain = CUE_SPATIAL[cue]?.gain ?? 1;
    return startVoice('sfx', cue, buffer, loop, gain, fadeS, position, offset);
  }

  function decode(id: CueId): Promise<AudioBufferLike | null> {
    const ready = buffers.get(id);
    if (ready) return Promise.resolve(ready);
    const pending = decoding.get(id);
    if (pending) return pending;
    const bytes = isScore(id) ? encoded.get(id) : undefined;
    if (!bytes) return Promise.resolve(null);
    const job = ctx
      .decodeAudioData(bytes.slice(0))
      .then((buffer) => {
        if (disposed) return null;
        buffers.set(id, buffer);
        return buffer;
      })
      .catch((error: unknown) => {
        cues[id] = 'error';
        log(`audio: ${id} failed to decode (${String(error)}); it stays silent`);
        return null;
      })
      .finally(() => decoding.delete(id));
    decoding.set(id, job);
    return job;
  }

  /** True while a voice of the target score plays and is not fading out. */
  const playingTarget = (): boolean =>
    scoreVoice !== null && scoreVoice.cue === scoreTarget && !scoreVoice.fadingOut;

  function fadeMusicOut(): void {
    for (const v of voices) if (v.kind === 'music') fadeOut(v, SCORE_CROSSFADE_S);
    scoreVoice = null;
  }

  /** Fades every score voice out and the target in from now, both on the same clock. */
  function crossfadeTo(id: ScoreId, buffer: AudioBufferLike): void {
    if (disposed || scoreTarget !== id || playingTarget()) return;
    // A reversal mid-fade: the new voice picks up where the fading voice of this score is, so the
    // two copies stay in phase while one fades out and the other in.
    const now = ctx.currentTime;
    const same = [...voices].find((v) => v.kind === 'music' && v.cue === id);
    const offset =
      same && buffer.duration > 0 ? (now - same.startedAt + same.offset) % buffer.duration : 0;
    fadeMusicOut();
    // Over the cap, the oldest fading voice stops now.
    while (count('music') >= MAX_MUSIC_VOICES) {
      const oldest = [...voices].find((v) => v.kind === 'music' && v.fadingOut);
      if (!oldest) break;
      try {
        oldest.source.stop();
      } catch {
        // Already stopped.
      }
      release(oldest);
    }
    const fadeS = musicStarted ? SCORE_CROSSFADE_S : SCORE_FADE_IN_S;
    musicStarted = true;
    scoreVoice = startVoice('music', id, buffer, true, 1, fadeS, null, offset);
  }

  /**
   * Crossfades to the target score. Its PCM may need decoding first: the outgoing score holds at
   * its level until then, so the two fades start together and keep equal power.
   */
  function startScore(id: ScoreId): void {
    const ready = buffers.get(id);
    if (ready) {
      crossfadeTo(id, ready);
      return;
    }
    void decode(id).then((buffer) => {
      if (disposed) return;
      if (scoreTarget !== id) {
        // Retargeted while decoding: drop the PCM unless a fading voice still plays it.
        if (buffer && count('music', id) === 0) buffers.delete(id);
        return;
      }
      if (buffer) crossfadeTo(id, buffer);
      // Still fetching: loadCue starts it. Missing or undecodable: the old score goes.
      else if (cues[id] !== 'pending') unavailable(id);
    });
  }

  /** The target score has no file or failed to decode: the music fades out. */
  function unavailable(id: CueId): void {
    if (isScore(id) && scoreTarget === id && !playingTarget()) fadeMusicOut();
  }

  function startBeds(): void {
    if (!ambience) return;
    ambience.beds.forEach((bed, i) => {
      if (bedVoices[i]) return;
      const buffer = buffers.get(bed.cue);
      if (!buffer) return;
      // A random loop offset, so the cricket sources never play in phase.
      bedVoices[i] = playSfx(
        bed.cue,
        true,
        bed.position,
        BED_FADE_IN_S,
        random() * buffer.duration,
      );
    });
  }

  function setRamp(param: AudioParamLike, value: number): void {
    param.setTargetAtTime(value, ctx.currentTime, GAIN_SMOOTH_S);
  }

  async function loadCue(id: CueId, url: string): Promise<void> {
    let bytes: ArrayBuffer;
    try {
      bytes = await deps.fetchBytes(url);
    } catch (error) {
      cues[id] = 'missing';
      log(`audio: ${id} not found at ${url} (${String(error)}); it stays silent`);
      unavailable(id);
      return;
    }
    if (disposed) return;
    if (isScore(id)) {
      encoded.set(id, bytes);
      cues[id] = 'loaded';
      if (scoreTarget === id && !playingTarget()) startScore(id);
      return;
    }
    let buffer: AudioBufferLike;
    try {
      buffer = await ctx.decodeAudioData(bytes);
    } catch (error) {
      if (disposed) return;
      cues[id] = 'error';
      log(`audio: ${id} failed to decode (${String(error)}); it stays silent`);
      return;
    }
    // A dispose during the decode has already cleared the buffers: hold nothing more.
    if (disposed) return;
    buffers.set(id, buffer);
    cues[id] = 'loaded';
    startBeds();
  }

  const mixer: Mixer = {
    async load() {
      let parsed: AudioManifest | null = null;
      const url = `${deps.base}${MANIFEST_PATH}`;
      try {
        const bytes = await deps.fetchBytes(url);
        parsed = parseManifest(JSON.parse(new TextDecoder().decode(bytes)));
      } catch {
        parsed = null;
      }
      if (disposed) return;
      if (!parsed) {
        manifest = 'missing';
        for (const id of CUE_IDS) cues[id] = 'missing';
        if (scoreTarget) unavailable(scoreTarget);
        log(`audio: no usable manifest at ${url}; running silent`);
        return;
      }
      manifest = 'loaded';
      const listed = new Set(parsed.cues.map((c) => c.id));
      for (const id of CUE_IDS) {
        if (listed.has(id)) continue;
        cues[id] = 'missing';
        unavailable(id);
      }
      await Promise.all(
        parsed.cues.map((cue) => {
          const cueFile = cueUrl(cue, deps.format, deps.base);
          return cueFile ? loadCue(cue.id, cueFile) : Promise.resolve();
        }),
      );
    },
    setVolumes(music, sfx) {
      volumes = { music, sfx };
      if (disposed) return;
      setRamp(musicBus.gain, music);
      setRamp(sfxBus.gain, sfx);
    },
    setMuted(next) {
      muted = next;
      if (!disposed) setRamp(master.gain, muted ? 0 : 1);
    },
    setScore(id) {
      if (disposed || id === scoreTarget) return;
      scoreTarget = id;
      if (id === null) {
        fadeMusicOut();
        return;
      }
      // A reversal before the other score decoded: the voice still at full keeps playing.
      const keep = [...voices].find((v) => v.kind === 'music' && v.cue === id && !v.fadingOut);
      if (keep) {
        for (const v of voices) if (v.kind === 'music' && v !== keep) fadeOut(v, SCORE_CROSSFADE_S);
        scoreVoice = keep;
        return;
      }
      startScore(id);
    },
    setAmbience(next) {
      if (disposed) return;
      for (const v of bedVoices) if (v) fadeOut(v, BED_FADE_OUT_S);
      ambience = next;
      bedVoices = next ? next.beds.map(() => null) : [];
      nextBellAt = next?.bell ? ctx.currentTime + between(random, BELL_FIRST_S) : null;
      startBeds();
    },
    playWhoosh() {
      playSfx('portal-whoosh', false, null);
    },
    rustle(position) {
      if (disposed || !buffers.has('stroke-rustle')) return false;
      const now = ctx.currentTime;
      if (
        now - lastRustleAt < RUSTLE_MIN_INTERVAL_S ||
        count('sfx', 'stroke-rustle') >= RUSTLE_MAX_VOICES
      ) {
        rustlesLimited++;
        return false;
      }
      if (!playSfx('stroke-rustle', false, position)) return false;
      lastRustleAt = now;
      rustlesPlayed++;
      return true;
    },
    setListener({ position: p, forward: f, up: u }) {
      if (disposed) return;
      const l = ctx.listener;
      if (l.positionX && l.positionY && l.positionZ) {
        l.positionX.value = p[0];
        l.positionY.value = p[1];
        l.positionZ.value = p[2];
      } else {
        l.setPosition?.(p[0], p[1], p[2]);
      }
      if (l.forwardX && l.forwardY && l.forwardZ && l.upX && l.upY && l.upZ) {
        l.forwardX.value = f[0];
        l.forwardY.value = f[1];
        l.forwardZ.value = f[2];
        l.upX.value = u[0];
        l.upY.value = u[1];
        l.upZ.value = u[2];
      } else {
        l.setOrientation?.(f[0], f[1], f[2], u[0], u[1], u[2]);
      }
    },
    frame() {
      if (disposed || nextBellAt === null || !ambience?.bell) return;
      const now = ctx.currentTime;
      if (now < nextBellAt) return;
      if (playSfx('church-bell', false, ambience.bell)) bellsRung++;
      nextBellAt = now + between(random, BELL_INTERVAL_S);
    },
    setSuspended(suspended) {
      if (disposed) return;
      wantSuspended = suspended;
      // Each request waits for the previous suspend or resume, then re-checks the wanted state, so
      // a hide and show quicker than one suspend still ends running.
      stateChange = stateChange
        .then(async () => {
          if (disposed) return;
          if (wantSuspended && ctx.state === 'running') await within(ctx.suspend());
          else if (!wantSuspended && ctx.state === 'suspended') await within(ctx.resume());
        })
        .catch(() => {});
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const voice of [...voices]) {
        voice.source.onended = null;
        try {
          voice.source.stop();
        } catch {
          // Already stopped.
        }
        release(voice);
      }
      musicBus.disconnect();
      sfxBus.disconnect();
      master.disconnect();
      limiterTrim.disconnect();
      limiter.disconnect();
      buffers.clear();
      encoded.clear();
      decoding.clear();
      ambience = null;
      bedVoices = [];
      nextBellAt = null;
      scoreVoice = null;
      void ctx.close();
    },
    get disposed() {
      return disposed;
    },
    diag() {
      let crossfading = false;
      for (const v of voices) if (v.kind === 'music' && v.fadingOut) crossfading = true;
      return {
        state: ctx.state,
        muted,
        manifest,
        buses: { ...volumes },
        voices: { music: count('music'), sfx: count('sfx'), max: MAX_SFX_VOICES, dropped },
        score: {
          target: scoreTarget,
          playing: (scoreVoice?.cue as ScoreId | undefined) ?? null,
          crossfading,
        },
        cues: { ...cues },
        buffers: buffers.size,
        rustle: { played: rustlesPlayed, limited: rustlesLimited },
        bell: { rung: bellsRung, nextS: nextBellAt },
      };
    },
  };
  return mixer;
}
