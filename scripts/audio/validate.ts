/**
 * `make asset-check` audio leg: recomputes every runtime audio check from the current files
 * in public/audio/ (see validate-lib.ts) and exits non-zero on any failure.
 *
 * FFmpeg policy: ffmpeg must be on PATH, or this fails. A build other than the pin only
 * warns, because none of these checks needs byte identity: hashes are of the committed
 * bytes, and the measurements are expected to move far less than their tolerances on
 * another build. Byte identity of a rebuild is `bun scripts/audio/master.ts --check`, which
 * needs the pin and is the one step skipped on another build.
 *
 * `--self-test` first runs the fixtures (fixtures.ts): the known-good baseline must pass,
 * and each mutation must fail for exactly its own reason.
 *
 * Pending owner deviations (contract.ts `deviations`) never fail; each prints a WARN line.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CUES, LIMITS } from './contract.ts';
import { CONTRACT_HASH_LABEL, contractHash } from './derivatives.ts';
import { displayVersion, FFMPEG_PIN, ffmpegVersion } from './ffmpeg.ts';
import { runSelfTest } from './fixtures.ts';
import type { Manifest } from './manifest.ts';
import { formatTable, manifestShapeErrors, strayFiles, validate } from './validate-lib.ts';

const root = resolve(import.meta.dirname, '../..');
const dir = join(root, 'public/audio');

const version = ffmpegVersion();
if (!version.found) {
  console.error(
    `audio-check: FAIL ffmpeg is not on PATH. The audio validator decodes with ffmpeg (pin ${FFMPEG_PIN.version}).`,
  );
  process.exit(1);
}
if (!version.pinned) {
  console.warn(
    `audio-check: WARN ffmpeg ${version.version} (libavcodec ${displayVersion(version.libavcodec)}) is not the pin ${FFMPEG_PIN.version} ` +
      `(libavcodec ${displayVersion(FFMPEG_PIN.libavcodec)}). Every validator check and the self-test still run; only the master.ts --check byte-identity rebuild is skipped.`,
  );
}

if (process.argv.includes('--self-test')) {
  const started = performance.now();
  const outcome = runSelfTest(root);
  for (const line of outcome.lines) console.log(`audio-check: self-test ${line}`);
  if (!outcome.ok) {
    console.error('audio-check: FAIL self-test, the validator cannot be trusted on this toolchain');
    process.exit(1);
  }
  console.log(
    `audio-check: self-test passed in ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
}

const raw: unknown = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const shape = manifestShapeErrors(raw);
if (shape.length > 0) {
  for (const e of shape) console.error(`audio-check: FAIL [manifest] manifest.json: ${e}`);
  process.exit(1);
}
const manifest = raw as Manifest;
const result = validate({ dir, manifest, cues: CUES, limits: LIMITS, root });
const failures = [...result.failures, ...strayFiles(dir, manifest)];

const doc = readFileSync(join(root, 'docs/audio/derivatives.md'), 'utf8');
const recorded = new RegExp(`${CONTRACT_HASH_LABEL}: \`([0-9a-f]{64})\``).exec(doc)?.[1];
const current = contractHash(root);
if (recorded !== current) {
  failures.push({
    cue: '*',
    file: 'docs/audio/derivatives.md',
    reason: 'manifest',
    message: `contract hash ${recorded ?? 'missing'}, current contract ${current}: run make audio`,
  });
}

console.log(formatTable(result.measures));
for (const f of result.sourceFolds) {
  console.log(`audio-check: source fold ${f.cue} ${f.lossDb.toFixed(2)} dB`);
}
for (const w of result.warnings) console.warn(`audio-check: WARN ${w}`);
if (failures.length > 0) {
  for (const f of failures)
    console.error(`audio-check: FAIL [${f.reason}] ${f.cue} ${f.file}: ${f.message}`);
  process.exit(1);
}
console.log(
  `audio-check: ${result.measures.length} runtime files across ${CUES.length} cues verified` +
    (result.warnings.length > 0 ? `, ${result.warnings.length} owner warnings above` : ''),
);
