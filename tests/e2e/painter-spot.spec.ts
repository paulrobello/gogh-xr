import { Euler, Quaternion, Vector3 } from 'three';
import { CANVAS_PITCH } from '../../src/paintings/starry-night/canvas-camera';
import { expect, type Quat, test, type Xr } from './fixtures';
import { aim, controlPoint, panel, portal, settings, settled } from './helpers';

interface Round {
  match: number;
  found: boolean;
  hint: boolean;
  threshold: number;
  hud: { reference: boolean; text: string } | null;
}

async function round(xr: Xr): Promise<Round | null> {
  return (await xr.diag()).painterSpot as Round | null;
}

async function rigPosition(xr: Xr): Promise<number[]> {
  return ((await xr.diag()).rig as { position: number[] }).position;
}

async function expectRandomStart(xr: Xr): Promise<void> {
  const [x, , z] = await rigPosition(xr);
  expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(8);
  expect(Math.hypot(x, z)).toBeLessThanOrEqual(18);
  expect(await round(xr)).toMatchObject({ found: false, hint: false, hud: null });
}

test('desktop settings start a fresh round, with opt-in hints and a stationary finish', async ({
  page,
  xr,
}) => {
  test.setTimeout(120_000);
  const url = '/?diag&noanim&painting=starry-night&findthreshold=97.5';
  await page.goto(url);
  await settled(xr, 'starry-night');
  expect(await rigPosition(xr)).toEqual([0, 0, 0]);
  expect(await round(xr)).toBeNull();

  await page.keyboard.press('m');
  const toggle = page.locator('[data-control="findPainterSpot"] button');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(await round(xr)).toBeNull();

  await page.reload();
  await settled(xr, 'starry-night');
  await expectRandomStart(xr);
  expect((await round(xr))?.threshold).toBe(97.5);

  await page.keyboard.press('j');
  await expect
    .poll(async () => (await round(xr))?.hud)
    .toMatchObject({
      reference: true,
      text: expect.stringMatching(/^\d+% match\n/),
    });
  await page.keyboard.press('j');
  await expect.poll(async () => (await round(xr))?.hud).toBeNull();

  await page.evaluate((pitch) => window.__goghPose?.(0, 1.6, 0, 0, pitch), CANVAS_PITCH);
  await expect
    .poll(async () => (await round(xr))?.hud)
    .toMatchObject({
      reference: false,
      text: 'You found the painter’s spot',
    });
  const camera = (await xr.diag()).camera;
  expect(camera.position).toEqual([0, 1.6, 0]);
  expect(await round(xr)).toMatchObject({ found: true, hint: false });
  expect((await round(xr))?.match).toBeCloseTo(100);
  await page.keyboard.press('j');
  await xr.waitFrames(3);
  expect((await xr.diag()).camera).toEqual(camera);
  expect((await round(xr))?.hint).toBe(false);

  await page.keyboard.press('g');
  await settled(xr, 'gallery');
  expect(await round(xr)).toBeNull();
});

test('XR settings opt into portal entry and hints follow the rendered head pose', async ({
  page,
  xr,
}) => {
  test.setTimeout(120_000);
  await xr.boot('noanim');
  await settled(xr, 'gallery');
  await xr.enterXR();
  await xr.setPose({ head: { position: [0, 1.6, 0], quaternion: [0, 0, 0, 1] } });
  await xr.press('right', 'a-button');
  await expect.poll(async () => (await panel(xr)).typeset).toBe(true);
  const target = controlPoint(await panel(xr), 'findPainterSpot');
  await aim(xr, target.clone().add(new Vector3(0, 0, 0.32)), target);
  await expect.poll(async () => (await panel(xr)).hover?.right).toBe('findPainterSpot');
  await xr.press('right', 'trigger');
  await expect.poll(async () => (await settings(xr)).effective.findPainterSpot).toBe(true);
  await xr.press('right', 'a-button');

  await xr.stick('left', 0, -1);
  await expect.poll(async () => (await portal(xr)).state, { timeout: 20_000 }).toBe('entering');
  await xr.stick('left', 0, 0);
  expect((await portal(xr)).lastTrigger).toMatchObject({ id: 'starry-night', cause: 'walk' });
  await settled(xr, 'starry-night');
  await expectRandomStart(xr);
  expect((await round(xr))?.threshold).toBe(90);
  await xr.press('left', 'y-button');
  await expect.poll(async () => (await round(xr))?.hud?.reference).toBe(true);
  await xr.press('left', 'y-button');
  await expect.poll(async () => (await round(xr))?.hud).toBeNull();

  const [x, , z] = await rigPosition(xr);
  const orientation = new Quaternion().setFromEuler(new Euler(CANVAS_PITCH, 0, 0));
  await xr.setPose({
    head: {
      position: [-x, 1.6, -z],
      quaternion: orientation.toArray() as Quat,
    },
  });
  await expect.poll(async () => (await round(xr))?.found).toBe(true);
  expect((await round(xr))?.match).toBeGreaterThanOrEqual(90);
  await page.evaluate(() => window.__goghPortal?.('gallery'));
  await settled(xr, 'gallery');
  expect(await round(xr)).toBeNull();
});
