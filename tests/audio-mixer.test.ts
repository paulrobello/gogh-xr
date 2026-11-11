/**
 * The P6.5 mixer on a fake AudioContext: gain routing, mute, the voice bound, the rustle's rate
 * limit, the score crossfade, the bell, the listener, suspension, a missing manifest, and every
 * node and buffer released on dispose.
 */
import { describe, expect, test } from 'vitest';
import { CUE_IDS, type CueId, MANIFEST_PATH } from '../src/audio/cues.ts';
import {
  BELL_FIRST_S,
  BELL_INTERVAL_S,
  CRICKETS_GAIN,
  CUE_SPATIAL,
  createMixer,
  LIMITER,
  LIMITER_MAKEUP_DB,
  LIMITER_TRIM,
  MAX_MUSIC_VOICES,
  MAX_SFX_VOICES,
  type MixerDeps,
  RUSTLE_MAX_VOICES,
  RUSTLE_MIN_INTERVAL_S,
  SCORE_CROSSFADE_S,
  SCORE_FADE_IN_S,
  WIND_HILL_GAIN,
} from '../src/audio/mixer.ts';
import { type Ambience, ambienceFor, bellPosition } from '../src/audio/placement.ts';
import {
  audioBytes,
  chain,
  FakeAudioContext,
  type FakeCompressor,
  type FakeGain,
  type FakeNode,
  FakePanner,
  type FakeSource,
  settle,
} from './audio-fake.ts';

const BASE = '/';
/** Cue durations, seconds: the scores loop, the one-shots are short. */
const DURATIONS: Record<CueId, number> = {
  'score-gallery': 150,
  'score-night': 160,
  'wind-hill': 30,
  crickets: 20,
  'church-bell': 6,
  'portal-whoosh': 1.5,
  'stroke-rustle': 2,
};

function manifestJson(ids: readonly CueId[] = CUE_IDS): ArrayBuffer {
  // P6.4's shape (tests/fixtures/audio-manifest.json): file names relative to the manifest.
  const cues = ids.map((id) => ({
    id,
    kind: id.startsWith('score') ? 'music' : 'sfx',
    loop: id.startsWith('score') || id === 'wind-hill' || id === 'crickets',
    channels: id.startsWith('score') ? 2 : 1,
    duration: DURATIONS[id],
    frames: DURATIONS[id] * 48000,
    loudness: { target: id.startsWith('score') ? -18 : -24, tolerance: 1 },
    files: { ogg: `${id}.ogg`, mp3: `${id}.mp3` },
  }));
  return new TextEncoder().encode(JSON.stringify({ version: 1, sampleRate: 48000, cues }))
    .buffer as ArrayBuffer;
}

interface Rig {
  ctx: FakeAudioContext;
  mixer: ReturnType<typeof createMixer>;
  logs: string[];
  fetched: string[];
}

function rig(options: Partial<MixerDeps> & { files?: CueId[] | null } = {}): Rig {
  const ctx = new FakeAudioContext();
  const logs: string[] = [];
  const fetched: string[] = [];
  const files = options.files === undefined ? [...CUE_IDS] : options.files;
  let r = 0;
  const mixer = createMixer({
    ctx,
    base: BASE,
    format: 'ogg',
    volumes: { music: 0.7, sfx: 0.5 },
    random: () => {
      r = (r + 0.37) % 1;
      return r;
    },
    log: (m) => logs.push(m),
    fetchBytes: async (url) => {
      fetched.push(url);
      if (url === `${BASE}${MANIFEST_PATH}`) {
        if (files === null) throw new Error('HTTP 404');
        return manifestJson(files);
      }
      const id = CUE_IDS.find((c) => url === `${BASE}audio/${c}.ogg`);
      if (!id) throw new Error('HTTP 404');
      return audioBytes(DURATIONS[id]);
    },
    ...options,
  });
  return { ctx, mixer, logs, fetched };
}

/** The SFX cues, which stay decoded once loaded. */
const SFX_BUFFERS = CUE_IDS.filter((id) => !id.startsWith('score')).length;

