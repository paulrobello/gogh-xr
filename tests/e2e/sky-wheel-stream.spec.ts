/**
 * The wheel and stream sky wraps (src/motion/variants.ts, docs/verification.md, Sky wrap variants:
 * wheel and stream): selected by `?wrap=` and by the A/B button, drawing the rest sky at `?noanim`,
 * stream drawing it at calm 0 and wheel holding its turned pose there; the wheel's cores advancing
 * about their centres with no reset over a full turn, across a turn boundary and across the
 * 3600 s wrap of uTime; the stream's footprint fixed while its paint moves; the river arms,
 * wheelrun and wheelflow, turning the three kept discs as wheel does, moving the big swirl with
 * the river, and moving the paint the way Paul drew it at patches on his paths; the bare share of the sky under `?coverage` beside wave and base, with the wheel's rim
 * seam measured apart; and, with SWIRL_STRIPS=1, the six-frame strips of the central swirl in
 * docs/shots.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { CAPTURE_SIZE } from '../../scripts/fidelity-io.ts';
import { DEFAULT_BAND_SIZE } from '../../src/render/strokes/bands.ts';
import { COVERAGE_POSES, type CoveragePose } from '../world-poses';
import { luma, shiftAt } from './block-match';
import { expect, glErrors, test, type Xr } from './fixtures';

test.use({ viewport: { width: CAPTURE_SIZE.width, height: CAPTURE_SIZE.height } });

const WORLD = 'painting=starry-night&seed=1&shot&nogov';
/**
 * The most bare share the coverage sweep allows wheel, stream, wheelflow and wheelrun at any pose
 * and time (P2-A3).
 */
const MAX_BARE = 0.005;

/**
 * The wheels' canvas centres (v down) and radii in painting widths: regions.json's vortices at
 * SKY_WHEEL_CORE_SCALE (0.95), less SKY_WHEEL_STROKE_HALF as a share of that angle (the last
 * factor), and each wheel's seconds per turn (sky-swirl.ts SKY_WHEELS, the unit tests print them).
 */
const WHEELS = [
  {
    note: 'central left',
    centre: [0.5184, 0.3354],
    radius: 0.95 * 0.1434 * 0.8596,
    period: 3600 / 32,
  },
  {
    note: 'central right',
    centre: [0.6853, 0.4778],
    radius: 0.95 * 0.0614 * 0.6534,
    period: 3600 / 94,
  },
  {
    note: 'moon eddy',
    centre: [0.9137, 0.1677],
    radius: 0.95 * 0.1024 * 0.7181,
    period: 3600 / 69,
  },
  { note: 'star eddy', centre: [0.3505, 0.5293], radius: 0.95 * 0.0819 * 0.757, period: 3600 / 55 },
] as const;

