/**
 * Mastering steps for P6.4. Every sample operation runs inside the pinned ffmpeg, so the
 * outputs depend only on the source bytes, the contract values and the ffmpeg build.
 *
 * Per cue:
 * 1. Stage: decode, resample to 48 kHz, fold to mono (SFX, 0.5L + 0.5R), trim, then either
 *    the loop wrap or a one-shot fade-out, into a float WAV.
 * 2. Gain: optional limiter, then one linear gain that meets the loudness target, cut back
 *    when the true peak would pass the master ceiling (the skill's post-normalisation trim).
 * 3. Encode: Opus in Ogg (`+bitexact`, fixed serial) and MP3 with its normal Lavc gapless header.
 *
 * Loop wrap (the Suno guide's tail-to-head rule): with the trimmed body b[0, M) and a
 * crossfade of F frames, the loop is b[F, M-F) followed by b[M-F, M) fading out under
 * b[0, F) fading in. Its last frame is the head at full gain, b[F-1], so the wrap lands on
 * b[F], the frame that follows it. The consumed intro is never replayed.
 */

import type { CueSpec } from './contract.ts';
import { loudness, SAMPLE_RATE } from './ffmpeg.ts';

const MONO_FOLD = 'pan=mono|c0=0.5*c0+0.5*c1';

export function frames(seconds: number): number {
  return Math.round(seconds * SAMPLE_RATE);
}

/** The stage-1 filtergraph for a cue. `sourceFrames` is the source length at 48 kHz. */
export function stageGraph(spec: CueSpec, sourceFrames: number): string {
  const start = frames(spec.trim.start);
  const end = spec.trim.end === null ? sourceFrames : frames(spec.trim.end);
  const prep = [
    `aresample=${SAMPLE_RATE}`,
    'aformat=sample_fmts=flt',
    ...(spec.channels === 1 ? [MONO_FOLD] : []),
    `atrim=start_sample=${start}:end_sample=${end}`,
    'asetpts=N/SR/TB',
  ].join(',');
  if (spec.loop) {
    const fade = frames(spec.crossfade ?? 0);
    if (fade <= 0) throw new Error(`${spec.id}: a loop needs a crossfade`);
    if (fade * 2 >= end - start)
      throw new Error(`${spec.id}: crossfade does not fit the trimmed body`);
    return [
      `[0:a]${prep},asplit=2[body][head]`,
      `[body]atrim=start_sample=${fade},asetpts=N/SR/TB[rest]`,
      `[head]atrim=end_sample=${fade},asetpts=N/SR/TB[intro]`,
      `[rest][intro]acrossfade=ns=${fade}:o=1:c1=qsin:c2=qsin[out]`,
    ].join(';');
  }
  const fadeOut = frames(spec.fadeOut ?? 0);
  const length = end - start;
  const tail =
    fadeOut > 0 ? `,afade=t=out:start_sample=${length - fadeOut}:nb_samples=${fadeOut}` : '';
  return `[0:a]${prep}${tail}[out]`;
}

export function stageArgs(
  spec: CueSpec,
  source: string,
  sourceFrames: number,
  out: string,
): string[] {
  return [
    '-y',
    '-v',
    'error',
    '-i',
    source,
    '-filter_complex',
    stageGraph(spec, sourceFrames),
    '-map',
    '[out]',
    '-map_metadata',
    '-1',
    '-fflags',
    '+bitexact',
    '-c:a',
    'pcm_f32le',
    out,
  ];
}

export function limiterChain(spec: CueSpec): string | undefined {
  if (!spec.limiter) return undefined;
  const { preGainDb, limit } = spec.limiter;
  return `volume=${preGainDb}dB,alimiter=limit=${limit}:attack=5:release=50:level=0:latency=1`;
}

export function gainArgs(stage: string, chain: string, out: string): string[] {
  return [
    '-y',
    '-v',
    'error',
    '-i',
    stage,
    '-af',
    chain,
    '-map_metadata',
    '-1',
    '-fflags',
    '+bitexact',
    '-c:a',
    'pcm_f32le',
    out,
  ];
}

export function oggArgs(spec: CueSpec, master: string, out: string): string[] {
  return [
    '-y',
    '-v',
    'error',
    '-i',
    master,
    '-map',
    '0:a',
    '-map_metadata',
    '-1',
    '-c:a',
    'libopus',
    '-b:a',
    `${spec.bitrate.ogg}k`,
    '-vbr',
    'on',
    '-compression_level',
    '10',
    '-application',
    'audio',
    '-frame_duration',
    '20',
    '-serial_offset',
    String(spec.serial),
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    out,
  ];
}

/** No `+bitexact` here: it swaps the Lavc gapless header for one Firefox ignores (Suno guide). */
export function mp3Args(spec: CueSpec, master: string, out: string): string[] {
  return [
    '-y',
    '-v',
    'error',
    '-i',
    master,
    '-map',
    '0:a',
    '-map_metadata',
    '-1',
    '-c:a',
    'libmp3lame',
    '-b:a',
    `${spec.bitrate.mp3}k`,
    '-ar',
    String(SAMPLE_RATE),
    out,
  ];
}

/** Gains are rounded to 0.01 dB so the recorded command is the command that ran. */
export function roundGain(db: number): number {
  return Math.round(db * 100) / 100;
}

export interface GainPlan {
  /** Loudness and true peak after the optional limiter, before the gain. */
  measured: { integrated: number; truePeak: number };
  gainDb: number;
  /** True when the true-peak ceiling, not the loudness target, set the gain. */
  peakLimited: boolean;
}

export function planGain(spec: CueSpec, stage: string, ceiling: number): GainPlan {
  const measured = loudness(stage, limiterChain(spec));
  const wanted = spec.loudness.target - measured.integrated;
  const allowed = ceiling - measured.truePeak;
  const peakLimited = wanted > allowed;
  return { measured, gainDb: roundGain(peakLimited ? allowed : wanted), peakLimited };
}

export function gainChain(spec: CueSpec, gainDb: number): string {
  return [limiterChain(spec), `volume=${gainDb.toFixed(2)}dB`].filter(Boolean).join(',');
}
