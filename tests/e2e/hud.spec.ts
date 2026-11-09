import type { Page } from '@playwright/test';
import { expect, glErrors, test, useAutoQuality, type Xr } from './fixtures';

interface HudDiag {
  visible: boolean;
  built: boolean;
  text: string;
  updatedAt: number | null;
  typeset: boolean;
}

interface FrameDiag {
  t: number | null;
  fps: number;
  meanMs: number | null;
  p99Ms: number | null;
}

interface GovernorDiag {
  judging: boolean;
  level: number;
  targetHz: number;
  densities: Record<'near' | 'mid' | 'far', number>;
  foveation: number;
  fbScale: number | 'unavailable';
  fbScaleApplied: number | null;
  gpuMs: number | null;
  notice: string | null;
  fixedLevel: number | null;
  history: unknown[];
}

interface Sample {
  hud: HudDiag;
  frame: FrameDiag;
  governor?: GovernorDiag;
  canvas: { strokes: { visible: number; visibleChunks: number } };
  xr: { targetFrameRate: number | null };
}

/**
 * One `__goghDiag()` read taken in the frame the HUD recomputed its text: `hud.updatedAt` equals
 * the time of the last recorded frame, so the HUD and the live diag fields describe the same
 * frame. The page yields through a MessageChannel, which runs between every pair of frames, so it
 * catches the next update (at most 250 ms plus one frame away) without any wall-clock tolerance.
 * `after` skips the update stamped with that frame time, so consecutive calls see distinct updates
 * (a time, not an order: entering XR can switch the frame clock).
 */
function alignedSample(page: Page, after: number | null = null): Promise<Sample> {
  return page.evaluate(async (since) => {
    const yieldTask = () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      });
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const diag = window.__goghDiag?.() as unknown as Partial<Sample> | undefined;
      const hud = diag?.hud;
      if (hud && diag.frame && diag.canvas && hud.updatedAt !== null) {
        // Mean and p99 need recorded intervals, so wait out the frame-stats warm-up.
        const live = diag.frame.meanMs !== null;
        const fresh = hud.updatedAt !== since;
        if (live && fresh && hud.updatedAt === diag.frame.t) return diag as Sample;
      }
      await yieldTask();
    }
    throw new Error('no diag read landed in a HUD update frame within 5 s');
  }, after);
}

function ms(value: number | null): string {
  return value === null ? '--' : value.toFixed(2);
}

