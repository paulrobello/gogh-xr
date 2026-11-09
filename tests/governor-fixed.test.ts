/**
 * The fixed quality level (2026-11-08, Paul's A2): the ladder is the governor's own shed order
 * with no drawn counts, and a fixed machine never judges.
 */
import { describe, expect, test } from 'vitest';
import type { DensityLaw } from '../src/diag/flags.ts';
import {
  createGovernor,
  type GovernorEvent,
  type GovernorMode,
  type LadderStep,
  MIN_BAND_DENSITY,
  qualityLadder,
  SHED_FB_SCALE,
} from '../src/render/governor.ts';
import {
  BEAUTY_BAND_DENSITY,
  BEAUTY_BAND_SIZE,
  DEFAULT_BAND_DENSITY,
  DEFAULT_BAND_SIZE,
  type StrokeBand,
} from '../src/render/strokes/bands.ts';
import { MAX_QUALITY_LEVEL } from '../src/settings/schema.ts';

/** Mid carries the most, so every density step clears `MIN_SHED_YIELD` and the floor never binds. */
const HEAVY: Record<StrokeBand, number> = { near: 1_000_000, mid: 3_000_000, far: 1_000_000 };

/** Every shed event of an adaptive machine driven down its whole shed order, each shed paying. */
function adaptiveSheds(mode: GovernorMode, densityLaw: DensityLaw): GovernorEvent[] {
  const gov = createGovernor({ mode, targetHz: 90, densityLaw });
  const sheds: GovernorEvent[] = [];
  let t = 0;
  while (t < 120_000) {
    // 5% off per step from 64 ms still overruns 72 Hz at level 18, so no shed reads as no-gain.
    const intervalMs = 64 * 0.95 ** gov.snapshot().level;
    t += intervalMs;
    const event = gov.sample({ t, intervalMs, gpuMs: null, drawn: HEAVY });
    if (!event) continue;
    if (event.action === 'rate') break;
    expect(event.action, `${event.action} ${event.step}`).toBe('shed');
    sheds.push(event);
  }
  return sheds;
}

const stepOf = (s: LadderStep | GovernorEvent) => [s.step, s.from, s.to];

describe('qualityLadder', () => {
  test('default: foveation 0.5, fb 0.85, foveation 1, then far x4, mid x5, near x4 (16 levels)', () => {
    const ladder = qualityLadder('default');
    expect(ladder.map((s) => s.step)).toEqual([
      'foveation',
      'fb-scale',
      'foveation-max',
      ...Array(4).fill('far-density'),
      ...Array(5).fill('mid-density'),
      ...Array(4).fill('near-density'),
    ]);
    expect(ladder.slice(0, 3).map(stepOf)).toEqual([
      ['foveation', 0, 0.5],
      ['fb-scale', 1, SHED_FB_SCALE],
      ['foveation-max', 0.5, 1],
    ]);
    // Each band ends on its minimum. Mid's last step, 0.216 to 0.2, is low-yield, and a fixed level
    // keeps it: only a step that cannot apply is skipped.
    const last = (band: StrokeBand) => ladder.filter((s) => s.step === `${band}-density`).at(-1);
    for (const band of ['far', 'mid', 'near'] as const)
      expect(last(band)?.to).toBe(MIN_BAND_DENSITY[band]);
    expect(last('mid')?.from).toBeCloseTo(0.216, 3);
  });

  test('beauty starts from the max-beauty densities: far x6, mid x5, near x4 (18 levels)', () => {
    const ladder = qualityLadder('beauty');
    expect(ladder).toHaveLength(18);
    const first = (band: StrokeBand) => ladder.find((s) => s.step === `${band}-density`);
    expect(first('far')).toMatchObject({ from: BEAUTY_BAND_DENSITY.far, fromSize: 1.12 });
    expect(first('mid')?.from).toBe(BEAUTY_BAND_DENSITY.mid);
    expect(ladder.filter((s) => s.step === 'far-density')).toHaveLength(6);
  });

  test('the settings range constant is the longest ladder, for either density law', () => {
    for (const law of ['area', 'count'] as const) {
      const longest = Math.max(
        qualityLadder('default', law).length,
        qualityLadder('beauty', law).length,
      );
      expect(MAX_QUALITY_LEVEL).toBe(longest);
    }
  });

  test.each([
    ['default', 'area'],
    ['default', 'count'],
    ['beauty', 'area'],
    ['beauty', 'count'],
  ] as const)('%s / %s: equals the order the adaptive machine sheds in', (mode, law) => {
    const ladder = qualityLadder(mode, law);
    const sheds = adaptiveSheds(mode, law);
    expect(sheds.map(stepOf)).toEqual(ladder.map(stepOf));
  });

  test('sizes follow the law: sqrt of the density ratio under area, unchanged under count', () => {
    for (const s of qualityLadder('default', 'area').filter((x) => x.step.endsWith('-density')))
      expect(s.toSize).toBeCloseTo(s.fromSize * Math.sqrt(s.from / s.to), 12);
    for (const s of qualityLadder('default', 'count').filter((x) => x.step.endsWith('-density')))
      expect(s.toSize).toBe(s.fromSize);
  });
});

