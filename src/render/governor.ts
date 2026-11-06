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
 * Shed order: far, mid, then near density, down to per-band minimums and never below the drawn
 * floor of the budget (ruling R10); framebuffer scale 1 to 0.85; foveation 0 to 0.5. After 3 s
 * of continuous overrun with nothing left to shed, it requests 72 Hz once, with a notice. Restore
 * pops the shed stack, so it runs in exactly the reverse order back to the exact start levels.
 */
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

/** Each density shed keeps this share of the band's density, so it cuts about 30% of its draws. */
export const DENSITY_STEP = 0.7;
/** A density step smaller than this counts as nothing left to shed in that band. */
export const MIN_DENSITY_STEP = 0.01;
/** Per-band density floors, so no band ever vanishes. */
export const MIN_BAND_DENSITY: Readonly<Record<StrokeBand, number>> = Object.freeze({
  near: 0.25,
  mid: 0.2,
  far: 0.1,
});
export const FULL_FB_SCALE = 1;
export const SHED_FB_SCALE = 0.85;
/** The session default (`FOVEATION` in `xr/session.ts`). */
export const FULL_FOVEATION = 0;
/** P0.8: 1.0 shows blocky shimmer, so 0.5 is as far as the governor goes. */
export const SHED_FOVEATION = 0.5;
export const FALLBACK_HZ = 72;
export const HISTORY_LIMIT = 64;

export const RATE_NOTICE = `Frame rate lowered to ${FALLBACK_HZ} Hz to keep motion smooth.`;

/** Density sheds in this band order. */
const DENSITY_ORDER = ['far', 'mid', 'near'] as const;

export type GovernorMode = 'default' | 'beauty';
export type DensityStep = `${StrokeBand}-density`;
export type GovernorStep = DensityStep | 'fb-scale' | 'foveation';
export type GovernorAction = 'shed' | 'restore' | 'shed-back' | 'rate';

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
  targetHz: number;
  budgetMs: number;
  /** Steps currently shed. */
  level: number;
  /** The most recent step still shed, or 'none'. */
  step: GovernorStep | 'none';
  /** No density step is left: every band is at its minimum or the floor binds. */
  densityMin: boolean;
  densities: Record<StrokeBand, number>;
  sizes: Record<StrokeBand, number>;
  fbScale: number;
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
}

export interface Governor {
  readonly levels: GovernorLevels;
  sample(sample: FrameSample): GovernorEvent | null;
  snapshot(): GovernorSnapshot;
}

interface ShedEntry {
  readonly step: GovernorStep;
  readonly from: number;
  readonly to: number;
  /** Size multipliers for density steps. */
  readonly fromSize: number;
  readonly toSize: number;
}

function budgetFor(mode: GovernorMode): StrokeBudget {
  return mode === 'beauty' ? STROKE_BUDGET.maxBeauty : STROKE_BUDGET.default;
}

