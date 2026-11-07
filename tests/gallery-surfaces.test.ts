import sharp from 'sharp';
import { expect, test } from 'vitest';
import { decodedNormal, strokeShade } from '../src/demo/canvas/placement.ts';
import { HANGINGS, MOULDING_DEPTH, ROOM } from '../src/paintings/gallery/layout.ts';
import { luma, PALETTE_SAMPLES } from '../src/paintings/gallery/palette.ts';
import {
  createBaseGeometry,
  DEFAULT_GALLERY_SEED,
  gallerySurfaces,
  lightAt,
  NEAR_FRAME_SHARE,
  scatterGallery,
} from '../src/paintings/gallery/surfaces.ts';
import {
  DEPTH_TIE_BREAK_MAX_M,
  depthTieBreakRange,
  sizeShare,
} from '../src/render/strokes/depth-tie-break.ts';
import { unpackInstance } from '../src/render/strokes/instance.ts';

/** The brief's cap on strokes drawn from the spawn; the room's total stays under it. */
const BUDGET = 150_000;
const surfaces = gallerySurfaces();
const painted = scatterGallery(surfaces, DEFAULT_GALLERY_SEED);

test('the scatter is deterministic for a seed', () => {
  const again = scatterGallery(gallerySurfaces(), DEFAULT_GALLERY_SEED);
  expect(again.counts).toEqual(painted.counts);
  for (const key of ['position', 'normal', 'tangent', 'color', 'size', 'meta'] as const) {
    expect(
      Buffer.from(again.buffers[key].buffer).equals(Buffer.from(painted.buffers[key].buffer)),
      key,
    ).toBe(true);
  }
  const other = scatterGallery(gallerySurfaces(), 2);
  expect(
    Buffer.from(other.buffers.position.buffer).equals(Buffer.from(painted.buffers.position.buffer)),
  ).toBe(false);
});

test('every surface role is painted and the whole room fits the 150k budget', () => {
  const { counts, buffers } = painted;
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  expect(sum).toBe(buffers.count);
  expect(buffers.count).toBeLessThanOrEqual(BUDGET);
  for (const [role, n] of Object.entries(counts)) expect(n, role).toBeGreaterThan(0);
});

test('every stroke lies inside the room', () => {
  const { buffers } = painted;
  const eps = 1e-3;
  for (let i = 0; i < buffers.count; i++) {
    const x = buffers.position[i * 3];
    const y = buffers.position[i * 3 + 1];
    const z = buffers.position[i * 3 + 2];
    if (
      x < ROOM.minX - eps ||
      x > ROOM.maxX + eps ||
      z < ROOM.minZ - eps ||
      z > ROOM.maxZ + eps ||
      y < -eps ||
      y > ROOM.height + eps
    ) {
      throw new Error(`stroke ${i} at (${x}, ${y}, ${z}) is outside the room`);
    }
  }
});

test('the room stays darker than the paintings: no lit stroke is as bright as the brightest sample', () => {
  const { buffers } = painted;
  const brightest = Math.max(...Object.values(PALETTE_SAMPLES).map((s) => luma(s.rgb)));
  let peak = 0;
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    const shade = strokeShade(decodedNormal(s.normal));
    peak = Math.max(peak, luma([s.color[0] * shade, s.color[1] * shade, s.color[2] * shade]));
  }
  expect(peak).toBeLessThan(brightest);
});

test('the base mesh is one quad per surface', () => {
  const geometry = createBaseGeometry(surfaces);
  expect(geometry.getAttribute('position').count).toBe(surfaces.length * 4);
  expect(geometry.getIndex()?.count).toBe(surfaces.length * 6);
  geometry.dispose();
});

/**
 * For a wall stroke on `h`'s wall (on the wall plane, facing out of it), the distance from its centre
 * to `h`'s moulding in the wall plane. null for any other stroke, mouldings included.
 */