const starry: Ambience = ambienceFor('starry-night', { heightAt: () => -5 }) as Ambience;

/** The voice gain node a source feeds. */
const voiceGain = (s: FakeSource): FakeGain => s.outputs[0] as FakeGain;
const sourcesOf = (ctx: FakeAudioContext, duration: number): FakeSource[] =>
  ctx.live().filter((s) => s.buffer?.duration === duration);

describe('gain routing', () => {
  test('music reaches the music bus, sfx the sfx bus, both the master and the destination', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setScore('score-gallery');
    mixer.setAmbience(starry);
    mixer.playWhoosh();
    await settle();
    const [score] = sourcesOf(ctx, DURATIONS['score-gallery']);
    const music = chain(score);
    expect(music.map((n) => n.kind)).toEqual([
      'source',
      'gain',
      'gain',
      'gain',
      'gain',
      'compressor',
      'destination',
    ]);
    const [whoosh] = sourcesOf(ctx, DURATIONS['portal-whoosh']);
    const sfx = chain(whoosh);
    expect(sfx.map((n) => n.kind)).toEqual([
      'source',
      'gain',
      'gain',
      'gain',
      'gain',
      'compressor',
      'destination',
    ]);
    const [cricket] = sourcesOf(ctx, DURATIONS.crickets);
    const bed = chain(cricket);
    expect(bed.map((n) => n.kind)).toEqual([
      'source',
      'gain',
      'panner',
      'gain',
      'gain',
      'gain',
      'compressor',
      'destination',
    ]);
    const musicBus = music[2] as FakeGain;
    const sfxBus = sfx[2] as FakeGain;
    expect(musicBus).not.toBe(sfxBus);
    expect(bed[3]).toBe(sfxBus);
    // One master for both buses.
    expect(music[3]).toBe(sfx[3]);
    expect(musicBus.gain.value).toBeCloseTo(0.7, 6);
    expect(sfxBus.gain.value).toBeCloseTo(0.5, 6);
  });

  test('the beds carry their runtime trims, and a limiter sits before the destination', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setAmbience(starry);
    await settle();
    expect(WIND_HILL_GAIN).toBeCloseTo(10 ** (4 / 20), 9);
    expect(CRICKETS_GAIN).toBeCloseTo(0.6 * 10 ** (10 / 20), 9);
    expect(CUE_SPATIAL['wind-hill']?.gain).toBe(WIND_HILL_GAIN);
    expect(CUE_SPATIAL.crickets?.gain).toBe(CRICKETS_GAIN);
    // The panner distance model is unchanged.
    expect(CUE_SPATIAL.crickets).toMatchObject({
      refDistance: 3,
      rolloffFactor: 1.2,
      maxDistance: 120,
    });
    const [wind] = sourcesOf(ctx, DURATIONS['wind-hill']);
    const crickets = sourcesOf(ctx, DURATIONS.crickets);
    expect(crickets).toHaveLength(5);
    await Promise.resolve();
    ctx.advance(3);
    expect(voiceGain(wind).gain.value).toBeCloseTo(WIND_HILL_GAIN, 6);
    for (const c of crickets) expect(voiceGain(c).gain.value).toBeCloseTo(CRICKETS_GAIN, 6);
    const limiter = chain(wind).find((n) => n.kind === 'compressor') as FakeCompressor;
    expect(limiter.threshold.value).toBe(LIMITER.threshold);
    expect(limiter.ratio.value).toBe(LIMITER.ratio);
    // The compressor's automatic makeup gain is (1 / curve(1.0)) ^ 0.6 = +1.71 dB at -3 dB, ratio
    // 20, and the trim in front of it cancels it.
    const fullRangeGain = 10 ** ((-3 + 3 / 20) / 20);
    const makeup = (1 / fullRangeGain) ** 0.6;
    expect(LIMITER_MAKEUP_DB).toBeCloseTo(1.71, 2);
    expect(LIMITER_TRIM).toBeCloseTo(1 / makeup, 9);
    expect(LIMITER_TRIM * makeup).toBeCloseTo(1, 12);
    const trim = chain(wind)
      .filter((n) => n.kind === 'gain')
      .at(-1) as FakeGain;
    expect(trim.gain.value).toBeCloseTo(LIMITER_TRIM, 12);
  });

  test('every positional cue has its own HRTF panner, at its anchor', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setAmbience(starry);
    mixer.rustle([1, -4.5, -2]);
    ctx.advance(starry.bell ? BELL_FIRST_S.max : 0);
    mixer.frame();
    const panners = ctx.nodes.filter((n): n is FakePanner => n instanceof FakePanner);
    // Wind, five crickets, the rustle and the bell.
    expect(panners).toHaveLength(starry.beds.length + 2);
    for (const p of panners) expect(p.panningModel).toBe('HRTF');
    expect(new Set(panners).size).toBe(panners.length);
    const positions = panners.map((p) => p.position);
    for (const bed of starry.beds) expect(positions).toContainEqual([...bed.position]);
    expect(positions).toContainEqual([1, -4.5, -2]);
    expect(positions).toContainEqual([...bellPosition()]);
  });

  test('a volume change ramps its bus to the new level and leaves the other bus', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setScore('score-night');
    mixer.playWhoosh();
    await settle();
    const musicBus = chain(sourcesOf(ctx, DURATIONS['score-night'])[0])[2] as FakeGain;
    const sfxBus = chain(sourcesOf(ctx, DURATIONS['portal-whoosh'])[0])[2] as FakeGain;
    mixer.setVolumes(0.2, 0.5);
    ctx.advance(0.5);
    expect(musicBus.gain.value).toBeCloseTo(0.2, 3);
    expect(sfxBus.gain.value).toBeCloseTo(0.5, 6);
    mixer.setVolumes(0.2, 0);
    ctx.advance(0.5);
    expect(sfxBus.gain.value).toBeCloseTo(0, 3);
    expect(mixer.diag().buses).toEqual({ music: 0.2, sfx: 0 });
  });
});

