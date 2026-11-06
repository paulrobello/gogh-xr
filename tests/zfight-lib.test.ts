import { describe, expect, test } from 'vitest';
import { FLIP_THRESHOLD, flipPercent } from '../scripts/zfight-lib.ts';

function image(width: number, height: number, fill = 0): Uint8Array {
  return new Uint8Array(width * height * 3).fill(fill);
}

function set(img: Uint8Array, width: number, x: number, y: number, rgb: [number, number, number]) {
  img.set(rgb, (y * width + x) * 3);
}

describe('flipPercent', () => {
  test('identical frames flip nothing', () => {
    const a = image(4, 6, 100);
    expect(flipPercent(a, a.slice(), 4, 6)).toEqual({ all: 0, top: 0, mid: 0, bottom: 0 });
  });

  test('a summed RGB change must exceed the threshold', () => {
    const a = image(2, 3);
    const b = image(2, 3);
    set(b, 2, 0, 0, [FLIP_THRESHOLD, 0, 0]);
    expect(flipPercent(a, b, 2, 3).all).toBe(0);
    set(b, 2, 0, 0, [FLIP_THRESHOLD, 1, 0]);
    expect(flipPercent(a, b, 2, 3).all).toBeCloseTo(100 / 6, 10);
  });

  test('channel differences add as absolute values', () => {
    const a = image(1, 3, 50);
    const b = image(1, 3, 50);
    set(b, 1, 0, 1, [40, 60, 50]);
    expect(flipPercent(a, b, 1, 3).mid).toBe(0);
    set(b, 1, 0, 1, [37, 63, 50]);
    expect(flipPercent(a, b, 1, 3).mid).toBe(100);
  });

  test('each screen third is a percentage of its own pixels', () => {
    const a = image(4, 6);
    const b = image(4, 6);
    set(b, 4, 0, 0, [255, 255, 255]);
    set(b, 4, 1, 2, [255, 255, 255]);
    set(b, 4, 2, 3, [255, 255, 255]);
    set(b, 4, 3, 5, [255, 255, 255]);
    expect(flipPercent(a, b, 4, 6)).toEqual({ all: 400 / 24, top: 12.5, mid: 25, bottom: 12.5 });
  });

  test('a height that does not divide by three splits the rows by floor(3 y / h)', () => {
    const a = image(1, 4);
    const b = image(1, 4, 255);
    // Rows 0 and 1 are the top third (0, 0.75), row 2 the middle (1.5), row 3 the bottom (2.25).
    expect(flipPercent(a, b, 1, 4)).toEqual({ all: 100, top: 100, mid: 100, bottom: 100 });
    set(b, 1, 0, 1, [0, 0, 0]);
    expect(flipPercent(a, b, 1, 4)).toEqual({ all: 75, top: 50, mid: 100, bottom: 100 });
  });

  test('rejects buffers that do not match the size', () => {
    expect(() => flipPercent(image(2, 3), image(2, 2), 2, 3)).toThrow(RangeError);
  });
});
