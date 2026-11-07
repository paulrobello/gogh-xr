import sharp from 'sharp';
import { beforeAll, expect, test } from 'vitest';
import {
  BENCHES,
  BLOCK_MARGIN,
  CROP_BIAS,
  coverCrop,
  galleryBlocked,
  galleryBoundary,
  HANGINGS,
  insideWall,
  PLAQUE_CENTRE_Y,
  ROOM,
  rectsOverlap,
  WALLS,
} from '../src/paintings/gallery/layout.ts';
import { PAINTINGS } from '../src/paintings/registry.ts';

/** Each scan's `frame.webp` pixel size, read from the file. */
const SCAN_SIZES = new Map<string, [number, number]>();

beforeAll(async () => {
  for (const p of PAINTINGS) {
    const { width, height } = await sharp(`public/${p.frameImage}`).metadata();
    SCAN_SIZES.set(p.id, [width ?? 0, height ?? 0]);
  }
});

function scanSize(id: string): [number, number] {
  const size = SCAN_SIZES.get(id);
  if (!size) throw new Error(`no scan for ${id}`);
  return size;
}

test('the room is about 10 × 6 m with a 3.5 m ceiling', () => {
  expect(ROOM.maxX - ROOM.minX).toBe(6);
  expect(ROOM.maxZ - ROOM.minZ).toBe(10);
  expect(ROOM.height).toBe(3.5);
});

test('all seven paintings hang: Starry Night alone on the facing wall, the rest in plan order', () => {
  expect(HANGINGS.map((h) => h.painting.id)).toEqual(PAINTINGS.map((p) => p.id));
  expect(HANGINGS.filter((h) => h.wall.name === 'north').map((h) => h.painting.id)).toEqual([
    'starry-night',
  ]);
  const starry = HANGINGS[0];
  expect(starry.s).toBe(0);
  expect(starry.wall.normal).toEqual([0, 0, 1]);
  // The other six, in registry order, walk round the side and back walls.
  expect(HANGINGS.slice(1).map((h) => h.wall.name)).toEqual([
    'east',
    'east',
    'south',
    'south',
    'west',
    'west',
  ]);
});

test('every frame is centred at 1.6 m at its painting’s true size and aspect', () => {
  for (const h of HANGINGS) {
    expect(h.y, h.painting.id).toBe(1.6);
    expect(h.width, h.painting.id).toBeCloseTo(h.painting.widthCm / 100, 9);
    expect(h.height, h.painting.id).toBeCloseTo(h.painting.heightCm / 100, 9);
    expect(h.width / h.height, h.painting.id).toBeCloseTo(
      h.painting.widthCm / h.painting.heightCm,
      9,
    );
    expect((h.scan.y0 + h.scan.y1) / 2, h.painting.id).toBeCloseTo(1.6, 9);
    expect((h.scan.s0 + h.scan.s1) / 2, h.painting.id).toBeCloseTo(h.s, 9);
  }
});

test('every frame and plaque lies inside its wall, and nothing on a wall overlaps', () => {
  for (const h of HANGINGS) {
    expect(insideWall(h.wall, h.outer), `${h.painting.id} frame`).toBe(true);
    expect(insideWall(h.wall, h.plaque), `${h.painting.id} plaque`).toBe(true);
    expect((h.plaque.y0 + h.plaque.y1) / 2, h.painting.id).toBeCloseTo(PLAQUE_CENTRE_Y, 9);
    expect(rectsOverlap(h.outer, h.plaque), h.painting.id).toBe(false);
  }
  for (let i = 0; i < HANGINGS.length; i++) {
    for (let j = i + 1; j < HANGINGS.length; j++) {
      const a = HANGINGS[i];
      const b = HANGINGS[j];
      if (a.wall !== b.wall) continue;
      const pair = `${a.painting.id} / ${b.painting.id}`;
      for (const ra of [a.outer, a.plaque]) {
        for (const rb of [b.outer, b.plaque]) expect(rectsOverlap(ra, rb), pair).toBe(false);
      }
    }
  }
});