describe('mute', () => {
  test('mute zeroes the master and keeps both bus volumes; unmute restores it', async () => {
    const { ctx, mixer } = rig({ muted: true });
    await mixer.load();
    mixer.setScore('score-gallery');
    await settle();
    const nodes = chain(sourcesOf(ctx, DURATIONS['score-gallery'])[0]);
    const musicBus = nodes[2] as FakeGain;
    const master = nodes[3] as FakeGain;
    expect(master.gain.value).toBe(0);
    expect(mixer.diag().muted).toBe(true);
    mixer.setMuted(false);
    ctx.advance(0.5);
    expect(master.gain.value).toBeCloseTo(1, 3);
    mixer.setMuted(true);
    ctx.advance(0.5);
    expect(master.gain.value).toBeCloseTo(0, 3);
    expect(musicBus.gain.value).toBeCloseTo(0.7, 6);
    expect(mixer.diag().buses).toEqual({ music: 0.7, sfx: 0.5 });
  });
});

describe('voice bound', () => {
  test('SFX voices never pass MAX_SFX_VOICES; extras are dropped and slots free on end', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setAmbience(starry);
    const beds = starry.beds.length;
    expect(mixer.diag().voices.sfx).toBe(beds);
    for (let i = 0; i < 20; i++) mixer.playWhoosh();
    expect(mixer.diag().voices.sfx).toBe(MAX_SFX_VOICES);
    expect(ctx.live()).toHaveLength(MAX_SFX_VOICES);
    expect(mixer.diag().voices.dropped).toBe(20 - (MAX_SFX_VOICES - beds));
    // The whooshes end; their slots free and a new one plays.
    ctx.advance(DURATIONS['portal-whoosh'] + 0.1);
    expect(mixer.diag().voices.sfx).toBe(beds);
    mixer.playWhoosh();
    expect(mixer.diag().voices.sfx).toBe(beds + 1);
  });

  test('score voices never pass MAX_MUSIC_VOICES, even when retargeted every frame', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    for (let i = 0; i < 8; i++) {
      mixer.setScore(i % 2 ? 'score-night' : 'score-gallery');
      await settle();
      ctx.advance(0.05);
      expect(mixer.diag().voices.music).toBeLessThanOrEqual(MAX_MUSIC_VOICES);
    }
  });
});

