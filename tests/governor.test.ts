import { describe, expect, test } from 'vitest';
import {
  createGovernor,
  densityBand,
  FALLBACK_HZ,
  type FrameSample,
  type Governor,
  type GovernorEvent,
  type GovernorLevels,
  MAX_HOLD_MS,
  MAX_PROBE_WAIT_MS,
  MIN_BAND_DENSITY,
  MIN_SHED_YIELD,
  NO_GAIN_HOLD_MS,
  NO_GAIN_SHARE,
  RECOVER_AFTER_MS,
  RESTORE_HOLD_MS,
  WARMUP_MS,
} from '../src/render/governor.ts';
import {
  BEAUTY_BAND_DENSITY,
  BEAUTY_BAND_SIZE,
  DEFAULT_BAND_DENSITY,
  DEFAULT_BAND_SIZE,
  STROKE_BUDGET,
  type StrokeBand,
} from '../src/render/strokes/bands.ts';
import { mulberry32 } from '../src/util/prng.ts';

type Drawn = Record<StrokeBand, number>;

/** Plenty drawn in every band, so the 150k floor never binds. */
const PLENTY: Drawn = { near: 1_000_000, mid: 1_000_000, far: 1_000_000 };
const OVER = 16;
const CLEAN = 8;
/** Each step shed takes this share off the interval in `shedding`, a gain over `NO_GAIN_SHARE`. */
const SHED_GAIN = 0.95;

/**
 * An overrun that each shed step helps: the interval falls 5% per step shed and still overruns the
 * 72 Hz budget at all 15 steps (32 × 0.95^15 = 14.8 ms), so every shed sticks.
 */
function shedding(gov: Governor, start = 32): () => number {
  return () => start * SHED_GAIN ** gov.snapshot().level;
}

interface Trace {
  /** Frame interval for the next frame, from the governor's current levels and the time. */
  interval: (levels: GovernorLevels, t: number) => number;
  drawn?: (levels: GovernorLevels) => Drawn;
  gpuMs?: number | null;
  /** Stops early once this returns true for an event. */
  until?: (event: GovernorEvent) => boolean;
  /** What the runtime reports back for a rate request; default 'apply'. */
  rate?: 'apply' | 'fail' | 'pending';
}

/** Feeds frames for `durationMs` from `start` and returns the events and the end time. */
function drive(
  gov: Governor,
  start: number,
  durationMs: number,
  trace: Trace,
): { events: GovernorEvent[]; t: number } {
  const events: GovernorEvent[] = [];
  let t = start;
  while (t < start + durationMs) {
    const intervalMs = trace.interval(gov.levels, t);
    t += intervalMs;
    const sample: FrameSample = {
      t,
      intervalMs,
      gpuMs: trace.gpuMs ?? null,
      drawn: trace.drawn ? trace.drawn(gov.levels) : PLENTY,
    };
    const event = gov.sample(sample);
    if (event) {
      events.push(event);
      if (event.action === 'rate' && (trace.rate ?? 'apply') === 'apply') {
        gov.rateApplied(event.to);
      } else if (event.action === 'rate' && trace.rate === 'fail') {
        const failed = gov.rateFailed(t);
        if (failed) events.push(failed);
      }
      if (trace.until?.(event)) break;
    }
  }
  return { events, t };
}

/** Run-length summary of `action step` pairs. */
function summary(events: readonly GovernorEvent[]): string[] {
  const out: string[] = [];
  let last = '';
  let n = 0;
  for (const e of events) {
    const key = `${e.action} ${e.step}`;
    if (key === last) {
      n++;
      continue;
    }
    if (last) out.push(`${last} x${n}`);
    last = key;
    n = 1;
  }
  if (last) out.push(`${last} x${n}`);
  return out;
}

/** Stops a drive on a density shed. */
const isDensity = (e: GovernorEvent): boolean => densityBand(e.step) !== null;
/** Stops a drive once near density reaches its minimum: the last shed step. */
const nearAtMinimum = (gov: Governor) => (e: GovernorEvent) =>
  e.step === 'near-density' && gov.levels.density.near <= MIN_BAND_DENSITY.near;

const SHED_SEQUENCE = [
  'shed foveation x1',
  'shed fb-scale x1',
  'shed foveation-max x1',
  'shed far-density x4',
  // Mid's fifth step, 0.22 to the 0.2 minimum, cuts under 3% of the drawn total and is skipped.
  'shed mid-density x4',
  'shed near-density x4',
];

