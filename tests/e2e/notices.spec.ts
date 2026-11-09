/**
 * HUD notices (P5.6) in IWER. A corrupt stored settings blob and a rejected XR entry raise their
 * notices through the real paths, and `__goghNotice` raises the 72 Hz fallback and the update
 * reload. In XR each notice shows on the HUD's notice stack, dedupes by kind and dismisses with a
 * trigger on its Dismiss button. With the settings panel open, a ray that meets the panel owns the
 * trigger even through a Dismiss button, and the panel's slider still takes the trigger with a
 * notice up. These run in the bare scene (`?scene=bare`).
 */
import type { Page } from '@playwright/test';
import { Quaternion, Vector3 } from 'three';
import { CONTROL_Z } from '../../src/ui/panel-core.ts';
import {
  controlLayout,
  controlRect,
  PANEL_H,
  setControlHidden,
} from '../../src/ui/panel-layout.ts';
import { expect, glErrors, type Quat, test, type Vec3, type Xr } from './fixtures';

const KEY = 'gogh-xr.settings.v1';
const RATE_TEXT = 'Frame rate lowered to 72 Hz to keep motion smooth.';

interface Notice {
  kind: string;
  text: string;
}

interface NoticesDiag {
  queue: Notice[];
  shown: Notice[];
  view: {
    visible: boolean;
    elevationDeg: number;
    typeset: boolean;
    targets: { kind: string; center: Vec3; hovered: boolean }[];
  } | null;
}

interface PanelDiag {
  open: boolean;
  typeset: boolean;
  pose: { position: Vec3; quaternion: Quat } | null;
  scale: number | null;
  hover: { left: string | null; right: string | null } | null;
}

// The bare scene registers no gallery return, so the page hides that button.
setControlHidden('gallery', true);

async function notices(xr: Xr): Promise<NoticesDiag> {
  return (await xr.diag()).notices as NoticesDiag;
}

async function kinds(xr: Xr): Promise<string[]> {
  return (await notices(xr)).queue.map((n) => n.kind);
}

async function panel(xr: Xr): Promise<PanelDiag> {
  return (await xr.diag()).panel as PanelDiag;
}

/** Points the right controller from `from` at `target`. */
async function aim(xr: Xr, from: Vector3, target: Vector3): Promise<void> {
  const dir = target.clone().sub(from).normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir);
  await xr.setPose({
    right: { position: from.toArray() as Vec3, quaternion: q.toArray() as Quat },
  });
}

function setTrigger(page: Page, value: number): Promise<void> {
  return page.evaluate(
    (v) => window.__goghIwer?.controllers.right?.updateButtonValue('trigger', v),
    value,
  );
}

async function target(xr: Xr, kind: string): Promise<Vector3> {
  const t = (await notices(xr)).view?.targets.find((x) => x.kind === kind);
  if (!t) throw new Error(`no ${kind} dismiss target`);
  return new Vector3(...t.center);
}

async function hovered(xr: Xr, kind: string): Promise<boolean> {
  return Boolean((await notices(xr)).view?.targets.find((x) => x.kind === kind)?.hovered);
}

/** Aims from below at `kind`'s Dismiss button, a ray that never meets the panel spawn. */
async function aimAtButton(xr: Xr, kind: string): Promise<void> {
  const at = await target(xr, kind);
  await aim(xr, at.clone().add(new Vector3(0, -0.3, 0.25)), at);
  await expect.poll(() => hovered(xr, kind)).toBe(true);
}

async function aimAway(xr: Xr): Promise<void> {
  await aim(xr, new Vector3(0.2, 1.3, -0.3), new Vector3(2, 1.3, 0));
}

/** A point on the open panel, panel-local metres at scale 1, in world space (rig at origin). */
function panelPoint(p: PanelDiag, x: number, y: number, z = 0): Vector3 {
  if (!p.pose || p.scale === null) throw new Error('no panel pose');
  return new Vector3(x, y, z)
    .multiplyScalar(p.scale)
    .applyQuaternion(new Quaternion(...p.pose.quaternion))
    .add(new Vector3(...p.pose.position));
}

