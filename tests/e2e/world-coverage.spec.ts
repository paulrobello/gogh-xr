/**
 * The Starry Night world (P2.7): boot smoke checks and the coverage sweep (P2-A3).
 *
 * The sweep renders `?painting=starry-night&noanim&seed=1&diag&shot&coverage`. With `?coverage`
 * every base mesh and the clear colour are flat magenta while the strokes render normally, so a
 * magenta pixel is one the strokes leave bare, whether it shows a base mesh or the clear colour.
 * The assertion counts mostly magenta pixels; a coverage-weighted share that also counts MSAA rims
 * is logged per pose (see `BareShare`).
 * `?bare` (base meshes magenta, strokes hidden) calibrates the count: there it reads about 100%.
 *
 * Poses are set through `window.__goghPose(x, y, z, yaw, pitch)`, which drives the desktop camera
 * rather than the IWER head the plan names. The desktop camera renders through the same scene,
 * batch cull and materials, so the coverage is equivalent, and an exact pitch of ±π/2 is simpler
 * to set (controller ruling for P2.7).
 */

import type { Page } from '@playwright/test';
import { REACTIVE_MOTION_BIT } from '../../src/motion/layers.ts';
import { STROKE_LAYER } from '../../src/render/strokes/instance.ts';
import { COVERAGE_POSES, type CoveragePose, CREST_POSES } from '../world-poses';
import { expect, glErrors, test, type Xr } from './fixtures';

/** Most bare share allowed at any pose (P2-A3). */
const MAX_BARE = 0.005;
/** The P0.8 default-mode drawn budget (src/render/strokes/bands.ts). */
const DEFAULT_BUDGET = 325_000;
const SWEEP = 'painting=starry-night&noanim&seed=1&shot';

interface WorldDiag {
  painting: string;
  seed: number;
  debug: string | null;
  counts: Record<string, number>;
  total: number;
  times: Record<string, number>;
  cache: 'hit' | 'miss' | 'bypass';
  strokes: { chunks: number; visibleChunks: number; total: number; visible: number };
}

/** `__goghDiag().draw`: the last frame's draw calls and the bound batch's visible chunks. */
interface DrawDiag {
  calls: number;
  visibleChunks: number;
}

async function world(xr: Xr): Promise<WorldDiag> {
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
    .toBe(true);
  return (await xr.diag()).world as WorldDiag;
}

interface BareShare {
  /**
   * Share of pixels that read as mostly magenta: red and blue above 192, green below 64. Exact
   * magenta survives the sRGB output and no Starry Night colour has that mix. With MSAA on, a
   * pixel with only 1-2 of its 4 samples magenta blends with the stroke colour and fails these
   * bounds, so this counts pixels about 75% magenta or more and undercounts rims.
   */
  readonly binary: number;
  /**
   * Coverage-weighted share: per pixel clamp((min(R, B) - G) / 255, 0, 1), averaged over the frame.
   * A partly magenta pixel counts by its magenta fraction. It also picks up a little from purple
   * stroke colours (min(R, B) above G), so it reads slightly high.
   */
  readonly weighted: number;
}

/** The canvas keeps its drawing buffer (`?shot`), so this reads the last frame. */
function bareShare(page: Page): Promise<BareShare> {
  return page.evaluate(() => {
    const gl = document.querySelector('canvas') as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = gl.width;
    copy.height = gl.height;
    const context = copy.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas context is not available');
    context.drawImage(gl, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let bare = 0;
    let weight = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > 192 && g < 64 && b > 192) bare++;
      weight += Math.min(1, Math.max(0, (Math.min(r, b) - g) / 255));
    }
    const pixels = data.length / 4;
    return { binary: bare / pixels, weighted: weight / pixels };
  });
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