/** Parses the HUD text and checks every field against the diag's own fields. */
function expectHudMatches(sample: Sample): void {
  const { hud, frame, governor, canvas, xr } = sample;
  const lines = hud.text.split('\n');
  const line = (pattern: RegExp): RegExpExecArray => {
    const match = lines.map((l) => pattern.exec(l)).find((m) => m !== null);
    if (!match) throw new Error(`HUD line ${pattern} missing from:\n${hud.text}`);
    return match;
  };

  const [, fps, mean, p99] = line(/^fps (\d+) {3}mean (\S+) ms {3}p99 (\S+) ms$/);
  expect(Number(fps), 'fps').toBe(frame.fps);
  expect(mean, 'mean ms').toBe(ms(frame.meanMs));
  expect(p99, 'p99 ms').toBe(ms(frame.p99Ms));

  const [, gpu, target] = line(/^gpu (n\/a|\d+\.\d+ ms) {3}target (\d+) Hz$/);
  const gpuMs = governor?.gpuMs ?? null;
  expect(gpu, 'gpu').toBe(gpuMs === null ? 'n/a' : `${gpuMs.toFixed(2)} ms`);
  expect(Number(target), 'target Hz').toBe(governor ? governor.targetHz : xr.targetFrameRate);

  const [, visible, chunks] = line(/^visible ([\d,]+) strokes {3}([\d,]+) chunks$/);
  expect(Number(visible?.replaceAll(',', '')), 'visible strokes').toBe(canvas.strokes.visible);
  expect(Number(chunks?.replaceAll(',', '')), 'visible chunks').toBe(canvas.strokes.visibleChunks);

  if (!governor) {
    expect(lines).toContain('governor off');
    expect(hud.text).not.toMatch(/gov level|foveation/);
    return;
  }
  // On desktop the governor does not judge frames, so the HUD shows "gov idle" for the level. A
  // fixed level reads "gov fixed L3" either way.
  const [, level, fixed, near, mid, far] = line(
    /^gov (?:level (\d+)|idle|fixed L(\d+)) {3}near (\d\.\d\d) {3}mid (\d\.\d\d) {3}far (\d\.\d\d)$/,
  );
  if (governor.fixedLevel !== null) expect(Number(fixed), 'fixed level').toBe(governor.fixedLevel);
  else if (governor.judging) expect(Number(level), 'governor level').toBe(governor.level);
  else expect(level, 'governor idle').toBeUndefined();
  expect(near, 'near density').toBe(governor.densities.near.toFixed(2));
  expect(mid, 'mid density').toBe(governor.densities.mid.toFixed(2));
  expect(far, 'far density').toBe(governor.densities.far.toFixed(2));
  const [, foveation, fb, applied] = line(
    /^foveation (\d\.\d\d) {3}fb scale (\S+)(?: \(applied (\d\.\d\d)\))?$/,
  );
  expect(foveation, 'foveation').toBe(governor.foveation.toFixed(2));
  const { fbScale, fbScaleApplied } = governor;
  expect(fb, 'fb scale').toBe(fbScale === 'unavailable' ? 'n/a' : fbScale.toFixed(2));
  // The applied scale shows only when it is known and differs from the request by over 0.01.
  const differs =
    typeof fbScale === 'number' &&
    fbScaleApplied !== null &&
    Math.abs(fbScaleApplied - fbScale) > 0.01;
  expect(applied, 'applied fb scale').toBe(differs ? fbScaleApplied?.toFixed(2) : undefined);
  // The 72 Hz notice shows on the notice stack, not on the HUD (2026-11-08).
  if (governor.notice) expect(hud.text).not.toContain(governor.notice);
  expect(lines).toHaveLength(5);
}

