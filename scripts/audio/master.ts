/**
 * `make audio`: masters every cue in scripts/audio/contract.ts from its immutable source,
 * stages the Opus/Ogg + MP3 files and manifest.json in build/audio/out/, then promotes them
 * to public/audio/ (removing any file there the manifest does not name) and rewrites
 * docs/audio/derivatives.md. The float WAV stage and master intermediates go to
 * build/audio/, which is ignored by version control.
 *
 * `--check` rebuilds into build/audio/out/ and compares it byte for byte with the committed
 * public/audio/ files and docs/audio/derivatives.md, without promoting: the
 * reproducibility check. It skips on any ffmpeg but the pin; the write mode refuses.
 *
 * `--audition` (`make audio-audition`) renders, for each cue with a pending `crest-limited`
 * deviation, the shipping limited file and the linear-gain-to-ceiling alternative into
 * build/audio/audition/ (never committed), for the owner to compare.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256Of } from '../asset-lib.ts';
import { CUES, type CueSpec, LIMITS, MASTER_TRUE_PEAK_CEILING } from './contract.ts';
import { type CueRecord, contractHash, renderDerivatives } from './derivatives.ts';
import {
  decode,
  displayVersion,
  FFMPEG_PIN,
  ffmpeg,
  ffmpegVersion,
  type Loudness,
  loudness,
  type Pcm,
  SAMPLE_RATE,
} from './ffmpeg.ts';
import { buildManifest, MANIFEST_NAME } from './manifest.ts';
import {
  gainArgs,
  gainChain,
  mp3Args,
  oggArgs,
  planGain,
  roundGain,
  stageArgs,
} from './master-lib.ts';
import { applyDeviations, sourceFoldLoss } from './validate-lib.ts';

const root = resolve(import.meta.dirname, '../..');
process.chdir(root);

const PUBLIC_DIR = 'public/audio';
const DOC = 'docs/audio/derivatives.md';
const BUILD = 'build/audio';
const MAX_PEAK_PASSES = 4;
/** Extra cut, dB, when an encode overshoots the ceiling, so the next pass clears it. */
const PEAK_MARGIN_DB = 0.2;

const check = process.argv.includes('--check');
const audition = process.argv.includes('--audition');

const version = ffmpegVersion();
if (!version.pinned && check) {
  // asset-check runs this leg; under another ffmpeg it degrades to the validator's checks.
  console.warn(
    `audio master --check: SKIP the byte-identity rebuild needs ffmpeg ${FFMPEG_PIN.version} ` +
      `(libavcodec ${displayVersion(FFMPEG_PIN.libavcodec)}), found ${version.found ? version.version : 'no ffmpeg on PATH'}.`,
  );
  process.exit(0);
}
if (!version.pinned) {
  console.error(
    `audio master: FAIL needs ffmpeg ${FFMPEG_PIN.version} (libavcodec ${displayVersion(FFMPEG_PIN.libavcodec)}), found ` +
      `${version.found ? `${version.version} (libavcodec ${displayVersion(version.libavcodec)})` : 'no ffmpeg on PATH'}. ` +
      'Another build gives different bytes, so the committed files could not be reproduced.',
  );
  process.exit(1);
}

for (const spec of CUES) {
  const actual = sha256Of(readFileSync(spec.source.path));
  if (actual !== spec.source.sha256) {
    console.error(
      `audio master: FAIL ${spec.source.path}: source hash ${actual}, contract ${spec.source.sha256}`,
    );
    process.exit(1);
  }
}

const outDir = join(BUILD, 'out');
rmSync(outDir, { recursive: true, force: true });
for (const dir of [outDir, join(BUILD, 'stage'), join(BUILD, 'master')])
  mkdirSync(dir, { recursive: true });

/** SHA-256 of the decoded float PCM, channel after channel: a cross-decoder signal. */
function pcmSha(pcm: Pcm): string {
  return sha256Of(
    Buffer.concat(pcm.channels.map((ch) => Buffer.from(ch.buffer, ch.byteOffset, ch.byteLength))),
  );
}

interface Encoded {
  gainDb: number;
  encoded: Record<'ogg' | 'mp3', Loudness>;
  passes: number;
}

