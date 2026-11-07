import { existsSync, readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import {
  livePainting,
  PAINTINGS,
  type PaintingEntry,
  type RegistryProblemCode,
  validateRegistry,
} from '../src/paintings/registry.ts';

function provenanceKeys(): Set<string> {
  const text = readFileSync('assets/PROVENANCE.md', 'utf8').split('<!-- scan-hashes:start -->')[0];
  const keys = new Set<string>();
  for (const match of text.matchAll(/^\| ([a-z0-9-]+) \|/gm)) keys.add(match[1]);
  keys.delete('id');
  return keys;
}
const checks = {
  frameExists: (frame: string) => existsSync(`public/${frame}`),
  provenanceKeys: provenanceKeys(),
};

test('the registry holds Starry Night live and six coming-soon paintings', () => {
  expect(PAINTINGS).toHaveLength(7);
  const entry = PAINTINGS[0];
  expect(entry.id).toBe('starry-night');
  expect(entry.status).toBe('live');
  expect(entry.year).toBe(1889);
  expect(entry.museum).toMatch(/Museum of Modern Art/);
  expect(typeof entry.world).toBe('function');
  expect(entry.heightCm).toBe(73.7);
  expect(entry.widthCm).toBe(92.1);
  expect(PAINTINGS.slice(1).every((p) => p.status === 'coming-soon' && !p.world)).toBe(true);
});

test('the real registry has no problems, frames and provenance keys included', () => {
  expect(provenanceKeys().size).toBe(7);
  expect(validateRegistry(PAINTINGS, checks)).toEqual([]);
});

test('each painting size matches its frame scan aspect within 8%', async () => {
  const sharp = (await import('sharp')).default;
  for (const p of PAINTINGS) {
    const { width, height } = await sharp(`public/${p.frameImage}`).metadata();
    const scan = (width ?? 1) / (height ?? 1);
    expect(Math.abs(p.widthCm / p.heightCm / scan - 1), p.id).toBeLessThan(0.08);
  }
});

const base = PAINTINGS[1];
const live = PAINTINGS[0];
const cases: [string, RegistryProblemCode, PaintingEntry[]][] = [
  ['duplicate id', 'duplicate-id', [base, { ...base }]],
  ['empty title', 'empty-field', [{ ...base, title: ' ' }]],
  ['bad year', 'bad-year', [{ ...base, year: 1889.5 }]],
  ['zero width', 'bad-size', [{ ...base, widthCm: 0 }]],
  ['NaN height', 'bad-size', [{ ...base, heightCm: Number.NaN }]],
  ['bad status', 'bad-status', [{ ...base, status: 'soon' as PaintingEntry['status'] }]],
  ['live without world', 'live-without-world', [{ ...live, world: undefined }]],
  ['unknown provenance', 'unknown-provenance', [{ ...base, scanProvenance: 'nope' }]],
  ['missing frame', 'missing-frame-image', [{ ...base, frameImage: 'paintings/none/frame.webp' }]],
];
test.each(cases)('validation rejects %s by name', (_name, code, entries) => {
  const problems = validateRegistry(entries, checks);
  expect(problems.map((p) => p.code)).toContain(code);
});

test('a malformed coming-soon entry is reported, not thrown', () => {
  const problems = validateRegistry([{ ...base, frameImage: 'x.webp' }], checks);
  expect(problems).toHaveLength(1);
  expect(problems[0].status).toBe('coming-soon');
  expect(problems[0].id).toBe(base.id);
});

test('boot validation without checks skips the file and provenance checks', () => {
  expect(validateRegistry([{ ...base, frameImage: 'x.webp', scanProvenance: 'nope' }])).toEqual([]);
});

test('livePainting returns a live entry and warns, returning null, for anything else', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(livePainting('starry-night')?.id).toBe('starry-night');
  expect(warn).not.toHaveBeenCalled();
  expect(livePainting(null)).toBeNull();
  expect(warn).not.toHaveBeenCalled();
  expect(livePainting('water-lilies')).toBeNull();
  expect(warn).toHaveBeenCalledOnce();
  expect(String(warn.mock.calls[0][0])).toMatch(/water-lilies/);
  expect(livePainting('bedroom')).toBeNull();
  warn.mockRestore();
});