async function bootHud(page: Page, xr: Xr, extra: string): Promise<void> {
  await xr.boot(`hud&demo=canvas${extra}`);
  // The canvas builds and the HUD types its first text after async chunk imports.
  await expect
    .poll(
      async () => {
        const diag = await xr.diag();
        return Boolean((diag.hud as HudDiag | undefined)?.typeset && diag.canvas);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(await glErrors(page)).toEqual([]);
}

test('the HUD matches diag within one update while the governor sheds, and leaves out the notice', async ({
  page,
  xr,
}) => {
  await useAutoQuality(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  // ?hz=90 selects adaptive-90, whose 72 Hz fallback brings the notice this test needs.
  await bootHud(page, xr, '&hz=90');
  await xr.enterXR();

  // Headless Chromium's 60 Hz vsync overruns the 90 Hz budget, so the governor moves. Vsync fixes
  // the interval, so each shed buys nothing and is undone as no-gain a window later. A shed level
  // lasts one 0.5 s window, about two HUD updates, so step through the updates until one lands
  // while a step is shed: that sample proves the HUD shows a level other than 0.
  let first = await alignedSample(page);
  const deadline = Date.now() + 20_000;
  while (!(first.governor?.judging && first.governor.level > 0) && Date.now() < deadline) {
    first = await alignedSample(page, first.hud.updatedAt);
  }
  expect(first.governor?.level, 'a HUD update while a step is shed').toBeGreaterThan(0);
  expectHudMatches(first);

  // The next update comes one 250 ms interval later, give or take a frame.
  const next = await alignedSample(page, first.hud.updatedAt);
  const gap = (next.hud.updatedAt ?? 0) - (first.hud.updatedAt ?? 0);
  expect(gap).toBeGreaterThanOrEqual(250);
  expect(gap).toBeLessThan(500);
  expectHudMatches(next);

  // At the bottom of the shed order the governor drops to 72 Hz. The notice goes to the notice
  // stack, and the HUD shows the 72 Hz target. The target and the notice commit in the
  // updateTargetFrameRate callback, outside any frame, so the sample must come from an update
  // after the read that first saw the notice.
  let seenAt: number | null = null;
  await expect
    .poll(
      async () => {
        const diag = await xr.diag();
        seenAt = (diag.hud as HudDiag).updatedAt;
        return (diag.governor as GovernorDiag).notice;
      },
      { timeout: 30_000 },
    )
    .toMatch(/72 Hz/);
  const noticed = await alignedSample(page, seenAt);
  expectHudMatches(noticed);
  expect(noticed.hud.text).not.toContain(noticed.governor?.notice ?? 'missing notice');
  expect(noticed.hud.text).toMatch(/target 72 Hz/);

  // The font comes from the app, never from troika's CDN.
  const origin = new URL(page.url()).origin;
  expect(requests.filter((url) => !url.startsWith(origin) && !/^(data|blob):/.test(url))).toEqual(
    [],
  );
  expect(requests).toContain(`${origin}/fonts/NotoSans-Regular.ttf`);
  expect(await glErrors(page)).toEqual([]);
});

test('without a governor the HUD shows the frame lines and "governor off", desktop and XR', async ({
  page,
  xr,
}) => {
  await bootHud(page, xr, '&nogov');
  const desktop = await alignedSample(page);
  expect(desktop.governor).toBeUndefined();
  expectHudMatches(desktop);

  await xr.enterXR();
  // Two updates after entry: the first may still count the desktop pose's cull.
  const entry = await alignedSample(page, desktop.hud.updatedAt);
  const inXr = await alignedSample(page, entry.hud.updatedAt);
  expect(inXr.governor).toBeUndefined();
  expectHudMatches(inXr);
  expect(await glErrors(page)).toEqual([]);
});

const FONT_PATH = '/fonts/NotoSans-Regular.ttf';

function hudDiag(xr: Xr): Promise<HudDiag> {
  return xr.diag().then((diag) => diag.hud as HudDiag);
}

test('without ?hud the HUD stays unbuilt until H, then H hides and shows it', async ({
  page,
  xr,
}) => {
  const fonts: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === FONT_PATH) fonts.push(request.url());
  });
  await xr.boot('demo=canvas');
  await expect
    .poll(async () => (await xr.diag()).canvas !== undefined, { timeout: 30_000 })
    .toBe(true);
  await xr.waitFrames(30);
  expect(await hudDiag(xr)).toEqual({ visible: false, built: false });
  expect((await xr.diag()).frame).toBeUndefined();
  expect(fonts).toEqual([]);

  // A held key auto-repeats; only the first keydown toggles.
  await page.keyboard.down('h');
  await page.keyboard.down('h');
  await page.keyboard.up('h');
  await expect
    .poll(async () => {
      const hud = await hudDiag(xr);
      return hud.visible && hud.built && hud.typeset;
    })
    .toBe(true);
  expect(fonts).toHaveLength(1);
  expectHudMatches(await alignedSample(page));

  await page.keyboard.press('h');
  await expect.poll(async () => (await hudDiag(xr)).visible).toBe(false);
  // Hidden, the HUD stops recomputing: no update across two 250 ms intervals.
  const hiddenAt = (await hudDiag(xr)).updatedAt;
  await xr.waitFrames(40);
  expect((await hudDiag(xr)).updatedAt).toBe(hiddenAt);

  await page.keyboard.press('h');
  await expect.poll(async () => (await hudDiag(xr)).visible).toBe(true);
  expectHudMatches(await alignedSample(page, hiddenAt));
  expect(fonts).toHaveLength(1);
  expect(await glErrors(page)).toEqual([]);
});

test('in XR the left X button toggles the HUD once per press', async ({ page, xr }) => {
  await bootHud(page, xr, '&nogov');
  await xr.enterXR();
  expect((await hudDiag(xr)).visible).toBe(true);
  await xr.press('left', 'x-button');
  await expect.poll(async () => (await hudDiag(xr)).visible).toBe(false);
  await xr.press('left', 'x-button');
  await expect.poll(async () => (await hudDiag(xr)).visible).toBe(true);
  expectHudMatches(await alignedSample(page));
  expect(await glErrors(page)).toEqual([]);
});
