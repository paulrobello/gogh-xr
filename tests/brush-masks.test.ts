import { describe, expect, test } from 'vitest';
import {
  ATLAS_SIZE,
  BRUSH_CHANNEL,
  BRUSH_COUNT,
  brushTexelRect,
  DEFAULT_BRUSH_SEED,
  generateBrushAtlas,
} from '../src/render/strokes/brush-atlas-data.ts';
import {
  BRUSH_MASK_DATA,
  BRUSH_MASK_THRESHOLD,
  brushMaskCovered,
  buildBrushMasks,
  encodeBrushMasks,
} from '../src/render/strokes/brush-masks.ts';

describe('committed brush masks', () => {
  const atlas = generateBrushAtlas(DEFAULT_BRUSH_SEED);

  test('match the default-seed atlas (bun scripts/brush-masks.ts regenerates them)', () => {
    expect(BRUSH_MASK_DATA).toBe(encodeBrushMasks(buildBrushMasks(atlas)));
  });

  test('never call a point covered that the full atlas leaves bare, and cover most of each brush', () => {
    for (let b = 0; b < BRUSH_COUNT; b++) {
      const rect = brushTexelRect(b);
      let atlasCovered = 0;
      let maskCovered = 0;
      for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
          const u = (x + 0.5) / rect.width;
          const v = (y + 0.5) / rect.height;
          const full =
            atlas[((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4 + BRUSH_CHANNEL.coverage] >=
            BRUSH_MASK_THRESHOLD;
          const mask = brushMaskCovered(b, u, v);
          if (mask) expect(full, `brush ${b} texel ${x},${y}`).toBe(true);
          atlasCovered += full ? 1 : 0;
          maskCovered += mask ? 1 : 0;
        }
      }
      expect(maskCovered / atlasCovered, `brush ${b}`).toBeGreaterThan(0.7);
    }
  });
});
