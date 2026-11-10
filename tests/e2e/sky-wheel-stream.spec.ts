/**
 * The wheel and stream sky wraps (src/motion/variants.ts, docs/verification.md, Sky wrap variants:
 * wheel and stream): selected by `?wrap=` and by the A/B button, drawing the rest sky at `?noanim`,
 * stream drawing it at calm 0 and wheel holding its turned pose there; the wheel's cores advancing
 * about their centres with no reset over a full turn, across a turn boundary and across the
 * 3600 s wrap of uTime; the stream's footprint fixed while its paint moves; the bare share of the sky under `?coverage`
 * beside wave and base, with the wheel's rim seam measured apart; and, with SWIRL_STRIPS=1, the
 * six-frame strips of the central swirl in docs/shots.
 */
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { CAPTURE_SIZE } from '../../scripts/fidelity-io.ts';
import { COVERAGE_POSES, type CoveragePose } from '../world-poses';
import { luma, shiftAt } from './block-match';
import { expect, glErrors, test, type Xr } from './fixtures';

test.use({ viewport: { width: CAPTURE_SIZE.width, height: CAPTURE_SIZE.height } });

const WORLD = 'painting=starry-night&seed=1&shot&nogov';
/** The most bare share the coverage sweep allows wheel and stream at any pose and time (P2-A3). */
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

  await bootWorld(xr, 'painter&motiont=3.7');
  const wave = await rawPixels(page);
  const shots: Record<string, Buffer> = {};
  const reports: string[] = [];
  for (const wrap of ['wheel', 'stream'] as const) {
    await bootWorld(xr, `painter&motiont=3.7&wrap=${wrap}`);
    await hideHud(page, xr);
    const diag = await xr.diag();
    expect((diag.variants as { wrap: string }).wrap).toBe(wrap);
    const w = diag.wrap as WrapDiag;
    expect(w.wrap).toBe(wrap);
    expect(w.drawn).toBeGreaterThan(1000);
    // No arc loop: nothing shrinks and nothing turns back.
    expect([w.small, w.returning]).toEqual([0, 0]);
    expect(w.wheeled).toBeGreaterThan(0);
    reports.push(`${wrap} ${JSON.stringify(w)}`);
    shots[wrap] = await rawPixels(page);
    expect(shots[wrap].equals(wave), `${wrap} moves the sky its own way`).toBe(false);
    expect(shots[wrap].equals(rest), `${wrap} is not the rest sky at motiont 3.7`).toBe(false);
  }
  console.log(`[e2e] sky wheel/stream wrap diag: ${reports.join('; ')}`);

  // By the A/B button: one press from wave reaches wheel and two reach stream, from one boot.
  await bootWorld(xr, 'painter&motiont=3.7&ab=wrap');
  const ab = (await xr.diag()).ab as { variants: string[]; variant: string };
  expect(ab.variants).toEqual(['wave', 'wheel', 'stream', 'base', 'pingpong']);
  expect(ab.variant).toBe('wave');
  const programs = (await xr.diag()).renderer.programs;
  for (const [index, variant] of ['wheel', 'stream'].entries()) {
    await pressV(page, xr);
    const now = await xr.diag();
    expect(now.ab, variant).toMatchObject({ index: index + 1, variant });
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
    await bootWorld(xr, `painter&nohalo&wrap=wheel&motiont=0&motionlayers=sky`);
    await hideHud(page, xr);
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
        // The left wheel at every probe: a reset would turn a probe back, and a still veil would
        // pull it toward 0 (fix round 3: all 56 at 0.88 to 1.19).
        if (w === 0) {
          expect(ratio, `${wheel.note} t ${t} probe ${i}`).toBeGreaterThan(0.5);
          expect(ratio, `${wheel.note} t ${t} probe ${i}`).toBeLessThan(1.5);
        }
        ratios.push(ratio);
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
      expect(median, `${wheel.note} t ${t} median pace`).toBeGreaterThan(0.5);
      expect(median, `${wheel.note} t ${t} median pace`).toBeLessThan(1.5);
    }
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

test('coverage: the bare share at 8 motion times for wave, base, wheel and stream, at the painter view and two sky-heavy poses, and at the wheel seams', async ({
  page,
  xr,
}) => {
  test.setTimeout(1_200_000);
  const poses = ['spot straight up', 'spot left, raised'].map((name) => {
    const pose = COVERAGE_POSES.find((p) => p.name === name);
    if (!pose) throw new Error(`no "${name}" pose`);
    return pose;
  });
  // One loop per wrap at 8 evenly spaced times: wave and base 8 s, stream its 2 s loop, and wheel
  // a whole turn of the big central wheel.
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
  for (const wrap of ['wave', 'base', 'wheel', 'stream']) {
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
    if (row.wrap !== 'wheel' && row.wrap !== 'stream') continue;
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