describe('governor shedding', () => {
  test('a sustained overrun sheds foveation 0.5, fb scale, foveation 1, far, mid, near, then 72 Hz', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events, t } = drive(gov, 0, 60_000, {
      interval: shedding(gov),
      until: (e) => e.action === 'rate',
    });
    expect(summary(events)).toEqual([...SHED_SEQUENCE, 'rate frame-rate x1']);
    const levels = gov.levels;
    expect(levels.density).toEqual({ ...MIN_BAND_DENSITY, mid: expect.closeTo(0.216, 3) });
    expect(levels.fbScale).toBe(0.85);
    expect(levels.foveation).toBe(1);
    expect(gov.snapshot().foveation).toBe(1);
    expect(events.filter((e) => e.step.startsWith('foveation')).map((e) => [e.from, e.to])).toEqual(
      [
        [0, 0.5],
        [0.5, 1],
      ],
    );
    const lastShed = events.filter((e) => e.action === 'shed').at(-1);
    const rate = events.find((e) => e.action === 'rate');
    expect(rate).toMatchObject({ from: 90, to: FALLBACK_HZ });
    // 3 s of continuous overrun at minimum quality, judged on 0.5 s windows.
    const wait = (rate?.t ?? 0) - (lastShed?.t ?? 0);
    expect(wait).toBeGreaterThanOrEqual(3000);
    expect(wait).toBeLessThan(3000 + 2 * 500 + OVER * 2);
    const snap = gov.snapshot();
    expect(snap.targetHz).toBe(72);
    expect(snap.budgetMs).toBeCloseTo(1000 / 72, 6);
    expect(snap.notice).toMatch(/72 Hz/);
    // Still overrunning at 72 with nothing left to shed; recovery waits 5 s (tested below).
    expect(drive(gov, t, 5000, { interval: shedding(gov) }).events).toEqual([]);
    expect(gov.snapshot().exhausted).toBe(true);
    expect(gov.snapshot().history.at(-1)?.action).toBe('rate');
  });

  test('the first shed waits out the warm-up and one full 0.5 s window', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events } = drive(gov, 0, 5000, { interval: () => OVER, until: () => true });
    expect(events[0].step).toBe('foveation');
    expect(events[0].t).toBeGreaterThanOrEqual(WARMUP_MS + 500);
    expect(events[0].t).toBeLessThan(WARMUP_MS + 500 + 3 * OVER);
  });

  test('each density shed multiplies by 0.7 and raises the size by 1/sqrt of the density ratio', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    drive(gov, 0, 10_000, { interval: () => OVER, until: isDensity });
    expect(gov.levels.density.far).toBeCloseTo(DEFAULT_BAND_DENSITY.far * 0.7, 10);
    expect(gov.levels.size.far).toBeCloseTo(DEFAULT_BAND_SIZE.far * Math.sqrt(1 / 0.7), 10);
    expect(gov.levels.density.mid).toBe(DEFAULT_BAND_DENSITY.mid);
  });

  test('a band that draws nothing is skipped: shedding it would buy no time', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events } = drive(gov, 0, 10_000, {
      interval: () => OVER,
      drawn: () => ({ near: 400_000, mid: 300_000, far: 0 }),
      until: isDensity,
    });
    expect(events.at(-1)?.step).toBe('mid-density');
  });

  /** 300k near, 100k mid and a sparse 4k far at the default densities, scaling with density. */
  const sparseFar = (levels: GovernorLevels): Drawn => ({
    near: Math.floor(300_000 * levels.density.near),
    mid: Math.floor((100_000 * levels.density.mid) / DEFAULT_BAND_DENSITY.mid),
    far: Math.floor((4_000 * levels.density.far) / DEFAULT_BAND_DENSITY.far),
  });

  test('a band whose shed would save under the no-gain bar (3%) of the drawn strokes is skipped', () => {
    // One constant: a step that cuts less than the bar cannot pass the no-gain check.
    expect(MIN_SHED_YIELD).toBe(NO_GAIN_SHARE);
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events } = drive(gov, 0, 10_000, {
      interval: () => OVER,
      drawn: sparseFar,
      until: isDensity,
    });
    // Far would save 1.2k of 404k (0.3%); mid saves 30k (7%).
    expect(events.at(-1)?.step).toBe('mid-density');
    expect(gov.levels.density.far).toBe(DEFAULT_BAND_DENSITY.far);
  });

  test('skipping a sparse band keeps the full shed and restore exactly reversible (M5)', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 60_000, {
      interval: shedding(gov),
      drawn: sparseFar,
      until: (e) => e.action === 'rate',
    });
    const shedEvents = shed.events.filter((e) => e.action === 'shed');
    const sheds = summary(shedEvents);
    expect(sheds.some((s) => s.includes('far-density'))).toBe(false);
    expect(sheds.at(-1)).toMatch(/^shed near-density x\d+$/);
    const restore = drive(gov, shed.t, 200_000, { interval: () => CLEAN, drawn: sparseFar });
    expect(restore.events.map((e) => e.step)).toEqual(shedEvents.map((e) => e.step).reverse());
    for (let i = 0; i < restore.events.length; i++) {
      const back = shedEvents[shedEvents.length - 1 - i];
      expect(restore.events[i]).toMatchObject({ action: 'restore', from: back.to, to: back.from });
    }
    expect(gov.levels.density).toEqual(DEFAULT_BAND_DENSITY);
    expect(gov.levels.size).toEqual(DEFAULT_BAND_SIZE);
    expect(gov.levels.foveation).toBe(0);
    expect(gov.snapshot().level).toBe(0);
  });

  test('a short overrun spike under 5% of budget on the window mean does not shed', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    // Vsync-locked: mostly on time, with one dropped frame (two intervals' worth) every 30.
    let i = 0;
    const { events } = drive(gov, 0, 30_000, {
      interval: () => (i++ % 30 === 29 ? 2000 / 90 : 1000 / 90),
    });
    expect(events).toEqual([]);
  });
});

describe('governor floor (ruling R10)', () => {
  test('density never sheds the drawn count below the 150k minimum', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const drawn = (levels: GovernorLevels): Drawn => ({
      near: Math.floor(200_000 * levels.density.near),
      mid: 0,
      far: 0,
    });
    const { events } = drive(gov, 0, 30_000, {
      interval: shedding(gov),
      drawn,
      until: (e) => e.action === 'rate',
    });
    expect(summary(events)).toEqual([
      'shed foveation x1',
      'shed fb-scale x1',
      'shed foveation-max x1',
      'shed near-density x1',
      'rate frame-rate x1',
    ]);
    // 0.7 would draw 140k; the step clamps to the floor instead.
    expect(gov.levels.density.near).toBeCloseTo(STROKE_BUDGET.default.min / 200_000, 10);
    expect(drawn(gov.levels).near).toBeGreaterThanOrEqual(STROKE_BUDGET.default.min - 1);
    expect(gov.snapshot().densityMin).toBe(true);
  });

  test('a view already under the floor sheds no density at all', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events } = drive(gov, 0, 10_000, {
      interval: () => OVER,
      drawn: () => ({ near: 100_000, mid: 20_000, far: 10_000 }),
    });
    expect(events.some((e) => e.step === 'fb-scale')).toBe(true);
    expect(events.some(isDensity)).toBe(false);
    expect(gov.levels.density).toEqual(DEFAULT_BAND_DENSITY);
  });

  test('per-band minimum densities hold even with an unlimited view', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    drive(gov, 0, 60_000, { interval: shedding(gov) });
    for (const band of ['near', 'mid', 'far'] as const) {
      expect(gov.levels.density[band]).toBeGreaterThanOrEqual(MIN_BAND_DENSITY[band]);
      expect(MIN_BAND_DENSITY[band]).toBeGreaterThan(0);
    }
  });
});

