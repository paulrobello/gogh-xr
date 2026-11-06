/**
 * Stroke-flicker probe: captures the Starry Night world at four painter's-spot poses, then at each
 * pose again unmoved and shifted 0.1 mm and 1 mm along x, and prints the share of pixels that
 * change (`scripts/zfight-lib.ts`) over the frame and per screen third. A head that sways by a
 * fraction of a millimetre moves almost nothing by parallax, so a large flip share there is
 * overlapping strokes trading depth order. Headless Chromium on the GPU at 1280 × 1014, with the
 * e2e suite's launch flags (`PW_GPU=swiftshader` for software GL). Results: docs/verification.md,
 * stroke flicker.
 *
 *   bun scripts/zfight-probe.ts <base-url>
 *
 * The base url is a running build, for example http://localhost:4252/ under `make dev`.
 */
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { gpuArgs } from '../tests/e2e/gpu.ts';
import { type FlipPercent, flipPercent } from './zfight-lib.ts';

const base = process.argv[2];
if (!base) {
  console.error('usage: bun scripts/zfight-probe.ts <base-url>');
  process.exit(2);
}
const url = new URL(base);
url.search = '?painting=starry-night&diag&shot&nogov&nocache';

/** Name, eye position and heading (yaw 0 faces -Z, pitch up positive), as `__goghPose` takes. */
const POSES: readonly (readonly [string, number, number, number, number, number])[] = [
  ['painter-level', 0, 1.6, 0, 0, 0],
  ['painter-down', 0, 1.6, 0, 0, -0.25],
  ['village-look', 0, 1.6, 0, 0.6, -0.1],
  ['back', 0, 1.6, 0, Math.PI, -0.1],
];

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1014 },
    deviceScaleFactor: 1,
  });
  await page.goto(url.href);
  await page.waitForFunction(
    () => Boolean(window.__goghShot && window.__goghDiag?.().world),
    null,
    {
      timeout: 120_000,
    },
  );

  const frame = (): Promise<number> =>
    page.evaluate(() => {
      const diag = window.__goghDiag;
      if (!diag) throw new Error('__goghDiag is not installed');
      return (diag().renderer as { frame: number }).frame;
    });
  const shot = async (
    pose: readonly number[],
  ): Promise<{ data: Buffer; width: number; height: number }> => {
    await page.evaluate((p) => window.__goghPose?.(p[0], p[1], p[2], p[3], p[4]), [...pose]);
    const start = await frame();
    while ((await frame()) < start + 4) await page.waitForTimeout(30);
    const dataUrl = await page.evaluate(() => window.__goghShot?.() ?? '');
    const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    const { data, info } = await sharp(png)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  };
  const fixed = (p: FlipPercent): Record<keyof FlipPercent, string> => ({
    all: p.all.toFixed(3),
    top: p.top.toFixed(3),
    mid: p.mid.toFixed(3),
    bottom: p.bottom.toFixed(3),
  });

  for (const [name, x, y, z, yaw, pitch] of POSES) {
    const a = await shot([x, y, z, yaw, pitch]);
    const flips = (b: { data: Buffer }): Record<keyof FlipPercent, string> =>
      fixed(flipPercent(a.data, b.data, a.width, a.height));
    const same = flips(await shot([x, y, z, yaw, pitch]));
    const shift01mm = flips(await shot([x + 0.0001, y, z, yaw, pitch]));
    const shift1mm = flips(await shot([x + 0.001, y, z, yaw, pitch]));
    console.log(name, JSON.stringify({ same, shift01mm, shift1mm }));
  }
} finally {
  await browser.close();
}
