/**
 * Chunk draw order under head sway (`holdOrderKeys`, docs/verification.md, view-angle strip). The
 * painter's spot is a corner of the 24 m chunk grid, so the ground cells either side of x = 0
 * mirror each other about the eye. A sway across that plane must keep one chunk order, and the
 * 1 cm step across it must change no more of the frame than the 1 cm steps beside it. A pose
 * reached by a move under 1 m keeps the held order, and coverage must hold there too.
 */
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { flipPercent } from '../../scripts/zfight-lib.ts';
import { COVERAGE_POSES } from '../world-poses';
import { expect, test, type Xr } from './fixtures';

test.use({ viewport: { width: 1280, height: 1014 } });

/** Heading north, a little down: the x = 0 seam runs up the middle of the frame. */
const YAW = 0;
const PITCH = -0.15;
const EYE_Y = 1.6;
/** Most bare share allowed at a coverage pose (P2-A3, tests/e2e/world-coverage.spec.ts). */
const MAX_BARE = 0.005;
/** Under ORDER_KEY_RESET_M, so the approach keeps the held keys. */
const APPROACH_M = 0.9;

interface Capture {
  rgb: Buffer;
  width: number;
  height: number;
  order: string[];
}

async function place(page: Page, xr: Xr, pose: readonly number[]): Promise<void> {
  await page.evaluate((p) => window.__goghPose?.(p[0], p[1], p[2], p[3], p[4]), [...pose]);
  await xr.waitFrames(3);
}

async function order(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__goghDiag?.().chunkOrder as string[] | null) ?? []);
}

async function capture(page: Page, xr: Xr, x: number, z = 0): Promise<Capture> {
  await place(page, xr, [x, EYE_Y, z, YAW, PITCH]);
  const dataUrl = await page.evaluate(() => window.__goghShot?.() ?? '');
  const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height, order: await order(page) };
}

const changed = (a: Capture, b: Capture): number =>
  flipPercent(a.rgb, b.rgb, a.width, a.height).all;

/** Share of mostly magenta pixels under `?coverage`, as world-coverage.spec.ts counts them. */
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

async function worldReady(xr: Xr): Promise<void> {
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
    .toBe(true);
  await xr.waitFrames(3);
}

test('a head swaying across x = 0 at the painter spot keeps one chunk order and no strip', async ({
  page,
  xr,
}) => {
  test.setTimeout(150_000);
  await xr.boot('painting=starry-night&noanim&seed=1&shot&nogov');
  await worldReady(xr);

  const sweep = [-0.2, -0.1, -0.05, -0.02, -0.01, 0, 0.01, 0.02, 0.05, 0.1, 0.2];
  const orders: string[][] = [];
  for (const x of [...sweep, ...sweep.slice().reverse()]) {
    orders.push((await capture(page, xr, x)).order);
  }
  expect(orders[0].length).toBeGreaterThan(0);
  for (const o of orders) expect(o).toEqual(orders[0]);

  const a = await capture(page, xr, -0.015);
  const b = await capture(page, xr, -0.005);
  const c = await capture(page, xr, 0.005);
  const d = await capture(page, xr, 0.015);
  const crossing = changed(b, c);
  const beside = (changed(a, b) + changed(c, d)) / 2;
  // Parallax differs between views, so the control spot's 1 cm step is logged, not gated.
  const control = changed(await capture(page, xr, 5.995, 7), await capture(page, xr, 6.005, 7));
  console.log(
    `[e2e] strip: 1 cm across x = 0 ${crossing.toFixed(3)}%, beside ${beside.toFixed(3)}%, control ${control.toFixed(3)}%`,
  );
  expect(crossing).toBeLessThanOrEqual(beside * 1.02);
});

test('coverage holds at poses reached by a move under 1 m, on the held chunk order', async ({
  page,
  xr,
}) => {
  test.setTimeout(150_000);
  await xr.boot('painting=starry-night&noanim&seed=1&shot&coverage');
  await worldReady(xr);
  const poses = [COVERAGE_POSES[0], COVERAGE_POSES[6], COVERAGE_POSES[11]];
  const offsets: readonly (readonly [number, number])[] = [
    [APPROACH_M, 0],
    [-APPROACH_M, 0],
    [0, APPROACH_M],
    [0, -APPROACH_M],
  ];
  let heldTotal = 0;
  for (const { name, position, yaw, pitch } of poses) {
    const [x, y, z] = position;
    // A jump over 1 m first, so the plain-distance order at the pose is the reference.
    await place(page, xr, [x + 50, y, z, yaw, pitch]);
    await place(page, xr, [x, y, z, yaw, pitch]);
    const plain = await order(page);
    let held = 0;
    for (const [dx, dz] of offsets) {
      await place(page, xr, [x + 50, y, z, yaw, pitch]);
      await place(page, xr, [x + dx, y, z + dz, yaw, pitch]);
      await place(page, xr, [x, y, z, yaw, pitch]);
      if (JSON.stringify(await order(page)) !== JSON.stringify(plain)) held++;
      const bare = await bareShare(page);
      console.log(`[e2e] held ${name} from (${dx}, ${dz}): ${(bare * 100).toFixed(3)}% bare`);
      expect(bare, `${name} from (${dx}, ${dz})`).toBeLessThanOrEqual(MAX_BARE);
    }
    console.log(
      `[e2e] held ${name}: ${held} of ${offsets.length} approaches differ from plain order`,
    );
    heldTotal += held;
  }
  // Some approach must hold an order other than plain distance, or the hold path went untested.
  expect(heldTotal).toBeGreaterThan(0);
});