interface WrapDiag {
  wrap: string;
  drawn: number;
  small: number;
  returning: number;
  wheeled: number;
  streaming: number;
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

test('wheel and stream: selected by ?wrap and by the A/B button, the rest sky at noanim, and wheel holding its pose at calm 0', async ({
  page,
  xr,
}) => {
  test.setTimeout(480_000);
  const { width, height } = CAPTURE_SIZE;
  console.log(`[e2e] sky wheel/stream selection: load ${load()} at start`);
  await bootWorld(xr, 'painter&noanim');
  const rest = await rawPixels(page);
  for (const extra of [
    'wrap=wheel&noanim',
    'wrap=wheel&noanim&motiont=3.7',
    'wrap=stream&noanim',
    'wrap=stream&calm=0&motiont=3.7',
    'wrap=wheelflow&noanim',
    'wrap=wheelrun&noanim',
  ]) {
    await bootWorld(xr, `painter&${extra}`);
    await hideHud(page, xr);
    expect((await rawPixels(page)).equals(rest), `${extra} draws the rest sky`).toBe(true);
  }
  // Calm 0 under wheel holds the discs where uTime stopped (clock.ts setHoldMask): at motiont 3.7
  // it draws the 3.7 s pose, not the rest sky. With only the sky moving, calm 1 draws the same
  // frame byte for byte: the wheel's offset never scales with calm, and the haze turns with its
  // wheel and is thinned at its turned centre, with no calm-scaled reach (motion.glsl motionReach
  // and skyWheelOffset).
  await bootWorld(xr, 'painter&nohalo&wrap=wheel&calm=0&motiont=3.7');
  await hideHud(page, xr);
  const held = await rawPixels(page);
  expect(held.equals(rest), 'calm 0 under wheel holds the turned pose').toBe(false);
  expect(((await xr.diag()).motion as { hold: number }).hold).toBeGreaterThan(0);
  await bootWorld(xr, 'painter&nohalo&wrap=wheel&motiont=3.7&motionlayers=sky');
  await hideHud(page, xr);
  const turned = await rawPixels(page);
  let differ = 0;
  for (let i = 0; i < held.length; i += 4) {
    if (held[i] !== turned[i] || held[i + 1] !== turned[i + 1] || held[i + 2] !== turned[i + 2]) {
      differ++;
    }
  }
  console.log(
    `[e2e] sky wheel calm 0 hold: ${differ} of ${width * height} pixels differ from calm 1 sky-only`,
  );
  expect(differ, 'calm 0 holds exactly the calm 1 pose at the pinned time').toBe(0);
  // Wheelflow and wheelrun hold their three kept discs at calm 0 too, the same setHoldMask, and
  // every other sky stroke, the big swirl's included, is at rest there (calm scales its travel,
  // and wheelrun's shrink fades out with calm). So both draw one frame, which is neither the rest
  // sky nor wheel's, whose big disc is held turned.
  const riverHeld: Buffer[] = [];
  for (const wrap of ['wheelrun', 'wheelflow']) {
    await bootWorld(xr, `painter&nohalo&wrap=${wrap}&calm=0&motiont=3.7`);
    await hideHud(page, xr);
    const frame = await rawPixels(page);
    expect(frame.equals(rest), `calm 0 under ${wrap} holds its kept discs' pose`).toBe(false);
    expect(frame.equals(held), `calm 0 under ${wrap} leaves the big swirl at rest`).toBe(false);
    expect(((await xr.diag()).motion as { hold: number }).hold).toBeGreaterThan(0);
    riverHeld.push(frame);
  }
  expect(riverHeld[0].equals(riverHeld[1]), 'both river arms hold the same frame').toBe(true);

  await bootWorld(xr, 'painter&motiont=3.7&wrap=wave');
  const wave = await rawPixels(page);
  const shots: Record<string, Buffer> = {};
  const reports: string[] = [];
  for (const wrap of ['wheel', 'stream', 'wheelflow', 'wheelrun'] as const) {
    await bootWorld(xr, `painter&motiont=3.7&wrap=${wrap}`);
    await hideHud(page, xr);
    const diag = await xr.diag();
    expect((diag.variants as { wrap: string }).wrap).toBe(wrap);
    const w = diag.wrap as WrapDiag;
    expect(w.wrap).toBe(wrap);
    expect(w.drawn).toBeGreaterThan(1000);
    expect(w.wheeled).toBeGreaterThan(0);
    // Only stream streams paint.
    expect(w.streaming).toBe(wrap === 'stream' ? w.drawn : 0);
    // Wheel and stream have no arc loop: nothing shrinks and nothing turns back. Outside the
    // kept wheels wheelflow runs pingpong's curve along the river (strokes turn back, at full
    // size) and wheelrun base's one-way loop (strokes shrink at the wrap, none turns back).
    if (wrap === 'wheel' || wrap === 'stream') expect([w.small, w.returning]).toEqual([0, 0]);
    if (wrap === 'wheelflow') {
      expect(w.small).toBe(0);
      expect(w.returning).toBeGreaterThan(0);
    }
    if (wrap === 'wheelrun') {
      expect(w.small).toBeGreaterThan(0);
      expect(w.returning).toBe(0);
    }
    reports.push(`${wrap} ${JSON.stringify(w)}`);
    shots[wrap] = await rawPixels(page);
    expect(shots[wrap].equals(wave), `${wrap} moves the sky its own way`).toBe(false);
    expect(shots[wrap].equals(rest), `${wrap} is not the rest sky at motiont 3.7`).toBe(false);
  }
  console.log(`[e2e] sky wheel/stream wrap diag: ${reports.join('; ')}`);

  // By the A/B button: the boot starts at the default wheelrun, one press reaches wheelflow, three
  // wheel and four stream, from one boot.
  await bootWorld(xr, 'painter&motiont=3.7&ab=wrap');
  const ab = (await xr.diag()).ab as { variants: string[]; variant: string };
  expect(ab.variants).toEqual([
    'wheelrun',
    'wheelflow',
    'wave',
    'wheel',
    'stream',
    'base',
    'pingpong',
  ]);
  expect(ab.variant).toBe('wheelrun');
  const programs = (await xr.diag()).renderer.programs;
  for (const [index, variant] of ab.variants.entries()) {
    if (index > 0) await pressV(page, xr);
    if (!(variant in shots)) continue;
    const now = await xr.diag();
    expect(now.ab, variant).toMatchObject({ index, variant });
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
  console.log(`[e2e] sky wheel/stream selection: load ${load()} at end`);
});

test('wheel: each core advances about its centre at every sample of a full turn, with no reset, as the TS mirror predicts', async ({
  page,
  xr,
}) => {
  test.setTimeout(600_000);
  const { width, height } = CAPTURE_SIZE;
  const samples = 12;
  const rows: string[] = [];
  // The two central wheels on four sides: a rigid turn moves the paint at a fixed pixel the same
  // way at every time, so the shift over `step` at each sample of the turn is the rest point's
  // shift at `step`. The left is block-matched at half its radius with a 21 px block over 0.5 s,
  // the right (2.86°, about 49 px) at 0.3 of its radius with a 13 px block over 1.5 s. The
  // boundary haze shell (45-55 m out, up to 45 m high) lies in front of the right wheel and much
  // of the left. Its strokes in front of a wheel turn with it about the same axis through the eye
  // (fix round 3), so their paint moves on screen as the dome's behind them does.
  const probes = [
    { share: 0.5, half: 10, step: 0.5 },
    { share: 0.3, half: 6, step: 1.5 },
  ];
  for (const [w, wheel] of WHEELS.slice(0, 2).entries()) {
    const { share, half, step } = probes[w];
    const before = load();
    const perProbe: number[][] = [[], [], [], []];
    await bootWorld(xr, `painter&nohalo&wrap=wheel&motiont=0&motionlayers=sky`);
    await hideHud(page, xr);
    // Every band at density 1, as in motion.spec's painterShot: the dome draws the suffix of its
    // order (`drawsSuffix`), so a density below 1 would hand the block match a different far-band
    // sample. The coverage sweeps keep the shipped densities, so this stays out of bootWorld.
    await page.evaluate((size) => {
      if (!window.__goghBands) throw new Error('__goghBands is e2e-only');
      window.__goghBands({ density: { near: 1, mid: 1, far: 1 }, size });
    }, DEFAULT_BAND_SIZE);
    await xr.waitFrames(5);
    const points = [0, 1, 2, 3].map((k) => {
      const a = (k * Math.PI) / 2 + 0.3;
      const r = share * wheel.radius;
      return [
        wheel.centre[0] + r * Math.cos(a),
        wheel.centre[1] + r * Math.sin(a) * (width / height),
      ];
    });
    const predicted = await page.evaluate(
      ([pts, t]) =>
        pts.map(([u, v]) => {
          if (!window.__goghSkyShift) throw new Error('__goghSkyShift is e2e-only');
          return window.__goghSkyShift(u, v, 1, t, 0, 'wheel');
        }),
      [points, step] as const,
    );
    // Twelve samples of a full turn, then one window across the turn boundary and one across
    // the 3600 s wrap of uTime, where __goghMotionT wraps 3600.25 to 0.25.
    const times = [
      ...Array.from({ length: samples }, (_, k) => (k * wheel.period) / samples),
      wheel.period - 0.25,
      3599.75,
    ];
    for (const t of times) {
      await motionT(page, xr, t);
      const a = luma(await rawPixels(page));
      await motionT(page, xr, t + step);
      const b = luma(await rawPixels(page));
      const ratios: number[] = [];
      points.forEach(([u, v], i) => {
        const shift = predicted[i];
        if (!shift) throw new Error(`no prediction at (${u}, ${v})`);
        const px = shift[0] * width;
        const py = shift[1] * height;
        const m = shiftAt(a, b, Math.round(u * width), Math.round(v * height), half, 8);
        const along = (m.dx * px + m.dy * py) / Math.hypot(px, py);
        const row = `${wheel.note} t ${t.toFixed(2)} (${u.toFixed(3)}, ${v.toFixed(3)}): predicted (${px.toFixed(2)}, ${py.toFixed(2)}) px, measured (${m.dx.toFixed(2)}, ${m.dy.toFixed(2)}) along ${along.toFixed(2)} sharp ${m.sharpness.toFixed(1)}`;
        rows.push(row);
        console.log(`[e2e] sky wheel turn row: ${row}`);
        const ratio = along / Math.hypot(px, py);
        // The left wheel at every reading: a reset turns a probe back, to 0 or below. With every
        // band at density 1 the 21 px block reads 0.497 to 1.325 over a turn (2026-11-10, 56
        // readings), so the floor sits well clear of a reset and of that noise.
        if (w === 0) {
          expect.soft(ratio, `${wheel.note} t ${t} probe ${i}`).toBeGreaterThan(0.3);
          expect.soft(ratio, `${wheel.note} t ${t} probe ${i}`).toBeLessThan(1.5);
        }
        ratios.push(ratio);
        perProbe[i].push(ratio);
      });
      // At about the predicted pace, as the median of the four probes. The right wheel's single
      // probes stay on the median: its 13 px blocks over a 3.5 px shift are noisy, and in fix round
      // 3 its 9 of 56 out-of-band readings (0.17 to 0.45 and 1.81 to 2.09) fell at all four probes
      // at different times, low and high alike, where a still veil over a fixed pixel would read
      // low at every time.
      const median =
        [...ratios]
          .sort((p, q) => p - q)
          .slice(1, 3)
          .reduce((p, q) => p + q) / 2;
      expect.soft(median, `${wheel.note} t ${t} median pace`).toBeGreaterThan(0.5);
      expect.soft(median, `${wheel.note} t ${t} median pace`).toBeLessThan(1.5);
    }
    // Each probe's median over the turn: a still veil over a fixed pixel reads low at every time.
    // Measured 2026-11-10 at density 1: left 0.993 to 1.091, right 0.804 to 1.002.
    const [lo, hi] = w === 0 ? [0.8, 1.25] : [0.6, 1.4];
    perProbe.forEach((rs, i) => {
      const s = [...rs].sort((p, q) => p - q);
      const mid = s.length / 2;
      const m = s.length % 2 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
      expect.soft(m, `${wheel.note} probe ${i} median over the turn`).toBeGreaterThan(lo);
      expect.soft(m, `${wheel.note} probe ${i} median over the turn`).toBeLessThan(hi);
    });
    console.log(`[e2e] sky wheel turn ${wheel.note}: load ${before} before, ${load()} after`);
  }
  console.log(`[e2e] sky wheel turn:\n${rows.join('\n')}`);
  expect(await glErrors(page)).toEqual([]);
});

/** Mostly magenta pixels, as tests/e2e/world-coverage.spec.ts counts them, as a 0/1 mask. */
async function bareMask(page: Page): Promise<{ width: number; height: number; mask: Uint8Array }> {
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
  const mask = new Uint8Array(width * height);
  for (const i of bare) mask[i] = 1;
  return { width, height, mask };
}

test('stream: every stroke keeps its footprint while its paint streams', async ({ page, xr }) => {
  test.setTimeout(300_000);
  await bootWorld(xr, 'coverage&painter&noanim');
  await hideHud(page, xr);
  const still = await bareMask(page);
  // Only the sky's gate opens, so the stars, moon rings and cypress hold still, and the haze thin
  // keeps one gate state over every sample: the first sample is the reference footprint.
  await bootWorld(xr, 'coverage&painter&wrap=stream&motiont=0.3&motionlayers=sky');
  await hideHud(page, xr);
  let reference: Uint8Array | null = null;
  let previous: Buffer | null = null;
  const changes: string[] = [];
  for (const time of [0.3, 0.8, 1.35, 1.9, 2.6, 3599.7]) {
    await motionT(page, xr, time);
    const now = await bareMask(page);
    if (!reference) {
      reference = now.mask;
      let fromStill = 0;
      for (let i = 0; i < now.mask.length; i++) fromStill += now.mask[i] !== still.mask[i] ? 1 : 0;
      // Information only: the open sky gate widens the haze thin by the motion reach.
      console.log(`[e2e] sky stream footprint: ${fromStill} pixels differ from noanim`);
    }
    let differ = 0;
    for (let i = 0; i < now.mask.length; i++) differ += now.mask[i] !== reference[i] ? 1 : 0;
    // The footprint is the first sample's, pixel for pixel.
    expect(differ, `stream footprint at motiont ${time}`).toBe(0);
    const pixels = await rawPixels(page);
    if (previous) {
      let moved = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] !== previous[i] || pixels[i + 1] !== previous[i + 1]) moved++;
      }
      changes.push(
        `${time}: ${((moved / (pixels.length / 4)) * 100).toFixed(2)}% of pixels changed`,
      );
      // The paint does move.
      expect(moved).toBeGreaterThan(0.01 * (pixels.length / 4));
    }
    previous = pixels;
  }
  console.log(`[e2e] sky stream footprint fixed; colour changes ${changes.join(', ')}`);
  expect(await glErrors(page)).toEqual([]);
});