describe('rustle rate limit', () => {
  test(`at most one rustle per ${RUSTLE_MIN_INTERVAL_S} s and ${RUSTLE_MAX_VOICES} at once`, async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    const at: [number, number, number] = [0, 0.3, -1];
    expect(mixer.rustle(at)).toBe(true);
    ctx.advance(0.1);
    expect(mixer.rustle(at)).toBe(false);
    ctx.advance(RUSTLE_MIN_INTERVAL_S);
    expect(mixer.rustle(at)).toBe(true);
    // Past the interval, but both rustle voices (2 s each) still play.
    ctx.advance(RUSTLE_MIN_INTERVAL_S + 0.01);
    expect(mixer.rustle(at)).toBe(false);
    expect(mixer.diag().rustle).toEqual({ played: 2, limited: 2 });
    ctx.advance(DURATIONS['stroke-rustle']);
    expect(mixer.rustle(at)).toBe(true);
    expect(mixer.diag().rustle.played).toBe(3);
  });

  test('no rustle without its buffer, and it is not counted as limited', async () => {
    const { mixer } = rig({ files: ['score-gallery'] });
    await mixer.load();
    expect(mixer.rustle([0, 0, 0])).toBe(false);
    expect(mixer.diag().rustle).toEqual({ played: 0, limited: 0 });
  });
});

