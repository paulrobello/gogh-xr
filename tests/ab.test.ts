import { describe, expect, it, vi } from 'vitest';
import {
  AB_GROUPS,
  type AbFlags,
  abShowsHudAtBoot,
  calmVariants,
  createAbController,
  createAbGroup,
  formatAbLine,
  resolveAb,
} from '../src/diag/ab';
import { parseFlags, ZDIAG_MODES } from '../src/diag/flags';
import { VTX_FEWER_KEEP, VTX_SMALLER_SCALE, vertexArms } from '../src/render/strokes/vertex-arms';

const NONE: AbFlags = {
  ab: null,
  zdiag: null,
  nohalo: false,
  wrap: null,
  calm: null,
  bench: null,
};
const flags = (over: Partial<AbFlags>): AbFlags => ({ ...NONE, ...over });

describe('AB_GROUPS', () => {
  it('ships shimmer, zdiag-all, halo, calm, wrap and vtx with base or the default first', () => {
    expect(AB_GROUPS.shimmer).toEqual(['base', 'write', 'noa2c', 'sharp', 'sharp4', 'freeze']);
    expect(AB_GROUPS['zdiag-all']).toEqual(['base', ...ZDIAG_MODES]);
    expect(AB_GROUPS.halo).toEqual(['on', 'off']);
    expect(AB_GROUPS.calm).toEqual(['1', '0.5', '0.25']);
    // Wheelrun first: the default wrap since 2026-11-10. Wheelflow next, so one press from the
    // default reaches the other river arm, and two reach wave.
    expect(AB_GROUPS.wrap).toEqual([
      'wheelrun',
      'wheelflow',
      'wave',
      'wheel',
      'stream',
      'base',
      'pingpong',
    ]);
    expect(AB_GROUPS.vtx).toEqual(['base', 'fewer', 'smaller', 'sparse', 'hoist']);
    expect(Object.keys(AB_GROUPS)).toEqual(['shimmer', 'zdiag-all', 'halo', 'calm', 'wrap', 'vtx']);
  });
});

describe('vtx', () => {
  it('has no implying flag, and its group drives the shared vertex-arm uniform', () => {
    expect(resolveAb(flags({ ab: 'vtx' })).activation).toEqual({ group: 'vtx', start: 0 });
    const deps = {
      zdiag: { setMode: vi.fn(), prepare: vi.fn() },
      setHalo: vi.fn(),
      setCalm: vi.fn(),
      setWrap: vi.fn(),
    };
    const group = createAbGroup('vtx', deps);
    expect(group.variants).toEqual(['base', 'fewer', 'smaller', 'sparse', 'hoist']);
    group.apply('smaller');
    expect(vertexArms.uniforms.uVtxSize.value).toBe(VTX_SMALLER_SCALE);
    expect(vertexArms.keep()).toBe(1);
    group.apply('fewer');
    expect(vertexArms.keep()).toBe(VTX_FEWER_KEEP);
    group.apply('base');
    expect(vertexArms.uniforms.uVtxSize.value).toBe(1);
    expect(vertexArms.keep()).toBe(1);
    expect(deps.setWrap).not.toHaveBeenCalled();
  });
});

describe('wrap', () => {
  it('?wrap implies its group at its variant, after ?zdiag and ?nohalo', () => {
    expect(resolveAb(flags({ wrap: 'wheelrun' })).activation).toEqual({ group: 'wrap', start: 0 });
    expect(resolveAb(flags({ wrap: 'wheelflow' })).activation).toEqual({ group: 'wrap', start: 1 });
    expect(resolveAb(flags({ wrap: 'wave' })).activation).toEqual({ group: 'wrap', start: 2 });
    expect(resolveAb(flags({ wrap: 'wheel' })).activation).toEqual({ group: 'wrap', start: 3 });
    expect(resolveAb(flags({ wrap: 'stream' })).activation).toEqual({ group: 'wrap', start: 4 });
    expect(resolveAb(flags({ wrap: 'base' })).activation).toEqual({ group: 'wrap', start: 5 });
    expect(resolveAb(flags({ wrap: 'pingpong' })).activation).toEqual({ group: 'wrap', start: 6 });
    const both = resolveAb(flags({ nohalo: true, wrap: 'wave' }));
    expect(both.activation).toEqual({ group: 'halo', start: 1 });
    expect(both.warnings).toEqual(['?nohalo has the A/B button (halo); ?wrap=wave stays fixed']);
  });

  it('?ab=wrap starts at an implied ?wrap and keeps a ?nohalo fixed', () => {
    expect(resolveAb(flags({ ab: 'wrap', wrap: 'base' }))).toEqual({
      activation: { group: 'wrap', start: 5 },
      warnings: [],
    });
    expect(resolveAb(flags({ ab: 'wrap', nohalo: true })).warnings).toEqual([
      '?ab=wrap has the A/B button (wrap); ?nohalo stays fixed',
    ]);
  });

  it('?ab=flame, the retired cypress sway group, is no group, and ?wrap=opacity is no wrap', () => {
    expect(resolveAb(flags({ ab: 'flame' })).activation).toBeNull();
    expect(parseFlags('?wrap=opacity').wrap).toBeNull();
  });

  it('its group drives the wrap setter, and calm uses the activation variants', () => {
    const deps = {
      zdiag: { setMode: vi.fn(), prepare: vi.fn() },
      setHalo: vi.fn(),
      setCalm: vi.fn(),
      setWrap: vi.fn(),
    };
    createAbGroup('wrap', deps).apply('wave');
    expect(deps.setWrap).toHaveBeenCalledWith('wave');
    createAbGroup('wrap', deps).apply('pingpong');
    expect(deps.setWrap).toHaveBeenCalledWith('pingpong');
    const calm = createAbGroup('calm', deps, ['1', '0.7', '0.5', '0.25']);
    expect(calm.variants).toEqual(['1', '0.7', '0.5', '0.25']);
    calm.apply('0.7');
    expect(deps.setCalm).toHaveBeenCalledWith(0.7);
  });
});

