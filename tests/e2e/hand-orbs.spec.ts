/**
 * Hand orbs: a glow round each tracked hand in XR, toggled from the settings panel. IWER's Quest 3
 * renders two views without multiview, so each shown orb is one draw call per view.
 */
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { Vector3 } from 'three';
import { CAPTURE_SIZE } from '../../scripts/fidelity-io.ts';
import { expect, test, type Vec3, type Xr } from './fixtures';
import { aim, controlPoint, panel, SETTINGS_KEY, setButton, settings } from './helpers';

interface HandOrbsDiag {
  enabled: boolean;
  visible: [boolean, boolean];
  /** Metres to the nearest stroke a hand pushes, or null past its 0.13 m reach. */
  reach: [number | null, number | null];
  /** The eased boost, 0-1. */
  boost: [number, number];
}

/** IWER's stereo views: three draws each visible mesh once per view. */
const VIEWS = 2;

const orbs = async (xr: Xr): Promise<HandOrbsDiag> => (await xr.diag()).handOrbs as HandOrbsDiag;
const calls = async (xr: Xr): Promise<number> =>
  ((await xr.diag()).draw as { calls: number }).calls;

/** The right controller points away from the panel, low and to the right; the left hand sits ahead. */
async function restHands(xr: Xr): Promise<void> {
  await aim(xr, new Vector3(0.25, 1.25, -0.35), new Vector3(2, 1.25, 0));
  await xr.setPose({ left: { position: [-0.25, 1.3, -0.4] } });
  await xr.waitFrames(4);
}

/** Both hands at a typical reach, 0.48 m from the head, with the panel closed. */
async function reachHands(xr: Xr): Promise<void> {
  await xr.setPose({
    left: { position: [-0.2, 1.38, -0.38] },
    right: { position: [0.2, 1.38, -0.38] },
  });
  await xr.waitFrames(4);
}

/** The canvas keeps its drawing buffer (`?shot`): the last XR frame, as raw RGBA. */
async function canvasPixels(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() =>
    (document.querySelector('canvas') as HTMLCanvasElement).toDataURL('image/png'),
  );
  const png = Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64');
  return sharp(png).ensureAlpha().raw().toBuffer();
}

/** The share of pixels that differ between two frames of the same size. */
function changedShare(a: Buffer, b: Buffer): number {
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changed++;
  }
  return changed / (a.length / 4);
}

/** Opens the panel, pulls the trigger on the Hand orbs toggle, and closes the panel again. */
async function flipToggle(page: Page, xr: Xr): Promise<void> {
  await xr.press('right', 'a-button');
  await expect
    .poll(
      async () => {
        const p = await panel(xr);
        return p.open && p.typeset;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const target = controlPoint(await panel(xr), 'handOrbs');
  await aim(xr, target.clone().add(new Vector3(0.06, -0.12, 0.38)), target);
  await expect.poll(async () => (await panel(xr)).hover?.right).toBe('handOrbs');
  await setButton(page, 'trigger', 1);
  await xr.waitFrames(3);
  await setButton(page, 'trigger', 0);
  await xr.waitFrames(3);
  await restHands(xr);
  await xr.press('right', 'a-button');
  await expect.poll(async () => (await panel(xr)).open).toBe(false);
  await xr.waitFrames(4);
}

test('the Hand orbs toggle shows and hides one orb per hand in XR only, and persists', async ({
  page,
  xr,
}) => {
  test.setTimeout(120_000);
  await xr.boot('noanim&shot&scene=bare');
  // The first animation frame copies the default setting into the orbs.
  await expect.poll(() => orbs(xr)).toMatchObject({ enabled: true, visible: [false, false] });
  await xr.enterXR();
  await restHands(xr);
  expect(await orbs(xr)).toMatchObject({ enabled: true, visible: [true, true] });
  const shown = await calls(xr);

  await flipToggle(page, xr);
  expect((await settings(xr)).effective.handOrbs).toBe(false);
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), SETTINGS_KEY))
    .toContain('"handOrbs":false');
  expect(await orbs(xr)).toMatchObject({ enabled: false, visible: [false, false] });
  const hidden = await calls(xr);
  await reachHands(xr);
  const off = await canvasPixels(page);

  // This open happens with the hands at reach, where neither laser hovers a control.
  await flipToggle(page, xr);
  expect(await orbs(xr)).toMatchObject({ enabled: true, visible: [true, true] });
  const again = await calls(xr);
  await reachHands(xr);
  const on = await canvasPixels(page);
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), SETTINGS_KEY))
    .toContain('"handOrbs":true');
  console.log(`[e2e] hand orbs draw calls: ${shown} on, ${hidden} off, ${again} on again`);
  expect(again - hidden).toBe(2 * VIEWS);
  expect(shown - hidden).toBe(2 * VIEWS);
  // Each orb is a small ball: at 0.48 m it changed about 7% of the frame with the 0.14 m glow, and
  // the 0.08 m glow covers about a third of that area (2026-11-09, not measured yet).
  const perOrb = changedShare(on, off) / 2;
  console.log(`[e2e] hand orbs: ${(perOrb * 100).toFixed(2)}% of the frame per orb at 0.48 m`);
  expect(perOrb).toBeGreaterThan(0.002);
  expect(perOrb).toBeLessThan(0.05);
});

