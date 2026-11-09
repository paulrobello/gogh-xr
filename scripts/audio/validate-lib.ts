/**
 * The P6.4 runtime audio validator. Every value is recomputed from the current files:
 * nothing the manifest or derivatives.md says about loudness, peaks or loops is trusted.
 * The manifest supplies only expectations (file names, hashes, frame counts), each checked.
 *
 * Each failure carries one reason code, so a mutation fixture can assert it was rejected
 * for its own reason and not for some other check.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Of } from '../asset-lib.ts';
import type { CueSpec, Limits } from './contract.ts';
import { decode, loudness, probeStream, SAMPLE_RATE } from './ffmpeg.ts';
import type { Manifest, ManifestCue } from './manifest.ts';
import { headTailBalance, interiorGaps, monoFold, wrapStep } from './metrics.ts';

export type Reason =
  | 'source-hash'
  | 'manifest'
  | 'missing'
  | 'hash'
  | 'size'
  | 'format'
  | 'frames'
  | 'duration'
  | 'loudness'
  | 'true-peak'
  | 'wrap'
  | 'head-tail'
  | 'interior-gap'
  | 'mono';

export interface Failure {
  cue: string;
  file: string;
  reason: Reason;
  message: string;
  /** The measured value, for a deviation's `upToDb` bound. */
  value?: number;
}

export interface FileMeasure {
  cue: string;
  file: string;
  format: 'ogg' | 'mp3';
  frames: number;
  integrated: number;
  truePeak: number;
  wrapRatio: number | null;
  headTailDb: number | null;
  quietWindows: number | null;
  zeroRunS: number;
  monoLossDb: number | null;
}

export interface ValidateInput {
  /** Directory holding the runtime files the manifest names. */
  dir: string;
  manifest: Manifest;
  cues: readonly CueSpec[];
  limits: Limits;
  /** Root the cue source paths are relative to. */
  root: string;
}

export interface ValidateResult {
  failures: Failure[];
  /** Pending owner deviations: never failures, always printed. */
  warnings: string[];
  measures: FileMeasure[];
  /** 0.5L + 0.5R fold loss of each stereo source that is folded to a mono cue, dB. */
  sourceFolds: { cue: string; lossDb: number }[];
}

const CODECS = { ogg: 'opus', mp3: 'mp3' } as const;

export function validate(input: ValidateInput): ValidateResult {
  const { dir, manifest, cues, limits, root } = input;
  const failures: Failure[] = [];
  const measures: FileMeasure[] = [];
  const sourceFolds: { cue: string; lossDb: number }[] = [];
  const fail = (cue: string, file: string, reason: Reason, message: string, value?: number) =>
    failures.push({ cue, file, reason, message, value });

  if (manifest.version !== 1)
    fail('*', 'manifest.json', 'manifest', `unknown manifest version ${manifest.version}`);
  if (manifest.sampleRate !== SAMPLE_RATE) {
    fail(
      '*',
      'manifest.json',
      'manifest',
      `sampleRate ${manifest.sampleRate}, expected ${SAMPLE_RATE}`,
    );
  }
  const listed = new Map(manifest.cues.map((cue) => [cue.id, cue]));
  if (listed.size !== manifest.cues.length)
    fail('*', 'manifest.json', 'manifest', 'duplicate cue ids');
  for (const id of listed.keys()) {
    if (!cues.some((spec) => spec.id === id))
      fail(id, 'manifest.json', 'manifest', 'cue is not in the contract');
  }

  for (const spec of cues) {
    const sourcePath = join(root, spec.source.path);
    if (!existsSync(sourcePath)) {
      fail(spec.id, spec.source.path, 'source-hash', 'source file is missing');
    } else {
      const actual = sha256Of(readFileSync(sourcePath));
      if (actual !== spec.source.sha256) {
        fail(
          spec.id,
          spec.source.path,
          'source-hash',
          `source changed: ${actual}, archived ${spec.source.sha256}`,
        );
      }
    }
    if (existsSync(sourcePath) && spec.channels === 1) {
      const loss = sourceFoldLoss(sourcePath);
      if (loss !== null) {
        sourceFolds.push({ cue: spec.id, lossDb: loss });
        if (!(loss < limits.monoMaxLossDb)) {
          fail(
            spec.id,
            spec.source.path,
            'mono',
            `the 0.5L + 0.5R fold of the stereo source loses ${loss.toFixed(2)} dB against the channel mean, limit ${limits.monoMaxLossDb} dB`,
            loss,
          );
        }
      }
    }
    const cue = listed.get(spec.id);
    if (!cue) {
      fail(spec.id, 'manifest.json', 'manifest', 'cue is missing from the manifest');
      continue;
    }
    checkManifestCue(spec, cue, manifest.sampleRate, (reason, message) =>
      fail(spec.id, 'manifest.json', reason, message),
    );
    for (const format of ['ogg', 'mp3'] as const) {
      const name = cue.files[format];
      const measure = checkFile(spec, cue, format, join(dir, name), limits, (reason, message) =>
        fail(spec.id, name, reason, message),
      );
      if (measure) measures.push({ ...measure, cue: spec.id, file: name });
    }
  }
  const { kept, warnings } = applyDeviations(cues, failures);
  return { failures: kept, warnings, measures, sourceFolds };
}

