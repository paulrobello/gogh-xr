/**
 * `make bake`: analyzes assets/scans/starry-night.jpg and writes palette.json, flow.png,
 * regions.png and lights.webp to public/paintings/starry-night/, then records their hashes (and the hash of the
 * hand-authored regions.json input) in the bake block of assets/PROVENANCE.md.
 *
 * Outputs (see scan-analysis.ts for the conventions):
 * - palette.json: 24 k-means swatches (Oklab, seeded k-means++), sorted dark to light.
 * - flow.png: 1024² RGB8. R = 0.5 + 0.5·cos 2θ, G = 0.5 + 0.5·sin 2θ, B = coherence (stroke-length
 *   hint). θ is the stroke direction from +x, counterclockwise, y up, in painting space. Decode
 *   with θ = ½·atan2(2G − 1, 2R − 1). The scan is squashed to the square, so sample by UV.
 * - regions.png: 1024² 8-bit greyscale, pixel value = region id. Sample with NearestFilter and no
 *   mipmaps or ids blend. Ids: 0 sky (fallback), 1 stars, 2 moon, 3 cypress, 4 village, 5 hills,
 *   6 church.
 * - lights.webp: the scan at full resolution around each moon and star anchor, one square per anchor
 *   stacked top to bottom (src/world/sky-scan.ts), lossy WebP at quality 90. The sky-light strokes
 *   read their colours there.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { sha256Of } from '../asset-lib.ts';
import { bakeScan, bakeSkyLights } from './bake.ts';
import type { RegionsDoc } from './scan-analysis.ts';

const root = resolve(import.meta.dirname, '../..');
const SCAN = 'assets/scans/starry-night.jpg';
const REGIONS_INPUT = 'assets/bake/starry-night/regions.json';
const OUT_DIR = 'public/paintings/starry-night';
const PROVENANCE = 'assets/PROVENANCE.md';
const START = '<!-- bake-hashes:start -->';
const END = '<!-- bake-hashes:end -->';

const started = performance.now();
const scan = readFileSync(resolve(root, SCAN));
const regionsText = readFileSync(resolve(root, REGIONS_INPUT), 'utf8');
const regionsDoc = JSON.parse(regionsText) as RegionsDoc;

const meta = await sharp(scan).metadata();
const scanAspect = (meta.width ?? 0) / (meta.height ?? 1);
if (Math.abs(scanAspect - regionsDoc.aspect) > 0.005) {
  throw new Error(`${REGIONS_INPUT}: aspect ${regionsDoc.aspect} != scan aspect ${scanAspect}`);
}

const { palette, flow, regions } = await bakeScan(scan, regionsDoc);
const lights = await bakeSkyLights(scan);
mkdirSync(resolve(root, OUT_DIR), { recursive: true });
const outputs: Array<{ path: string; bytes: Uint8Array; role: string }> = [
  { path: `${OUT_DIR}/palette.json`, bytes: Buffer.from(palette), role: 'bake: 24-swatch palette' },
  { path: `${OUT_DIR}/flow.png`, bytes: flow, role: 'bake: 1024² flow field' },
  { path: `${OUT_DIR}/regions.png`, bytes: regions, role: 'bake: 1024² region ids' },
  {
    path: `${OUT_DIR}/lights.webp`,
    bytes: lights,
    role: 'bake: full-resolution scan around the moon and stars',
  },
];
for (const out of outputs) writeFileSync(resolve(root, out.path), out.bytes);

const rows = [
  { path: REGIONS_INPUT, bytes: Buffer.from(regionsText), role: 'bake input, hand-authored' },
  ...outputs,
];
const table = [
  START,
  '| file | SHA-256 | role |',
  '| --- | --- | --- |',
  ...rows.map((r) => `| \`${r.path}\` | ${sha256Of(r.bytes)} | ${r.role} |`),
  END,
].join('\n');
const markdown = readFileSync(resolve(root, PROVENANCE), 'utf8');
if (!markdown.includes(START) || !markdown.includes(END)) {
  throw new Error(`${PROVENANCE}: missing ${START} / ${END} markers`);
}
writeFileSync(
  resolve(root, PROVENANCE),
  markdown.slice(0, markdown.indexOf(START)) +
    table +
    markdown.slice(markdown.indexOf(END) + END.length),
);

const seconds = ((performance.now() - started) / 1000).toFixed(2);
for (const out of outputs) {
  console.log(`bake: wrote ${out.path} (${statSync(resolve(root, out.path)).size} bytes)`);
}
console.log(`bake: done in ${seconds} s`);