test('the river arms: the kept discs turn as under wheel, the big swirl travels with the river, and wheelrun moves the paint along the way Paul drew it at patches on his paths', async ({
  page,
  xr,
}) => {
  test.setTimeout(600_000);
  const { width, height } = CAPTURE_SIZE;
  const differ = (a: Buffer, b: Buffer, i: number): boolean =>
    a[4 * i] !== b[4 * i] || a[4 * i + 1] !== b[4 * i + 1] || a[4 * i + 2] !== b[4 * i + 2];
  // A disc's core: within `share` of its radius about its canvas centre.
  const inCore = (w: (typeof WHEELS)[number], share: number, x: number, y: number): boolean =>
    Math.hypot(x - w.centre[0] * width, y - w.centre[1] * height) / width < share * w.radius;
  // The bar is on the moon and the large star. At the far band's 1.6, 57 outside dome strokes
  // reach the right central disc's inner half at rest (6 the moon's, none the star's: the seed-1
  // world suite's calibration), and they travel under the river while wheel holds them, so that
  // disc is logged with no bar.
  const [big, right, ...kept] = WHEELS;

  await bootWorld(xr, 'painter&nohalo&noanim');
  await hideHud(page, xr);
  const rest = await rawPixels(page);
  const shot = async (query: string): Promise<Buffer> => {
    await bootWorld(xr, `painter&nohalo&motionlayers=sky&${query}`);
    await hideHud(page, xr);
    return rawPixels(page);
  };
  const reports: string[] = [];
  for (const wrap of ['wheelrun', 'wheelflow']) {
    for (const time of [1.3, 3.7, 6.1]) {
      const wheel = await shot(`wrap=wheel&motiont=${time}`);
      const own = await shot(`wrap=${wrap}&motiont=${time}`);
      // The kept discs' inner half turns as under wheel. Paint travelling outside a small disc
      // can reach into it, as resting paint does, so the bar is a share, not byte identity.
      let keptInside = 0;
      let keptSame = 0;
      let rightInside = 0;
      let rightSame = 0;
      let bigInside = 0;
      let bigWheel = 0;
      let bigMoved = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          if (kept.some((w) => inCore(w, 0.5, x, y))) {
            keptInside++;
            if (!differ(own, wheel, i)) keptSame++;
          }
          if (inCore(right, 0.5, x, y)) {
            rightInside++;
            if (!differ(own, wheel, i)) rightSame++;
          }
          if (inCore(big, 0.6, x, y)) {
            bigInside++;
            if (!differ(own, wheel, i)) bigWheel++;
            if (differ(own, rest, i)) bigMoved++;
          }
        }
      }
      reports.push(
        `${wrap} t ${time}: moon and star cores ${keptSame} of ${keptInside} as wheel, right central ${rightSame} of ${rightInside}; big swirl core ${bigWheel} of ${bigInside} as wheel, ${bigMoved} off rest`,
      );
      expect(keptInside).toBeGreaterThan(500);
      expect(keptSame / keptInside, `${wrap} t ${time}: kept discs turn as wheel`).toBeGreaterThan(
        0.8,
      );
      // The big swirl is no wheel under the river: its core moves, and not as wheel turns it. In
      // its core (0.6 of its edge) 661 of 676 dome strokes have an amplitude over 0.05.
      expect(bigMoved / bigInside, `${wrap} t ${time}: the big swirl moves`).toBeGreaterThan(0.2);
      expect(bigWheel / bigInside, `${wrap} t ${time}: the big swirl is not wheel's`).toBeLessThan(
        0.8,
      );
    }
  }
  console.log(`[e2e] sky river arms: ${reports.join('; ')}`);

  // The sign: under wheelrun with every phase pinned at 0.5 (?motionphase), f = fract(t / 8 + 0.5),
  // so from t = 0 (tau 0) to t = 2 (tau +2 s times the travel, at full size) every stroke outside
  // the kept discs steps forward along its river velocity. At patches on Paul's polylines the
  // block-matched shift must point along the guide's heading there (__goghRiverHeading).
  const paths = (
    JSON.parse(readFileSync('assets/bake/starry-night/sky-river.json', 'utf8')) as {
      paths: { uv: [number, number][] }[];
    }
  ).paths;
  const patches: [number, number][] = [];
  for (const { uv } of paths) {
    for (const at of [0.35, 0.7]) {
      const k = Math.min(uv.length - 2, Math.floor(at * (uv.length - 1)));
      const [a, b] = [uv[k], uv[k + 1]];
      patches.push([(a[0] + b[0]) / 2, 1 - (a[1] + b[1]) / 2]);
    }
  }
  const start = await shot('wrap=wheelrun&motionphase=0.5&motiont=0');
  await motionT(page, xr, 2);
  await hideHud(page, xr);
  const step = await rawPixels(page);
  const lumaStart = luma(start);
  const lumaStep = luma(step);
  const rows: string[] = [];
  let measured = 0;
  let along = 0;
  for (const [u, v] of patches) {
    const cx = Math.round(u * width);
    const cy = Math.round(v * height);
    if (cx < 40 || cy < 40 || cx > width - 40 || cy > height - 40) continue;
    const probe = await page.evaluate(
      ([pu, pv, w, h]) => {
        if (!window.__goghRiverHeading) throw new Error('__goghRiverHeading is e2e-only');
        return window.__goghRiverHeading(pu, pv, w, h);
      },
      [u, v, CAPTURE_SIZE.width, CAPTURE_SIZE.height] as const,
    );
    if (!probe || probe.member) continue;
    const s = shiftAt(lumaStart, lumaStep, cx, cy, 10, 24);
    const length = Math.hypot(s.dx, s.dy);
    const cos = length > 0 ? (s.dx * probe.heading[0] + s.dy * probe.heading[1]) / length : 0;
    rows.push(
      `(${u.toFixed(3)}, ${v.toFixed(3)}) shift (${s.dx}, ${s.dy}) px, cos ${cos.toFixed(2)} to the heading`,
    );
    if (length < 2) continue;
    measured++;
    if (cos > 0) along++;
  }
  console.log(
    `[e2e] sky river sign: ${along} of ${measured} along the heading; ${rows.join('; ')}`,
  );
  expect(measured, 'patches on the paths that moved').toBeGreaterThanOrEqual(6);
  expect(along / measured, 'patches moving the way Paul drew').toBeGreaterThanOrEqual(0.8);
  expect(await glErrors(page)).toEqual([]);
});

