/**
 * The motion A/B variant probe (src/motion/variants.ts, docs/verification.md, "Sky wrap and cypress
 * sway variants"). Headless Chromium on the GPU at 1280 × 1014 with the e2e suite's launch flags,
 * against a running `--mode e2e` build (`make preview`), because `?motiont` and `__goghMotionT` only
 * exist there.
 *
 *   bun scripts/motion-variant-probe.ts capture <base-url> <out-dir> [extra-query]
 *   bun scripts/motion-variant-probe.ts measure <base-url> [name-part]
 *
 * `capture` writes the byte-compare PNGs (the `?noanim` painter view, the painter view at two pinned
 * times, and one sky and one cypress pose at a pinned time) with `extra-query` appended, so two
 * builds, or a build with and without `&wrap=base&flame=base`, can be compared byte for byte.
 * `measure` boots each variant with `?wrap=` or `?flame=` and prints, per variant: the bare share
 * under `?coverage` at the sky and cypress poses over pinned times (the worst shown), the share of
 * drawn sky strokes below 0.8 of their rest size (and above 0.2 fade weight) at motiont 3.7 from
 * `__goghDiag().wrap`, and the per-pixel temporal flicker (`temporalFlicker`) at the sky poses over
 * 12 frames stepped at 1/72 s of motion time, and over 8 frames of seeded 0.1-0.3 mm eye jitter at a
 * pinned time (the shimmer probe's jitter). It follows the host load rule: before a capture run and
 * before each variant's measurement it waits, at most 15 minutes, for a 1-minute load average of
 * 15 or less, and it records the load before and after.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import sharp from 'sharp';
import { gpuArgs } from '../tests/e2e/gpu.ts';
import { temporalFlicker } from './zfight-lib.ts';

const [mode, base, out, extra = ''] = process.argv.slice(2);
if ((mode !== 'capture' && mode !== 'measure') || !base || (mode === 'capture' && !out)) {
  console.error(
    'usage: bun scripts/motion-variant-probe.ts capture <base-url> <out-dir> [extra] | measure <base-url> [name-part]',
  );
  process.exit(2);
}

const WIDTH = 1280;
const HEIGHT = 1014;
const MAX_LOAD = 15;
const LOAD_WAIT_MS = 15 * 60_000;

/** Name, eye position, yaw (0 faces -Z, left positive) and pitch, as `__goghPose` takes. */
type Pose = readonly [string, number, number, number, number, number];
const SKY_POSES: readonly Pose[] = [
  ['spot ahead', 0, 1.6, 0, 0, 0],
  ['spot behind', 0, 1.6, 0, Math.PI, 0],
  ['spot left, raised', 0, 1.6, 0, Math.PI / 2, 0.25],
  ['spot straight up', 0, 1.6, 0, 0, Math.PI / 2],
  ['boundary north-east', 32, -2.52, -28, -Math.PI / 4, 0.1],
];
/** The cypress poses: from the spot toward it, under it, and side on, looking along the wind. */
const CYPRESS_POSES: readonly Pose[] = [
  ['spot toward the cypress', 0, 1.6, 0, 0.383, 0.25],
  ['under the cypress', -6, -2.03, -5, -0.56, 0.4],
  ['cypress side on', -12.09, -3.02, -5.92, -1.188, 0.35],
];
const SKY_TIMES = [0.5, 2.3, 3.7, 6.1, 9.9];
/** A pose's eye and heading, as `__goghPose` takes them. */
const at = (p: Pose): number[] => [p[1], p[2], p[3], p[4], p[5]];
const CYPRESS_TIMES = Array.from({ length: 12 }, (_, k) => 0.5 + k);

async function waitForLoad(): Promise<number> {
  const start = Date.now();
  while (loadavg()[0] > MAX_LOAD && Date.now() - start < LOAD_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  return loadavg()[0];
}

async function boot(page: Page, query: string): Promise<void> {
  const url = new URL(base);
  url.search = `?${query}`;
  await page.goto(url.href);
  await page.waitForFunction(
    () => Boolean(window.__goghShot && window.__goghDiag?.().world),
    null,
    { timeout: 240_000 },
  );
  await frames(page, 5);
}

async function frames(page: Page, n: number): Promise<void> {
  const frame = (): Promise<number> =>
    page.evaluate(() => {
      const diag = window.__goghDiag;
      if (!diag) throw new Error('__goghDiag is not installed');
      return (diag().renderer as { frame: number }).frame;
    });
  const start = await frame();
  while ((await frame()) < start + n) await page.waitForTimeout(10);
}

async function pose(page: Page, p: readonly number[]): Promise<void> {
  await page.evaluate((q) => window.__goghPose?.(q[0], q[1], q[2], q[3], q[4]), [...p]);
  await frames(page, 3);
}

async function time(page: Page, t: number): Promise<void> {
  await page.evaluate((s) => window.__goghMotionT?.(s), t);
  await frames(page, 3);
}

async function png(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => window.__goghShot?.() ?? '');
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
}

async function raw(page: Page): Promise<Buffer> {
  return sharp(await png(page))
    .removeAlpha()
    .raw()
    .toBuffer();
}

/** The share of mostly magenta pixels, as tests/e2e/world-coverage.spec.ts counts them. */
async function bare(page: Page): Promise<number> {
  const data = await raw(page);
  let n = 0;
  for (let i = 0; i < data.length; i += 3) {
    if (data[i] > 192 && data[i + 1] < 64 && data[i + 2] > 192) n++;
  }
  return n / (data.length / 3);
}

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

