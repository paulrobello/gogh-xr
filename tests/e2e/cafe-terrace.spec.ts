import type { Page } from '@playwright/test';
import { Vector3 } from 'three';
import {
  CAFE_CAPTURE_SIZE,
  CAFE_DELTA_E_THRESHOLD,
  CAFE_SSIM_THRESHOLD,
  cafeFidelity,
} from '../../scripts/cafe/fidelity-lib.ts';
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

test("the painter URL frames the scan, and the paint holds off the painter's spot", async ({
  page,
  xr,
}) => {
  await page.setViewportSize(CAFE_CAPTURE_SIZE);
  await xr.boot(`painting=${CAFE}&painter&shot&noanim&nogov`);
  await settled(xr, CAFE);
  expect((await xr.diag()).world).toMatchObject({
    painting: CAFE,
    counts: { tables: 10, people: 13 },
    strokes: { total: 2400 },
  });
  const position = (await xr.diag()).camera.position;
  expect(position[1]).toBeCloseTo(1.6);
  const capture = async (name: string): Promise<Buffer> => {
    await xr.waitFrames(3);
    const shot = await page.evaluate(() => window.__goghShot?.() ?? '');
    expect(shot).toMatch(/^data:image\/png;base64,/);
    const body = Buffer.from(shot.split(',')[1], 'base64');
    await test.info().attach(name, { body, contentType: 'image/png' });
    return body;
  };
  const painter = await cafeFidelity(await capture('painter-view'));
  console.log(
    `[e2e] café fidelity SSIM ${painter.ssim.toFixed(4)} (≥ ${CAFE_SSIM_THRESHOLD}), mean ΔE2000 ${painter.meanDeltaE.toFixed(3)} (≤ ${CAFE_DELTA_E_THRESHOLD})`,
  );
  expect(painter.ssim).toBeGreaterThanOrEqual(CAFE_SSIM_THRESHOLD);
  expect(painter.meanDeltaE).toBeLessThanOrEqual(CAFE_DELTA_E_THRESHOLD);
  // The same metric from the street is far off the scan: it can tell a view that is not the canvas.
  await page.evaluate(() => window.__goghPose?.(2.6, 1.6, -9, 1.2, 0.1));
  const street = await cafeFidelity(await capture('street-side'));
  expect(street.ssim).toBeLessThan(0.5);
  await page.evaluate(() => window.__goghPose?.(-1, 1.6, -10, 0.3, 0.45));
  await capture('under-awning');
  expect(await glErrors(page)).toEqual([]);
});

test('café flight can rise above the rooftops within the street bounds', async ({ page, xr }) => {
  await xr.boot(`painting=${CAFE}&shot&noanim`);
  await settled(xr, CAFE);
  await page.evaluate(() => window.__goghPose?.(0.8, 9.8, -5.1, 0, 0));
  await xr.waitFrames(3);
  await walk(
    () => page.keyboard.down('KeyF'),
    () => page.keyboard.up('KeyF'),
    async () => ((await xr.diag()).rig as { mode: string }).mode === 'fly',
  );
  await walk(
    () => page.keyboard.down('Space'),
    () => page.keyboard.up('Space'),
    async () => (await xr.diag()).camera.position[1] > 11.5,
  );
  await page.evaluate(() => window.__goghPose?.(0.8, 16, -5.1, 0.15, -0.68));
  await xr.waitFrames(3);
  const shot = await page.evaluate(() => window.__goghShot?.() ?? '');
  expect(shot).toMatch(/^data:image\/png;base64,/);
  await test.info().attach('above-cafe', {
    body: Buffer.from(shot.split(',')[1], 'base64'),
    contentType: 'image/png',
  });
  expect(await glErrors(page)).toEqual([]);
});

test('café stars are visible all around the street and overhead', async ({ page, xr }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await xr.boot(`painting=${CAFE}&shot&noanim`);
  await settled(xr, CAFE);
  for (const [heading, yaw, pitch] of [
    ['north', 0, 0.58],
    ['west', Math.PI / 2, 0.58],
    ['south', Math.PI, 0.58],
    ['east', -Math.PI / 2, 0.58],
    ['overhead', 0, 1.54],
  ] as const) {
    await page.evaluate(([yaw, pitch]) => window.__goghPose?.(0, 16, -9, yaw, pitch), [yaw, pitch]);
    await xr.waitFrames(3);
    const stars = await page.evaluate(async () => {
      const shot = window.__goghShot?.();
      if (!shot) throw new Error('Missing canvas capture');
      const map = await createImageBitmap(await (await fetch(shot)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = map.width;
      canvas.height = map.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Missing capture canvas');
      ctx.drawImage(map, 0, 0);
      map.close();
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height / 2);
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 138 && data[i + 1] > 130 && data[i] > data[i + 2] + 20) count++;
      }
      return count;
    });
    expect(stars, heading).toBeGreaterThan(30);
    const shot = await page.evaluate(() => window.__goghShot?.() ?? '');
    await test.info().attach(`sky-${heading}`, {
      body: Buffer.from(shot.split(',')[1], 'base64'),
      contentType: 'image/png',
    });
  }
  expect(await glErrors(page)).toEqual([]);
});
