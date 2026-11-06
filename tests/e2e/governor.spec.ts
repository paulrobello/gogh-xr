import { expect, glErrors, test, type Xr } from './fixtures';
import { gpuArgs } from './gpu';

// Headless Chromium vsyncs requestAnimationFrame at 60 Hz, and IWER drives XR frames from it, so
// every interval would be 16.7 ms: past the 90 Hz shed line (11.7 ms) with no `?slow` at all.
// Uncapped, the canvas frame takes about 5 ms and `?slow=14` is what pushes it over.
test.use({
  launchOptions: { args: [...gpuArgs, '--disable-frame-rate-limit', '--disable-gpu-vsync'] },
});

interface HistoryEntry {
  t: number;
  action: 'shed' | 'restore' | 'shed-back' | 'rate';
  step: string;
  from: number;
  to: number;
}

interface GovernorDiag {
  mode: string;
  targetHz: number;
  budgetMs: number;
  level: number;
  step: string;
  densityMin: boolean;
  densities: Record<'near' | 'mid' | 'far', number>;
  fbScale: number | 'unavailable';
  fbScalePath: string | null;
  foveation: number;
  meanMs: number | null;
  overrun: boolean;
  notice: string | null;
  exhausted: boolean;
  history: HistoryEntry[];
}

interface CanvasStrokes {
  total: number;
  visible: number;
  visibleChunks: number;
}

async function governor(xr: Xr): Promise<GovernorDiag> {
  // The canvas builds, then the governor attaches, after async chunk imports.
  await expect
    .poll(async () => (await xr.diag()).governor !== undefined, { timeout: 30_000 })
    .toBe(true);
  return (await xr.diag()).governor as GovernorDiag;
}

test('slow=14 sheds density to its minimum, then fb scale and foveation, then requests 72 Hz', async ({
  page,
  xr,
}) => {
  await xr.boot('demo=canvas&slow=14');
  await governor(xr);
  await xr.enterXR();
  await expect
    .poll(async () => (await governor(xr)).history.some((e) => e.action === 'rate'), {
      timeout: 30_000,
    })
    .toBe(true);
  const gov = await governor(xr);
  const sequence = gov.history.map((e) => `${e.action} ${e.step} ${e.from}->${e.to}`);
  console.log(`[e2e] governor history ${JSON.stringify(gov.history)}`);
  test.info().annotations.push({ type: 'governor', description: sequence.join(', ') });

  // The canvas is all near band, so only near density can shed, and only down to the 150k floor.
  const steps = gov.history.map((e) => e.step);
  const firstOther = steps.findIndex((s) => !s.endsWith('-density'));
  expect(firstOther).toBeGreaterThan(0);
  expect(steps.slice(0, firstOther).every((s) => s === 'near-density')).toBe(true);
  expect(steps.slice(firstOther)).toEqual(['fb-scale', 'foveation', 'frame-rate']);
  expect(gov.history.every((e) => e.action === 'shed' || e.action === 'rate')).toBe(true);
  const rate = gov.history.at(-1);
  expect(rate).toMatchObject({ action: 'rate', from: 90, to: 72 });
  const foveation = gov.history.at(-2);
  expect((rate?.t ?? 0) - (foveation?.t ?? 0)).toBeGreaterThanOrEqual(3000);

  expect(gov.densityMin).toBe(true);
  expect(gov.densities.near).toBeLessThan(1);
  const strokes = ((await xr.diag()).canvas as { strokes: CanvasStrokes }).strokes;
  expect(strokes.visible).toBeLessThan(strokes.total);
  expect(strokes.visible).toBeGreaterThanOrEqual(150_000 - strokes.visibleChunks);

  expect(gov.fbScale).toBe(0.85);
  expect(gov.fbScalePath).toBe('base-layer');
  expect(gov.foveation).toBe(0.5);
  expect(gov.targetHz).toBe(72);
  expect(gov.budgetMs).toBeCloseTo(1000 / 72, 3);
  expect(gov.notice).toMatch(/72 Hz/);
  // The busy-wait shows in the XR frame intervals.
  expect(gov.meanMs ?? 0).toBeGreaterThan(14);
  // IWER implements updateTargetFrameRate and reports the new nominal rate.
  await expect.poll(async () => (await xr.diag()).xr).toMatchObject({ frameRate: 72 });
  expect(await glErrors(page)).toEqual([]);
});

test('slow=0 control: the uncapped canvas stays under budget and nothing sheds', async ({
  page,
  xr,
}) => {
  await xr.boot('demo=canvas');
  await governor(xr);
  await xr.enterXR();
  // Warm-up (1 s) plus several 0.5 s windows.
  await page.waitForTimeout(4000);
  const gov = await governor(xr);
  console.log(`[e2e] governor control meanMs ${gov.meanMs}`);
  test.info().annotations.push({ type: 'controlMeanMs', description: String(gov.meanMs) });
  expect(gov.meanMs).not.toBeNull();
  expect(gov.meanMs ?? Number.POSITIVE_INFINITY).toBeLessThan(gov.budgetMs);
  expect(gov.history).toEqual([]);
  expect(gov).toMatchObject({ level: 0, targetHz: 90, foveation: 0, fbScale: 1 });
  expect(await glErrors(page)).toEqual([]);
});
