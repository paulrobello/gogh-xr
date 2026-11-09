/**
 * The portal (P5.5): walking into Starry Night's frame on the desktop enters its world, Return to
 * gallery (G) comes back, and a gallery-to-world-to-gallery round trip leaves the GPU's geometry
 * and texture counts and the draw calls where they started, on the desktop and under IWER. No
 * frame of an entry or a return takes longer than 27.8 ms (2 × the 72 Hz budget). The frames are
 * logged for docs/verification.md.
 */
import type { Page } from '@playwright/test';
import { expect, glErrors, test, type Xr } from './fixtures';
import { type PortalDiag, portal, settled } from './helpers';

interface Memory {
  geometries: number;
  textures: number;
  /** Draw calls of the last frame, at the last look. */
  calls: number;
}

/** The brief's bar: no transition frame over 2 × the 72 Hz budget, ms. */
const FRAME_BAR_MS = 27.8;

/** What docs/verification.md reads from each transition. */
const summary = (p: PortalDiag) => {
  const at = p.frames.reduce(
    (best, f, i, all) => (f.intervalMs > all[best].intervalMs ? i : best),
    0,
  );
  return {
    longestFrameMs: p.longestFrameMs,
    longestWorkMs: p.longestWorkMs,
    longestWorkPhase: p.longestWorkPhase,
    longestStep: p.longestStep,
    longestStepMs: p.longestStepMs,
    stepsMs: p.stepsMs,
    durationMs: p.durationMs,
    // The longest interval ends at frame `at`, so the frame before it did the work that delayed it.
    longestInterval: p.frames.slice(Math.max(0, at - 1), at + 1),
  };
};

/** No frame of the transition `p` over the bar, and nothing of it left running. */
function expectWithinBar(p: PortalDiag, label: string): void {
  expect(p.longestFrameMs, `${label} longest frame`).not.toBeNull();
  expect(
    p.longestFrameMs ?? Number.POSITIVE_INFINITY,
    `${label} longest frame`,
  ).toBeLessThanOrEqual(FRAME_BAR_MS);
  expect(p.flying, `${label} fly strokes`).toBe(false);
}

/**
 * Draws the veil for a few frames, so the vignette sphere's one geometry uploads before the
 * baseline: a round trip must then leave the counts exactly where they were.
 */
async function warmVeil(page: Page, xr: Xr): Promise<void> {
  await page.evaluate(() => window.__goghVeil?.(1));
  await xr.waitFrames(3);
  await page.evaluate(() => window.__goghVeil?.(0));
  await xr.waitFrames(3);
}

const LOOKS: readonly [number, number][] = [0, Math.PI / 2, Math.PI, -Math.PI / 2].flatMap((yaw) =>
  [0, -1, 1].map((pitch) => [yaw, pitch] as [number, number]),
);

/** Looks round the gallery so every scan and chunk has drawn, then reads the GPU counts. */
async function galleryMemory(page: Page, xr: Xr): Promise<Memory> {
  for (const [yaw, pitch] of LOOKS) {
    await page.evaluate(([h, p]) => window.__goghPose?.(0, 1.6, 1, h, p), [yaw, pitch] as const);
    await xr.waitFrames(3);
  }
  return memory(xr);
}

async function memory(xr: Xr): Promise<Memory> {
  const d = await xr.diag();
  const r = d.renderer as unknown as { geometries: number; textures: number };
  const draw = d.draw as { calls: number };
  return { geometries: r.geometries, textures: r.textures, calls: draw.calls };
}

/**
 * The same under IWER: the rig back at the origin facing -Z, as at boot, and the headset turns its
 * head round the room.
 */
async function xrMemory(page: Page, xr: Xr): Promise<Memory> {
  await page.evaluate(() => window.__goghPose?.(0, 1.6, 0, 0, 0));
  for (const [yaw, pitch] of LOOKS) {
    const sy = Math.sin(yaw / 2);
    const cy = Math.cos(yaw / 2);
    const sp = Math.sin(pitch / 2);
    const cp = Math.cos(pitch / 2);
    await xr.setPose({
      head: { position: [0, 1.6, 0], quaternion: [cy * sp, sy * cp, -sy * sp, cy * cp] },
    });
    await xr.waitFrames(3);
  }
  return memory(xr);
}

