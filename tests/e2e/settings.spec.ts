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
  await page.goto(`/?diag&noanim&${query}`);
  await page.waitForFunction(() => {
    const diag = window.__goghDiag?.() as unknown as Record<string, unknown> | undefined;
    return Boolean(diag?.settings && diag.rig && diag.motion && diag.hud);
  });
  return page.evaluate(() => window.__goghDiag?.() as unknown as Record<string, unknown>);
}

function stored(settings: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, settings });
}

test('an empty localStorage boots the defaults', async ({ page }) => {
  const diag = await boot(page, '');
  const settings = diag.settings as SettingsDiag;
  expect(settings.recovered).toBeNull();
  expect(settings.effective).toMatchObject({ calm: 1, quality: 'adaptive-90', hud: false });
  expect(diag.rig).toMatchObject({ turnMode: 'snap', seated: false });
  expect(diag.hud).toMatchObject({ built: false });
  expect(diag.xr).toMatchObject({ targetFrameRate: 90 });
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
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
