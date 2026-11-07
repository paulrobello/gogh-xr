/**
 * The grabbable settings panel in XR (P5.3): right A opens it (the second open gesture, beside the
 * unverified menu button), a grip on the vignette slider changes nothing, the trigger sets it, the
 * vignette follows on the next smooth move, and the value survives a reload. Grip + the right stick
 * pitches the held panel and neither aims a teleport nor turns the rig. The trigger that presses
 * Recenter never reaches `select`, a close mid-grip saves the pose, and a closed panel draws
 * nothing. These run in the bare scene (`?scene=bare`), which keeps them fast: no world build. One
 * more opens and operates the panel in the gallery, the default boot, where Return to gallery stays
 * disabled until P5.5 registers its callback.
 *
 * `P53_SHOT=1` also writes the XR shot to docs/shots/p53-panel.jpg.
 */
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { Quaternion, Vector3 } from 'three';
import { CONTROL_Z } from '../../src/ui/panel-core.ts';
import { controlLayout } from '../../src/ui/panel-layout.ts';
import { DEFAULT_OFFSET } from '../../src/ui/panel-pose.ts';
import { expect, type Quat, test, type Vec3, type Xr } from './fixtures';

const KEY = 'gogh-xr.settings.v1';
const POSE_KEY = 'gogh-xr.panel.v1';

interface PanelDiag {
  built: boolean;
  open: boolean;
  surface: string | null;
  pose: { position: Vec3; quaternion: Quat } | null;
  scale: number | null;
  hover: { left: string | null; right: string | null } | null;
  typeset: boolean;
  locked: Record<string, string>;
}

interface SettingsDiag {
  stored: Record<string, unknown>;
  effective: Record<string, unknown>;
  saves: number;
}

async function panel(xr: Xr): Promise<PanelDiag> {
  return (await xr.diag()).panel as PanelDiag;
}

async function settings(xr: Xr): Promise<SettingsDiag> {
  return (await xr.diag()).settings as SettingsDiag;
}

/** A control's centre on the panel's control plane, rig-local (the rig sits at the origin here). */
function controlPoint(p: PanelDiag, id: string, fraction = 0.5): Vector3 {
  const layout = controlLayout(id);
  if (!layout || !p.pose || p.scale === null) throw new Error(`no ${id} or no pose`);
  const x = layout.rect.x - layout.rect.w / 2 + layout.rect.w * fraction;
  return new Vector3(x, layout.rect.y, CONTROL_Z)
    .multiplyScalar(p.scale)
    .applyQuaternion(new Quaternion(...p.pose.quaternion))
    .add(new Vector3(...p.pose.position));
}

/** Points the right controller from `from` at `target`. */
async function aim(xr: Xr, from: Vector3, target: Vector3): Promise<void> {
  const dir = target.clone().sub(from).normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir);
  await xr.setPose({
    right: { position: from.toArray() as Vec3, quaternion: q.toArray() as Quat },
  });
}

function setButton(page: Page, button: string, value: number): Promise<void> {
  return page.evaluate(
    ([b, v]) => window.__goghIwer?.controllers.right?.updateButtonValue(b as string, v as number),
    [button, value] as const,
  );
}

