/**
 * Quality governor (P1.6): a pure state machine over per-frame timings. It holds no clock and
 * applies nothing itself: `sample()` takes one frame's timestamp, interval and drawn counts, and
 * returns the change to apply, if any. `governor-runtime.ts` feeds it and applies the changes.
 *
 * Signals (ruling R11). XR frame intervals are vsync-locked, so they show overruns but not
 * headroom. The machine judges tumbling 0.5 s windows: it sheds one step when a window's mean
 * interval exceeds the budget (1000 / target Hz) by more than 5%. Restore is a probe: after 3 s
 * of clean windows it restores one step, and if the next window overruns it sheds that step back
 * and doubles the wait before the next probe, up to 24 s. 30 s with no failed probe resets the
 * wait. A GPU time, where a timer exists, can only hold a restore back for lack of headroom; it
 * never sheds, so the frame-interval path stands alone.
 *
 * Shed order: foveation and fb scale first, then density. The headset frame is GPU-bound, not CPU
 * or draw-call bound, and not by pixel count alone (Quest 3, 2026-11-06, `docs/verification.md`).
 * Fixed foveation 0.5 measured -16% (0.84 of base) and 1 measured 0.81. But 0.49x the pixels plus
 * foveation 1 reads 18.71 ms, barely under foveation 1 alone (17.2-18.1 ms), and the GPU profiler
 * shows about 54% of shading time on vertices, 85M polygons/s of about 25 px each, at about 78%
 * utilisation: geometry (many tiny stroke triangles through binning and rendering) plus fragment
 * work. Foveation is still the one measured lever. So the steps are foveation 0 to 0.5, framebuffer
 * scale 1 to 0.85, foveation 0.5 to 1 (the last resort P0.8 found blocky at the edges), then far,
 * mid and near density, down to per-band minimums and never below the drawn floor of the budget
 * (ruling R10), skipping a band whose step would save under `MIN_SHED_YIELD` (3%) of the drawn
 * total. Density goes last: each density step grows the band's stroke size by sqrt of the density
 * ratio to keep its coverage, so it keeps the painted area the same, it bought no measured time on
 * the headset, and it costs the most visible quality. After 3 s of continuous overrun with nothing
 * left to shed, a target above 72 Hz requests 72 Hz once. A 72 Hz target (the default adaptive-72,
 * and max beauty) never requests a rate: the session asked for 72 at its start. The 72 Hz budget
 * and the notice take effect only when the runtime reports the request applied (`rateApplied`); a
 * failed request (`rateFailed`) leaves the rate step unavailable. Restore pops the shed stack, so
 * it runs in exactly the reverse order back to the exact start levels.
 *
 * No-gain rule. A shed that buys no time costs quality for nothing: a density step that keeps the
 * painted area, or a framebuffer scale the runtime ignores. So the first window after a shed is
 * compared with the window that triggered it. If it still overruns and its mean interval is not at
 * least `NO_GAIN_SHARE` lower, the step is undone at once (a 'no-gain' event, back to the exact
 * level it shed from) and that step is held: it is not shed again until the reported frame rate
 * changes, the session is interrupted or restarted (the runtime then builds a new machine), or the
 * hold lapses, so a scene change can re-earn it. The first hold of a step lasts `NO_GAIN_HOLD_MS`
 * (30 s), and each further hold of that step doubles, capped at `MAX_HOLD_MS` (30, 60, 120, 240,
 * then 300 s), so a step that never pays stops flipping strokes every 30 s. A frame-rate change or
 * a new session restarts the doubling, and a shed that pays restarts it for that step. The holds
 * are per step, with two exceptions (`holdOf`). The two foveation steps hold apart ('foveation' to
 * 0.5, 'foveation-max' to 1), so a 0.5 step that reads as no-gain under window noise does not block
 * 1. Under the `area` density law the bands share one hold ('density'): under the sqrt size law
 * every band keeps its painted area, so one band's no-gain predicts the others' and they need not
 * each flip wall strokes to learn it. Under `count` each band holds apart, since a band's step then
 * cuts its own fill and vertex work and one band's no-gain predicts nothing for the others. A held step counts as nothing left to shed, so with every step held the 3 s count to
 * the 72 Hz request runs as before. A check window that no longer overruns keeps the step whatever
 * its gain, since undoing it would bring the overrun back. A shed-back after a failed probe is
 * never checked: the probe already showed that step pays.
 *
 * Overrun recovery (ruling Q26). On a vsync-locked headset, half-second window means vary by 4-7%
 * at 55-68 fps, more than the bar, so a third or more of useless sheds stick by chance, and a
 * restore probe needs clean windows that an overrunning frame never gives. So once the frame has
 * overrun for `RECOVER_AFTER_MS` with nothing left to shed (after the 72 Hz request is applied or
 * failed, or with no lower rate to ask for), the top shed step is restored (a 'recover' event), in
 * the shed stack's reverse order. The judged windows over the next `RECOVER_CHECK_MS` are compared
 * with the mean of every frame in that overrun stretch, a baseline at least ten windows long and so
 * far less noisy than one window. If their mean overruns by more than `NO_GAIN_SHARE` over the
 * baseline, the restore cost time: the step is shed again ('recover-back') and held from recovery,
 * which stops recovery at that step until the hold lapses. Otherwise the restore is kept and the
 * step is held from shedding, like a no-gain hold, so it is not shed straight back. Both holds
 * double like no-gain holds. A frame no step helps thus climbs back to the start levels about one
 * step per 7 s, and one that needs its sheds keeps its shed level, spending one 2 s check per hold
 * lapse to re-test it, at ever longer intervals.
 *
 * The budget follows the frame rate the session reports (`setFrameRate`), not the one requested.
 * A stall over 100 ms or a hidden session (`interrupt`) restarts the window and both timers, so a
 * pause never counts as overrun or as clean time. A stall keeps a pending no-gain check.
 *
 * Fixed level (the `qualityLevel` setting). With `GovernorConfig.fixedLevel` set, the machine sheds
 * that many steps at creation through the same `nextShed` it judges with, but with no drawn counts:
 * the drawn floor and `MIN_SHED_YIELD` depend on the view, so a fixed level skips only a step that
 * cannot apply (a band already at its minimum). It then never judges a frame: `sample()` returns
 * null, so there is no shed, restore, no-gain, recover or rate event. `qualityLadder` lists the
 * steps a fixed level takes.
 */