describe('governor restore', () => {
  test('restores step by step in the exact reverse order, back to the start levels', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 60_000, {
      interval: shedding(gov),
      until: nearAtMinimum(gov),
    });
    expect(summary(shed.events)).toEqual(SHED_SEQUENCE);
    const restore = drive(gov, shed.t, 120_000, { interval: () => CLEAN });
    expect(summary(restore.events)).toEqual([
      'restore near-density x4',
      'restore mid-density x4',
      'restore far-density x4',
      'restore foveation-max x1',
      'restore fb-scale x1',
      'restore foveation x1',
    ]);
    // Each probe needs 3 s of clean windows after the previous change.
    let previous = shed.t;
    for (const event of restore.events) {
      expect(event.t - previous).toBeGreaterThanOrEqual(RESTORE_HOLD_MS);
      previous = event.t;
    }
    const levels = gov.levels;
    expect(levels.density).toEqual(DEFAULT_BAND_DENSITY);
    expect(levels.size).toEqual(DEFAULT_BAND_SIZE);
    expect(levels.fbScale).toBe(1);
    expect(gov.snapshot().foveation).toBe(0);
    expect(gov.snapshot().level).toBe(0);
    expect(gov.snapshot().step).toBe('none');
  });

  test('at the budget with ±5% jitter it never sheds, and from a shed level only restores', () => {
    const rand = mulberry32(90);
    const atBudget = () => (1000 / 90) * (1 + (rand() - 0.5) * 0.1);
    const fresh = createGovernor({ mode: 'default', targetHz: 90 });
    expect(drive(fresh, 0, 60_000, { interval: atBudget }).events).toEqual([]);

    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    let sheds = 0;
    const shed = drive(gov, 0, 10_000, { interval: shedding(gov), until: () => ++sheds === 6 });
    expect(gov.snapshot().level).toBe(6);
    const { events } = drive(gov, shed.t, 60_000, { interval: atBudget });
    expect(events).toHaveLength(6);
    expect(events.every((e) => e.action === 'restore')).toBe(true);
    expect(gov.snapshot().level).toBe(0);
  });

  test('a failed probe sheds back and doubles the wait, capped at 24 s', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 5000, { interval: () => OVER, until: () => true });
    expect(gov.snapshot().level).toBe(1);
    // Level 1 fits the budget; level 0 overruns. Every probe fails.
    const { events } = drive(gov, shed.t, 120_000, {
      interval: () => (gov.snapshot().level === 0 ? OVER : CLEAN),
    });
    const pairs = summary(events);
    expect(pairs[0]).toBe('restore foveation x1');
    expect(pairs[1]).toBe('shed-back foveation x1');
    const waits: number[] = [];
    for (let i = 1; i + 1 < events.length; i += 2) {
      expect(events[i].action).toBe('shed-back');
      expect(events[i + 1].action).toBe('restore');
      waits.push(events[i + 1].t - events[i].t);
    }
    const expected = [6000, 12_000, 24_000, 24_000];
    expect(waits.length).toBeGreaterThanOrEqual(expected.length);
    expected.forEach((wait, i) => {
      expect(waits[i]).toBeGreaterThanOrEqual(wait);
      expect(waits[i]).toBeLessThan(wait + 600);
    });
    expect(gov.snapshot().probeWaitMs).toBe(MAX_PROBE_WAIT_MS);
  });

  test('a long clean run after a failure resets the probe wait to 3 s', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    let sheds = 0;
    const shed = drive(gov, 0, 10_000, { interval: shedding(gov), until: () => ++sheds === 3 });
    // The first probe fails, doubling the wait.
    let failed = false;
    const fail = drive(gov, shed.t, 20_000, {
      interval: () => (!failed && gov.snapshot().level === 2 ? OVER : CLEAN),
      until: (e) => {
        if (e.action === 'shed-back') failed = true;
        return failed;
      },
    });
    expect(gov.snapshot().probeWaitMs).toBe(2 * RESTORE_HOLD_MS);
    drive(gov, fail.t, 31_000, { interval: () => CLEAN });
    expect(gov.snapshot().probeWaitMs).toBe(RESTORE_HOLD_MS);
  });

  test('a clean window between overruns at minimum quality restarts the 3 s rate count', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 60_000, {
      interval: shedding(gov),
      until: nearAtMinimum(gov),
    });
    // 2.5 s overrun, one clean window, then overrun again: the request waits 3 s from the restart.
    const over = shedding(gov);
    const { events } = drive(gov, shed.t, 20_000, {
      interval: (_l, t) => (t > shed.t + 2500 && t < shed.t + 3050 ? CLEAN : over()),
      until: (e) => e.action === 'rate',
    });
    expect(events.map((e) => e.action)).toEqual(['rate']);
    // Without the restart it would fire about 3 s after the last shed.
    expect(events[0].t - shed.t).toBeGreaterThan(2500 + 3000);
  });

  test('after the 72 Hz drop, quality restores at 72 and the rate stays at 72', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 60_000, {
      interval: shedding(gov),
      until: (e) => e.action === 'rate',
    });
    // 13 ms fits the 72 Hz budget (13.9 ms) but not 90's.
    const { events } = drive(gov, shed.t, 120_000, { interval: () => 13 });
    expect(events.length).toBe(15);
    expect(events.every((e) => e.action === 'restore')).toBe(true);
    expect(gov.snapshot().targetHz).toBe(72);
    expect(gov.levels.density).toEqual(DEFAULT_BAND_DENSITY);
  });

  test('with a GPU timer, restore also needs GPU headroom; GPU time alone never sheds', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 5000, { interval: () => OVER, until: () => true });
    const busy = drive(gov, shed.t, 20_000, { interval: () => CLEAN, gpuMs: 10.5 });
    expect(busy.events).toEqual([]);
    const idle = drive(gov, busy.t, 5000, { interval: () => CLEAN, gpuMs: 4 });
    expect(summary(idle.events)).toEqual(['restore foveation x1']);
    const fresh = createGovernor({ mode: 'default', targetHz: 90 });
    expect(drive(fresh, 0, 10_000, { interval: () => CLEAN, gpuMs: 30 }).events).toEqual([]);
  });
});

describe('governor inputs', () => {
  test('budget is 1000 / target Hz for 72, 80, 90 and 120, shed above 5% over', () => {
    for (const hz of [72, 80, 90, 120]) {
      const gov = createGovernor({ mode: 'default', targetHz: hz });
      expect(gov.snapshot().budgetMs).toBeCloseTo(1000 / hz, 10);
      const under = drive(gov, 0, 5000, { interval: () => (1000 / hz) * 1.04 });
      expect(under.events).toEqual([]);
      const over = drive(gov, under.t, 5000, {
        interval: () => (1000 / hz) * 1.07,
        until: () => true,
      });
      expect(over.events[0]?.action).toBe('shed');
    }
  });

  test('80 and 120 Hz also fall back to 72; a 72 Hz target has no lower rate to request', () => {
    for (const hz of [80, 120]) {
      const gov = createGovernor({ mode: 'default', targetHz: hz });
      const { events } = drive(gov, 0, 60_000, { interval: shedding(gov, 40) });
      expect(events.find((e) => e.action === 'rate')).toMatchObject({ from: hz, to: 72 });
    }
    const gov = createGovernor({ mode: 'beauty', targetHz: 72 });
    const { events } = drive(gov, 0, 60_000, { interval: shedding(gov, 40) });
    expect(events.some((e) => e.action === 'rate')).toBe(false);
    expect(gov.snapshot().exhausted).toBe(true);
  });

  test('beauty mode starts from the max-beauty densities and the 72 Hz budget', () => {
    const gov = createGovernor({ mode: 'beauty', targetHz: 72 });
    expect(gov.levels.density).toEqual(BEAUTY_BAND_DENSITY);
    expect(gov.levels.size).toEqual(BEAUTY_BAND_SIZE);
    expect(gov.snapshot()).toMatchObject({ mode: 'beauty', targetHz: 72 });
  });

  test('frames in the warm-up and stalls over 100 ms are ignored', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    // Session start uploads 200k instances: the first second may hitch badly.
    const warm = drive(gov, 0, WARMUP_MS - 50, { interval: () => 50 });
    expect(warm.events).toEqual([]);
    let i = 0;
    const { events } = drive(gov, warm.t, 10_000, {
      interval: () => (i++ % 20 === 0 ? 400 : CLEAN),
    });
    expect(events).toEqual([]);
  });

  test('history is bounded and records time, action, step, from and to', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 5000, { interval: () => OVER, until: () => true });
    drive(gov, shed.t, 2_000_000, {
      interval: () => (gov.snapshot().level === 0 ? OVER : CLEAN),
    });
    const { history } = gov.snapshot();
    expect(history.length).toBeLessThanOrEqual(64);
    expect(history[0]).toEqual({
      t: expect.any(Number),
      action: expect.stringMatching(/shed|restore/),
      step: 'foveation',
      from: expect.any(Number),
      to: expect.any(Number),
    });
  });
});

