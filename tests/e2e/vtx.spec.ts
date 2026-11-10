/**
 * The `vtx` A/B group (src/render/strokes/vertex-arms.ts): once the hoist variant has compiled, V
 * cycles base, fewer, smaller, sparse and hoist live with no new program, each arm reports its
 * vertex invocations and drawn area, hoist draws within a small tolerance of base, and a full cycle
 * back to base renders a fresh no-flag boot byte for byte. `smaller` is measured on the pixels: it
 * raises the `?coverage` bare share, and the same check fails with its size factor forced to 1.
 *
 * The coverage sweeps for the measurement arms and for `?densitylaw=count` at governor level 4 are
 * measurements, not gates: they run only with GX_VTX_SWEEP=1 and log the bare share per pose.
 */
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { CAPTURE_SIZE } from '../../scripts/fidelity-io.ts';
import type { DensityLaw } from '../../src/diag/flags.ts';
import { createGovernor, type GovernorLevels } from '../../src/render/governor.ts';
import { COVERAGE_POSES, type CoveragePose } from '../world-poses';
import { expect, glErrors, test, type Xr } from './fixtures';

/** VTX_FEWER_KEEP and VTX_SMALLER_SCALE² (vertex-arms.ts): each arm cuts its quantity by 30%. */
const KEEP = 0.7;
/** VTX_SMALLER_SCALE: smaller's linear factor on every stroke. */
const SMALLER_SCALE = Math.sqrt(KEEP);

interface VtxDiag {
  arm: string;
  keep: number;
  scale: number;
  prepared: boolean;
  program: 'base' | 'hoist';
  verticesPerInstance: number;
  views: number;
  instances: number;
  vertexInvocations: number;
  drawnAreaM2: number;
  drawnSr: number;
  drawnSrViews: number[];
}

type Band = 'near' | 'mid' | 'far';
interface WorldStrokes {
  visible: number;
  bands: Record<Band, { d: number; size: number; visible: number }>;
}

async function vtx(xr: Xr): Promise<VtxDiag> {
  return (await xr.diag()).vtx as VtxDiag;
}

async function strokes(xr: Xr): Promise<WorldStrokes> {
  return ((await xr.diag()).world as { strokes: WorldStrokes }).strokes;
}

async function pressV(page: Page, xr: Xr): Promise<void> {
  await page.keyboard.down('KeyV');
  await xr.waitFrames(2);
  await page.keyboard.up('KeyV');
  await xr.waitFrames(2);
}

async function hideHud(page: Page, xr: Xr): Promise<void> {
  const hud = (await xr.diag()).hud as { visible: boolean } | undefined;
  if (!hud?.visible) return;
  await page.keyboard.press('h');
  await expect
    .poll(async () => ((await xr.diag()).hud as { visible: boolean }).visible)
    .toBe(false);
  await xr.waitFrames(5);
}

async function rawPixels(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    if (!window.__goghShot) throw new Error('__goghShot is not installed; boot with ?diag&shot');
    return window.__goghShot();
  });
  const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  return sharp(png).raw().toBuffer();
}

async function bootWorld(xr: Xr, query: string): Promise<void> {
  await xr.boot(query);
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
    .toBe(true);
  await xr.waitFrames(5);
}

/** Waits until every batch has its sky attributes and both programs compiled (vertex-arms.ts). */
async function waitPrepared(xr: Xr): Promise<void> {
  await expect.poll(async () => (await vtx(xr)).prepared, { timeout: 30_000 }).toBe(true);
  await xr.waitFrames(3);
}

/** Pixels whose largest channel difference is over `threshold` levels, as a share, and the max. */
function pixelDiff(a: Buffer, b: Buffer, threshold: number): { share: number; max: number } {
  let over = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2]),
    );
    if (d > threshold) over++;
    if (d > max) max = d;
  }
  return { share: over / (a.length / 4), max };
}

