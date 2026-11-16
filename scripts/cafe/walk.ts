/**
 * Captures the café from a walk around it, to judge the set away from the painter's spot.
 *
 *   bun scripts/cafe/walk.ts <base-url> <out-dir> [--size 1280x720] [--only name,name]
 *
 * Writes one JPEG per pose and `sheet.jpg`, all of them tiled. The poses are eye positions with
 * yaw (0 faces -Z, positive turns left) and pitch, as `__goghPose` takes them.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { gpuArgs } from '../../tests/e2e/gpu.ts';

export const WALK_POSES: Record<string, readonly [number, number, number, number, number]> = {
  painter: [0, 1.6, 0, 0, 0],
  'terrace-edge': [0.4, 1.6, -6.5, 0.9, 0],
  'under-awning': [-1.6, 1.6, -9, 0.35, 0.25],
  'among-tables': [-1.2, 1.6, -11, 1.2, -0.1],
  'facade-oblique': [-0.9, 1.6, -3.2, 0.5, 0.2],
  'street-back': [2.6, 1.6, -19, 2.6, 0.1],
  'street-side': [4.8, 1.6, -10, 1.45, 0.1],
  'shop-side': [3, 1.6, -14, -1.2, 0.1],
  'far-street': [1.5, 1.6, -22, 0.1, 0.1],
  'look-back': [0.5, 1.6, -8, 3.0, 0.05],
  'low-tables': [0.2, 0.9, -8.5, 1.0, 0],
  'bar-room': [-4.3, 1.67, -11.3, 0.9, 0],
  'from-bar': [-4.6, 1.67, -11.3, -1.6, 0],
  shopfront: [0.6, 1.6, -3.4, 1.35, 0.05],
  flight: [3.5, 9, -4, 0.75, -0.55],
  // The poses of the Quest screenshots that found painted-on textures.
  seating: [0.6, 1.6, -3.6, 0.2, -0.05],
  'tree-trunk': [2.6, 1.6, -7.6, -1.0, 0.3],
  alley: [2.6, 1.6, -24, 0.05, 0.05],
  'wing-door': [1.3, 1.3, -23, 0.95, -0.15],
  'tree-above': [1.4, 1.6, -11.5, -1.25, 0.85],
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const [width, height] = (option('size') ?? '1280x720').split('x').map(Number);
  const only = option('only')?.split(',');
  const [base, out] = args;
  if (!base || !out) {
    console.error('usage: bun scripts/cafe/walk.ts <base-url> <out-dir> [--size WxH] [--only a,b]');
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) {
        errors.push(message.text());
      }
    });
    await page.goto(`${base}/?painting=cafe-terrace-at-night&diag&shot&noanim&mute`);
    await page.waitForFunction(() => window.__goghShot && window.__goghDiag?.().world, null, {
      timeout: 120_000,
    });
    const names = Object.keys(WALK_POSES).filter((name) => !only || only.includes(name));
    const tiles: { input: Buffer; left: number; top: number }[] = [];
    const columns = Math.min(3, names.length);
    const tile = { width: Math.round(width / 2), height: Math.round(height / 2) };
    for (const [i, name] of names.entries()) {
      await page.evaluate(
        (pose) => (window as unknown as { __goghPose(...p: number[]): void }).__goghPose(...pose),
        [...WALK_POSES[name]],
      );
      const frame = (): Promise<number> =>
        page.evaluate(() => {
          const diag = window.__goghDiag;
          if (!diag) throw new Error('__goghDiag is not installed');
          return (diag().renderer as { frame: number }).frame;
        });
      const start = await frame();
      while ((await frame()) < start + 4) await page.waitForTimeout(40);
      const dataUrl = await page.evaluate(() => window.__goghShot?.() ?? '');
      const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
      await sharp(png)
        .removeAlpha()
        .jpeg({ quality: 88 })
        .toFile(join(out, `${name}.jpg`));
      tiles.push({
        input: await sharp(png).removeAlpha().resize(tile.width, tile.height).toBuffer(),
        left: (i % columns) * tile.width,
        top: Math.floor(i / columns) * tile.height,
      });
    }
    await sharp({
      create: {
        width: columns * tile.width,
        height: Math.ceil(names.length / columns) * tile.height,
        channels: 3,
        background: '#000',
      },
    })
      .composite(tiles)
      .jpeg({ quality: 86 })
      .toFile(join(out, 'sheet.jpg'));
    console.log(`walk: wrote ${names.length} poses to ${out}`);
    if (errors.length > 0) {
      console.error(`walk: page errors:\n${errors.join('\n')}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}
