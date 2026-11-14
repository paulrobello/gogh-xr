import type { Page } from '@playwright/test';
import { Vector3 } from 'three';
import { livePortals, returnPose } from '../../src/portal/portal';
import { controlHidden, setControlHidden } from '../../src/ui/panel-layout';
import { expect, glErrors, test, type Xr } from './fixtures';
import { aim, controlPoint, panel, portal, setButton, settled } from './helpers';

const CAFE = 'cafe-terrace-at-night';
const frame = livePortals().find((candidate) => candidate.id === CAFE);
if (!frame) throw new Error('The café frame has no portal');
const outside = returnPose(frame);

async function faceFrame(page: Page, xr: Xr): Promise<void> {
  const [x, , z] = outside.position;
  await page.evaluate(
    ([px, pz, yaw]) => window.__goghPose?.(px, 1.6, pz, yaw, 0),
    [x, z, outside.yaw],
  );
  await xr.waitFrames(3);
}

async function walk(
  start: () => Promise<void>,
  stop: () => Promise<void>,
  until: () => Promise<boolean>,
): Promise<void> {
  await start();
  try {
    await expect.poll(until, { timeout: 15_000 }).toBe(true);
  } finally {
    await stop();
  }
}

test('desktop walks through the café frame twice and returns to the gallery', async ({
  page,
  xr,
}) => {
  test.setTimeout(120_000);
  await xr.boot('nogov');
  await settled(xr, 'gallery');
  await faceFrame(page, xr);
  const start = () => page.keyboard.down('KeyW');
  const stop = () => page.keyboard.up('KeyW');

  for (let visit = 0; visit < 2; visit++) {
    await walk(start, stop, async () => (await portal(xr)).lastTrigger?.id === CAFE);
    await expect.poll(async () => (await portal(xr)).flying).toBe(true);
    await settled(xr, CAFE);
    const entry = await portal(xr);
    expect(entry.lastTrigger).toMatchObject({ id: CAFE, cause: 'walk' });
    expect(entry.frames.some((frame) => frame.phase === 'out')).toBe(true);
    const z = (await xr.diag()).camera.position[2];
    await walk(start, stop, async () => (await xr.diag()).camera.position[2] < z - 1);
    await page.keyboard.press('KeyG');
    await settled(xr, 'gallery');
    expect((await portal(xr)).lastTrigger).toMatchObject({ id: 'gallery', cause: 'return' });
    const [x, , returnZ] = (await xr.diag()).camera.position;
    expect(x).toBeCloseTo(outside.position[0]);
    expect(returnZ).toBeCloseTo(outside.position[2]);
  }
  expect(await glErrors(page)).toEqual([]);
});

test('immersive WebXR walks into the café, explores, and returns with the settings laser', async ({
  page,
  xr,
}) => {
  test.setTimeout(120_000);
  await xr.boot('noanim&nogov');
  await settled(xr, 'gallery');
  await faceFrame(page, xr);
  await xr.enterXR();
  const start = () => xr.stick('left', 0, -1);
  const stop = () => xr.stick('left', 0, 0);
  await walk(start, stop, async () => (await portal(xr)).lastTrigger?.id === CAFE);
  await settled(xr, CAFE);
  expect((await xr.diag()).xr.presenting).toBe(true);
  const z = (await xr.diag()).camera.position[2];
  await walk(start, stop, async () => (await xr.diag()).camera.position[2] < z - 1);

  await xr.press('left', 'thumbrest');
  await expect.poll(async () => (await panel(xr)).typeset).toBe(true);
  const wasHidden = controlHidden('gallery');
  setControlHidden('gallery', false);
  try {
    const back = controlPoint(await panel(xr), 'gallery');
    await aim(xr, back.clone().add(new Vector3(-0.04, -0.1, 0.35)), back);
    await expect.poll(async () => (await panel(xr)).hover?.right).toBe('gallery');
    await setButton(page, 'trigger', 1);
    await xr.waitFrames(3);
    await setButton(page, 'trigger', 0);
  } finally {
    setControlHidden('gallery', wasHidden);
  }
  await settled(xr, 'gallery');
  expect((await portal(xr)).lastTrigger).toMatchObject({ id: 'gallery', cause: 'return' });
  expect((await xr.diag()).xr.presenting).toBe(true);
  expect(await glErrors(page)).toEqual([]);
});

test('the painter URL boots the café with the portrait camera', async ({ page, xr }) => {
  await page.setViewportSize({ width: 655, height: 810 });
  await xr.boot(`painting=${CAFE}&painter&shot&noanim`);
  await settled(xr, CAFE);
  expect((await xr.diag()).world).toMatchObject({ painting: CAFE, strokes: { total: 2400 } });
  const position = (await xr.diag()).camera.position;
  expect(position[1]).toBeCloseTo(1.6);
  const capture = async (name: string): Promise<void> => {
    await xr.waitFrames(3);
    const shot = await page.evaluate(() => window.__goghShot?.() ?? '');
    expect(shot).toMatch(/^data:image\/png;base64,/);
    await test.info().attach(name, {
      body: Buffer.from(shot.split(',')[1], 'base64'),
      contentType: 'image/png',
    });
  };
  await capture('painter-view');
  await page.evaluate(() => window.__goghPose?.(1.35, 1.6, -3.1, 1.2, 0.25));
  await capture('street-side');
  await page.evaluate(() => window.__goghPose?.(-0.84, 1.6, -2.4, 1.04, 0.62));
  await capture('under-awning');
  expect(await glErrors(page)).toEqual([]);
});
