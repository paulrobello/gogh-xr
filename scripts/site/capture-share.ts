/**
 * Captures the share image's source frames from a served build, in headless Chromium on the GPU.
 *
 *   bun scripts/site/capture-share.ts <base-url> [out-dir] [--only id] [--pose x,y,z,yaw,pitch] [--size 2400x1260]
 *
 * Each shot boots a world with `?diag&shot&noanim`, places the desktop eye with `__goghPose` and
 * writes `<out-dir>/share-<id>.jpg` (default `assets/site`). `scripts/site/generate.ts` composes
 * them and records their hashes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { gpuArgs } from '../../tests/e2e/gpu.ts';

interface Shot {
  id: string;
  query: string;
  /** `__goghDiag()` key that marks the world built. */
  wait: string;
  /** Eye x, y, z, yaw and pitch for `__goghPose`. */
  pose: readonly [number, number, number, number, number];
}

export const SHOTS: readonly Shot[] = [
  {
    id: 'starry-night',
    query: 'painting=starry-night',
    wait: 'world',
    pose: [-1, 1.8, 1, -0.08, 0.24],
  },
  {
    id: 'cafe-terrace',
    query: 'painting=cafe-terrace-at-night',
    wait: 'world',
    pose: [1.2, 1.6, -1.5, -0.1, 0.1],
  },
];

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const only = option('only');
const poseOverride = option('pose');
const [width, height] = (option('size') ?? '2400x1260').split('x').map(Number) as [number, number];
const [base, outDir = 'assets/site'] = args;
if (!base) {
  console.error('usage: bun scripts/site/capture-share.ts <base-url> [out-dir] [--only id]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
try {
  for (const shot of SHOTS) {
    if (only && shot.id !== only) continue;
    const pose = poseOverride ? poseOverride.split(',').map(Number) : shot.pose;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(`${base}/?diag&shot&noanim&nocache&${shot.query}`);
    await page.waitForFunction(
      (key) => Boolean(window.__goghShot && window.__goghDiag?.()[key] !== undefined),
      shot.wait,
      { timeout: 120_000 },
    );
    await page.evaluate((p) => window.__goghPose?.(p[0], p[1], p[2], p[3], p[4]), pose as number[]);
    const frame = () =>
      page.evaluate(() => {
        const diag = window.__goghDiag;
        if (!diag) throw new Error('__goghDiag is not installed');
        return (diag().renderer as { frame: number }).frame;
      });
    const start = await frame();
    while ((await frame()) < start + 8) await page.waitForTimeout(50);
    const dataUrl = await page.evaluate(() => window.__goghShot?.() ?? '');
    const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    const out = join(outDir, `share-${shot.id}.jpg`);
    writeFileSync(
      out,
      await sharp(png).removeAlpha().jpeg({ quality: 92, mozjpeg: true }).toBuffer(),
    );
    console.log(`capture-share: wrote ${out} (${width}x${height}) pose ${pose.join(', ')}`);
    await page.close();
  }
} finally {
  await browser.close();
}
