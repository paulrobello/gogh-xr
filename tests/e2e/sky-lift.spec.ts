/**
 * The lift sky wrap (src/motion/variants.ts, docs/verification.md, Sky wrap variants: dive and
 * lift, where dive is superseded): selected by `?wrap=` and by the A/B button, drawing the rest
 * sky at `?noanim` and calm 0, the bare share of the sky under `?coverage` beside wave and base,
 * and, with SWIRL_STRIPS=1, the six-frame strips of the central swirl in docs/shots.
 */
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { CAPTURE_SIZE } from '../../scripts/fidelity-io.ts';
import { COVERAGE_POSES, type CoveragePose } from '../world-poses';
import { expect, glErrors, test, type Xr } from './fixtures';

test.use({ viewport: { width: CAPTURE_SIZE.width, height: CAPTURE_SIZE.height } });

const WORLD = 'painting=starry-night&seed=1&shot&nogov';
/** The most bare share the coverage sweep allows lift at any pose and time (P2-A3). */
const MAX_BARE = 0.005;

interface WrapDiag {
  wrap: string;
  drawn: number;
  small: number;
  cut: number;
  cutShare: number;
  returning: number;
  alignment: { within30: number; beyond60: number; median: number };
}

async function bootWorld(xr: Xr, query: string): Promise<void> {
  await xr.boot(`${WORLD}&${query}`);
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
    .toBe(true);
  await xr.waitFrames(5);
}

async function hideHud(page: Page, xr: Xr): Promise<void> {
  if (!((await xr.diag()).hud as { visible: boolean }).visible) return;
  await page.keyboard.press('h');
  await expect
    .poll(async () => ((await xr.diag()).hud as { visible: boolean }).visible)
    .toBe(false);
  await xr.waitFrames(5);
}

async function pressV(page: Page, xr: Xr): Promise<void> {
  // V is read per frame, so it is held across frames rather than tapped.
  await page.keyboard.down('KeyV');
  await xr.waitFrames(2);
  await page.keyboard.up('KeyV');
  await xr.waitFrames(2);
}

async function shotPng(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => {
    if (!window.__goghShot) throw new Error('__goghShot is not installed; boot with ?diag&shot');
    return window.__goghShot();
  });
  return Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64');
}

async function rawPixels(page: Page): Promise<Buffer> {
  return sharp(await shotPng(page))
    .raw()
    .toBuffer();
}

async function motionT(page: Page, xr: Xr, time: number): Promise<void> {
  await page.evaluate((t) => {
    if (!window.__goghMotionT) throw new Error('__goghMotionT is e2e-only and needs ?motiont');
    window.__goghMotionT(t);
  }, time);
  await xr.waitFrames(3);
}

const load = (): string => loadavg()[0].toFixed(1);

test('lift: selected by ?wrap and by the A/B button, and the rest sky at noanim and calm 0', async ({
  page,
  xr,
}) => {
  test.setTimeout(480_000);
  console.log(`[e2e] sky lift selection: load ${load()} at start`);
  // The rest sky: every wrap draws it at ?noanim, and lift at calm 0 with the time pinned.
  await bootWorld(xr, 'painter&noanim');
  const rest = await rawPixels(page);
  for (const extra of ['wrap=lift&noanim', 'wrap=lift&calm=0&motiont=3.7']) {
    await bootWorld(xr, `painter&${extra}`);
    await hideHud(page, xr);
    expect((await rawPixels(page)).equals(rest), `${extra} draws the rest sky`).toBe(true);
  }

  // Each arm by ?wrap at a pinned time: the variant, the wrap diag, and a sky unlike the wave's.
  await bootWorld(xr, 'painter&motiont=3.7');
  const wave = await rawPixels(page);
  const shots: Record<string, Buffer> = {};
  const reports: string[] = [];
  for (const wrap of ['lift'] as const) {
    await bootWorld(xr, `painter&motiont=3.7&wrap=${wrap}`);
    await hideHud(page, xr);
    const diag = await xr.diag();
    expect((diag.variants as { wrap: string }).wrap).toBe(wrap);
    const w = diag.wrap as WrapDiag;
    expect(w.wrap).toBe(wrap);
    expect(w.drawn).toBeGreaterThan(1000);
    // Full width, forward only: no stroke below 0.8 of its size, none on its way back.
    expect([w.small, w.returning]).toEqual([0, 0]);
    // The share in transition: 2 × SKY_LIFT_WINDOW of the phase bytes, about 20%.
    expect(w.cutShare).toBeGreaterThan(0.15);
    expect(w.cutShare).toBeLessThan(0.25);
    reports.push(`${wrap} ${JSON.stringify(w)}`);
    shots[wrap] = await rawPixels(page);
    expect(shots[wrap].equals(wave), `${wrap} moves the sky its own way`).toBe(false);
  }
  console.log(`[e2e] sky lift wrap diag: ${reports.join('; ')}`);

  // By the A/B button: one press from wave reaches lift, from one boot.
  await bootWorld(xr, 'painter&motiont=3.7&ab=wrap');
  const ab = (await xr.diag()).ab as { variants: string[]; variant: string };
  expect(ab.variants).toEqual(['wave', 'lift', 'base', 'pingpong']);
  expect(ab.variant).toBe('wave');
  const programs = (await xr.diag()).renderer.programs;
  for (const [index, variant] of ['lift'].entries()) {
    await pressV(page, xr);
    const now = await xr.diag();
    expect(now.ab, variant).toMatchObject({ index: index + 1, variant });
    expect((now.variants as { wrap: string }).wrap).toBe(variant);
    expect((now.wrap as WrapDiag).wrap).toBe(variant);
    // A switch links no program.
    expect(now.renderer.programs).toBe(programs);
    await hideHud(page, xr);
    expect((await rawPixels(page)).equals(shots[variant]), `A/B ${variant} matches ?wrap`).toBe(
      true,
    );
  }
  expect(await glErrors(page)).toEqual([]);
  console.log(`[e2e] sky lift selection: load ${load()} at end`);
});

