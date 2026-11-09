import { expect, test } from 'vitest';
import { MAX_CANVAS_COUNT, MIN_CANVAS_COUNT, parseFlags } from '../src/diag/flags.ts';

test('defaults when search is empty', () => {
  expect(parseFlags('')).toEqual({
    seed: null,
    noanim: false,
    calm: null,
    motiont: null,
    motionphase: null,
    motionlayers: null,
    nohalo: false,
    shot: false,
    diag: false,
    hud: null,
    iwer: false,
    bench: null,
    benchMode: 'a2c',
    benchSize: null,
    benchOrder: null,
    hz: null,
    strokesTest: false,
    demo: null,
    beauty: false,
    slow: 0,
    nogov: false,
    update: null,
    count: null,
    nocache: false,
    cache: false,
    painting: null,
    bare: false,
    coverage: false,
    painter: false,
    seated: null,
    turn: null,
    zdiag: null,
    ab: null,
    wrap: null,
    waveTurns: null,
    scene: null,
    densityLaw: null,
    fov: null,
    mute: false,
  });
});

test('parses every flag', () => {
  const f = parseFlags(
    '?seed=42&noanim&calm=0.25&motiont=3612.5&motionphase=1.25&shot&diag&hud&iwer&bench=strokes&mode=blend&size=32&order=random&hz=120&strokesTest&demo=canvas&beauty&slow=14&nogov&update&count=325000&nocache&cache&painting=starry-night&bare&coverage&painter&seated&turn=smooth&zdiag=nosort&motionlayers=sky,%20Moon&nohalo&scene=%20Bare&ab=%20Shimmer%20&wrap=%20Wave&waveturns=%203%20&densitylaw=%20Count&fov=0.5&mute',
  );
  expect(f).toEqual({
    seed: 42,
    noanim: true,
    calm: 0.25,
    motiont: 12.5,
    motionphase: 0.25,
    motionlayers: 0b101,
    nohalo: true,
    shot: true,
    diag: true,
    hud: true,
    iwer: true,
    bench: 'strokes',
    benchMode: 'blend',
    benchSize: 32,
    benchOrder: 'random',
    hz: 120,
    strokesTest: true,
    demo: 'canvas',
    beauty: true,
    slow: 14,
    nogov: true,
    update: true,
    count: 325_000,
    nocache: true,
    cache: true,
    painting: 'starry-night',
    bare: true,
    coverage: true,
    painter: true,
    seated: true,
    turn: 'smooth',
    zdiag: 'nosort',
    ab: 'shimmer',
    wrap: 'wave',
    waveTurns: 3,
    scene: 'bare',
    densityLaw: 'count',
    fov: 0.5,
    mute: true,
  });
});

test('?densitylaw takes area or count, trimmed and lower-cased, else null', () => {
  expect(parseFlags('?densitylaw=area').densityLaw).toBe('area');
  expect(parseFlags('?densitylaw=COUNT').densityLaw).toBe('count');
  expect(parseFlags('?densitylaw=sqrt').densityLaw).toBeNull();
  expect(parseFlags('').densityLaw).toBeNull();
});

test('?fov takes only 0, 0.5 or 1, else null (the app default)', () => {
  expect(parseFlags('?fov=0').fov).toBe(0);
  expect(parseFlags('?fov=0.5').fov).toBe(0.5);
  expect(parseFlags('?fov=%201%20').fov).toBe(1);
  for (const bad of ['?fov=0.7', '?fov=2', '?fov=-1', '?fov=high', '?fov', '']) {
    expect(parseFlags(bad).fov).toBeNull();
  }
});

test('?waveturns takes only 1, 2 or 3, trimmed', () => {
  for (const turns of [1, 2, 3] as const) {
    expect(parseFlags(`?waveturns=${turns}`).waveTurns).toBe(turns);
  }
  expect(parseFlags('?waveturns=%202%20').waveTurns).toBe(2);
  for (const bad of ['0', '4', '2.5', '02', 'two', '', '-1']) {
    expect(parseFlags(`?waveturns=${bad}`).waveTurns).toBeNull();
  }
  expect(parseFlags('?waveturns').waveTurns).toBeNull();
  expect(parseFlags('').waveTurns).toBeNull();
});

test('?wrap takes only its variants', () => {
  for (const wrap of ['base', 'pingpong', 'wave'] as const)
    expect(parseFlags(`?wrap=${wrap}`).wrap).toBe(wrap);
  for (const retired of ['fade', 'half', 'pair', 'opacity', 'flow']) {
    expect(parseFlags(`?wrap=${retired}`).wrap).toBeNull();
  }
  expect(parseFlags('?wrap').wrap).toBeNull();
  expect(parseFlags('?flame=wind')).not.toHaveProperty('flame');
});