describe('governor pauses and real frame rates (fix round 1)', () => {
  /** Sheds to minimum quality at 90 Hz and returns the time of the last near-density shed. */
  function toMinimum(gov: Governor): number {
    return drive(gov, 0, 60_000, { interval: shedding(gov), until: nearAtMinimum(gov) }).t;
  }

  test('a 2.5 s stall does not count toward the 3 s overrun before the 72 Hz request', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const before = drive(gov, toMinimum(gov), 1200, { interval: shedding(gov) });
    expect(before.events).toEqual([]);
    // One paused interval, then overrun frames again.
    const resume = before.t + 2500;
    expect(gov.sample({ t: resume, intervalMs: 2500, drawn: PLENTY })).toBeNull();
    const { events } = drive(gov, resume, 10_000, {
      interval: shedding(gov),
      until: (e) => e.action === 'rate',
    });
    expect(events.map((e) => e.action)).toEqual(['rate']);
    expect(events[0].t - resume).toBeGreaterThanOrEqual(3000);
  });

  test('a stall does not count toward the 3 s restore hold either', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 5000, { interval: () => OVER, until: () => true });
    const clean = drive(gov, shed.t, 2000, { interval: () => CLEAN });
    expect(clean.events).toEqual([]);
    const resume = clean.t + 2500;
    gov.sample({ t: resume, intervalMs: 2500, drawn: PLENTY });
    const { events } = drive(gov, resume, 10_000, { interval: () => CLEAN, until: () => true });
    expect(events[0].action).toBe('restore');
    expect(events[0].t - resume).toBeGreaterThanOrEqual(RESTORE_HOLD_MS);
  });

  test('interrupt() (a hidden session) restarts the windows and both timers', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const before = drive(gov, toMinimum(gov), 2000, { interval: shedding(gov) });
    gov.interrupt();
    const { events } = drive(gov, before.t, 10_000, {
      interval: shedding(gov),
      until: (e) => e.action === 'rate',
    });
    expect(events[0].t - before.t).toBeGreaterThanOrEqual(3000);
  });

  test('the budget follows the reported frame rate, not the configured one', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    gov.setFrameRate(72);
    expect(gov.snapshot()).toMatchObject({ targetHz: 90, frameRate: 72 });
    expect(gov.snapshot().budgetMs).toBeCloseTo(1000 / 72, 10);
    // 13 ms overruns 90 Hz but fits 72.
    expect(drive(gov, 0, 10_000, { interval: () => 13 }).events).toEqual([]);
  });

  test('already running at 72 Hz there is no rate step to request', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    gov.setFrameRate(72);
    const { events } = drive(gov, 0, 60_000, { interval: shedding(gov, 40) });
    expect(events.some((e) => e.action === 'rate')).toBe(false);
    expect(gov.snapshot().exhausted).toBe(true);
  });

  test('the 72 Hz budget and notice wait for the request to resolve', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events, t } = drive(gov, toMinimum(gov), 10_000, {
      interval: shedding(gov),
      rate: 'pending',
    });
    expect(events.map((e) => e.action)).toEqual(['rate']);
    expect(gov.snapshot()).toMatchObject({
      targetHz: 90,
      frameRate: 90,
      notice: null,
      rateRequest: 'pending',
      exhausted: false,
    });
    gov.rateApplied(72);
    expect(gov.snapshot()).toMatchObject({ targetHz: 72, frameRate: 72, rateRequest: 'applied' });
    expect(gov.snapshot().notice).toMatch(/72 Hz/);
    expect(drive(gov, t, 5000, { interval: shedding(gov) }).events).toEqual([]);
    expect(gov.snapshot().exhausted).toBe(true);
  });

  test('a failed rate request marks the step unavailable: exhausted, no notice, no retry', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events } = drive(gov, toMinimum(gov), 30_000, {
      interval: shedding(gov),
      rate: 'fail',
    });
    // After the failure only recovery acts (tested below); the rate is never asked again.
    expect(summary(events).slice(0, 2)).toEqual([
      'rate frame-rate x1',
      'rate-failed frame-rate x1',
    ]);
    expect(events.filter((e) => e.action === 'rate')).toHaveLength(1);
    expect(events.slice(2).every((e) => e.action.startsWith('recover'))).toBe(true);
    expect(events[1]).toMatchObject({ from: 90, to: 90 });
    expect(gov.snapshot()).toMatchObject({
      targetHz: 90,
      frameRate: 90,
      notice: null,
      rateRequest: 'unavailable',
      exhausted: true,
    });
    expect(gov.snapshot().budgetMs).toBeCloseTo(1000 / 90, 10);
  });

  test('a shed-back re-clamps density to the floor of the current view', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 10_000, { interval: () => OVER, until: isDensity });
    expect(gov.levels.density.far).toBeCloseTo(0.28, 10);
    // After the restore the view has changed: 60k near and 100k far at far density 0.4.
    let restored = false;
    const { events } = drive(gov, shed.t, 10_000, {
      interval: () => (gov.snapshot().level === 0 ? OVER : CLEAN),
      drawn: () => (restored ? { near: 60_000, mid: 0, far: 100_000 } : PLENTY),
      until: (e) => {
        if (e.action === 'restore') restored = true;
        return e.action === 'shed-back';
      },
    });
    expect(summary(events)).toEqual(['restore far-density x1', 'shed-back far-density x1']);
    // 0.28 would draw 60k + 70k = 130k; the floor needs 0.4 * (1 - 10k / 100k) = 0.36.
    expect(events[1].to).toBeCloseTo(0.36, 10);
    expect(gov.levels.density.far).toBeCloseTo(0.36, 10);
    expect(gov.levels.size.far).toBeCloseTo(DEFAULT_BAND_SIZE.far * Math.sqrt(0.4 / 0.36), 10);
  });
});