/**
 * The hoist tolerance: under the identity model matrix hoist differs from base only by float
 * rounding (P × (V × x) against P × V × (M × x), unnormalised varyings) and by the sky rest field
 * built in float64 on the CPU, so a handful of edge pixels may flip. The bound is on pixels that
 * moved by more than HOIST_LEVELS in any channel.
 */
const HOIST_LEVELS = 8;
const HOIST_MAX_SHARE = 0.002;

test.describe('the painter view', () => {
  test.use({ viewport: { width: CAPTURE_SIZE.width, height: CAPTURE_SIZE.height } });

  test('V cycles vtx live with no new program, each arm reports its cut, and a full cycle back to base matches a fresh boot byte for byte', async ({
    page,
    xr,
  }) => {
    test.setTimeout(240_000);
    const query = 'painting=starry-night&noanim&seed=1&shot&painter&nogov';
    await bootWorld(xr, query);
    expect((await xr.diag()).vtx, 'no vtx key without the group').toBeUndefined();
    const fresh = await rawPixels(page);

    await bootWorld(xr, `${query}&ab=vtx`);
    expect(((await xr.diag()).ab as { variants: string[] }).variants).toEqual([
      'base',
      'fewer',
      'smaller',
      'sparse',
      'hoist',
    ]);
    await waitPrepared(xr);
    await hideHud(page, xr);
    expect((await rawPixels(page)).equals(fresh), 'vtx base matches a fresh boot').toBe(true);
    const programs = (await xr.diag()).renderer.programs;
    const base = await vtx(xr);
    expect(base).toMatchObject({
      arm: 'base',
      keep: 1,
      scale: 1,
      prepared: true,
      program: 'base',
      verticesPerInstance: 4,
      views: 1,
    });
    expect(base.drawnSrViews).toHaveLength(1);
    expect(base.instances).toBe((await strokes(xr)).visible);
    expect(base.vertexInvocations).toBe(base.instances * 4);
    expect(base.drawnAreaM2).toBeGreaterThan(0);
    expect(base.drawnSr).toBeGreaterThan(0);

    const rows: string[] = [
      `world total ${((await xr.diag()).world as { total: number }).total}`,
      `base ${JSON.stringify(base)}`,
    ];
    let fewerSr = 0;
    for (const arm of ['fewer', 'smaller', 'sparse', 'hoist', 'base']) {
      await pressV(page, xr);
      await xr.waitFrames(3);
      const now = await vtx(xr);
      expect(now.arm).toBe(arm);
      expect(now.program).toBe(arm === 'hoist' ? 'hoist' : 'base');
      expect((await xr.diag()).renderer.programs, `${arm} linked no new program`).toBe(programs);
      rows.push(`${arm} ${JSON.stringify(now)}`);
      if (arm === 'fewer') fewerSr = now.drawnSr;
      if (arm === 'fewer' || arm === 'sparse') {
        // Pinned strokes always draw, so the cut lands a little under 30%.
        expect(now.instances / base.instances).toBeGreaterThan(KEEP - 0.01);
        expect(now.instances / base.instances).toBeLessThan(KEEP + 0.05);
        expect(now.vertexInvocations).toBe(now.instances * 4);
      }
      if (arm === 'fewer') {
        // The importance prefix is a stratified sample, so the fill falls with the count.
        const fill = now.drawnSr / base.drawnSr / KEEP;
        expect(fill).toBeGreaterThan(0.93);
        expect(fill).toBeLessThan(1.07);
      } else if (arm === 'sparse') {
        // Fit-capped strokes cannot grow past their cap, so sparse wins back less than fewer
        // lost: its fill sits between fewer's and base's.
        expect(now.drawnSr).toBeGreaterThan(fewerSr * 1.05);
        expect(now.drawnSr / base.drawnSr).toBeLessThan(1.07);
      } else if (arm === 'smaller') {
        // The diag applies uVtxSize after each fit cap, as the shader does, so this ratio is
        // exact by construction; the pixel check below and the coverage test measure the shader.
        expect(now.instances).toBe(base.instances);
        expect(now.drawnSr / base.drawnSr).toBeCloseTo(KEEP, 6);
      } else {
        expect(now.instances).toBe(base.instances);
        expect(now.drawnAreaM2).toBeCloseTo(base.drawnAreaM2, 6);
      }
      if (arm !== 'base') {
        await hideHud(page, xr);
        const pixels = await rawPixels(page);
        const diff = pixelDiff(pixels, fresh, HOIST_LEVELS);
        const same = pixels.equals(fresh);
        rows.push(
          `${arm} pixels ${same ? 'identical to' : 'differ from'} base (${(diff.share * 100).toFixed(4)}% over ${HOIST_LEVELS} levels, max ${diff.max})`,
        );
        if (arm === 'hoist') {
          expect(diff.share, 'hoist draws within the tolerance of base').toBeLessThanOrEqual(
            HOIST_MAX_SHARE,
          );
          // Rounding moves some pixels, so identical pixels would mean the define compiled away.
          expect(same, 'hoist runs its own program, not a copy of base').toBe(false);
        } else {
          expect(same, `${arm} draws differently from base`).toBe(false);
        }
      }
    }
    console.log(`[e2e] vtx arms: ${rows.join('; ')}`);
    await hideHud(page, xr);
    expect((await rawPixels(page)).equals(fresh), 'a full cycle back to base').toBe(true);
    expect(await glErrors(page)).toEqual([]);
  });

  test('with the sky moving, hoist reads its rest field and draws within the tolerance of base, under the base, wheel, stream, wave and wheelrun wraps and the default wheelflow', async ({
    page,
    xr,
  }) => {
    test.setTimeout(720_000);
    // `noanim` gates the sky motion off, so only a pinned motion time reads iSkyField and
    // iSkyWave. A field left at zero would hold hoist's sky strokes at rest while base's move.
    const still = 'painting=starry-night&noanim&seed=1&shot&painter&nogov';
    await bootWorld(xr, still);
    const rest = await rawPixels(page);
    const rows: string[] = [];
    for (const extra of [
      '&wrap=base',
      '&wrap=wheel',
      '&wrap=stream',
      '&wrap=wave',
      '&wrap=wheelrun',
      '',
    ]) {
      await bootWorld(
        xr,
        `painting=starry-night&seed=1&shot&painter&nogov&motiont=3.7${extra}&ab=vtx`,
      );
      await waitPrepared(xr);
      await hideHud(page, xr);
      const base = await rawPixels(page);
      for (let i = 0; i < 4; i++) await pressV(page, xr);
      expect(await vtx(xr)).toMatchObject({ arm: 'hoist', program: 'hoist' });
      await hideHud(page, xr);
      const hoist = await rawPixels(page);
      const moved = pixelDiff(base, rest, HOIST_LEVELS);
      const diff = pixelDiff(hoist, base, HOIST_LEVELS);
      rows.push(
        `wrap ${extra ? extra.slice(6) : 'wheelflow (default)'}: motion moves ${(moved.share * 100).toFixed(3)}%, hoist differs ${(diff.share * 100).toFixed(4)}% (max ${diff.max})`,
      );
      // The motion must move far more pixels than the tolerance allows, or a still sky would pass.
      expect(moved.share).toBeGreaterThan(10 * HOIST_MAX_SHARE);
      expect(diff.share, `hoist within the tolerance${extra}`).toBeLessThanOrEqual(HOIST_MAX_SHARE);
    }
    console.log(`[e2e] vtx hoist under motion: ${rows.join('; ')}`);
    expect(await glErrors(page)).toEqual([]);
  });
});

