/**
 * Captures a `?diag&shot` frame of a running build to a PNG, in headless Chromium on the GPU
 * (the e2e suite's launch flags, `PW_GPU=swiftshader` for software GL).
 *
 *   bun scripts/capture-shot.ts <url> <out.png> [--size 1600x1200] [--wait canvas]
 *
 * The url must carry `diag` and `shot`. `--wait` names a `__goghDiag()` key to wait for before the
 * capture, for scenes that build asynchronously (`canvas` for `?demo=canvas`).
 */
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { gpuArgs } from '../tests/e2e/gpu.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const size = option('size') ?? '1600x1200';
const waitKey = option('wait');
const [url, out] = args;
if (!url || !out) {
  console.error('usage: bun scripts/capture-shot.ts <url> <out.png> [--size WxH] [--wait key]');
  process.exit(2);
}
const [width, height] = size.split('x').map(Number);

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('console', (message) => {
    // Chromium requests a favicon the app does not ship.
    if (new URL(message.location().url || 'about:blank').pathname === '/favicon.ico') return;
    if (message.type() === 'error') errors.push(message.text());
    if (message.type() === 'warning') console.warn(`capture-shot: page warning: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    (key) => {
      const diag = window.__goghDiag?.();
      return Boolean(window.__goghShot && diag && (key === null || diag[key] !== undefined));
    },
    waitKey ?? null,
    { timeout: 60_000 },
  );
  // Let a few frames render after the build so the batch has culled and banded.
  const frame = () =>
    page.evaluate(() => {
      const diag = window.__goghDiag;
      if (!diag) throw new Error('__goghDiag is not installed; capture with ?diag');
      return (diag().renderer as { frame: number }).frame;
    });
  const start = await frame();
  while ((await frame()) < start + 5) await page.waitForTimeout(50);
  const diag = await page.evaluate(() => window.__goghDiag?.());
  const dataUrl = await page.evaluate(() => window.__goghShot?.() ?? '');
  // Lossless re-encode: the canvas is opaque, and zlib 9 with adaptive filtering cuts about 20%.
  const png = await sharp(Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'))
    .removeAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  writeFileSync(out, png);
  const renderer = (diag?.renderer as { unmaskedRenderer?: string } | undefined)?.unmaskedRenderer;
  console.log(`capture-shot: wrote ${out} (${width}x${height}) on ${renderer}`);
  if (waitKey) console.log(`capture-shot: ${waitKey} ${JSON.stringify(diag?.[waitKey])}`);
  if (errors.length > 0) {
    console.error(`capture-shot: page errors:\n${errors.join('\n')}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
