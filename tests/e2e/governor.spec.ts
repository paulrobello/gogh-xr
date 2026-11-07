import { expect, glErrors, test, type Xr } from './fixtures';
import { gpuArgs } from './gpu';

// Headless Chromium vsyncs requestAnimationFrame at 60 Hz, and IWER drives XR frames from it, so
// every interval would be 16.7 ms: past the 72 Hz shed line (14.6 ms) with no `?slow` at all.
// Uncapped, the canvas frame takes about 5 ms and `?slow` is what pushes it over.
test.use({
  launchOptions: { args: [...gpuArgs, '--disable-frame-rate-limit', '--disable-gpu-vsync'] },
});

interface HistoryEntry {
  t: number;
  action:
    | 'shed'
    | 'restore'
    | 'shed-back'
    | 'no-gain'
    | 'recover'
    | 'recover-back'
    | 'rate'
    | 'rate-failed';
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
  fbScaleApplied: number | null;
  fbScalePath: string | null;
  foveation: number;
  meanMs: number | null;
  overrun: boolean;
  notice: string | null;
  rateRequest: string;
  frameRate: number;
  exhausted: boolean;
  history: HistoryEntry[];
}

async function governor(xr: Xr): Promise<GovernorDiag> {
  // The canvas builds, then the governor attaches, after async chunk imports.
  await expect
    .poll(async () => (await xr.diag()).governor !== undefined, { timeout: 30_000 })
    .toBe(true);
  return (await xr.diag()).governor as GovernorDiag;
}

test('hz=90 at slow=40: sheds only foveation, fb scale and near density, undoes one as no-gain, then asks 72 Hz', async ({
  page,
  xr,
}) => {
  // ?hz=90 selects adaptive-90, the one quality with a 72 Hz fallback.
  // Under host load, headless window means at slow=14 (about 19 ms) move 1-3% from one window to
  // the next and sometimes over 3%, so a shed can read as a gain by chance. At slow=40 (about
  // 47 ms) the busy-wait dominates and they mostly move under 1%. 325k strokes put the 150k floor
  // three near steps away, so a chance gain leads to another check, and the spec fails only if
  // every check before the rate request reads as a gain.
  await xr.boot('demo=canvas&count=325000&slow=40&hz=90');
  await governor(xr);
  // No ?hud: the HUD starts hidden and unbuilt, so only the notice can show it.
  expect((await xr.diag()).hud).toEqual({ visible: false, built: false });
  await xr.enterXR();
  expect(await governor(xr)).toMatchObject({ targetHz: 90 });
  await expect
    .poll(async () => (await governor(xr)).history.some((e) => e.action === 'rate'), {
      timeout: 30_000,
    })
    .toBe(true);
  const gov = await governor(xr);
  const sequence = gov.history.map((e) => `${e.action} ${e.step} ${e.from}->${e.to}`);
  console.log(`[e2e] governor history ${JSON.stringify(gov.history)}`);
  test.info().annotations.push({ type: 'governor', description: sequence.join(', ') });

  // Once 72 Hz applies, the frame-rate change clears the holds and the governor may try again at
  // 72, so only the history up to the rate request is the 90 Hz sequence.
  const rateAt = gov.history.findIndex((e) => e.action === 'rate');
  const rate = gov.history[rateAt];
  expect(rate).toMatchObject({ action: 'rate', from: 90, to: 72 });
  const before = gov.history.slice(0, rateAt);
  const pairs = before.map((e) => `${e.action} ${e.step}`);
  // `?slow` busy-waits on the CPU, which no shed touches. Foveation 0.5, fb scale and foveation 1
  // ('foveation-max') go first. The canvas is all near band, so near density is the only density
  // step, and an undo holds it. IWER renders no foveation and ignores requestViewportScale, so none
  // of the first three steps can gain. Window noise can still make a step read as a gain, so the
  // spec needs one undo, not one per step.
  expect(pairs[0]).toBe('shed foveation');
  expect(pairs).toContain('shed fb-scale');
  expect(pairs).toContain('shed near-density');
  expect(
    pairs.every((p) => /^(shed|no-gain) (foveation|foveation-max|near-density|fb-scale)$/.test(p)),
  ).toBe(true);
  expect(before.some((e) => e.action === 'no-gain')).toBe(true);
  // Each no-gain undoes the shed just before it, back to the level it shed from.
  before.forEach((e, i) => {
    if (e.action !== 'no-gain') return;
    expect(before[i - 1]).toMatchObject({ action: 'shed', step: e.step, from: e.to, to: e.from });
  });
  // Nothing left to shed: the request waits out 3 s of overrun after the last undo.
  expect(rate.t - (before.at(-1)?.t ?? 0)).toBeGreaterThanOrEqual(3000);

  expect(gov.fbScalePath).toBe('base-layer');
  // IWER's getViewport ignores requestViewportScale, so the measured scale stays 1.
  expect(gov.fbScaleApplied).toBe(1);
  // Foveation is a shed step: 0, or a level a chance gain kept.
  expect([0, 0.5, 1]).toContain(gov.foveation);
  // The 72 Hz budget and notice commit only once updateTargetFrameRate resolves.
  await expect.poll(async () => (await governor(xr)).rateRequest).toBe('applied');
  expect(gov.targetHz).toBe(72);
  expect(gov.frameRate).toBe(72);
  expect(gov.budgetMs).toBeCloseTo(1000 / 72, 3);
  expect(gov.notice).toMatch(/72 Hz/);
  // The DOM notice is invisible in immersive mode, so the notice shows the hidden HUD that carries
  // it (R16). The HUD builds asynchronously on that first show.
  await expect
    .poll(async () => {
      const hud = (await xr.diag()).hud as { visible: boolean; built: boolean; text?: string };
      return hud.visible && hud.built && (hud.text ?? '').includes(gov.notice ?? 'missing');
    })
    .toBe(true);
  // The busy-wait shows in the XR frame intervals.
  expect(gov.meanMs ?? 0).toBeGreaterThan(14);
  // IWER implements updateTargetFrameRate and reports the new nominal rate.
  await expect.poll(async () => (await xr.diag()).xr).toMatchObject({ frameRate: 72 });
  expect(await glErrors(page)).toEqual([]);
});