test('in XR the vtx readout counts both eyes', async ({ page, xr }) => {
  test.setTimeout(150_000);
  await bootWorld(xr, 'painting=starry-night&noanim&seed=1&nogov&ab=vtx');
  await xr.enterXR();
  await xr.waitFrames(5);
  await waitPrepared(xr);
  const v = await vtx(xr);
  console.log(`[e2e] vtx XR base ${JSON.stringify(v)}`);
  expect(v.views).toBe(2);
  expect(v.instances).toBeGreaterThan(0);
  expect(v.vertexInvocations).toBe(v.instances * 4 * 2);
  // The solid angle is summed over both eyes, each from its own eye and inside its own frustum.
  expect(v.drawnSrViews).toHaveLength(2);
  const [left, right] = v.drawnSrViews;
  expect(left).toBeGreaterThan(0);
  expect(right).toBeGreaterThan(0);
  expect(v.drawnSr).toBeCloseTo(left + right, 6);
  expect(Math.abs(left - right) / Math.max(left, right)).toBeLessThan(0.25);
  expect(await glErrors(page)).toEqual([]);
});

/**
 * The measured `smaller` check: shrinking every stroke by √0.7 must raise the share of bare pixels
 * in the `?coverage` painter view by at least SMALLER_MIN_RISE, absolute, and by half again.
 */