test('every notice kind raises, dedupes, shows on the XR stack and dismisses; the panel keeps the trigger', async ({
  page,
  xr,
}) => {
  test.setTimeout(150_000);
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem(key, '{not json');
      sessionStorage.setItem('seeded', '1');
    }
  }, KEY);
  await xr.boot('noanim&scene=bare');

  // Corrupt settings: the page shows the notice; nothing is built for XR, and the HUD stays unbuilt.
  await expect.poll(() => kinds(xr)).toEqual(['settings-recovered']);
  await expect(page.locator('[data-notice-kind="settings-recovered"]')).toContainText(
    'could not be read',
  );
  expect((await notices(xr)).view).toBeNull();
  expect((await xr.diag()).hud).toEqual({ visible: false, built: false });

  // A rejected XR entry raises the entry error through the session's own path.
  await page.evaluate(() => {
    const system = navigator.xr;
    if (!system) throw new Error('no navigator.xr');
    const real = system.requestSession.bind(system);
    system.requestSession = () => {
      system.requestSession = real;
      return Promise.reject(new Error('stubbed denial'));
    };
  });
  await page.locator('#enter-vr').click();
  await expect.poll(() => kinds(xr)).toEqual(['xr-error', 'settings-recovered']);
  await expect(page.locator('[data-notice-kind="xr-error"]')).toContainText('stubbed denial');

  // A successful entry clears only the entry error; the settings notice carries into XR.
  await xr.enterXR();
  await expect.poll(() => kinds(xr)).toEqual(['settings-recovered']);
  await expect(page.locator('[data-notice-kind="xr-error"]')).toHaveCount(0);
  await expect
    .poll(
      async () => {
        const v = (await notices(xr)).view;
        return Boolean(v?.visible && v.typeset && v.targets.length === 1);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const view = (await notices(xr)).view;
  expect(view?.elevationDeg).toBeCloseTo(13, 6);

  // The other two kinds, and a second entry error that replaces the first.
  await page.evaluate((text) => {
    window.__goghNotice?.('rate-fallback', text);
    window.__goghNotice?.('xr-error', 'Could not start VR: first');
    window.__goghNotice?.('xr-error', 'Could not start VR: second');
    window.__goghNotice?.('update-ready');
  }, RATE_TEXT);
  const raised = await notices(xr);
  expect(raised.queue.map((n) => n.kind)).toEqual([
    'update-ready',
    'xr-error',
    'rate-fallback',
    'settings-recovered',
  ]);
  expect(raised.queue[1]?.text).toBe('Could not start VR: second');
  expect(raised.shown.map((n) => n.kind)).toEqual(['update-ready', 'xr-error']);
  await expect
    .poll(async () => (await notices(xr)).view?.targets.map((t) => t.kind))
    .toEqual(['update-ready', 'xr-error']);

  // A trigger on a Dismiss button dismisses that notice, and its hold never reaches `select`.
  await aimAtButton(xr, 'update-ready');
  await setTrigger(page, 1);
  await xr.waitFrames(4);
  expect(await kinds(xr)).toEqual(['xr-error', 'rate-fallback', 'settings-recovered']);
  expect((await xr.diag()).input?.actions?.select.down).toBe(false);
  await setTrigger(page, 0);
  await xr.waitFrames(3);
  await expect
    .poll(async () => (await notices(xr)).view?.targets.map((t) => t.kind))
    .toEqual(['xr-error', 'rate-fallback']);
  await aimAtButton(xr, 'xr-error');
  await xr.press('right', 'trigger');
  await expect.poll(() => kinds(xr)).toEqual(['rate-fallback', 'settings-recovered']);
  // The page mirrors the queue.
  await expect(page.locator('[data-notice-kind]')).toHaveCount(2);

  // Open the panel with right A. Its default spawn sits below the stack, which stays put.
  await aimAway(xr);
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
  expect((await notices(xr)).view?.elevationDeg).toBeCloseTo(13, 6);

  // A ray through the rate notice's Dismiss button onto the panel: the panel owns the trigger.
  const button = await target(xr, 'rate-fallback');
  const onPanel = panelPoint(opened, 0, PANEL_H / 2 - 0.03);
  const through = onPanel.clone().sub(button).normalize();
  const from = button.clone().sub(through.clone().multiplyScalar(0.3));
  await aim(xr, from, onPanel);
  await xr.waitFrames(3);
  expect(await hovered(xr, 'rate-fallback')).toBe(false);
  await xr.press('right', 'trigger');
  expect(await kinds(xr)).toEqual(['rate-fallback', 'settings-recovered']);
  // The same ray with the panel closed meets the button: the panel was what kept it.
  await xr.press('right', 'a-button');
  await expect.poll(async () => (await panel(xr)).open).toBe(false);
  await expect.poll(() => hovered(xr, 'rate-fallback')).toBe(true);
  await aimAway(xr);
  await xr.press('right', 'a-button');
  await expect.poll(async () => (await panel(xr)).open).toBe(true);

  // With a notice up, the panel's slider still takes the trigger.
  const reopened = await panel(xr);
  const layout = controlLayout('vignette');
  if (!layout) throw new Error('no vignette control');
  const rect = controlRect(layout);
  const slider = panelPoint(reopened, rect.x, rect.y, CONTROL_Z);
  await aim(xr, slider.clone().add(new Vector3(0.06, -0.12, 0.38)), slider);
  await expect.poll(async () => (await panel(xr)).hover?.right).toBe('vignette');
  await xr.press('right', 'trigger');
  const effective = ((await xr.diag()).settings as { effective: { vignette: number } }).effective;
  expect(effective.vignette).toBe(0.5);
  expect(await kinds(xr)).toEqual(['rate-fallback', 'settings-recovered']);

  // A Dismiss button off the panel still works with the panel open.
  await aimAtButton(xr, 'rate-fallback');
  await xr.press('right', 'trigger');
  await expect.poll(() => kinds(xr)).toEqual(['settings-recovered']);
  await aimAtButton(xr, 'settings-recovered');
  await xr.press('right', 'trigger');
  await expect.poll(() => kinds(xr)).toEqual([]);
  await expect.poll(async () => (await notices(xr)).view?.visible).toBe(false);
  await expect(page.locator('[data-notice-kind]')).toHaveCount(0);
  expect(await glErrors(page)).toEqual([]);
});

