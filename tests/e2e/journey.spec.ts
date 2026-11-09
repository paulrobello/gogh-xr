/**
 * The P5 journey (P5.7, P5-A2), under IWER and on the desktop preview: boot the gallery, walk into
 * Starry Night's frame, open the settings panel with the menu binding, change the comfort vignette
 * through the panel, return to the gallery through the panel's button, reload, and find the
 * vignette kept. Every step goes through real input: the stick or W to walk, the left menu button
 * or M to open, a laser and trigger or a mouse click to set and to return. It asserts state only,
 * so it runs in the `e2e` project. It changes the setting inside the world and then returns, the
 * plan's order. PRD P5-A2 lists the return before the change, and both orders cover the same steps.
 */
import type { Page } from '@playwright/test';
import { Vector3 } from 'three';
import { controlHidden, setControlHidden } from '../../src/ui/panel-layout.ts';
import { expect, glErrors, test, type Xr } from './fixtures';
import {
  aim,
  controlPoint,
  panel,
  portal,
  SETTINGS_KEY,
  setButton,
  settings,
  settled,
} from './helpers';

const DEFAULT_VIGNETTE = 0.6;

// `setControlHidden` is module state shared with the other specs in this worker.
const galleryHidden = controlHidden('gallery');
test.afterEach(() => setControlHidden('gallery', galleryHidden));

/** Walks forward from the gallery spawn until the portal starts, then lets go. */
async function walkIntoStarryNight(
  xr: Xr,
  hold: () => Promise<void>,
  release: () => Promise<void>,
) {
  const spawn = (await xr.diag()).rig as { position: number[] };
  expect(spawn.position[0]).toBeCloseTo(0, 3);
  expect(spawn.position[2]).toBeCloseTo(0, 3);
  await hold();
  await expect.poll(async () => (await portal(xr)).state, { timeout: 20_000 }).toBe('entering');
  await release();
  expect((await portal(xr)).lastTrigger).toMatchObject({ id: 'starry-night', cause: 'walk' });
  await settled(xr, 'starry-night');
  expect((await xr.diag()).painting).toBe('starry-night');
}

/** Waits for the debounced save to land, so a reload reads what the panel set. */
async function saved(page: Page, xr: Xr, vignette: number): Promise<void> {
  await expect.poll(async () => (await settings(xr)).pending).toBe(false);
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), SETTINGS_KEY))
    .toContain(`"vignette":${vignette}`);
}

async function expectKept(xr: Xr, vignette: number): Promise<void> {
  const after = await settings(xr);
  expect(after.stored.vignette).toBe(vignette);
  expect(after.effective.vignette).toBe(vignette);
}

