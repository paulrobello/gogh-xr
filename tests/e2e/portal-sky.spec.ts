/**
 * The portal's painted night sky (P5.5): on the desktop, no frame of an entry or a return is a
 * black full view, and the wait is painted, in the fly style and the fade style (calm 0.2). The
 * page samples its own canvas (`?shot` keeps the drawing buffer) every few frames through each
 * transition. A wait frame must show the sky drawing, blue paint brighter than the veil over a
 * share of the view and brushwork's spread of luminance, which the veil's flat colour alone, or
 * black with the paint chips over it, cannot. Negative controls (`__goghSkyControl`) show both
 * fail. A round trip still leaves the GPU's geometry and texture counts at the baseline. Not a
 * timing spec: the readbacks stall frames, so it holds no frame bar.
 */
import type { Page } from '@playwright/test';
import { expect, glErrors, test, type Xr } from './fixtures';
import { type PortalDiag, portal, settled } from './helpers';

interface Sample {
  phase: string | null;
  state: string;
  style: string | null;
  /** Mean display luminance over the view, 0-1, from the sRGB bytes. */
  mean: number;
  /** The brightest downsampled pixel's luminance, 0-1. */
  max: number;
  /** Blue's share of r + g + b over the view. */
  blue: number;
  /** The standard deviation of luminance over the downsampled pixels. */
  spread: number;
  /** The share of pixels of blue paint brighter than the veil: b ≥ 70, b > 1.3 r and b ≥ g. */
  paint: number;
  /** The portal diag's `sky`: the painted sky drew this frame. */
  sky: boolean;
}

declare global {
  interface Window {
    __skySamples?: Sample[];
    __skyStop?: () => void;
  }
}

/** Starts sampling the WebGL canvas, 32 × 18, every third animation frame. */
async function startSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    const source = document.querySelector('canvas');
    if (!source) throw new Error('no canvas');
    const small = document.createElement('canvas');
    small.width = 32;
    small.height = 18;
    const context = small.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('no 2d context');
    const samples: Sample[] = [];
    window.__skySamples = samples;
    let running = true;
    let tick = 0;
    window.__skyStop = () => {
      running = false;
    };
    const step = () => {
      if (!running) return;
      tick += 1;
      if (tick % 3 === 0) {
        const diag = window.__goghDiag?.() as
          | {
              portal: { phase: string | null; state: string; style: string | null; sky: boolean };
            }
          | undefined;
        const p = diag?.portal ?? { phase: null, state: 'idle', style: null, sky: false };
        context.drawImage(source, 0, 0, small.width, small.height);
        const data = context.getImageData(0, 0, small.width, small.height).data;
        let sum = 0;
        let squares = 0;
        let max = 0;
        let rgb = 0;
        let blue = 0;
        let paint = 0;
        const pixels = data.length / 4;
        for (let i = 0; i < data.length; i += 4) {
          const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
          const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          sum += l;
          squares += l * l;
          max = Math.max(max, l);
          rgb += r + g + b;
          blue += b;
          if (b >= 70 && b > 1.3 * r && b >= g) paint += 1;
        }
        const mean = sum / pixels;
        samples.push({
          phase: p.phase,
          state: p.state,
          style: p.style,
          mean,
          max,
          blue: rgb > 0 ? blue / rgb : 0,
          spread: Math.sqrt(Math.max(0, squares / pixels - mean * mean)),
          paint: paint / pixels,
          sky: p.sky,
        });
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function stopSampling(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    window.__skyStop?.();
    return window.__skySamples ?? [];
  });
}

const LOOKS: readonly [number, number][] = [0, Math.PI / 2, Math.PI, -Math.PI / 2].flatMap((yaw) =>
  [0, -1, 1].map((pitch) => [yaw, pitch] as [number, number]),
);

/** Looks round the gallery so every scan and chunk has drawn, then reads the GPU counts. */
async function galleryMemory(
  page: Page,
  xr: Xr,
): Promise<{ geometries: number; textures: number }> {
  for (const [yaw, pitch] of LOOKS) {
    await page.evaluate(([h, p]) => window.__goghPose?.(0, 1.6, 1, h, p), [yaw, pitch] as const);
    await xr.waitFrames(3);
  }
  const r = (await xr.diag()).renderer as unknown as { geometries: number; textures: number };
  return { geometries: r.geometries, textures: r.textures };
}

/** The wait's floors. The veil's colour alone reads mean 0.089, blue 0.60, spread 0, paint 0. */
const WAIT_MEAN = 0.12;
const WAIT_BLUE = 0.45;
const WAIT_SPREAD = 0.04;
const WAIT_PAINT = 0.25;

/** Every sample of the running transition, judged; returns the wait's. */
function judge(samples: Sample[], label: string): Sample[] {
  const running = samples.filter((s) => s.state !== 'idle');
  expect(running.length, `${label} samples`).toBeGreaterThan(10);
  for (const [i, s] of running.entries()) {
    // Never a black full view: the old world, the painted sky or the new world always shows.
    expect(s.mean, `${label} sample ${i} (${s.phase}) mean luminance`).toBeGreaterThan(0.04);
    expect(s.max, `${label} sample ${i} (${s.phase}) brightest pixel`).toBeGreaterThan(0.12);
  }
  const wait = running.filter((s) => s.phase === 'wait');
  expect(wait.length, `${label} wait samples`).toBeGreaterThan(3);
  for (const [i, s] of wait.entries()) {
    expect(s.sky, `${label} wait ${i} sky drawn`).toBe(true);
    expect(s.mean, `${label} wait ${i} mean luminance`).toBeGreaterThan(WAIT_MEAN);
    expect(s.blue, `${label} wait ${i} blue share`).toBeGreaterThan(WAIT_BLUE);
    expect(s.spread, `${label} wait ${i} luminance spread`).toBeGreaterThan(WAIT_SPREAD);
    expect(s.paint, `${label} wait ${i} blue paint share`).toBeGreaterThan(WAIT_PAINT);
  }
  return wait;
}