test('?painting=starry-night boots the world at the painter eye with no errors', async ({
  page,
  xr,
}) => {
  test.setTimeout(150_000);
  await xr.boot('painting=starry-night');
  const stats = await world(xr);
  await xr.waitFrames(3);
  const diag = await xr.diag();
  expect(stats.painting).toBe('starry-night');
  expect(stats.seed).toBe(1);
  expect(stats.debug).toBeNull();
  expect(stats.total).toBeGreaterThan(0);
  expect(stats.strokes.total).toBe(stats.total);
  // The seed-1 light counts the unit pin (tests/world-starry-night.test.ts) reads through sharp's
  // decode. A stroke splits on the scan's colours, so the browser's decoder must give the same.
  expect(stats.counts.moon).toBe(265);
  expect(stats.counts.star).toBe(4_695);
  // The eave underside copies (src/paintings/starry-night/eave-undersides.ts), as the unit pin.
  expect(stats.counts.eaves).toBe(10_053);
  // e2e builds always bypass the scatter cache.
  expect(stats.cache).toBe('bypass');
  expect((diag.world as WorldDiag).strokes.visible).toBeGreaterThan(0);
  // A visible chunk is at most one draw call (a zero-instance chunk draws nothing), and the base meshes draw too.
  const draw = diag.draw as DrawDiag;
  expect(draw.visibleChunks).toBe((diag.world as WorldDiag).strokes.visibleChunks);
  expect(draw.visibleChunks).toBeGreaterThan(0);
  expect(draw.calls).toBeGreaterThan(draw.visibleChunks);
  console.log(`[e2e] world desktop draw ${JSON.stringify(draw)}`);
  expect(diag.camera.position).toEqual([0, 1.6, 0]);
  console.log(`[e2e] world ${JSON.stringify(stats)}`);
  expect(await glErrors(page)).toEqual([]);
});

test('in XR the IWER head stands at the painter eye inside the world', async ({ page, xr }) => {
  test.setTimeout(150_000);
  await xr.boot('painting=starry-night&noanim&nogov');
  await world(xr);
  await xr.enterXR();
  await xr.waitFrames(5);
  const diag = await xr.diag();
  const [x, y, z] = diag.camera.position;
  expect(Math.hypot(x, y - 1.6, z)).toBeLessThan(0.05);
  const drawn = (diag.world as WorldDiag).strokes.visible;
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThanOrEqual(DEFAULT_BUDGET);
  const draw = diag.draw as DrawDiag;
  expect(draw.calls).toBeGreaterThan(draw.visibleChunks);
  console.log(`[e2e] world XR drawn at the spot ${drawn}, draw ${JSON.stringify(draw)}`);
  expect(await glErrors(page)).toEqual([]);
});

test('an unknown painting id warns once and opens the gallery', async ({ page, xr }) => {
  test.setTimeout(120_000);
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await xr.boot('painting=water-lilies');
  await expect
    .poll(async () => ((await xr.diag()).world as { painting?: string } | undefined)?.painting, {
      timeout: 90_000,
    })
    .toBe('gallery');
  expect(warnings.filter((w) => w.includes('water-lilies'))).toHaveLength(1);
});

test('?bare calibrates the count: with the strokes hidden, the view is all magenta', async ({
  page,
  xr,
}) => {
  test.setTimeout(150_000);
  await xr.boot(`${SWEEP}&bare`);
  expect((await world(xr)).debug).toBe('bare');
  for (const pose of [COVERAGE_POSES[0], COVERAGE_POSES[11], COVERAGE_POSES[23]]) {
    await visit(page, xr, pose);
    const share = await bareShare(page);
    console.log(
      `[e2e] bare ${pose.name}: ${(share.binary * 100).toFixed(2)}% (weighted ${(share.weighted * 100).toFixed(2)}%)`,
    );
    expect(share.binary, pose.name).toBeGreaterThan(0.99);
  }
});

test('at each of the 24 poses at most 0.5% of the view is bare, within the default budget', async ({
  page,
  xr,
}) => {
  test.setTimeout(300_000);
  await xr.boot(`${SWEEP}&coverage`);
  expect((await world(xr)).debug).toBe('coverage');
  const rows: { name: string; bare: number; weighted: number; drawn: number }[] = [];
  for (const pose of COVERAGE_POSES) {
    await visit(page, xr, pose);
    const { binary, weighted } = await bareShare(page);
    const drawn = ((await xr.diag()).world as WorldDiag).strokes.visible;
    rows.push({ name: pose.name, bare: binary, weighted, drawn });
  }
  for (const r of rows) {
    console.log(
      `[e2e] coverage ${r.name}: bare ${(r.bare * 100).toFixed(3)}%, weighted ${(r.weighted * 100).toFixed(3)}%, drawn ${r.drawn}`,
    );
  }
  const worst = rows.reduce((a, b) => (b.bare > a.bare ? b : a));
  const worstWeighted = rows.reduce((a, b) => (b.weighted > a.weighted ? b : a));
  test.info().annotations.push(
    { type: 'max bare', description: `${(worst.bare * 100).toFixed(3)}% at ${worst.name}` },
    {
      type: 'max weighted bare',
      description: `${(worstWeighted.weighted * 100).toFixed(3)}% at ${worstWeighted.name}`,
    },
  );
  console.log(
    `[e2e] coverage max bare ${(worst.bare * 100).toFixed(3)}% (${worst.name}), max weighted ${(worstWeighted.weighted * 100).toFixed(3)}% (${worstWeighted.name})`,
  );
  for (const r of rows) {
    expect(r.bare, r.name).toBeLessThanOrEqual(MAX_BARE);
    expect(r.drawn, r.name).toBeLessThanOrEqual(DEFAULT_BUDGET);
  }
  expect(await glErrors(page)).toEqual([]);
});

