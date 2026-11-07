import { describe, expect, it, vi } from 'vitest';
import { RATE_NOTICE } from '../src/render/governor';
import {
  createHudUpdater,
  formatPerfHud,
  PERF_HUD_INTERVAL_MS,
  type PerfHudValues,
} from '../src/ui/perf-hud-text';

const GOVERNED: PerfHudValues = {
  fps: 72,
  meanMs: 13.8889,
  p99Ms: 15.004,
  gpuMs: 6.25,
  targetHz: 90,
  visible: 183_412,
  visibleChunks: 112,
  governor: {
    judging: true,
    level: 3,
    targetHz: 72,
    densities: { near: 0.49, mid: 1, far: 0.7 },
    foveation: 0.5,
    fbScale: 0.85,
    fbScaleApplied: null,
    notice: null,
  },
};

const UNGOVERNED: PerfHudValues = {
  fps: 60,
  meanMs: 16.6667,
  p99Ms: 17.1,
  gpuMs: null,
  targetHz: 90,
  visible: 200_000,
  visibleChunks: 56,
  governor: null,
};

describe('formatPerfHud', () => {
  it('shows frame stats, GPU, target, visible strokes and chunks and the governor levels', () => {
    expect(formatPerfHud(GOVERNED).split('\n')).toEqual([
      'fps 72   mean 13.89 ms   p99 15.00 ms',
      'gpu 6.25 ms   target 72 Hz',
      'visible 183,412 strokes   112 chunks',
      'gov level 3   near 0.49   mid 1.00   far 0.70',
      'foveation 0.50   fb scale 0.85',
    ]);
  });

  it('shows "gov idle" instead of the level while the governor does not judge, as on desktop', () => {
    const governor = GOVERNED.governor as NonNullable<PerfHudValues['governor']>;
    const lines = formatPerfHud({
      ...GOVERNED,
      governor: { ...governor, judging: false, level: 0 },
    }).split('\n');
    expect(lines[3]).toBe('gov idle   near 0.49   mid 1.00   far 0.70');
    expect(lines[4]).toBe('foveation 0.50   fb scale 0.85');
  });

  it('reads n/a for a missing GPU time and an unavailable fb scale, and -- for empty stats', () => {
    const lines = formatPerfHud({
      ...GOVERNED,
      meanMs: null,
      p99Ms: null,
      gpuMs: null,
      visible: null,
      visibleChunks: null,
      governor: {
        ...(GOVERNED.governor as NonNullable<PerfHudValues['governor']>),
        fbScale: 'unavailable',
      },
    }).split('\n');
    expect(lines[0]).toBe('fps 72   mean -- ms   p99 -- ms');
    expect(lines[1]).toBe('gpu n/a   target 72 Hz');
    expect(lines[2]).toBe('visible -- strokes   -- chunks');
    expect(lines[4]).toBe('foveation 0.50   fb scale n/a');
  });

  it('shows the frame lines and "governor off" when no governor runs', () => {
    expect(formatPerfHud(UNGOVERNED).split('\n')).toEqual([
      'fps 60   mean 16.67 ms   p99 17.10 ms',
      'gpu n/a   target 90 Hz',
      'visible 200,000 strokes   56 chunks',
      'governor off',
    ]);
  });

  it('carries the active A/B line last, after the governor notice', () => {
    expect(formatPerfHud({ ...UNGOVERNED, ab: 'A/B shimmer: noa2c (3/6)' }).split('\n')).toEqual([
      'fps 60   mean 16.67 ms   p99 17.10 ms',
      'gpu n/a   target 90 Hz',
      'visible 200,000 strokes   56 chunks',
      'governor off',
      'A/B shimmer: noa2c (3/6)',
    ]);
    const governor = { ...(GOVERNED.governor as NonNullable<PerfHudValues['governor']>) };
    const text = formatPerfHud({
      ...GOVERNED,
      governor: { ...governor, notice: RATE_NOTICE },
      ab: 'A/B halo: off (2/2)',
    });
    expect(text.split('\n').slice(-2)).toEqual([RATE_NOTICE, 'A/B halo: off (2/2)']);
    expect(formatPerfHud({ ...UNGOVERNED, ab: null })).toBe(formatPerfHud(UNGOVERNED));
  });

  it('adds the governor notice as the last line, in plain ASCII for the local font', () => {
    const governor = { ...(GOVERNED.governor as NonNullable<PerfHudValues['governor']>) };
    const text = formatPerfHud({ ...GOVERNED, governor: { ...governor, notice: RATE_NOTICE } });
    expect(text.split('\n').at(-1)).toBe(RATE_NOTICE);
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('appends the applied fb scale when the runtime did not honour the request', () => {
    expect(fbLine(1)).toBe('foveation 0.50   fb scale 0.85 (applied 1.00)');
    expect(fbLine(0.7)).toBe('foveation 0.50   fb scale 0.85 (applied 0.70)');
  });

  it('shows the requested fb scale alone when applied matches within 0.01 or is unknown', () => {
    expect(fbLine(0.85)).toBe('foveation 0.50   fb scale 0.85');
    expect(fbLine(0.8571)).toBe('foveation 0.50   fb scale 0.85');
    expect(fbLine(null)).toBe('foveation 0.50   fb scale 0.85');
    expect(fbLine(null, 'unavailable')).toBe('foveation 0.50   fb scale n/a');
  });
});

function fbLine(fbScaleApplied: number | null, fbScale: number | 'unavailable' = 0.85) {
  const gov = GOVERNED.governor as NonNullable<PerfHudValues['governor']>;
  const values = { ...GOVERNED, governor: { ...gov, fbScale, fbScaleApplied } };
  return formatPerfHud(values).split('\n')[4];
}

describe('createHudUpdater', () => {
  function setup() {
    const draw = vi.fn<(text: string) => void>();
    const updater = createHudUpdater(draw);
    let values: PerfHudValues = UNGOVERNED;
    const sample = vi.fn(() => values);
    return {
      draw,
      updater,
      sample,
      set: (next: PerfHudValues) => {
        values = next;
      },
    };
  }

  it('recomputes at 4 Hz', () => {
    expect(PERF_HUD_INTERVAL_MS).toBe(250);
  });

  it('draws once on the first tick', () => {
    const { draw, updater, sample } = setup();
    updater.tick(1000, sample);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledWith(formatPerfHud(UNGOVERNED));
    expect(updater.text).toBe(formatPerfHud(UNGOVERNED));
    expect(updater.updatedAt).toBe(1000);
    expect(updater.redraws).toBe(1);
  });

  it('does not redraw when the values are unchanged', () => {
    const { draw, updater, sample } = setup();
    updater.tick(1000, sample);
    for (let t = 1250; t <= 3000; t += 250) updater.tick(t, sample);
    expect(sample).toHaveBeenCalledTimes(9);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(updater.redraws).toBe(1);
    expect(updater.updatedAt).toBe(3000);
  });

  it('redraws exactly once when a value changes', () => {
    const { draw, updater, sample, set } = setup();
    updater.tick(1000, sample);
    set({ ...UNGOVERNED, fps: 59 });
    updater.tick(1250, sample);
    updater.tick(1500, sample);
    updater.tick(1750, sample);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(draw).toHaveBeenLastCalledWith(formatPerfHud({ ...UNGOVERNED, fps: 59 }));
  });

  it('ignores ticks inside the 250 ms interval, without sampling', () => {
    const { draw, updater, sample, set } = setup();
    updater.tick(1000, sample);
    set({ ...UNGOVERNED, fps: 59 });
    updater.tick(1100, sample);
    updater.tick(1249, sample);
    expect(sample).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(updater.updatedAt).toBe(1000);
    updater.tick(1250, sample);
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('recomputes when the frame clock steps backwards, as at an XR session change', () => {
    const { draw, updater, sample, set } = setup();
    updater.tick(50_000, sample);
    set({ ...UNGOVERNED, fps: 59 });
    updater.tick(1000, sample);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(updater.updatedAt).toBe(1000);
  });

  it('treats a value change that formats the same as unchanged', () => {
    const { draw, updater, sample, set } = setup();
    updater.tick(1000, sample);
    set({ ...UNGOVERNED, meanMs: 16.6668 });
    updater.tick(1250, sample);
    expect(draw).toHaveBeenCalledTimes(1);
  });
});
