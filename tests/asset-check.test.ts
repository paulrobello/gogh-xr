import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIO_FILES,
  checkAssets,
  malformedRows,
  parseHashRows,
  requiredFiles,
  sha256Of,
} from '../scripts/asset-lib.ts';

const HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const FRAME = 'public/paintings/a/frame.webp';
const SOURCE = 'assets/scans/a.jpg';
const PAINTING_ROW =
  '| a | A painting | https://thumb.wikimedia.org/x/1280px-a.jpg (1280 px) | ok |';

const row = (path: string, hash: string) => `| \`${path}\` | ${hash} | role |`;

function fullManifest(): string {
  return [
    PAINTING_ROW,
    row(SOURCE, HELLO),
    row(FRAME, HELLO),
    ...AUDIO_FILES.map((f) => row(f, HELLO)),
  ].join('\n');
}

describe('asset hash checks', () => {
  let root: string;

  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'asset-check-'));
    for (const file of [SOURCE, FRAME, ...AUDIO_FILES]) write(file, 'hello');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('hashes bytes with SHA-256', () => {
    expect(sha256Of(new TextEncoder().encode('hello'))).toBe(HELLO);
  });

  it('parses well-formed rows and lowercases the hash', () => {
    const md = [row('x/y.bin', HELLO.toUpperCase()), '| plain | text |'].join('\n');
    expect(parseHashRows(md)).toEqual([{ path: 'x/y.bin', sha256: HELLO }]);
  });

  it('derives required files from the painting table', () => {
    expect(requiredFiles(PAINTING_ROW)).toEqual([SOURCE, FRAME, ...AUDIO_FILES]);
  });

  it('passes when every hash matches and every required file has a row', () => {
    expect(checkAssets(root, fullManifest())).toEqual({ failures: [], checked: 4 });
  });

  it('accepts uppercase hex', () => {
    const md = fullManifest().replaceAll(HELLO, HELLO.toUpperCase());
    expect(checkAssets(root, md).failures).toEqual([]);
  });

  it('names the file on hash drift', () => {
    write(FRAME, 'hellp');
    const { failures } = checkAssets(root, fullManifest());
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`${FRAME}: hash drift`);
  });

  it('names the audio file on audio hash drift', () => {
    write('assets/audio/source/suno/score-night.wav', 'hellp');
    const { failures } = checkAssets(root, fullManifest());
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('assets/audio/source/suno/score-night.wav: hash drift');
  });

  it('fails on a derivative with no provenance row', () => {
    write('public/paintings/a/extra.png', 'x');
    expect(checkAssets(root, fullManifest()).failures).toEqual([
      'public/paintings/a/extra.png: derivative has no provenance row',
    ]);
  });

  it('fails on an unlisted file under assets/ and names its path', () => {
    write('assets/audio/stray.wav', 'x');
    expect(checkAssets(root, fullManifest()).failures).toEqual([
      'assets/audio/stray.wav: asset has no provenance row',
    ]);
  });

  it('does not require a row for PROVENANCE.md itself, and ignores OS junk files', () => {
    write('assets/PROVENANCE.md', fullManifest());
    write('assets/.DS_Store', 'x');
    write('assets/scans/.DS_Store', 'x');
    write('public/paintings/a/.DS_Store', 'x');
    expect(checkAssets(root, fullManifest()).failures).toEqual([]);
  });

  it('fails on a listed file that is missing', () => {
    const md = `${fullManifest()}\n${row('assets/gone.bin', HELLO)}`;
    expect(checkAssets(root, md).failures).toEqual([
      'assets/gone.bin: file listed in PROVENANCE.md is missing',
    ]);
  });

  it('fails on a duplicate row', () => {
    const md = `${fullManifest()}\n${row(FRAME, HELLO)}`;
    expect(checkAssets(root, md).failures[0]).toContain('duplicate provenance row');
  });

  it('fails when a required row is deleted', () => {
    const md = fullManifest()
      .split('\n')
      .filter((line) => !line.includes(AUDIO_FILES[1] as string))
      .join('\n');
    expect(checkAssets(root, md).failures).toEqual([
      `${AUDIO_FILES[1]}: required file has no provenance row`,
    ]);
  });

  it('fails closed when the hash table is missing entirely', () => {
    const { failures } = checkAssets(root, PAINTING_ROW);
    expect(failures).toContain('no hash rows verified');
    expect(failures).toContain(`${SOURCE}: required file has no provenance row`);
  });

  it('fails closed when there are no painting rows', () => {
    expect(checkAssets(root, '').failures).toContain('no painting rows found in PROVENANCE.md');
  });

  it('reports a malformed hash row naming the line', () => {
    const bad = `| \`${FRAME}\` | ${HELLO.slice(0, 60)} | role |`;
    expect(malformedRows(bad)).toEqual([bad]);
    const { failures } = checkAssets(root, `${fullManifest()}\n${bad}`);
    expect(failures).toContain(`malformed hash row: ${bad}`);
  });
});
