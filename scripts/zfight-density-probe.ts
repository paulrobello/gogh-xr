/**
 * Building z-fight probe (docs/verification.md, residuals re-measured): id flips under a 0.1 mm
 * shift, and what a near-density step from 1 to 0.9 uncovers on buildings. It runs against
 * production builds of a tree patched by `scripts/zfight-id-patch.ts`. Headless Chromium on the GPU
 * at 1280 × 1014 with the e2e launch flags, seed 1, `?nogov&nocache&noanim`. A probe, not a gate.
 *
 *   bun scripts/zfight-density-probe.ts flips <id-build-url> <out-dir> [extra query]
 *     Per pose, the share of the frame whose winning stroke changes under the shift, by class, and
 *     how much of it is clustered (4 of 8 neighbours flipped too: a depth fight flips patches).
 *     Runs with `&coverage`, so a base mesh reads magenta.
 *   bun scripts/zfight-density-probe.ts density <build-url> <out-dir> <tag> [extra query]
 *     Saves `<pose>-<tag>-d1.png` and `-d09.png` at near density 1 and 0.9. On the id build pass
 *     the query `coverage` and tag `id`; on the colour build tag `colour`.
 *   bun scripts/zfight-density-probe.ts classify <out-dir> [colour-tag] [id-tag] [all]
 *     Over the building pixels of the id capture at density 1: the share that changes at all, the
 *     share that goes light (luma > 90) to dark (< 60), and what the id capture at 0.9 shows there.
 *     `all` adds the same two shares over the whole frame.
 *
 * Extra query such as `zdiag=write` selects the old depth-writing policy. Pass it without a
 * leading `&`, and join several with `&`.
 *
 * Classes come from the id patch, which colours only the scatter's surface and outline strokes.
 * The moon and stars, the boundary haze and the halos keep their paint, and the eave underside
 * copies carry a scaled roof id, so a pixel of theirs reads `rim` or aliases into the class whose
 * R it lands near. `rim` also covers blended edges. Treat the small class counts as approximate.
 */
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { gpuArgs } from '../tests/e2e/gpu.ts';

/** Name, eye position and heading, as `__goghPose` takes (the same as `scripts/zfight-probe.ts`). */
const POSES: readonly (readonly [string, number, number, number, number, number])[] = [
  ['h6-face-3m', -2.989, -3.503, -9.82, 0.0789, 0.1541],
  ['church-face-7m', 2.374, -2.733, -28.727, 0, 0.1815],
  // church-face-7m moved with the church at SCATTER_VERSION 16 (cec2aae): the church's footprint
  // moved by (0.09, -0.49) in xz, so this is again 7 m in front of its south end, 1.6 m above
  // the ground.
  ['church-face-7m-moved', 2.464, -2.675, -29.217, 0, 0.1815],
  // The density sweep's village and ground poses: `wall` and `ground` from
  // `scripts/shimmer-probe.ts`, `paul-strobe1` from `scripts/zfight-probe.ts`, the rest from
  // tests/world-poses.ts (eye positions).
  ['wall-h11-6m', 9.04, -3.27, -30.74, -0.286, 0.25],
  ['village-street', 1, -3.25, -19, 0, 0],
  ['village-west', 1, -2.97, -26, Math.PI / 2, 0.1],
  ['village-church', 2, -2.49, -33, 0, 0.35],
  ['village-uphill', 0, -2.81, -28, Math.PI, 0.1],
  ['ground', 0, 1.6, 0, 0, -0.45],
  ['paul-strobe1', 0.067, 1.551, 0, -0.571, -0.26],
  ['hill-slope', 2, -2.54, -8, 0, -0.3],
  ['under-cypress', -6, -2.03, -5, -0.56, 0.4],
];
const CLASSES = ['ground', 'wall', 'roof', 'church', 'window', 'outline', 'cypress', 'sky'];
const BUILDING = new Set(['wall', 'roof', 'church', 'window', 'outline']);
const THRESHOLD = 24;

type Image = { data: Buffer; width: number; height: number };

/** The id class of pixel `i`: `base` for magenta, `rim` for a blended edge or unknown id. */
function classOf(d: Buffer, i: number): string {
  const r = d[i * 3] as number;
  if (r > 240 && (d[i * 3 + 1] as number) < 16 && (d[i * 3 + 2] as number) > 240) return 'base';
  const k = Math.round((r - 12) / 28);
  if (k < 0 || k >= CLASSES.length || Math.abs(r - (12 + 28 * k)) > 3) return 'rim';
  return CLASSES[k] as string;
}
const luma = (d: Buffer, i: number): number =>
  0.2126 * (d[i * 3] as number) +
  0.7152 * (d[i * 3 + 1] as number) +
  0.0722 * (d[i * 3 + 2] as number);
const differs = (a: Buffer, b: Buffer, i: number): boolean =>
  Math.abs((a[i * 3] as number) - (b[i * 3] as number)) +
    Math.abs((a[i * 3 + 1] as number) - (b[i * 3 + 1] as number)) +
    Math.abs((a[i * 3 + 2] as number) - (b[i * 3 + 2] as number)) >
  THRESHOLD;
const load = async (path: string): Promise<Image> => {
  const { data, info } = await sharp(path)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};
const pct = (n: number, of: number): number => +((100 * n) / of).toFixed(3);

