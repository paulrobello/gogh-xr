/**
 * Byte-identity check between two running builds: renders the same `?diag&shot` boots in each, in
 * headless Chromium on the GPU (the e2e suite's launch flags), and compares the raw RGBA frames.
 * ab.spec.ts compares variants within one build; this compares a change's default path against
 * the commit before it.
 *
 *   bun scripts/compare-builds.ts <base-origin> <branch-origin> [--size WxH]
 *
 * The size defaults to CAPTURE_SIZE, the canvas aspect the painter camera keeps.
 *
 * Each origin serves a `--mode e2e` build (`vite preview --mode e2e`), so `?motiont` is honoured.
 * Exits 1 when any boot differs or a page logs an error.
 */
import { chromium, type Page } from '@playwright/test';
import sharp from 'sharp';
import { gpuArgs } from '../tests/e2e/gpu';
import { CAPTURE_SIZE } from './fidelity-io.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const [width, height] = (option('size') ?? `${CAPTURE_SIZE.width}x${CAPTURE_SIZE.height}`)
  .split('x')
  .map(Number);
const [baseOrigin, branchOrigin] = args;
if (!baseOrigin || !branchOrigin) {
  console.error('usage: bun scripts/compare-builds.ts <base-origin> <branch-origin> [--size WxH]');
  process.exit(2);
}

/** Each boot and the `__goghDiag()` key to wait for. */
const BOOTS: readonly { query: string; wait: string }[] = [
  { query: 'painting=starry-night&noanim&seed=1&painter', wait: 'world' },
  { query: 'painting=starry-night&seed=1&painter&nogov&motiont=3.7', wait: 'world' },
  { query: 'painting=starry-night&noanim&seed=1', wait: 'world' },
  { query: '', wait: 'world' },
  { query: 'strokesTest&noanim', wait: 'strokes' },
  { query: 'demo=canvas&noanim&seed=1', wait: 'canvas' },
];

async function capture(page: Page, origin: string, query: string, wait: string): Promise<Buffer> {
  const sep = query ? '&' : '';
  await page.goto(`${origin}/?diag&shot${sep}${query}`);
  await page.waitForFunction(
    (key) => {
      const diag = window.__goghDiag?.();
      if (!window.__goghShot || !diag || diag[key] === undefined) return false;
      // The gallery's plaques typeset over frames after `world` registers.
      const plaques = (diag[key] as { plaques?: { state: string } }).plaques;
      return plaques?.state !== 'pending';
    },
    wait,
    { timeout: 120_000 },
  );
  const frame = () =>
    page.evaluate(() => {
      const diag = window.__goghDiag;
      if (!diag) throw new Error('no __goghDiag');
      return (diag().renderer as { frame: number }).frame;
    });
  const start = await frame();
  await page.waitForFunction(
    (from) => {
      const diag = window.__goghDiag;
      return diag ? (diag().renderer as { frame: number }).frame >= from + 8 : false;
    },
    start,
    { timeout: 60_000 },
  );
  const dataUrl = await page.evaluate(() => {
    if (!window.__goghShot) throw new Error('no __goghShot');
    return window.__goghShot();
  });
  return sharp(Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'))
    .raw()
    .toBuffer();
}

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
let failed = false;
try {
  for (const { query, wait } of BOOTS) {
    const frames: Buffer[] = [];
    for (const origin of [baseOrigin, branchOrigin]) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      const errors: string[] = [];
      page.on('console', (m) => {
        if (new URL(m.location().url || 'about:blank').pathname === '/favicon.ico') return;
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(e.message));
      frames.push(await capture(page, origin, query, wait));
      if (errors.length > 0) {
        console.error(`compare-builds: ${origin} ?${query} page errors:\n${errors.join('\n')}`);
        failed = true;
      }
      await page.close();
    }
    const [a, b] = frames;
    let differing = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) differing++;
    const same = a.length === b.length && differing === 0;
    console.log(
      `compare-builds: ?${query || '(no flag)'} ${same ? 'identical' : `DIFFERS in ${differing} bytes`} (${a.length} bytes)`,
    );
    if (!same) failed = true;
  }
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