test('slow=40 at 180k strokes: the first near shed stops at the 150k drawn floor (ruling R10)', async ({
  page,
  xr,
}) => {
  // From the origin the whole canvas is in view, so 180k drawn puts the floor (150k) above the
  // 0.75 near step: the shed must clamp to it. The shed lasts one window before its no-gain undo,
  // so an in-page loop reads every frame rather than polling from the test.
  await xr.boot('demo=canvas&count=180000&slow=40');
  await governor(xr);
  await xr.enterXR();
  const sample = await page.evaluate(async () => {
    interface Read {
      governor: { densities: { near: number } };
      canvas: { strokes: { visible: number; total: number; visibleChunks: number } };
    }
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const diag = window.__goghDiag?.() as unknown as Read | undefined;
      const strokes = diag?.canvas?.strokes;
      // The cull runs in the frame after a density change, so wait for it to show.
      if (diag?.governor && strokes && diag.governor.densities.near < 1) {
        if (strokes.visible < strokes.total) return { near: diag.governor.densities.near, strokes };
      }
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      });
    }
    throw new Error('no near-density shed showed in the stroke counts within 30 s');
  });
  console.log(`[e2e] governor floor sample ${JSON.stringify(sample)}`);
  expect(sample.near).toBeGreaterThan(0.75);
  expect(sample.strokes.visible).toBeGreaterThanOrEqual(150_000 - sample.strokes.visibleChunks);
  expect(sample.strokes.visible).toBeLessThan(160_000);
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
  expect(gov).toMatchObject({ level: 0, targetHz: 72, foveation: 0, fbScale: 1 });
  expect(await glErrors(page)).toEqual([]);
});

test('the default boot runs adaptive-72: a 72 Hz budget from the start and no rate request', async ({
  page,
  xr,
}) => {
  // slow=40 overruns 72 Hz at every level, so the governor sheds what it can, finds nothing left,
  // and recovers. It never asks for a rate: the session asked for 72 at its start.
  await xr.boot('demo=canvas&count=325000&slow=40');
  await governor(xr);
  await xr.enterXR();
  await expect.poll(async () => (await xr.diag()).xr).toMatchObject({ frameRate: 72 });
  const first = await governor(xr);
  expect(first).toMatchObject({
    mode: 'default',
    targetHz: 72,
    frameRate: 72,
    rateRequest: 'none',
  });
  expect(first.budgetMs).toBeCloseTo(1000 / 72, 3);
  await expect.poll(async () => (await governor(xr)).exhausted, { timeout: 30_000 }).toBe(true);
  // Past the 3 s an adaptive-90 session waits before its request.
  await page.waitForTimeout(4000);
  const gov = await governor(xr);
  console.log(`[e2e] adaptive-72 governor history ${JSON.stringify(gov.history)}`);
  expect(gov.history.length).toBeGreaterThan(0);
  expect(gov.history.filter((e) => e.step === 'frame-rate')).toEqual([]);
  expect(gov).toMatchObject({ targetHz: 72, frameRate: 72, rateRequest: 'none', notice: null });
  expect(gov.budgetMs).toBeCloseTo(1000 / 72, 3);
  expect((await xr.diag()).hud).toEqual({ visible: false, built: false });
  expect(await glErrors(page)).toEqual([]);
});