async function withPage(
  base: string,
  extra: string,
  run: (
    shot: (pose: readonly number[]) => Promise<Image>,
    density: (d: number) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const url = new URL(base);
  url.search = `?painting=starry-night&diag&shot&nogov&nocache&noanim&seed=1${extra ? `&${extra}` : ''}`;
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
    const settle = async (): Promise<void> => {
      const start = await frame();
      while ((await frame()) < start + 4) await page.waitForTimeout(30);
    };
    const shot = async (pose: readonly number[]): Promise<Image> => {
      await page.evaluate((p) => window.__goghPose?.(p[0], p[1], p[2], p[3], p[4]), [...pose]);
      await settle();
      const dataUrl = await page.evaluate(() => window.__goghShot?.() ?? '');
      const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
      const { data, info } = await sharp(png)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height };
    };
    const density = (d: number): Promise<void> =>
      page.evaluate((v) => {
        const batch = (
          globalThis as unknown as { __zfightBatch?: { setDensity(band: string, d: number): void } }
        ).__zfightBatch;
        if (!batch)
          throw new Error('no __zfightBatch: patch the tree with scripts/zfight-id-patch.ts');
        batch.setDensity('near', v);
      }, d);
    await run(shot, density);
  } finally {
    await browser.close();
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'flips' && args[0] && args[1]) {
  const [base, out, extra] = args as [string, string, string | undefined];
  await withPage(base, `coverage${extra ? `&${extra}` : ''}`, async (shot) => {
    for (const [name, x, y, z, yaw, pitch] of POSES) {
      const a = await shot([x, y, z, yaw, pitch]);
      const b = await shot([x + 0.0001, y, z, yaw, pitch]);
      const { width: w, height: h } = a;
      const flipped = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) if (differs(a.data, b.data, i)) flipped[i] = 1;
      let flips = 0;
      let clustered = 0;
      const byClass = new Map<string, number>();
      for (let i = 0; i < w * h; i++) {
        if (!flipped[i]) continue;
        flips++;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const px = (i % w) + dx;
            const py = Math.floor(i / w) + dy;
            if ((dx || dy) && px >= 0 && py >= 0 && px < w && py < h && flipped[py * w + px]) n++;
          }
        }
        const ca = classOf(a.data, i);
        const cb = classOf(b.data, i);
        const key = ca === cb ? ca : [ca, cb].sort().join('|');
        byClass.set(key, (byClass.get(key) ?? 0) + 1);
        if (n >= 4) {
          clustered++;
          byClass.set(`clustered ${key}`, (byClass.get(`clustered ${key}`) ?? 0) + 1);
        }
      }
      const raw = { raw: { width: w, height: h, channels: 3 as const } };
      await sharp(a.data, raw).png().toFile(`${out}/${name}-flips-id.png`);
      const top = [...byClass].sort((p, q) => q[1] - p[1]).slice(0, 12);
      console.log(
        name,
        JSON.stringify({
          flips: pct(flips, w * h),
          clustered: pct(clustered, w * h),
          byClass: Object.fromEntries(top.map(([k, v]) => [k, pct(v, w * h)])),
        }),
      );
    }
  });
} else if (command === 'density' && args[0] && args[1] && args[2]) {
  const [base, out, tag, extra] = args as [string, string, string, string | undefined];
  await withPage(base, extra ?? '', async (shot, density) => {
    for (const [name, x, y, z, yaw, pitch] of POSES) {
      for (const [d, suffix] of [
        [1, 'd1'],
        [0.9, 'd09'],
      ] as const) {
        await density(d);
        const image = await shot([x, y, z, yaw, pitch]);
        const raw = { raw: { width: image.width, height: image.height, channels: 3 as const } };
        await sharp(image.data, raw).png().toFile(`${out}/${name}-${tag}-${suffix}.png`);
      }
      await density(1);
      console.log(`${name}: ${tag} d1 and d09 saved`);
    }
  });
} else if (command === 'classify' && args[0]) {
  const [out, colourTag = 'colour', idTag = 'id', scope] = args as [
    string,
    string?,
    string?,
    string?,
  ];
  // `all` adds the frame-wide shares, for poses with few building pixels (ground, hill).
  const all = scope === 'all';
  for (const [name] of POSES) {
    const c1 = await load(`${out}/${name}-${colourTag}-d1.png`);
    const c9 = await load(`${out}/${name}-${colourTag}-d09.png`);
    const i1 = await load(`${out}/${name}-${idTag}-d1.png`);
    const i9 = await load(`${out}/${name}-${idTag}-d09.png`);
    const n = c1.width * c1.height;
    let building = 0;
    let changed = 0;
    let lightToDark = 0;
    const shown = new Map<string, number>();
    let frameChanged = 0;
    let frameLightToDark = 0;
    for (let i = 0; i < n; i++) {
      if (all && differs(c1.data, c9.data, i)) frameChanged++;
      if (all && luma(c1.data, i) > 90 && luma(c9.data, i) < 60) frameLightToDark++;
      if (!BUILDING.has(classOf(i1.data, i))) continue;
      building++;
      if (differs(c1.data, c9.data, i)) changed++;
      if (!(luma(c1.data, i) > 90 && luma(c9.data, i) < 60)) continue;
      lightToDark++;
      const now = classOf(i9.data, i);
      shown.set(now, (shown.get(now) ?? 0) + 1);
    }
    console.log(
      name,
      JSON.stringify({
        buildingPct: pct(building, n),
        changedPctOfBuilding: pct(changed, building),
        lightToDarkPct: pct(lightToDark, n),
        lightToDarkPx: lightToDark,
        shownAt09: Object.fromEntries([...shown].sort((p, q) => q[1] - p[1])),
        ...(all
          ? { frameChangedPct: pct(frameChanged, n), frameLightToDarkPct: pct(frameLightToDark, n) }
          : {}),
      }),
    );
  }
} else {
  console.error(
    'usage: bun scripts/zfight-density-probe.ts flips <url> <out> [query] | density <url> <out> <tag> [query] | classify <out> [colour-tag] [id-tag] [all]',
  );
  process.exit(2);
}
