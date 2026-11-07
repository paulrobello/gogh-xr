/**
 * Live apply (P5.3): every settings change reaches the code that uses it at once, and the store
 * saves later. main.ts subscribes this to the settings store.
 */
import type { LocomotionSettings } from '../locomotion/settings';
import { type Settings, toLocomotionSettings } from './schema';

/** The perf HUD's live visibility, which left X and H toggle for the session. */
export interface HudLive {
  visible(): boolean;
  setVisible(visible: boolean): void;
}

export interface SettingsApplyDeps {
  setLocomotion(settings: LocomotionSettings): void;
  setCalm(calm: number): void;
  /** Null where there is no HUD (the bench). */
  hud: HudLive | null;
}

export function applySettingsChange(
  effective: Settings,
  key: keyof Settings,
  deps: SettingsApplyDeps,
): void {
  deps.setLocomotion(toLocomotionSettings(effective));
  if (key === 'calm') deps.setCalm(effective.calm);
  if (key === 'hud' && deps.hud && deps.hud.visible() !== effective.hud) {
    deps.hud.setVisible(effective.hud);
  }
}
