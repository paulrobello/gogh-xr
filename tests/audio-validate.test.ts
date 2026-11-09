// @vitest-environment node
/**
 * The P6.4 validator fixtures: the generated baseline must pass, and each mutation must fail
 * for exactly its own reason. They encode with ffmpeg, so they run only on the pinned build.
 * CI's ubuntu runner skips them (it has no asset-check job either); the pure metric tests in
 * audio-metrics.test.ts run everywhere.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUES } from '../scripts/audio/contract.ts';
import { FFMPEG_PIN, ffmpegVersion } from '../scripts/audio/ffmpeg.ts';
import {
  buildAndValidate,
  buildSeamMutation,
  MUTATIONS,
  SEAM_MUTATIONS,
} from '../scripts/audio/fixtures.ts';
import { stageGraph } from '../scripts/audio/master-lib.ts';

const version = ffmpegVersion();
if (!version.pinned) {
  console.warn(
    `audio-validate: skipping the ffmpeg fixtures, they need ffmpeg ${FFMPEG_PIN.version} and found ` +
      `${version.found ? version.version : 'no ffmpeg on PATH'}`,
  );
}

describe.skipIf(!version.pinned)('audio validator fixtures', () => {
  it('accepts the known-good baseline', () => {
    const set = buildAndValidate(null);
    expect(set.messages).toEqual([]);
  });

  for (const [mutation, reason] of Object.entries(MUTATIONS) as [
    keyof typeof MUTATIONS,
    string,
  ][]) {
    it(`rejects the ${mutation} mutation for exactly [${reason}]`, () => {
      const set = buildAndValidate(mutation);
      expect(set.reasons, set.messages.join('\n')).toEqual([reason]);
    });
  }

  const root = resolve(import.meta.dirname, '..');
  for (const mutation of SEAM_MUTATIONS) {
    it(`rejects ${mutation.name} on ${mutation.cue} for [wrap] in both formats`, () => {
      const set = buildSeamMutation(root, mutation);
      expect(set.reasons, set.messages.join('\n')).toEqual(['wrap']);
      expect([...(set.files.get('wrap') ?? [])].sort()).toEqual([
        `${mutation.cue}.mp3`,
        `${mutation.cue}.ogg`,
      ]);
    }, 120_000);
  }
});

describe('stageGraph', () => {
  it('wraps a loop tail-to-head: body after the intro, then the tail crossfaded over the intro', () => {
    const night = CUES.find((c) => c.id === 'score-night');
    if (!night) throw new Error('score-night missing');
    expect(stageGraph(night, 7_200_000)).toBe(
      '[0:a]aresample=48000,aformat=sample_fmts=flt,atrim=start_sample=0:end_sample=7008000,' +
        'asetpts=N/SR/TB,asplit=2[body][head];' +
        '[body]atrim=start_sample=240000,asetpts=N/SR/TB[rest];' +
        '[head]atrim=end_sample=240000,asetpts=N/SR/TB[intro];' +
        '[rest][intro]acrossfade=ns=240000:o=1:c1=qsin:c2=qsin[out]',
    );
  });

  it('folds SFX to mono by explicit 0.5L + 0.5R and fades a one-shot out', () => {
    const rustle = CUES.find((c) => c.id === 'stroke-rustle');
    if (!rustle) throw new Error('stroke-rustle missing');
    expect(stageGraph(rustle, 48_000)).toBe(
      '[0:a]aresample=48000,aformat=sample_fmts=flt,pan=mono|c0=0.5*c0+0.5*c1,' +
        'atrim=start_sample=0:end_sample=43200,asetpts=N/SR/TB,' +
        'afade=t=out:start_sample=41760:nb_samples=1440[out]',
    );
  });
});
