/**
 * Headset-shimmer probe: renders the Starry Night world for N consecutive frames per pose with
 * sub-millimetre eye jitter like a headset's tracking noise (0.1-0.3 mm per axis and about 0.01° of
 * yaw and pitch, from a fixed seeded sequence), once per `?zdiag` mode, and prints the per-pixel
 * temporal flicker (`temporalFlicker` in `scripts/zfight-lib.ts`). Headless Chromium on the GPU at
 * 1280 × 1014 with the e2e suite's launch flags. Results: docs/verification.md, headset shimmer.
 *
 *   bun scripts/shimmer-probe.ts <base-url> [frames] [mode,mode,...]
 *
 * The base url is a running build, for example `vite preview` of `make build`. Mode `base` is no
 * `?zdiag`. The default modes are every desktop-meaningful one: `freeze` only acts in XR.
 */
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { gpuArgs } from '../tests/e2e/gpu.ts';
import { temporalFlicker } from './zfight-lib.ts';

const base = process.argv[2];
if (!base) {
  console.error('usage: bun scripts/shimmer-probe.ts <base-url> [frames] [modes]');
  process.exit(2);
}
const FRAMES = Number(process.argv[3] ?? 10);
const MODES = (
  process.argv[4] ?? 'base,strokeorder,paintorder,nowrite,nosort,noa2c,nomip,mip'
).split(',');
/** `norot` as the fourth argument drops the rotation jitter, leaving the 0.1-0.3 mm translation. */
const ROTATE = process.argv[5] !== 'norot';

/** Name, eye position and heading (yaw 0 faces -Z, pitch up positive), as `__goghPose` takes. */
const POSES: readonly (readonly [string, number, number, number, number, number])[] = [
  ['ground', 0, 1.6, 0, 0, -0.45],
  ['paul-strobe1', 0.067, 1.551, 0, -0.571, -0.26],
  ['village', 0, 1.6, 0, 0.6, -0.1],
  ['wall', 9.04, -3.27, -30.74, -0.286, 0.25],
  ['ridge', 0, 1.6, 0, -0.7, 0.05],
  ['sky', 0, 1.6, 0, 0, 0.5],
];

/** mulberry32: the fixed jitter sequence, the same for every mode. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Jittered poses: each axis offset by ±(0.1-0.3) mm, yaw and pitch by up to ±0.01°. */
function jitterSequence(pose: readonly number[], n: number, seed: number): number[][] {
  const r = rng(seed);
  const mm = (): number => (r() < 0.5 ? -1 : 1) * (0.0001 + 0.0002 * r());
  const deg = (): number => (ROTATE ? 1 : 0) * (r() * 2 - 1) * ((0.01 * Math.PI) / 180);
  return Array.from({ length: n }, () => [
    pose[0] + mm(),
    pose[1] + mm(),
    pose[2] + mm(),
    pose[3] + deg(),
    pose[4] + deg(),
  ]);
}

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
try {
  for (const mode of MODES) {
    const url = new URL(base);
    url.search = `?painting=starry-night&diag&shot&nogov&nocache${mode === 'base' ? '' : `&zdiag=${mode}`}`;
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1014 },
      deviceScaleFactor: 1,
    });
    await page.goto(url.href);
    await page.waitForFunction(
      () => Boolean(window.__goghShot && window.__goghDiag?.().world),
      null,
      { timeout: 180_000 },
    );
    const active = await page.evaluate(() => window.__goghDiag?.().zdiag);
    const frame = (): Promise<number> =>
      page.evaluate(() => {
        const diag = window.__goghDiag;
        if (!diag) throw new Error('__goghDiag is not installed');
        return (diag().renderer as { frame: number }).frame;
      });
    const shot = async (pose: readonly number[]): Promise<Buffer> => {
      await page.evaluate((p) => window.__goghPose?.(p[0], p[1], p[2], p[3], p[4]), [...pose]);
      const start = await frame();
      while ((await frame()) < start + 3) await page.waitForTimeout(20);
      const dataUrl = await page.evaluate(() => window.__goghShot?.() ?? '');
      const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
      return sharp(png).removeAlpha().raw().toBuffer();
    };
    const rows: Record<string, string> = {};
    for (const [name, ...pose] of POSES) {
      const frames: Buffer[] = [];
      for (const p of jitterSequence(pose, FRAMES, 0x5eed)) frames.push(await shot(p));
      const still = temporalFlicker(
        [frames[0], await shot(jitterSequence(pose, 1, 0x5eed)[0])],
        1280,
        1014,
      );
      const f = temporalFlicker(frames, 1280, 1014);
      rows[name] =
        `${f.flicker.toFixed(3)} / ${f.perFrame.toFixed(3)} / ${f.clustered.toFixed(3)}` +
        (still.flicker > 0 ? ` (still ${still.flicker.toFixed(3)})` : '');
    }
    console.log(mode, JSON.stringify(active), JSON.stringify(rows));
    await page.close();
  }
} finally {
  await browser.close();
}