import type { DensityLaw } from '../diag/flags';
import {
  BEAUTY_BAND_DENSITY,
  BEAUTY_BAND_SIZE,
  DEFAULT_BAND_DENSITY,
  DEFAULT_BAND_SIZE,
  STROKE_BUDGET,
  type StrokeBand,
  type StrokeBudget,
} from './strokes/bands';

/** Shed decisions use windows of this length. */
export const SHED_WINDOW_MS = 500;
/** A window sheds when its mean interval exceeds the budget by this factor. */
export const OVERRUN_TOLERANCE = 1.05;
/** Clean windows needed before the first restore probe after a change. */
export const RESTORE_HOLD_MS = 3000;
/** Cap on the probe wait, which doubles on each failed probe. */
export const MAX_PROBE_WAIT_MS = 24_000;
/** A run this long without a failed probe resets the wait to `RESTORE_HOLD_MS`. */
export const PROBE_RESET_MS = 30_000;
/** Continuous overrun with nothing left to shed before the 72 Hz request. */
export const RATE_DROP_AFTER_MS = 3000;
/** Frames ignored after the first sample: session start uploads every instance buffer. */
export const WARMUP_MS = 1000;
/** Frames ignored after a frame-rate request while the runtime switches. */
export const RATE_SETTLE_MS = 1000;
/** Longer intervals are stalls (a hidden page, a paused session), not load. */
export const MAX_INTERVAL_MS = 100;
/** A restore probe also needs the window's GPU mean under this share of the budget. */
export const GPU_HEADROOM = 0.8;
/**
 * A shed must cut the next window's mean interval by at least this share of the triggering window's
 * mean, or it is undone. It is what a step that pays for itself buys: a 30% density cut of a band
 * carrying a tenth of the drawn strokes, on a stroke-bound frame, is 3%. Noise can cross it: in
 * headless Chromium under host load, window means at about 19 ms move 1-3% window to window and
 * now and then more, so a useless shed sometimes reads as a gain and sticks. The headset's window
 * noise is unmeasured.
 */
