import { createHash } from 'node:crypto';
import {
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  UnsignedByteType,
} from 'three';
import { describe, expect, test } from 'vitest';
import { createBrushAtlas } from '../src/render/strokes/brush-atlas.ts';
import {
  ATLAS_CELL_SIZE,
  ATLAS_GRID,
  ATLAS_GUTTER,
  ATLAS_SIZE,
  BRUSH_CHANNEL,
  BRUSH_COUNT,
  BRUSHES,
  type BrushKind,
  brushTexelRect,
  brushUvRect,
  DEFAULT_BRUSH_SEED,
  generateBrushAtlas,
  TONE_NEUTRAL,
} from '../src/render/strokes/brush-atlas-data.ts';

const atlases = new Map<number, Uint8Array>();
function atlas(seed: number): Uint8Array {
  let data = atlases.get(seed);
  if (!data) {
    data = generateBrushAtlas(seed);
    atlases.set(seed, data);
  }
  return data;
}

function hash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function texel(data: Uint8Array, x: number, y: number, channel: number): number {
  return data[(y * ATLAS_SIZE + x) * 4 + channel] ?? 0;
}

function cellOrigin(index: number): { x: number; y: number } {
  return {
    x: (index % ATLAS_GRID) * ATLAS_CELL_SIZE,
    y: Math.floor(index / ATLAS_GRID) * ATLAS_CELL_SIZE,
  };
}

interface CellStats {
  mean: number;
  nonZero: number;
  band: number;
}

function cellStats(data: Uint8Array, index: number): CellStats {
  const { x: cx, y: cy } = cellOrigin(index);
  let sum = 0;
  let nonZero = 0;
  let band = 0;
  for (let y = cy; y < cy + ATLAS_CELL_SIZE; y++) {
    for (let x = cx; x < cx + ATLAS_CELL_SIZE; x++) {
      const c = texel(data, x, y, BRUSH_CHANNEL.coverage) / 255;
      sum += c;
      if (c > 0) nonZero++;
      if (c >= 0.1 && c <= 0.9) band++;
    }
  }
  return { mean: sum / (ATLAS_CELL_SIZE * ATLAS_CELL_SIZE), nonZero, band };
}

describe('layout', () => {
  test('a 4 x 4 grid of 512 px cells fills the 2048 px atlas', () => {
    expect(ATLAS_GRID * ATLAS_CELL_SIZE).toBe(ATLAS_SIZE);
    expect(BRUSH_COUNT).toBe(ATLAS_GRID * ATLAS_GRID);
    expect(BRUSHES).toHaveLength(BRUSH_COUNT);
    expect(ATLAS_GUTTER).toBeGreaterThanOrEqual(16);
  });

  test('every brush kind has at least two variants', () => {
    const kinds: BrushKind[] = ['ridge', 'bristle', 'dab', 'comma', 'crescent'];
    for (const kind of kinds) {
      expect(BRUSHES.filter((b) => b.kind === kind).length).toBeGreaterThanOrEqual(2);
    }
  });

  test('uv rects sit inside their cell, clear of the gutter', () => {
    for (let i = 0; i < BRUSH_COUNT; i++) {
      const uv = brushUvRect(i);
      const { x, y } = cellOrigin(i);
      const g = ATLAS_GUTTER / ATLAS_SIZE;
      expect(uv.u).toBeGreaterThanOrEqual(x / ATLAS_SIZE + g - 1e-9);
      expect(uv.v).toBeGreaterThanOrEqual(y / ATLAS_SIZE + g - 1e-9);
      expect(uv.u + uv.width).toBeLessThanOrEqual((x + ATLAS_CELL_SIZE) / ATLAS_SIZE - g + 1e-9);
      expect(uv.v + uv.height).toBeLessThanOrEqual((y + ATLAS_CELL_SIZE) / ATLAS_SIZE - g + 1e-9);
      expect(BRUSHES[i]?.aspect).toBeCloseTo(uv.height / uv.width, 9);
    }
  });

  test('brushUvRect rejects an index outside 0..15', () => {
    expect(() => brushUvRect(16)).toThrow(RangeError);
    expect(() => brushUvRect(-1)).toThrow(RangeError);
    expect(() => brushUvRect(1.5)).toThrow(RangeError);
  });
});

// Wider than the generator's clip window (6 px margin, 1 px blur), so a clipped shape fails.
const BORDER = 8;

