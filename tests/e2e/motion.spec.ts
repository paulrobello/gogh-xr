/**
 * The motion clock (P4.1): `?noanim` freezes it, so the world draws at rest and shots taken apart in
 * time match pixel for pixel. Without it the clock runs, scaled by `?calm`. The sky swirl (P4.2)
 * moves the world's sky in proportion to calm at a pinned `?motiont`, and the P1 canvas demo stays
 * static.
 */
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { CAPTURE_SIZE } from '../../scripts/fidelity-io.ts';
import { MAX_MOTION_DT_S } from '../../src/motion/clock.ts';
import { MOTION_LAYER_MASK } from '../../src/motion/layers.ts';
import { expect, glErrors, test, type Xr } from './fixtures';

interface MotionDiag {
  time: number;
  calm: number;
  frozen: boolean;
  layers: number;
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

  expect(before).toEqual({ time: 0, calm: 1, frozen: true, layers: MOTION_LAYER_MASK });
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

test('the P1 canvas demo keeps every motion layer closed, so its sky stays static (R-P4f)', async ({
  page,
  xr,
}) => {
  test.setTimeout(120_000);
  await xr.boot('demo=canvas&seed=1&nogov');
  await expect
    .poll(async () => (await xr.diag()).canvas !== undefined, { timeout: 60_000 })
    .toBe(true);
  await xr.waitFrames(2);
  const state = await motion(xr);
  expect(state.frozen).toBe(false);
  expect(state.calm).toBe(1);
  expect(state.layers).toBe(0);
  expect(await glErrors(page)).toEqual([]);
});

test.describe('sky swirl (P4.2)', () => {
  test.use({ viewport: { width: CAPTURE_SIZE.width, height: CAPTURE_SIZE.height } });

  /**
   * The pinned motion time, with every phase pinned to 0 (`?motionphase=0`): f = fract(7 / 8) =
   * 0.875, so every sky stroke is 3 s along its loop and past the wrap fade, at full size.
   */
  const PINNED = 7;
  /** Patch half-size and search radius, pixels. */
  const HALF = 24;
  const SEARCH = 24;
  /**
   * Patch centres, canvas (u, v down): the points of a 0.1 grid over the sky (u 0.35-0.85, v
   * 0.1-0.4) that are clear of the star and moon discs and that the prediction moves 4 px or more.
   * The star and moon layers stay still in P4.2, so a patch they fill reads no shift: (0.35, 0.1),
   * (0.35, 0.3), (0.55, 0.1), (0.65, 0.1), (0.65, 0.2), (0.75, 0.2), (0.75, 0.3) and (0.85, 0.2)
   * read under 1 px, and the moon at (0.85, 0.1) matches nowhere. (0.55, 0.4) moves under 4 px.
   */
  const PATCHES: readonly (readonly [number, number])[] = [
    [0.35, 0.2],
    [0.35, 0.4],
    [0.45, 0.1],
    [0.45, 0.2],
    [0.45, 0.3],
    [0.45, 0.4],
    [0.55, 0.2],
    [0.55, 0.3],
    [0.65, 0.3],
    [0.65, 0.4],
    [0.75, 0.1],
    [0.75, 0.4],
    [0.85, 0.3],
    [0.85, 0.4],
  ];

  async function painterShot(page: Page, xr: Xr, extra: string): Promise<Buffer> {
    await xr.boot(`painting=starry-night&seed=1&shot&painter&nogov&motionphase=0&${extra}`);
    await expect
      .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
      .toBe(true);
    await xr.waitFrames(5);
    const url = await page.evaluate(() => {
      if (!window.__goghShot) throw new Error('__goghShot is not installed; boot with ?diag&shot');
      return window.__goghShot();
    });
    return rawPixels(url);
  }

  function luma(raw: Buffer): Float32Array {
    const { width, height } = CAPTURE_SIZE;
    const channels = raw.length / (width * height);
    const out = new Float32Array(width * height);
    for (let i = 0; i < out.length; i++) {
      const k = i * channels;
      out[i] = 0.2126 * raw[k] + 0.7152 * raw[k + 1] + 0.0722 * raw[k + 2];
    }
    return out;
  }

  /**
   * The shift s, pixels, that best maps the rest patch at (cx, cy) onto the moved image: the
   * least squared difference of rest(x) against moved(x + s) over integer shifts, refined to a
   * sub-pixel by a parabola through the neighbours. `sharpness` is the median error over the best:
   * a clear match reads well above 1.
   */
  function shiftAt(
    rest: Float32Array,
    moved: Float32Array,
    cx: number,
    cy: number,
  ): { dx: number; dy: number; sharpness: number } {
    const { width } = CAPTURE_SIZE;
    const side = 2 * SEARCH + 1;
    const error = new Float64Array(side * side);
    for (let sy = -SEARCH; sy <= SEARCH; sy++) {
      for (let sx = -SEARCH; sx <= SEARCH; sx++) {
        let sum = 0;
        for (let y = cy - HALF; y <= cy + HALF; y++) {
          const a = y * width;
          const b = (y + sy) * width + sx;
          for (let x = cx - HALF; x <= cx + HALF; x++) {
            const d = rest[a + x] - moved[b + x];
            sum += d * d;
          }
        }
        error[(sy + SEARCH) * side + sx + SEARCH] = sum;
      }
    }
    let best = 0;
    for (let i = 1; i < error.length; i++) if (error[i] < error[best]) best = i;
    const bx = best % side;
    const by = Math.floor(best / side);
    const at = (x: number, y: number): number => error[y * side + x];
    const refine = (m: number, z: number, p: number): number => {
      const curve = m - 2 * z + p;
      return curve > 0 ? (0.5 * (m - p)) / curve : 0;
    };
    const fx = bx > 0 && bx < side - 1 ? refine(at(bx - 1, by), at(bx, by), at(bx + 1, by)) : 0;
    const fy = by > 0 && by < side - 1 ? refine(at(bx, by - 1), at(bx, by), at(bx, by + 1)) : 0;
    const sorted = Float64Array.from(error).sort();
    return {
      dx: bx - SEARCH + fx,
      dy: by - SEARCH + fy,
      sharpness: sorted[sorted.length >> 1] / Math.max(error[best], 1e-9),
    };
  }

  test('a pinned coherent phase moves the sky along the TS prediction, half as far at calm 0.5', async ({
    page,
    xr,
  }) => {
    test.setTimeout(480_000);
    const { width, height } = CAPTURE_SIZE;
    const rest = await painterShot(page, xr, 'noanim');
    const still = await painterShot(page, xr, `calm=0&motiont=${PINNED}`);
    expect(await motion(xr)).toEqual({
      time: PINNED,
      calm: 0,
      frozen: false,
      layers: MOTION_LAYER_MASK,
    });
    const half = await painterShot(page, xr, `calm=0.5&motiont=${PINNED}`);
    const full = await painterShot(page, xr, `calm=1&motiont=${PINNED}`);
    expect(await motion(xr)).toEqual({
      time: PINNED,
      calm: 1,
      frozen: false,
      layers: MOTION_LAYER_MASK,
    });
    // Pinned: the time holds while frames run.
    await xr.waitFrames(10);
    expect((await motion(xr)).time).toBe(PINNED);
    // Calm 0 closes the gate: byte for byte the rest pose.
    expect(still.equals(rest)).toBe(true);

    const predicted = await page.evaluate(
      ([points, time]) =>
        points.map(([u, v]) => {
          if (!window.__goghSkyShift) throw new Error('__goghSkyShift is e2e-only');
          return window.__goghSkyShift(u, v, 1, time, 0);
        }),
      [PATCHES, PINNED] as const,
    );
    const [restL, halfL, fullL] = [luma(rest), luma(half), luma(full)];
    const rows: { u: number; v: number; ratio: number; angle: number; sharpness: number }[] = [];
    PATCHES.forEach(([u, v], i) => {
      const shift = predicted[i];
      if (!shift) throw new Error(`no prediction at (${u}, ${v})`);
      const px = shift[0] * width;
      const py = shift[1] * height;
      const cx = Math.round(u * width);
      const cy = Math.round(v * height);
      const a = shiftAt(restL, fullL, cx, cy);
      const b = shiftAt(restL, halfL, cx, cy);
      const fullMag = Math.hypot(a.dx, a.dy);
      const halfMag = Math.hypot(b.dx, b.dy);
      const angle =
        (Math.acos(
          Math.min(1, Math.max(-1, (a.dx * px + a.dy * py) / (fullMag * Math.hypot(px, py)))),
        ) *
          180) /
        Math.PI;
      console.log(
        `sky swirl patch (${u}, ${v}): predicted (${px.toFixed(2)}, ${py.toFixed(2)}) px, ` +
          `calm 1 (${a.dx.toFixed(2)}, ${a.dy.toFixed(2)}) sharp ${a.sharpness.toFixed(1)}, ` +
          `calm 0.5 (${b.dx.toFixed(2)}, ${b.dy.toFixed(2)}) sharp ${b.sharpness.toFixed(1)}, ` +
          `ratio ${(halfMag / fullMag).toFixed(3)}, angle ${angle.toFixed(1)} deg`,
      );
      expect(Math.hypot(px, py), `patch (${u}, ${v})`).toBeGreaterThan(4);
      rows.push({ u, v, ratio: halfMag / fullMag, angle, sharpness: a.sharpness });
    });
    const mean = rows.reduce((sum, r) => sum + r.ratio, 0) / rows.length;
    console.log(
      `sky swirl: ${rows.length} patches, mean calm 0.5 / calm 1 shift ratio ${mean.toFixed(3)}`,
    );
    // Calm halves the displacement (R-P4g).
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
    for (const r of rows) {
      const name = `patch (${r.u}, ${r.v})`;
      expect(r.ratio, name).toBeGreaterThan(0.4);
      expect(r.ratio, name).toBeLessThan(0.6);
      // The GPU moves each patch the way the TS mirror predicts (M4).
      expect(r.angle, name).toBeLessThan(30);
    }
    expect(await glErrors(page)).toEqual([]);
  });
});