export const NO_GAIN_SHARE = 0.03;
/**
 * How long a step stays held the first time it buys nothing, when the frame rate and session do not
 * change. Each further no-gain hold of the same step doubles it, up to `MAX_HOLD_MS`.
 */
export const NO_GAIN_HOLD_MS = 30_000;
/** Cap on the doubling no-gain and recovery holds: 30, 60, 120, 240, then 300 s. */
export const MAX_HOLD_MS = 300_000;
/** Overrun with nothing left to shed before each recovery restore. */
export const RECOVER_AFTER_MS = 5000;
/**
 * A recovery restore is judged on this much frame time, four windows, since one window's mean
 * varies by 4-7% on a vsync-locked frame and a 2 s mean by about half that.
 */
export const RECOVER_CHECK_MS = 2000;

/** Each density shed keeps this share of the band's density, so it cuts about 30% of its draws. */
export const DENSITY_STEP = 0.7;
/** A density step smaller than this counts as nothing left to shed in that band. */
export const MIN_DENSITY_STEP = 0.01;
/**
 * A density step that would cut less than this share of the drawn total is skipped for the next
 * band or step. It is the no-gain bar: even on a fully stroke-bound frame such a step saves less
 * than the bar, so the no-gain rule would undo it, and trying it would only cost a window of lower
 * quality, or stick by chance.
 */
export const MIN_SHED_YIELD = NO_GAIN_SHARE;
/** Per-band density floors, so no band ever vanishes. */
export const MIN_BAND_DENSITY: Readonly<Record<StrokeBand, number>> = Object.freeze({
  near: 0.25,
  mid: 0.2,
  far: 0.1,
});
export const FULL_FB_SCALE = 1;
export const SHED_FB_SCALE = 0.85;
/** The session default (`FOVEATION` in `xr/session.ts`), where every session starts. */
export const FULL_FOVEATION = 0;
/** The first foveation step. P0.8 saw shimmer here, but far less than at 1. */
export const SHED_FOVEATION = 0.5;
/** The last-resort foveation step: blocky at the view edges (P0.8). */
export const MAX_FOVEATION = 1;
export const FALLBACK_HZ = 72;
export const HISTORY_LIMIT = 64;

export const RATE_NOTICE = `Frame rate lowered to ${FALLBACK_HZ} Hz to keep motion smooth.`;

/** Density sheds in this band order. */
const DENSITY_ORDER = ['far', 'mid', 'near'] as const;

export type GovernorMode = 'default' | 'beauty';
export type DensityStep = `${StrokeBand}-density`;
/** 'foveation' takes foveation 0 to 0.5, 'foveation-max' up to 1; each has its own hold. */
export type GovernorStep = DensityStep | 'fb-scale' | 'foveation' | 'foveation-max';
/**
 * What a hold applies to: a step, or 'density' for all three bands under the `area` law, where a
 * density step keeps the painted area in any band, so one band's no-gain predicts the others'.
 */
export type GovernorHold = GovernorStep | 'density';
export type GovernorAction =
  | 'shed'
  | 'restore'
  | 'shed-back'
  | 'no-gain'
  | 'recover'
  | 'recover-back'
  | 'rate'
  | 'rate-failed';
/** The 72 Hz fallback: not asked yet, awaiting the runtime, applied, or refused. */
export type RateRequest = 'none' | 'pending' | 'applied' | 'unavailable';

/** One change, returned by `sample()` and kept in the history. */
export interface GovernorEvent {
  /** Frame timestamp, ms. */
  readonly t: number;
  readonly action: GovernorAction;
  readonly step: GovernorStep | 'frame-rate';
  /** Density, framebuffer scale, foveation or Hz before and after. */
  readonly from: number;
  readonly to: number;
}

export interface GovernorLevels {
  readonly density: Readonly<Record<StrokeBand, number>>;
  readonly size: Readonly<Record<StrokeBand, number>>;
  readonly fbScale: number;
  readonly foveation: number;
}

