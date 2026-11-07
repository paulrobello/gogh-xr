/**
 * The motion clock (P4.1): `?noanim` freezes it, so the world draws at rest and shots taken apart in
 * time match pixel for pixel. Without it the clock runs, scaled by `?calm`.
 */
import sharp from 'sharp';
import { MAX_MOTION_DT_S } from '../../src/motion/clock.ts';
import { expect, glErrors, test, type Xr } from './fixtures';

interface MotionDiag {
  time: number;
  calm: number;
  frozen: boolean;
}

async function motion(xr: Xr): Promise<MotionDiag> {
  return (await xr.diag()).motion as MotionDiag;
}

async function rawPixels(dataUrl: string): Promise<Buffer> {
  const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  return sharp(png).raw().toBuffer();
}

test('?noanim holds the motion clock and two world shots 500 ms apart match', async ({
  page,
  xr,
}) => {
  test.setTimeout(150_000);
  await xr.boot('painting=starry-night&noanim&seed=1&shot&painter');
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
    .toBe(true);
  await xr.waitFrames(5);

  const shot = (): Promise<string> =>
    page.evaluate(() => {
      if (!window.__goghShot) throw new Error('__goghShot is not installed; boot with ?diag&shot');
      return window.__goghShot();
    });
  const before = await motion(xr);
  const first = await shot();
  await page.waitForTimeout(500);
  await xr.waitFrames(2);
  const second = await shot();
  const after = await motion(xr);

  expect(before).toEqual({ time: 0, calm: 1, frozen: true });
  expect(after).toEqual(before);
  const [a, b] = await Promise.all([rawPixels(first), rawPixels(second)]);
  expect(a.length).toBeGreaterThan(0);
  expect(a.equals(b)).toBe(true);
  expect(await glErrors(page)).toEqual([]);
});

test('without ?noanim the motion clock advances, scaled by ?calm', async ({ page, xr }) => {
  // The motion time and the wall clock, read in one evaluate so the host's load cannot skew them.
  const sample = (): Promise<{ time: number; wall: number }> =>
    page.evaluate(() => {
      const diag = window.__goghDiag?.() as { motion?: { time: number } } | undefined;
      if (!diag?.motion) throw new Error('__goghDiag().motion is missing; boot with ?diag');
      return { time: diag.motion.time, wall: performance.now() / 1000 };
    });

  await xr.boot('calm=0.5');
  await xr.waitFrames(2);
  const state = await motion(xr);
  expect(state.calm).toBe(0.5);
  expect(state.frozen).toBe(false);
  const start = await sample();
  await page.waitForTimeout(500);
  await xr.waitFrames(2);
  const later = await sample();
  // Half calm: never more than half the wall time, plus one clamped frame step of slack.
  const advanced = later.time - start.time;
  expect(advanced).toBeGreaterThan(0);
  expect(advanced).toBeLessThanOrEqual(0.5 * (later.wall - start.wall) + 0.5 * MAX_MOTION_DT_S);

  await xr.boot('calm=0');
  await xr.waitFrames(2);
  const still = await motion(xr);
  await page.waitForTimeout(300);
  await xr.waitFrames(2);
  expect((await motion(xr)).time).toBe(still.time);
  expect(still.time).toBe(0);
  expect(await glErrors(page)).toEqual([]);
});
