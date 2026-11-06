import type { Page } from '@playwright/test';
import { expect, glErrors, test, type Xr } from './fixtures';

interface HudDiag {
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
  level: number;
  targetHz: number;
  densities: Record<'near' | 'mid' | 'far', number>;
  foveation: number;
  fbScale: number | 'unavailable';
  gpuMs: number | null;
  notice: string | null;
}

interface Sample {
  hud: HudDiag;
  frame: FrameDiag;
  governor?: GovernorDiag;
  canvas: { strokes: { visible: number } };
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
  const { hud, frame, governor, canvas } = sample;
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
  expect(Number(target), 'target Hz').toBe(governor ? governor.targetHz : 90);

  const [, visible] = line(/^visible ([\d,]+) strokes$/);
  expect(Number(visible?.replaceAll(',', '')), 'visible strokes').toBe(canvas.strokes.visible);

  if (!governor) {
    expect(lines).toContain('governor off');
    expect(hud.text).not.toMatch(/gov level|foveation/);
    return;
  }
  const [, level, near, mid, far] = line(
    /^gov level (\d+) {3}near (\d\.\d\d) {3}mid (\d\.\d\d) {3}far (\d\.\d\d)$/,
  );
  expect(Number(level), 'governor level').toBe(governor.level);
  expect(near, 'near density').toBe(governor.densities.near.toFixed(2));
  expect(mid, 'mid density').toBe(governor.densities.mid.toFixed(2));
  expect(far, 'far density').toBe(governor.densities.far.toFixed(2));
  const [, foveation, fb] = line(/^foveation (\d\.\d\d) {3}fb scale (\S+)$/);
  expect(foveation, 'foveation').toBe(governor.foveation.toFixed(2));
  expect(fb, 'fb scale').toBe(
    governor.fbScale === 'unavailable' ? 'n/a' : governor.fbScale.toFixed(2),
  );
  if (governor.notice) expect(lines.at(-1), 'notice').toBe(governor.notice);
  else expect(lines).toHaveLength(5);
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

test('the HUD matches diag within one update while the governor sheds, notice included', async ({
  page,
  xr,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await bootHud(page, xr, '');
  await xr.enterXR();

  // Headless Chromium's 60 Hz vsync overruns the 90 Hz budget, so the governor moves.
  await expect
    .poll(async () => ((await xr.diag()).governor as GovernorDiag).level, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const first = await alignedSample(page);
  expectHudMatches(first);
  expect(first.governor).toBeDefined();

  // The next update comes one 250 ms interval later, give or take a frame.
  const next = await alignedSample(page, first.hud.updatedAt);
  const gap = (next.hud.updatedAt ?? 0) - (first.hud.updatedAt ?? 0);
  expect(gap).toBeGreaterThanOrEqual(250);
  expect(gap).toBeLessThan(500);
  expectHudMatches(next);

  // At the bottom of the shed order the governor drops to 72 Hz and the HUD shows its notice. The
  // 72 Hz target and the notice commit in the updateTargetFrameRate callback, outside any frame,
  // so the sample must come from an update after the read that first saw the notice.
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
  expect(noticed.hud.text).toContain(noticed.governor?.notice ?? 'missing notice');
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
