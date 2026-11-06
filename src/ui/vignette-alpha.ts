/**
 * The tunnel vignette's alpha (P3.3), pure: the comfort factor, scaled by the strength setting,
 * eased so it never pops. `vignette.ts` draws it; `src/locomotion/locomotion.ts` drives it.
 */
import type { LocomotionSettings } from '../locomotion/settings';
import { MAX_DT } from '../xr/input';

/** The easing's exponential time constant, seconds. */
export const VIGNETTE_TAU = 0.12;
/** Below this, with nothing pushing it up, the alpha is exactly 0 and the mesh is hidden. */
export const VIGNETTE_REST_ALPHA = 1e-3;
const DEG = Math.PI / 180;

/**
 * How hard artificial motion is moving the view, 0-1: the larger of the smooth-move speed over
 * the set move speed and the smooth-turn rate over the set rate, so full stick is 1 (ruling Q25).
 * Every comfort source is one ratio in this max. Snap turns are instant, so they add nothing.
 */
export function comfortFactor(
  /** Smooth-move speed, m/s. */
  speed: number,
  /** Smooth-turn rate, rad/s, either sign. */
  turnRate: number,
  settings: LocomotionSettings,
): number {
  const move = speed / settings.moveSpeed;
  const turn = Math.abs(turnRate) / (settings.smoothTurnDegPerSec * DEG);
  return Math.min(1, Math.max(move, turn));
}

/**
 * One frame of easing toward `target` (strength × comfort factor). An exponential never reaches 0,
 * so once both it and the target are below `VIGNETTE_REST_ALPHA` it lands on exactly 0.
 */
export function easeVignette(alpha: number, target: number, dt: number): number {
  const t = dt > 0 ? Math.min(dt, MAX_DT) : 0;
  const next = alpha + (target - alpha) * (1 - Math.exp(-t / VIGNETTE_TAU));
  return next < VIGNETTE_REST_ALPHA && target < VIGNETTE_REST_ALPHA ? 0 : next;
}
