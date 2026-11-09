/**
 * Desktop captures of the portal's wait (P5.5), written to docs/shots when `PORTAL_SHOTS=1`: the fly
 * style's swirl twice, 0.5 s apart, and the fade style's pulse field (calm 0.2, seeded through the
 * stored settings), each mid-wait while Starry Night builds behind the veil.
 */
import type { Page } from '@playwright/test';
import { expect, test, type Xr } from './fixtures';
import { type PortalDiag, portal, settled } from './helpers';

interface WaitDiag extends PortalDiag {
  phase: string | null;
  cue: string | null;
  waitMs: number | null;
}

async function hideButton(page: Page): Promise<void> {
  await page.evaluate(() => {
    const button = document.getElementById('enter-vr');
    if (button) button.style.visibility = 'hidden';
  });
}

/** Starts the entry and waits until the wait has run `ms`. */
async function intoWait(page: Page, xr: Xr, ms: number): Promise<WaitDiag> {
  expect(await page.evaluate(() => window.__goghPortal?.('starry-night'))).toBe(true);
  await expect
    .poll(
      async () => {
        const p = (await portal(xr)) as WaitDiag;
        return p.phase === 'wait' && (p.waitMs ?? 0) >= ms;
      },
      { timeout: 30_000, intervals: [20] },
    )
    .toBe(true);
  return (await portal(xr)) as WaitDiag;
}

test('docs/shots captures of the portal wait (PORTAL_SHOTS=1)', async ({ page, xr }) => {
  test.skip(!process.env.PORTAL_SHOTS, 'set PORTAL_SHOTS=1 to write docs/shots');
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Fly: from 1.2 m before the frame, as a walk-in starts.
  await xr.boot('noanim&nogov&shot');
  await settled(xr, 'gallery');
  await hideButton(page);
  await page.evaluate(() => window.__goghPose?.(0, 1.6, -2.6, 0, 0));
  await xr.waitFrames(3);
  const fly = await intoWait(page, xr, 1000);
  expect(fly.cue).toBe('swirl');
  await page.screenshot({ path: 'docs/shots/p55-wait-fly-a.jpg', type: 'jpeg', quality: 90 });
  await page.waitForTimeout(500);
  expect(((await portal(xr)) as WaitDiag).phase).toBe('wait');
  await page.screenshot({ path: 'docs/shots/p55-wait-fly-b.jpg', type: 'jpeg', quality: 90 });
  await settled(xr, 'starry-night');

  // Fade: calm 0.2 from the stored settings.
  await page.addInitScript(() => {
    localStorage.setItem(
      'gogh-xr.settings.v1',
      JSON.stringify({ version: 2, settings: { calm: 0.2 } }),
    );
  });
  await xr.boot('noanim&nogov&shot');
  await settled(xr, 'gallery');
  await hideButton(page);
  await page.evaluate(() => window.__goghPose?.(0, 1.6, -2.6, 0, 0));
  await xr.waitFrames(3);
  const fade = await intoWait(page, xr, 2500);
  expect(fade.cue).toBe('pulse');
  await page.screenshot({ path: 'docs/shots/p55-wait-fade.jpg', type: 'jpeg', quality: 90 });
  await settled(xr, 'starry-night');
});
