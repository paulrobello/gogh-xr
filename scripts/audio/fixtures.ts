/**
 * Generated validator fixtures (P6.4): a known-good baseline and one mutation per check.
 *
 * The baseline is three short synthetic cues (a stereo music loop, a mono SFX bed and a
 * mono one-shot), normalised with the same ffmpeg meter and encoded with the same encoder
 * arguments as master.ts, then validated against the production LIMITS. The only contract
 * difference is the loop-length budget (4-20 s instead of 120-180 s), which keeps the set
 * small. Each mutation changes one property of the music cue (or, for `mono-source`, the
 * stereo source of the SFX bed) and must be rejected for exactly its own reason.
 *
 * The seam mutations (SEAM_MUTATIONS) start from a committed runtime loop instead: decode
 * public/audio/<id>.ogg, add a click near the wrap, re-encode both formats with the
 * production arguments, and validate that one cue. Both files must fail for [wrap].
 * Nothing here is committed: every file is written to a temp dir.
 */
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Of } from '../asset-lib.ts';
import { CUES, type CueSpec, LIMITS } from './contract.ts';
import { decode, ffmpeg, loudness, SAMPLE_RATE } from './ffmpeg.ts';
import { buildManifest, type ManifestInput } from './manifest.ts';
import { mp3Args, oggArgs } from './master-lib.ts';
import { type Reason, validate } from './validate-lib.ts';

/** Each synthetic mutation and the one reason it must be rejected for. */
export const MUTATIONS = {
  'source-hash': 'source-hash',
  hash: 'hash',
  frames: 'frames',
  duration: 'duration',
  loudness: 'loudness',
  'true-peak': 'true-peak',
  wrap: 'wrap',
  'head-tail': 'head-tail',
  'interior-gap': 'interior-gap',
  mono: 'mono',
  'mono-source': 'mono',
} as const satisfies Record<string, Reason>;

export type Mutation = keyof typeof MUTATIONS;

export interface SeamMutation {
  name: string;
  cue: string;
  /** Adds the click in place, to every channel. */
  apply: (ch: Float32Array) => void;
}

const lastSamples = (count: number, amount: number) => (ch: Float32Array) => {
  for (let i = 1; i <= count; i++) ch[ch.length - i] = (ch[ch.length - i] as number) + amount;
};

/** The review's seam cases that the boundary-sample check passed. Each must fail for [wrap]. */
export const SEAM_MUTATIONS: readonly SeamMutation[] = [
  { name: 'seam-click-0.15', cue: 'crickets', apply: lastSamples(3, 0.15) },
  { name: 'seam-click-0.2', cue: 'crickets', apply: lastSamples(3, 0.2) },
  { name: 'seam-click-0.3', cue: 'crickets', apply: lastSamples(3, 0.3) },
  {
    name: 'seam-impulse-5ms',
    cue: 'score-night',
    apply: (ch) => {
      const at = ch.length - Math.round(0.005 * SAMPLE_RATE);
      ch[at] = (ch[at] as number) + 0.4;
    },
  },
];

const SECONDS = 6;
const N = SECONDS * SAMPLE_RATE;
const MUSIC = CUES.find((c) => c.kind === 'music') as CueSpec;
const SFX = CUES.find((c) => c.kind === 'sfx') as CueSpec;

function fixtureSpecs(): CueSpec[] {
  const base = { trim: { start: 0, end: null }, source: { path: '', sha256: '' } };
  return [
    { ...MUSIC, ...base, id: 'fx-music', duration: [4, 20], crossfade: 1, serial: 9001 },
    { ...SFX, ...base, id: 'fx-bed', loop: true, crossfade: 1, serial: 9002 },
    { ...SFX, ...base, id: 'fx-shot', loop: false, fadeOut: 0.03, serial: 9003 },
  ];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Unit-variance noise, periodic over its length by construction (it is just a buffer). */
function noise(seed: number, length: number): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = (rand() + rand() + rand() + rand() - 2) * Math.sqrt(3);
  return out;
}

/** Every tone has a whole number of cycles in SECONDS, so the loop wraps seamlessly. */
function synth(id: string): Float32Array[] {
  const t = (i: number) => i / SAMPLE_RATE;
  if (id === 'fx-music') {
    const n = noise(1, N);
    const left = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      left[i] =
        0.2 * Math.cos(2 * Math.PI * 110 * t(i)) +
        0.1 * Math.sin(2 * Math.PI * 440 * t(i) + 0.3) +
        0.03 * (n[i] as number);
    }
    return [left, left.map((v) => 0.85 * v)];
  }
  if (id === 'fx-bed') {
    const n = noise(2, N);
    return [
      Float32Array.from(
        { length: N },
        (_, i) => 0.1 * (n[i] as number) + 0.1 * Math.sin(2 * Math.PI * 220 * t(i)),
      ),
    ];
  }
  const length = SAMPLE_RATE;
  const fade = Math.round(0.03 * SAMPLE_RATE);
  return [
    Float32Array.from({ length }, (_, i) => {
      const tail = i >= length - fade ? (length - i) / fade : 1;
      return 0.5 * Math.exp(-5 * t(i)) * Math.sin(2 * Math.PI * 660 * t(i)) * tail;
    }),
  ];
}

