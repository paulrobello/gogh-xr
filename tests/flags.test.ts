import { expect, test } from 'vitest';
import { parseFlags } from '../src/diag/flags.ts';

test('defaults when search is empty', () => {
  expect(parseFlags('')).toEqual({
    seed: null,
    noanim: false,
    shot: false,
    diag: false,
    hud: false,
    iwer: false,
    bench: null,
    benchMode: 'a2c',
    benchSize: null,
    benchOrder: null,
    hz: null,
    strokesTest: false,
  });
});

test('parses every flag', () => {
  const f = parseFlags(
    '?seed=42&noanim&shot&diag&hud&iwer&bench=strokes&mode=blend&size=32&order=random&hz=120&strokesTest',
  );
  expect(f).toEqual({
    seed: 42,
    noanim: true,
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
  });
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