test('an untracked hand has no orb', async ({ page, xr }) => {
  await xr.boot('noanim&scene=bare');
  await xr.enterXR();
  await restHands(xr);
  expect(await orbs(xr)).toMatchObject({ enabled: true, visible: [true, true] });
  const both = await calls(xr);
  await page.evaluate(() => {
    const left = window.__goghIwer?.controllers.left;
    if (!left) throw new Error('no IWER left controller');
    left.connected = false;
  });
  await xr.waitFrames(6);
  expect(await orbs(xr)).toMatchObject({ enabled: true, visible: [false, true] });
  expect(both - (await calls(xr))).toBe(VIEWS);
});

test('an orb brightens at the paint and stays at rest 1.5 m over the meadow (seed 1)', async ({
  page,
  xr,
}) => {
  test.setTimeout(240_000);
  await xr.boot('painting=starry-night&seed=1&nogov');
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 120_000 })
    .toBe(true);
  await xr.enterXR();
  // The rig stands on the painter's spot, where the seed-1 ground is flat at y = 0: the right hand
  // 5 cm over the grass, the left one 1.5 m over it.
  await xr.setPose({
    head: { position: [0, 1.6, 0], quaternion: [0, 0, 0, 1] },
    left: { position: [-0.2, 1.5, -0.4] },
    right: { position: [0.2, 0.05, -0.4] },
  });
  await page.waitForTimeout(1000);
  await xr.waitFrames(6);
  const o = await orbs(xr);
  console.log(`[e2e] hand orbs reach ${JSON.stringify(o.reach)}, boost ${JSON.stringify(o.boost)}`);
  expect(o.visible).toEqual([true, true]);
  expect(o.reach[0]).toBeNull();
  expect(o.boost[0]).toBe(0);
  expect(o.reach[1]).not.toBeNull();
  expect(o.reach[1] as number).toBeLessThan(0.13);
  expect(o.boost[1]).toBeGreaterThan(0.4);
  const world = (await xr.diag()).world as { reach: { strokes: number } };
  expect(world.reach.strokes).toBeGreaterThan(300_000);
});

async function shot(page: Page, file: string): Promise<void> {
  const url = await page.evaluate(() => window.__goghShot?.() ?? '');
  const png = Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64');
  await sharp(png).png().toFile(file);
}

test.describe('the look', () => {
  test.use({ viewport: CAPTURE_SIZE });

  test('hands at reach glow over the cypress strokes and sit behind the open panel (docs/shots)', async ({
    page,
    xr,
  }) => {
    test.setTimeout(240_000);
    await xr.boot('painting=starry-night&seed=1&shot&nogov');
    await expect
      .poll(async () => (await xr.diag()).world !== undefined, { timeout: 120_000 })
      .toBe(true);
    await xr.enterXR();
    // The eye 1.0 m out from the main cypress's hull at its axis ring 9, facing the axis
    // (reactive.spec.ts derives these from the seed-1 cypress).
    const axis: Vec3 = [-3.36, -1.55, -9.35];
    const out: Vec3 = [0.338, 0, 0.941];
    const r = 1.29 + 1.0;
    const eye: Vec3 = [axis[0] + r * out[0], axis[1], axis[2] + r * out[2]];
    const yaw = Math.atan2(out[0], out[2]);
    await page.evaluate(([x, y, z, w]) => window.__goghPose?.(x, y, z, w, 0), [
      ...eye,
      yaw,
    ] as const);
    await xr.setPose({
      head: { position: [0, 1.6, 0], quaternion: [0, 0, 0, 1] },
      left: { position: [-0.16, 1.44, -0.42] },
      right: { position: [0.2, 1.36, -0.42] },
    });
    await page.waitForTimeout(1500);
    await xr.waitFrames(6);
    expect(await orbs(xr)).toMatchObject({ enabled: true, visible: [true, true] });
    await shot(page, 'docs/shots/hand-orbs.png');

    // The panel open in front: the left hand ahead of it glows over it, the right one behind it is
    // hidden by its backing (depth test).
    await xr.press('right', 'a-button');
    await expect
      .poll(
        async () => {
          const p = await panel(xr);
          return p.open && p.typeset;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await xr.setPose({
      left: { position: [-0.14, 1.4, -0.5] },
      right: { position: [0.12, 1.44, -0.9] },
    });
    await page.waitForTimeout(500);
    await xr.waitFrames(6);
    expect(await orbs(xr)).toMatchObject({ enabled: true, visible: [true, true] });
    await shot(page, 'docs/shots/hand-orbs-panel.png');
  });
});