/** Gain envelope with raised-cosine ramps, from `from` to `to` seconds, down to `gain`. */
function dip(ch: Float32Array, from: number, to: number, gain: number, rampS: number): void {
  const a = Math.round(from * SAMPLE_RATE);
  const b = Math.round(to * SAMPLE_RATE);
  const ramp = Math.round(rampS * SAMPLE_RATE);
  for (let i = a; i < b; i++) {
    const edge = Math.min(i - a, b - 1 - i);
    const w = edge >= ramp ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / ramp);
    ch[i] = (ch[i] as number) * (1 - w * (1 - gain));
  }
}

function structural(mutation: Mutation | null, channels: Float32Array[]): Float32Array[] {
  switch (mutation) {
    case 'wrap':
      // Half a 110 Hz period off the end: the cosine ends at its trough and wraps to its crest.
      return channels.map((ch) => ch.slice(0, N - 218));
    case 'head-tail':
      for (const ch of channels) dip(ch, 0.05, 0.95, 0.1, 0.01);
      return channels;
    case 'interior-gap':
      for (const ch of channels) dip(ch, 2.9, 3.2, 0, 0.005);
      return channels;
    case 'mono':
      return [channels[0] as Float32Array, (channels[1] as Float32Array).map((v) => -v)];
    case 'duration':
      // Half the loop: whole cycles still, so it wraps cleanly, but under the 4 s budget.
      return channels.map((ch) => ch.slice(0, N / 2));
    case 'frames':
      // Two whole periods: still seamless, but twice the frames the manifest records.
      return channels.map((ch) => {
        const out = new Float32Array(ch.length * 2);
        out.set(ch, 0);
        out.set(ch, ch.length);
        return out;
      });
    default:
      return channels;
  }
}