describe('score crossfade', () => {
  test('the first score fades in; a world change crossfades at equal power and drops the old PCM', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setScore('score-gallery');
    await settle();
    const [gallery] = sourcesOf(ctx, DURATIONS['score-gallery']);
    const g = voiceGain(gallery).gain;
    expect(gallery.loop).toBe(true);
    expect(g.value).toBe(0);
    ctx.advance(SCORE_FADE_IN_S);
    expect(g.value).toBeCloseTo(1, 6);
    ctx.advance(10);
    expect(mixer.diag().buffers).toBe(SFX_BUFFERS + 1);

    const t0 = ctx.currentTime;
    mixer.setScore('score-night');
    await settle();
    const [night] = sourcesOf(ctx, DURATIONS['score-night']);
    const n = voiceGain(night).gain;
    expect(mixer.diag().score).toEqual({
      target: 'score-night',
      playing: 'score-night',
      crossfading: true,
    });
    // Equal power: the summed power stays at 1 (within the 16-segment ramp's error).
    for (let i = 0; i <= 12; i++) {
      const t = t0 + (SCORE_CROSSFADE_S * i) / 12;
      expect(g.valueAt(t) ** 2 + n.valueAt(t) ** 2).toBeCloseTo(1, 1);
    }
    expect(g.valueAt(t0 + SCORE_CROSSFADE_S / 2)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(n.valueAt(t0 + SCORE_CROSSFADE_S / 2)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(gallery.stopAt).toBeCloseTo(t0 + SCORE_CROSSFADE_S, 6);
    ctx.advance(SCORE_CROSSFADE_S);
    expect(gallery.ended).toBe(true);
    expect(n.value).toBeCloseTo(1, 6);
    expect(mixer.diag().voices.music).toBe(1);
    expect(mixer.diag().score.crossfading).toBe(false);
    // Only the playing score stays decoded.
    expect(mixer.diag().buffers).toBe(SFX_BUFFERS + 1);
  });

  test('repeating the target does nothing; a reversal mid-fade fades back from where it was', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setScore('score-gallery');
    await settle();
    ctx.advance(SCORE_FADE_IN_S + 1);
    mixer.setScore('score-night');
    await settle();
    const before = ctx.live().length;
    mixer.setScore('score-night');
    await settle();
    expect(ctx.live()).toHaveLength(before);
    ctx.advance(SCORE_CROSSFADE_S / 3);
    const [night] = sourcesOf(ctx, DURATIONS['score-night']);
    const level = voiceGain(night).gain.value;
    expect(level).toBeGreaterThan(0.2);
    expect(level).toBeLessThan(0.9);
    // A failed build falls back to the gallery: the night voice fades from its level, no jump.
    mixer.setScore('score-gallery');
    expect(voiceGain(night).gain.value).toBeCloseTo(level, 6);
    await settle();
    ctx.advance(SCORE_CROSSFADE_S);
    expect(night.ended).toBe(true);
    const playing = sourcesOf(ctx, DURATIONS['score-gallery']);
    expect(playing).toHaveLength(1);
    expect(voiceGain(playing[0]).gain.value).toBeCloseTo(1, 6);
  });

  test('a reversal mid-fade restarts the old score in phase with its fading voice', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setScore('score-gallery');
    await settle();
    ctx.advance(37);
    const [first] = sourcesOf(ctx, DURATIONS['score-gallery']);
    mixer.setScore('score-night');
    await settle();
    ctx.advance(SCORE_CROSSFADE_S / 2);
    mixer.setScore('score-gallery');
    await settle();
    const restarted = sourcesOf(ctx, DURATIONS['score-gallery']).find((s) => s !== first);
    if (restarted?.startedAt == null) throw new Error('no restarted gallery voice');
    // Where the fading voice is in its loop at the restart.
    const phase =
      (restarted.startedAt - (first.startedAt ?? 0) + first.offset) % DURATIONS['score-gallery'];
    expect(restarted.offset).toBeCloseTo(phase, 6);
    expect(restarted.offset).toBeGreaterThan(37);
  });

  test('a slow decode holds the old score at full, then both fades start together', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setScore('score-gallery');
    await settle();
    ctx.advance(SCORE_FADE_IN_S + 5);
    const [gallery] = sourcesOf(ctx, DURATIONS['score-gallery']);
    const g = voiceGain(gallery).gain;
    ctx.decodeDelayS = 1;
    const t0 = ctx.currentTime;
    mixer.setScore('score-night');
    expect(g.value).toBe(1);
    await settle();
    const t1 = ctx.currentTime;
    expect(t1).toBeCloseTo(t0 + 1, 6);
    const [night] = sourcesOf(ctx, DURATIONS['score-night']);
    const n = voiceGain(night).gain;
    expect(night.startedAt).toBeCloseTo(t1, 6);
    expect(g.valueAt(t0 + 0.9)).toBe(1);
    for (let i = 0; i <= 12; i++) {
      const t = t1 + (SCORE_CROSSFADE_S * i) / 12;
      expect(g.valueAt(t) ** 2 + n.valueAt(t) ** 2).toBeCloseTo(1, 1);
    }
    expect(gallery.stopAt).toBeCloseTo(t1 + SCORE_CROSSFADE_S, 6);
  });

  test('a reversal before the target decodes keeps the old score at full and starts nothing', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setScore('score-gallery');
    await settle();
    ctx.advance(SCORE_FADE_IN_S + 5);
    const [gallery] = sourcesOf(ctx, DURATIONS['score-gallery']);
    ctx.decodeDelayS = 1;
    mixer.setScore('score-night');
    mixer.setScore('score-gallery');
    await settle();
    expect(sourcesOf(ctx, DURATIONS['score-night'])).toHaveLength(0);
    expect(ctx.live().filter((s) => s.loop && s.buffer?.duration !== undefined)).toHaveLength(1);
    expect(voiceGain(gallery).gain.value).toBe(1);
    expect(gallery.stopAt).toBeNull();
    expect(mixer.diag().score).toEqual({
      target: 'score-gallery',
      playing: 'score-gallery',
      crossfading: false,
    });
    // The night PCM decoded for nothing is dropped.
    expect(mixer.diag().buffers).toBe(SFX_BUFFERS + 1);
  });

  test('a target with no file fades the old score out', async () => {
    const { ctx, mixer } = rig({ files: ['score-gallery'] });
    await mixer.load();
    mixer.setScore('score-gallery');
    await settle();
    ctx.advance(SCORE_FADE_IN_S);
    mixer.setScore('score-night');
    await settle();
    ctx.advance(SCORE_CROSSFADE_S);
    expect(ctx.live()).toHaveLength(0);
  });

  test('null fades the music out', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setScore('score-gallery');
    await settle();
    mixer.setScore(null);
    ctx.advance(SCORE_CROSSFADE_S);
    expect(ctx.live()).toHaveLength(0);
    expect(mixer.diag().buffers).toBe(SFX_BUFFERS);
  });

  test('a target set before its file arrives starts once it loads', async () => {
    const { ctx, mixer } = rig();
    mixer.setScore('score-night');
    await mixer.load();
    await settle();
    expect(sourcesOf(ctx, DURATIONS['score-night'])).toHaveLength(1);
  });
});