async function roundTrip(page: Page, xr: Xr): Promise<{ enter: PortalDiag; back: PortalDiag }> {
  expect(await page.evaluate(() => window.__goghPortal?.('starry-night'))).toBe(true);
  await expect.poll(async () => (await portal(xr)).state).toBe('entering');
  // A second trigger during the transition is refused.
  expect(await page.evaluate(() => window.__goghPortal?.('starry-night'))).toBe(false);
  await settled(xr, 'starry-night');
  const enter = await portal(xr);
  await page.keyboard.press('KeyG');
  await expect.poll(async () => (await portal(xr)).state).toBe('returning');
  await settled(xr, 'gallery');
  const back = await portal(xr);
  return { enter, back };
}

test('walking into Starry Night enters its world; G returns to the gallery facing the frame', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await xr.boot('noanim');
  await settled(xr, 'gallery');
  // Stand 1.2 m from the frame, then walk forward into its threshold.
  await page.evaluate(() => window.__goghPose?.(0, 1.6, -2.6, 0, 0));
  await xr.waitFrames(3);
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await portal(xr)).state, { timeout: 10_000 }).toBe('entering');
  await page.keyboard.up('KeyW');
  expect((await portal(xr)).lastTrigger?.cause).toBe('walk');
  await settled(xr, 'starry-night');
  const rig = (await xr.diag()).rig as { position: number[]; yaw: number };
  expect(rig.position[0]).toBeCloseTo(0, 3);
  expect(rig.position[2]).toBeCloseTo(0, 3);
  await page.keyboard.press('KeyG');
  await settled(xr, 'gallery');
  const back = (await xr.diag()).rig as { position: number[]; yaw: number };
  // 1.2 m before the frame plane at z = -3.952, outside the 0.6 m threshold (to z = -3.352).
  expect(back.position[0]).toBeCloseTo(0, 3);
  expect(back.position[2]).toBeCloseTo(-2.752, 2);
  expect(back.yaw).toBeCloseTo(0, 3);
  // Standing at the return spot does not re-trigger.
  await xr.waitFrames(10);
  expect((await portal(xr)).state).toBe('idle');
  expect(await glErrors(page)).toEqual([]);
});

test('a round trip returns the GPU geometry and texture counts to the baseline (desktop)', async ({
  page,
  xr,
}) => {
  test.setTimeout(240_000);
  await xr.boot('noanim');
  await settled(xr, 'gallery');
  // The veil is the vignette's sphere, built at boot and first drawn by a transition: once it has
  // drawn, a round trip leaves the counts exactly at the baseline.
  await warmVeil(page, xr);
  const baseline = await galleryMemory(page, xr);
  const first = await roundTrip(page, xr);
  expect(await galleryMemory(page, xr)).toEqual(baseline);
  const second = await roundTrip(page, xr);
  expect(await galleryMemory(page, xr)).toEqual(baseline);
  console.log(
    'portal desktop',
    JSON.stringify({
      baseline,
      enter: [first.enter, second.enter].map(summary),
      back: [first.back, second.back].map(summary),
    }),
  );
  for (const [trip, { enter, back }] of [first, second].entries()) {
    expectWithinBar(enter, `enter ${trip}`);
    expectWithinBar(back, `return ${trip}`);
  }
  expect(await glErrors(page)).toEqual([]);
});

test('a round trip returns the GPU geometry and texture counts to the baseline (IWER)', async ({
  page,
  xr,
}) => {
  test.setTimeout(240_000);
  await xr.boot('noanim&nogov');
  await settled(xr, 'gallery');
  await xr.enterXR();
  await xr.waitFrames(10);
  await warmVeil(page, xr);
  const baseline = await xrMemory(page, xr);
  const trips: { enter: PortalDiag; back: PortalDiag }[] = [];
  for (let trip = 0; trip < 2; trip++) {
    expect(await page.evaluate(() => window.__goghPortal?.('starry-night'))).toBe(true);
    await settled(xr, 'starry-night');
    const enter = await portal(xr);
    console.log(`portal iwer enter ${trip}`, JSON.stringify(summary(enter)));
    expect(await page.evaluate(() => window.__goghPortal?.('gallery'))).toBe(true);
    await settled(xr, 'gallery');
    const back = await portal(xr);
    console.log(`portal iwer return ${trip}`, JSON.stringify(summary(back)));
    trips.push({ enter, back });
    expect(await xrMemory(page, xr)).toEqual(baseline);
  }
  console.log('portal iwer memory', JSON.stringify(baseline));
  for (const [trip, { enter, back }] of trips.entries()) {
    expectWithinBar(enter, `iwer enter ${trip}`);
    expectWithinBar(back, `iwer return ${trip}`);
  }
  expect(await glErrors(page)).toEqual([]);
});