/** The wait's lowest readings, for the log. */
function low(samples: Sample[]) {
  const wait = samples.filter((s) => s.state !== 'idle' && s.phase === 'wait');
  const min = (key: 'mean' | 'blue' | 'spread' | 'paint') =>
    Number(Math.min(...wait.map((s) => s[key])).toFixed(3));
  return {
    samples: wait.length,
    sky: wait.filter((s) => s.sky).length,
    mean: min('mean'),
    blue: min('blue'),
    spread: min('spread'),
    paint: min('paint'),
    paintMax: Number(Math.max(...wait.map((s) => s.paint)).toFixed(3)),
  };
}

/** One transition to `target`, sampled from its trigger until it settles. */
async function sampledTrip(page: Page, xr: Xr, target: string): Promise<Sample[]> {
  await startSampling(page);
  expect(await page.evaluate((id) => window.__goghPortal?.(id), target)).toBe(true);
  await settled(xr, target);
  return stopSampling(page);
}

/** Boots the gallery at 1280 × 720 and stands 1.2 m before Starry Night's frame. */
async function bootGallery(page: Page, xr: Xr): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 });
  await xr.boot('noanim&nogov&shot');
  await settled(xr, 'gallery');
}

async function standAtFrame(page: Page, xr: Xr): Promise<void> {
  await page.evaluate(() => window.__goghPose?.(0, 1.6, -2.6, 0, 0));
  await xr.waitFrames(3);
}

test('an entry and a return go through the painted sky, never black, and leave the counts at baseline', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootGallery(page, xr);
  // The veil's sphere and the sky draw once, so their geometries are in the baseline.
  await page.evaluate(() => window.__goghVeil?.(1));
  await xr.waitFrames(3);
  expect(((await portal(xr)) as PortalDiag & { sky: boolean }).sky).toBe(true);
  await page.evaluate(() => window.__goghVeil?.(0));
  await xr.waitFrames(3);
  expect(((await portal(xr)) as PortalDiag & { sky: boolean }).sky).toBe(false);
  const baseline = await galleryMemory(page, xr);

  await standAtFrame(page, xr);
  const enter = await sampledTrip(page, xr, 'starry-night');
  judge(enter, 'enter');
  const back = await sampledTrip(page, xr, 'gallery');
  judge(back, 'return');
  expect(((await portal(xr)) as PortalDiag & { sky: boolean }).sky).toBe(false);

  expect(await galleryMemory(page, xr)).toEqual(baseline);
  console.log('portal sky fly', JSON.stringify({ baseline, enter: low(enter), back: low(back) }));
  expect(await glErrors(page)).toEqual([]);
});

test('the fade style (calm 0.2) goes through the painted sky too', async ({ page, xr }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem(
      'gogh-xr.settings.v1',
      JSON.stringify({ version: 3, settings: { calm: 0.2 } }),
    );
  });
  await bootGallery(page, xr);
  await standAtFrame(page, xr);
  const enter = await sampledTrip(page, xr, 'starry-night');
  const styles = new Set(enter.filter((s) => s.state !== 'idle').map((s) => s.style));
  expect([...styles]).toEqual(['fade']);
  judge(enter, 'fade enter');
  const back = await sampledTrip(page, xr, 'gallery');
  judge(back, 'fade return');
  console.log('portal sky fade', JSON.stringify({ enter: low(enter), back: low(back) }));
});

test('negative controls: no sky over the blue veil, or over a black one, fails the wait floors', async ({
  page,
  xr,
}) => {
  test.setTimeout(240_000);
  await bootGallery(page, xr);
  await standAtFrame(page, xr);
  const readings: Record<string, ReturnType<typeof low>> = {};
  for (const mode of ['hidden', 'black'] as const) {
    await page.evaluate((m) => window.__goghSkyControl?.(m), mode);
    const enter = await sampledTrip(page, xr, 'starry-night');
    readings[`${mode} enter`] = low(enter);
    expect(() => judge(enter, `${mode} enter`), `${mode} enter must fail`).toThrow();
    const back = await sampledTrip(page, xr, 'gallery');
    readings[`${mode} return`] = low(back);
    expect(() => judge(back, `${mode} return`), `${mode} return must fail`).toThrow();
    // The same floors without the sky flag: the pixels alone must fail them.
    const pixelsOnly = (samples: Sample[]) => samples.map((s) => ({ ...s, sky: true }));
    expect(() => judge(pixelsOnly(enter), `${mode} enter pixels`)).toThrow();
    expect(() => judge(pixelsOnly(back), `${mode} return pixels`)).toThrow();
    // Not one wait frame passes for paint: the chips over the veil never read as the sky.
    for (const [label, samples] of [
      ['enter', enter],
      ['return', back],
    ] as const) {
      for (const s of samples.filter((x) => x.state !== 'idle' && x.phase === 'wait')) {
        expect(s.paint, `${mode} ${label} wait paint`).toBeLessThan(WAIT_PAINT);
      }
    }
  }
  await page.evaluate(() => window.__goghSkyControl?.('sky'));
  console.log('portal sky controls', JSON.stringify(readings));
});