test('right A opens the panel; grip on a slider changes nothing; the trigger sets the vignette, which applies and persists', async ({
  page,
  xr,
}) => {
  test.setTimeout(120_000);
  await xr.boot('noanim&shot&scene=bare');
  expect(await panel(xr)).toMatchObject({ built: false, open: false });
  await xr.enterXR();
  // Start with the right controller pointing away, so nothing is hovered at open.
  await aim(xr, new Vector3(0.2, 1.3, -0.3), new Vector3(2, 1.3, 0));
  const closedCalls = ((await xr.diag()).draw as { calls: number }).calls;

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
  const opened = await panel(xr);
  expect(opened.surface).toBe('xr');
  expect(opened.scale).toBe(1);
  const before = (await settings(xr)).effective.vignette;
  expect(before).toBe(0.6);

  // Laser onto the vignette slider's centre (its value 0.5).
  const target = controlPoint(opened, 'vignette', 0.5);
  const from = target.clone().add(new Vector3(0.06, -0.12, 0.38));
  await aim(xr, from, target);
  await expect.poll(async () => (await panel(xr)).hover?.right).toBe('vignette');

  // Grip on the slider grabs the panel and never sets the value.
  await xr.press('right', 'squeeze');
  await xr.waitFrames(3);
  expect((await settings(xr)).effective.vignette).toBe(0.6);
  const afterGrip = await panel(xr);
  for (const [i, v] of (afterGrip.pose?.position ?? []).entries()) {
    expect(v).toBeCloseTo(opened.pose?.position[i] ?? Number.NaN, 6);
  }

  // The trigger operates it. While the panel holds the trigger, the action frame selects nothing.
  await setButton(page, 'trigger', 1);
  await xr.waitFrames(3);
  const held = (await xr.diag()).input?.actions;
  expect(held?.select.down).toBe(false);
  expect((await settings(xr)).effective.vignette).toBe(0.5);
  const drawCalls = ((await xr.diag()).draw as { calls: number }).calls;
  await setButton(page, 'trigger', 0);
  await xr.waitFrames(3);
  // Release commits the save at once.
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), KEY))
    .toContain('"vignette":0.5');
  console.log(
    `[e2e] panel draw calls in XR: ${drawCalls} open, ${closedCalls} closed (+${drawCalls - closedCalls}, two views)`,
  );

  // Hover help shows after 700 ms on the slider.
  await page.waitForTimeout(900);
  await xr.waitFrames(3);
  expect((await xr.diag()).panel).toMatchObject({ tooltip: 'vignette' });
  const tooltipCalls = ((await xr.diag()).draw as { calls: number }).calls;
  console.log(`[e2e] panel draw calls in XR with hover help: ${tooltipCalls}`);
  if (process.env.P53_SHOT) {
    const url = await page.evaluate(() => window.__goghShot?.() ?? '');
    const png = Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64');
    await sharp(png).jpeg({ quality: 88 }).toFile('docs/shots/p53-panel.jpg');
  }

  // Grip + right stick pitches the held panel and leaves the rig alone: no teleport aim, no turn.
  const beforeTurn = await panel(xr);
  const rigBefore = (await xr.diag()).rig as { yaw: number };
  await setButton(page, 'squeeze', 1);
  await xr.waitFrames(3);
  await xr.stick('right', 0, -1);
  await xr.waitFrames(10);
  const rigHeld = (await xr.diag()).rig as { yaw: number; aim: { active: boolean } };
  expect(rigHeld.aim.active).toBe(false);
  expect(rigHeld.yaw).toBe(rigBefore.yaw);
  const turned = await panel(xr);
  const q0 = new Quaternion(...(beforeTurn.pose?.quaternion ?? [0, 0, 0, 1]));
  const q1 = new Quaternion(...(turned.pose?.quaternion ?? [0, 0, 0, 1]));
  expect(q1.angleTo(q0)).toBeGreaterThan(0.05);
  expect(turned.scale).toBe(1);
  await xr.stick('right', 0, 0);
  await setButton(page, 'squeeze', 0);
  await xr.waitFrames(3);
  expect(((await xr.diag()).rig as { aim: { active: boolean } }).aim.active).toBe(false);
  // Letting go saves the pose.
  expect(await page.evaluate((k) => localStorage.getItem(k), POSE_KEY)).not.toBeNull();

  // The trigger that presses Recenter stays out of `select` while it is held.
  const recenterAt = controlPoint(await panel(xr), 'recenter');
  await aim(xr, recenterAt.clone().add(new Vector3(0.04, -0.1, 0.35)), recenterAt);
  await expect.poll(async () => (await panel(xr)).hover?.right).toBe('recenter');
  await setButton(page, 'trigger', 1);
  await xr.waitFrames(4);
  expect((await xr.diag()).input?.actions?.select.down).toBe(false);
  expect(await page.evaluate((k) => localStorage.getItem(k), POSE_KEY)).toBeNull();
  await setButton(page, 'trigger', 0);
  await xr.waitFrames(3);

  // Close it while gripping: the pose still saves. Hidden, it costs no draw.
  const grabAt = controlPoint(await panel(xr), 'vignette', 0.5);
  await aim(xr, grabAt.clone().add(new Vector3(0.06, -0.12, 0.38)), grabAt);
  await expect.poll(async () => (await panel(xr)).hover?.right).toBe('vignette');
  await setButton(page, 'squeeze', 1);
  await xr.waitFrames(3);
  expect((await xr.diag()).panel).toMatchObject({ grabbing: true });
  await xr.press('right', 'a-button');
  await expect.poll(async () => (await panel(xr)).open).toBe(false);
  expect(await page.evaluate((k) => localStorage.getItem(k), POSE_KEY)).not.toBeNull();
  await setButton(page, 'squeeze', 0);
  await xr.waitFrames(3);
  expect(((await xr.diag()).draw as { calls: number }).calls).toBe(closedCalls);

  // Then move: the vignette settles at 0.5 at full stick.
  await xr.stick('left', 0, -1);
  await expect
    .poll(async () => ((await xr.diag()).rig as { vignette: number }).vignette, { timeout: 15_000 })
    .toBeCloseTo(0.5, 3);
  await xr.stick('left', 0, 0);

  // Reload: the stored value comes back.
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(window.__goghDiag))).toBe(true);
  const reloaded = await settings(xr);
  expect(reloaded.stored.vignette).toBe(0.5);
  expect(reloaded.effective.vignette).toBe(0.5);
});

