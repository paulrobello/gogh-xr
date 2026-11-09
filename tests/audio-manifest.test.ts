// @vitest-environment node
/**
 * The committed audio checks that need no ffmpeg, so they also run in CI: the manifest's
 * shape, bytes and hashes against public/audio/, no unnamed files, and the contract hash
 * recorded in docs/audio/derivatives.md against the current contract.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Of } from '../scripts/asset-lib.ts';
import { CUES } from '../scripts/audio/contract.ts';
import { CONTRACT_HASH_LABEL, contractHash } from '../scripts/audio/derivatives.ts';
import type { Manifest } from '../scripts/audio/manifest.ts';
import { manifestShapeErrors, strayFiles } from '../scripts/audio/validate-lib.ts';

const root = resolve(import.meta.dirname, '..');
const dir = join(root, 'public/audio');
const raw: unknown = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

describe('committed audio manifest', () => {
  it('has the documented shape', () => {
    expect(manifestShapeErrors(raw)).toEqual([]);
  });

  const manifest = raw as Manifest;

  it('lists exactly the contract cues, with their loop, kind, channels and target', () => {
    expect(manifest.cues.map((c) => c.id)).toEqual(CUES.map((c) => c.id));
    for (const spec of CUES) {
      const cue = manifest.cues.find((c) => c.id === spec.id);
      expect(cue?.loop).toBe(spec.loop);
      expect(cue?.kind).toBe(spec.kind);
      expect(cue?.channels).toBe(spec.channels);
      expect(cue?.loudness).toEqual(spec.loudness);
    }
  });

  it('matches every runtime file byte count and hash', () => {
    for (const cue of manifest.cues) {
      for (const format of ['ogg', 'mp3'] as const) {
        const bytes = readFileSync(join(dir, cue.files[format]));
        expect(bytes.length, cue.files[format]).toBe(cue.bytes[format]);
        expect(sha256Of(bytes), cue.files[format]).toBe(cue.sha256[format]);
      }
    }
  });

  it('leaves no file in public/audio/ that the manifest does not name', () => {
    expect(strayFiles(dir, manifest)).toEqual([]);
  });

  it('was built from the current contract', () => {
    const doc = readFileSync(join(root, 'docs/audio/derivatives.md'), 'utf8');
    const recorded = new RegExp(`${CONTRACT_HASH_LABEL}: \`([0-9a-f]{64})\``).exec(doc)?.[1];
    expect(recorded).toBe(contractHash(root));
  });

  it('archives every source under its contract hash', () => {
    for (const spec of CUES) {
      expect(sha256Of(readFileSync(join(root, spec.source.path))), spec.id).toBe(
        spec.source.sha256,
      );
    }
  });
});
