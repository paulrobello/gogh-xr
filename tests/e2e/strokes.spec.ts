import type { Page } from '@playwright/test';
import { expect, test, type Xr } from './fixtures';

interface StrokesDiag {
  chunks: number;
  visibleChunks: number;
  total: number;
  visible: number;
  atlasMs: number;
  bands: Record<
    'near' | 'mid' | 'far',
    { d: number; size: number; chunks: number; visible: number }
  >;
}

/** The per-band diag splits the totals exactly. */
function expectBandsSumToTotals(stats: StrokesDiag): void {
  const bands = Object.values(stats.bands);
  expect(bands).toHaveLength(3);
  expect(bands.reduce((sum, b) => sum + b.visible, 0)).toBe(stats.visible);
  expect(bands.reduce((sum, b) => sum + b.chunks, 0)).toBe(stats.visibleChunks);
}

async function strokes(xr: Xr): Promise<StrokesDiag> {
  // The test scene registers its diag key after an async chunk import.
  await expect.poll(async () => (await xr.diag()).strokes !== undefined).toBe(true);
  return (await xr.diag()).strokes as StrokesDiag;
}

/** Drains the GL error queue; the pageErrors fixture separately fails on console GL errors. */
function glErrors(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2');
    if (!gl) throw new Error('no WebGL2 context on the app canvas');
    const errors: number[] = [];
    for (let e = gl.getError(); e !== gl.NO_ERROR && errors.length < 16; e = gl.getError()) {
      errors.push(e);
    }
    return errors;
  });
}

test('strokesTest renders its chunks in XR without WebGL errors', async ({ page, xr }) => {
  await xr.boot('strokesTest');
  await xr.enterXR();
  await xr.waitFrames(5);

  const stats = await strokes(xr);
  expect(stats.total).toBe(6000);
  expect(stats.chunks).toBeGreaterThan(8);
  expect(stats.atlasMs).toBeGreaterThan(0);
  expect(stats.visible).toBeGreaterThan(0);
  expect(stats.visibleChunks).toBeLessThan(stats.chunks);
  expectBandsSumToTotals(stats);
  // The whole test scene lies within 6 m of the start pose.
  expect(stats.bands.near.visible).toBe(stats.visible);
  test.info().annotations.push({ type: 'atlasMs', description: stats.atlasMs.toFixed(1) });
  console.log(`[e2e] strokes ${JSON.stringify(stats)}`);
  expect(await glErrors(page)).toEqual([]);

  // Turning round brings the building wall at z = +6 into view.
  await xr.setPose({ head: { position: [0, 1.6, 0], quaternion: [0, 1, 0, 0] } });
  await xr.waitFrames(3);
  const turned = await strokes(xr);
  expect(turned.visible).toBeGreaterThan(0);
  expect(turned.visible).not.toBe(stats.visible);
  expectBandsSumToTotals(turned);
  expect(await glErrors(page)).toEqual([]);

  // Stepping back 20 m puts the whole scene 14-22 m away: the bands follow the XR eye into mid,
  // drawing the mid material at half density.
  await xr.setPose({ head: { position: [0, 1.6, 20], quaternion: [0, 0, 0, 1] } });
  await xr.waitFrames(3);
  const back = await strokes(xr);
  expectBandsSumToTotals(back);
  expect(back.bands.near.chunks).toBe(0);
  expect(back.bands.far.chunks).toBe(0);
  expect(back.bands.mid.visible).toBeGreaterThan(0);
  expect(back.visible).toBe(back.bands.mid.visible);
  expect(back.visible).toBeLessThan(stats.visible);
  expect(await glErrors(page)).toEqual([]);
});

test('strokesTest renders on the desktop page without errors', async ({ page, xr }) => {
  await xr.boot('strokesTest');
  await xr.waitFrames(5);
  const stats = await strokes(xr);
  expect(stats.visible).toBeGreaterThan(0);
  expect((await xr.diag()).xr.presenting).toBe(false);
  expect(await glErrors(page)).toEqual([]);
});