test('malformed numbers become null', () => {
  for (const bad of ['abc', '', '1e3', '0x10', 'NaN', 'Infinity', '12px', '1.2.3']) {
    expect(parseFlags(`?seed=${bad}`).seed).toBeNull();
  }
  expect(parseFlags('?seed').seed).toBeNull();
});

test('numbers accept sign and decimals', () => {
  expect(parseFlags('?seed=-7').seed).toBe(-7);
  expect(parseFlags('?seed=1.5').seed).toBe(1.5);
});

test('shot is a boolean flag, off for 0 and false, and ignores any value', () => {
  expect(parseFlags('?shot').shot).toBe(true);
  expect(parseFlags('?shot=1500').shot).toBe(true);
  expect(parseFlags('?shot=0').shot).toBe(false);
  expect(parseFlags('?shot=false').shot).toBe(false);
  expect(parseFlags('').shot).toBe(false);
});

test('repeated keys use the first occurrence', () => {
  expect(parseFlags('?seed=1&seed=2').seed).toBe(1);
  expect(parseFlags('?seed=abc&seed=2').seed).toBeNull();
  expect(parseFlags('?bench=a&bench=b').bench).toBe('a');
});

test('strokesTest is a boolean flag, off by default', () => {
  expect(parseFlags('?strokesTest').strokesTest).toBe(true);
  expect(parseFlags('?strokesTest=0').strokesTest).toBe(false);
  expect(parseFlags('?diag').strokesTest).toBe(false);
});

test('boolean flags are off for 0 and false', () => {
  expect(parseFlags('?diag=0').diag).toBe(false);
  expect(parseFlags('?diag=false').diag).toBe(false);
  expect(parseFlags('?diag=1').diag).toBe(true);
  expect(parseFlags('?diag=').diag).toBe(true);
});

test('empty bench is null and result is frozen', () => {
  expect(parseFlags('?bench=').bench).toBeNull();
  const f = parseFlags('?diag');
  expect(Object.isFrozen(f)).toBe(true);
});

test('bench mode accepts a2c and blend, anything else falls back to a2c', () => {
  expect(parseFlags('?mode=a2c').benchMode).toBe('a2c');
  expect(parseFlags('?mode=blend').benchMode).toBe('blend');
  expect(parseFlags('?mode=BLEND').benchMode).toBe('blend');
  expect(parseFlags('?mode=additive').benchMode).toBe('a2c');
  expect(parseFlags('?mode=').benchMode).toBe('a2c');
});

test('bench size is a positive number of px, otherwise null', () => {
  expect(parseFlags('?size=24').benchSize).toBe(24);
  expect(parseFlags('?size=12.5').benchSize).toBe(12.5);
  for (const bad of ['0', '-4', 'abc', '24px', '']) {
    expect(parseFlags(`?size=${bad}`).benchSize).toBeNull();
  }
});

test('bench order accepts sorted and random, anything else is null', () => {
  expect(parseFlags('?order=sorted').benchOrder).toBe('sorted');
  expect(parseFlags('?order=Random').benchOrder).toBe('random');
  expect(parseFlags('?order=shuffle').benchOrder).toBeNull();
  expect(parseFlags('').benchOrder).toBeNull();
});

test('hz accepts 72, 90 and 120 only', () => {
  expect(parseFlags('?hz=72').hz).toBe(72);
  expect(parseFlags('?hz=90').hz).toBe(90);
  expect(parseFlags('?hz=120').hz).toBe(120);
  for (const bad of ['60', '80', '144', 'fast', '', '90.5']) {
    expect(parseFlags(`?hz=${bad}`).hz).toBeNull();
  }
});

test('demo accepts canvas only, anything else is null', () => {
  expect(parseFlags('?demo=canvas').demo).toBe('canvas');
  expect(parseFlags('?demo=Canvas').demo).toBe('canvas');
  for (const bad of ['', 'sky', 'canvas2', '1']) {
    expect(parseFlags(`?demo=${bad}`).demo).toBeNull();
  }
  expect(parseFlags('?demo').demo).toBeNull();
  expect(parseFlags('').demo).toBeNull();
});