function jitter(p: readonly number[], n: number): number[][] {
  const r = rng(0x5eed);
  const mm = (): number => (r() < 0.5 ? -1 : 1) * (0.0001 + 0.0002 * r());
  const deg = (): number => (r() * 2 - 1) * ((0.01 * Math.PI) / 180);
  return Array.from({ length: n }, () => [
    p[0] + mm(),
    p[1] + mm(),
    p[2] + mm(),
    p[3] + deg(),
    p[4] + deg(),
  ]);
}

const pct = (x: number): string => `${(x * 100).toFixed(3)}%`;

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  if (mode === 'capture') {
    mkdirSync(out, { recursive: true });
    const world = 'painting=starry-night&seed=1&diag&shot&nogov';
    const shots: readonly [string, string, Pose | null][] = [
      ['painter-noanim', `${world}&painter&noanim`, null],
      ['painter-t0.5', `${world}&painter&motiont=0.5`, null],
      ['painter-t3.7', `${world}&painter&motiont=3.7`, null],
      ['sky-up-t3.7', `${world}&motiont=3.7`, ['sky up', 0, 1.6, 0, 0, 0.9]],
      ['cypress-under-t3.7', `${world}&motiont=3.7`, ['under', -6, -2.03, -5, -0.56, 0.4]],
    ];
    const before = await waitForLoad();
    for (const [name, query, spot] of shots) {
      await boot(page, `${query}${extra}`);
      if (spot) await pose(page, at(spot));
      // A group named by ?ab shows the HUD at boot: hide it for the capture.
      const hud = await page.evaluate(() => window.__goghDiag?.().hud as { visible: boolean });
      if (hud?.visible) {
        await page.keyboard.press('h');
        await frames(page, 5);
      }
      writeFileSync(join(out, `${name}.png`), await png(page));
      console.log(`captured ${name}`);
    }
    console.log(`capture load ${before.toFixed(1)} → ${loadavg()[0].toFixed(1)}`);
  } else {
    const variants: readonly [string, string][] = [
      ['wrap base', 'wrap=base'],
      ['wrap fade', 'wrap=fade'],
      ['wrap half', 'wrap=half'],
      ['flame base', 'flame=base'],
      ['flame wind', 'flame=wind'],
    ];
    // `measure <base-url> <name-part>` measures only the variants whose name contains it.
    for (const [name, flag] of variants.filter(([n]) => n.includes(out ?? ''))) {
      const isWrap = flag.startsWith('wrap');
      const before = await waitForLoad();
      // Coverage at the poses of the group's layer, over pinned times.
      await boot(page, `painting=starry-night&seed=1&diag&shot&coverage&motiont=0.5&${flag}`);
      const poses = isWrap ? SKY_POSES : CYPRESS_POSES;
      const times = isWrap ? SKY_TIMES : CYPRESS_TIMES;
      const coverage: string[] = [];
      let worst = 0;
      for (const p of poses) {
        await pose(page, at(p));
        let poseWorst = 0;
        let worstAt = times[0];
        for (const t of times) {
          await time(page, t);
          const b = await bare(page);
          if (b > poseWorst) {
            poseWorst = b;
            worstAt = t;
          }
        }
        worst = Math.max(worst, poseWorst);
        coverage.push(`${p[0]} ${pct(poseWorst)} @${worstAt}`);
      }
      console.log(`${name} coverage worst ${pct(worst)}: ${coverage.join('; ')}`);
      if (isWrap) {
        // Size modulation and flicker at the sky poses, without ?coverage.
        await boot(page, `painting=starry-night&seed=1&diag&shot&motiont=3.7&${flag}`);
        const sizes: string[] = [];
        const flicker: string[] = [];
        for (const p of SKY_POSES) {
          await pose(page, at(p));
          await time(page, 3.7);
          const w = await page.evaluate(
            () => window.__goghDiag?.().wrap as { drawn: number; small: number; faded: number },
          );
          sizes.push(`${p[0]} ${pct(w.small / w.drawn)} small, ${pct(w.faded / w.drawn)} faded`);
          const stepped: Buffer[] = [];
          for (let k = 0; k < 12; k++) {
            await time(page, 3.7 + k / 72);
            stepped.push(await raw(page));
          }
          const motion = temporalFlicker(stepped, WIDTH, HEIGHT);
          await time(page, 3.7);
          const jittered: Buffer[] = [];
          for (const q of jitter(at(p), 8)) {
            await pose(page, q);
            jittered.push(await raw(page));
          }
          const still = temporalFlicker(jittered, WIDTH, HEIGHT);
          flicker.push(
            `${p[0]} motion ${motion.flicker.toFixed(3)} / ${motion.perFrame.toFixed(3)} / ${motion.clustered.toFixed(3)}, jitter ${still.flicker.toFixed(3)} / ${still.perFrame.toFixed(3)} / ${still.clustered.toFixed(3)}`,
          );
        }
        console.log(`${name} size at motiont 3.7: ${sizes.join('; ')}`);
        console.log(`${name} flicker (flicker / per frame / clustered, %): ${flicker.join('; ')}`);
      }
      console.log(`${name} load ${before.toFixed(1)} → ${loadavg()[0].toFixed(1)}`);
    }
  }
} finally {
  await browser.close();
}