describe('governor no-gain rule', () => {
  // A density no-gain holds every band ('density'), so mid and near are never tried.
  const UNDONE = [
    'shed foveation x1',
    'no-gain foveation x1',
    'shed fb-scale x1',
    'no-gain fb-scale x1',
    'shed foveation-max x1',
    'no-gain foveation-max x1',
    'shed far-density x1',
    'no-gain far-density x1',
  ];

  test('a shed that does not help is undone at once and not retried within the hold', () => {
    expect(NO_GAIN_SHARE).toBe(0.03);
    expect(NO_GAIN_HOLD_MS).toBe(30_000);
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    // A CPU-bound frame: shedding changes nothing. The rate request stays pending, so the frame
    // rate never changes and the holds can only lapse by time.
    const { events } = drive(gov, 0, 25_000, { interval: () => OVER, rate: 'pending' });
    expect(summary(events)).toEqual([...UNDONE, 'rate frame-rate x1']);
    for (let i = 0; i < UNDONE.length; i += 2) {
      const shed = events[i];
      const undo = events[i + 1];
      // Undone on the first window after the shed, back to the exact level it shed from.
      expect(undo).toMatchObject({
        action: 'no-gain',
        step: shed.step,
        from: shed.to,
        to: shed.from,
      });
      expect(undo.t - shed.t).toBeGreaterThanOrEqual(500);
      expect(undo.t - shed.t).toBeLessThan(500 + 2 * OVER);
    }
    expect(gov.levels.density).toEqual(DEFAULT_BAND_DENSITY);
    expect(gov.levels.size).toEqual(DEFAULT_BAND_SIZE);
    expect(gov.levels.fbScale).toBe(1);
    expect(gov.levels.foveation).toBe(0);
    const snap = gov.snapshot();
    expect(snap.level).toBe(0);
    expect(snap.densityMin).toBe(true);
    expect(snap.noGainHeld).toEqual(['foveation', 'fb-scale', 'foveation-max', 'density']);
  });

  test('the hold lapses after 30 s and the step is tried again', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events } = drive(gov, 0, 40_000, { interval: () => OVER, rate: 'pending' });
    const first = events.find((e) => e.action === 'no-gain' && e.step === 'far-density');
    const retry = events.filter((e) => e.action === 'shed' && e.step === 'far-density')[1];
    expect(retry).toBeDefined();
    expect((retry?.t ?? 0) - (first?.t ?? 0)).toBeGreaterThanOrEqual(NO_GAIN_HOLD_MS);
    expect((retry?.t ?? 0) - (first?.t ?? 0)).toBeLessThan(NO_GAIN_HOLD_MS + 600);
  });

  test('a shed that helps sticks', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    // Each step takes 5% off the interval: over the 3% bar, and still overrunning.
    const { events } = drive(gov, 0, 8000, { interval: shedding(gov) });
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events.every((e) => e.action === 'shed')).toBe(true);
    expect(gov.snapshot().level).toBe(events.length);
    expect(gov.snapshot().noGainHeld).toEqual([]);
  });

  test('a gain just under 3% is undone; one just over sticks', () => {
    const run = (gain: number) => {
      const gov = createGovernor({ mode: 'default', targetHz: 90 });
      const interval = () => (gov.snapshot().level === 0 ? 20 : 20 * (1 - gain));
      return summary(drive(gov, 0, 2600, { interval, until: (e) => e.action !== 'shed' }).events);
    };
    expect(run(0.025)).toEqual(['shed foveation x1', 'no-gain foveation x1']);
    // The first shed sticks; the second gains nothing more and is undone.
    expect(run(0.035)).toEqual(['shed foveation x1', 'shed fb-scale x1', 'no-gain fb-scale x1']);
  });

  test('a shed that brings the window under budget sticks, even with a small gain', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    // 11.9 ms overruns the 11.67 ms shed line; 11.6 ms is 2.5% better and under it.
    const interval = () => (gov.snapshot().level === 0 ? 11.9 : 11.6);
    const { events } = drive(gov, 0, 4000, { interval });
    expect(summary(events)).toEqual(['shed foveation x1']);
    expect(gov.snapshot().level).toBe(1);
  });

  test('with every step held, the 72 Hz request still fires after 3 s of overrun', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events } = drive(gov, 0, 20_000, {
      interval: () => OVER,
      until: (e) => e.action === 'rate',
    });
    expect(summary(events)).toEqual([...UNDONE, 'rate frame-rate x1']);
    const rate = events.at(-1);
    const lastUndo = events.at(-2);
    expect(rate).toMatchObject({ action: 'rate', from: 90, to: FALLBACK_HZ });
    expect((rate?.t ?? 0) - (lastUndo?.t ?? 0)).toBeGreaterThanOrEqual(3000);
    expect((rate?.t ?? 0) - (lastUndo?.t ?? 0)).toBeLessThan(3000 + 2 * 500 + 2 * OVER);
    // The applied 72 Hz rate is a frame-rate change: it clears the holds, so 72 Hz tries again.
    expect(gov.snapshot().noGainHeld).toEqual([]);
    const after = drive(gov, events.at(-1)?.t ?? 0, 3000, { interval: () => OVER });
    expect(summary(after.events).slice(0, 2)).toEqual([
      'shed foveation x1',
      'no-gain foveation x1',
    ]);
  });

  test.each([
    ['interrupt()', (gov: Governor) => gov.interrupt()],
    ['a reported frame-rate change', (gov: Governor) => gov.setFrameRate(80)],
  ])('%s clears the holds', (_name, clear) => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const held = drive(gov, 0, 10_000, {
      interval: () => OVER,
      until: (e) => e.action === 'no-gain',
    });
    expect(gov.snapshot().noGainHeld).toEqual(['foveation']);
    clear(gov);
    expect(gov.snapshot().noGainHeld).toEqual([]);
    const { events } = drive(gov, held.t, 5000, { interval: () => OVER, until: () => true });
    expect(events[0]).toMatchObject({ action: 'shed', step: 'foveation' });
  });

  test('an unchanged reported frame rate keeps the holds', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    drive(gov, 0, 10_000, { interval: () => OVER, until: (e) => e.action === 'no-gain' });
    gov.setFrameRate(90);
    expect(gov.snapshot().noGainHeld).toEqual(['foveation']);
  });

  test('a shed-back after a failed probe is never undone as no-gain', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 5000, { interval: () => 20, until: () => true });
    // Level 1 is clean and level 0 overruns, so the probe fails; then everything overruns alike.
    let shedBack = false;
    const { events } = drive(gov, shed.t, 10_000, {
      interval: () => (shedBack || gov.snapshot().level === 0 ? 20 : CLEAN),
      until: (e) => {
        if (e.action === 'shed-back') shedBack = true;
        return shedBack && e.action !== 'shed-back';
      },
    });
    expect(summary(events)).toEqual([
      'restore foveation x1',
      'shed-back foveation x1',
      'shed fb-scale x1',
    ]);
  });

  test('a restore and a no-gain undo leave the shed stack consistent', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    // Foveation helps (level 0 -> 1); fb scale does not.
    const interval = () => (gov.snapshot().level === 0 ? 20 : 18);
    const { events } = drive(gov, 0, 3000, { interval, until: (e) => e.action === 'no-gain' });
    expect(summary(events)).toEqual([
      'shed foveation x1',
      'shed fb-scale x1',
      'no-gain fb-scale x1',
    ]);
    expect(gov.snapshot().level).toBe(1);
    expect(gov.levels.foveation).toBe(0.5);
    expect(gov.levels.fbScale).toBe(1);
    expect(gov.snapshot().noGainHeld).toEqual(['fb-scale']);
    const restore = drive(gov, events.at(-1)?.t ?? 0, 10_000, { interval: () => CLEAN });
    expect(summary(restore.events)).toEqual(['restore foveation x1']);
    expect(gov.levels.foveation).toBe(0);
  });
});