function wallDistance(
  h: (typeof HANGINGS)[number],
  p: readonly number[],
  n: readonly number[],
): number | null {
  const { origin, right, normal } = h.wall;
  const off = (p[0] - origin[0]) * normal[0] + (p[2] - origin[2]) * normal[2];
  if (off < 0 || off > 0.02 || n[0] * normal[0] + n[2] * normal[2] < 0.9) return null;
  const s = (p[0] - origin[0]) * right[0] + (p[2] - origin[2]) * right[2];
  const ds = Math.max(h.outer.s0 - s, 0, s - h.outer.s1);
  const dy = Math.max(h.outer.y0 - p[1], 0, p[1] - h.outer.y1);
  return Math.hypot(ds, dy);
}

test('no wall stroke that can reach a moulding ranks over it from anywhere in the room', () => {
  const { buffers } = painted;
  // The farthest a viewer's eye gets from a frame: the room's diagonal.
  const far = Math.hypot(ROOM.maxX - ROOM.minX, ROOM.maxZ - ROOM.minZ);
  const range = Math.min(DEPTH_TIE_BREAK_MAX_M, depthTieBreakRange(far, 0.1, 1000));
  expect(NEAR_FRAME_SHARE * range).toBeLessThan(MOULDING_DEPTH);
  let near = 0;
  for (let i = 0; i < buffers.count; i++) {
    const p = [buffers.position[i * 3], buffers.position[i * 3 + 1], buffers.position[i * 3 + 2]];
    const length = buffers.size[i * 2];
    const width = buffers.size[i * 2 + 1];
    const radius = 0.5 * Math.hypot(length, width);
    const n = unpackInstance(buffers, i).normal;
    for (const h of HANGINGS) {
      const d = wallDistance(h, p, n);
      if (d === null || d >= radius) continue;
      near++;
      expect(sizeShare(length, width), `stroke ${i} by ${h.painting.id}`).toBeLessThan(
        NEAR_FRAME_SHARE,
      );
    }
  }
  expect(near).toBeGreaterThan(1000);
});

test('the wall beside each frame stays under its scan: mean at most 0.85 of the scan median', async () => {
  const { buffers } = painted;
  for (const h of HANGINGS) {
    const { data, info } = await sharp(`public/${h.painting.frameImage}`)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const scan: number[] = [];
    for (let i = 0; i < data.length; i += info.channels) {
      scan.push(luma([data[i], data[i + 1], data[i + 2]]));
    }
    scan.sort((a, b) => a - b);
    const median = scan[Math.floor((scan.length - 1) / 2)];
    const lit: number[] = [];
    for (let i = 0; i < buffers.count; i++) {
      const p = [buffers.position[i * 3], buffers.position[i * 3 + 1], buffers.position[i * 3 + 2]];
      const s = unpackInstance(buffers, i);
      const d = wallDistance(h, p, s.normal);
      if (d === null || d === 0 || d > 0.3) continue;
      const shade = strokeShade(decodedNormal(s.normal));
      lit.push(luma([s.color[0] * shade, s.color[1] * shade, s.color[2] * shade]));
    }
    lit.sort((a, b) => a - b);
    const mean = lit.reduce((a, b) => a + b, 0) / lit.length;
    const p95 = lit[Math.floor(0.95 * (lit.length - 1))];
    expect(lit.length, h.painting.id).toBeGreaterThan(100);
    expect(mean, `${h.painting.id} mean vs median ${median.toFixed(0)}`).toBeLessThanOrEqual(
      0.85 * median,
    );
    expect(p95, `${h.painting.id} p95 vs median ${median.toFixed(0)}`).toBeLessThan(median);
  }
});

test('a bench top is lit above its sides', () => {
  const top = lightAt('bench', [0, 0.45, -2.1], undefined, [0, 1, 0]);
  const side = lightAt('bench', [0, 0.3, -1.89], undefined, [0, 0, 1]);
  expect(top / side).toBeGreaterThan(1.3);
});
