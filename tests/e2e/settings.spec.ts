/**
 * Stored settings feed the live code at boot (P5.2): locomotion, the motion calm, the quality mode
 * and the HUD. A URL flag wins for the session and is never written back.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const KEY = 'gogh-xr.settings.v1';

interface SettingsDiag {
  stored: Record<string, unknown>;
  effective: Record<string, unknown>;
  recovered: string | null;
}

async function boot(page: Page, query: string, stored?: string): Promise<Record<string, unknown>> {
  if (stored !== undefined) {
    await page.addInitScript(
      ([key, value]) => {
        // Only the first load: a reload must show what the app itself wrote, if anything.
        if (!sessionStorage.getItem('seeded')) {
          localStorage.setItem(key, value);
          sessionStorage.setItem('seeded', '1');
        }
      },
      [KEY, stored],
    );
  }
  await page.goto(`/?diag&noanim&scene=bare&${query}`);
  await page.waitForFunction(() => {
    const diag = window.__goghDiag?.() as unknown as Record<string, unknown> | undefined;
    return Boolean(diag?.settings && diag.rig && diag.motion && diag.hud);
  });
  return page.evaluate(() => window.__goghDiag?.() as unknown as Record<string, unknown>);
}

function stored(settings: Record<string, unknown>): string {
  return JSON.stringify({ version: 2, settings });
}

test('an empty localStorage boots the defaults', async ({ page }) => {
  const diag = await boot(page, '');
  const settings = diag.settings as SettingsDiag;
  expect(settings.recovered).toBeNull();
  expect(settings.effective).toMatchObject({ calm: 1, quality: 'adaptive-72', hud: false });
  expect(diag.rig).toMatchObject({ turnMode: 'snap', seated: false });
  expect(diag.hud).toMatchObject({ built: false });
  expect(diag.xr).toMatchObject({ targetFrameRate: 72 });
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
});

test('a v1 stored adaptive-90, the old default, boots adaptive-72; ?hz=90 still asks 90', async ({
  page,
}) => {
  const v1 = JSON.stringify({ version: 1, settings: { quality: 'adaptive-90', calm: 0.4 } });
  const diag = await boot(page, '', v1);
  const settings = diag.settings as SettingsDiag;
  expect(settings.recovered).toBeNull();
  expect(settings.stored).toMatchObject({ quality: 'adaptive-72', calm: 0.4 });
  expect(diag.xr).toMatchObject({ targetFrameRate: 72 });
  // The migration is not written back until a setting changes.
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(v1);
  const ninety = await boot(page, 'hz=90');
  expect((ninety.settings as SettingsDiag).effective).toMatchObject({ quality: 'adaptive-90' });
  expect(ninety.xr).toMatchObject({ targetFrameRate: 90 });
});

test('stored settings reach locomotion, the motion clock, the quality mode and the HUD', async ({
  page,
}) => {
  const diag = await boot(
    page,
    '',
    stored({ turnMode: 'smooth', seated: true, calm: 0.4, quality: 'beauty-72', hud: true }),
  );
  expect(diag.rig).toMatchObject({ turnMode: 'smooth', seated: true });
  expect(diag.motion).toMatchObject({ calm: 0.4 });
  expect(diag.xr).toMatchObject({ targetFrameRate: 72 });
  await page.waitForFunction(() => {
    const diag = window.__goghDiag?.() as unknown as { hud?: { visible: boolean } } | undefined;
    return diag?.hud?.visible === true;
  });
});

test('a URL flag overrides the stored value for the session and is not written back', async ({
  page,
}) => {
  const text = stored({ turnMode: 'smooth', calm: 0.4, quality: 'beauty-72' });
  const diag = await boot(page, 'turn=snap&calm=1&hz=120', text);
  expect(diag.rig).toMatchObject({ turnMode: 'snap' });
  expect(diag.motion).toMatchObject({ calm: 1 });
  expect(diag.xr).toMatchObject({ targetFrameRate: 120 });
  const settings = diag.settings as SettingsDiag;
  expect(settings.stored).toMatchObject({ turnMode: 'smooth', calm: 0.4 });
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(text);
});

test('corrupt stored settings fall back to the defaults and report the reason', async ({
  page,
}) => {
  const diag = await boot(page, '', '{not json');
  const settings = diag.settings as SettingsDiag;
  expect(settings.recovered).toBe('corrupt-json');
  expect(diag.rig).toMatchObject({ turnMode: 'snap' });
});

interface FixedGovernorDiag {
  fixedLevel: number | null;
  level: number;
  foveation: number;
  foveationPin?: number | null;
  fbScale: number | 'unavailable';
  history: unknown[];
}

async function governorOf(page: Page): Promise<FixedGovernorDiag> {
  const handle = await page.waitForFunction(
    () => (window.__goghDiag?.() as unknown as { governor?: unknown } | undefined)?.governor,
    undefined,
    { timeout: 30_000 },
  );
  return (await handle.jsonValue()) as FixedGovernorDiag;
}

test('a fixed quality level set in the DOM panel applies, survives a reload and shows in the governor diag', async ({
  page,
}) => {
  await page.goto('/?diag&noanim&strokesTest');
  expect(await governorOf(page)).toMatchObject({ fixedLevel: 5, level: 5, foveation: 1 });
  await page.keyboard.press('m');
  const row = page.locator('#gogh-settings [data-control="qualityLevel"]');
  const slider = row.locator('input[type=range]');
  await expect(slider).toHaveValue('5');
  await expect(row.locator('.value')).toHaveText('5 · far 0.20');
  // Keyboard on the range input: Home is Auto, then four steps right is level 3.
  await slider.focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await expect(row.locator('.value')).toHaveText('3 · fov 1');
  await expect
    .poll(async () => governorOf(page))
    .toMatchObject({ fixedLevel: 3, level: 3, foveation: 1, fbScale: 0.85, history: [] });
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), KEY))
    .toContain('"qualityLevel":3');

  await page.reload();
  expect(await governorOf(page)).toMatchObject({ fixedLevel: 3, level: 3, foveation: 1 });
  const diag = await page.evaluate(
    () => window.__goghDiag?.() as unknown as Record<string, unknown>,
  );
  expect((diag.settings as SettingsDiag).stored).toMatchObject({ qualityLevel: 3 });

  // Back to Auto: the adaptive machine from the start levels.
  await page.keyboard.press('m');
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(row.locator('.value')).toHaveText('Auto');
  await expect
    .poll(async () => governorOf(page))
    .toMatchObject({ fixedLevel: null, level: 0, foveation: 0, fbScale: 1 });
});

test('a foveation pin set in the DOM panel applies over the level, survives a reload, and ?fov locks it', async ({
  page,
}) => {
  const settingsOf = async (): Promise<SettingsDiag> => {
    const diag = await page.evaluate(
      () => window.__goghDiag?.() as unknown as Record<string, unknown>,
    );
    return diag.settings as SettingsDiag;
  };
  await page.goto('/?diag&noanim&strokesTest');
  expect(await governorOf(page)).toMatchObject({ fixedLevel: 5, foveation: 1, foveationPin: null });
  await page.keyboard.press('m');
  const row = page.locator('#gogh-settings [data-control="foveation"]');
  const buttons = row.locator('button');
  await expect(buttons).toHaveText(['Auto', 'Off', '0.5', '1']);
  await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await buttons.nth(1).click();
  await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
  expect((await settingsOf()).effective).toMatchObject({ foveation: 0 });
  // The level keeps its fb and density steps; only the foveation is the pin.
  await expect
    .poll(async () => governorOf(page))
    .toMatchObject({ fixedLevel: 5, level: 5, fbScale: 0.85, foveation: 0, foveationPin: 0 });
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), KEY))
    .toContain('"foveation":0');

  await page.reload();
  expect(await governorOf(page)).toMatchObject({ fixedLevel: 5, foveation: 0, foveationPin: 0 });
  expect((await settingsOf()).stored).toMatchObject({ foveation: 0 });

  await page.goto('/?diag&noanim&strokesTest&fov=1');
  expect(await governorOf(page)).toMatchObject({ foveation: 1, foveationPin: 1 });
  expect(await settingsOf()).toMatchObject({
    effective: { foveation: 1 },
    stored: { foveation: 0 },
  });
  await page.keyboard.press('m');
  await expect(row.locator('button').first()).toBeDisabled();
  await expect(row).toHaveAttribute('title', /\?fov=1/);
});