/** Linear gain, then encode; re-encodes with less gain while either decoded peak is over. */
function encodeAt(
  spec: CueSpec,
  stage: string,
  master: string,
  ogg: string,
  mp3: string,
  startDb: number,
): Encoded {
  let gainDb = startDb;
  for (let pass = 1; ; pass++) {
    ffmpeg(gainArgs(stage, gainChain(spec, gainDb), master));
    ffmpeg(oggArgs(spec, master, ogg));
    ffmpeg(mp3Args(spec, master, mp3));
    const encoded: Record<'ogg' | 'mp3', Loudness> = { ogg: loudness(ogg), mp3: loudness(mp3) };
    const peak = Math.max(encoded.ogg.truePeak, encoded.mp3.truePeak);
    if (peak <= LIMITS.truePeakMax) return { gainDb, encoded, passes: pass };
    if (pass >= MAX_PEAK_PASSES) {
      console.error(
        `audio master: FAIL ${spec.id} still peaks at ${peak.toFixed(2)} dBTP after ${pass} passes, ceiling ${LIMITS.truePeakMax} dBTP`,
      );
      process.exit(1);
    }
    gainDb = roundGain(gainDb - (peak - LIMITS.truePeakMax) - PEAK_MARGIN_DB);
  }
}

function masterCue(spec: CueSpec): CueRecord {
  const started = performance.now();
  const sourceFrames = decode(spec.source.path).frames;
  const stage = join(BUILD, 'stage', `${spec.id}.wav`);
  const master = join(BUILD, 'master', `${spec.id}.wav`);
  const ogg = join(outDir, `${spec.id}.ogg`);
  const mp3 = join(outDir, `${spec.id}.mp3`);
  const stageCmd = stageArgs(spec, spec.source.path, sourceFrames, stage);
  ffmpeg(stageCmd);

  const plan = planGain(spec, stage, MASTER_TRUE_PEAK_CEILING);
  const { gainDb, encoded, passes } = encodeAt(spec, stage, master, ogg, mp3, plan.gainDb);

  const masterPcm = decode(master);
  const oggBytes = readFileSync(ogg);
  const mp3Bytes = readFileSync(mp3);
  const record: CueRecord = {
    spec,
    sourceFrames,
    source: {
      ...loudness(spec.source.path),
      foldLossDb: spec.channels === 1 ? sourceFoldLoss(spec.source.path) : null,
    },
    frames: masterPcm.frames,
    gainDb,
    peakLimited: plan.peakLimited || gainDb < plan.gainDb,
    staged: plan.measured,
    stageSha256: sha256Of(readFileSync(stage)),
    master: { ...loudness(master), sha256: sha256Of(readFileSync(master)) },
    files: {
      ogg: {
        name: `${spec.id}.ogg`,
        bytes: oggBytes.length,
        sha256: sha256Of(oggBytes),
        pcmSha256: pcmSha(decode(ogg)),
        ...encoded.ogg,
      },
      mp3: {
        name: `${spec.id}.mp3`,
        bytes: mp3Bytes.length,
        sha256: sha256Of(mp3Bytes),
        pcmSha256: pcmSha(decode(mp3)),
        ...encoded.mp3,
      },
    },
    commands: {
      stage: stageCmd,
      gain: gainArgs(stage, gainChain(spec, gainDb), master),
      ogg: oggArgs(spec, master, join(PUBLIC_DIR, `${spec.id}.ogg`)),
      mp3: mp3Args(spec, master, join(PUBLIC_DIR, `${spec.id}.mp3`)),
    },
  };
  console.log(
    `audio master: ${spec.id} ${(masterPcm.frames / SAMPLE_RATE).toFixed(3)} s gain ${gainDb.toFixed(2)} dB, ` +
      `ogg ${encoded.ogg.integrated.toFixed(2)} LUFS ${encoded.ogg.truePeak.toFixed(2)} dBTP, ` +
      `mp3 ${encoded.mp3.integrated.toFixed(2)} LUFS ${encoded.mp3.truePeak.toFixed(2)} dBTP ` +
      `(${passes} pass${passes > 1 ? 'es' : ''}, ${((performance.now() - started) / 1000).toFixed(1)} s)`,
  );
  return record;
}

