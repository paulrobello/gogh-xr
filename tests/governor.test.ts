import { describe, expect, test } from 'vitest';
import {
  createGovernor,
  FALLBACK_HZ,
  type FrameSample,
  type Governor,
  type GovernorEvent,
  type GovernorLevels,
  MAX_PROBE_WAIT_MS,
  MIN_BAND_DENSITY,
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

interface Trace {
  /** Frame interval for the next frame, from the governor's current levels and the time. */
  interval: (levels: GovernorLevels, t: number) => number;
  drawn?: (levels: GovernorLevels) => Drawn;
  gpuMs?: number | null;
  /** Stops early once this returns true for an event. */
  until?: (event: GovernorEvent) => boolean;
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

const SHED_SEQUENCE = [
  'shed far-density x4',
  'shed mid-density x5',
  'shed near-density x4',
  'shed fb-scale x1',
  'shed foveation x1',
];

describe('governor shedding', () => {
  test('a sustained overrun sheds far, mid, near, fb scale, foveation, then requests 72 Hz', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events } = drive(gov, 0, 60_000, { interval: () => OVER });
    expect(summary(events)).toEqual([...SHED_SEQUENCE, 'rate frame-rate x1']);
    const levels = gov.levels;
    expect(levels.density).toEqual(MIN_BAND_DENSITY);
    expect(levels.fbScale).toBe(0.85);
    expect(levels.foveation).toBe(0.5);
    const foveation = events.find((e) => e.step === 'foveation');
    const rate = events.find((e) => e.action === 'rate');
    expect(rate).toMatchObject({ from: 90, to: FALLBACK_HZ });
    // 3 s of continuous overrun at minimum quality, judged on 0.5 s windows.
    const wait = (rate?.t ?? 0) - (foveation?.t ?? 0);
    expect(wait).toBeGreaterThanOrEqual(3000);
    expect(wait).toBeLessThan(3000 + 2 * 500 + OVER * 2);
    const snap = gov.snapshot();
    expect(snap.targetHz).toBe(72);
    expect(snap.budgetMs).toBeCloseTo(1000 / 72, 6);
    expect(snap.notice).toMatch(/72 Hz/);
    // Still overrunning at 72 with nothing left to shed: terminal, the history stops growing.
    expect(snap.exhausted).toBe(true);
    expect(snap.history.at(-1)?.action).toBe('rate');
  });

  test('the first shed waits out the warm-up and one full 0.5 s window', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events } = drive(gov, 0, 5000, { interval: () => OVER, until: () => true });
    expect(events[0].step).toBe('far-density');
    expect(events[0].t).toBeGreaterThanOrEqual(WARMUP_MS + 500);
    expect(events[0].t).toBeLessThan(WARMUP_MS + 500 + 3 * OVER);
  });

  test('each density shed multiplies by 0.7 and raises the size by 1/sqrt of the density ratio', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    drive(gov, 0, 5000, { interval: () => OVER, until: () => true });
    expect(gov.levels.density.far).toBeCloseTo(DEFAULT_BAND_DENSITY.far * 0.7, 10);
    expect(gov.levels.size.far).toBeCloseTo(DEFAULT_BAND_SIZE.far * Math.sqrt(1 / 0.7), 10);
    expect(gov.levels.density.mid).toBe(DEFAULT_BAND_DENSITY.mid);
  });

  test('a band that draws nothing is skipped: shedding it would buy no time', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events } = drive(gov, 0, 5000, {
      interval: () => OVER,
      drawn: () => ({ near: 400_000, mid: 300_000, far: 0 }),
      until: () => true,
    });
    expect(events[0].step).toBe('mid-density');
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
    const { events } = drive(gov, 0, 30_000, { interval: () => OVER, drawn });
    expect(summary(events)).toEqual([
      'shed near-density x1',
      'shed fb-scale x1',
      'shed foveation x1',
      'rate frame-rate x1',
    ]);
    // 0.7 would draw 140k; the step clamps to the floor instead.
    expect(gov.levels.density.near).toBeCloseTo(STROKE_BUDGET.default.min / 200_000, 10);
    expect(drawn(gov.levels).near).toBeGreaterThanOrEqual(STROKE_BUDGET.default.min - 1);
    expect(gov.snapshot().densityMin).toBe(true);
  });

  test('a view already under the floor sheds no density at all', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const { events } = drive(gov, 0, 5000, {
      interval: () => OVER,
      drawn: () => ({ near: 100_000, mid: 20_000, far: 10_000 }),
      until: () => true,
    });
    expect(events[0].step).toBe('fb-scale');
    expect(gov.levels.density).toEqual(DEFAULT_BAND_DENSITY);
  });

  test('per-band minimum densities hold even with an unlimited view', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    drive(gov, 0, 60_000, { interval: () => OVER });
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
      interval: () => OVER,
      until: (e) => e.step === 'foveation',
    });
    expect(summary(shed.events)).toEqual(SHED_SEQUENCE);
    const restore = drive(gov, shed.t, 120_000, { interval: () => CLEAN });
    expect(summary(restore.events)).toEqual([
      'restore foveation x1',
      'restore fb-scale x1',
      'restore near-density x4',
      'restore mid-density x5',
      'restore far-density x4',
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
    expect(levels.foveation).toBe(0);
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
    const shed = drive(gov, 0, 10_000, { interval: () => OVER, until: () => ++sheds === 6 });
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
    expect(pairs[0]).toBe('restore far-density x1');
    expect(pairs[1]).toBe('shed-back far-density x1');
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
    const shed = drive(gov, 0, 10_000, { interval: () => OVER, until: () => ++sheds === 3 });
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
      interval: () => OVER,
      until: (e) => e.step === 'foveation',
    });
    // 2.5 s overrun, one clean window, then overrun again: the request waits 3 s from the restart.
    const { events } = drive(gov, shed.t, 20_000, {
      interval: (_l, t) => (t > shed.t + 2500 && t < shed.t + 3050 ? CLEAN : OVER),
      until: (e) => e.action === 'rate',
    });
    expect(events.map((e) => e.action)).toEqual(['rate']);
    // Without the restart it would fire about 3 s after the foveation shed.
    expect(events[0].t - shed.t).toBeGreaterThan(2500 + 3000);
  });

  test('after the 72 Hz drop, quality restores at 72 and the rate stays at 72', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 90 });
    const shed = drive(gov, 0, 60_000, {
      interval: () => OVER,
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
    expect(summary(idle.events)).toEqual(['restore far-density x1']);
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
      const { events } = drive(gov, 0, 60_000, { interval: () => 40 });
      expect(events.at(-1)).toMatchObject({ action: 'rate', from: hz, to: 72 });
    }
    const gov = createGovernor({ mode: 'beauty', targetHz: 72 });
    const { events } = drive(gov, 0, 60_000, { interval: () => 40 });
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
      step: 'far-density',
      from: expect.any(Number),
      to: expect.any(Number),
    });
  });
});