/** Fold loss of a stereo source, or null for a mono source (nothing to fold). */
export function sourceFoldLoss(path: string): number | null {
  const pcm = decode(path);
  return pcm.channels.length < 2 ? null : monoFold(pcm).lossDb;
}

/**
 * Moves failures a pending owner deviation covers into warnings, and adds one warning per
 * pending deviation, so every run names what still waits on the owner.
 */
export function applyDeviations(
  cues: readonly CueSpec[],
  failures: readonly Failure[],
): { kept: Failure[]; warnings: string[] } {
  const warnings: string[] = [];
  const kept: Failure[] = [];
  for (const spec of cues) {
    for (const d of spec.deviations ?? []) {
      warnings.push(`[deviation ${d.kind}, ${d.status}] ${spec.id}: ${d.reason}`);
    }
  }
  for (const f of failures) {
    const spec = cues.find((c) => c.id === f.cue);
    const waiver = spec?.deviations?.find(
      (d) =>
        d.status === 'pending-owner' &&
        d.kind === 'source-fold' &&
        f.reason === 'mono' &&
        f.file === spec.source.path &&
        f.value !== undefined &&
        f.value <= (d.upToDb ?? 0),
    );
    if (waiver)
      warnings.push(`[deviation ${waiver.kind}, waived] ${f.cue} ${f.file}: ${f.message}`);
    else kept.push(f);
  }
  return { kept, warnings };
}

/** Files in the runtime directory that the manifest does not name. */
export function strayFiles(dir: string, manifest: Manifest): Failure[] {
  const named = new Set([
    'manifest.json',
    ...manifest.cues.flatMap((c) => [c.files.ogg, c.files.mp3]),
  ]);
  return readdirSync(dir)
    .filter((name) => !named.has(name) && name !== '.DS_Store')
    .map((name) => ({
      cue: '*',
      file: name,
      reason: 'manifest' as const,
      message: 'file in public/audio/ is not named by the manifest, so it would ship unvalidated',
    }));
}

