/**
 * View-angle strip probe: sweeps the eye across the painter's spot along x and along z, a few cm
 * at a time, at several headings, and prints for every step the share of pixels that change
 * (`scripts/zfight-lib.ts`) and whether the batch's chunk draw order (`__goghDiag().chunkOrder`)
 * changed, with the chunk pairs that swapped. A control sweep runs the same steps at a spot away
 * from the cell seams. Headless Chromium on the GPU at 1280 × 1014, with the e2e suite's launch
 * flags. Results: docs/verification.md, view-angle strip.
 *
 *   bun scripts/strip-probe.ts <base-url> [--diff=out.png] [--only=painter:north:x] [--query=zdiag=nosort]
 *
 * `--diff` writes the diff image of the painter's spot, heading north, across x = 0 (-5 mm to
 * +5 mm): the first frame dimmed, every changed pixel red. `--only` limits the sweep to one centre,
 * heading and axis. `--query` appends to the page query.
 */
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { gpuArgs } from '../tests/e2e/gpu.ts';
import { FLIP_THRESHOLD, flipPercent } from './zfight-lib.ts';

const base = process.argv[2];
if (!base) {
  console.error(
    'usage: bun scripts/strip-probe.ts <base-url> [--diff=out.png] [--only=c:h:a] [--query=q]',
  );
  process.exit(2);
}
const option = (name: string): string | undefined =>
  process.argv
    .slice(3)
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const diffOut = option('diff');
const only = option('only');
const query = option('query');
const url = new URL(base);
url.search = `?painting=starry-night&diag&shot&nogov&nocache&noanim${query ? `&${query}` : ''}`;

/** Name, yaw and pitch, as `__goghPose` takes them. */
const HEADINGS: readonly (readonly [string, number, number])[] = [
  ['north', 0, -0.15],
  ['north-up', 0, 0.35],
  ['east', -Math.PI / 2, -0.15],
  ['south', Math.PI, -0.1],
  ['west', Math.PI / 2, -0.15],
  ['village', 0.6, -0.1],
];
const OFFSETS = [-0.2, -0.1, -0.05, -0.02, -0.01, -0.005, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2];
/** Eye positions swept: the painter's spot, and a control spot away from the cell seams. */
const CENTRES: readonly (readonly [string, number, number, number])[] = [
  ['painter', 0, 1.6, 0],
  ['control', 6, 1.6, 7],
];

interface Frame {
  data: Buffer;
  width: number;
  height: number;
  order: string[];
}

/** The chunk pairs whose relative order differs between `a` and `b`, over chunks in both. */
function swaps(a: readonly string[], b: readonly string[]): string[][] {
  const rank = new Map(b.map((name, i) => [name, i]));
  const common = a.filter((name) => rank.has(name));
  const out: string[][] = [];
  for (let i = 0; i < common.length; i++) {
    for (let j = i + 1; j < common.length; j++) {
      if ((rank.get(common[i]) ?? 0) > (rank.get(common[j]) ?? 0)) out.push([common[i], common[j]]);
    }
  }
  return out;
}

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1014 },
    deviceScaleFactor: 1,
  });
  await page.goto(url.href);
  await page.waitForFunction(
    () => Boolean(window.__goghShot && window.__goghDiag?.().world),
    null,
    {
      timeout: 120_000,
    },
  );
  const frame = (): Promise<number> =>
    page.evaluate(() => {
      const diag = window.__goghDiag;
      if (!diag) throw new Error('__goghDiag is not installed');
      return (diag().renderer as { frame: number }).frame;
    });
  const shot = async (pose: readonly number[]): Promise<Frame> => {
    await page.evaluate((p) => window.__goghPose?.(p[0], p[1], p[2], p[3], p[4]), [...pose]);
    const start = await frame();
    while ((await frame()) < start + 4) await page.waitForTimeout(30);
    const { dataUrl, order } = await page.evaluate(() => ({
      dataUrl: window.__goghShot?.() ?? '',
      order: (window.__goghDiag?.().chunkOrder as string[] | null) ?? [],
    }));
    const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    const { data, info } = await sharp(png)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, order };
  };

  let crossing: { a: Frame; b: Frame; all: number; label: string } | null = null;
  for (const [centre, cx, cy, cz] of CENTRES) {
    for (const [heading, yaw, pitch] of HEADINGS) {
      for (const axis of ['x', 'z'] as const) {
        if (only && only !== `${centre}:${heading}:${axis}`) continue;
        const frames: Frame[] = [];
        for (const offset of OFFSETS) {
          const x = axis === 'x' ? cx + offset : cx;
          const z = axis === 'z' ? cz + offset : cz;
          frames.push(await shot([x, cy, z, yaw, pitch]));
        }
        const steps = [];
        for (let i = 1; i < frames.length; i++) {
          const a = frames[i - 1];
          const b = frames[i];
          const all = flipPercent(a.data, b.data, a.width, a.height).all;
          const swapped = swaps(a.order, b.order);
          steps.push({
            from: OFFSETS[i - 1],
            to: OFFSETS[i],
            changed: Number(all.toFixed(3)),
            swaps: swapped.length,
            pairs: swapped.slice(0, 6).map((pair) => pair.join(' / ')),
          });
          const label = `${centre} ${heading} ${axis} ${OFFSETS[i - 1]} -> ${OFFSETS[i]}`;
          if (
            centre === 'painter' &&
            heading === 'north' &&
            axis === 'x' &&
            OFFSETS[i - 1] < 0 &&
            OFFSETS[i] > 0
          ) {
            crossing = { a, b, all, label };
          }
        }
        console.log(JSON.stringify({ centre, heading, axis, steps }));
      }
    }
  }

  if (diffOut && crossing) {
    const { a, b } = crossing;
    const out = Buffer.alloc(a.width * a.height * 3);
    for (let p = 0; p < a.width * a.height; p++) {
      const k = p * 3;
      const sum =
        Math.abs(a.data[k] - b.data[k]) +
        Math.abs(a.data[k + 1] - b.data[k + 1]) +
        Math.abs(a.data[k + 2] - b.data[k + 2]);
      if (sum > FLIP_THRESHOLD) {
        out[k] = 255;
      } else {
        out[k] = a.data[k] >> 2;
        out[k + 1] = a.data[k + 1] >> 2;
        out[k + 2] = a.data[k + 2] >> 2;
      }
    }
    await sharp(out, { raw: { width: a.width, height: a.height, channels: 3 } })
      .png()
      .toFile(diffOut);
    console.log(`diff ${crossing.label}: ${crossing.all.toFixed(3)}% -> ${diffOut}`);
  }
} finally {
  await browser.close();
}
