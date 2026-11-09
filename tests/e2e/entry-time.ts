/**
 * Portal entry timing on a running build (card 01a1b83d2e2c), in headless Chromium on the GPU (the
 * e2e suite's launch flags). Boots the gallery, then runs `trips` round trips into Starry Night in
 * one browser context, so the first entry misses the scatter cache and the later ones hit it on a
 * production build. Prints each transition's wall time, its phases (the frame intervals of each
 * phase summed), the wait split by the switcher's tasks, and its longest frame and work.
 *
 *   bunx vite build && bunx vite preview --port 4334 --strictPort
 *   bun tests/e2e/entry-time.ts http://localhost:4334/ [trips]
 *
 * Not a spec: `make e2e` never runs it.
 */
import { chromium } from '@playwright/test';
import { gpuArgs } from './gpu.ts';
import type { PortalDiag } from './helpers.ts';

const [base, tripsArg] = process.argv.slice(2);
if (!base) {
  console.error('usage: bun tests/e2e/entry-time.ts <base-url> [trips]');
  process.exit(2);
}
const trips = Number(tripsArg ?? 3);

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  await page.goto(new URL('?diag&noanim', base).toString());
  const diag = () => page.evaluate(() => window.__goghDiag?.() ?? null);
  const settled = async (painting: string): Promise<void> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const d = await diag();
      const world = d?.world as { plaques?: { state: string } } | undefined;
      const p = d?.portal as PortalDiag | undefined;
      if (
        d?.painting === painting &&
        p?.state === 'idle' &&
        world !== undefined &&
        world.plaques?.state !== 'pending'
      ) {
        return;
      }
      if (Date.now() > deadline) throw new Error(`never settled in ${painting}`);
      await page.waitForTimeout(50);
    }
  };
  const report = (label: string, p: PortalDiag, world: unknown): void => {
    const phases: Record<string, { ms: number; frames: number }> = {};
    const tasks: Record<string, { ms: number; frames: number }> = {};
    let firstTask: number | null = null;
    p.frames.forEach((f, i) => {
      phases[f.phase] ??= { ms: 0, frames: 0 };
      const ph = phases[f.phase];
      ph.ms += f.intervalMs;
      ph.frames += 1;
      if (f.phase === 'wait' && f.task) {
        firstTask ??= i;
        const name = f.task.split('+')[0];
        tasks[name] ??= { ms: 0, frames: 0 };
        const t = tasks[name];
        t.ms += f.intervalMs;
        t.frames += 1;
      }
    });
    const wait = p.frames.filter((f) => f.phase === 'wait');
    const buildFrames = firstTask === null ? wait : p.frames.slice(0, firstTask);
    const buildWait = buildFrames.filter((f) => f.phase === 'wait');
    const round = (x: number) => Math.round(x * 10) / 10;
    console.log(
      JSON.stringify({
        label,
        durationMs: round(p.durationMs ?? 0),
        phases: Object.fromEntries(
          Object.entries(phases).map(([k, v]) => [k, `${round(v.ms)} ms / ${v.frames}`]),
        ),
        waitBeforeFirstTaskMs: round(buildWait.reduce((s, f) => s + f.intervalMs, 0)),
        waitTasks: Object.fromEntries(
          Object.entries(tasks).map(([k, v]) => [k, `${round(v.ms)} ms / ${v.frames}`]),
        ),
        longestFrameMs: p.longestFrameMs,
        longestWorkMs: round(p.longestWorkMs ?? 0),
        longestWorkPhase: p.longestWorkPhase,
        longestStep: p.longestStep,
        longestStepMs: round(p.longestStepMs ?? 0),
        world,
      }),
    );
  };
  await settled('gallery');
  for (let trip = 0; trip < trips; trip++) {
    await page.evaluate(() => window.__goghPose?.(0, 1.6, -2.6, 0, 0));
    await page.waitForTimeout(200);
    if (!(await page.evaluate(() => window.__goghPortal?.('starry-night')))) {
      throw new Error('the portal refused the entry');
    }
    await settled('starry-night');
    const d = await diag();
    const w = d?.world as { cache: string; times: unknown } | undefined;
    report(`enter ${trip + 1}`, d?.portal as PortalDiag, { cache: w?.cache, times: w?.times });
    await page.waitForTimeout(300);
    await page.keyboard.press('KeyG');
    await settled('gallery');
    report(`return ${trip + 1}`, (await diag())?.portal as PortalDiag, null);
    await page.waitForTimeout(300);
  }
} finally {
  await browser.close();
}