test('from the hill flank, looking up at the crest from all four sides, at most 0.5% of the view is bare', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await xr.boot(`${SWEEP}&coverage`);
  expect((await world(xr)).debug).toBe('coverage');
  const rows: { name: string; bare: number; weighted: number; drawn: number }[] = [];
  for (const pose of CREST_POSES) {
    await visit(page, xr, pose);
    const { binary, weighted } = await bareShare(page);
    const drawn = ((await xr.diag()).world as WorldDiag).strokes.visible;
    rows.push({ name: pose.name, bare: binary, weighted, drawn });
  }
  for (const r of rows) {
    console.log(
      `[e2e] crest coverage ${r.name}: bare ${(r.bare * 100).toFixed(3)}%, weighted ${(r.weighted * 100).toFixed(3)}%, drawn ${r.drawn}`,
    );
  }
  for (const r of rows) {
    expect(r.bare, r.name).toBeLessThanOrEqual(MAX_BARE);
    expect(r.drawn, r.name).toBeLessThanOrEqual(DEFAULT_BUDGET);
  }
  expect(await glErrors(page)).toEqual([]);
});

test('with the sky river pinned mid-motion, the spot-ahead view stays within 0.5% bare under both river arms at 8 times through the loop', async ({
  page,
  xr,
}) => {
  test.setTimeout(900_000);
  const [ahead] = COVERAGE_POSES;
  expect(ahead.name).toBe('spot ahead');
  // The sweep above runs under ?noanim, so it never sees the motion. These shots run the shipped
  // default, the wheelrun wrap (src/motion/variants.ts), and wheelflow: the kept wheels turn, and
  // outside them the sky strokes travel along the river, wheelrun one way with base's shrink
  // scaled by its travel, wheelflow ahead and back at full size. 8 times span the 8 s loop.
  const runs: [string, number][] = [];
  for (const wrap of ['', '&wrap=wheelflow']) {
    for (let k = 0; k < 8; k++) runs.push([wrap, 0.5 + k]);
  }
  for (const [wrap, time] of runs) {
    await xr.boot(`painting=starry-night&seed=1&shot&coverage&motiont=${time}${wrap}`);
    expect((await world(xr)).debug).toBe('coverage');
    const motion = (await xr.diag()).motion as { time: number; frozen: boolean; layers: number };
    expect(motion.time).toBe(time);
    expect(motion.frozen).toBe(false);
    expect(motion.layers).not.toBe(0);
    expect(motion.layers & REACTIVE_MOTION_BIT).not.toBe(0);
    await visit(page, xr, ahead);
    const { binary, weighted } = await bareShare(page);
    const drawn = ((await xr.diag()).world as WorldDiag).strokes.visible;
    console.log(
      `[e2e] coverage spot ahead ${wrap ? wrap.slice(6) : 'wheelrun'} at motiont ${time}: bare ${(binary * 100).toFixed(3)}%, weighted ${(weighted * 100).toFixed(3)}%, drawn ${drawn}`,
    );
    expect(binary).toBeLessThanOrEqual(MAX_BARE);
  }
  expect(await glErrors(page)).toEqual([]);
});