export function writeWavF32(path: string, channels: readonly Float32Array[]): void {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const data = Buffer.alloc(frames * count * 4);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++)
      data.writeFloatLE((channels[c] as Float32Array)[i] as number, (i * count + c) * 4);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(count, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * count * 4, 28);
  header.writeUInt16LE(count * 4, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

function scale(channels: Float32Array[], db: number): Float32Array[] {
  const g = 10 ** (db / 20);
  return channels.map((ch) => ch.map((v) => v * g));
}

export interface FixtureSet {
  dir: string;
  specs: CueSpec[];
  reasons: Reason[];
  /** The files each reason was raised on. */
  files: Map<Reason, Set<string>>;
  messages: string[];
}

function outcome(
  dir: string,
  specs: CueSpec[],
  failures: ReturnType<typeof validate>['failures'],
): FixtureSet {
  const files = new Map<Reason, Set<string>>();
  for (const f of failures) files.set(f.reason, (files.get(f.reason) ?? new Set()).add(f.file));
  return {
    dir,
    specs,
    reasons: [...files.keys()].sort(),
    files,
    messages: failures.map((f) => `[${f.reason}] ${f.cue} ${f.file}: ${f.message}`),
  };
}

/** Builds the baseline (mutation null) or one mutation, validates it, and removes the files. */
export function buildAndValidate(mutation: Mutation | null): FixtureSet {
  const dir = mkdtempSync(join(tmpdir(), 'gogh-audio-fixture-'));
  try {
    const specs = fixtureSpecs();
    const inputs: ManifestInput[] = [];
    for (const spec of specs) {
      const isMusic = spec.id === 'fx-music';
      let channels = synth(spec.id);
      const source = join(dir, `${spec.id}.source.wav`);
      if (spec.id === 'fx-bed') {
        // A stereo source folded to the mono cue, so the source fold check has something to read.
        const side = mutation === 'mono-source' ? -0.9 : 0.9;
        const mono = channels[0] as Float32Array;
        writeWavF32(source, [mono, mono.map((v) => side * v)]);
      } else {
        writeWavF32(source, channels);
      }
      spec.source = { path: `${spec.id}.source.wav`, sha256: sha256Of(readFileSync(source)) };
      const recordedFrames = channels[0]?.length ?? 0;
      if (isMusic) channels = structural(mutation, channels);

      const master = join(dir, `${spec.id}.master.wav`);
      writeWavF32(master, channels);
      channels = scale(channels, spec.loudness.target - loudness(master).integrated);
      if (isMusic && mutation === 'loudness') channels = scale(channels, -4);
      if (isMusic && mutation === 'true-peak') {
        const at = 3 * SAMPLE_RATE;
        for (const ch of channels)
          for (let i = 0; i < 96; i++)
            ch[at + i] = Math.sin((2 * Math.PI * 3000 * i) / SAMPLE_RATE);
      }
      writeWavF32(master, channels);

      const ogg = join(dir, `${spec.id}.ogg`);
      const mp3 = join(dir, `${spec.id}.mp3`);
      ffmpeg(oggArgs(spec, master, ogg));
      ffmpeg(mp3Args(spec, master, mp3));
      const frames = isMusic && mutation === 'frames' ? recordedFrames : (channels[0]?.length ?? 0);
      const file = (name: string) => {
        const bytes = readFileSync(join(dir, name));
        return { name, bytes: bytes.length, sha256: sha256Of(bytes) };
      };
      inputs.push({
        spec,
        frames,
        files: { ogg: file(`${spec.id}.ogg`), mp3: file(`${spec.id}.mp3`) },
      });

      if (isMusic && mutation === 'hash') {
        // Same audio, different Ogg serial: the bytes no longer match the manifest.
        ffmpeg(oggArgs({ ...spec, serial: spec.serial + 1 }, master, ogg));
      }
      if (isMusic && mutation === 'source-hash') appendFileSync(source, Buffer.from([0]));
    }
    const manifest = buildManifest(inputs, 'fixture');
    const result = validate({ dir, manifest, cues: specs, limits: LIMITS, root: dir });
    return outcome(dir, specs, result.failures);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Re-encodes a committed loop with one seam mutation and validates that cue alone. */
export function buildSeamMutation(root: string, mutation: SeamMutation): FixtureSet {
  const dir = mkdtempSync(join(tmpdir(), 'gogh-audio-seam-'));
  try {
    const spec = CUES.find((c) => c.id === mutation.cue) as CueSpec;
    const pcm = decode(join(root, 'public/audio', `${spec.id}.ogg`));
    for (const ch of pcm.channels) mutation.apply(ch);
    const master = join(dir, `${spec.id}.master.wav`);
    writeWavF32(master, pcm.channels);
    ffmpeg(oggArgs(spec, master, join(dir, `${spec.id}.ogg`)));
    ffmpeg(mp3Args(spec, master, join(dir, `${spec.id}.mp3`)));
    const file = (name: string) => {
      const bytes = readFileSync(join(dir, name));
      return { name, bytes: bytes.length, sha256: sha256Of(bytes) };
    };
    const manifest = buildManifest(
      [
        {
          spec,
          frames: pcm.frames,
          files: { ogg: file(`${spec.id}.ogg`), mp3: file(`${spec.id}.mp3`) },
        },
      ],
      'fixture',
    );
    const result = validate({ dir, manifest, cues: [spec], limits: LIMITS, root });
    return outcome(dir, [spec], result.failures);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface SelfTestOutcome {
  ok: boolean;
  lines: string[];
}

function judge(
  name: string,
  set: FixtureSet,
  reason: Reason,
  everyFile: number,
): [boolean, string] {
  const exact =
    set.reasons.length === 1 &&
    set.reasons[0] === reason &&
    (set.files.get(reason)?.size ?? 0) >= everyFile;
  const where = [...(set.files.get(reason) ?? [])].join(', ');
  return [
    exact,
    `${name} ${exact ? 'ok' : 'FAIL'}, rejected for [${set.reasons.join(', ')}]${where ? ` on ${where}` : ''}${exact ? '' : `: ${set.messages.join('; ')}`}`,
  ];
}

/** `root` holds public/audio/ for the seam mutations; without its files they are skipped. */
export function runSelfTest(root?: string): SelfTestOutcome {
  const lines: string[] = [];
  let ok = true;
  const baseline = buildAndValidate(null);
  if (baseline.reasons.length > 0) {
    ok = false;
    lines.push(`baseline FAIL, rejected: ${baseline.messages.join('; ')}`);
  } else {
    lines.push('baseline ok, accepted');
  }
  for (const [mutation, reason] of Object.entries(MUTATIONS) as [Mutation, Reason][]) {
    const [pass, line] = judge(mutation, buildAndValidate(mutation), reason, 1);
    if (!pass) ok = false;
    lines.push(line);
  }
  for (const mutation of SEAM_MUTATIONS) {
    if (!root || !existsSync(join(root, 'public/audio', `${mutation.cue}.ogg`))) {
      ok = false;
      lines.push(`${mutation.name} FAIL, public/audio/${mutation.cue}.ogg is missing`);
      continue;
    }
    const [pass, line] = judge(
      `${mutation.name} (${mutation.cue})`,
      buildSeamMutation(root, mutation),
      'wrap',
      2,
    );
    if (!pass) ok = false;
    lines.push(line);
  }
  return { ok, lines };
}