/** Structural guard, so a malformed manifest fails as [manifest] instead of throwing. */
export function manifestShapeErrors(value: unknown): string[] {
  const errors: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  if (!isObj(value)) return ['manifest is not an object'];
  if (typeof value.version !== 'number') errors.push('version is not a number');
  if (typeof value.sampleRate !== 'number') errors.push('sampleRate is not a number');
  if (!Array.isArray(value.cues)) return [...errors, 'cues is not an array'];
  value.cues.forEach((cue: unknown, i: number) => {
    if (!isObj(cue)) {
      errors.push(`cues[${i}] is not an object`);
      return;
    }
    for (const key of ['id', 'kind'] as const) {
      if (typeof cue[key] !== 'string') errors.push(`cues[${i}].${key} is not a string`);
    }
    for (const key of ['duration', 'frames', 'channels'] as const) {
      if (typeof cue[key] !== 'number') errors.push(`cues[${i}].${key} is not a number`);
    }
    if (typeof cue.loop !== 'boolean') errors.push(`cues[${i}].loop is not a boolean`);
    const loud = cue.loudness;
    if (!isObj(loud) || typeof loud.target !== 'number' || typeof loud.tolerance !== 'number') {
      errors.push(`cues[${i}].loudness is not { target, tolerance }`);
    }
    for (const [key, type] of [
      ['files', 'string'],
      ['sha256', 'string'],
      ['bytes', 'number'],
    ] as const) {
      const pair = cue[key];
      if (!isObj(pair) || typeof pair.ogg !== type || typeof pair.mp3 !== type) {
        errors.push(`cues[${i}].${key} is not { ogg, mp3 } of ${type}`);
      }
    }
  });
  return errors;
}

function checkManifestCue(
  spec: CueSpec,
  cue: ManifestCue,
  sampleRate: number,
  fail: (reason: Reason, message: string) => void,
): void {
  if (cue.loop !== spec.loop) fail('manifest', `loop is ${cue.loop}, contract says ${spec.loop}`);
  if (cue.kind !== spec.kind) fail('manifest', `kind is ${cue.kind}, contract says ${spec.kind}`);
  if (cue.channels !== spec.channels)
    fail('manifest', `channels ${cue.channels}, contract says ${spec.channels}`);
  if (
    cue.loudness.target !== spec.loudness.target ||
    cue.loudness.tolerance !== spec.loudness.tolerance
  ) {
    fail('manifest', 'loudness target differs from the contract');
  }
  if (Math.abs(cue.duration - cue.frames / sampleRate) > 1e-9)
    fail('manifest', 'duration is not frames / sampleRate');
  if (cue.files.ogg !== `${spec.id}.ogg` || cue.files.mp3 !== `${spec.id}.mp3`) {
    fail('manifest', 'file names are not <id>.ogg and <id>.mp3');
  }
  if (spec.duration) {
    const [min, max] = spec.duration;
    if (cue.duration < min || cue.duration > max) {
      fail('duration', `loop is ${cue.duration.toFixed(3)} s, budget ${min}-${max} s`);
    }
  }
}

