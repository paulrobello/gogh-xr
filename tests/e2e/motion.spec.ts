/**
 * The motion clock (P4.1): `?noanim` freezes it, so the world draws at rest and shots taken apart in
 * time match pixel for pixel. Without it the clock runs, scaled by `?calm`. The sky swirl (P4.2)
 * moves the world's sky in proportion to calm at a pinned `?motiont`, and the P1 canvas demo stays
 * static.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { CAPTURE_SIZE } from '../../scripts/fidelity-io.ts';
import { MAX_MOTION_DT_S } from '../../src/motion/clock.ts';
import { MOTION_LAYER_MASK } from '../../src/motion/layers.ts';
import { STROKE_LAYER } from '../../src/render/strokes/instance.ts';
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
 * least squared difference of rest(x) against moved(x + s) over the (2 half + 1)² patch and integer
 * shifts up to `search`, refined to a
 * sub-pixel by a parabola through the neighbours. `sharpness` is the median error over the best:
 * a clear match reads well above 1.
 */
function shiftAt(
  rest: Float32Array,
  moved: Float32Array,
  cx: number,
  cy: number,
  half: number,
  search: number,
): { dx: number; dy: number; sharpness: number } {
  const { width } = CAPTURE_SIZE;
  const side = 2 * search + 1;
  const error = new Float64Array(side * side);
  for (let sy = -search; sy <= search; sy++) {
    for (let sx = -search; sx <= search; sx++) {
      let sum = 0;
      for (let y = cy - half; y <= cy + half; y++) {
        const a = y * width;
        const b = (y + sy) * width + sx;
        for (let x = cx - half; x <= cx + half; x++) {
          const d = rest[a + x] - moved[b + x];
          sum += d * d;
        }
      }
      error[(sy + search) * side + sx + search] = sum;
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
    dx: bx - search + fx,
    dy: by - search + fy,
    sharpness: sorted[sorted.length >> 1] / Math.max(error[best], 1e-9),
  };
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
   * Every shot opens the sky layer alone (`?motionlayers=sky`) and hides the halo (`?nohalo`), so
   * the P4.3 rings neither move nor brighten the light strokes and the block match reads the sky
   * swirl alone; the rings have their own test below. The star and moon layers stay still, so a
   * patch they fill reads no shift: (0.35, 0.1), (0.35, 0.3), (0.55, 0.1), (0.65, 0.1), (0.65,
   * 0.2), (0.75, 0.2), (0.75, 0.3) and (0.85, 0.2) read under 1 px, and the moon at (0.85, 0.1)
   * matches nowhere. (0.55, 0.4) moves under 4 px.
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
  /** The motion layers `?motionlayers=sky` leaves open. */
  const SKY_ONLY = 1 << STROKE_LAYER.sky;

  async function painterShot(page: Page, xr: Xr, extra: string): Promise<Buffer> {
    await xr.boot(
      `painting=starry-night&seed=1&shot&painter&nogov&motionphase=0&motionlayers=sky&nohalo&${extra}`,
    );
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

  test('a pinned coherent phase moves the sky along the TS prediction, half as far at calm 0.5', async ({
    page,
    xr,
  }) => {
    test.setTimeout(480_000);
    const { width, height } = CAPTURE_SIZE;
    const rest = await painterShot(page, xr, 'noanim');
    const still = await painterShot(page, xr, `calm=0&motiont=${PINNED}`);
    expect(await motion(xr)).toEqual({ time: PINNED, calm: 0, frozen: false, layers: SKY_ONLY });
    const half = await painterShot(page, xr, `calm=0.5&motiont=${PINNED}`);
    const full = await painterShot(page, xr, `calm=1&motiont=${PINNED}`);
    expect(await motion(xr)).toEqual({ time: PINNED, calm: 1, frozen: false, layers: SKY_ONLY });
    expect(((await xr.diag()).halo as { visible: boolean }).visible).toBe(false);
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
      const a = shiftAt(restL, fullL, cx, cy, HALF, SEARCH);
      const b = shiftAt(restL, halfL, cx, cy, HALF, SEARCH);
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

test.describe('star and moon rings (P4.3)', () => {
  test.use({ viewport: { width: CAPTURE_SIZE.width, height: CAPTURE_SIZE.height } });

  interface HaloDiag {
    visible: boolean;
    halos: { size: number; phase: number; ring: number }[];
  }

  async function lightsShot(page: Page, xr: Xr, extra: string): Promise<Buffer> {
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

  /** Mean absolute channel difference over the canvas box (u0, v0)-(u1, v1), v down. */
  function boxDiff(
    a: Buffer,
    b: Buffer,
    [u0, v0, u1, v1]: readonly [number, number, number, number],
  ): number {
    const { width, height } = CAPTURE_SIZE;
    const channels = a.length / (width * height);
    let sum = 0;
    let n = 0;
    for (let y = Math.round(v0 * height); y < Math.round(v1 * height); y++) {
      for (let x = Math.round(u0 * width); x < Math.round(u1 * width); x++) {
        const k = (y * width + x) * channels;
        for (let c = 0; c < 3; c++) sum += Math.abs(a[k + c] - b[k + c]);
        n += 3;
      }
    }
    return sum / n;
  }

  /** Rec. 709 luma per pixel of a raw RGB(A) capture. */
  function lumaOf(raw: Buffer): Float32Array {
    const { width, height } = CAPTURE_SIZE;
    const channels = raw.length / (width * height);
    const out = new Float32Array(width * height);
    for (let i = 0; i < out.length; i++) {
      const k = i * channels;
      out[i] = 0.2126 * raw[k] + 0.7152 * raw[k + 1] + 0.0722 * raw[k + 2];
    }
    return out;
  }

  /** Bilinear luma at pixel-centre coordinates (x, y). */
  function sampleLuma(img: Float32Array, x: number, y: number): number {
    const { width } = CAPTURE_SIZE;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const at = (xx: number, yy: number): number => img[yy * width + xx];
    return (
      (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) +
      fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1))
    );
  }

  /** The star whose ring the test reads: star 10, the large lower-left one, rim about 124 px. */
  const STAR = 10;

  test('a star ring pushes its strokes outward and brightens them, as the TS mirror predicts (I2)', async ({
    page,
    xr,
  }) => {
    test.setTimeout(300_000);
    // The halo is hidden (`?nohalo`) and the sky layer closed (`?motionlayers=star,moon`), so
    // only the ring strokes can differ between the two shots: a ringMotion that returned zero
    // leaves them equal.
    const flags = 'motionlayers=star,moon&nohalo';
    const rest = await lightsShot(page, xr, `noanim&${flags}`);
    expect(((await xr.diag()).halo as HaloDiag).visible).toBe(false);
    await expect.poll(() => page.evaluate(() => window.__goghRingShift !== undefined)).toBe(true);
    // The crest: the pinned time, on a 0.05 s grid over two periods, at which the TS mirror
    // pushes the annulus's mid-line (0.875 of the rim) outward the most, mean over 24 angles.
    const plan = await page.evaluate(
      ([k, width, height]) => {
        const probe = window.__goghRingShift;
        if (!probe) throw new Error('__goghRingShift is e2e-only');
        const base = probe(k, 0.5, 0.3, 0);
        if (!base) throw new Error(`ring ${k} is off the painter view`);
        const rim = base.rim * width;
        const mean = (t: number): { radial: number; bright: number } => {
          let radial = 0;
          let bright = 0;
          for (let a = 0; a < 24; a++) {
            const th = (a / 24) * 2 * Math.PI;
            const u = base.centre[0] + (0.875 * rim * Math.cos(th)) / width;
            const v = base.centre[1] + (0.875 * rim * Math.sin(th)) / height;
            const m = probe(k, u, v, t);
            if (!m) throw new Error(`no prediction at (${u}, ${v})`);
            radial += m.shift[0] * width * Math.cos(th) + m.shift[1] * height * Math.sin(th);
            bright += m.bright;
          }
          return { radial: radial / 24, bright: bright / 24 };
        };
        let best = { t: 0, radial: -Infinity, bright: 0 };
        for (let i = 0; i < 400; i++) {
          const t = i * 0.05;
          const m = mean(t);
          if (m.radial > best.radial) best = { t, ...m };
        }
        return { centre: [base.centre[0] * width, base.centre[1] * height], rim, ...best };
      },
      [STAR, CAPTURE_SIZE.width, CAPTURE_SIZE.height] as const,
    );
    const crest = await lightsShot(page, xr, `motiont=${plan.t.toFixed(2)}&${flags}`);

    const { width, height } = CAPTURE_SIZE;
    const [cx, cy] = plan.centre;
    const channels = rest.length / (width * height);
    const restL = lumaOf(rest);
    const crestL = lumaOf(crest);
    // The annulus at 0.75-1.0 of the rim, where the ring's hat is still well above 0.
    const annulus: number[] = [];
    for (let y = Math.floor(cy - plan.rim); y <= Math.ceil(cy + plan.rim); y++) {
      for (let x = Math.floor(cx - plan.rim); x <= Math.ceil(cx + plan.rim); x++) {
        if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
        const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / plan.rim;
        if (r >= 0.75 && r <= 1) annulus.push(y * width + x);
      }
    }
    let change = 0;
    let lift = 0;
    for (const i of annulus) {
      for (let c = 0; c < 3; c++)
        change += Math.abs(crest[i * channels + c] - rest[i * channels + c]);
      lift += crestL[i] - restL[i];
    }
    change /= 3 * annulus.length;
    lift /= annulus.length;
    // The radial shift: the crest's changed pixels against the rest shot scaled about the ring
    // centre by s, normalised cross-correlation, so the brightening's gain does not bias it.
    // The static sky behind the strokes is left out: it would pin the fit at s = 1.
    const moved = annulus.filter((i) => Math.abs(crestL[i] - restL[i]) > 8);
    const scaleNcc = (s: number): number => {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (const i of moved) {
        const x = i % width;
        const y = Math.floor(i / width);
        const a = sampleLuma(restL, cx - 0.5 + (x + 0.5 - cx) / s, cy - 0.5 + (y + 0.5 - cy) / s);
        const b = crestL[i];
        sa += a;
        sb += b;
        saa += a * a;
        sbb += b * b;
        sab += a * b;
      }
      const m = moved.length;
      return (sab - (sa * sb) / m) / Math.sqrt((saa - (sa * sa) / m) * (sbb - (sb * sb) / m));
    };
    // The scale that moves the mid-line by the predicted mean radial shift.
    const e = plan.radial / (0.875 * plan.rim);
    const [inward, still, outward] = [scaleNcc(1 - e), scaleNcc(1), scaleNcc(1 + e)];
    console.log(
      `ring ${STAR}: crest at ${plan.t.toFixed(2)} s, centre (${cx.toFixed(1)}, ${cy.toFixed(1)}) ` +
        `px, rim ${plan.rim.toFixed(1)} px; predicted mid-line push ${plan.radial.toFixed(2)} px, ` +
        `bright ${plan.bright.toFixed(3)}; annulus ${annulus.length} px, mean |crest - rest| ` +
        `${change.toFixed(3)}, mean luma lift ${lift.toFixed(3)}; ${moved.length} changed px, ` +
        `ncc inward ${inward.toFixed(4)}, still ${still.toFixed(4)}, outward ${outward.toFixed(4)}`,
    );
    // The mirror pushes outward and brightens on a crest.
    expect(plan.radial).toBeGreaterThan(3);
    expect(plan.bright).toBeGreaterThan(0.2);
    // A zero ringMotion leaves the annulus unchanged.
    expect(change).toBeGreaterThan(2);
    expect(moved.length).toBeGreaterThan(annulus.length / 10);
    // The GPU brightens it, and moves it the way the mirror does: outward, not inward or not at all.
    expect(lift).toBeGreaterThan(0);
    expect(outward).toBeGreaterThan(still);
    expect(still).toBeGreaterThan(inward);
    // Nothing outside the rings moves: the village and hills match byte for byte.
    expect(boxDiff(rest, crest, [0.0, 0.8, 1.0, 1.0])).toBe(0);
    expect(await glErrors(page)).toEqual([]);
  });

  test('the halo is the one additive pass: 1 draw per desktop frame, 2 per XR frame', async ({
    page,
    xr,
  }) => {
    test.setTimeout(240_000);
    // Counts draws made while blending is on, from the GL state three sets, one bucket per
    // animation frame: every window rAF callback of one frame gets the same timestamp. IWER runs
    // its XR frames from the window's rAF, so the bucket holds the whole XR frame too. A draw is
    // additive when its destination factor is ONE.
    await page.addInitScript(() => {
      const proto = WebGL2RenderingContext.prototype;
      interface Bucket {
        t: number;
        draws: number;
        blended: number;
        additive: number;
      }
      const stats = { frames: [] as Bucket[], current: null as Bucket | null };
      (window as unknown as { __blendStats: typeof stats }).__blendStats = stats;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
        raf((t) => {
          if (stats.current?.t !== t) {
            if (stats.current) stats.frames.push(stats.current);
            if (stats.frames.length > 240) stats.frames.shift();
            stats.current = { t, draws: 0, blended: 0, additive: 0 };
          }
          callback(t);
        });
      let blend = false;
      let dst = 0;
      const BLEND = 0x0be2;
      const ONE = 1;
      const { enable, disable, blendFunc, blendFuncSeparate } = proto;
      proto.enable = function (this: WebGL2RenderingContext, cap: GLenum) {
        if (cap === BLEND) blend = true;
        return enable.call(this, cap);
      };
      proto.disable = function (this: WebGL2RenderingContext, cap: GLenum) {
        if (cap === BLEND) blend = false;
        return disable.call(this, cap);
      };
      proto.blendFunc = function (this: WebGL2RenderingContext, s: GLenum, d: GLenum) {
        dst = d;
        return blendFunc.call(this, s, d);
      };
      proto.blendFuncSeparate = function (
        this: WebGL2RenderingContext,
        s: GLenum,
        d: GLenum,
        sa: GLenum,
        da: GLenum,
      ) {
        dst = d;
        return blendFuncSeparate.call(this, s, d, sa, da);
      };
      const draws = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'];
      const table = proto as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const name of draws) {
        const draw = table[name];
        table[name] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
          const bucket = stats.current;
          if (bucket) {
            bucket.draws++;
            if (blend) {
              bucket.blended++;
              if (dst === ONE) bucket.additive++;
            }
          }
          return draw.apply(this, args);
        };
      }
    });
    await xr.boot('painting=starry-night&seed=1&nogov&motiont=3');
    await expect
      .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
      .toBe(true);
    await xr.waitFrames(5);
    // The diag's halo state is the TS mirror on the CPU (SkyHalo.state), not read back from the GPU.
    const halo = (await xr.diag()).halo as HaloDiag;
    expect(halo.visible).toBe(true);
    expect(halo.halos.every((h) => h.ring > 0)).toBe(true);

    /** Every animation frame that drew over the next dozen frames, fewest and most draws. */
    const sample = async (): Promise<{
      frames: number;
      additive: [number, number];
      blended: [number, number];
    }> => {
      await page.evaluate(() => {
        (window as unknown as { __blendStats: { frames: unknown[] } }).__blendStats.frames = [];
      });
      await xr.waitFrames(12);
      return page.evaluate(() => {
        const { frames } = (
          window as unknown as {
            __blendStats: { frames: { draws: number; blended: number; additive: number }[] };
          }
        ).__blendStats;
        const drawn = frames.filter((f) => f.draws > 0);
        const range = (values: number[]): [number, number] => [
          Math.min(...values),
          Math.max(...values),
        ];
        return {
          frames: drawn.length,
          additive: range(drawn.map((f) => f.additive)),
          blended: range(drawn.map((f) => f.blended)),
        };
      });
    };
    const desktop = await sample();
    console.log(`halo pass: desktop ${JSON.stringify(desktop)}`);
    expect(desktop.frames).toBeGreaterThan(5);
    expect(desktop.additive).toEqual([1, 1]);
    expect(desktop.blended).toEqual(desktop.additive);

    await xr.enterXR();
    await xr.waitFrames(5);
    const immersive = await sample();
    console.log(`halo pass: XR ${JSON.stringify(immersive)}`);
    expect(immersive.frames).toBeGreaterThan(5);
    // IWER has no multiview, so three draws the halo once per eye.
    expect(immersive.additive).toEqual([2, 2]);
    expect(immersive.blended).toEqual(immersive.additive);
    expect(await glErrors(page)).toEqual([]);
  });
});

test.describe('cypress flame (P4.4)', () => {
  test.use({ viewport: { width: CAPTURE_SIZE.width, height: CAPTURE_SIZE.height } });

  /** Two pinned motion times, 1.6 s apart: 40% of a rise loop, so every stroke sits elsewhere. */
  const TIMES = [1.3, 2.9] as const;
  /**
   * The painted cypress's canvas box (CYPRESS_OUTLINE, u 0.121-0.463, v down 0.058-1), grown by
   * 0.05 on each side: the flame reach (at most 0.18 m, 1.0° at 10 m) plus half a stroke.
   */
  const BOX: readonly [number, number, number, number] = [0.071, 0.008, 0.513, 1];
  const CYPRESS_ONLY = 1 << STROKE_LAYER.cypress;

  async function cypressShot(page: Page, xr: Xr, extra: string): Promise<Buffer> {
    await xr.boot(
      `painting=starry-night&seed=1&shot&painter&nogov&motionlayers=cypress&nohalo&${extra}`,
    );
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

  /** Mean absolute channel difference inside and pixels differing outside the box. */
  function split(a: Buffer, b: Buffer): { inside: number; outsideDiffer: number } {
    const { width, height } = CAPTURE_SIZE;
    const channels = a.length / (width * height);
    const [u0, v0, u1, v1] = BOX;
    let sum = 0;
    let n = 0;
    let differ = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const k = (y * width + x) * channels;
        const inBox = x >= u0 * width && x < u1 * width && y >= v0 * height && y < v1 * height;
        let d = 0;
        for (let c = 0; c < 3; c++) d += Math.abs(a[k + c] - b[k + c]);
        if (inBox) {
          sum += d;
          n += 3;
        } else if (d > 0) {
          differ++;
        }
      }
    }
    return { inside: sum / n, outsideDiffer: differ };
  }

  test('the cypress moves between two pinned times while the ground and sky hold, and calm 0 is the rest pose', async ({
    page,
    xr,
  }) => {
    test.setTimeout(480_000);
    const rest = await cypressShot(page, xr, 'noanim');
    const still = await cypressShot(page, xr, `calm=0&motiont=${TIMES[0]}`);
    expect(await motion(xr)).toEqual({
      time: TIMES[0],
      calm: 0,
      frozen: false,
      layers: CYPRESS_ONLY,
    });
    const a = await cypressShot(page, xr, `motiont=${TIMES[0]}`);
    expect(await motion(xr)).toEqual({
      time: TIMES[0],
      calm: 1,
      frozen: false,
      layers: CYPRESS_ONLY,
    });
    const b = await cypressShot(page, xr, `motiont=${TIMES[1]}`);
    // Calm 0 closes the gate: byte for byte the rest pose.
    expect(still.equals(rest)).toBe(true);
    const moved = split(a, b);
    const fromRest = split(rest, a);
    console.log(
      `[e2e] cypress flame: box diff t ${TIMES[0]} vs ${TIMES[1]} ${moved.inside.toFixed(2)}, rest vs t ${TIMES[0]} ${fromRest.inside.toFixed(2)}; outside pixels differing ${moved.outsideDiffer}, ${fromRest.outsideDiffer}`,
    );
    expect(moved.inside).toBeGreaterThan(1);
    expect(fromRest.inside).toBeGreaterThan(1);
    // Nothing outside the cypress moves: the ground and sky are byte for byte the same.
    expect(moved.outsideDiffer).toBe(0);
    expect(fromRest.outsideDiffer).toBe(0);
    expect(await glErrors(page)).toEqual([]);
  });

  /**
   * The GPU probe's prediction (tests/motion-cypress-flame.test.ts writes it): per pair of pinned
   * times, the TS mirror's mean shift of the facing cypress strokes in each trunk patch, with
   * every phase pinned to `phase`.
   */
  interface Probe {
    phase: number;
    half: number;
    tolerance: { px: number; share: number };
    pairs: {
      name: string;
      times: [number, number];
      /** The shift components this pair holds to the prediction. */
      checks: ('dx' | 'dy')[];
      patches: { u: number; v: number; cx: number; cy: number; dx: number; dy: number }[];
    }[];
  }
  const PROBE: Probe = JSON.parse(
    readFileSync(new URL('../fixtures/cypress-probe.json', import.meta.url), 'utf8'),
  );

  test('trunk patches rise and sway by the TS prediction with every phase pinned (I3)', async ({
    page,
    xr,
  }) => {
    test.setTimeout(480_000);
    const times = [...new Set(PROBE.pairs.flatMap((p) => p.times))];
    const shots = new Map<number, Float32Array>();
    for (const t of times) {
      shots.set(t, luma(await cypressShot(page, xr, `motionphase=${PROBE.phase}&motiont=${t}`)));
      expect((await motion(xr)).time).toBe(t);
    }
    const { px, share } = PROBE.tolerance;
    const tolerance = (v: number): number => px + share * Math.abs(v);
    type Shift = { dx: number; dy: number };
    const rows: { name: string; checks: ('dx' | 'dy')[]; p: Shift; m: Shift }[] = [];
    for (const pair of PROBE.pairs) {
      const [a, b] = pair.times.map((t) => shots.get(t) as Float32Array);
      for (const p of pair.patches) {
        const m = shiftAt(a, b, p.cx, p.cy, PROBE.half, 32);
        console.log(
          `cypress probe ${pair.name} (${p.u}, ${p.v}): predicted (${p.dx}, ${p.dy}) px, ` +
            `measured (${m.dx.toFixed(2)}, ${m.dy.toFixed(2)}) sharp ${m.sharpness.toFixed(1)}`,
        );
        rows.push({ name: `${pair.name} patch (${p.u}, ${p.v})`, checks: pair.checks, p, m });
      }
    }
    for (const { name, checks, p, m } of rows) {
      for (const k of checks) {
        expect(Math.abs(m[k] - p[k]), `${name} ${k}`).toBeLessThanOrEqual(tolerance(p[k]));
      }
    }
    expect(await glErrors(page)).toEqual([]);
  });
});