test('slow is a busy-wait in ms, clamped to 0-50, and 0 for anything malformed', () => {
  expect(parseFlags('?slow=14').slow).toBe(14);
  expect(parseFlags('?slow=2.5').slow).toBe(2.5);
  expect(parseFlags('?slow=0').slow).toBe(0);
  expect(parseFlags('?slow=-3').slow).toBe(0);
  expect(parseFlags('?slow=500').slow).toBe(50);
  for (const bad of ['', 'abc', '14ms', 'NaN', 'Infinity', '1e2']) {
    expect(parseFlags(`?slow=${bad}`).slow).toBe(0);
  }
  expect(parseFlags('?slow').slow).toBe(0);
  expect(parseFlags('').slow).toBe(0);
});

test('cache is a boolean flag, off for 0 and false', () => {
  expect(parseFlags('?cache').cache).toBe(true);
  expect(parseFlags('?cache=1').cache).toBe(true);
  expect(parseFlags('?cache=0').cache).toBe(false);
  expect(parseFlags('?cache=false').cache).toBe(false);
  expect(parseFlags('?nocache').cache).toBe(false);
});

test('nocache is a boolean flag, off for 0 and false', () => {
  expect(parseFlags('?nocache').nocache).toBe(true);
  expect(parseFlags('?nocache=1').nocache).toBe(true);
  expect(parseFlags('?nocache=0').nocache).toBe(false);
  expect(parseFlags('?nocache=false').nocache).toBe(false);
  expect(parseFlags('').nocache).toBe(false);
});

test('beauty and nogov are boolean flags, off for 0 and false', () => {
  expect(parseFlags('?beauty').beauty).toBe(true);
  expect(parseFlags('?beauty=0').beauty).toBe(false);
  expect(parseFlags('?beauty=false').beauty).toBe(false);
  expect(parseFlags('?nogov').nogov).toBe(true);
  expect(parseFlags('?nogov=0').nogov).toBe(false);
});

test('count is a canvas stroke target, rounded and clamped to 10k-1M, null when malformed', () => {
  expect(parseFlags('?count=325000').count).toBe(325_000);
  expect(parseFlags('?count=500000').count).toBe(500_000);
  expect(parseFlags('?count=12345.6').count).toBe(12_346);
  expect(parseFlags('?count=10').count).toBe(MIN_CANVAS_COUNT);
  expect(parseFlags('?count=-5').count).toBe(MIN_CANVAS_COUNT);
  expect(parseFlags('?count=5000000').count).toBe(MAX_CANVAS_COUNT);
  expect([MIN_CANVAS_COUNT, MAX_CANVAS_COUNT]).toEqual([10_000, 1_000_000]);
  for (const bad of ['', 'abc', '1e5', '325k', 'NaN', 'Infinity', '0x10']) {
    expect(parseFlags(`?count=${bad}`).count).toBeNull();
  }
  expect(parseFlags('?count').count).toBeNull();
  expect(parseFlags('').count).toBeNull();
});

test('painting is a trimmed lower-case id, or null when absent or empty', () => {
  expect(parseFlags('?painting=starry-night').painting).toBe('starry-night');
  expect(parseFlags('?painting=%20Starry-Night%20').painting).toBe('starry-night');
  expect(parseFlags('?painting=water-lilies').painting).toBe('water-lilies');
  expect(parseFlags('?painting').painting).toBeNull();
  expect(parseFlags('?painting=%20').painting).toBeNull();
  expect(parseFlags('').painting).toBeNull();
});

test('bare and coverage are boolean flags, off for 0 and false', () => {
  for (const key of ['bare', 'coverage'] as const) {
    expect(parseFlags(`?${key}`)[key]).toBe(true);
    expect(parseFlags(`?${key}=0`)[key]).toBe(false);
    expect(parseFlags(`?${key}=false`)[key]).toBe(false);
    expect(parseFlags('')[key]).toBe(false);
  }
});

test('turn is snap or smooth, trimmed and lower-cased, null when absent or unknown', () => {
  expect(parseFlags('?turn=smooth').turn).toBe('smooth');
  expect(parseFlags('?turn=%20Smooth%20').turn).toBe('smooth');
  expect(parseFlags('?turn=snap').turn).toBe('snap');
  expect(parseFlags('?turn=spin').turn).toBeNull();
  expect(parseFlags('?turn').turn).toBeNull();
  expect(parseFlags('').turn).toBeNull();
});

