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
import { DEFAULT_BAND_SIZE } from '../../src/render/strokes/bands.ts';
import { STROKE_LAYER } from '../../src/render/strokes/instance.ts';
import { srgb8ToLab } from '../../src/util/cielab.ts';
import { luma, shiftAt } from './block-match';
import { expect, glErrors, test, type Xr } from './fixtures';
import { handOrbsOff } from './helpers';

/** The clock's hold mask with no `?wrap`: the default wheelrun holds the sky gate at calm 0. */
const DEFAULT_HOLD = 1 << STROKE_LAYER.sky;
/** Every motion layer and the reactive bit but the sky's, as a `?motionlayers` flag. */
const ALL_BUT_SKY = 'motionlayers=star,moon,cypress,reactive';

interface MotionDiag {
  time: number;
  delta: number;
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

  expect(before).toEqual({
    time: 0,
    delta: 0,
    calm: 1,
    frozen: true,
    layers: MOTION_LAYER_MASK,
    hold: DEFAULT_HOLD,
  });
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

  await xr.boot('scene=bare&calm=0.5');
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

  await xr.boot('scene=bare&calm=0');
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
   * Patch candidates, canvas (u, v down): points of a 0.1 grid over the sky (u 0.35-0.85, v
   * 0.1-0.4) that the prediction moves 4 px or more. Every shot opens the sky layer alone
   * (`?motionlayers=sky`) and hides the halo (`?nohalo`), so the P4.3 rings neither move nor
   * brighten the light strokes and the block match reads the sky swirl alone; the rings have their
   * own test below. The star and moon layers stay still, so a block that reaches a ring's rim can
   * lock on them at no shift. The base test drops those by the wave test's ring-clearance rule,
   * which leaves 10 of these 14 on seed 1: (0.35, 0.4), (0.45, 0.1), (0.65, 0.3) and (0.85, 0.3)
   * reach a rim. Of the rest of the grid, (0.35, 0.1), (0.35, 0.3), (0.55, 0.1), (0.65, 0.1),
   * (0.65, 0.2), (0.75, 0.2), (0.75, 0.3) and (0.85, 0.2) read under 1 px, the moon at (0.85, 0.1)
   * matches nowhere, and (0.55, 0.4) moves under 4 px.
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
    // Every band at density 1 draws every stored stroke, whichever end of its order a density cut
    // keeps (`drawsSuffix`), so the block matches read the whole dome and not the far band's 0.4
    // sample of it. The band sizes stay the defaults.
    await page.evaluate((size) => {
      if (!window.__goghBands) throw new Error('__goghBands is e2e-only');
      window.__goghBands({ density: { near: 1, mid: 1, far: 1 }, size });
    }, DEFAULT_BAND_SIZE);
    await xr.waitFrames(5);
    const url = await page.evaluate(() => {
      if (!window.__goghShot) throw new Error('__goghShot is not installed; boot with ?diag&shot');
      return window.__goghShot();
    });
    return rawPixels(url);
  }

  // Base's own loop (`?wrap=base`): the wave sets each stroke's phase from its direction and the
  // default wheelrun moves each along its own river velocity, so the pin would not move the sky
  // coherently. The wave's own test is below, and the river's sign check is in
  // sky-wheel-stream.spec.ts.
  test('a pinned coherent phase moves the sky along the TS prediction, half as far at calm 0.5', async ({
    page,
    xr,
  }) => {
    test.setTimeout(480_000);
    const { width, height } = CAPTURE_SIZE;
    const rest = await painterShot(page, xr, 'noanim&wrap=base');
    const still = await painterShot(page, xr, `calm=0&motiont=${PINNED}&wrap=base`);
    expect(await motion(xr)).toEqual({
      time: PINNED,
      delta: 0,
      calm: 0,
      frozen: false,
      layers: SKY_ONLY,
      hold: 0,
    });
    const half = await painterShot(page, xr, `calm=0.5&motiont=${PINNED}&wrap=base`);
    const full = await painterShot(page, xr, `calm=1&motiont=${PINNED}&wrap=base`);
    expect(((await xr.diag()).variants as { wrap: string }).wrap).toBe('base');
    expect(await motion(xr)).toEqual({
      time: PINNED,
      delta: 0,
      calm: 1,
      frozen: false,
      layers: SKY_ONLY,
      hold: 0,
    });
    expect(((await xr.diag()).halo as { visible: boolean }).visible).toBe(false);
    // Pinned: the time holds while frames run.
    await xr.waitFrames(10);
    expect((await motion(xr)).time).toBe(PINNED);
    // Calm 0 closes the gate: byte for byte the rest pose.
    expect(still.equals(rest)).toBe(true);

    const { predicted, clear } = await page.evaluate(
      ([points, time, half, w, h]) => {
        const skyShift = window.__goghSkyShift;
        const ringShift = window.__goghRingShift;
        if (!skyShift || !ringShift)
          throw new Error('__goghSkyShift and __goghRingShift are e2e-only');
        // The rings, in pixels: the probe throws past the last one.
        const discs: { x: number; y: number; rim: number }[] = [];
        for (let k = 0; k < 64; k++) {
          let ring: ReturnType<typeof ringShift>;
          try {
            ring = ringShift(k, 0.5, 0.3, 0);
          } catch {
            break;
          }
          if (ring) discs.push({ x: ring.centre[0] * w, y: ring.centre[1] * h, rim: ring.rim * w });
        }
        return {
          predicted: points.map(([u, v]) => skyShift(u, v, 1, time, 0, 'base')),
          clear: points.map(([u, v]) =>
            discs.every((d) => Math.hypot(u * w - d.x, v * h - d.y) > d.rim + half * Math.SQRT2),
          ),
        };
      },
      [PATCHES, PINNED, HALF, width, height] as const,
    );
    const [restL, halfL, fullL] = [luma(rest), luma(half), luma(full)];
    const rows: { u: number; v: number; ratio: number; angle: number; sharpness: number }[] = [];
    PATCHES.forEach(([u, v], i) => {
      if (!clear[i]) {
        console.log(`sky swirl patch (${u}, ${v}): skipped, its block reaches a star or moon rim`);
        return;
      }
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
    expect(rows.length).toBeGreaterThanOrEqual(10);
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

  // The `wrap` diag is the TS mirror, so this checks the GPU's own wave phase (motion.glsl
  // skyWavePhase): its windings, sign, stereographic convention and atan argument order. Under the
  // pin every stroke's jitter is the same, so each stroke's loop phase is the mirror's wave phase at
  // its direction. The wave's shift changes fast across the view, so at one time most patches
  // straddle a band edge, where no single shift describes the block. Each patch is instead shot at
  // its own two turns, the mirror's times of its largest shift ahead and back (tau ±4 s), where tau
  // is flat to first order. The patches are a 0.05 grid over the sky (u 0.35-0.85, v 0.1-0.4),
  // less any whose block, grown by its diagonal, reaches a star or moon ring's rim (those strokes
  // stay still under `motionlayers=sky` and hold the match at 0), and less any turn whose predicted
  // shift varies by over 30% across the block (near a vortex core). A wrong sign or winding puts a
  // patch elsewhere in its loop at those times, off the prediction.
  test('the wave wrap carries each sky patch ahead and back as the TS mirror predicts, at its own turns', async ({
    page,
    xr,
  }) => {
    test.setTimeout(480_000);
    const { width, height } = CAPTURE_SIZE;
    /** The turns move a patch twice base's shift at the pin, up to about 29 px. */
    const WAVE_SEARCH = 32;
    const restL = luma(await painterShot(page, xr, 'noanim&wrap=wave'));
    await painterShot(page, xr, 'wrap=wave&motiont=0');
    expect(((await xr.diag()).variants as { wrap: string }).wrap).toBe('wave');
    const { rings, plan } = await page.evaluate(
      ([half, w, h]) => {
        const skyShift = window.__goghSkyShift;
        const ringShift = window.__goghRingShift;
        if (!skyShift || !ringShift)
          throw new Error('__goghSkyShift and __goghRingShift are e2e-only');
        const shift = (u: number, v: number, t: number, wrap: 'base' | 'wave'): number[] => {
          const s = skyShift(u, v, 1, t, 0, wrap);
          if (!s) throw new Error(`no prediction at (${u}, ${v})`);
          return [s[0] * w, s[1] * h];
        };
        // The rings, in pixels: the probe throws past the last one.
        const discs: { x: number; y: number; rim: number }[] = [];
        for (let k = 0; k < 64; k++) {
          let ring: ReturnType<typeof ringShift>;
          try {
            ring = ringShift(k, 0.5, 0.3, 0);
          } catch {
            break;
          }
          if (ring) discs.push({ x: ring.centre[0] * w, y: ring.centre[1] * h, rim: ring.rim * w });
        }
        const turns: { u: number; v: number; turn: string; t: number; shift: number[] }[] = [];
        for (let i = 0; i <= 10; i++) {
          for (let j = 0; j <= 6; j++) {
            const u = Math.round(35 + 5 * i) / 100;
            const v = Math.round(10 + 5 * j) / 100;
            const clear = discs.every(
              (d) => Math.hypot(u * w - d.x, v * h - d.y) > d.rim + half * Math.SQRT2,
            );
            if (!clear) continue;
            // Base 2 s past mid-loop: its shift points downstream.
            const flow = shift(u, v, 6, 'base');
            let ahead = { t: 0, along: -Infinity };
            let back = { t: 0, along: Infinity };
            for (let k = 0; k < 160; k++) {
              const s = shift(u, v, k * 0.05, 'wave');
              const along = s[0] * flow[0] + s[1] * flow[1];
              if (along > ahead.along) ahead = { t: k * 0.05, along };
              if (along < back.along) back = { t: k * 0.05, along };
            }
            for (const [turn, t] of [
              ['ahead', ahead.t],
              ['back', back.t],
            ] as const) {
              const centre = shift(u, v, t, 'wave');
              const size = Math.hypot(centre[0], centre[1]);
              let spread = 0;
              for (const du of [-half, 0, half]) {
                for (const dv of [-half, 0, half]) {
                  const s = shift(u + du / w, v + dv / h, t, 'wave');
                  spread = Math.max(spread, Math.hypot(s[0] - centre[0], s[1] - centre[1]));
                }
              }
              if (size >= 4 && spread <= 0.3 * size) turns.push({ u, v, turn, t, shift: centre });
            }
          }
        }
        return { rings: discs.length, plan: turns };
      },
      [HALF, width, height] as const,
    );
    expect(rings).toBe(12);
    let ahead = 0;
    let back = 0;
    for (const { u, v, turn, t, shift } of plan) {
      const [px, py] = shift;
      const predicted = Math.hypot(px, py);
      const name = `patch (${u}, ${v}) ${turn} at t ${t.toFixed(2)}`;
      await page.evaluate((time) => {
        if (!window.__goghMotionT) throw new Error('__goghMotionT is e2e-only and needs ?motiont');
        window.__goghMotionT(time);
      }, t);
      await xr.waitFrames(3);
      const url = await page.evaluate(() => {
        if (!window.__goghShot)
          throw new Error('__goghShot is not installed; boot with ?diag&shot');
        return window.__goghShot();
      });
      const movedL = luma(await rawPixels(url));
      const a = shiftAt(
        restL,
        movedL,
        Math.round(u * width),
        Math.round(v * height),
        HALF,
        WAVE_SEARCH,
      );
      const mag = Math.hypot(a.dx, a.dy);
      const angle =
        (Math.acos(Math.min(1, Math.max(-1, (a.dx * px + a.dy * py) / (mag * predicted)))) * 180) /
        Math.PI;
      console.log(
        `wave ${name}: predicted (${px.toFixed(2)}, ${py.toFixed(2)}) px, measured (${a.dx.toFixed(2)}, ${a.dy.toFixed(2)}) ` +
          `sharp ${a.sharpness.toFixed(1)}, angle ${angle.toFixed(1)} deg, ratio ${(mag / predicted).toFixed(2)}`,
      );
      expect(angle, name).toBeLessThan(30);
      expect(mag / predicted, name).toBeGreaterThan(0.5);
      expect(mag / predicted, name).toBeLessThan(1.5);
      if (turn === 'ahead') ahead++;
      else back++;
    }
    console.log(`wave: ${ahead} patches checked ahead, ${back} back`);
    expect(ahead).toBeGreaterThanOrEqual(8);
    expect(back).toBeGreaterThanOrEqual(8);
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

  /** The moon's ring: the last of SKY_RINGS (SKY_MOON_RING). Its still inner radius is 2/3 of the rim. */
  const MOON = 11;
  const MOON_INNER = 2 / 3;
  /**
   * The rim fraction past which the painter view shows no moon stroke the ring brightens: measured,
   * the lift is 0 past about 0.79 of the rim (1.19 moon radii), where the dome shows through and
   * its layer is closed here. The measured band stops there.
   */
  const MOON_OUTER = 0.79;
  /** CIELAB b* over which a rest pixel inside the moon disc is the crescent's gold. */
  const CRESCENT_B = 50;
  /** The crescent's core: b* over this, with every neighbour over it too. */
  const CRESCENT_CORE_B = 55;
  /** CIELAB b* under which a rest pixel inside the moon disc is its cream. */
  const CREAM_B = 40;
  /**
   * How far the crescent's outline may change while the disc ripples, from cream strokes whose
   * antialiased edges blend over it: no crescent stroke moves or brightens, but a cream stroke at
   * its brightest, 1 + 0.14 + 0.04 of a cream R or G of about 211, adds at most 38 levels at full
   * cover. The transition pixels may take up to that; the gold round the core, which a cream edge
   * covers only in part, up to 30 levels on at most 6% of its pixels (measured 26 and 4.1% over
   * ten times at seed 1).
   */
  const OUTLINE_TOLERANCE = { goldLevels: 30, goldShare: 0.06, transitionLevels: 40 };
  /**
   * The cream's relative lift per unit of the mirror's predicted ripple brightening: about 1 when
   * the GPU applies SKY_RING_MOON_DISC_BRIGHT (measured 0.82 to 1.01), so a gain off by half or
   * double fails.
   */
  const RIPPLE_SLOPE: readonly [number, number] = [0.7, 1.3];
  /** The cream's mean absolute luma change at the ripple's peak over the ten times (measured 21.6). */
  const CREAM_PEAK_LIFT: readonly [number, number] = [15, 30];
  /**
   * The RMS change, from one time to the next, of the cream's lift that the ripple leaves
   * unexplained: 0.052 with the shimmer and 0.016 with motion.glsl's shimmer line deleted.
   */
  const SHIMMER_RESIDUAL_MIN = 0.03;
  /**
   * A frame-geometry guard, not the P4.3 colour clip (that is the moon-disc test below): bounds on
   * the share of the moon's band, its radius to its rim, that falls outside the painter frame at its
   * top edge (measured 24.0% since canvas uv excludes the mat, 16.7% before), so a moved moon or
   * camera fails.
   */
  const FRAME_OUT_SHARE: readonly [number, number] = [0.22, 0.26];

  /** A shot of the running page after moving the `?motiont` pin to `t` (`__goghMotionT`). */
  async function shotAt(page: Page, xr: Xr, t: number): Promise<Buffer> {
    await page.evaluate((time) => {
      if (!window.__goghMotionT) throw new Error('__goghMotionT is e2e-only and needs ?motiont');
      window.__goghMotionT(time);
    }, t);
    await xr.waitFrames(3);
    expect((await motion(xr)).time).toBeCloseTo(t, 9);
    const url = await page.evaluate(() => {
      if (!window.__goghShot) throw new Error('__goghShot is not installed; boot with ?diag&shot');
      return window.__goghShot();
    });
    return rawPixels(url);
  }

  /** Canvas pixel indices of the annulus r0..r1 (fractions of `rim` px) round (cx, cy), in frame. */
  function annulusOf(
    cx: number,
    cy: number,
    rim: number,
    r0: number,
    r1: number,
  ): { inside: number[]; total: number } {
    const { width, height } = CAPTURE_SIZE;
    const inside: number[] = [];
    let total = 0;
    for (let y = Math.floor(cy - rim); y <= Math.ceil(cy + rim); y++) {
      for (let x = Math.floor(cx - rim); x <= Math.ceil(cx + rim); x++) {
        const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / rim;
        if (r < r0 || r > r1) continue;
        total++;
        if (x >= 0 && y >= 0 && x < width && y < height) inside.push(y * width + x);
      }
    }
    return { inside, total };
  }

  test('the moon ring travels outward over time, as the TS mirror predicts (P4.3 a)', async ({
    page,
    xr,
  }) => {
    test.setTimeout(300_000);
    // The moon layer alone and no halo, so only the moon's ring strokes differ from the rest shot.
    const flags = 'motionlayers=moon&nohalo';
    const rest = await lightsShot(page, xr, `noanim&${flags}`);
    await expect.poll(() => page.evaluate(() => window.__goghRingShift !== undefined)).toBe(true);
    const { width, height } = CAPTURE_SIZE;
    // The crest's ringBump spans a whole wavelength, the rim, and the band only an eighth of it, so
    // the band's brightening centroid barely moves. The balance does: the outer half's share of the
    // band's brightening less the inner half's, which rises as the crest crosses the band outward.
    // The pair of times 1 s apart over which the mirror's balance rises the most, with at least 30%
    // of the most brightening in the band at both.
    const plan = await page.evaluate(
      ([k, inner, outerEdge, w, h]) => {
        const probe = window.__goghRingShift;
        if (!probe) throw new Error('__goghRingShift is e2e-only');
        const base = probe(k, 0.5, 0.3, 0);
        if (!base) throw new Error(`ring ${k} is off the painter view`);
        const rim = base.rim * w;
        const mid = (inner + outerEdge) / 2;
        const profile = (t: number): { balance: number; mass: number } => {
          let outer = 0;
          let near = 0;
          for (let i = 0; i <= 16; i++) {
            const r = inner + ((outerEdge - inner) * (i + 0.5)) / 17;
            for (let a = 0; a < 24; a++) {
              const th = (a / 24) * 2 * Math.PI;
              const u = base.centre[0] + (r * rim * Math.cos(th)) / w;
              const v = base.centre[1] + (r * rim * Math.sin(th)) / h;
              if (u < 0 || u > 1 || v < 0 || v > 1) continue;
              const m = probe(k, u, v, t);
              if (!m) continue;
              if (r >= mid) outer += m.bright;
              else near += m.bright;
            }
          }
          const mass = outer + near;
          return { balance: mass > 0 ? (outer - near) / mass : 0, mass };
        };
        const profiles = Array.from({ length: 200 }, (_, i) => ({
          t: i * 0.05,
          ...profile(i * 0.05),
        }));
        const most = Math.max(...profiles.map((p) => p.mass));
        let best = { t1: 0, t2: 1, b1: 0, b2: 0, gain: -Infinity };
        for (const p of profiles) {
          const q = { t: p.t + 1, ...profile(p.t + 1) };
          if (p.mass < 0.3 * most || q.mass < 0.3 * most) continue;
          if (q.balance - p.balance > best.gain) {
            best = {
              t1: p.t,
              t2: q.t,
              b1: p.balance,
              b2: q.balance,
              gain: q.balance - p.balance,
            };
          }
        }
        return { centre: [base.centre[0] * w, base.centre[1] * h], rim, ...best };
      },
      [MOON, MOON_INNER, MOON_OUTER, width, height] as const,
    );
    await xr.boot(
      `painting=starry-night&seed=1&shot&painter&nogov&motionphase=0&motiont=${plan.t1}&${flags}`,
    );
    await expect
      .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
      .toBe(true);
    await xr.waitFrames(5);
    const early = await shotAt(page, xr, plan.t1);
    const late = await shotAt(page, xr, plan.t2);

    const [cx, cy] = plan.centre;
    const band = annulusOf(cx, cy, plan.rim, MOON_INNER, MOON_OUTER);
    const whole = annulusOf(cx, cy, plan.rim, MOON_INNER, 1);
    // The share of the moon's band, its radius to its rim, that falls outside the painter frame.
    const clip = 1 - whole.inside.length / whole.total;
    const restL = lumaOf(rest);
    const mid = (MOON_INNER + MOON_OUTER) / 2;
    // The mean lift over the whole band in eight radial bins, logged.
    const bins = (shot: Buffer): string => {
      const l = lumaOf(shot);
      const sum = new Array(8).fill(0);
      const n = new Array(8).fill(0);
      for (const i of whole.inside) {
        const r = Math.hypot((i % width) + 0.5 - cx, Math.floor(i / width) + 0.5 - cy) / plan.rim;
        const k = Math.min(7, Math.floor(((r - MOON_INNER) / (1 - MOON_INNER)) * 8));
        sum[k] += Math.max(l[i] - restL[i], 0);
        n[k]++;
      }
      return sum.map((v, k) => (v / Math.max(n[k], 1)).toFixed(2)).join(' ');
    };
    const balance = (shot: Buffer): { balance: number; lift: number } => {
      const l = lumaOf(shot);
      let outer = 0;
      let near = 0;
      for (const i of band.inside) {
        const lift = Math.max(l[i] - restL[i], 0);
        const r = Math.hypot((i % width) + 0.5 - cx, Math.floor(i / width) + 0.5 - cy) / plan.rim;
        if (r >= mid) outer += lift;
        else near += lift;
      }
      const mass = outer + near;
      return { balance: (outer - near) / mass, lift: mass / band.inside.length };
    };
    const a = balance(early);
    const b = balance(late);
    console.log(
      `moon ring lift by radius, ${MOON_INNER.toFixed(3)}-1 of the rim: early ${bins(early)}; late ${bins(late)}`,
    );
    console.log(
      `moon ring: centre (${cx.toFixed(1)}, ${cy.toFixed(1)}) px, rim ${plan.rim.toFixed(1)} px, band clipped ${(clip * 100).toFixed(1)}%; t ${plan.t1.toFixed(2)} to ${plan.t2.toFixed(2)} s: predicted outer-less-inner balance ${plan.b1.toFixed(3)} to ${plan.b2.toFixed(3)}, measured ${a.balance.toFixed(3)} to ${b.balance.toFixed(3)} (mean lift ${a.lift.toFixed(2)}, ${b.lift.toFixed(2)})`,
    );
    // The mirror's crest moves outward, and so does the GPU's, by at least a third as much. Only the
    // rise is held, not the balance itself: the mirror weights every radius evenly, while the moon
    // strokes thin out towards 0.79 of the rim (they stop at about 1.19 moon radii, and the halo
    // carries the travel past that), so the measured balance sits far below the predicted one.
    expect(plan.gain).toBeGreaterThan(0.1);
    expect(a.lift).toBeGreaterThan(0.2);
    expect(b.lift).toBeGreaterThan(0.2);
    expect(b.balance - a.balance).toBeGreaterThan(plan.gain / 3);
    expect(clip).toBeGreaterThanOrEqual(FRAME_OUT_SHARE[0]);
    expect(clip).toBeLessThanOrEqual(FRAME_OUT_SHARE[1]);
    expect(await glErrors(page)).toEqual([]);
  });

  /**
   * The moon disc in painter-view pixels, as P4.3 measured its clip (the crescent clipping to flat
   * lemon): the moon anchor's `anchorReach(anchor, 1)` circle on the dome's tangent plane at the
   * ring centre, projected through the painter camera as a 128-point polygon (`__goghMoonDisc`,
   * because Playwright cannot load sky.ts, which imports regions.json). Pixel centres inside.
   */
  async function moonDisc(page: Page): Promise<number[]> {
    const { width, height } = CAPTURE_SIZE;
    await expect.poll(() => page.evaluate(() => window.__goghMoonDisc !== undefined)).toBe(true);
    const uv = await page.evaluate(() => {
      if (!window.__goghMoonDisc) throw new Error('__goghMoonDisc is e2e-only');
      return window.__goghMoonDisc(128);
    });
    if (!uv) throw new Error('the moon disc is behind the painter camera');
    const rim = uv.map(([u, v]) => [u * width, v * height] as const);
    const inside = (x: number, y: number): boolean => {
      let hit = false;
      for (let i = 0, j = rim.length - 1; i < rim.length; j = i++) {
        const [xi, yi] = rim[i];
        const [xj, yj] = rim[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    const xs = rim.map((p) => p[0]);
    const ys = rim.map((p) => p[1]);
    const out: number[] = [];
    for (
      let y = Math.max(0, Math.floor(Math.min(...ys)));
      y <= Math.min(height - 1, Math.ceil(Math.max(...ys)));
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(Math.min(...xs)));
        x <= Math.min(width - 1, Math.ceil(Math.max(...xs)));
        x++
      ) {
        if (inside(x + 0.5, y + 0.5)) out.push(y * width + x);
      }
    }
    return out;
  }

  /** The share of `pixels` whose R or G is clipped, 254 or more. */
  function clippedShare(raw: Buffer, pixels: readonly number[]): number {
    const channels = raw.length / (CAPTURE_SIZE.width * CAPTURE_SIZE.height);
    let clipped = 0;
    for (const i of pixels) {
      const k = i * channels;
      if (raw[k] >= 254 || raw[k + 1] >= 254) clipped++;
    }
    return clipped / pixels.length;
  }

  /** The brightest R and G over `pixels`, logged as the clip's headroom. */
  function peakRG(raw: Buffer, pixels: readonly number[]): string {
    const channels = raw.length / (CAPTURE_SIZE.width * CAPTURE_SIZE.height);
    let r = 0;
    let g = 0;
    for (const i of pixels) {
      r = Math.max(r, raw[i * channels]);
      g = Math.max(g, raw[i * channels + 1]);
    }
    return `R ${r}, G ${g}`;
  }

  test('the moon disc does not clip to flat lemon: under 1% R or G at 254 or more at its crest, none at rest (P4.3 clip)', async ({
    page,
    xr,
  }) => {
    test.setTimeout(300_000);
    // At rest: every layer open, the halo drawn.
    const rest = await lightsShot(page, xr, 'noanim');
    const disc = await moonDisc(page);
    expect(disc.length).toBeGreaterThan(1000);
    const restShare = clippedShare(rest, disc);
    await expect.poll(() => page.evaluate(() => window.__goghRingShift !== undefined)).toBe(true);
    // The crest: the time in the first 20 s (two moon periods) at which the mirror's mean
    // brightening over the moon's band, its radius to its rim, peaks.
    const crest = await page.evaluate(
      ([k, inner, span, w, h]) => {
        const probe = window.__goghRingShift;
        if (!probe) throw new Error('__goghRingShift is e2e-only');
        const base = probe(k, 0.5, 0.3, 0);
        if (!base) throw new Error(`ring ${k} is off the painter view`);
        const rim = base.rim * w;
        let best = { t: 0, bright: -1 };
        for (let s = 0; s < span * 20; s++) {
          const t = s * 0.05;
          let sum = 0;
          let n = 0;
          for (let i = 0; i < 12; i++) {
            const r = inner + ((1 - inner) * (i + 0.5)) / 12;
            for (let a = 0; a < 24; a++) {
              const th = (a / 24) * 2 * Math.PI;
              const u = base.centre[0] + (r * rim * Math.cos(th)) / w;
              const v = base.centre[1] + (r * rim * Math.sin(th)) / h;
              if (u < 0 || u > 1 || v < 0 || v > 1) continue;
              const m = probe(k, u, v, t);
              if (!m) continue;
              sum += m.bright;
              n++;
            }
          }
          if (n > 0 && sum / n > best.bright) best = { t, bright: sum / n };
        }
        return { ...best, centre: [base.centre[0] * w, base.centre[1] * h], rim };
      },
      [MOON, MOON_INNER, 20, CAPTURE_SIZE.width, CAPTURE_SIZE.height] as const,
    );
    // Every motion layer but the sky's: under the river default with motionphase=0 the whole dome
    // round the disc moves and shrinks in step, which the clip share does not read.
    const shot = await lightsShot(page, xr, `motiont=${crest.t}&${ALL_BUT_SKY}`);
    expect((await motion(xr)).time).toBeCloseTo(crest.t, 9);
    const crestShare = clippedShare(shot, disc);
    // The crest is live: the moon band's mean luma, from its radius to 0.79 of its rim, is above the
    // rest shot's, so a 0% clip is read at a lit crest and not at a still ring.
    const band = annulusOf(crest.centre[0], crest.centre[1], crest.rim, MOON_INNER, MOON_OUTER);
    const meanLuma = (raw: Buffer): number => {
      const l = lumaOf(raw);
      return band.inside.reduce((s, i) => s + l[i], 0) / band.inside.length;
    };
    const lift = meanLuma(shot) - meanLuma(rest);
    console.log(
      `[e2e] moon disc ${disc.length} px: R or G clipped ${(restShare * 100).toFixed(2)}% at rest (peak ${peakRG(rest, disc)}), ${(crestShare * 100).toFixed(2)}% at the crest (peak ${peakRG(shot, disc)}; motiont ${crest.t.toFixed(2)} s, predicted band brightening ${crest.bright.toFixed(3)}, band mean luma lift ${lift.toFixed(2)})`,
    );
    expect(crest.bright).toBeGreaterThan(0);
    expect(lift).toBeGreaterThan(1);
    expect(restShare).toBe(0);
    expect(crestShare).toBeLessThan(0.01);
    expect(await glErrors(page)).toEqual([]);
  });

  test('the moon disc ripples outward and shimmers as the TS mirror predicts while the crescent stays still, and calm 0 freezes it', async ({
    page,
    xr,
  }) => {
    test.setTimeout(420_000);
    const { width, height } = CAPTURE_SIZE;
    const rest = await lightsShot(page, xr, 'noanim');
    const disc = await moonDisc(page);
    const channels = rest.length / (width * height);
    const labB = (raw: Buffer, i: number): number =>
      srgb8ToLab(raw[i * channels], raw[i * channels + 1], raw[i * channels + 2])[2];
    const inDisc = new Set(disc);
    const restB = new Map(disc.map((i) => [i, labB(rest, i)]));
    const above = (i: number, b: number): boolean => (restB.get(i) ?? -Infinity) > b;
    const neighbours = (i: number): number[] => [i - 1, i + 1, i - width, i + width];
    // The crescent's whole shape: every gold pixel, and the 1 px ring round it where the outline's
    // antialiasing blends it with the cream. Its core, gold with gold neighbours, is held byte for
    // byte; the rest of it, the outline, to OUTLINE_TOLERANCE.
    const shape = disc.filter(
      (i) => above(i, CRESCENT_B) || neighbours(i).some((j) => above(j, CRESCENT_B)),
    );
    const core = disc.filter(
      (i) => above(i, CRESCENT_CORE_B) && neighbours(i).every((j) => above(j, CRESCENT_CORE_B)),
    );
    const coreSet = new Set(core);
    // The outline: the gold round the core, and the transition to the cream (b* 40 to 50). The
    // ring's pixels under b* 40 are the cream's own, or the dome showing between strokes.
    const goldEdge = shape.filter((i) => !coreSet.has(i) && above(i, CRESCENT_B));
    const transition = shape.filter((i) => !above(i, CRESCENT_B) && above(i, CREAM_B));
    const outline = [...goldEdge, ...transition];
    const shapeSet = new Set(shape);
    // The cream disc the crescent bites into, clear of the crescent's shape.
    const restL = lumaOf(rest);
    const cream = disc.filter(
      (i) =>
        !shapeSet.has(i) &&
        (restB.get(i) ?? Infinity) < CREAM_B &&
        restL[i] > 120 &&
        neighbours(i).every((j) => inDisc.has(j)),
    );
    expect(core.length).toBeGreaterThan(1000);
    expect(outline.length).toBeGreaterThan(500);
    expect(cream.length).toBeGreaterThan(1000);

    // Calm 0 at a pinned time is the rest world, byte for byte. Under wave: the default wheelrun
    // holds its kept discs at the pose the pinned time turned them to.
    const calm0 = await lightsShot(page, xr, 'calm=0&motiont=2.5&wrap=wave');
    expect(calm0.equals(rest)).toBe(true);

    await expect.poll(() => page.evaluate(() => window.__goghRingShift !== undefined)).toBe(true);
    // Ten times across the ripple's 10 s period, so a crest crosses the crescent between samples;
    // a step of 1 s is off the shimmer's 2.5 s cycle, so its phase differs from sample to sample.
    const times = Array.from({ length: 10 }, (_, k) => k);
    // The mirror's ripple brightening (the ring, no shimmer) at every cream pixel and time.
    const predicted = await page.evaluate(
      ([k, pixels, ts, w, h]) => {
        const probe = window.__goghRingShift;
        if (!probe) throw new Error('__goghRingShift is e2e-only');
        return ts.map((t) =>
          pixels.map(
            (i) => probe(k, ((i % w) + 0.5) / w, (Math.floor(i / w) + 0.5) / h, t)?.bright ?? 0,
          ),
        );
      },
      [MOON, cream, times, width, height] as const,
    );
    // The sky's motion is closed: under the river default with motionphase=0 the dome behind the
    // band moves and shrinks in step through the sweep, a luma swing the regression would read.
    await xr.boot(
      `painting=starry-night&seed=1&shot&painter&nogov&motionphase=0&motiont=0&${ALL_BUT_SKY}`,
    );
    await expect
      .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
      .toBe(true);
    await xr.waitFrames(5);
    /** Least squares of b on a: slope, intercept, correlation and the residuals' RMS. */
    const leastSquares = (a: readonly number[], b: readonly number[]) => {
      const n = a.length;
      const ma = a.reduce((s, v) => s + v, 0) / n;
      const mb = b.reduce((s, v) => s + v, 0) / n;
      let ab = 0;
      let aa = 0;
      let bb = 0;
      for (let i = 0; i < n; i++) {
        ab += (a[i] - ma) * (b[i] - mb);
        aa += (a[i] - ma) ** 2;
        bb += (b[i] - mb) ** 2;
      }
      const slope = ab / aa;
      const residual = a.map((v, i) => b[i] - mb - slope * (v - ma));
      const rms = Math.sqrt(residual.reduce((s, v) => s + v * v, 0) / n);
      return { slope, r: ab / Math.sqrt(aa * bb), residual, rms };
    };
    const report: string[] = [];
    const residuals: number[][] = [];
    const samples: Array<{ coreMoved: number; r: number; slope: number; clipped: number }> = [];
    let worstGold = 0;
    let worstTransition = 0;
    let goldEdgeMoved = 0;
    let peakLift = 0;
    for (const [n, t] of times.entries()) {
      const shot = await shotAt(page, xr, t);
      const delta = (i: number): number =>
        Math.max(
          ...[0, 1, 2].map((c) => Math.abs(shot[i * channels + c] - rest[i * channels + c])),
        );
      const coreMoved = core.filter((i) => delta(i) > 0);
      const goldDeltas = goldEdge.map(delta);
      const transitionDeltas = transition.map(delta);
      const outlineDeltas = [...goldDeltas, ...transitionDeltas];
      const moved = outlineDeltas.filter((d) => d > 0).length;
      const goldMoved = goldDeltas.filter((d) => d > 0).length;
      worstGold = Math.max(worstGold, ...goldDeltas);
      worstTransition = Math.max(worstTransition, ...transitionDeltas);
      goldEdgeMoved = Math.max(goldEdgeMoved, goldMoved);
      const l = lumaOf(shot);
      // The cream's relative lift follows the mirror's ripple, pixel by pixel.
      const lift = cream.map((i) => l[i] / restL[i] - 1);
      const f = leastSquares(predicted[n], lift);
      residuals.push(f.residual);
      const meanLift = cream.reduce((s, i) => s + Math.abs(l[i] - restL[i]), 0) / cream.length;
      peakLift = Math.max(peakLift, meanLift);
      const clipped = clippedShare(shot, disc);
      report.push(
        `t ${t}: core moved ${coreMoved.length}/${core.length}, outline moved ${moved}/${outline.length} (gold edge ${goldMoved}/${goldEdge.length}, max ${Math.max(...goldDeltas)}; transition max ${Math.max(...transitionDeltas)}), cream mean |lift| ${meanLift.toFixed(2)}, ripple r ${f.r.toFixed(3)} slope ${f.slope.toFixed(2)} residual rms ${f.rms.toFixed(4)}, disc clipped ${(clipped * 100).toFixed(2)}%`,
      );
      samples.push({ coreMoved: coreMoved.length, r: f.r, slope: f.slope, clipped });
    }
    // The shimmer: what the ripple leaves unexplained changes from one time to the next, stroke by
    // stroke. Without it the residual is the mirror's per-pixel error, which barely moves.
    let shimmer = 0;
    for (let n = 1; n < times.length; n++) {
      let sum = 0;
      for (let i = 0; i < cream.length; i++) sum += (residuals[n][i] - residuals[n - 1][i]) ** 2;
      shimmer += Math.sqrt(sum / cream.length);
    }
    shimmer /= times.length - 1;
    console.log(
      `[e2e] moon disc ripple: ${core.length} core px, ${outline.length} outline px, ${cream.length} cream px; peak cream mean |lift| ${peakLift.toFixed(2)}; gold edge worst ${worstGold}, most moved ${goldEdgeMoved}/${goldEdge.length}; transition worst ${worstTransition}; shimmer residual change rms ${shimmer.toFixed(4)}; ${report.join('; ')}`,
    );
    for (const sample of samples) {
      expect(sample.coreMoved).toBe(0);
      expect(sample.r).toBeGreaterThan(0.4);
      expect(sample.slope).toBeGreaterThan(RIPPLE_SLOPE[0]);
      expect(sample.slope).toBeLessThan(RIPPLE_SLOPE[1]);
      expect(sample.clipped).toBeLessThan(0.01);
    }
    // The ripple explains the cream's lift pixel by pixel (measured 0.45 to 0.79 per time with the
    // shimmer, whose per-stroke noise it cannot predict).
    expect(samples.reduce((sum, sample) => sum + sample.r, 0) / samples.length).toBeGreaterThan(
      0.55,
    );
    expect(peakLift).toBeGreaterThan(CREAM_PEAK_LIFT[0]);
    expect(peakLift).toBeLessThan(CREAM_PEAK_LIFT[1]);
    expect(shimmer).toBeGreaterThan(SHIMMER_RESIDUAL_MIN);
    expect(worstGold).toBeLessThanOrEqual(OUTLINE_TOLERANCE.goldLevels);
    expect(goldEdgeMoved).toBeLessThanOrEqual(OUTLINE_TOLERANCE.goldShare * goldEdge.length);
    expect(worstTransition).toBeLessThanOrEqual(OUTLINE_TOLERANCE.transitionLevels);
    expect(await glErrors(page)).toEqual([]);
  });

  test('the halo brightens and dims between two pinned times by the TS mirror, and calm 0 draws the rest halo (P4.3 b, c)', async ({
    page,
    xr,
  }) => {
    test.setTimeout(360_000);
    // (c) Calm 0 with the halo drawn is the frozen world, byte for byte. Under wave: the default
    // wheelrun holds its kept discs at the pose the pinned time turned them to.
    const rest = await lightsShot(page, xr, 'noanim');
    expect(((await xr.diag()).halo as HaloDiag).visible).toBe(true);
    const still = await lightsShot(page, xr, 'calm=0&motiont=3.3&wrap=wave');
    expect(((await xr.diag()).halo as HaloDiag).visible).toBe(true);
    expect((await motion(xr)).time).toBe(3.3);
    expect(still.equals(rest)).toBe(true);

    // (b) The star 10 halo's mean predicted glow over its disc, 0.6 of the rim: the pinned times
    // on a 0.1 s grid over 10 s at which the mirror's glow is highest and lowest.
    await expect.poll(() => page.evaluate(() => window.__goghHaloGlow !== undefined)).toBe(true);
    const { width, height } = CAPTURE_SIZE;
    const plan = await page.evaluate(
      ([k, w, h]) => {
        const ring = window.__goghRingShift;
        const glow = window.__goghHaloGlow;
        if (!ring || !glow) throw new Error('the ring and halo probes are e2e-only');
        const base = ring(k, 0.5, 0.3, 0);
        if (!base) throw new Error(`ring ${k} is off the painter view`);
        const rim = base.rim * w;
        const cx = base.centre[0] * w;
        const cy = base.centre[1] * h;
        const pixels: number[] = [];
        for (let y = Math.floor(cy - 0.6 * rim); y <= Math.ceil(cy + 0.6 * rim); y += 2) {
          for (let x = Math.floor(cx - 0.6 * rim); x <= Math.ceil(cx + 0.6 * rim); x += 2) {
            if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= 0.6 * rim) pixels.push(y * w + x);
          }
        }
        const mean = (t: number): number => {
          let sum = 0;
          for (const i of pixels) {
            sum += glow(k, ((i % w) + 0.5) / w, (Math.floor(i / w) + 0.5) / h, t) ?? 0;
          }
          return sum / pixels.length;
        };
        let hi = { t: 0, glow: -Infinity };
        let lo = { t: 0, glow: Infinity };
        for (let i = 0; i < 100; i++) {
          const t = Math.round(i * 10) / 100;
          const g = mean(t);
          if (g > hi.glow) hi = { t, glow: g };
          if (g < lo.glow) lo = { t, glow: g };
        }
        return { pixels, hi, lo };
      },
      [STAR, width, height] as const,
    );
    const pair = async (extra: string): Promise<[Buffer, Buffer]> => {
      await xr.boot(`painting=starry-night&seed=1&shot&painter&nogov&motiont=${plan.hi.t}${extra}`);
      await expect
        .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
        .toBe(true);
      await xr.waitFrames(5);
      return [await shotAt(page, xr, plan.hi.t), await shotAt(page, xr, plan.lo.t)];
    };
    const [hi, lo] = await pair('');
    expect(((await xr.diag()).halo as HaloDiag).visible).toBe(true);
    const [hiBare, loBare] = await pair('&nohalo');
    expect(((await xr.diag()).halo as HaloDiag).visible).toBe(false);
    // The halo's own light: the shot less the no-halo shot at the same time, so the moving
    // strokes cancel. A pixel with a saturated channel in any of the four shots is left out of
    // both times, so the brighter time does not lose its brightest pixels alone.
    const channels = hi.length / (width * height);
    const kept = plan.pixels.filter((i) =>
      [hi, lo, hiBare, loBare].every((shot) =>
        [0, 1, 2].every((c) => shot[i * channels + c] < 250),
      ),
    );
    const haloLight = (on: Buffer, off: Buffer): number => {
      const onL = lumaOf(on);
      const offL = lumaOf(off);
      let sum = 0;
      for (const i of kept) sum += onL[i] - offL[i];
      return sum / kept.length;
    };
    const atHi = haloLight(hi, hiBare);
    const atLo = haloLight(lo, loBare);
    console.log(
      `halo ${STAR}: predicted mean glow ${plan.hi.glow.toFixed(4)} at ${plan.hi.t.toFixed(1)} s, ${plan.lo.glow.toFixed(4)} at ${plan.lo.t.toFixed(1)} s; measured halo light ${atHi.toFixed(3)} and ${atLo.toFixed(3)} luma over ${kept.length} of ${plan.pixels.length} px`,
    );
    expect(plan.hi.glow).toBeGreaterThan(plan.lo.glow);
    // The halo adds light at both times, and more where the mirror says it is brighter.
    expect(atLo).toBeGreaterThan(0);
    expect(atHi - atLo).toBeGreaterThan(0.5);
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
    // The hand orbs are an additive pass of their own, round each controller.
    await handOrbsOff(page);
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
      delta: 0,
      calm: 0,
      frozen: false,
      layers: CYPRESS_ONLY,
      hold: DEFAULT_HOLD,
    });
    const a = await cypressShot(page, xr, `motiont=${TIMES[0]}`);
    expect(await motion(xr)).toEqual({
      time: TIMES[0],
      delta: 0,
      calm: 1,
      frozen: false,
      layers: CYPRESS_ONLY,
      hold: DEFAULT_HOLD,
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
