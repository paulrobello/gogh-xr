/**
 * Diag readers and IWER aiming shared by the portal, panel and journey specs. Not a spec file, so
 * importing it registers no tests.
 */
import type { Page } from '@playwright/test';
import { Quaternion, Vector3 } from 'three';
import { CONTROL_Z } from '../../src/ui/panel-core.ts';
import { controlLayout, controlRect } from '../../src/ui/panel-layout.ts';
import { expect, type Quat, type Vec3, type Xr } from './fixtures';

export const SETTINGS_KEY = 'gogh-xr.settings.v1';

export interface FrameRecord {
  phase: string;
  intervalMs: number;
  workMs: number;
  slicerMs: number;
  renderMs: number;
  task: string | null;
}

export interface PortalDiag {
  state: 'idle' | 'entering' | 'returning';
  progress: number;
  lastTrigger: { id: string; cause: string; t: number } | null;
  longestFrameMs: number | null;
  longestStepMs: number | null;
  longestStep: string | null;
  stepsMs: Record<string, number>;
  durationMs: number | null;
  longestWorkMs: number | null;
  longestWorkPhase: string | null;
  flying: boolean;
  /** What the last transition fell back to after its target failed to build, else null. */
  fallback: 'gallery' | 'bare' | null;
  frames: FrameRecord[];
}

export interface PanelDiag {
  built: boolean;
  open: boolean;
  surface: string | null;
  pose: { position: Vec3; quaternion: Quat } | null;
  scale: number | null;
  hover: { left: string | null; right: string | null } | null;
  typeset: boolean;
  locked: Record<string, string>;
}

export interface SettingsDiag {
  stored: Record<string, unknown>;
  effective: Record<string, unknown>;
  saves: number;
  pending: boolean;
}

export const portal = async (xr: Xr): Promise<PortalDiag> => (await xr.diag()).portal as PortalDiag;

/** Waits until `painting` is the active world, no transition runs and its plaques have settled. */
export async function settled(xr: Xr, painting: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const d = await xr.diag();
        const world = d.world as { plaques?: { state: string } } | undefined;
        return (
          d.painting === painting &&
          (d.portal as PortalDiag).state === 'idle' &&
          world !== undefined &&
          world.plaques?.state !== 'pending'
        );
      },
      { timeout: 90_000 },
    )
    .toBe(true);
}

export async function panel(xr: Xr): Promise<PanelDiag> {
  return (await xr.diag()).panel as PanelDiag;
}

/**
 * Stores the Hand orbs setting off before every load, keeping any other stored field. For specs
 * that compare XR pixels or count blended draws with a controller in view, which the orbs (an
 * additive pass round each hand) would change.
 */
export async function handOrbsOff(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    let stored: { version?: number; settings?: Record<string, unknown> } = {};
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
    } catch {
      stored = {};
    }
    const version = typeof stored.version === 'number' ? stored.version : 3;
    const settings = { ...(stored.settings ?? {}), handOrbs: false };
    localStorage.setItem(key, JSON.stringify({ version, settings }));
  }, SETTINGS_KEY);
}

export async function settings(xr: Xr): Promise<SettingsDiag> {
  return (await xr.diag()).settings as SettingsDiag;
}

/**
 * A control's centre on the panel's control plane. The result is rig-local, the frame of the
 * panel's diag pose and of IWER's controller poses, so it can be passed to `aim` wherever the rig
 * stands. The layout module's hidden state (`setControlHidden`) must match the page's, or the
 * point lands where the page does not draw.
 */
export function controlPoint(p: PanelDiag, id: string, fraction = 0.5): Vector3 {
  const layout = controlLayout(id);
  if (!layout || !p.pose || p.scale === null) throw new Error(`no ${id} or no pose`);
  const rect = controlRect(layout);
  const x = rect.x - rect.w / 2 + rect.w * fraction;
  return new Vector3(x, rect.y, CONTROL_Z)
    .multiplyScalar(p.scale)
    .applyQuaternion(new Quaternion(...p.pose.quaternion))
    .add(new Vector3(...p.pose.position));
}

/** Points the right controller from `from` at `target`. */
export async function aim(xr: Xr, from: Vector3, target: Vector3): Promise<void> {
  const dir = target.clone().sub(from).normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir);
  await xr.setPose({
    right: { position: from.toArray() as Vec3, quaternion: q.toArray() as Quat },
  });
}

/** Sets a right controller button's value and leaves it there. */
export function setButton(page: Page, button: string, value: number): Promise<void> {
  return page.evaluate(
    ([b, v]) => window.__goghIwer?.controllers.right?.updateButtonValue(b as string, v as number),
    [button, value] as const,
  );
}
