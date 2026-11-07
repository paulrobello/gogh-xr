/**
 * The gallery palette constants (P5.4) are sampled from the scans: this re-derives every sample
 * from its `frame.webp`, so a retouched scan or an edited constant fails here.
 */
import sharp from 'sharp';
import { expect, test } from 'vitest';
import {
  luma,
  mute,
  PALETTE_SAMPLES,
  PLAQUE_COLORS,
  type Rgb,
  SCAN_MEDIAN_LUMA,
} from '../src/paintings/gallery/palette.ts';
import { PAINTINGS } from '../src/paintings/registry.ts';

async function meanRgb(
  id: string,
  [u0, v0, u1, v1]: readonly [number, number, number, number],
): Promise<Rgb> {
  const entry = PAINTINGS.find((p) => p.id === id);
  if (!entry) throw new Error(`no painting ${id}`);
  const { data, info } = await sharp(`public/${entry.frameImage}`)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const x0 = Math.round(u0 * info.width);
  const x1 = Math.round(u1 * info.width);
  const y0 = Math.round(v0 * info.height);
  const y1 = Math.round(v1 * info.height);
  const sum = [0, 0, 0];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * info.width + x) * info.channels;
      sum[0] += data[i];
      sum[1] += data[i + 1];
      sum[2] += data[i + 2];
    }
  }
  const n = (x1 - x0) * (y1 - y0);
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

test('every palette sample is the mean colour of its rect of the scan', async () => {
  for (const [name, sample] of Object.entries(PALETTE_SAMPLES)) {
    const rgb = await meanRgb(sample.painting, sample.rect);
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(rgb[c] - sample.rgb[c]), `${name} channel ${c}`).toBeLessThanOrEqual(2);
    }
  }
});

test('every scan median is the median luma of its frame.webp', async () => {
  for (const p of PAINTINGS) {
    const { data, info } = await sharp(`public/${p.frameImage}`)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const lumas: number[] = [];
    for (let i = 0; i < data.length; i += info.channels) {
      lumas.push(luma([data[i], data[i + 1], data[i + 2]]));
    }
    lumas.sort((a, b) => a - b);
    const median = lumas[Math.floor((lumas.length - 1) / 2)];
    expect(Math.abs(median - SCAN_MEDIAN_LUMA[p.id]), p.id).toBeLessThanOrEqual(1);
  }
});

test('mute desaturates toward the luma and darkens', () => {
  const rgb: Rgb = [200, 100, 50];
  expect(mute(rgb, 1, 1)).toEqual([200, 100, 50]);
  const grey = mute(rgb, 0, 1);
  expect(grey[0]).toBeCloseTo(luma(rgb), 9);
  expect(grey[1]).toBeCloseTo(luma(rgb), 9);
  const dark = mute(rgb, 1, 0.5);
  expect(dark).toEqual([100, 50, 25]);
});

test('the plaque text reads on its card: a near-black card under off-white text', () => {
  expect(luma(PLAQUE_COLORS.card)).toBeLessThan(40);
  expect(luma(PLAQUE_COLORS.title) / luma(PLAQUE_COLORS.card)).toBeGreaterThan(7);
  expect(luma(PLAQUE_COLORS.detail) / luma(PLAQUE_COLORS.card)).toBeGreaterThan(5);
});