const SMALLER_MIN_RISE = 0.002;
function smallerShows(base: number, now: number): boolean {
  return now - base >= SMALLER_MIN_RISE && now >= 1.5 * base;
}

test.describe('the painter view under coverage', () => {
  test.use({ viewport: { width: CAPTURE_SIZE.width, height: CAPTURE_SIZE.height } });

  test('smaller raises the bare share, and the check fails with its size factor forced to 1', async ({
    page,
    xr,
  }) => {
    test.setTimeout(180_000);
    await bootWorld(xr, 'painting=starry-night&noanim&seed=1&shot&painter&coverage&nogov&ab=vtx');
    await waitPrepared(xr);
    await hideHud(page, xr);
    const base = await bareShare(page);
    await pressV(page, xr);
    await pressV(page, xr);
    expect((await vtx(xr)).arm).toBe('smaller');
    await hideHud(page, xr);
    const smaller = await bareShare(page);
    // The negative control: the same arm with uVtxSize forced back to 1 draws base's quads.
    await page.evaluate(() => {
      if (!window.__goghVtxSize) throw new Error('__goghVtxSize is e2e-only');
      window.__goghVtxSize(1);
    });
    await xr.waitFrames(3);
    const forced = await bareShare(page);
    await page.evaluate((scale) => window.__goghVtxSize?.(scale), SMALLER_SCALE);
    await xr.waitFrames(3);
    const restored = await bareShare(page);
    const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
    console.log(
      `[e2e] vtx smaller bare share: base ${pct(base)}, smaller ${pct(smaller)}, forced 1 ${pct(forced)}, restored ${pct(restored)}`,
    );
    expect(smallerShows(base, smaller), 'smaller raises the bare share').toBe(true);
    expect(smallerShows(base, forced), 'the check fails with the factor forced to 1').toBe(false);
    expect(forced).toBe(base);
    expect(restored).toBe(smaller);
    expect(await glErrors(page)).toEqual([]);
  });
});

// --- Measurements (GX_VTX_SWEEP=1) ---------------------------------------------------------------

const SWEEP = 'painting=starry-night&noanim&seed=1&shot&coverage&nogov';

/** The world-coverage.spec.ts bare count: pixels at least about 75% magenta. */
function bareShare(page: Page): Promise<number> {
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
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 192 && data[i + 1] < 64 && data[i + 2] > 192) bare++;
    }
    return bare / (data.length / 4);
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

async function sweep(page: Page, xr: Xr, label: string): Promise<void> {
  const rows: { name: string; bare: number; drawn: number }[] = [];
  for (const pose of COVERAGE_POSES) {
    await visit(page, xr, pose);
    rows.push({ name: pose.name, bare: await bareShare(page), drawn: (await strokes(xr)).visible });
  }
  for (const r of rows) {
    console.log(
      `[e2e] vtx sweep ${label} ${r.name}: bare ${(r.bare * 100).toFixed(3)}%, drawn ${r.drawn}`,
    );
  }
  const worst = rows.reduce((a, b) => (b.bare > a.bare ? b : a));
  const over = rows.filter((r) => r.bare > 0.005).length;
  const mean = rows.reduce((s, r) => s + r.bare, 0) / rows.length;
  const summary = `max ${(worst.bare * 100).toFixed(3)}% (${worst.name}), mean ${(mean * 100).toFixed(3)}%, ${over}/24 over 0.5%`;
  console.log(`[e2e] vtx sweep ${label}: ${summary}`);
  test.info().annotations.push({ type: label, description: summary });
}