describe('masks', () => {
  const data = atlas(DEFAULT_BRUSH_SEED);

  test('each cell has a non-empty coverage between 15 and 70 percent', () => {
    for (let i = 0; i < BRUSH_COUNT; i++) {
      const { mean, nonZero } = cellStats(data, i);
      expect(nonZero, `brush ${i}`).toBeGreaterThan(0);
      expect(mean, `brush ${i}`).toBeGreaterThanOrEqual(0.15);
      expect(mean, `brush ${i}`).toBeLessThanOrEqual(0.7);
    }
  });

  test('coverage is a shape mask: under 10 percent of covered texels are partial', () => {
    for (let i = 0; i < BRUSH_COUNT; i++) {
      const { nonZero, band } = cellStats(data, i);
      expect(band / nonZero, `brush ${i}`).toBeLessThan(0.1);
    }
  });

  test.each([DEFAULT_BRUSH_SEED, 2, 3, 977])(
    'seed %i: shapes sit inside the uv rect, clear of an 8 px border, unclipped',
    (seed) => {
      const seeded = atlas(seed);
      for (let i = 0; i < BRUSH_COUNT; i++) {
        const rect = brushTexelRect(i);
        const { x: cx, y: cy } = cellOrigin(i);
        let stray = 0;
        for (let y = cy; y < cy + ATLAS_CELL_SIZE; y++) {
          for (let x = cx; x < cx + ATLAS_CELL_SIZE; x++) {
            const inner =
              x >= rect.x + BORDER &&
              x < rect.x + rect.width - BORDER &&
              y >= rect.y + BORDER &&
              y < rect.y + rect.height - BORDER;
            if (!inner && texel(seeded, x, y, BRUSH_CHANNEL.coverage) > 0) stray++;
          }
        }
        expect(stray, `seed ${seed} brush ${i}`).toBe(0);
        expect(cellStats(seeded, i).mean, `seed ${seed} brush ${i}`).toBeGreaterThanOrEqual(0.15);
      }
    },
  );

  test('uv rect matches the texel rect', () => {
    for (let i = 0; i < BRUSH_COUNT; i++) {
      const uv = brushUvRect(i);
      const rect = brushTexelRect(i);
      expect(uv.u * ATLAS_SIZE).toBeCloseTo(rect.x, 6);
      expect(uv.v * ATLAS_SIZE).toBeCloseTo(rect.y, 6);
      expect(uv.width * ATLAS_SIZE).toBeCloseTo(rect.width, 6);
      expect(uv.height * ATLAS_SIZE).toBeCloseTo(rect.height, 6);
    }
  });

  test('height and tone carry relief inside the shape and stay neutral outside', () => {
    for (let i = 0; i < BRUSH_COUNT; i++) {
      const { x: cx, y: cy } = cellOrigin(i);
      let heightInside = 0;
      let toneMin = 255;
      let toneMax = 0;
      let leaks = 0;
      let spare = 0;
      for (let y = cy; y < cy + ATLAS_CELL_SIZE; y++) {
        for (let x = cx; x < cx + ATLAS_CELL_SIZE; x++) {
          const c = texel(data, x, y, BRUSH_CHANNEL.coverage);
          const h = texel(data, x, y, BRUSH_CHANNEL.height);
          const tone = texel(data, x, y, BRUSH_CHANNEL.tone);
          if (texel(data, x, y, BRUSH_CHANNEL.spare) !== 255) spare++;
          if (c === 0) {
            if (h !== 0 || tone !== TONE_NEUTRAL) leaks++;
          } else if (c === 255) {
            heightInside = Math.max(heightInside, h);
            toneMin = Math.min(toneMin, tone);
            toneMax = Math.max(toneMax, tone);
          }
        }
      }
      expect(spare, `brush ${i}`).toBe(0);
      expect(leaks, `brush ${i}`).toBe(0);
      expect(heightInside, `brush ${i}`).toBeGreaterThan(128);
      expect(toneMax - toneMin, `brush ${i}`).toBeGreaterThan(40);
    }
  });
});

describe('determinism', () => {
  test('a fixed seed gives the same atlas hash', () => {
    expect(hash(generateBrushAtlas(DEFAULT_BRUSH_SEED))).toBe(hash(atlas(DEFAULT_BRUSH_SEED)));
  });

  test('a different seed gives a different hash', () => {
    expect(hash(atlas(2))).not.toBe(hash(atlas(DEFAULT_BRUSH_SEED)));
  });
});

describe('createBrushAtlas', () => {
  test('builds a mipmapped, linear RGBA8 DataTexture', () => {
    const texture = createBrushAtlas(DEFAULT_BRUSH_SEED);
    expect(texture.image.width).toBe(ATLAS_SIZE);
    expect(texture.image.height).toBe(ATLAS_SIZE);
    expect(texture.format).toBe(RGBAFormat);
    expect(texture.type).toBe(UnsignedByteType);
    expect(texture.colorSpace).toBe(NoColorSpace);
    expect(texture.generateMipmaps).toBe(true);
    expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
    expect(texture.magFilter).toBe(LinearFilter);
    expect(texture.wrapS).toBe(ClampToEdgeWrapping);
    expect(texture.wrapT).toBe(ClampToEdgeWrapping);
    expect(texture.flipY).toBe(false);
    expect(texture.version).toBeGreaterThan(0);
    expect(hash(texture.image.data as Uint8Array)).toBe(hash(atlas(DEFAULT_BRUSH_SEED)));
    texture.dispose();
  });

  test('a null seed falls back to the default seed', () => {
    const texture = createBrushAtlas(null);
    expect(hash(texture.image.data as Uint8Array)).toBe(hash(atlas(DEFAULT_BRUSH_SEED)));
    texture.dispose();
  });
});
