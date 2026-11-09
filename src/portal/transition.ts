/**
 * The portal transition's timeline (P5.5), pure. A transition goes out, waits for the next world,
 * then comes in:
 *
 * - `fly` (about 2 s): out 0.6 s, the painting's strokes lift off and the old world dissolves into
 *   black; in 1.4 s, they fly out to the new world's strokes as it shows behind them.
 * - `fade` (calm below 0.3, 0.6 s): out 0.3 s to black, in 0.3 s back. No strokes fly.
 *
 * The new world builds from the trigger, the old one is disposed at the end of `out`, and `wait`
 * lasts until the new one is built and uploaded. The veil holds at 1 through the wait, but the
 * view keeps moving over it (wait-motion.ts): in `fly` the strokes swirl about where they hover,
 * eased in from liftoff and out over the `in` leg on the switcher's clock from the trigger, so
 * neither phase end pops however long the wait; in `fade` a dim, fixed field of night-coloured
 * strokes grows in with the veil, breathes slowly in brightness while waiting and shrinks away as
 * the veil lifts. A transition never queues: `request` is refused while one runs, so a trigger
 * during a transition is dropped, not kept for later.
 */

export type PortalState = 'idle' | 'entering' | 'returning';
export type TransitionStyle = 'fly' | 'fade';
export type TransitionPhase = 'out' | 'wait' | 'in' | 'done';

/** Calm below this uses the fade. */
export const CALM_FADE_BELOW = 0.3;
export const FLY_OUT_S = 0.6;
export const FLY_IN_S = 1.4;
export const FADE_OUT_S = 0.3;
export const FADE_IN_S = 0.3;

export function transitionStyle(calm: number): TransitionStyle {
  return calm < CALM_FADE_BELOW ? 'fade' : 'fly';
}

export function phaseDurations(style: TransitionStyle): { out: number; in: number } {
  return style === 'fly' ? { out: FLY_OUT_S, in: FLY_IN_S } : { out: FADE_OUT_S, in: FADE_IN_S };
}

export interface TransitionFrame {
  readonly phase: TransitionPhase;
  /** 0-1 through the phase; 1 while waiting. */
  readonly t: number;
  /** 0-1 through the whole transition, wait excluded. */
  readonly progress: number;
  /** True on the one frame `out` ends: dispose the old world now. */
  readonly outEnded: boolean;
}

export interface Transition {
  readonly state: PortalState;
  readonly style: TransitionStyle | null;
  /** The painting id the running transition goes to, or null. */
  readonly target: string | null;
  readonly phase: TransitionPhase | null;
  readonly progress: number;
  /** Starts a transition; false (and nothing queued) while one runs. */
  request(state: Exclude<PortalState, 'idle'>, target: string, style: TransitionStyle): boolean;
  /** The new world is built: `wait` ends on the next `advance`. */
  ready(): void;
  /** Advances by `dt` seconds. Returns null while idle. */
  advance(dt: number): TransitionFrame | null;
  /** Abandons the running transition (a failed build). */
  cancel(): void;
}

export function createTransition(): Transition {
  let state: PortalState = 'idle';
  let style: TransitionStyle | null = null;
  let target: string | null = null;
  let phase: TransitionPhase | null = null;
  let elapsed = 0;
  let built = false;
  let progress = 0;

  function reset(): void {
    state = 'idle';
    style = null;
    target = null;
    phase = null;
    elapsed = 0;
    built = false;
    progress = 0;
  }

  return {
    get state() {
      return state;
    },
    get style() {
      return style;
    },
    get target() {
      return target;
    },
    get phase() {
      return phase;
    },
    get progress() {
      return progress;
    },
    request(next, to, how) {
      if (state !== 'idle') return false;
      state = next;
      target = to;
      style = how;
      phase = 'out';
      elapsed = 0;
      built = false;
      progress = 0;
      return true;
    },
    ready() {
      if (state !== 'idle') built = true;
    },
    advance(dt) {
      if (state === 'idle' || !style || !phase) return null;
      const d = phaseDurations(style);
      const total = d.out + d.in;
      const step = Math.max(0, dt);
      if (phase === 'out') {
        elapsed += step;
        if (elapsed < d.out) {
          progress = elapsed / total;
          return { phase, t: elapsed / d.out, progress, outEnded: false };
        }
        phase = 'wait';
        elapsed = 0;
        progress = d.out / total;
        return { phase: 'out', t: 1, progress, outEnded: true };
      }
      if (phase === 'wait') {
        if (!built) return { phase, t: 1, progress, outEnded: false };
        phase = 'in';
        elapsed = 0;
      }
      if (phase === 'in') {
        elapsed += step;
        if (elapsed < d.in) {
          progress = (d.out + elapsed) / total;
          return { phase, t: elapsed / d.in, progress, outEnded: false };
        }
        reset();
        progress = 1;
        return { phase: 'done', t: 1, progress: 1, outEnded: false };
      }
      return null;
    },
    cancel() {
      reset();
    },
  };
}

/** Smoothstep easing on [0, 1]. */
export function ease(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** The black veil's opacity over a transition frame: up during `out`, held, down during `in`. */
export function veilAt(frame: TransitionFrame, style: TransitionStyle): number {
  if (frame.phase === 'out') return ease(frame.t);
  if (frame.phase === 'wait') return 1;
  if (frame.phase === 'in') return 1 - ease(style === 'fly' ? frame.t / 0.6 : frame.t);
  return 0;
}
