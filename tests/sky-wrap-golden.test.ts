/**
 * Byte-identity guard for the wave, base and pingpong sky wraps across the lift removal and the
 * wheel and stream arms (2026-11-09). tests/fixtures/sky-wrap-golden.json was recorded from the TS
 * mirror at 775768e, before those changes; set SKY_WRAP_GOLDEN_WRITE=1 to re-record it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { skySwirl, skyWrapLoop } from '../src/motion/sky-swirl.ts';
import { PAINTER_EYE } from '../src/paintings/starry-night/canvas-camera.ts';

const FIXTURE = 'tests/fixtures/sky-wrap-golden.json';
const WRAPS = ['wave', 'base', 'pingpong'] as const;

function samples(): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < 24; i++) {
    const y = 0.05 + 0.9 * ((i * 0.618034) % 1);
    const a = i * 2.39996;
    const r = Math.sqrt(1 - y * y);
    const d = [r * Math.sin(a), y, -r * Math.cos(a)];
    const p = [
      PAINTER_EYE[0] + 118 * d[0],
      PAINTER_EYE[1] + 118 * d[1],
      PAINTER_EYE[2] + 118 * d[2],
    ] as const;
    const n = [-d[0], -d[1], -d[2]] as const;
    for (const phase of [0, 0.71]) {
      for (const time of [1.7, 5.25, 3599.9]) {
        for (const wrap of WRAPS) {
          for (const turns of wrap === 'wave' ? [1, 2, 3] : [2]) {
            const m = skySwirl(p, n, phase, time, undefined, wrap, turns);
            const l = skyWrapLoop(wrap, phase, time);
            out.push([...m.offset, m.turn, m.gain, l.tau, l.gain, l.returning ? 1 : 0]);
          }
        }
      }
    }
  }
  return out.map((row) => row.map((x) => Number(x.toPrecision(12))));
}

test('wave, base and pingpong match their 775768e outputs', () => {
  const now = samples();
  if (process.env.SKY_WRAP_GOLDEN_WRITE === '1') writeFileSync(FIXTURE, JSON.stringify(now));
  const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as number[][];
  expect(now.length).toBe(golden.length);
  expect(now).toEqual(golden);
});