describe('ambience', () => {
  test('beds loop at random offsets, fade in, and fade out on a world change', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setAmbience(starry);
    const crickets = sourcesOf(ctx, DURATIONS.crickets);
    expect(crickets).toHaveLength(5);
    for (const c of crickets) expect(c.loop).toBe(true);
    expect(new Set(crickets.map((c) => c.offset)).size).toBe(5);
    mixer.setAmbience(null);
    ctx.advance(1.01);
    expect(ctx.live()).toHaveLength(0);
  });

  test('the bell rings from the steeple, first within BELL_FIRST_S, then every 60-120 s', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setAmbience(starry);
    const first = mixer.diag().bell.nextS as number;
    expect(first).toBeGreaterThanOrEqual(BELL_FIRST_S.min);
    expect(first).toBeLessThanOrEqual(BELL_FIRST_S.max);
    ctx.advance(first - 0.01);
    mixer.frame();
    expect(mixer.diag().bell.rung).toBe(0);
    ctx.advance(0.02);
    mixer.frame();
    expect(mixer.diag().bell.rung).toBe(1);
    const next = (mixer.diag().bell.nextS as number) - ctx.currentTime;
    expect(next).toBeGreaterThanOrEqual(BELL_INTERVAL_S.min);
    expect(next).toBeLessThanOrEqual(BELL_INTERVAL_S.max);
    mixer.setAmbience(null);
    expect(mixer.diag().bell.nextS).toBeNull();
  });
});

describe('listener and suspension', () => {
  test('the listener takes the pose through its AudioParams, or setPosition and setOrientation', async () => {
    const { ctx, mixer } = rig();
    mixer.setListener({ position: [1, 2, 3], forward: [0, 0, -1], up: [0, 1, 0] });
    expect(ctx.listener.positionX.value).toBe(1);
    expect(ctx.listener.positionZ.value).toBe(3);
    expect(ctx.listener.forwardZ.value).toBe(-1);

    const old = new FakeAudioContext();
    const calls: number[][] = [];
    const legacy = {
      setPosition: (...p: number[]) => calls.push(p),
      setOrientation: (...o: number[]) => calls.push(o),
    };
    Object.defineProperty(old, 'listener', { value: legacy });
    const m = createMixer({
      ctx: old,
      base: BASE,
      format: 'mp3',
      volumes: { music: 1, sfx: 1 },
      fetchBytes: () => Promise.reject(new Error('none')),
      log: () => {},
    });
    m.setListener({ position: [4, 5, 6], forward: [1, 0, 0], up: [0, 1, 0] });
    expect(calls).toEqual([
      [4, 5, 6],
      [1, 0, 0, 0, 1, 0],
    ]);
  });

  test('setSuspended suspends and resumes the context', async () => {
    const { ctx, mixer } = rig();
    mixer.setSuspended(true);
    await settle();
    expect(ctx.state).toBe('suspended');
    mixer.setSuspended(false);
    await settle();
    expect(ctx.state).toBe('running');
  });

  test('a show before the suspend settles still ends running', async () => {
    const { ctx, mixer } = rig();
    let release = (): void => {};
    ctx.stateGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mixer.setSuspended(true);
    await settle();
    // The suspend is in flight, the state still reads running.
    expect(ctx.state).toBe('running');
    mixer.setSuspended(false);
    release();
    await settle();
    expect(ctx.state).toBe('running');
    // And the other way round: a hide before the resume settles ends suspended.
    ctx.state = 'suspended';
    ctx.stateGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mixer.setSuspended(false);
    await settle();
    mixer.setSuspended(true);
    release();
    await settle();
    expect(ctx.state).toBe('suspended');
  });
});