/** regions.png ids of the sky, its stars and the moon (REGION in src/demo/canvas/field.ts). */
const SKY_REGION_IDS = [0, 1, 2];

/** The painter view's sky pixels: regions.png (canvas uv [0, 1]², top row first) at frame size. */
async function painterSkyMask(width: number, height: number): Promise<Uint8Array> {
  const ids = await sharp('public/paintings/starry-night/regions.png')
    .extractChannel(0)
    .resize(width, height, { kernel: 'nearest', fit: 'fill' })
    .raw()
    .toBuffer();
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = SKY_REGION_IDS.includes(ids[i]) ? 1 : 0;
  return mask;
}

/**
 * The wheels' rim seams in the painter view: the sky pixels from 0.85 to 1.1 of each wheel's
 * radius, in painting widths, as pixels (the painter frame is canvas uv [0, 1]²).
 */
function seamMask(width: number, height: number, sky: Uint8Array): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!sky[i]) continue;
      for (const w of WHEELS) {
        const r = Math.hypot(x - w.centre[0] * width, y - w.centre[1] * height) / width;
        if (r > 0.85 * w.radius && r < 1.1 * w.radius) mask[i] = 1;
      }
    }
  }
  return mask;
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

test('coverage: the bare share at 8 motion times for wave, base, wheel, stream, wheelflow and wheelrun, at the painter view and two sky-heavy poses, and at the wheel seams', async ({
  page,
  xr,
}) => {
  test.setTimeout(1_200_000);
  const poses = ['spot straight up', 'spot left, raised'].map((name) => {
    const pose = COVERAGE_POSES.find((p) => p.name === name);
    if (!pose) throw new Error(`no "${name}" pose`);
    return pose;
  });
  // One loop per wrap at 8 evenly spaced times: wave, base and the river arms (wheelflow,
  // wheelrun) 8 s, stream its 2 s loop, and wheel a whole turn of the big central wheel. The river
  // arms' kept discs turn too, so their seams are counted with wheel's.
  const wheeled = (wrap: string): boolean =>
    wrap === 'wheel' || wrap === 'wheelflow' || wrap === 'wheelrun';
  const loopTimes = (wrap: string): number[] => {
    const period = wrap === 'stream' ? 2 : wrap === 'wheel' ? WHEELS[0].period : 8;
    return Array.from({ length: 8 }, (_, i) => ((i + 0.5) * period) / 8);
  };
  const rows: { wrap: string; view: string; shares: number[] }[] = [];
  let masks: { sky: Uint8Array; seam: Uint8Array } | null = null;
  const share = (mask: Uint8Array, within: Uint8Array | null): number => {
    let bare = 0;
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
      if (within && !within[i]) continue;
      count++;
      bare += mask[i];
    }
    return bare / count;
  };
  for (const wrap of ['wave', 'base', 'wheel', 'stream', 'wheelflow', 'wheelrun']) {
    const times = loopTimes(wrap);
    const before = load();
    await bootWorld(xr, `coverage&painter&motiont=${times[0]}&wrap=${wrap}`);
    expect(((await xr.diag()).world as { debug: string }).debug).toBe('coverage');
    const painter: number[] = [];
    const painterSky: number[] = [];
    const seam: number[] = [];
    for (const time of times) {
      await motionT(page, xr, time);
      const m = await bareMask(page);
      if (!masks) {
        const sky = await painterSkyMask(m.width, m.height);
        masks = { sky, seam: seamMask(m.width, m.height, sky) };
      }
      painter.push(share(m.mask, null));
      painterSky.push(share(m.mask, masks.sky));
      seam.push(share(m.mask, masks.seam));
    }
    rows.push({ wrap, view: 'painter', shares: painter });
    rows.push({ wrap, view: 'painter, of the sky', shares: painterSky });
    rows.push({ wrap, view: 'painter, at the wheel seams', shares: seam });
    for (const pose of poses) {
      await visit(page, xr, pose);
      const shares: number[] = [];
      for (const time of times) {
        await motionT(page, xr, time);
        shares.push(share((await bareMask(page)).mask, null));
      }
      rows.push({ wrap, view: pose.name, shares });
    }
    console.log(`[e2e] sky wheel/stream coverage ${wrap}: load ${before} before, ${load()} after`);
  }
  for (const row of rows) {
    const pct = row.shares.map((s) => (s * 100).toFixed(3)).join(' ');
    const worst = Math.max(...row.shares);
    const mean = row.shares.reduce((a, b) => a + b, 0) / row.shares.length;
    console.log(
      `[e2e] sky wheel/stream coverage ${row.wrap} | ${row.view} | ${pct} | mean ${(mean * 100).toFixed(3)}% worst ${(worst * 100).toFixed(3)}%`,
    );
  }
  // The whole-frame rows carry the P2-A3 limit; the sky-only and seam rows are reported.
  for (const row of rows) {
    if (!wheeled(row.wrap) && row.wrap !== 'stream') continue;
    if (row.view.startsWith('painter,')) continue;
    const times = loopTimes(row.wrap);
    row.shares.forEach((s, i) => {
      expect(s, `${row.wrap} ${row.view} at motiont ${times[i]}`).toBeLessThanOrEqual(MAX_BARE);
    });
  }
  expect(await glErrors(page)).toEqual([]);
});