test('zdiag is one of the diagnostic modes, trimmed and lower-cased, null otherwise', () => {
  for (const mode of [
    'write',
    'nowrite',
    'nosort',
    'noa2c',
    'sharp',
    'sharp4',
    'nomip',
    'mip',
    'freeze',
    'strokeorder',
    'paintorder',
  ]) {
    expect(parseFlags(`?zdiag=${mode}`).zdiag).toBe(mode);
  }
  expect(parseFlags('?zdiag=%20StrokeOrder%20').zdiag).toBe('strokeorder');
  expect(parseFlags('?zdiag=bogus').zdiag).toBeNull();
  expect(parseFlags('?zdiag').zdiag).toBeNull();
  expect(parseFlags('').zdiag).toBeNull();
});

test('calm is clamped to 0-1, and null when absent or malformed', () => {
  expect(parseFlags('?calm=0.5').calm).toBe(0.5);
  expect(parseFlags('?calm=0').calm).toBe(0);
  expect(parseFlags('?calm=1').calm).toBe(1);
  expect(parseFlags('?calm=2').calm).toBe(1);
  expect(parseFlags('?calm=-1').calm).toBe(0);
  expect(parseFlags('?calm= .75 ').calm).toBe(0.75);
  expect(parseFlags('?calm').calm).toBeNull();
  expect(parseFlags('?calm=abc').calm).toBeNull();
  expect(parseFlags('').calm).toBeNull();
});

test('?motiont pins a time in seconds, wrapped at 3600; negative or malformed is null', () => {
  expect(parseFlags('?motiont=2.5').motiont).toBe(2.5);
  expect(parseFlags('?motiont=7200').motiont).toBe(0);
  expect(parseFlags('?motiont=-1').motiont).toBeNull();
  expect(parseFlags('?motiont=abc').motiont).toBeNull();
  expect(parseFlags('?motiont').motiont).toBeNull();
});

test('?motionlayers is a stroke layer mask, null when absent; unknown names add nothing', () => {
  expect(parseFlags('?motionlayers=sky').motionlayers).toBe(1);
  expect(parseFlags('?motionlayers=star,moon').motionlayers).toBe(0b110);
  expect(parseFlags('?motionlayers=%20SKY%20,bogus').motionlayers).toBe(1);
  expect(parseFlags('?motionlayers=bogus').motionlayers).toBe(0);
  expect(parseFlags('?motionlayers').motionlayers).toBe(0);
  expect(parseFlags('').motionlayers).toBeNull();
  // `reactive` names the reactive gate bit (P4.5), above the six layer bits.
  expect(parseFlags('?motionlayers=reactive').motionlayers).toBe(1 << 6);
  expect(parseFlags('?motionlayers=cypress,%20Reactive').motionlayers).toBe((1 << 3) | (1 << 6));
});

test('nohalo is a boolean flag, off for 0 and false', () => {
  expect(parseFlags('?nohalo').nohalo).toBe(true);
  expect(parseFlags('?nohalo=0').nohalo).toBe(false);
  expect(parseFlags('?nohalo=false').nohalo).toBe(false);
  expect(parseFlags('').nohalo).toBe(false);
});

test('?motionphase pins a phase fraction, wrapped to [0, 1); negative or malformed is null', () => {
  expect(parseFlags('?motionphase=0.3').motionphase).toBe(0.3);
  expect(parseFlags('?motionphase=0').motionphase).toBe(0);
  expect(parseFlags('?motionphase=2.5').motionphase).toBe(0.5);
  expect(parseFlags('?motionphase=-0.1').motionphase).toBeNull();
  expect(parseFlags('?motionphase=x').motionphase).toBeNull();
  expect(parseFlags('?motionphase').motionphase).toBeNull();
});

test('?seated and ?hud are on bare, off with 0 or false, and null when absent', () => {
  expect([parseFlags('?seated').seated, parseFlags('?hud').hud]).toEqual([true, true]);
  expect([parseFlags('?seated=1').seated, parseFlags('?hud=1').hud]).toEqual([true, true]);
  expect([parseFlags('?seated=0').seated, parseFlags('?hud=0').hud]).toEqual([false, false]);
  expect([parseFlags('?seated=false').seated, parseFlags('?hud=FALSE').hud]).toEqual([
    false,
    false,
  ]);
  expect([parseFlags('?x').seated, parseFlags('?x').hud]).toEqual([null, null]);
});

test('update is on, off or absent', () => {
  expect(parseFlags('').update).toBeNull();
  expect(parseFlags('?update').update).toBe(true);
  expect(parseFlags('?update=1').update).toBe(true);
  expect(parseFlags('?update=0').update).toBe(false);
  expect(parseFlags('?update=false').update).toBe(false);
});