/** Mostly magenta pixels, as tests/e2e/world-coverage.spec.ts counts them. */
function bareShare(page: Page): Promise<number> {
  return bareShares(page, null).then((s) => s.frame);
}

/**
 * The bare share of the frame and, given a mask of the frame's sky pixels, of the sky alone. The
 * painter view is canvas uv [0, 1]², so the mask comes from regions.png (painterSkyMask).
 */
async function bareShares(
  page: Page,
  sky: { width: number; height: number; mask: Uint8Array; count: number } | null,
): Promise<{ frame: number; sky: number }> {
  const { width, height, bare } = await page.evaluate(() => {
    const gl = document.querySelector('canvas') as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = gl.width;
    copy.height = gl.height;
    const context = copy.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas context is not available');
    context.drawImage(gl, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    const bare: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 192 && data[i + 1] < 64 && data[i + 2] > 192) bare.push(i / 4);
    }
    return { width: copy.width, height: copy.height, bare };
  });
  if (!sky) return { frame: bare.length / (width * height), sky: Number.NaN };
  if (sky.width !== width || sky.height !== height) throw new Error('sky mask size mismatch');
  let inSky = 0;
  for (const i of bare) inSky += sky.mask[i];
  return { frame: bare.length / (width * height), sky: inSky / sky.count };
}

/** regions.png ids of the sky, its stars and the moon (REGION in src/demo/canvas/field.ts). */
const SKY_REGION_IDS = [0, 1, 2];

/** The painter view's sky pixels: regions.png (canvas uv [0, 1]², top row first) at frame size. */
async function painterSkyMask(
  width: number,
  height: number,
): Promise<{ width: number; height: number; mask: Uint8Array; count: number }> {
  const ids = await sharp('public/paintings/starry-night/regions.png')
    .extractChannel(0)
    .resize(width, height, { kernel: 'nearest', fit: 'fill' })
    .raw()
    .toBuffer();
  const mask = new Uint8Array(width * height);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (SKY_REGION_IDS.includes(ids[i])) {
      mask[i] = 1;
      count++;
    }
  }
  return { width, height, mask, count };
}

async function visit(page: Page, xr: Xr, { position, yaw, pitch }: CoveragePose): Promise<void> {
  await page.evaluate(
    ([x, y, z, h, p]) => {
      if (!window.__goghPose) throw new Error('__goghPose is not installed; boot with ?diag');
      window.__goghPose(x, y, z, h, p);
    },
    [...position, yaw, pitch] as const,
  );
  await xr.waitFrames(3);
}