describe('governor overrun recovery (ruling Q26)', () => {
  const VSYNC = 1000 / 72;
  /** The reviewer's 24 m painter-spot split at the default densities (216k drawn). */
  const SPLIT = { near: 60_000, mid: 110_000, far: 46_000 };
  const splitDrawn = (levels: GovernorLevels): Drawn => ({
    near: Math.floor(SPLIT.near * levels.density.near),
    mid: Math.floor((SPLIT.mid * levels.density.mid) / DEFAULT_BAND_DENSITY.mid),
    far: Math.floor((SPLIT.far * levels.density.far) / DEFAULT_BAND_DENSITY.far),
  });

  interface Run {
    gov: Governor;
    events: GovernorEvent[];
    /** Steps shed, averaged over frame time from 30 s on. */
    meanLevel: number;
    /** The lowest level seen from 30 s on: 0 once every stuck step has come back. */
    minLevel: number;
  }

  /**
   * A 72 Hz vsync-locked frame: each frame takes 1 or 2 vsyncs, missing with `miss(level)`. A
   * constant miss rate is a fully CPU-bound frame (0.31 is about 55 fps, 0.06 about 68), where
   * half-second window means vary by 4-7%, more than the 3% bar, so useless sheds stick by chance
   * (governor review I1).
   */
  function vsyncTrace(miss: (level: number) => number, seed: number, ms: number): Run {
    const gov = createGovernor({ mode: 'default', targetHz: 72 });
    const rand = mulberry32(seed);
    const events: GovernorEvent[] = [];
    let t = 0;
    let levelTime = 0;
    let total = 0;
    let minLevel = Number.POSITIVE_INFINITY;
    while (t < ms) {
      const interval = rand() < miss(gov.snapshot().level) ? 2 * VSYNC : VSYNC;
      t += interval;
      const event = gov.sample({ t, intervalMs: interval, drawn: splitDrawn(gov.levels) });
      if (event) events.push(event);
      if (t >= 30_000) {
        const level = gov.snapshot().level;
        total += interval;
        levelTime += interval * level;
        minLevel = Math.min(minLevel, level);
      }
    }
    return { gov, events, meanLevel: levelTime / total, minLevel };
  }

  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

  test.each([0.31, 0.15, 0.06])(
    'CPU-bound at miss rate %s with window noise: stuck sheds come back, no ratchet',
    (miss) => {
      const meanLevels: number[] = [];
      for (const seed of SEEDS) {
        const { events, meanLevel, minLevel } = vsyncTrace(() => miss, seed, 120_000);
        // Some useless sheds stick by chance; recovery restores them.
        expect(
          events.some((e) => e.action === 'recover'),
          `seed ${seed}`,
        ).toBe(true);
        // Back at or next to the start levels after 30 s, and on average within three steps
        // (worst measured 2.88: seed 3 at miss rate 0.06).
        expect(minLevel, `seed ${seed} lowest level after 30 s`).toBeLessThanOrEqual(1);
        expect(meanLevel, `seed ${seed} mean level, 30-120 s`).toBeLessThan(3);
        meanLevels.push(meanLevel);
      }
      // Without recovery the same traces stick at a median of 4 steps (governor review I1).
      const mean = meanLevels.reduce((a, b) => a + b, 0) / meanLevels.length;
      // Worst measured 0.76 (miss rate 0.15).
      expect(mean).toBeLessThan(2);
    },
  );

  test.each([0.31, 0.15, 0.06])(
    'CPU-bound at miss rate %s over 600 s: the back-off does not ratchet the level up',
    (miss) => {
      // The recovery-hold doubling never resets on a CPU-bound frame (the rate never changes), so
      // a chance recover-back holds its step from recovery for ever longer. These bounds track
      // the measured worst case over 30-600 s (mean 0.66, worst seed 1.79), not a target.
      const means = SEEDS.map((seed) => vsyncTrace(() => miss, seed, 600_000).meanLevel);
      const mean = means.reduce((a, b) => a + b, 0) / means.length;
      expect(mean, `mean over seeds ${JSON.stringify(means)}`).toBeLessThan(1);
      expect(Math.max(...means), 'worst seed').toBeLessThan(3.5);
    },
  );

  test('GPU-bound: restores that cost time are reverted and held, and the shed level stands', () => {
    // Each step shed takes 8 points off the miss rate (about 5% of the mean interval): 0.9 at full
    // quality, and still over the 72 Hz budget at the 150k floor.
    const miss = (level: number) => Math.max(0.1, 0.9 - 0.08 * level);
    for (const seed of [1, 2, 3, 4]) {
      const { events, meanLevel } = vsyncTrace(miss, seed, 120_000);
      const recovers = events.filter((e) => e.action === 'recover').length;
      const backs = events.filter((e) => e.action === 'recover-back').length;
      expect(recovers, `seed ${seed}`).toBeGreaterThan(0);
      // At least one restore is reverted (seed 3: 1 of 3). A recovery that window noise keeps now
      // holds every density band at once (the shared 'density' hold), so fewer re-tests revert.
      expect(backs, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      // 2.46 at worst (seed 1), for the same reason; it was over 2.5 with per-band holds.
      expect(meanLevel, `seed ${seed} mean level, 30-120 s`).toBeGreaterThan(2.2);
    }
  });

  test('a deterministic GPU-bound frame: every restore is reverted and held for 30 s', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 60_000, {
      interval: shedding(gov),
      until: (e) => e.action === 'rate',
    });
    expect(gov.snapshot().level).toBe(15);
    // At 72 Hz with every step shed, 14.8 ms still overruns; a restore costs 5%.
    const { events } = drive(gov, shed.t, 70_000, { interval: shedding(gov) });
    expect(summary(events)[0]).toBe('recover near-density x1');
    expect(summary(events)[1]).toBe('recover-back near-density x1');
    expect(events.every((e) => e.action === 'recover' || e.action === 'recover-back')).toBe(true);
    const recovers = events.filter((e) => e.action === 'recover');
    // The first after 5 s of overrun with nothing to shed; then one per hold lapse.
    expect(recovers[0].t - shed.t).toBeGreaterThanOrEqual(RECOVER_AFTER_MS);
    for (let i = 1; i < recovers.length; i++) {
      expect(recovers[i].t - recovers[i - 1].t).toBeGreaterThanOrEqual(NO_GAIN_HOLD_MS);
    }
    expect(recovers.length).toBeLessThanOrEqual(3);
    expect(gov.snapshot().level).toBe(15);
  });

  test('a deterministic CPU-bound frame: recovery restores every stuck step in reverse order', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    // A scene that sheds well, then turns CPU-bound: 20 ms whatever the level.
    const shed = drive(gov, 0, 60_000, {
      interval: shedding(gov),
      until: (e) => e.action === 'rate',
    });
    const { events } = drive(gov, shed.t, 180_000, { interval: () => 20 });
    const recovers = events.filter((e) => e.action === 'recover');
    expect(recovers.map((e) => e.step)).toEqual(
      shed.events
        .filter((e) => e.action === 'shed')
        .map((e) => e.step)
        .reverse(),
    );
    expect(events.some((e) => e.action === 'recover-back')).toBe(false);
    expect(gov.levels.density).toEqual(DEFAULT_BAND_DENSITY);
    expect(gov.levels.size).toEqual(DEFAULT_BAND_SIZE);
    expect(gov.levels.fbScale).toBe(1);
    expect(gov.levels.foveation).toBe(0);
    // One restore per 5 s (plus the check window) while nothing is left to shed.
    for (let i = 1; i < recovers.length; i++) {
      expect(recovers[i].t - recovers[i - 1].t).toBeGreaterThanOrEqual(RECOVER_AFTER_MS);
    }
  });

  test('a kept restore holds that step, so it is not shed straight back', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 60_000, {
      interval: shedding(gov),
      until: (e) => e.action === 'rate',
    });
    const { events } = drive(gov, shed.t, 7000, {
      interval: () => 20,
      until: (e) => e.action === 'recover',
    });
    const recovered = events.at(-1);
    expect(recovered).toMatchObject({ action: 'recover', step: 'near-density', from: 0.25 });
    const after = drive(gov, events.at(-1)?.t ?? 0, 3000, { interval: () => 20 });
    expect(after.events).toEqual([]);
    expect(gov.snapshot().noGainHeld).toContain('density');
  });

  test('recovery also runs after a failed 72 Hz request', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 60_000, {
      interval: shedding(gov),
      until: (e) => e.action === 'rate',
      rate: 'fail',
    });
    expect(gov.snapshot().rateRequest).toBe('unavailable');
    const { events } = drive(gov, shed.t, 10_000, { interval: () => 20 });
    expect(events.map((e) => e.action)).toContain('recover');
  });

  test('no recovery while the 72 Hz request is still to come or pending', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 60_000, {
      interval: shedding(gov),
      until: (e) => e.action === 'rate',
      rate: 'pending',
    });
    const { events } = drive(gov, shed.t, 20_000, { interval: () => 20 });
    expect(events).toEqual([]);
  });
});