function renderAudition(): void {
  const dir = join(BUILD, 'audition');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const spec of CUES.filter((c) => c.deviations?.some((d) => d.kind === 'crest-limited'))) {
    const record = masterCue(spec);
    for (const f of Object.values(record.files)) {
      copyFileSync(
        join(outDir, f.name),
        join(dir, f.name.replace(`${spec.id}.`, `${spec.id}-limited.`)),
      );
    }
    const linear: CueSpec = { ...spec, limiter: undefined };
    const stage = join(BUILD, 'stage', `${spec.id}.wav`);
    const plan = planGain(linear, stage, MASTER_TRUE_PEAK_CEILING);
    const out = (ext: string) => join(dir, `${spec.id}-linear.${ext}`);
    const { gainDb, encoded } = encodeAt(
      linear,
      stage,
      out('wav'),
      out('ogg'),
      out('mp3'),
      plan.gainDb,
    );
    console.log(
      `audio audition: ${spec.id} limited ${record.files.ogg.integrated.toFixed(2)} LUFS ` +
        `${record.files.ogg.truePeak.toFixed(2)} dBTP, linear (${gainDb.toFixed(2)} dB, no limiter) ` +
        `${encoded.ogg.integrated.toFixed(2)} LUFS ${encoded.ogg.truePeak.toFixed(2)} dBTP, target ${spec.loudness.target} LUFS`,
    );
  }
  console.log(`audio audition: wrote ${readdirSync(dir).sort().join(', ')} to ${dir}/`);
}

if (audition) {
  renderAudition();
  process.exit(0);
}

const records = CUES.map(masterCue);
const unwaived = applyDeviations(
  CUES,
  records.flatMap((r) =>
    r.source.foldLossDb !== null && !(r.source.foldLossDb < LIMITS.monoMaxLossDb)
      ? [
          {
            cue: r.spec.id,
            file: r.spec.source.path,
            reason: 'mono' as const,
            message: `source fold loses ${r.source.foldLossDb.toFixed(2)} dB`,
            value: r.source.foldLossDb,
          },
        ]
      : [],
  ),
).kept;
if (unwaived.length > 0) {
  for (const f of unwaived) {
    console.error(
      `audio master: FAIL [mono] ${f.cue} ${f.file}: ${f.message}, with no owner deviation`,
    );
  }
  process.exit(1);
}
const manifestText = `${JSON.stringify(buildManifest(records, version.version ?? ''), null, 2)}\n`;
const docText = renderDerivatives(records, version, contractHash(root));
writeFileSync(join(outDir, MANIFEST_NAME), manifestText);
const staged = readdirSync(outDir).sort();

if (!check) {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  for (const name of readdirSync(PUBLIC_DIR)) {
    if (!staged.includes(name)) rmSync(join(PUBLIC_DIR, name));
  }
  for (const name of staged) copyFileSync(join(outDir, name), join(PUBLIC_DIR, name));
  writeFileSync(DOC, docText);
  console.log(`audio master: promoted ${staged.length} files to ${PUBLIC_DIR}/ and wrote ${DOC}`);
  process.exit(0);
}

const differences: string[] = [];
const compare = (committed: string, rebuilt: Buffer | string) => {
  if (!existsSync(committed)) {
    differences.push(`${committed}: missing from the tree`);
    return;
  }
  const a = sha256Of(readFileSync(committed));
  const b = sha256Of(typeof rebuilt === 'string' ? Buffer.from(rebuilt) : rebuilt);
  if (a !== b) differences.push(`${committed}: committed ${a}, rebuilt ${b}`);
};
for (const name of staged) compare(join(PUBLIC_DIR, name), readFileSync(join(outDir, name)));
for (const name of readdirSync(PUBLIC_DIR)) {
  if (!staged.includes(name) && name !== '.DS_Store') {
    differences.push(`${PUBLIC_DIR}/${name}: not produced by the build`);
  }
}
compare(DOC, docText);
if (differences.length > 0) {
  for (const line of differences) console.error(`audio master --check: FAIL ${line}`);
  process.exit(1);
}
console.log(`audio master --check: rebuilt ${staged.length + 1} files byte-identical to the tree`);
