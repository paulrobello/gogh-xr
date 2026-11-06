import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface HashRow {
  path: string;
  sha256: string;
}

export const HASH_ROW = /^\|\s*`([^`]+)`\s*\|\s*([0-9a-f]{64})\s*\|/i;
const FILE_ROW_SHAPE = /^\|\s*`[^`]+`\s*\|/;
const PAINTING_ROW = /^\| ([a-z][a-z0-9-]*) \|.*thumb\.wikimedia\.org/;
export const AUDIO_FILES = [
  'assets/audio/source/suno/score-night.wav',
  'assets/audio/source/suno/score-gallery.wav',
];
/** `make bake` input and outputs, recorded in the PROVENANCE.md bake block. */
export const BAKE_FILES = [
  'assets/bake/starry-night/regions.json',
  'public/paintings/starry-night/palette.json',
  'public/paintings/starry-night/flow.png',
  'public/paintings/starry-night/regions.png',
];

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseHashRows(markdown: string): HashRow[] {
  const rows: HashRow[] = [];
  for (const line of markdown.split('\n')) {
    const match = HASH_ROW.exec(line);
    if (match) rows.push({ path: match[1] as string, sha256: (match[2] as string).toLowerCase() });
  }
  return rows;
}

/** Lines shaped like a file-hash row (backticked path first cell) that fail the strict parse. */
export function malformedRows(markdown: string): string[] {
  return markdown.split('\n').filter((line) => FILE_ROW_SHAPE.test(line) && !HASH_ROW.test(line));
}

export function paintingIds(markdown: string): string[] {
  const ids: string[] = [];
  for (const line of markdown.split('\n')) {
    const id = PAINTING_ROW.exec(line)?.[1];
    if (id) ids.push(id);
  }
  return ids;
}

export function requiredFiles(markdown: string): string[] {
  const ids = paintingIds(markdown);
  return [
    ...ids.map((id) => `assets/scans/${id}.jpg`),
    ...ids.map((id) => `public/paintings/${id}/frame.webp`),
    ...AUDIO_FILES,
    ...BAKE_FILES,
  ];
}

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

export interface CheckResult {
  failures: string[];
  checked: number;
}

const JUNK_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db']);
const PROVENANCE_FILE = 'assets/PROVENANCE.md';

function isJunk(file: string): boolean {
  return JUNK_FILES.has(file.split(/[\\/]/).pop() ?? '');
}

/**
 * Recompute every manifest hash under `root`, and require a row for every file in
 * `public/paintings` and `assets/` (except PROVENANCE.md itself). OS junk files are ignored.
 */
export function checkAssets(root: string, markdown: string): CheckResult {
  const rows = parseHashRows(markdown);
  const failures: string[] = [];
  for (const line of malformedRows(markdown)) failures.push(`malformed hash row: ${line}`);
  if (paintingIds(markdown).length === 0) failures.push('no painting rows found in PROVENANCE.md');
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.path)) failures.push(`${row.path}: duplicate provenance row`);
    seen.add(row.path);
    const full = join(root, row.path);
    if (!existsSync(full)) {
      failures.push(`${row.path}: file listed in PROVENANCE.md is missing`);
      continue;
    }
    const actual = sha256Of(readFileSync(full));
    if (actual !== row.sha256) {
      failures.push(`${row.path}: hash drift (expected ${row.sha256}, got ${actual})`);
    }
  }
  for (const required of requiredFiles(markdown)) {
    if (!seen.has(required)) failures.push(`${required}: required file has no provenance row`);
  }
  if (rows.length === 0) failures.push('no hash rows verified');
  for (const file of listFiles(join(root, 'public/paintings'))) {
    if (isJunk(file)) continue;
    const rel = relative(root, file).split('\\').join('/');
    if (!seen.has(rel)) failures.push(`${rel}: derivative has no provenance row`);
  }
  const required = new Set(requiredFiles(markdown));
  for (const file of listFiles(join(root, 'assets'))) {
    if (isJunk(file)) continue;
    const rel = relative(root, file).split('\\').join('/');
    if (rel !== PROVENANCE_FILE && !seen.has(rel) && !required.has(rel)) {
      failures.push(`${rel}: asset has no provenance row`);
    }
  }
  return { failures, checked: rows.length };
}