test('with the cypress flame pinned, the painter view and the pose under the cypress stay within 0.5% bare', async ({
  page,
  xr,
}) => {
  test.setTimeout(300_000);
  const near = COVERAGE_POSES.find((p) => p.name === 'under the cypress');
  if (!near) throw new Error('no "under the cypress" pose');
  // Every motion layer open, as shipped, and no ?noanim: the cypress strokes rise and shrink at
  // their wrap, the likeliest way to open holes in the foreground.
  for (const time of [0.5, 3.7]) {
    await xr.boot(`painting=starry-night&seed=1&shot&coverage&painter&motiont=${time}`);
    expect((await world(xr)).debug).toBe('coverage');
    const motion = (await xr.diag()).motion as { time: number; frozen: boolean; layers: number };
    expect(motion.time).toBe(time);
    expect(motion.frozen).toBe(false);
    expect(motion.layers & (1 << STROKE_LAYER.cypress)).not.toBe(0);
    expect(motion.layers & REACTIVE_MOTION_BIT).not.toBe(0);
    await xr.waitFrames(3);
    const painter = await bareShare(page);
    await visit(page, xr, near);
    const under = await bareShare(page);
    for (const [name, share] of [
      ['painter view', painter],
      ['under the cypress', under],
    ] as const) {
      console.log(
        `[e2e] coverage ${name} at motiont ${time}: bare ${(share.binary * 100).toFixed(3)}%, weighted ${(share.weighted * 100).toFixed(3)}%`,
      );
      expect(share.binary, `${name} at ${time}`).toBeLessThanOrEqual(MAX_BARE);
    }
  }
  expect(await glErrors(page)).toEqual([]);
});

test('spot ahead stays within 0.5% bare over a full 12 s cypress sway period, and the reactive growth adds no drawn stroke there (P4.6)', async ({
  page,
  xr,
}) => {
  test.setTimeout(300_000);
  const [ahead] = COVERAGE_POSES;
  expect(ahead.name).toBe('spot ahead');
  // The sway's two sines (2.4 s and 1.5 s) repeat every 12 s, and the 4 s rise loop divides it.
  // One boot, every motion layer open, the pin moved by __goghMotionT: 24 phases 0.5 s apart from
  // 0.5 s, so 0.5 s and the 3.5 s next to the pinned 3.7 s are among them. 0.5 s still samples the
  // 1.5 s sine at only three of its phases; the 2.4 s sine gets all 24.
  await xr.boot('painting=starry-night&seed=1&shot&coverage&motiont=0.5');
  expect((await world(xr)).debug).toBe('coverage');
  expect(((await xr.diag()).motion as { layers: number }).layers & REACTIVE_MOTION_BIT).not.toBe(0);
  await visit(page, xr, ahead);
  const rows: { time: number; bare: number; weighted: number; drawn: number }[] = [];
  for (let k = 0; k < 24; k++) {
    const time = 0.5 + 0.5 * k;
    await page.evaluate((t) => {
      if (!window.__goghMotionT) throw new Error('__goghMotionT is e2e-only and needs ?motiont');
      window.__goghMotionT(t);
    }, time);
    await xr.waitFrames(3);
    expect(((await xr.diag()).motion as { time: number }).time).toBe(time);
    const { binary, weighted } = await bareShare(page);
    const drawn = ((await xr.diag()).world as WorldDiag).strokes.visible;
    rows.push({ time, bare: binary, weighted, drawn });
    console.log(
      `[e2e] coverage spot ahead sweep at motiont ${time}: bare ${(binary * 100).toFixed(3)}%, weighted ${(weighted * 100).toFixed(3)}%, drawn ${drawn}`,
    );
  }
  const worst = rows.reduce((a, b) => (b.bare > a.bare ? b : a));
  test.info().annotations.push({
    type: 'worst phase',
    description: `${(worst.bare * 100).toFixed(3)}% at motiont ${worst.time}`,
  });
  console.log(
    `[e2e] coverage spot ahead sweep worst phase: bare ${(worst.bare * 100).toFixed(3)}% at motiont ${worst.time}`,
  );
  for (const r of rows) expect(r.bare, `motiont ${r.time}`).toBeLessThanOrEqual(MAX_BARE);

  // The same view with the reactive bit closed is the P4.4 cull (sky, star, moon and cypress
  // growth only). The desktop eye is the only disturber, and no stroke of spot ahead is within
  // its radius, so the per-chunk reactive growth draws exactly as many strokes.
  await xr.boot(
    'painting=starry-night&seed=1&shot&coverage&motiont=0.5&motionlayers=sky,star,moon,cypress',
  );
  expect((await world(xr)).debug).toBe('coverage');
  const layers = ((await xr.diag()).motion as { layers: number }).layers;
  expect(layers & REACTIVE_MOTION_BIT).toBe(0);
  expect(layers & (1 << STROKE_LAYER.cypress)).not.toBe(0);
  await visit(page, xr, ahead);
  const baseline = ((await xr.diag()).world as WorldDiag).strokes.visible;
  console.log(
    `[e2e] spot ahead drawn: every layer ${rows[0].drawn}, reactive bit closed ${baseline}`,
  );
  for (const r of rows) expect(r.drawn, `motiont ${r.time}`).toBe(baseline);
  expect(await glErrors(page)).toEqual([]);
});