function bandOf(step: GovernorStep): StrokeBand | null {
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
  let rateDropped = false;

  let cleanSince: number | null = null;
  let overrunSince: number | null = null;
  let probe: ShedEntry | null = null;
  let probeWaitMs = RESTORE_HOLD_MS;
  let lastFailureAt = Number.NEGATIVE_INFINITY;

  const budgetMs = (): number => 1000 / targetHz;

  function record(event: GovernorEvent): GovernorEvent {
    history.push(event);
    if (history.length > HISTORY_LIMIT) history.shift();
    return event;
  }

  /** Starts a fresh window and hold after a change, so only post-change frames are judged. */
  function changed(): void {
    windowStart = null;
    cleanSince = null;
    overrunSince = null;
  }

  function apply(entry: ShedEntry, toFrom: boolean): void {
    const value = toFrom ? entry.from : entry.to;
    const band = bandOf(entry.step);
    if (band) {
      density[band] = value;
      size[band] = toFrom ? entry.fromSize : entry.toSize;
    } else if (entry.step === 'fb-scale') {
      levels.fbScale = value;
    } else {
      levels.foveation = value;
    }
  }

  /** The next density step, or null when every band is at its minimum or the floor binds. */
  function nextDensityShed(drawn: Readonly<Record<StrokeBand, number>>): ShedEntry | null {
    const total = drawn.near + drawn.mid + drawn.far;
    if (total <= budget.min) return null;
    for (const band of DENSITY_ORDER) {
      const visible = drawn[band];
      const d = density[band];
      if (visible <= 0 || d <= 0) continue;
      let to = Math.max(MIN_BAND_DENSITY[band], d * DENSITY_STEP);
      // Drawn scales with density, so this is the lowest density that keeps the total at the floor.
      const floor = d * (1 - (total - budget.min) / visible);
      to = Math.max(to, floor);
      if (d - to < MIN_DENSITY_STEP) continue;
      return {
        step: `${band}-density`,
        from: d,
        to,
        fromSize: size[band],
        toSize: size[band] * Math.sqrt(d / to),
      };
    }
    return null;
  }

  function nextShed(drawn: Readonly<Record<StrokeBand, number>>): ShedEntry | null {
    const step = nextDensityShed(drawn);
    if (step) return step;
    if (levels.fbScale > SHED_FB_SCALE) {
      return { step: 'fb-scale', from: levels.fbScale, to: SHED_FB_SCALE, fromSize: 0, toSize: 0 };
    }
    if (levels.foveation < SHED_FOVEATION) {
      const from = levels.foveation;
      return { step: 'foveation', from, to: SHED_FOVEATION, fromSize: 0, toSize: 0 };
    }
    return null;
  }

  function judge(
    t: number,
    start: number,
    drawn: Readonly<Record<StrokeBand, number>>,
  ): GovernorEvent | null {
    const budgetNow = budgetMs();
    overrun = (meanMs ?? 0) > budgetNow * OVERRUN_TOLERANCE;
    densityMin = nextDensityShed(drawn) === null;

    if (overrun) {
      cleanSince = null;
      if (probe) {
        const entry = probe;
        probe = null;
        probeWaitMs = Math.min(probeWaitMs * 2, MAX_PROBE_WAIT_MS);
        lastFailureAt = t;
        stack.push(entry);
        apply(entry, false);
        changed();
        return record({ t, action: 'shed-back', step: entry.step, from: entry.from, to: entry.to });
      }
      const entry = nextShed(drawn);
      if (entry) {
        stack.push(entry);
        apply(entry, false);
        changed();
        return record({ t, action: 'shed', step: entry.step, from: entry.from, to: entry.to });
      }
      overrunSince ??= start;
      if (!rateDropped && targetHz > FALLBACK_HZ) {
        if (t - overrunSince < RATE_DROP_AFTER_MS) return null;
        const from = targetHz;
        targetHz = FALLBACK_HZ;
        rateDropped = true;
        notice = RATE_NOTICE;
        changed();
        ignoreUntil = t + RATE_SETTLE_MS;
        return record({ t, action: 'rate', step: 'frame-rate', from, to: FALLBACK_HZ });
      }
      exhausted = true;
      return null;
    }

    overrunSince = null;
    exhausted = false;
    probe = null;
    cleanSince ??= start;
    if (t - lastFailureAt >= PROBE_RESET_MS) probeWaitMs = RESTORE_HOLD_MS;
    const headroom = gpuMs === null || gpuMs <= budgetNow * GPU_HEADROOM;
    const top = stack.at(-1);
    if (!top || !headroom || t - cleanSince < probeWaitMs) return null;
    stack.pop();
    apply(top, true);
    probe = top;
    changed();
    return record({ t, action: 'restore', step: top.step, from: top.to, to: top.from });
  }

  return {
    levels,
    sample(s: FrameSample): GovernorEvent | null {
      if (ignoreUntil === null) ignoreUntil = s.t + WARMUP_MS;
      if (s.t < ignoreUntil) return null;
      if (!(s.intervalMs > 0) || s.intervalMs > MAX_INTERVAL_MS) return null;
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
    snapshot(): GovernorSnapshot {
      const top = stack.at(-1);
      return {
        mode: config.mode,
        targetHz,
        budgetMs: budgetMs(),
        level: stack.length,
        step: top ? top.step : 'none',
        densityMin,
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
      };
    },
  };
}
