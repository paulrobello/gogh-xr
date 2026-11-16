/**
 * Renders the favicon set, the PWA icons and the share image from `assets/site/` into `public/`,
 * and rewrites their rows in `assets/PROVENANCE.md`.
 *
 *   bun scripts/site/generate.ts
 *
 * Sources: `icon.svg` (the mark), `icon-small.svg` (the simplified mark for 48 px and below),
 * `icon-maskable.svg` (full bleed, the mark inside the maskable safe zone) and the two world
 * captures `share-*.jpg`, which `scripts/site/capture-share.ts` takes from a served build.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { sha256Of } from '../asset-lib.ts';
import {
  encodeIco,
  ICO_FILE,
  ICO_SIZES,
  ICON_OUTPUTS,
  SHARE_IMAGE,
  SOURCE_DIR,
  SOURCE_FILES,
  SVG_FAVICON,
} from './site-lib.ts';

const root = resolve(import.meta.dirname, '../..');
const source = (name: string): string => resolve(root, SOURCE_DIR, name);
const START = '<!-- site-hashes:start -->';
const END = '<!-- site-hashes:end -->';
const FONT = resolve(root, 'public/fonts/NotoSans-Regular.ttf');

const written: Array<{ path: string; role: string }> = [];
function write(path: string, bytes: Uint8Array | string, role: string): void {
  const full = resolve(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
  written.push({ path, role });
}

const renderIcon = (svg: string, size: number): Promise<Buffer> =>
  sharp(source(svg), { density: 72 * Math.max(1, size / 512) })
    .resize(size, size)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();

for (const icon of ICON_OUTPUTS) {
  write(icon.file, await renderIcon(icon.source, icon.size), `${icon.size} px from ${icon.source}`);
}
write(
  ICO_FILE,
  encodeIco(
    await Promise.all(
      ICO_SIZES.map(async (size) => ({ size, png: await renderIcon(SVG_FAVICON.source, size) })),
    ),
  ),
  `${ICO_SIZES.join(', ')} px from ${SVG_FAVICON.source}`,
);
write(SVG_FAVICON.file, readFileSync(source(SVG_FAVICON.source)), `copy of ${SVG_FAVICON.source}`);

// The share image: the Starry Night capture, the café capture behind a slanted seam (its line
// fades out above the lockup), and the title lockup over a shade. Text is set in the app's own Noto Sans.
const { width: W, height: H } = SHARE_IMAGE;
const SEAM_TOP = 760;
const SEAM_BOTTOM = 640;
const svg = (body: string): Buffer =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`);
const text = (markup: string, size: number): Promise<Buffer> =>
  sharp({ text: { text: markup, font: `Noto Sans ${size}`, fontfile: FONT, rgba: true, dpi: 72 } })
    .png()
    .toBuffer();
const fitted = (name: string): Promise<Buffer> => sharp(source(name)).resize(W, H).toBuffer();

const night = await sharp(await fitted('share-starry-night.jpg'))
  .extract({ left: 150, top: 0, width: W - 150, height: H })
  .extend({ right: 150, background: '#000' })
  .toBuffer();
const cafe = await sharp(await fitted('share-cafe-terrace.jpg'))
  .extract({ left: 60, top: 0, width: W - 580, height: H })
  .extend({ left: 580, background: '#000' })
  .ensureAlpha()
  .composite([
    {
      input: svg(
        `<polygon points="${SEAM_TOP},0 ${W},0 ${W},${H} ${SEAM_BOTTOM},${H}" fill="#fff"/>`,
      ),
      blend: 'dest-in',
    },
  ])
  .png()
  .toBuffer();
const shade = svg(
  `<defs><linearGradient id="low" x1="0" y1="0" x2="0" y2="1"><stop offset="0.42" stop-color="#070b24" stop-opacity="0"/><stop offset="0.8" stop-color="#070b24" stop-opacity="0.82"/><stop offset="1" stop-color="#070b24" stop-opacity="0.94"/></linearGradient><linearGradient id="high" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#070b24" stop-opacity="0.5"/><stop offset="0.2" stop-color="#070b24" stop-opacity="0"/></linearGradient><linearGradient id="seam" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${H}"><stop offset="0.5" stop-color="#f6d36b"/><stop offset="0.66" stop-color="#f6d36b" stop-opacity="0"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#high)"/><rect width="${W}" height="${H}" fill="url(#low)"/><line x1="${SEAM_TOP}" y1="-4" x2="${SEAM_BOTTOM}" y2="${H + 4}" stroke="url(#seam)" stroke-width="5"/>`,
);
const address = await text(
  '<span foreground="#f6d36b" letter_spacing="1536">gogh-xr.pardev.net</span>',
  22,
);
const share = await sharp(night)
  .composite([
    { input: cafe, left: 0, top: 0 },
    { input: shade, left: 0, top: 0 },
    { input: await renderIcon('icon.svg', 132), left: 64, top: 434 },
    {
      input: await text('<span foreground="#fff3c4" letter_spacing="3072">Gogh XR</span>', 84),
      left: 224,
      top: 426,
    },
    {
      input: await text(
        '<span foreground="#e8ecff">Step inside Van Gogh’s paintings in VR</span>',
        34,
      ),
      left: 226,
      top: 524,
    },
    {
      input: await text(
        '<span foreground="#aebbe8" letter_spacing="1024">WebXR  ·  Meta Quest 3  ·  The Starry Night  ·  Café Terrace at Night</span>',
        20,
      ),
      left: 226,
      top: 578,
    },
    { input: address, left: W - 64 - ((await sharp(address).metadata()).width ?? 0), top: 40 },
  ])
  .jpeg({ quality: 88, mozjpeg: true })
  .toBuffer();
write(SHARE_IMAGE.file, share, `${W} x ${H} share image from the two captures and icon.svg`);

const hash = (path: string): string => sha256Of(readFileSync(resolve(root, path)));
const sourceRole = (name: string): string =>
  name.endsWith('.svg') ? 'source art, hand-authored' : 'source capture (capture-share.ts)';
const table = [
  START,
  '| file | SHA-256 | role |',
  '| --- | --- | --- |',
  ...SOURCE_FILES.map((name) => {
    const path = `${SOURCE_DIR}/${name}`;
    return `| \`${path}\` | ${hash(path)} | ${sourceRole(name)} |`;
  }),
  ...written.map((file) => `| \`${file.path}\` | ${hash(file.path)} | ${file.role} |`),
  END,
].join('\n');
const provenancePath = resolve(root, 'assets/PROVENANCE.md');
const markdown = readFileSync(provenancePath, 'utf8');
if (!markdown.includes(START) || !markdown.includes(END)) {
  throw new Error(`assets/PROVENANCE.md has no ${START} block`);
}
writeFileSync(
  provenancePath,
  markdown.slice(0, markdown.indexOf(START)) +
    table +
    markdown.slice(markdown.indexOf(END) + END.length),
);
console.log(`site: wrote ${written.length} files and ${SOURCE_FILES.length + written.length} rows`);