test('IWER: gallery, walk into Starry Night, left menu, vignette by laser, Return, reload keeps it', async ({
  page,
  xr,
}) => {
  test.setTimeout(240_000);
  await xr.boot('noanim&nogov');
  await settled(xr, 'gallery');
  expect((await settings(xr)).effective.vignette).toBe(DEFAULT_VIGNETTE);
  await xr.enterXR();
  await xr.setPose({ head: { position: [0, 1.6, 0], quaternion: [0, 0, 0, 1] } });

  // Forward on the left stick is raw -Y.
  await walkIntoStarryNight(
    xr,
    () => xr.stick('left', 0, -1),
    () => xr.stick('left', 0, 0),
  );

  // IWER's left thumbrest is button index 6, the app's `menu` slot. Whether a real Quest exposes
  // its menu button there is unverified (src/xr/input.ts MENU_BUTTON).
  await xr.press('left', 'thumbrest');
  await expect
    .poll(
      async () => {
        const p = await panel(xr);
        return p.open && p.typeset && p.surface === 'xr';
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  // Inside a world the page shows Return to gallery, so the layout module must too.
  setControlHidden('gallery', false);
  const slider = controlPoint(await panel(xr), 'vignette', 0.2);
  await aim(xr, slider.clone().add(new Vector3(0.06, -0.12, 0.38)), slider);
  await expect.poll(async () => (await panel(xr)).hover?.right).toBe('vignette');
  await setButton(page, 'trigger', 1);
  await xr.waitFrames(3);
  await setButton(page, 'trigger', 0);
  await xr.waitFrames(3);
  const vignette = (await settings(xr)).effective.vignette as number;
  // 20% along the slider snaps to 0.2 on its 0.05 step.
  expect(vignette).toBeCloseTo(0.2, 6);
  console.log(`[e2e] journey IWER vignette set to ${vignette}`);
  await saved(page, xr, vignette);

  const back = controlPoint(await panel(xr), 'gallery');
  await aim(xr, back.clone().add(new Vector3(-0.04, -0.1, 0.35)), back);
  await expect.poll(async () => (await panel(xr)).hover?.right).toBe('gallery');
  await setButton(page, 'trigger', 1);
  await xr.waitFrames(3);
  await setButton(page, 'trigger', 0);
  await expect
    .poll(async () => (await portal(xr)).lastTrigger)
    .toMatchObject({ id: 'gallery', cause: 'return' });
  await settled(xr, 'gallery');

  await page.reload();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__goghIwer && window.__goghDiag)))
    .toBe(true);
  await settled(xr, 'gallery');
  await expectKept(xr, vignette);
  await xr.enterXR();
  await xr.setPose({ head: { position: [0, 1.6, 0], quaternion: [0, 0, 0, 1] } });
  // Backward, away from the portal: at full stick the vignette settles at the kept strength.
  await xr.stick('left', 0, 1);
  await expect
    .poll(async () => ((await xr.diag()).rig as { vignette: number }).vignette, {
      timeout: 15_000,
      intervals: [50],
    })
    .toBeCloseTo(vignette, 2);
  await xr.stick('left', 0, 0);
  expect(await glErrors(page)).toEqual([]);
});

test('desktop: gallery, W into Starry Night, M, vignette by mouse, Return, reload keeps it', async ({
  page,
  xr,
}) => {
  test.setTimeout(240_000);
  await page.goto('/?diag&noanim');
  await expect.poll(() => page.evaluate(() => Boolean(window.__goghDiag))).toBe(true);
  await settled(xr, 'gallery');
  expect((await settings(xr)).effective.vignette).toBe(DEFAULT_VIGNETTE);

  await walkIntoStarryNight(
    xr,
    () => page.keyboard.down('KeyW'),
    () => page.keyboard.up('KeyW'),
  );

  await page.keyboard.press('m');
  const dom = page.locator('#gogh-settings');
  await expect(dom).toBeVisible();
  expect(await panel(xr)).toMatchObject({ open: true, surface: 'dom' });

  const slider = dom.locator('[data-control="vignette"] input[type=range]');
  const box = await slider.boundingBox();
  if (!box) throw new Error('the vignette slider has no box');
  await slider.click({ position: { x: box.width * 0.2, y: box.height / 2 } });
  await expect.poll(async () => (await settings(xr)).effective.vignette).not.toBe(DEFAULT_VIGNETTE);
  const vignette = (await settings(xr)).effective.vignette as number;
  expect(vignette).toBeLessThan(0.4);
  console.log(`[e2e] journey desktop vignette set to ${vignette}`);
  await saved(page, xr, vignette);

  const back = dom.locator('button[data-control="gallery"]');
  await expect(back).toBeEnabled();
  await back.click();
  await expect
    .poll(async () => (await portal(xr)).lastTrigger)
    .toMatchObject({ id: 'gallery', cause: 'return' });
  await settled(xr, 'gallery');

  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(window.__goghDiag))).toBe(true);
  await settled(xr, 'gallery');
  await expectKept(xr, vignette);
  // The reopened panel reads the kept value too.
  await page.keyboard.press('m');
  await expect(dom).toBeVisible();
  await expect(slider).toHaveValue(String(vignette));
  expect(await glErrors(page)).toEqual([]);
});
