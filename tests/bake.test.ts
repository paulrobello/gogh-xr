// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sha256Of } from '../scripts/asset-lib.ts';
import { bakeScan } from '../scripts/bake/bake.ts';
import type { RegionsDoc } from '../scripts/bake/scan-analysis.ts';

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
