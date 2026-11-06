// @vitest-environment node
import sharp from 'sharp';
import { expect, test } from 'vitest';
import {
  CAPTURE_SIZE,
  loadCapture,
  loadScanReference,
  SCAN_INSET,
} from '../scripts/fidelity-io.ts';
import { FIDELITY_HEIGHT, FIDELITY_WIDTH } from '../scripts/fidelity-lib.ts';
import { COLOR_INSET } from '../src/demo/canvas/placement.ts';
import { CANVAS_ASPECT } from '../src/paintings/starry-night/canvas-camera.ts';

test('the scan inset is the colour sampling inset, and the capture is at the canvas aspect', () => {
  expect(SCAN_INSET).toEqual(COLOR_INSET);
  expect(CAPTURE_SIZE.width / CAPTURE_SIZE.height).toBeCloseTo(CANVAS_ASPECT, 3);
});

test('the scan reference is 256 × 203 RGB', async () => {
  const scan = await loadScanReference();
  expect([scan.width, scan.height, scan.data.length]).toEqual([
    FIDELITY_WIDTH,
    FIDELITY_HEIGHT,
    FIDELITY_WIDTH * FIDELITY_HEIGHT * 3,
  ]);
});

test('a capture is stretched to fill 256 × 203, not cropped', async () => {
  // Left half red, right half blue, with a green 8 px column at each edge.
  const { width, height } = CAPTURE_SIZE;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (x < 8 || x >= width - 8) raw[i + 1] = 255;
      else if (x < width / 2) raw[i] = 255;
      else raw[i + 2] = 255;
    }
  }
  const png = await sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  const img = await loadCapture(png);
  expect([img.width, img.height]).toEqual([FIDELITY_WIDTH, FIDELITY_HEIGHT]);
  const at = (x: number, y: number): number[] => [
    ...img.data.subarray((y * FIDELITY_WIDTH + x) * 3, (y * FIDELITY_WIDTH + x) * 3 + 3),
  ];
  // The edge columns survive: 8 of 1280 px is 1.6 output px.
  expect(at(0, 100)[1]).toBeGreaterThan(200);
  expect(at(FIDELITY_WIDTH - 1, 100)[1]).toBeGreaterThan(200);
  expect(at(FIDELITY_WIDTH / 4, 100)[0]).toBeGreaterThan(250);
  expect(at((3 * FIDELITY_WIDTH) / 4, 100)[2]).toBeGreaterThan(250);
});
