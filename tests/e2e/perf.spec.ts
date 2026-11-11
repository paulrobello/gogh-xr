/**
 * `?perf` (src/diag/perf.ts): the windowed frame recorder. Under IWER, an XR entry and two marks
 * close windows, each summary carries its label and stats, the list persists to localStorage and
 * survives a reload (whose pagehide closes the open window), and an A/B switch closes a window that keeps the variant it measured.
 * Written without being run (load ruling, 2026-11-11): run it on the MiniMac.
 */
import type { Page } from '@playwright/test';
import { expect, test, type Xr } from './fixtures';

interface Summary {
  label: string;
  closedBy: string | null;
  group: string | null;
  variant: string | null;
  frames: number;
  presenting: boolean;
  targetHz: number | null;
  budgetMs: number | null;
  meanMs: number | null;
  p99Ms: number | null;
  handSpeed: { n: number }[];
}

interface PerfDiag {
  windows: Summary[];
  current: Summary;
}

async function perfDiag(xr: Xr): Promise<PerfDiag> {
  let perf: PerfDiag | undefined;
  await expect
    .poll(async () => {
      perf = (await xr.diag()).perf as PerfDiag | undefined;
      return perf !== undefined;
    })
    .toBe(true);
  return perf as PerfDiag;
}

async function mark(page: Page, label: string): Promise<void> {
  await page.evaluate((l) => {
    (window as unknown as { __goghPerfMark(label: string): void }).__goghPerfMark(l);
  }, label);
}

/** V is read per frame, so it is held across frames rather than tapped (ab.spec.ts). */
async function pressV(page: Page, xr: Xr): Promise<void> {
  await page.keyboard.down('KeyV');
  await xr.waitFrames(2);
  await page.keyboard.up('KeyV');
  await xr.waitFrames(2);
}

/** Waits past the 1 s settle and long enough to count frames. */
async function measure(page: Page): Promise<void> {
  await page.waitForTimeout(2000);
}

test('?perf windows close on XR entry and on marks, and persist across a reload', async ({
  page,
  xr,
}) => {
  await xr.boot('perf&scene=bare');
  // The recorder loads behind a dynamic import: wait for its diag key before clearing.
  await perfDiag(xr);
  await page.evaluate(() => {
    (window as unknown as { __goghPerfClear(): void }).__goghPerfClear();
  });
  await measure(page);
  await xr.enterXR();
  await measure(page);
  await mark(page, 'first');
  await measure(page);
  await mark(page, 'second');
  const { windows, current } = await perfDiag(xr);
  expect(windows.map((w) => [w.label, w.closedBy])).toEqual([
    ['boot', 'xr-start'],
    ['xr-start', 'first'],
    ['first', 'second'],
  ]);
  expect(current.label).toBe('second');
  const [desktop, ...inXr] = windows;
  expect(desktop.presenting).toBe(false);
  expect(desktop.budgetMs).toBeNull();
  for (const w of inXr) {
    expect(w.presenting).toBe(true);
    expect(w.frames).toBeGreaterThan(20);
    expect(w.targetHz).not.toBeNull();
    expect(w.meanMs).toBeGreaterThan(0);
    expect(w.handSpeed).toHaveLength(2);
  }
  const stored = await page.evaluate(() => localStorage.getItem('gogh-xr.perf.v1'));
  expect(JSON.parse(stored ?? '{}').windows).toHaveLength(3);

  // The reload's pagehide closes the open window, past its settle, so it persists too.
  await measure(page);
  await xr.boot('perf&scene=bare');
  expect((await perfDiag(xr)).windows.map((w) => [w.label, w.closedBy])).toEqual([
    ['boot', 'xr-start'],
    ['xr-start', 'first'],
    ['first', 'second'],
    ['second', 'pagehide'],
  ]);
});

test('an A/B switch closes a window with the variant it measured', async ({ page, xr }) => {
  await xr.boot('perf&ab=trackertime&scene=bare');
  // The recorder loads behind a dynamic import: wait for its diag key before clearing.
  await perfDiag(xr);
  await page.evaluate(() => {
    (window as unknown as { __goghPerfClear(): void }).__goghPerfClear();
  });
  await measure(page);
  await pressV(page, xr);
  await measure(page);
  await pressV(page, xr);
  const { windows } = await perfDiag(xr);
  expect(windows.map((w) => [w.label, w.variant, w.closedBy])).toEqual([
    ['boot', 'predicted', 'ab trackertime=callback'],
    ['ab trackertime=callback', 'callback', 'ab trackertime=predicted'],
  ]);
});

test('with no A/B group, the A/B button marks a window', async ({ page, xr }) => {
  await xr.boot('perf&scene=bare');
  await perfDiag(xr);
  await page.evaluate(() => {
    (window as unknown as { __goghPerfClear(): void }).__goghPerfClear();
  });
  await measure(page);
  await pressV(page, xr);
  await measure(page);
  await pressV(page, xr);
  const { windows, current } = await perfDiag(xr);
  expect(windows.map((w) => [w.label, w.closedBy])).toEqual([
    ['boot', 'button'],
    ['button', 'button'],
  ]);
  expect(current.label).toBe('button');
});
