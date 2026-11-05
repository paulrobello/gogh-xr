import { expect, test } from 'vitest';
import { parseFlags } from '../src/diag/flags.ts';

test('defaults when search is empty', () => {
  expect(parseFlags('')).toEqual({
    seed: null,
    noanim: false,
    shot: null,
    diag: false,
    hud: false,
    iwer: false,
    bench: null,
  });
});

test('parses every flag', () => {
  const f = parseFlags('?seed=42&noanim&shot=1500&diag&hud&iwer&bench=strokes');
  expect(f).toEqual({
    seed: 42,
    noanim: true,
    shot: 1500,
    diag: true,
    hud: true,
    iwer: true,
    bench: 'strokes',
  });
});

test('malformed numbers become null', () => {
  for (const bad of ['abc', '', '1e3', '0x10', 'NaN', 'Infinity', '12px', '1.2.3']) {
    const f = parseFlags(`?seed=${bad}&shot=${bad}`);
    expect(f.seed).toBeNull();
    expect(f.shot).toBeNull();
  }
  expect(parseFlags('?seed').seed).toBeNull();
});

test('numbers accept sign and decimals; negative shot is null', () => {
  expect(parseFlags('?seed=-7').seed).toBe(-7);
  expect(parseFlags('?seed=1.5').seed).toBe(1.5);
  expect(parseFlags('?shot=-5').shot).toBeNull();
  expect(parseFlags('?shot=0').shot).toBe(0);
});

test('repeated keys use the first occurrence', () => {
  expect(parseFlags('?seed=1&seed=2').seed).toBe(1);
  expect(parseFlags('?seed=abc&seed=2').seed).toBeNull();
  expect(parseFlags('?bench=a&bench=b').bench).toBe('a');
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