/**
 * The governor's levels at `level`, from the same overrun the headset showed at the painter spot
 * (22 ms against the 72 Hz budget, 2026-11-06): foveation 0.5 pays (×0.84), the fb-scale step
 * buys nothing on Quest and is undone, foveation 1 reaches 17.65 ms (×0.955 more), and each density
 * step takes 3.5% off, just past the 3% no-gain bar. Drawn scales with each band's density.
 */
function levelsAt(level: number, law: DensityLaw, drawn: Record<Band, number>): GovernorLevels {
  const gov = createGovernor({ mode: 'default', targetHz: 72, densityLaw: law });
  const d0 = { ...gov.levels.density };
  const interval = (l: GovernorLevels): number => {
    let ms = 22;
    if (l.foveation >= 0.5) ms *= 0.84;
    if (l.foveation >= 1) ms *= 0.955;
    for (const band of ['near', 'mid', 'far'] as const) {
      ms *= 0.965 ** Math.round(Math.log(l.density[band] / d0[band]) / Math.log(0.7));
    }
    return ms;
  };
  let t = 0;
  while (gov.snapshot().level < level) {
    if (t > 600_000) throw new Error(`governor never reached level ${level}`);
    const l = gov.levels;
    const ms = interval(l);
    t += ms;
    gov.sample({
      t,
      intervalMs: ms,
      gpuMs: null,
      drawn: {
        near: Math.floor((drawn.near * l.density.near) / d0.near),
        mid: Math.floor((drawn.mid * l.density.mid) / d0.mid),
        far: Math.floor((drawn.far * l.density.far) / d0.far),
      },
    });
  }
  return gov.levels;
}

test.describe('measurements', () => {
  test.skip(!process.env.GX_VTX_SWEEP, 'set GX_VTX_SWEEP=1 to run the vtx coverage sweeps');
  test.describe.configure({ timeout: 900_000 });

  test('the coverage sweep for each measuring arm', async ({ page, xr }) => {
    await bootWorld(xr, `${SWEEP}&ab=vtx`);
    await hideHud(page, xr);
    await sweep(page, xr, 'base');
    for (const arm of ['fewer', 'smaller', 'sparse']) {
      await pressV(page, xr);
      expect((await vtx(xr)).arm).toBe(arm);
      await hideHud(page, xr);
      await sweep(page, xr, arm);
    }
    expect(await glErrors(page)).toEqual([]);
  });

  test('the coverage sweep at governor levels 4 and 6 under the count and area laws', async ({
    page,
    xr,
  }) => {
    await bootWorld(xr, SWEEP);
    await visit(page, xr, COVERAGE_POSES[0]);
    const bands = (await strokes(xr)).bands;
    const drawn = { near: bands.near.visible, mid: bands.mid.visible, far: bands.far.visible };
    console.log(`[e2e] vtx painter-spot drawn per band ${JSON.stringify(drawn)}`);
    for (const [level, law] of [
      [4, 'count'],
      [4, 'area'],
      [6, 'count'],
    ] as const) {
      const levels = levelsAt(level, law, drawn);
      console.log(`[e2e] vtx level ${level} ${law}: ${JSON.stringify(levels)}`);
      // ?nogov keeps the governor off, so the law reaches the batch only through these sizes.
      await bootWorld(xr, SWEEP);
      await page.evaluate(
        (l) => {
          if (!window.__goghBands) throw new Error('__goghBands is e2e-only');
          window.__goghBands(l);
        },
        { density: levels.density, size: levels.size },
      );
      await xr.waitFrames(3);
      await sweep(page, xr, `level ${level} ${law}`);
    }
    expect(await glErrors(page)).toEqual([]);
  });
});