function checkFile(
  spec: CueSpec,
  cue: ManifestCue,
  format: 'ogg' | 'mp3',
  path: string,
  limits: Limits,
  fail: (reason: Reason, message: string) => void,
): Omit<FileMeasure, 'cue' | 'file'> | null {
  if (!existsSync(path)) {
    fail('missing', 'runtime file is missing');
    return null;
  }
  const bytes = readFileSync(path);
  const hash = sha256Of(bytes);
  if (hash !== cue.sha256[format]) fail('hash', `sha256 ${hash}, manifest ${cue.sha256[format]}`);
  if (bytes.length !== cue.bytes[format])
    fail('hash', `${bytes.length} bytes, manifest ${cue.bytes[format]}`);
  if (bytes.length > spec.maxBytes) fail('size', `${bytes.length} bytes, budget ${spec.maxBytes}`);

  const info = probeStream(path);
  if (
    info.codec !== CODECS[format] ||
    info.sampleRate !== SAMPLE_RATE ||
    info.channels !== spec.channels
  ) {
    fail(
      'format',
      `${info.codec} ${info.sampleRate} Hz ${info.channels} ch, expected ${CODECS[format]} ${SAMPLE_RATE} Hz ${spec.channels} ch`,
    );
  }

  const pcm = decode(path);
  if (pcm.frames !== cue.frames)
    fail('frames', `decodes to ${pcm.frames} frames, manifest ${cue.frames}`);

  const level = loudness(path);
  const { target, tolerance } = spec.loudness;
  if (!(Math.abs(level.integrated - target) <= tolerance)) {
    fail('loudness', `${level.integrated.toFixed(2)} LUFS, target ${target} ±${tolerance}`);
  }
  if (!(level.truePeak <= limits.truePeakMax)) {
    fail('true-peak', `${level.truePeak.toFixed(2)} dBTP, ceiling ${limits.truePeakMax} dBTP`);
  }

  let wrapRatio: number | null = null;
  let headTailDb: number | null = null;
  if (spec.loop) {
    const wrap = wrapStep(pcm, {
      halfWindowS: limits.seamHalfWindowS,
      lowpassHz: limits.seamLowpassHz,
    });
    wrapRatio = wrap.ratio;
    if (!(wrap.ratio <= limits.wrapMaxRatio)) {
      fail(
        'wrap',
        `seam window (±${limits.seamHalfWindowS * 1000} ms) reads ${wrap.full.ratio.toFixed(2)}x full band and ${wrap.low.ratio.toFixed(2)}x below ${limits.seamLowpassHz} Hz against the loop's own p99.9 window, limit ${limits.wrapMaxRatio}x`,
      );
    }
    const balance = headTailBalance(pcm, limits.headTailWindowS);
    headTailDb = balance.deltaDb;
    if (!(balance.deltaDb <= limits.headTailMaxDb)) {
      fail(
        'head-tail',
        `head ${balance.headDb.toFixed(1)} dB and tail ${balance.tailDb.toFixed(1)} dB differ by ${balance.deltaDb.toFixed(1)} dB, limit ${limits.headTailMaxDb} dB`,
      );
    }
  }

  const gaps = interiorGaps(pcm, {
    windowS: limits.gapWindowS,
    belowMedianDb: limits.gapBelowMedianDb,
    zeroRunS: limits.zeroRunS,
    loop: spec.loop,
    activeFloorDb: limits.activeFloorDb,
  });
  if (gaps.quiet.length > 0) {
    const where = gaps.quiet
      .slice(0, 4)
      .map((q) => `${q.at.toFixed(1)} s at ${q.db.toFixed(1)} dB`)
      .join(', ');
    fail(
      'interior-gap',
      `${gaps.quiet.length} window(s) more than ${limits.gapBelowMedianDb} dB under the ${gaps.medianDb.toFixed(1)} dB median: ${where}`,
    );
  }
  if (gaps.longestZeroRunS >= limits.zeroRunS) {
    fail(
      'interior-gap',
      `${(gaps.longestZeroRunS * 1000).toFixed(1)} ms of digital silence at ${gaps.zeroRunAt.toFixed(3)} s`,
    );
  }

  let monoLossDb: number | null = null;
  if (pcm.channels.length > 1) {
    monoLossDb = monoFold(pcm).lossDb;
    if (!(monoLossDb < limits.monoMaxLossDb)) {
      fail(
        'mono',
        `0.5L + 0.5R fold loses ${monoLossDb.toFixed(2)} dB against the channel mean, limit ${limits.monoMaxLossDb} dB`,
      );
    }
  }

  return {
    format,
    frames: pcm.frames,
    integrated: level.integrated,
    truePeak: level.truePeak,
    wrapRatio,
    headTailDb,
    quietWindows: spec.loop ? gaps.quiet.length : null,
    zeroRunS: gaps.longestZeroRunS,
    monoLossDb,
  };
}

export function formatTable(measures: readonly FileMeasure[]): string {
  const header =
    'file                   frames     LUFS    dBTP   wrap  head/tail  gaps  zero-ms  mono-dB';
  const rows = measures.map((m) => {
    const opt = (v: number | null, d: number, w: number) =>
      (v === null ? '-' : v.toFixed(d)).padStart(w);
    return [
      m.file.padEnd(20),
      String(m.frames).padStart(9),
      m.integrated.toFixed(2).padStart(8),
      m.truePeak.toFixed(2).padStart(7),
      opt(m.wrapRatio, 2, 6),
      opt(m.headTailDb, 1, 10),
      opt(m.quietWindows, 0, 5),
      (m.zeroRunS * 1000).toFixed(1).padStart(8),
      opt(m.monoLossDb, 2, 8),
    ].join(' ');
  });
  return [header, ...rows].join('\n');
}