describe('governor foveation steps and hold back-off (Quest 3 costs, 2026-11-06)', () => {
  const VSYNC = 1000 / 72;
  /**
   * Frame costs measured on the headset over CDP on 2026-11-06 (72 Hz, governor level 4, 3.5 s
   * windows, interleaved): base 22.39, 21.55 and 21.61 ms (mean 21.85), foveation 0.5 18.31 and
   * 18.22 ms (0.84 of base), foveation 1 18.08 and 17.24 ms (0.81 of base, about 3% past 0.5).
   */
  const SHIPPED_MS = 21.85;
  const FOVEATION_COST: Record<number, number> = { 0: 1, 0.5: 0.84, 1: 0.81 };

  interface FillRun {
    events: GovernorEvent[];
    /** Share of frame time from 10 s on spent where `pred` holds. */
    timeAt: (pred: (levels: GovernorLevels) => boolean) => number;
  }

  /**
   * A 72 Hz vsync-locked, GPU-bound frame: each frame takes 1 or 2 vsyncs, with a deterministic
   * debt so the mean interval tracks `cost(levels)` between 1 and 2 vsyncs. Density costs nothing.
   */
  function fillTrace(
    cost: (levels: GovernorLevels) => number,
    ms: number,
    /** With a generator, each frame misses its vsync at random instead, so windows carry noise. */
    rand?: () => number,
  ): FillRun {
    const gov = createGovernor({ mode: 'default', targetHz: 72 });
    const events: GovernorEvent[] = [];
    const samples: { levels: GovernorLevels; dt: number }[] = [];
    let t = 0;
    let debt = 0;
    while (t < ms) {
      let interval = VSYNC;
      if (rand) {
        const miss = Math.min(1, Math.max(0, cost(gov.levels) / VSYNC - 1));
        if (rand() < miss) interval = 2 * VSYNC;
      } else {
        debt += cost(gov.levels) - VSYNC;
        if (debt > 0) {
          interval = 2 * VSYNC;
          debt -= VSYNC;
        } else {
          debt = Math.max(debt, -VSYNC);
        }
      }
      t += interval;
      const event = gov.sample({ t, intervalMs: interval, drawn: PLENTY });
      if (event) events.push(event);
      if (t >= 10_000) {
        const { density, size, fbScale, foveation } = gov.levels;
        samples.push({
          levels: { density: { ...density }, size: { ...size }, fbScale, foveation },
          dt: interval,
        });
      }
    }
    const total = samples.reduce((a, s) => a + s.dt, 0);
    return {
      events,
      timeAt: (pred) => samples.reduce((a, s) => a + (pred(s.levels) ? s.dt : 0), 0) / total,
    };
  }

  test('a frame that fb scale helps sheds foveation and fb scale, keeps them, never density', () => {
    // Assumes fb scale applies, fill falling with the pixel count (scale squared). Quest Browser
    // ignores it on the projection layer, so this is a runtime that honours requestViewportScale.
    const cost = (l: GovernorLevels) => SHIPPED_MS * FOVEATION_COST[l.foveation] * l.fbScale ** 2;
    const { events, timeAt } = fillTrace(cost, 600_000);
    expect(summary(events.slice(0, 2))).toEqual(['shed foveation x1', 'shed fb-scale x1']);
    expect(events.some(isDensity)).toBe(false);
    // 18.4 ms at foveation 0.5, and 13.3 ms with fb scale 0.85 too: under budget, so both stay,
    // apart from a failed restore probe at most every 24 s.
    expect(timeAt((l) => l.foveation === 0.5 && l.fbScale === 0.85)).toBeGreaterThan(0.95);
    expect(timeAt((l) => l.foveation === 1)).toBe(0);
  });

  test('a frame that gains nothing from density stops oscillating: holds back off to 5 min', () => {
    // The headset as measured: foveation pays, fb scale is ignored and density buys nothing.
    const cost = (l: GovernorLevels) => SHIPPED_MS * FOVEATION_COST[l.foveation];
    const { events, timeAt } = fillTrace(cost, 600_000);
    // Foveation 1 sticks without noise: 17.7 ms is 3.6% under 0.5's 18.4 ms, just over the bar,
    // and still overruns, but it is the best the frame can do.
    expect(timeAt((l) => l.foveation === 1)).toBeGreaterThan(0.95);
    // One shared density hold: only far is ever tried. 30 s holds per band would shed about 60
    // times in 10 min (e0eac54: 65); one doubling hold sheds 5 times, at 0, 30, 90, 210 and 450 s.
    const density = events.filter(isDensity);
    expect(density.every((e) => e.step === 'far-density')).toBe(true);
    const sheds = density.filter((e) => e.action === 'shed');
    expect(sheds.length).toBeLessThanOrEqual(5);
    expect(sheds.length).toBeGreaterThanOrEqual(3);
    expect(density.length).toBe(2 * sheds.length);
    for (let i = 2; i < sheds.length; i++) {
      const gap = sheds[i].t - sheds[i - 1].t;
      expect(gap).toBeGreaterThan(1.9 * (sheds[i - 1].t - sheds[i - 2].t) - 2000);
    }
    expect(timeAt((l) => l.density.near < DEFAULT_BAND_DENSITY.near)).toBeLessThan(0.01);
    // Recovery re-tests foveation 1, finds it pays, and waits ever longer before the next test.
    const recovers = events.filter((e) => e.action === 'recover' && e.step === 'foveation-max');
    expect(recovers.length).toBeGreaterThanOrEqual(2);
    expect(recovers.length).toBeLessThanOrEqual(6);
    for (const r of recovers) {
      expect(events.find((e) => e.t > r.t)).toMatchObject({
        action: 'recover-back',
        step: 'foveation-max',
      });
    }
  });

  test('with window noise and the measured costs, foveation stays shed', () => {
    // 1 buys only about 3% past 0.5, so window noise can read it either way; 0.5 always pays.
    const cost = (l: GovernorLevels) => SHIPPED_MS * FOVEATION_COST[l.foveation];
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { events, timeAt } = fillTrace(cost, 300_000, mulberry32(seed));
      expect(
        timeAt((l) => l.foveation >= 0.5),
        `seed ${seed} time at foveation 0.5 or 1`,
      ).toBeGreaterThan(0.95);
      // Measured worst over these seeds: 16 density events in 300 s (chance sticks and their
      // recovery), against 10 in 600 s without noise. Foveation 1 itself is held 1% to 97% of the
      // time, seed by seed: its 3% gain over 0.5 sits on the bar.
      expect(events.filter(isDensity).length, `seed ${seed} density events`).toBeLessThanOrEqual(
        16,
      );
    }
  });

  test('with window noise, foveation 0.5 gaining under 3% does not block foveation 1', () => {
    // Hypothetical costs, not measured: 0.5 buys 2%, under the bar, so it reads as no-gain, and 1
    // buys 22%. The shared id of 819b25a would hold 1 behind the no-gain of 0.5.
    const hypothetical: Record<number, number> = { 0: 1, 0.5: 0.98, 1: 0.76 };
    const cost = (l: GovernorLevels) => SHIPPED_MS * hypothetical[l.foveation];
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { events, timeAt } = fillTrace(cost, 300_000, mulberry32(seed));
      expect(
        events.some((e) => e.action === 'shed' && e.step === 'foveation-max'),
        `seed ${seed}`,
      ).toBe(true);
      expect(
        timeAt((l) => l.foveation === 1),
        `seed ${seed} time at foveation 1`,
        // Worst measured 0.89 (seed 7): a noise-kept recovery of 1 costs a hold before re-shedding.
      ).toBeGreaterThan(0.85);
    }
  });

  test('each further no-gain hold of a step doubles, capped at 5 min; a rate change restarts it', () => {
    expect(MAX_HOLD_MS).toBe(300_000);
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    // A CPU-bound frame; the rate request stays pending, so only time lapses the holds.
    const { events, t } = drive(gov, 0, 1_100_000, { interval: () => OVER, rate: 'pending' });
    const undo = events.filter((e) => e.action === 'no-gain' && e.step === 'foveation');
    const retry = events.filter((e) => e.action === 'shed' && e.step === 'foveation');
    const gaps = undo.slice(0, -1).map((u, i) => retry[i + 1].t - u.t);
    const expected = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000];
    expect(gaps.length).toBeGreaterThanOrEqual(expected.length);
    expected.forEach((hold, i) => {
      expect(gaps[i]).toBeGreaterThanOrEqual(hold);
      expect(gaps[i]).toBeLessThan(hold + 600);
    });
    gov.setFrameRate(80);
    const after = drive(gov, t, 40_000, { interval: () => OVER, rate: 'pending' });
    const fov = after.events.filter((e) => e.step === 'foveation');
    expect(fov.map((e) => e.action).slice(0, 3)).toEqual(['shed', 'no-gain', 'shed']);
    expect(fov[2].t - fov[1].t).toBeLessThan(NO_GAIN_HOLD_MS + 600);
  });
});
