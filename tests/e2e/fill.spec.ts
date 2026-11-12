/**
 * The `fill` A/B group (src/render/strokes/fill-arms.ts): V cycles the fragment arms at the
 * painter view with no program link, each arm's pixel difference from base is recorded, and a
 * full cycle back to base renders byte for byte as a fresh no-flag boot.
 *
 * Measure: the count of RGB channels that differ from base by more than 8 levels (out of 255) at
 * the 1280 × 1028 painter capture, `?noanim&seed=1&nogov`. Desktop GPUs run mediump as highp, so
 * `mediump` (and the mediump part of `lean`) reads near 0 here whatever it does on the Quest.
 */
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { CAPTURE_SIZE } from '../../scripts/fidelity-io.ts';
import { expect, glErrors, test, type Xr } from './fixtures';

/** FILL_ARMS (fill-arms.ts), which Playwright cannot import through batch.ts's bake outputs. */
const FILL_ARMS = ['base', 'domenowrite', 'nostream', 'shade3', 'mediump', 'lean'];
/** The per-channel difference that counts as moved. */
const MOVED_LEVELS = 8;

interface FillDiag {
  arm: string;
  defines: string[];
  domeWrite: boolean;
  prepared: boolean;
}

async function rawPixels(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    if (!window.__goghShot) throw new Error('__goghShot is not installed; boot with ?diag&shot');
    return window.__goghShot();
  });
  const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  return sharp(png).raw().toBuffer();
}

/** RGB channels (alpha skipped) that differ by more than MOVED_LEVELS, and the largest step. */
function moved(a: Buffer, b: Buffer): { channels: number; share: number; max: number } {
  let channels = 0;
  let total = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (i % 4 === 3) continue;
    total += 1;
    const d = Math.abs(a[i] - b[i]);
    if (d > MOVED_LEVELS) channels += 1;
    if (d > max) max = d;
  }
  return { channels, share: channels / total, max };
}

async function pressV(page: Page, xr: Xr): Promise<void> {
  await page.keyboard.down('KeyV');
  await xr.waitFrames(2);
  await page.keyboard.up('KeyV');
  await xr.waitFrames(2);
}

test.describe('the painter view', () => {
  test.use({ viewport: { width: CAPTURE_SIZE.width, height: CAPTURE_SIZE.height } });

  test('V cycles fill with no program link, records each arm against base, and a full cycle matches a fresh boot byte for byte', async ({
    page,
    xr,
  }) => {
    test.setTimeout(300_000);
    const query = 'painting=starry-night&noanim&seed=1&shot&painter&nogov';
    const bootWorld = async (extra: string): Promise<void> => {
      await xr.boot(`${query}${extra}`);
      await expect
        .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
        .toBe(true);
      await xr.waitFrames(5);
    };
    const hideHud = async (): Promise<void> => {
      const hud = (await xr.diag()).hud as { visible: boolean };
      if (hud.visible) await page.keyboard.press('h');
      await expect
        .poll(async () => ((await xr.diag()).hud as { visible: boolean }).visible)
        .toBe(false);
      await xr.waitFrames(5);
    };

    await bootWorld('');
    const fresh = await rawPixels(page);

    await bootWorld('&ab=fill');
    await expect
      .poll(async () => ((await xr.diag()).fill as FillDiag | undefined)?.prepared, {
        timeout: 30_000,
      })
      .toBe(true);
    await hideHud();
    const base = await rawPixels(page);
    // The group's boot draws the shipped batch: base is the no-flag boot.
    expect(base.equals(fresh), 'fill at base renders a fresh boot').toBe(true);
    const programs = (await xr.diag()).renderer.programs;

    const rows: string[] = [];
    const diffs: Record<string, ReturnType<typeof moved>> = {};
    for (let step = 1; step <= FILL_ARMS.length; step += 1) {
      const arm = FILL_ARMS[step % FILL_ARMS.length];
      await pressV(page, xr);
      const fill = (await xr.diag()).fill as FillDiag;
      expect(fill.arm).toBe(arm);
      expect(fill.domeWrite).toBe(arm !== 'domenowrite');
      expect((await xr.diag()).renderer.programs, `${arm} linked no new program`).toBe(programs);
      await hideHud();
      const pixels = await rawPixels(page);
      expect(pixels.length).toBe(fresh.length);
      diffs[arm] = moved(pixels, fresh);
      rows.push(
        `${arm}: ${diffs[arm].channels} channels > ${MOVED_LEVELS} (${(diffs[arm].share * 100).toFixed(4)}%), max ${diffs[arm].max}`,
      );
    }
    console.log(`[e2e] fill arms against base at the painter view: ${rows.join('; ')}`);

    // nostream: no stroke streams at the default wrap, so it draws as base.
    expect(diffs.nostream.channels, 'nostream draws as base').toBe(0);
    // shade3 changes the moonlight by float rounding only.
    expect(diffs.shade3.share, 'shade3 is float rounding').toBeLessThan(1e-4);
    // domenowrite resolves dome overlaps by draw order, not rank: the negative control.
    expect(diffs.domenowrite.channels, 'domenowrite changes the dome').toBeGreaterThan(0);
    // The cycle ended on base.
    expect(diffs.base.channels).toBe(0);
    const cycled = await rawPixels(page);
    expect(cycled.equals(fresh), 'a full cycle back to base renders a fresh boot').toBe(true);
    expect(await glErrors(page)).toEqual([]);
  });
});