export interface GovernorConfig {
  readonly mode: GovernorMode;
  readonly targetHz: number;
  /**
   * How a density shed sizes the band's survivors (`?densitylaw`): `area` (the default) grows them
   * by sqrt(from / to), so the painted area holds; `count` keeps their size, so a shed cuts
   * instances, vertex work and painted area alike and gaps can open. Under `area` the bands share
   * the 'density' hold; under `count` each band holds apart (`holdOf`).
   */
  readonly densityLaw?: DensityLaw;
  /**
   * A fixed quality level: the first N steps of the shed order (`qualityLadder`), clamped to the
   * ladder, and no judging. null or absent runs the adaptive machine.
   */
  readonly fixedLevel?: number | null;
}

export interface FrameSample {
  /** Frame timestamp, ms. */
  readonly t: number;
  /** Interval since the previous frame, ms. */
  readonly intervalMs: number;
  /** GPU time of the frame where a timer exists, else null. */
  readonly gpuMs?: number | null;
  /** Instances drawn per band after the last cull. */
  readonly drawn: Readonly<Record<StrokeBand, number>>;
}

export interface GovernorSnapshot {
  mode: GovernorMode;
  /** The density shed's size law (`GovernorConfig.densityLaw`). */
  densityLaw: DensityLaw;
  /** The configured target, or 72 once the fallback is applied. */
  targetHz: number;
  /** The frame rate the session reports, which sets the budget. */
  frameRate: number;
  budgetMs: number;
  rateRequest: RateRequest;
  /** Steps currently shed. */
  level: number;
  /** The most recent step still shed, or 'none'. */
  step: GovernorStep | 'none';
  /**
   * No density step is left: every band is at its minimum, the floor binds, is held after a no-gain
   * undo, or would save under `MIN_SHED_YIELD` of the drawn total.
   */
  densityMin: boolean;
  /** Steps not shed until their hold lapses: undone as no-gain, or restored by a kept recovery. */
  noGainHeld: GovernorHold[];
  /** Steps whose recovery restore cost time and was shed back: held from recovery until lapsed. */
  recoverHeld: GovernorHold[];
  densities: Record<StrokeBand, number>;
  sizes: Record<StrokeBand, number>;
  fbScale: number;
  /** Fixed foveation the governor asks for: 0, 0.5 or 1. */
  foveation: number;
  /** Mean interval of the last judged window, ms. */
  meanMs: number | null;
  gpuMs: number | null;
  /** Whether the last judged window overran. */
  overrun: boolean;
  notice: string | null;
  probeWaitMs: number;
  /** Overrunning with nothing left to shed and no lower rate to request. */
  exhausted: boolean;
  history: GovernorEvent[];
  /** The fixed level applied (clamped to the ladder), or null when the machine adapts. */
  fixedLevel: number | null;
}

/** One step of the shed order, as `qualityLadder` lists it: values before and after. */
export interface LadderStep {
  readonly step: GovernorStep;
  /** Density, framebuffer scale or foveation. */
  readonly from: number;
  readonly to: number;
  /** Size multipliers for density steps, 0 otherwise. */
  readonly fromSize: number;
  readonly toSize: number;
}

export interface Governor {
  readonly levels: GovernorLevels;
  sample(sample: FrameSample): GovernorEvent | null;
  /** The session's reported frame rate; a change restarts the window. */
  setFrameRate(hz: number): void;
  /** The session went hidden or paused: restarts the window and both timers. */
  interrupt(): void;
  /** The runtime applied the 72 Hz request: commits the budget and the notice. */
  rateApplied(hz: number): void;
  /** The request was refused or cannot be made: returns the 'rate-failed' history event. */
  rateFailed(t: number): GovernorEvent | null;
  snapshot(): GovernorSnapshot;
  /** The steps shed now, first shed first. */
  shedSteps(): LadderStep[];
}

type ShedEntry = LadderStep;

/** A shed awaiting its no-gain check, with the mean of the window that triggered it. */
interface PendingCheck {
  readonly entry: ShedEntry;
  readonly triggerMs: number;
}

/** A recovery restore under check: the stretch's baseline and the frames judged since. */
interface RecoveryCheck {
  readonly entry: ShedEntry;
  readonly baselineMs: number;
  readonly since: number;
  sum: number;
  count: number;
}

