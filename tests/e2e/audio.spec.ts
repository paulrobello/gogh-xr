/**
 * The audio unlock (P6.5): no AudioContext before a gesture, a running one after the first click
 * or the Enter VR button, a silent, error-free boot with no audio files present, none at all in
 * the bench, and the desktop panel's volume sliders driving the buses live and across a reload.
 * P6.6 extends this once P6.4's files ship.
 */
import type { Page } from '@playwright/test';
import { expect, test, type Xr } from './fixtures';
import { SETTINGS_KEY, settings } from './helpers';

interface AudioDiag {
  state: string;
  unlocked: boolean;
  manifest: string;
  buses: { music: number; sfx: number };
  score: { target: string | null; playing: string | null; crossfading: boolean };
  voices: { music: number; sfx: number; max: number; dropped: number };
}

const audio = async (xr: Xr): Promise<AudioDiag> => (await xr.diag()).audio as AudioDiag;

/** Counts AudioContext constructions from the next navigation on, read by `contexts(page)`. */
async function countContexts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let made = 0;
    (window as unknown as { __audioContexts: () => number }).__audioContexts = () => made;
    const Real = window.AudioContext;
    if (!Real) return;
    window.AudioContext = class extends Real {
      constructor(options?: AudioContextOptions) {
        super(options);
        made++;
      }
    };
  });
}

const contexts = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __audioContexts: () => number }).__audioContexts());

test('the first desktop click unlocks a running context, and missing files run silent', async ({
  page,
  xr,
}) => {
  await countContexts(page);
  await xr.boot('noanim');
  await expect.poll(async () => (await xr.diag()).painting).toBe('gallery');
  await xr.waitFrames(3);
  const before = await audio(xr);
  expect(before).toMatchObject({ state: 'none', unlocked: false, manifest: 'pending' });
  expect(before.score.target).toBe('score-gallery');
  expect(await contexts(page)).toBe(0);
  await page.locator('canvas').click();
  await expect.poll(async () => (await audio(xr)).unlocked).toBe(true);
  await expect.poll(async () => (await audio(xr)).state).toBe('running');
  await expect.poll(async () => (await audio(xr)).manifest).not.toBe('pending');
  const after = await audio(xr);
  expect(after.score.target).toBe('score-gallery');
  expect(after.voices.dropped).toBe(0);
  await page.locator('canvas').click();
  expect(await contexts(page)).toBe(1);
});

test('Enter VR unlocks the context', async ({ xr }) => {
  await xr.boot('noanim&scene=bare');
  await xr.waitFrames(3);
  expect((await audio(xr)).unlocked).toBe(false);
  await xr.enterXR();
  await expect.poll(async () => (await audio(xr)).unlocked).toBe(true);
  await expect.poll(async () => (await audio(xr)).state).toBe('running');
});

test('the bench creates no audio', async ({ page, xr }) => {
  await countContexts(page);
  await xr.boot('bench=1000');
  await xr.waitFrames(3);
  await page.locator('canvas').click();
  await page.keyboard.press('Space');
  await xr.waitFrames(2);
  expect((await xr.diag()).audio).toBeUndefined();
  expect(await contexts(page)).toBe(0);
});

test('the desktop panel volume sliders move the buses live and persist across a reload', async ({
  page,
  xr,
}) => {
  await xr.boot('noanim&scene=bare');
  await xr.waitFrames(3);
  await page.locator('canvas').click();
  await expect.poll(async () => (await audio(xr)).state).toBe('running');
  expect((await audio(xr)).buses).toEqual({ music: 0.7, sfx: 0.7 });
  await page.keyboard.press('m');
  const dom = page.locator('#gogh-settings');
  await expect(dom).toBeVisible();
  const music = dom.locator('[data-control="musicVolume"] input[type=range]');
  const sfx = dom.locator('[data-control="sfxVolume"] input[type=range]');
  await expect(music).toBeEnabled();
  await expect(sfx).toBeEnabled();

  // Each arrow press is one 0.05 step, applied to the running mixer at once.
  await music.focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await audio(xr)).buses.music).toBeCloseTo(0.3, 6);
  expect((await audio(xr)).buses.sfx).toBeCloseTo(0.7, 6);
  await sfx.focus();
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await audio(xr)).buses.sfx).toBeCloseTo(0.8, 6);
  expect((await audio(xr)).buses.music).toBeCloseTo(0.3, 6);
  await expect.poll(async () => (await settings(xr)).pending).toBe(false);
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), SETTINGS_KEY))
    .toContain('"musicVolume":0.3');
  expect(await page.evaluate((k) => localStorage.getItem(k), SETTINGS_KEY)).toContain(
    '"sfxVolume":0.8',
  );

  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(window.__goghDiag))).toBe(true);
  await xr.waitFrames(3);
  const kept = await settings(xr);
  expect(kept.stored).toMatchObject({ musicVolume: 0.3, sfxVolume: 0.8 });
  expect((await audio(xr)).unlocked).toBe(false);
  await page.locator('canvas').click();
  await expect.poll(async () => (await audio(xr)).state).toBe('running');
  expect((await audio(xr)).buses).toEqual({ music: 0.3, sfx: 0.8 });
});