test('on the desktop the page notice dismisses the queued notice', async ({ page, xr }) => {
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem(key, '{not json');
      sessionStorage.setItem('seeded', '1');
    }
  }, KEY);
  await xr.boot('noanim&scene=bare');
  await expect.poll(() => kinds(xr)).toEqual(['settings-recovered']);
  await page.locator('[data-notice-kind="settings-recovered"] button').click();
  await expect.poll(() => kinds(xr)).toEqual([]);
  expect((await notices(xr)).view).toBeNull();
});

/**
 * A held pointer lock does not survive XR entry in IWER. This does NOT cover the `releaseLock`
 * call in main.ts's sessionstart handler: with that call removed it still passes, because IWER
 * moves the canvas into its own container when the render state is set, and Chromium drops the
 * lock of a re-parented element. That call is covered by the unit test in tests/controls.test.ts.
 */
test('a held pointer lock does not survive XR entry', async ({ page, xr }) => {
  await xr.boot('noanim&scene=bare');
  await page.locator('canvas').first().click();
  const locked = await page
    .waitForFunction(() => document.pointerLockElement !== null, undefined, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!locked, 'headless Chromium did not grant pointer lock');
  // Under lock the mouse cannot reach the button, so click it from the page.
  await page.evaluate(() => document.getElementById('enter-vr')?.click());
  await expect.poll(async () => (await xr.diag()).xr.presenting).toBe(true);
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
});

test('the bench builds no notices', async ({ xr }) => {
  await xr.boot('bench=1000');
  await xr.waitFrames(3);
  expect((await xr.diag()).notices).toBeUndefined();
});
