import { expect, glErrors, test, type Xr } from './fixtures';

interface CanvasDiag {
  seed: number;
  count: number;
  decodeMs: number;
  placeMs: number;
  batchMs: number;
  buildMs: number;
  strokes: {
    chunks: number;
    visibleChunks: number;
    total: number;
    visible: number;
    bands: Record<'near' | 'mid' | 'far', { chunks: number; visible: number }>;
  };
}

async function canvas(xr: Xr): Promise<CanvasDiag> {
  // The demo registers its diag key once the images are decoded and the strokes placed.
  await expect
    .poll(async () => (await xr.diag()).canvas !== undefined, { timeout: 30_000 })
    .toBe(true);
  return (await xr.diag()).canvas as CanvasDiag;
}

/**
 * The canvas is built, within 5% of `target` strokes (200k by default), all drawn from the near
 * band. Placement sizes its grid from the region area shares, so the count lands near the target,
 * not on it.
 */
function expectWholeCanvasNear(stats: CanvasDiag, target = 200_000): void {
  expect(stats.count).toBeGreaterThan(target * 0.95);
  expect(stats.count).toBeLessThan(target * 1.05);
  expect(stats.strokes.total).toBe(stats.count);
  expect(stats.strokes.visible).toBeGreaterThan(0);
  expect(stats.strokes.bands.near.visible).toBe(stats.strokes.visible);
  expect(stats.buildMs).toBeGreaterThan(0);
}

test('the canvas demo renders in XR without WebGL errors', async ({ page, xr }) => {
  // The headless page vsyncs at 60 Hz, over the 90 Hz budget: keep the governor from thinning it.
  await xr.boot('demo=canvas&seed=1&noanim&nogov');
  await xr.enterXR();
  await xr.waitFrames(5);
  const stats = await canvas(xr);
  await xr.waitFrames(3);
  const drawn = (await canvas(xr)).strokes;
  expect(stats.seed).toBe(1);
  expectWholeCanvasNear({ ...stats, strokes: drawn });
  // The IWER head starts at the origin looking down -z, straight at the whole canvas.
  expect(drawn.visible).toBe(drawn.total);
  test.info().annotations.push({ type: 'buildMs', description: stats.buildMs.toFixed(1) });
  console.log(`[e2e] canvas ${JSON.stringify(stats)}`);
  expect(await glErrors(page)).toEqual([]);

  // Turned round, the canvas is behind the viewer and every chunk culls.
  await xr.setPose({ head: { position: [0, 1.6, 0], quaternion: [0, 1, 0, 0] } });
  await xr.waitFrames(3);
  expect((await canvas(xr)).strokes.visible).toBe(0);
  expect(await glErrors(page)).toEqual([]);
});

test('the canvas demo renders on the desktop page in front of the viewer', async ({ page, xr }) => {
  await xr.boot('demo=canvas');
  const stats = await canvas(xr);
  await xr.waitFrames(5);
  const diag = await xr.diag();
  const drawn = (diag.canvas as CanvasDiag).strokes;
  // No ?seed means seed 1.
  expect(stats.seed).toBe(1);
  expectWholeCanvasNear({ ...stats, strokes: drawn });
  expect(diag.xr.presenting).toBe(false);
  // The desktop viewer starts at the XR origin, 2.55 m from the canvas.
  expect(diag.camera.position).toEqual([0, 1.6, 0]);
  expect(await glErrors(page)).toEqual([]);
});

/** The P1.8 frame-time URLs: the P0 default budget, and the max-beauty budget with `?beauty`. */
for (const { count, extra, budget } of [
  { count: 325_000, extra: '', budget: 'the P0 default budget' },
  { count: 500_000, extra: '&beauty', budget: 'the max-beauty budget' },
]) {
  test(`&count=${count}${extra} builds the canvas at ${budget} in XR without WebGL errors`, async ({
    page,
    xr,
  }) => {
    // No governor, so the full count stays drawn under the headless 60 Hz vsync.
    await xr.boot(`demo=canvas&count=${count}${extra}&noanim&nogov`);
    await xr.enterXR();
    await xr.waitFrames(5);
    const stats = await canvas(xr);
    await xr.waitFrames(3);
    const drawn = (await canvas(xr)).strokes;
    expectWholeCanvasNear({ ...stats, strokes: drawn }, count);
    expect(drawn.visible).toBe(drawn.total);
    test.info().annotations.push({ type: 'count', description: String(stats.count) });
    console.log(`[e2e] canvas count=${count}${extra} ${JSON.stringify(stats)}`);
    expect(await glErrors(page)).toEqual([]);
  });
}
