import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { sha256Of } from '../asset-lib.ts';

const root = resolve(import.meta.dirname, '../..');
const provenancePath = resolve(root, 'assets/PROVENANCE.md');
const USER_AGENT = 'gogh-xr-asset-fetch/0.1 (https://github.com/paulrobello/gogh-xr)';
const FRAME_EDGE = 1024;
const START = '<!-- scan-hashes:start -->';
const END = '<!-- scan-hashes:end -->';

interface Scan {
  id: string;
  url: string;
  source: string;
}

function readScans(markdown: string): Scan[] {
  const scans: Scan[] = [];
  for (const line of markdown.split('\n')) {
    const id = /^\| ([a-z][a-z0-9-]*) \|/.exec(line)?.[1];
    const url = /(https:\/\/thumb\.wikimedia\.org\/\S+?) \(\d+ px\)/.exec(line)?.[1];
    if (!id || !url || id === 'id') continue;
    const ext = /\.(jpe?g)$/i.exec(url)?.[1]?.toLowerCase() ?? 'jpg';
    scans.push({ id, url, source: `assets/scans/${id}.${ext === 'jpeg' ? 'jpg' : ext}` });
  }
  return scans;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const markdown = readFileSync(provenancePath, 'utf8');
const scans = readScans(markdown);
if (scans.length !== 7) {
  throw new Error(`expected 7 scan rows in PROVENANCE.md, found ${scans.length}`);
}

const hashes: Array<{ path: string; sha256: string; role: string }> = [];
let fetched = 0;
for (const scan of scans) {
  const sourcePath = resolve(root, scan.source);
  if (!existsSync(sourcePath)) {
    if (fetched > 0) await sleep(1000);
    const downloaded = await download(scan.url);
    await sharp(downloaded).metadata();
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, downloaded);
    fetched += 1;
    console.log(`fetched ${scan.source}`);
  }
  const bytes = readFileSync(sourcePath);
  hashes.push({ path: scan.source, sha256: sha256Of(bytes), role: 'source (never served)' });

  const frame = `public/paintings/${scan.id}/frame.webp`;
  mkdirSync(resolve(root, dirname(frame)), { recursive: true });
  const webp = await sharp(bytes)
    .rotate()
    .resize(FRAME_EDGE, FRAME_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();
  writeFileSync(resolve(root, frame), webp);
  hashes.push({
    path: frame,
    sha256: sha256Of(webp),
    role: `runtime frame, ${FRAME_EDGE} px long edge`,
  });
}

const table = [
  START,
  '| file | SHA-256 | role |',
  '| --- | --- | --- |',
  ...hashes.map((h) => `| \`${h.path}\` | ${h.sha256} | ${h.role} |`),
  END,
].join('\n');

let next: string;
if (markdown.includes(START) && markdown.includes(END)) {
  next =
    markdown.slice(0, markdown.indexOf(START)) +
    table +
    markdown.slice(markdown.indexOf(END) + END.length);
} else {
  next = `${markdown.trimEnd()}\n\n## Painting scan hashes\n\nWritten by \`scripts/scans/fetch.ts\`. \`asset-check\` recomputes every hash and requires a row for every file under \`public/paintings/\`.\n\n${table}\n`;
}
writeFileSync(provenancePath, next);
console.log(`fetched ${fetched} new files, recorded ${hashes.length} hashes`);