describe('a fixed level', () => {
  test('level N applies the first N ladder steps; level 0 is the start levels', () => {
    const ladder = qualityLadder('default');
    const zero = createGovernor({ mode: 'default', targetHz: 72, fixedLevel: 0 });
    expect(zero.levels).toMatchObject({
      density: DEFAULT_BAND_DENSITY,
      size: DEFAULT_BAND_SIZE,
      fbScale: 1,
      foveation: 0,
    });
    expect(zero.snapshot()).toMatchObject({ level: 0, step: 'none', fixedLevel: 0 });
    for (let n = 1; n <= ladder.length; n++) {
      const gov = createGovernor({ mode: 'default', targetHz: 72, fixedLevel: n });
      expect(gov.shedSteps()).toEqual(ladder.slice(0, n));
      expect(gov.snapshot()).toMatchObject({ level: n, fixedLevel: n, step: ladder[n - 1]?.step });
    }
    const three = createGovernor({ mode: 'default', targetHz: 72, fixedLevel: 3 }).snapshot();
    expect(three).toMatchObject({
      foveation: 1,
      fbScale: SHED_FB_SCALE,
      densities: DEFAULT_BAND_DENSITY,
    });
  });

  test('a level past the ladder applies the whole ladder and reports the level it applied', () => {
    const gov = createGovernor({ mode: 'default', targetHz: 72, fixedLevel: 18 });
    expect(gov.snapshot()).toMatchObject({ level: 16, fixedLevel: 16 });
    expect(gov.levels.density).toEqual(MIN_BAND_DENSITY);
  });

  test('beauty level 0 starts from the max-beauty densities and sizes', () => {
    const gov = createGovernor({ mode: 'beauty', targetHz: 72, fixedLevel: 0 });
    expect(gov.levels.density).toEqual(BEAUTY_BAND_DENSITY);
    expect(gov.levels.size).toEqual(BEAUTY_BAND_SIZE);
  });

  test.each([72, 90])(
    'at %i Hz it never judges: no shed, restore, no-gain, recover or rate request, whatever the frame',
    (targetHz) => {
      const gov = createGovernor({ mode: 'default', targetHz, fixedLevel: 4 });
      const before = gov.snapshot();
      let t = 0;
      // 40 ms overruns every budget for two minutes, then clean frames for another.
      for (const interval of [40, 8]) {
        for (const end = t + 120_000; t < end; ) {
          t += interval;
          expect(gov.sample({ t, intervalMs: interval, gpuMs: 1, drawn: HEAVY })).toBeNull();
        }
      }
      const after = gov.snapshot();
      expect(after.history).toEqual([]);
      expect(after).toMatchObject({
        rateRequest: 'none',
        notice: null,
        level: 4,
        fixedLevel: 4,
        targetHz,
        densities: before.densities,
        foveation: before.foveation,
        fbScale: before.fbScale,
      });
    },
  );

  test('an adaptive machine reports fixedLevel null', () => {
    expect(createGovernor({ mode: 'default', targetHz: 72 }).snapshot().fixedLevel).toBeNull();
  });
});