/** The hold a step's no-gain or recovery result applies to. */
export function holdOf(step: GovernorStep, law: DensityLaw = 'area'): GovernorHold {
  return law === 'area' && step.endsWith('-density') ? 'density' : step;
}

function budgetFor(mode: GovernorMode): StrokeBudget {
  return mode === 'beauty' ? STROKE_BUDGET.maxBeauty : STROKE_BUDGET.default;
}

/** The band a density step sheds, or null for any other step. */
export function densityBand(step: GovernorEvent['step']): StrokeBand | null {
  return step.endsWith('-density') ? (step.slice(0, -'-density'.length) as StrokeBand) : null;
}

export function createGovernor(config: GovernorConfig): Governor {
  const budget = budgetFor(config.mode);
  const density: Record<StrokeBand, number> = {
    ...(config.mode === 'beauty' ? BEAUTY_BAND_DENSITY : DEFAULT_BAND_DENSITY),
  };
  const size: Record<StrokeBand, number> = {
    ...(config.mode === 'beauty' ? BEAUTY_BAND_SIZE : DEFAULT_BAND_SIZE),
  };
  const levels = { density, size, fbScale: FULL_FB_SCALE, foveation: FULL_FOVEATION };
  let targetHz = config.targetHz;
  let frameRate = config.targetHz;
  let rateRequest: RateRequest = 'none';

  const stack: ShedEntry[] = [];
  const history: GovernorEvent[] = [];
  let notice: string | null = null;

  let ignoreUntil: number | null = null;
  let windowStart: number | null = null;
  let sum = 0;
  let count = 0;
  let gpuSum = 0;
  let gpuCount = 0;

  let meanMs: number | null = null;
  let gpuMs: number | null = null;
  let overrun = false;
  let densityMin = false;
  let exhausted = false;

  let cleanSince: number | null = null;
  let overrunSince: number | null = null;
  let probe: ShedEntry | null = null;
  let probeWaitMs = RESTORE_HOLD_MS;
  let lastFailureAt = Number.NEGATIVE_INFINITY;
  let pending: PendingCheck | null = null;
  let recovering: RecoveryCheck | null = null;
  /** Start of the overrun stretch with nothing left to shed: a change ends it, clean time not. */
  let stuckSince: number | null = null;
  /** Frame intervals over that stretch: the recovery baseline. */
  let stuckSum = 0;
  let stuckCount = 0;
  /** No-gain steps and the time each hold lapses. */
  const heldUntil = new Map<GovernorHold, number>();
  /** Steps whose recovery restore cost time: not restored by recovery until the hold lapses. */
  const recoverHeldUntil = new Map<GovernorHold, number>();
  /** Holds per step since the last frame-rate change. The next one lasts 2^n times as long. */
  const strikes = new Map<GovernorHold, number>();

  const budgetMs = (): number => 1000 / frameRate;
  const holdKey = (step: GovernorStep): GovernorHold => holdOf(step, config.densityLaw);

  function record(event: GovernorEvent): GovernorEvent {
    history.push(event);
    if (history.length > HISTORY_LIMIT) history.shift();
    return event;
  }

  /**
   * A frame-rate change or an interrupt: no-gain holds and a pending check no longer apply. Only a
   * frame-rate change (`resetBackoff`) also restarts the hold doubling; a new session builds a new
   * machine, which starts it over too.
   */
  function clearHolds(resetBackoff: boolean): void {
    heldUntil.clear();
    recoverHeldUntil.clear();
    if (resetBackoff) strikes.clear();
    pending = null;
    recovering = null;
  }

  /** Holds `step` in `holds` for 30 s, doubled per hold since the last reset, up to 5 min. */
  function hold(holds: Map<GovernorHold, number>, step: GovernorStep, t: number): void {
    const key = holdKey(step);
    const n = strikes.get(key) ?? 0;
    strikes.set(key, n + 1);
    holds.set(key, t + Math.min(NO_GAIN_HOLD_MS * 2 ** n, MAX_HOLD_MS));
  }

  /** Starts a fresh window and hold after a change, so only post-change frames are judged. */
  function changed(): void {
    windowStart = null;
    cleanSince = null;
    overrunSince = null;
    stuckSince = null;
    stuckSum = 0;
    stuckCount = 0;
  }

  /**
   * Restores the top shed step once the stretch with nothing left to shed has lasted
   * `RECOVER_AFTER_MS`, unless that step is held from recovery.
   */
  function recover(t: number): GovernorEvent | null {
    if (stuckSince === null) return null;
    stuckSum += sum;
    stuckCount += count;
    const top = stack.at(-1);
    if (!top || recoverHeldUntil.has(holdKey(top.step)) || t - stuckSince < RECOVER_AFTER_MS)
      return null;
    const baselineMs = stuckSum / stuckCount;
    stack.pop();
    apply(top, true);
    changed();
    recovering = { entry: top, baselineMs, since: t, sum: 0, count: 0 };
    return record({ t, action: 'recover', step: top.step, from: top.to, to: top.from });
  }

  function apply(entry: ShedEntry, toFrom: boolean): void {
    const value = toFrom ? entry.from : entry.to;
    const band = densityBand(entry.step);
    if (band) {
      density[band] = value;
      size[band] = toFrom ? entry.fromSize : entry.toSize;
    } else if (entry.step === 'foveation' || entry.step === 'foveation-max') {
      levels.foveation = value;
    } else {
      levels.fbScale = value;
    }
  }

  /**
   * A density shed of `band` toward `target`, clamped to the band minimum and to the drawn floor
   * for the current view, or null when that leaves less than `MIN_DENSITY_STEP` to shed. With no
   * drawn counts (a fixed level) only the band minimum clamps.
   */
  function densityShed(
    band: StrokeBand,
    target: number,
    drawn: Readonly<Record<StrokeBand, number>> | null,
  ): ShedEntry | null {
    const d = density[band];
    if (d <= 0) return null;
    let floor = 0;
    if (drawn) {
      const total = drawn.near + drawn.mid + drawn.far;
      const visible = drawn[band];
      if (total <= budget.min || visible <= 0) return null;
      // Drawn scales with density, so this is the lowest density that keeps the total at the floor.
      floor = d * (1 - (total - budget.min) / visible);
    }
    const to = Math.max(MIN_BAND_DENSITY[band], target, floor);
    if (d - to < MIN_DENSITY_STEP) return null;
    return {
      step: `${band}-density`,
      from: d,
      to,
      fromSize: size[band],
      toSize: config.densityLaw === 'count' ? size[band] : size[band] * Math.sqrt(d / to),
    };
  }

  /**
   * The next density step, or null when every band is at its minimum, the floor binds, or what is
   * left would save under `MIN_SHED_YIELD` of the drawn total. A failed probe's shed-back skips
   * this yield check (`shedBack`), so it always returns the step it restored. With no drawn counts
   * (a fixed level) there is no yield check either.
   */
  function nextDensityShed(drawn: Readonly<Record<StrokeBand, number>> | null): ShedEntry | null {
    const total = drawn ? drawn.near + drawn.mid + drawn.far : 0;
    for (const band of DENSITY_ORDER) {
      if (heldUntil.has(holdKey(`${band}-density`))) continue;
      const entry = densityShed(band, density[band] * DENSITY_STEP, drawn);
      if (
        entry &&
        (!drawn || drawn[band] * (1 - entry.to / entry.from) >= MIN_SHED_YIELD * total)
      ) {
        return entry;
      }
    }
    return null;
  }

  /** A failed probe's step again, density re-clamped to the current view's floor. */
  function shedBack(
    entry: ShedEntry,
    drawn: Readonly<Record<StrokeBand, number>>,
  ): ShedEntry | null {
    const band = densityBand(entry.step);
    return band ? densityShed(band, entry.to, drawn) : entry;
  }

  function foveationShed(step: 'foveation' | 'foveation-max', to: number): ShedEntry | null {
    if (levels.foveation >= to || heldUntil.has(step)) return null;
    return { step, from: levels.foveation, to, fromSize: 0, toSize: 0 };
  }

  /**
   * Foveation 0.5, fb scale and foveation 1 first, then density far, mid, near. With 'foveation'
   * held after a no-gain, 'foveation-max' sheds straight from 0 to 1. A fixed level passes null
   * for `drawn` (see `nextDensityShed`).
   */
  function nextShed(drawn: Readonly<Record<StrokeBand, number>> | null): ShedEntry | null {
    const first = foveationShed('foveation', SHED_FOVEATION);
    if (first) return first;
    if (levels.fbScale > SHED_FB_SCALE && !heldUntil.has('fb-scale')) {
      return { step: 'fb-scale', from: levels.fbScale, to: SHED_FB_SCALE, fromSize: 0, toSize: 0 };
    }
    return foveationShed('foveation-max', MAX_FOVEATION) ?? nextDensityShed(drawn);
  }

  function judge(
    t: number,
    start: number,
    drawn: Readonly<Record<StrokeBand, number>>,
  ): GovernorEvent | null {
    const budgetNow = budgetMs();
    const mean = meanMs ?? 0;
    overrun = mean > budgetNow * OVERRUN_TOLERANCE;
    for (const holds of [heldUntil, recoverHeldUntil]) {
      for (const [step, until] of holds) if (t >= until) holds.delete(step);
    }

    // Nothing changes the stack between a shed and this window, so the checked entry is its top.
    const check = pending;
    pending = null;
    if (check && overrun && mean > check.triggerMs * (1 - NO_GAIN_SHARE)) {
      stack.pop();
      apply(check.entry, true);
      hold(heldUntil, check.entry.step, t);
      densityMin = nextDensityShed(drawn) === null;
      changed();
      const { step, from, to } = check.entry;
      return record({ t, action: 'no-gain', step, from: to, to: from });
    }
    // The shed paid for itself: its next no-gain hold starts from 30 s again.
    if (check) strikes.delete(holdKey(check.entry.step));
    // A recovery check spans RECOVER_CHECK_MS of windows and nothing else changes meanwhile, so
    // the restored entry goes back on top if it is shed back.
    const restored = recovering;
    if (restored) {
      restored.sum += sum;
      restored.count += count;
      if (t - restored.since < RECOVER_CHECK_MS) return null;
      recovering = null;
      const checkMs = restored.sum / restored.count;
      if (
        checkMs > budgetNow * OVERRUN_TOLERANCE &&
        checkMs > restored.baselineMs * (1 + NO_GAIN_SHARE)
      ) {
        hold(recoverHeldUntil, restored.entry.step, t);
        stack.push(restored.entry);
        apply(restored.entry, false);
        densityMin = nextDensityShed(drawn) === null;
        changed();
        const { step, from, to } = restored.entry;
        return record({ t, action: 'recover-back', step, from, to });
      }
      // Kept: the step bought nothing, so it is not shed straight back.
      hold(heldUntil, restored.entry.step, t);
    }
    densityMin = nextDensityShed(drawn) === null;

    if (overrun) {
      cleanSince = null;
      if (probe) {
        const back = shedBack(probe, drawn);
        probe = null;
        probeWaitMs = Math.min(probeWaitMs * 2, MAX_PROBE_WAIT_MS);
        lastFailureAt = t;
        // A view now under the floor leaves nothing to shed back; the next shed step applies.
        if (back) {
          stack.push(back);
          apply(back, false);
          changed();
          return record({ t, action: 'shed-back', step: back.step, from: back.from, to: back.to });
        }
      }
      const entry = nextShed(drawn);
      if (entry) {
        stack.push(entry);
        apply(entry, false);
        pending = { entry, triggerMs: mean };
        changed();
        return record({ t, action: 'shed', step: entry.step, from: entry.from, to: entry.to });
      }
      overrunSince ??= start;
      if (rateRequest === 'pending') return null;
      // A 72 Hz target (adaptive-72, max beauty) already asked for 72 at session start: a
      // session that reports more refused it, and the budget follows the reported rate.
      if (rateRequest === 'none' && frameRate > FALLBACK_HZ && config.targetHz > FALLBACK_HZ) {
        if (t - overrunSince < RATE_DROP_AFTER_MS) return null;
        rateRequest = 'pending';
        changed();
        ignoreUntil = t + RATE_SETTLE_MS;
        return record({ t, action: 'rate', step: 'frame-rate', from: frameRate, to: FALLBACK_HZ });
      }
      exhausted = true;
      stuckSince ??= start;
      return recover(t);
    }

    overrunSince = null;
    exhausted = false;
    probe = null;
    cleanSince ??= start;
    if (t - lastFailureAt >= PROBE_RESET_MS) probeWaitMs = RESTORE_HOLD_MS;
    const headroom = gpuMs === null || gpuMs <= budgetNow * GPU_HEADROOM;
    const top = stack.at(-1);
    // A frame at the shed line mixes clean and overrun windows: recovery keeps its stretch.
    if (!top || !headroom || t - cleanSince < probeWaitMs) return recover(t);
    stack.pop();
    apply(top, true);
    probe = top;
    changed();
    return record({ t, action: 'restore', step: top.step, from: top.to, to: top.from });
  }

  const fixed = config.fixedLevel ?? null;
  if (fixed !== null) {
    // Nothing is held yet, so this is the plain shed order from the mode's start levels.
    while (stack.length < fixed) {
      const entry = nextShed(null);
      if (!entry) break;
      stack.push(entry);
      apply(entry, false);
    }
  }

  return {
    levels,
    sample(s: FrameSample): GovernorEvent | null {
      if (fixed !== null) return null;
      if (ignoreUntil === null) ignoreUntil = s.t + WARMUP_MS;
      if (s.t < ignoreUntil) return null;
      if (!(s.intervalMs > 0) || s.intervalMs > MAX_INTERVAL_MS) {
        changed();
        return null;
      }
      if (windowStart === null) {
        windowStart = s.t - s.intervalMs;
        sum = 0;
        count = 0;
        gpuSum = 0;
        gpuCount = 0;
      }
      sum += s.intervalMs;
      count++;
      if (typeof s.gpuMs === 'number' && Number.isFinite(s.gpuMs)) {
        gpuSum += s.gpuMs;
        gpuCount++;
      }
      if (s.t - windowStart < SHED_WINDOW_MS) return null;
      const start = windowStart;
      windowStart = null;
      meanMs = sum / count;
      gpuMs = gpuCount > 0 ? gpuSum / gpuCount : null;
      return judge(s.t, start, s.drawn);
    },
    setFrameRate(hz: number) {
      if (!(hz > 0) || hz === frameRate) return;
      frameRate = hz;
      clearHolds(true);
      changed();
    },
    interrupt() {
      clearHolds(false);
      changed();
    },
    rateApplied(hz: number) {
      if (rateRequest !== 'pending') return;
      rateRequest = 'applied';
      targetHz = hz;
      notice = RATE_NOTICE;
      if (hz !== frameRate) {
        frameRate = hz;
        clearHolds(true);
        changed();
      }
    },
    rateFailed(t: number) {
      if (rateRequest !== 'pending') return null;
      rateRequest = 'unavailable';
      changed();
      return record({
        t,
        action: 'rate-failed',
        step: 'frame-rate',
        from: frameRate,
        to: frameRate,
      });
    },
    snapshot(): GovernorSnapshot {
      const top = stack.at(-1);
      return {
        mode: config.mode,
        densityLaw: config.densityLaw ?? 'area',
        targetHz,
        frameRate,
        budgetMs: budgetMs(),
        rateRequest,
        level: stack.length,
        step: top ? top.step : 'none',
        densityMin,
        noGainHeld: [...heldUntil.keys()],
        recoverHeld: [...recoverHeldUntil.keys()],
        densities: { ...density },
        sizes: { ...size },
        fbScale: levels.fbScale,
        foveation: levels.foveation,
        meanMs,
        gpuMs,
        overrun,
        notice,
        probeWaitMs,
        exhausted,
        history: [...history],
        fixedLevel: fixed === null ? null : stack.length,
      };
    },
    shedSteps: () => [...stack],
  };
}

/**
 * The fixed-level ladder for `mode`: entry N - 1 is the step level N adds, so level N applies the
 * first N. It is the machine's own shed order from the mode's start levels, with no drawn counts.
 */
export function qualityLadder(mode: GovernorMode, densityLaw?: DensityLaw): LadderStep[] {
  return createGovernor({
    mode,
    targetHz: FALLBACK_HZ,
    densityLaw,
    fixedLevel: Number.POSITIVE_INFINITY,
  }).shedSteps();
}