describe('missing audio', () => {
  test('no manifest: logs once, every cue missing, every call silent', async () => {
    const { ctx, mixer, logs, fetched } = rig({ files: null });
    await mixer.load();
    expect(fetched).toEqual([`${BASE}${MANIFEST_PATH}`]);
    expect(logs).toHaveLength(1);
    const d = mixer.diag();
    expect(d.manifest).toBe('missing');
    expect(Object.values(d.cues).every((s) => s === 'missing')).toBe(true);
    mixer.setScore('score-gallery');
    mixer.setAmbience(starry);
    mixer.playWhoosh();
    expect(mixer.rustle([0, 0, 0])).toBe(false);
    ctx.advance(200);
    mixer.frame();
    await settle();
    expect(ctx.live()).toHaveLength(0);
  });

  test('a manifest whose files are missing leaves those cues silent', async () => {
    const { ctx, mixer, logs } = rig({
      fetchBytes: async (url) => {
        if (url.endsWith(MANIFEST_PATH)) return manifestJson();
        throw new Error('HTTP 404');
      },
    });
    await mixer.load();
    expect(mixer.diag().manifest).toBe('loaded');
    expect(mixer.diag().cues['score-gallery']).toBe('missing');
    expect(logs).toHaveLength(CUE_IDS.length);
    mixer.setScore('score-gallery');
    await settle();
    expect(ctx.live()).toHaveLength(0);
  });
});

describe('dispose', () => {
  test('a dispose while buffers decode holds none of them once the decodes finish', async () => {
    const { ctx, mixer } = rig();
    let release = (): void => {};
    ctx.decodeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loading = mixer.load();
    await settle();
    expect(ctx.decodes).toBe(SFX_BUFFERS);
    mixer.dispose();
    release();
    await loading;
    await settle();
    expect(mixer.diag().buffers).toBe(0);
  });

  test('stops every voice, disconnects every node, drops every buffer and closes', async () => {
    const { ctx, mixer } = rig();
    await mixer.load();
    mixer.setScore('score-gallery');
    mixer.setAmbience(starry);
    await settle();
    ctx.advance(2);
    mixer.setScore('score-night');
    mixer.playWhoosh();
    mixer.rustle([0, 0, -1]);
    await settle();
    expect(ctx.live().length).toBeGreaterThan(8);
    expect(mixer.diag().buffers).toBeGreaterThan(0);
    mixer.dispose();
    await settle();
    const created = ctx.nodes.filter((n: FakeNode) => n !== ctx.destination);
    for (const node of created) {
      expect(node.disconnects, node.kind).toBeGreaterThan(0);
      expect(node.outputs, node.kind).toEqual([]);
    }
    for (const s of ctx.sources()) expect(s.stopAt).not.toBeNull();
    expect(mixer.diag().buffers).toBe(0);
    expect(mixer.diag().voices).toMatchObject({ music: 0, sfx: 0 });
    expect(ctx.state).toBe('closed');
    // Nothing plays after dispose.
    const count = ctx.nodes.length;
    mixer.setScore('score-gallery');
    mixer.playWhoosh();
    mixer.setAmbience(starry);
    await settle();
    expect(ctx.nodes).toHaveLength(count);
  });
});