describe('abShowsHudAtBoot (F2)', () => {
  it('builds the HUD at boot only for a group an explicit ?ab names', () => {
    const cases: [Partial<AbFlags>, boolean][] = [
      [{}, false],
      [{ ab: 'shimmer' }, true],
      [{ ab: 'wrap' }, true],
      [{ ab: 'wrap', wrap: 'pingpong' }, true],
      [{ ab: 'calm', calm: 0.3 }, true],
      [{ zdiag: 'noa2c' }, false],
      [{ nohalo: true }, false],
      [{ wrap: 'wave' }, false],
      [{ ab: 'bogus', nohalo: true }, false],
      [{ ab: 'shimmer', bench: '1000' }, false],
    ];
    for (const [over, shown] of cases) {
      const f = flags(over);
      expect(abShowsHudAtBoot(resolveAb(f).activation, f.ab), JSON.stringify(over)).toBe(shown);
    }
  });
});

describe('resolveAb', () => {
  it('activates nothing and warns about nothing with no flag', () => {
    expect(resolveAb(NONE)).toEqual({ activation: null, warnings: [] });
  });

  it('activates ?ab at its first variant', () => {
    for (const group of Object.keys(AB_GROUPS)) {
      expect(resolveAb(flags({ ab: group })).activation).toEqual({ group, start: 0 });
    }
  });

  it('warns about an unknown group and activates nothing', () => {
    const { activation, warnings } = resolveAb(flags({ ab: 'bogus' }));
    expect(activation).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bogus');
  });

  it('lets an implied flag still activate after an unknown ?ab', () => {
    const { activation, warnings } = resolveAb(flags({ ab: 'bogus', nohalo: true }));
    expect(activation).toEqual({ group: 'halo', start: 1 });
    expect(warnings).toHaveLength(1);
  });

  it('implies shimmer from a shimmer zdiag mode, at that mode', () => {
    expect(resolveAb(flags({ zdiag: 'noa2c' })).activation).toEqual({ group: 'shimmer', start: 2 });
    expect(resolveAb(flags({ zdiag: 'freeze' })).activation).toEqual({
      group: 'shimmer',
      start: 5,
    });
  });

  it('implies zdiag-all from any other zdiag mode, at that mode', () => {
    for (const mode of ['nosort', 'nomip', 'mip', 'strokeorder', 'paintorder'] as const) {
      const { activation, warnings } = resolveAb(flags({ zdiag: mode }));
      expect(activation).toEqual({
        group: 'zdiag-all',
        start: AB_GROUPS['zdiag-all'].indexOf(mode),
      });
      expect(warnings).toEqual([]);
    }
  });

  it('implies halo from ?nohalo, at off', () => {
    expect(resolveAb(flags({ nohalo: true }))).toEqual({
      activation: { group: 'halo', start: 1 },
      warnings: [],
    });
  });

  it('does not imply calm from ?calm, which is a setting', () => {
    expect(resolveAb(flags({ calm: 0.5 })).activation).toBeNull();
  });

  it('starts ?ab=calm at the effective calm when that is one of its variants', () => {
    expect(resolveAb(flags({ ab: 'calm', calm: 0.25 })).activation).toEqual({
      group: 'calm',
      start: 2,
    });
    expect(resolveAb(flags({ ab: 'calm', calm: 1 })).activation).toEqual({
      group: 'calm',
      start: 0,
    });
  });

  it('inserts an effective calm that is no variant, in descending order, and starts there (F1)', () => {
    expect(resolveAb(flags({ ab: 'calm', calm: 0.3 })).activation).toEqual({
      group: 'calm',
      start: 2,
      variants: ['1', '0.5', '0.3', '0.25'],
    });
    expect(resolveAb(flags({ ab: 'calm', calm: 0 })).activation).toEqual({
      group: 'calm',
      start: 3,
      variants: ['1', '0.5', '0.25', '0'],
    });
    expect(resolveAb(flags({ ab: 'calm', calm: 0.75 })).activation).toEqual({
      group: 'calm',
      start: 1,
      variants: ['1', '0.75', '0.5', '0.25'],
    });
    expect(calmVariants(0.5)).toBe(AB_GROUPS.calm);
    expect(calmVariants(null)).toBe(AB_GROUPS.calm);
  });

  it('starts ?ab at an implied flag of the same group, with no warning', () => {
    expect(resolveAb(flags({ ab: 'shimmer', zdiag: 'sharp4' }))).toEqual({
      activation: { group: 'shimmer', start: 4 },
      warnings: [],
    });
    expect(resolveAb(flags({ ab: 'zdiag-all', zdiag: 'noa2c' }))).toEqual({
      activation: { group: 'zdiag-all', start: AB_GROUPS['zdiag-all'].indexOf('noa2c') },
      warnings: [],
    });
    expect(resolveAb(flags({ ab: 'halo', nohalo: true }))).toEqual({
      activation: { group: 'halo', start: 1 },
      warnings: [],
    });
  });

  it('lets ?ab win a conflict, warning once, and keeps a loser that the winner does not own', () => {
    const { activation, warnings } = resolveAb(flags({ ab: 'halo', zdiag: 'noa2c' }));
    expect(activation).toEqual({ group: 'halo', start: 0 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('?ab=halo');
    expect(warnings[0]).toContain('?zdiag=noa2c stays fixed');
  });

  it('drops a loser whose setting the winning group owns', () => {
    const { activation, warnings } = resolveAb(flags({ ab: 'shimmer', zdiag: 'nomip' }));
    expect(activation).toEqual({ group: 'shimmer', start: 0 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('?zdiag=nomip is ignored');
  });

  it('gives ?zdiag precedence over ?nohalo without ?ab, warning once', () => {
    const { activation, warnings } = resolveAb(flags({ zdiag: 'sharp', nohalo: true }));
    expect(activation).toEqual({ group: 'shimmer', start: 3 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('?nohalo stays fixed');
  });

  it('folds every conflict into one warning', () => {
    const { warnings } = resolveAb(flags({ ab: 'calm', zdiag: 'sharp', nohalo: true }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('?zdiag=sharp');
    expect(warnings[0]).toContain('?nohalo');
  });

  it('is ignored entirely by the bench', () => {
    expect(resolveAb(flags({ bench: '100000', ab: 'shimmer', zdiag: 'noa2c' }))).toEqual({
      activation: null,
      warnings: [],
    });
    expect(resolveAb(flags({ bench: '100000', ab: 'bogus' }))).toEqual({
      activation: null,
      warnings: [],
    });
  });
});

describe('createAbController', () => {
  const group = (variants: readonly string[]) => ({
    name: 'test',
    variants,
    apply: vi.fn<(variant: string) => void>(),
  });

  it('applies the start variant once on creation', () => {
    const g = group(['a', 'b', 'c']);
    const ab = createAbController(g, 1);
    expect(g.apply).toHaveBeenCalledTimes(1);
    expect(g.apply).toHaveBeenLastCalledWith('b');
    expect(ab.diag()).toEqual({ group: 'test', variants: ['a', 'b', 'c'], index: 1, variant: 'b' });
  });

  it('cycles to the next variant and wraps around', () => {
    const g = group(['a', 'b', 'c']);
    const ab = createAbController(g, 0);
    const seen = [ab.diag().variant];
    for (let i = 0; i < 4; i += 1) {
      ab.cycle();
      seen.push(ab.diag().variant);
    }
    expect(seen).toEqual(['a', 'b', 'c', 'a', 'b']);
    expect(g.apply.mock.calls.map(([v]) => v)).toEqual(['a', 'b', 'c', 'a', 'b']);
  });

  it('wraps from the last variant back to the first', () => {
    const g = group(['on', 'off']);
    const ab = createAbController(g, 1);
    ab.cycle();
    expect(ab.diag().index).toBe(0);
    expect(ab.diag().variant).toBe('on');
  });

  it('labels the HUD line with the group, variant and 1-based position', () => {
    const g = group(AB_GROUPS.shimmer);
    g.name = 'shimmer';
    const ab = createAbController(g, 2);
    expect(ab.label()).toBe('A/B shimmer: noa2c (3/6)');
    expect(formatAbLine('halo', 'off', 1, 2)).toBe('A/B halo: off (2/2)');
  });

  it('follows an outside change to one of its variants without applying it again', () => {
    const g = group(['1', '0.5', '0.25']);
    const ab = createAbController(g, 0);
    expect(ab.follow('0.25')).toBe(true);
    expect(ab.diag()).toMatchObject({ index: 2, variant: '0.25' });
    expect(g.apply).toHaveBeenCalledTimes(1);
    expect(ab.follow('0.3')).toBe(false);
    expect(ab.diag().index).toBe(2);
    ab.cycle();
    expect(ab.diag().variant).toBe('1');
  });

  it('returns a copy of the variants in its diag', () => {
    const g = group(['a', 'b']);
    const ab = createAbController(g, 0);
    const d = ab.diag();
    expect(d.variants).not.toBe(g.variants);
  });
});