test('ending the XR session with the panel open saves its moved pose', async ({ page, xr }) => {
  test.setTimeout(120_000);
  await xr.boot('noanim&scene=bare');
  await xr.enterXR();
  await aim(xr, new Vector3(0.2, 1.3, -0.3), new Vector3(2, 1.3, 0));
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
  const opened = await panel(xr);

  // Grab it by the vignette slider and hold the grip.
  const grabAt = controlPoint(opened, 'vignette', 0.5);
  const from = grabAt.clone().add(new Vector3(0.06, -0.12, 0.38));
  await aim(xr, from, grabAt);
  await expect.poll(async () => (await panel(xr)).hover?.right).toBe('vignette');
  await setButton(page, 'squeeze', 1);
  await xr.waitFrames(3);
  expect((await xr.diag()).panel).toMatchObject({ grabbing: true });

  // Carry the controller sideways and up. The panel follows it, off the default spawn.
  const shift = new Vector3(0.3, 0.15, 0);
  await aim(xr, from.clone().add(shift), grabAt.clone().add(shift));
  await xr.waitFrames(5);
  const moved = await panel(xr);
  const travelled = new Vector3(...(moved.pose?.position ?? [0, 0, 0])).distanceTo(
    new Vector3(...(opened.pose?.position ?? [0, 0, 0])),
  );
  expect(travelled).toBeGreaterThan(0.1);
  // Nothing has released yet, so nothing has saved.
  expect(await page.evaluate((k) => localStorage.getItem(k), POSE_KEY)).toBeNull();

  // Release saves the pose. Clear that save, leaving the panel open and not held, so a close
  // saves nothing by itself (close() saves only mid-grab) and only the XR exit save can set the key.
  await setButton(page, 'squeeze', 0);
  await xr.waitFrames(3);
  expect((await xr.diag()).panel).toMatchObject({ open: true, grabbing: false });
  expect(await page.evaluate((k) => localStorage.getItem(k), POSE_KEY)).not.toBeNull();
  await page.evaluate((k) => localStorage.removeItem(k), POSE_KEY);

  // End the session with the panel open.
  await page.evaluate(() => window.__goghIwer?.activeSession?.end());
  await expect.poll(async () => (await xr.diag()).xr.presenting).toBe(false);
  const raw = await page.evaluate((k) => localStorage.getItem(k), POSE_KEY);
  expect(raw).not.toBeNull();
  const stored = JSON.parse(raw ?? '{}') as { offset: Vec3; version: number };
  expect(stored.version).toBe(1);
  // The saved offset is the moved pose, not the default spawn.
  const offset = new Vector3(...stored.offset);
  expect(offset.distanceTo(new Vector3(...DEFAULT_OFFSET))).toBeGreaterThan(0.1);
});

