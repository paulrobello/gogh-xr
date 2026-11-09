// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sha256Of } from '../scripts/asset-lib.ts';
import { bakeScan, canvasRect } from '../scripts/bake/bake.ts';
import type { RegionsDoc } from '../scripts/bake/scan-analysis.ts';
import { SCAN_INSET } from '../scripts/fidelity-io.ts';
import { COLOR_INSET } from '../src/demo/canvas/placement.ts';
import { CANVAS_ASPECT } from '../src/paintings/starry-night/canvas-camera.ts';
import { SKY_SCAN_SIZE } from '../src/world/sky-scan.ts';

const root = resolve(import.meta.dirname, '..');
// A 64² fill-resize (sharp lanczos3) of assets/scans/starry-night.jpg.
const FIXTURE = resolve(root, 'tests/fixtures/starry-night-64.png');
const REGIONS = JSON.parse(
  readFileSync(resolve(root, 'assets/bake/starry-night/regions.json'), 'utf8'),
) as RegionsDoc;
const OPTS = { fieldSize: 64, paletteWidth: 64 };

describe('bakeScan', () => {
  it('gives the same bake output twice for the 64² fixture', async () => {
    const hashes = async () => {
      const out = await bakeScan(readFileSync(FIXTURE), REGIONS, OPTS);
      return [out.palette, out.flow, out.regions].map((b) => sha256Of(Buffer.from(b)));
    };
    expect(await hashes()).toEqual(await hashes());
  });

  it('writes 24 swatches, an RGB flow field and a one-channel region raster', async () => {
    const out = await bakeScan(readFileSync(FIXTURE), REGIONS, OPTS);
    expect(JSON.parse(out.palette).swatches).toHaveLength(24);
    const flow = await sharp(out.flow).metadata();
    expect([flow.width, flow.height, flow.channels]).toEqual([64, 64, 3]);
    const regions = await sharp(out.regions).metadata();
    expect([regions.width, regions.height, regions.channels]).toEqual([64, 64, 1]);
    const ids = await sharp(out.regions).toColourspace('b-w').raw().toBuffer();
    expect(new Set(ids)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
  });
});

describe('one canvas uv extent', () => {
  it('crops the scan past its mat by COLOR_INSET, the rectangle CANVAS_ASPECT names', () => {
    const [width, height] = SKY_SCAN_SIZE;
    const rect = canvasRect(width, height);
    expect(rect).toEqual({ left: 45, top: 15, width: 3750, height: 3011 });
    expect(rect.left).toBe(Math.round(COLOR_INSET[0] * width));
    expect(rect.top).toBe(Math.round(COLOR_INSET[1] * height));
    expect(SCAN_INSET).toEqual(COLOR_INSET);
    expect(CANVAS_ASPECT).toBe(rect.width / rect.height);
  });

  it('has regions.json authored at the canvas aspect', () => {
    expect(REGIONS.aspect).toBeCloseTo(CANVAS_ASPECT, 4);
  });
});