test('strips: six frames of the central swirl for wheel and stream, as JPEG (SWIRL_STRIPS=1)', async ({
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
  // The wheel 2 s apart, a sixtieth of its turn per frame, and the stream a third of a second
  // apart, six frames inside its 2 s loop.
  for (const [name, gap] of [
    ['wheel', 2],
    ['stream', 1 / 3],
  ] as const) {
    const before = load();
    await bootWorld(xr, `painter&nohalo&motiont=${start}&wrap=${name}`);
    await hideHud(page, xr);
    const frames: Buffer[] = [];
    for (let k = 0; k < 6; k++) {
      await motionT(page, xr, start + gap * k);
      frames.push(
        await sharp(await shotPng(page))
          .extract(crop)
          .png()
          .toBuffer(),
      );
    }
    const margin = 8;
    const strip = await sharp({
      create: {
        width: 6 * crop.width + 5 * margin,
        height: crop.height,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite(frames.map((input, k) => ({ input, left: k * (crop.width + margin), top: 0 })))
      .jpeg({ quality: 85 })
      .toBuffer();
    writeFileSync(`docs/shots/swirl-${name}-strip.jpg`, strip);
    console.log(
      `[e2e] sky ${name} strip: motiont ${start} to ${start + 5 * gap}, load ${before} before, ${load()} after`,
    );
  }
  expect(await glErrors(page)).toEqual([]);
});