test("in a stroke scene the panel's strokes reuse the batch's program", async ({ xr }) => {
  test.setTimeout(120_000);
  /** Programs the first open adds in XR, laser off the panel. */
  async function openedPrograms(query: string, ready: string | null): Promise<number> {
    await xr.boot(query);
    if (ready) {
      await expect
        .poll(async () => Boolean((await xr.diag())[ready]), { timeout: 60_000 })
        .toBe(true);
    }
    await xr.enterXR();
    await aim(xr, new Vector3(0.2, 1.3, -0.3), new Vector3(2, 1.3, 0));
    await xr.waitFrames(5);
    const before = ((await xr.diag()).renderer as { programs: number }).programs;
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
    await xr.waitFrames(5);
    return ((await xr.diag()).renderer as { programs: number }).programs - before;
  }
  const bare = await openedPrograms('noanim&scene=bare', null);
  const strokes = await openedPrograms('noanim&strokesTest', 'strokes');
  console.log(`[e2e] programs the panel adds: ${bare} in the bare scene, ${strokes} with a batch`);
  // The bare scene compiles the stroke program for the panel; a stroke scene already has it.
  expect(strokes).toBe(bare - 1);
});

test('M opens the desktop DOM panel, which releases pointer lock and writes the same store', async ({
  page,
  xr,
}) => {
  await xr.boot('noanim&turn=smooth&scene=bare');
  await page.keyboard.press('m');
  const dom = page.locator('#gogh-settings');
  await expect(dom).toBeVisible();
  expect(await panel(xr)).toMatchObject({ open: true, surface: 'dom', built: false });
  // ?turn locks the turn mode: shown, disabled, and the help names the flag.
  const turn = dom.locator('[data-control="turnMode"]');
  await expect(turn).toHaveAttribute('title', 'Set by ?turn=smooth for this session');
  await expect(turn.locator('button').first()).toBeDisabled();
  // The gallery button waits for the portal.
  await expect(dom.locator('button[data-control="gallery"]')).toBeDisabled();
  await dom.locator('[data-control="snapAngleDeg"] button', { hasText: '45°' }).click();
  await expect.poll(async () => (await settings(xr)).effective.snapAngleDeg).toBe(45);
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), KEY))
    .toContain('"snapAngleDeg":45');
  // The locked flag value is never written back.
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toContain('"turnMode":"snap"');
  await page.keyboard.press('m');
  await expect(dom).toBeHidden();
});

test('in the gallery the panel opens and operates, and Return to gallery does nothing yet', async ({
  page,
  xr,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await xr.boot('noanim&nogov');
  await expect
    .poll(
      async () => {
        const world = (await xr.diag()).world as
          | { painting: string; strokes?: unknown }
          | undefined;
        return world?.painting === 'gallery' && world.strokes !== undefined;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await xr.enterXR();
  await aim(xr, new Vector3(0.2, 1.3, -0.3), new Vector3(2, 1.3, 0));
  await xr.waitFrames(5);
  const closedCalls = ((await xr.diag()).draw as { calls: number }).calls;

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
  expect((await panel(xr)).surface).toBe('xr');

  // The trigger on Smooth sets the turn mode, as in the bare scene.
  const smooth = controlPoint(await panel(xr), 'turnMode', 0.75);
  await aim(xr, smooth.clone().add(new Vector3(0.06, -0.12, 0.38)), smooth);
  await expect.poll(async () => (await panel(xr)).hover?.right).toBe('turnMode');
  await setButton(page, 'trigger', 1);
  await xr.waitFrames(3);
  await setButton(page, 'trigger', 0);
  await xr.waitFrames(3);
  expect((await settings(xr)).effective.turnMode).toBe('smooth');

  // Return to gallery has no callback until P5.5: its trigger leaves the panel open in the gallery.
  const back = controlPoint(await panel(xr), 'gallery');
  await aim(xr, back.clone().add(new Vector3(-0.04, -0.1, 0.35)), back);
  await expect.poll(async () => (await panel(xr)).hover?.right).toBe('gallery');
  await setButton(page, 'trigger', 1);
  await xr.waitFrames(3);
  expect((await xr.diag()).input?.actions?.select.down).toBe(false);
  await setButton(page, 'trigger', 0);
  await xr.waitFrames(3);
  expect((await panel(xr)).open).toBe(true);
  expect(((await xr.diag()).world as { painting: string }).painting).toBe('gallery');

  // Closed, it draws nothing again.
  await aim(xr, new Vector3(0.2, 1.3, -0.3), new Vector3(2, 1.3, 0));
  await xr.press('right', 'a-button');
  await expect.poll(async () => (await panel(xr)).open).toBe(false);
  await xr.waitFrames(5);
  expect(((await xr.diag()).draw as { calls: number }).calls).toBe(closedCalls);
  expect(errors).toEqual([]);
});