test('the four walls close the room and face into it', () => {
  for (const wall of Object.values(WALLS)) {
    const [ox, , oz] = wall.origin;
    const [nx, , nz] = wall.normal;
    // A step along the normal from the wall is inside the room.
    expect(galleryBoundary([ox + nx * 0.5, 1, oz + nz * 0.5]), wall.name).toBe(0);
    expect(galleryBoundary([ox - nx * 0.5, 1, oz - nz * 0.5]), wall.name).toBe(1);
  }
});

test('coverCrop keeps the painting’s aspect: the shown part of each scan matches it', () => {
  for (const h of HANGINGS) {
    const [w, hgt] = scanSize(h.painting.id);
    const crop = coverCrop(w, hgt, h.width, h.height, CROP_BIAS[h.painting.id] ?? 0);
    const shown = ((crop.u1 - crop.u0) * w) / ((crop.v1 - crop.v0) * hgt);
    expect(shown, h.painting.id).toBeCloseTo(h.width / h.height, 9);
    expect(crop.u0).toBeGreaterThanOrEqual(0);
    expect(crop.v0).toBeGreaterThanOrEqual(0);
    expect(crop.u1).toBeLessThanOrEqual(1);
    expect(crop.v1).toBeLessThanOrEqual(1);
  }
});

test('the chestnut scan loses its margin mostly from the bottom', () => {
  const h = HANGINGS.find((x) => x.painting.id === 'chestnut-trees-in-blossom');
  if (!h) throw new Error('no chestnut hanging');
  const [w, hgt] = scanSize(h.painting.id);
  const crop = coverCrop(w, hgt, h.width, h.height, CROP_BIAS[h.painting.id]);
  expect(crop.u0).toBe(0);
  expect(crop.u1).toBe(1);
  const cut = 1 - (crop.v1 - crop.v0);
  expect(cut).toBeGreaterThan(0.06);
  expect(cut).toBeLessThan(0.07);
  // uv v runs up from the bottom row: v0 is the share cut from the bottom.
  expect(crop.v0).toBeCloseTo(cut * 0.7, 9);
  expect(1 - crop.v1).toBeCloseTo(cut * 0.3, 9);
});

test('coverCrop crops width centrally when the scan is too wide', () => {
  expect(coverCrop(200, 100, 1, 1)).toEqual({ u0: 0.25, u1: 0.75, v0: 0, v1: 1 });
  expect(coverCrop(100, 200, 1, 1)).toEqual({ u0: 0, u1: 1, v0: 0.25, v1: 0.75 });
});

test('galleryBlocked: the walls and benches grown by 0.3 m, nothing else', () => {
  expect(galleryBlocked(0, 0)).toBe(false);
  expect(galleryBlocked(ROOM.maxX - BLOCK_MARGIN - 0.01, 0)).toBe(false);
  expect(galleryBlocked(ROOM.maxX - BLOCK_MARGIN + 0.01, 0)).toBe(true);
  expect(galleryBlocked(0, ROOM.minZ + BLOCK_MARGIN + 0.01)).toBe(false);
  expect(galleryBlocked(0, ROOM.minZ + BLOCK_MARGIN - 0.01)).toBe(true);
  expect(galleryBlocked(10, 0)).toBe(true);
  for (const bench of BENCHES) {
    const [x, z] = bench.centre;
    expect(galleryBlocked(x, z)).toBe(true);
    expect(galleryBlocked(x + bench.sizeX / 2 + BLOCK_MARGIN - 0.01, z)).toBe(true);
    expect(galleryBlocked(x + bench.sizeX / 2 + BLOCK_MARGIN + 0.01, z)).toBe(false);
  }
});

test('galleryBoundary is 0 everywhere inside the room', () => {
  for (let x = ROOM.minX + 0.05; x < ROOM.maxX; x += 0.5) {
    for (let z = ROOM.minZ + 0.05; z < ROOM.maxZ; z += 0.5) {
      expect(galleryBoundary([x, 1.6, z])).toBe(0);
    }
  }
  expect(galleryBoundary([0, 1.6, ROOM.maxZ + 0.1])).toBe(1);
});
