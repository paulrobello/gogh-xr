/**
 * Halo over world-stroke overhang (docs/verification.md, nowrite default, N2): captures the Starry
 * Night world with and without the star and moon halo (`?nohalo`), under the default policy and
 * under `?zdiag=write`, at the painter view and at given poses. The halo shows where the two
 * captures differ. A pixel where the halo shows under the default but not under `write` is one
 * where a world stroke wrote depth in front of the halo under `write`, and the halo now paints
 * over it. Headless Chromium on the GPU at the canvas aspect (CAPTURE_SIZE), motion off.
 *
 *   bun scripts/halo-overhang.ts <base-url> [out-dir]
 */
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { gpuArgs } from '../tests/e2e/gpu.ts';
import { COVERAGE_POSES } from '../tests/world-poses.ts';
import { CAPTURE_SIZE } from './fidelity-io.ts';

const base = process.argv[2];
if (!base) {
  console.error('usage: bun scripts/halo-overhang.ts <base-url> [out-dir]');
  process.exit(2);
}
const outDir = process.argv[3] ?? '';
const VIEWS = ['painter', 'hill west', 'under the cypress'] as const;
/** Summed RGB difference above which a pixel counts as changed. */
const THRESHOLD = 6;

type Raw = { data: Buffer; width: number; height: number };
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });

async function capture(view: string, query: string): Promise<Raw> {
  const page = await browser.newPage({
    viewport: CAPTURE_SIZE,
    deviceScaleFactor: 1,
  });
  const painter = view === 'painter' ? '&painter' : '';
  const url = new URL(base);
  url.search = `?painting=starry-night&diag&shot&nogov&nocache&noanim&seed=1${painter}${query}`;
  await page.goto(url.href);
  await page.waitForFunction(
    () => Boolean(window.__goghShot && window.__goghDiag?.().world),
    null,
    {
      timeout: 120_000,
    },
  );
  const pose = COVERAGE_POSES.find((p) => p.name === view);
  if (pose) {
    await page.evaluate(
      (p) => window.__goghPose?.(p[0], p[1], p[2], p[3], p[4]),
      [...pose.position, pose.yaw, pose.pitch],
    );
  }
  const frame = (): Promise<number> =>
    page.evaluate(
      () => (window.__goghDiag?.().renderer as { frame: number } | undefined)?.frame ?? 0,
    );
  const start = await frame();
  while ((await frame()) < start + 6) await page.waitForTimeout(30);
  const dataUrl = await page.evaluate(() => window.__goghShot?.() ?? '');
  await page.close();
  const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function changed(a: Raw, b: Raw): Uint8Array {
  const n = a.width * a.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d =
      Math.abs(a.data[i * 3] - b.data[i * 3]) +
      Math.abs(a.data[i * 3 + 1] - b.data[i * 3 + 1]) +
      Math.abs(a.data[i * 3 + 2] - b.data[i * 3 + 2]);
    out[i] = d > THRESHOLD ? 1 : 0;
  }
  return out;
}

try {
  for (const view of VIEWS) {
    const shots: Record<string, Raw> = {};
    for (const [name, q] of [
      ['base', ''],
      ['base-nohalo', '&nohalo'],
      ['write', '&zdiag=write'],
      ['write-nohalo', '&zdiag=write&nohalo'],
    ] as const) {
      shots[name] = await capture(view, q);
    }
    const haloBase = changed(shots.base, shots['base-nohalo']);
    const haloWrite = changed(shots.write, shots['write-nohalo']);
    const n = haloBase.length;
    let inBase = 0;
    let inWrite = 0;
    let onlyBase = 0;
    let onlyWrite = 0;
    const mask = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) {
      inBase += haloBase[i];
      inWrite += haloWrite[i];
      if (haloBase[i] && !haloWrite[i]) {
        onlyBase++;
        mask[i * 3] = 255;
      }
      if (haloWrite[i] && !haloBase[i]) {
        onlyWrite++;
        mask[i * 3 + 2] = 255;
      }
      if (haloBase[i] && haloWrite[i]) mask[i * 3 + 1] = 120;
    }
    const pct = (v: number): string => ((100 * v) / n).toFixed(3);
    console.log(
      JSON.stringify({
        view,
        haloBasePct: pct(inBase),
        haloWritePct: pct(inWrite),
        onlyBasePct: pct(onlyBase),
        onlyWritePct: pct(onlyWrite),
      }),
    );
    if (outDir) {
      const { width, height } = shots.base;
      const slug = view.replace(/\s+/g, '-');
      await sharp(mask, { raw: { width, height, channels: 3 } })
        .png()
        .toFile(`${outDir}/halo-${slug}-mask.png`);
      for (const [name, raw] of Object.entries(shots)) {
        await sharp(raw.data, { raw: { width, height, channels: 3 } })
          .png()
          .toFile(`${outDir}/halo-${slug}-${name}.png`);
      }
    }
  }
} finally {
  await browser.close();
}
