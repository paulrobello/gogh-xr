/**
 * FFmpeg plumbing for the audio pipeline (P6.4): version pin, decode, loudness and encode.
 *
 * Every call runs with `-nostdin` and stdin ignored, so nothing ever waits on a terminal.
 */
import { spawnSync } from 'node:child_process';

/** The toolchain the committed runtime files were built with. master.ts refuses any other. */
export const FFMPEG_PIN = {
  version: '9.0.2',
  libavcodec: '63.  1.102',
  /** Recorded from Homebrew (`brew list --versions opus lame`), not machine-checked. */
  libopus: '1.6.1',
  lame: '4.0',
} as const;

export const SAMPLE_RATE = 48_000;
const MAX_BUFFER = 1024 * 1024 * 1024;

export interface RunResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

export function run(cmd: string, args: readonly string[]): RunResult {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER });
  if (result.error) throw new Error(`${cmd}: ${result.error.message}`);
  return {
    status: result.status ?? 1,
    stdout: result.stdout as Buffer,
    stderr: (result.stderr as Buffer).toString('utf8'),
  };
}

export function ffmpeg(args: readonly string[]): RunResult {
  const result = run('ffmpeg', ['-nostdin', '-hide_banner', ...args]);
  if (result.status !== 0) {
    throw new Error(`ffmpeg ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result;
}

export interface FfmpegVersion {
  found: boolean;
  version: string | null;
  libavcodec: string | null;
  pinned: boolean;
}

/** Reads `ffmpeg -version`. `found` is false when ffmpeg is not on PATH. */
export function ffmpegVersion(): FfmpegVersion {
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (probe.error || probe.status !== 0) {
    return { found: false, version: null, libavcodec: null, pinned: false };
  }
  const text = (probe.stdout as Buffer).toString('utf8');
  // Test-only: pretend to be another build, to exercise the degraded non-pin path
  // (CLAUDE.md, Audio). Never set it for `make audio`, which then refuses to run.
  const simulated = process.env.AUDIO_FFMPEG_SIMULATE_VERSION;
  const version = simulated || (/^ffmpeg version (\S+)/m.exec(text)?.[1] ?? null);
  const libavcodec = /^libavcodec\s+(\d+\.\s*\d+\.\s*\d+)/m.exec(text)?.[1] ?? null;
  const pinned = version === FFMPEG_PIN.version && libavcodec === FFMPEG_PIN.libavcodec;
  return { found: true, version, libavcodec, pinned };
}

/** `63.  1.102` (ffmpeg's padded form, used for the pin comparison) as `63.1.102`. */
export function displayVersion(libavcodec: string | null): string {
  return (libavcodec ?? 'unknown').replace(/\s+/g, '');
}

export interface Pcm {
  sampleRate: number;
  /** One Float32Array per channel. */
  channels: Float32Array[];
  frames: number;
}

export interface StreamInfo {
  codec: string;
  sampleRate: number;
  channels: number;
}

export function probeStream(path: string): StreamInfo {
  const result = run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name,sample_rate,channels',
    '-of',
    'json',
    path,
  ]);
  if (result.status !== 0) throw new Error(`ffprobe ${path}: ${result.stderr.trim()}`);
  const stream = (
    JSON.parse(result.stdout.toString('utf8')) as {
      streams: { codec_name: string; sample_rate: string; channels: number }[];
    }
  ).streams[0];
  if (!stream) throw new Error(`ffprobe ${path}: no audio stream`);
  return {
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels,
  };
}

/**
 * Decodes the whole file to float PCM at its own channel count, resampled to 48 kHz only
 * when it is not already 48 kHz. The decoder's own gapless trimming (Opus pre-skip, the
 * MP3 LAME/Lavc delay and padding) applies, so the frame count is what a player sees.
 */
export function decode(path: string): Pcm {
  const info = probeStream(path);
  const args = ['-v', 'error', '-i', path, '-map', '0:a:0'];
  if (info.sampleRate !== SAMPLE_RATE) args.push('-ar', String(SAMPLE_RATE));
  args.push('-f', 'f32le', '-acodec', 'pcm_f32le', '-');
  const { stdout } = ffmpeg(args);
  const interleaved = new Float32Array(
    stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength),
  );
  const count = info.channels;
  const frames = Math.floor(interleaved.length / count);
  const channels = Array.from({ length: count }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++)
      (channels[c] as Float32Array)[i] = interleaved[i * count + c] as number;
  }
  return { sampleRate: SAMPLE_RATE, channels, frames };
}

export interface Loudness {
  /** Integrated loudness, LUFS (EBU R128 / BS.1770). */
  integrated: number;
  /** True peak over all channels, dBTP (ebur128's 4x oversampled peak). */
  truePeak: number;
}

/**
 * EBU R128 integrated loudness and true peak from ffmpeg's ebur128 filter, read from its
 * per-frame metadata at full precision (the printed summary rounds to 0.1). Half a second
 * of padding flushes the last partial 100 ms frame into the metadata. Silence sits under
 * the -70 LUFS absolute gate and adds no peak, so it changes neither value.
 * `chain` is an optional filter run before the meter.
 */
export const METER_CHAIN =
  'apad=pad_dur=0.5,ebur128=peak=true:metadata=1,ametadata=mode=print:file=-';

export function loudness(path: string, chain?: string): Loudness {
  const filters = chain ? `${chain},${METER_CHAIN}` : METER_CHAIN;
  const { stdout } = ffmpeg([
    '-v',
    'error',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-af',
    filters,
    '-f',
    'null',
    '-',
  ]);
  const text = stdout.toString('utf8');
  const integrated = lastMatch(text, /^lavfi\.r128\.I=(-?[\d.]+|-?inf)$/gm);
  const peak = lastMatch(text, /^lavfi\.r128\.true_peak=(-?[\d.]+)$/gm);
  if (integrated === null || peak === null) throw new Error(`${path}: no ebur128 metadata`);
  return {
    integrated: integrated,
    truePeak: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
  };
}

function lastMatch(text: string, pattern: RegExp): number | null {
  let value: string | null = null;
  for (const match of text.matchAll(pattern)) value = match[1] as string;
  if (value === null) return null;
  return value.endsWith('inf') ? (value.startsWith('-') ? -Infinity : Infinity) : Number(value);
}