test('coverage: the bare share of the sky at 8 motion times for wave, base and lift, at the painter view and two sky-heavy poses', async ({
  page,
  xr,
}) => {
  test.setTimeout(900_000);
  const poses = ['spot straight up', 'spot left, raised'].map((name) => {
    const pose = COVERAGE_POSES.find((p) => p.name === name);
    if (!pose) throw new Error(`no "${name}" pose`);
    return pose;
  });
  // One whole loop per wrap at 8 evenly spaced times, each stroke at its own phase byte: wave and
  // base 8 s, 1 s apart, and lift its own 4 s loop (SKY_LIFT_PERIOD, sky-swirl.ts), 0.5 s apart.
  const loopTimes = (wrap: string): number[] => {
    const period = wrap === 'lift' ? 4 : 8;
    return Array.from({ length: 8 }, (_, i) => ((i + 0.5) * period) / 8);
  };
  const rows: { wrap: string; view: string; shares: number[] }[] = [];
  // Of the sky alone, reported beside the whole-frame rows and not held to MAX_BARE, which is a
  // whole-frame limit.
  const skyRows: { wrap: string; view: string; shares: number[] }[] = [];
  let sky: Awaited<ReturnType<typeof painterSkyMask>> | null = null;
  for (const wrap of ['wave', 'base', 'lift']) {
    const times = loopTimes(wrap);
    const before = load();
    await bootWorld(xr, `coverage&painter&motiont=${times[0]}&wrap=${wrap}`);
    expect(((await xr.diag()).world as { debug: string }).debug).toBe('coverage');
    if (!sky) {
      const size = await page.evaluate(() => {
        const gl = document.querySelector('canvas') as HTMLCanvasElement;
        return [gl.width, gl.height];
      });
      sky = await painterSkyMask(size[0], size[1]);
      console.log(
        `[e2e] sky lift coverage: the painter sky mask is ${((sky.count / (size[0] * size[1])) * 100).toFixed(1)}% of the ${size[0]} x ${size[1]} frame`,
      );
    }
    const painter: number[] = [];
    const painterSky: number[] = [];
    for (const time of times) {
      await motionT(page, xr, time);
      const shares = await bareShares(page, sky);
      painter.push(shares.frame);
      painterSky.push(shares.sky);
    }
    rows.push({ wrap, view: 'painter', shares: painter });
    skyRows.push({ wrap, view: 'painter, of the sky', shares: painterSky });
    for (const pose of poses) {
      await visit(page, xr, pose);
      const shares: number[] = [];
      for (const time of times) {
        await motionT(page, xr, time);
        shares.push(await bareShare(page));
      }
      rows.push({ wrap, view: pose.name, shares });
    }
    console.log(`[e2e] sky lift coverage ${wrap}: load ${before} before, ${load()} after`);
  }
  for (const row of [...rows, ...skyRows]) {
    const pct = row.shares.map((s) => (s * 100).toFixed(3)).join(' ');
    const worst = Math.max(...row.shares);
    const mean = row.shares.reduce((a, b) => a + b, 0) / row.shares.length;
    console.log(
      `[e2e] sky lift coverage ${row.wrap} | ${row.view} | ${pct} | mean ${(mean * 100).toFixed(3)}% worst ${(worst * 100).toFixed(3)}%`,
    );
  }
  for (const row of rows) {
    if (row.wrap !== 'lift') continue;
    const times = loopTimes(row.wrap);
    row.shares.forEach((share, i) => {
      expect(share, `${row.wrap} ${row.view} at motiont ${times[i]}`).toBeLessThanOrEqual(MAX_BARE);
    });
  }
  expect(await glErrors(page)).toEqual([]);
});

test('strips: six frames 0.5 s apart of the central swirl for wave and lift, as JPEG (SWIRL_STRIPS=1)', async ({
  page,
  xr,
}) => {
  test.skip(process.env.SWIRL_STRIPS !== '1', 'writes docs/shots; run with SWIRL_STRIPS=1');
  test.setTimeout(300_000);
  const { width, height } = CAPTURE_SIZE;
  // The big central swirl, canvas uv (0.518, 0.335) with v down and radius 0.143 painting widths
  // (assets/bake/starry-night/regions.json), framed with a margin under the painter camera.
  const crop = {
    left: Math.round(0.518 * width - 240),
    top: Math.round(0.335 * height - 200),
    width: 480,
    height: 400,
  };
  const start = 3.7;
  for (const [name, query] of [
    ['wave', 'wrap=wave'],
    ['lift', 'wrap=lift'],
  ] as const) {
    const before = load();
    await bootWorld(xr, `painter&nohalo&motiont=${start}&${query}`);
    await hideHud(page, xr);
    const frames: Buffer[] = [];
    for (let k = 0; k < 6; k++) {
      await motionT(page, xr, start + 0.5 * k);
      frames.push(
        await sharp(await shotPng(page))
          .extract(crop)
          .png()
          .toBuffer(),
      );
    }
    const gap = 8;
    const strip = await sharp({
      create: {
        width: 6 * crop.width + 5 * gap,
        height: crop.height,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite(frames.map((input, k) => ({ input, left: k * (crop.width + gap), top: 0 })))
      .jpeg({ quality: 85 })
      .toBuffer();
    writeFileSync(`docs/shots/swirl-${name}-strip.jpg`, strip);
    console.log(
      `[e2e] sky lift strip ${name}: motiont ${start} to ${start + 2.5}, load ${before} before, ${load()} after`,
    );
  }
  expect(await glErrors(page)).toEqual([]);
});
