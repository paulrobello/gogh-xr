/**
 * Lays the café set over the scan, to check the layout against the painting: each surface the
 * painter sees as a wash of its id's colour, with the tables, chairs, figures and solids outlined.
 *
 *   bun scripts/cafe/overlay.ts [out.jpg]
 */
import sharp from 'sharp';
import {
  CAMERA_FORWARD,
  PAINTER_EYE,
  toCanvas,
} from '../../src/paintings/cafe-terrace-at-night/canvas.ts';
import { rasterizeIds } from '../../src/paintings/cafe-terrace-at-night/id-map.ts';
import {
  CHAIRS,
  LAMP,
  PEOPLE,
  SEAT_HEIGHT,
  setSolids,
  TABLE_HEIGHT,
  TABLES,
  TRUNK,
} from '../../src/paintings/cafe-terrace-at-night/layout.ts';
import { paintBuilder } from '../../src/paintings/cafe-terrace-at-night/paint.ts';
import { buildSet } from '../../src/paintings/cafe-terrace-at-night/set.ts';
import type { Vec3 } from '../../src/render/strokes/frame.ts';
import { mulberry32 } from '../../src/util/prng.ts';
import { drain } from '../../src/util/slicer.ts';

const WIDTH = 1200;
const scan = sharp('assets/scans/cafe-terrace-at-night.jpg').resize(WIDTH);
const { height: HEIGHT } = await scan
  .clone()
  .toBuffer({ resolveWithObject: true })
  .then((r) => r.info);
const NEAR = 0.2;

const depth = (p: Vec3): number =>
  (p[0] - PAINTER_EYE[0]) * CAMERA_FORWARD[0] +
  (p[1] - PAINTER_EYE[1]) * CAMERA_FORWARD[1] +
  (p[2] - PAINTER_EYE[2]) * CAMERA_FORWARD[2];

function clip(corners: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const da = depth(a) - NEAR;
    const db = depth(b) - NEAR;
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

const px = (p: Vec3): string => {
  const { u, v } = toCanvas(p);
  return `${(u * WIDTH).toFixed(1)},${(v * HEIGHT).toFixed(1)}`;
};
const shapes: string[] = [];
// The set as the painter's id map names it, one hue per id.
const set = paintBuilder([]);
drain(buildSet(set, mulberry32(8)));
const ids = drain(rasterizeIds(set.positions, set.ids, WIDTH, HEIGHT, 0));
const wash = Buffer.alloc(WIDTH * HEIGHT * 4);
for (let i = 0; i < ids.length; i++) {
  const hue = (ids[i] * 137.5) % 360;
  const channel = (offset: number): number =>
    Math.round(255 * (0.5 + 0.5 * Math.cos(((hue + offset) * Math.PI) / 180)));
  wash.set([channel(0), channel(120), channel(240), ids[i] === 0 ? 0 : 96], i * 4);
}
const ring = (center: Vec3, radius: number, color: string): void => {
  const points: Vec3[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI) / 12;
    points.push([center[0] + radius * Math.cos(a), center[1], center[2] + radius * Math.sin(a)]);
  }
  shapes.push(
    `<polygon points="${points.map(px).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`,
  );
};
const post = (foot: Vec3, height: number, color: string): void => {
  shapes.push(
    `<polyline points="${px(foot)} ${px([foot[0], foot[1] + height, foot[2]])}" stroke="${color}" stroke-width="3"/>`,
  );
};
for (const { center, radius } of TABLES) {
  ring(center, radius, '#00ffff');
  post([center[0], 0, center[2]], TABLE_HEIGHT, '#00ffff');
}
for (const { seat } of CHAIRS) ring(seat, 0.2, '#ff9900');
for (const { at, height, pose } of PEOPLE) {
  post(at, pose === 'seated' ? 1.2 : height, '#ff00ff');
  if (pose === 'seated') ring([at[0], SEAT_HEIGHT, at[2]], 0.2, '#ff00ff');
}
post(TRUNK, 3.4, '#00ff00');
ring(LAMP, 0.2, '#ffffff');
for (const { center, size } of setSolids()) {
  const [x, , z] = center;
  const [w, , d] = size;
  shapes.push(
    `<polygon points="${clip([
      [x - w / 2, 0.02, z - d / 2],
      [x + w / 2, 0.02, z - d / 2],
      [x + w / 2, 0.02, z + d / 2],
      [x - w / 2, 0.02, z + d / 2],
    ])
      .map(px)
      .join(' ')}" fill="none" stroke="#000000" stroke-width="1" stroke-dasharray="4 3"/>`,
  );
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${shapes.join('')}</svg>`;
const out = process.argv[2] ?? 'build/cafe-overlay.jpg';
await scan
  .composite([
    { input: wash, raw: { width: WIDTH, height: HEIGHT, channels: 4 } },
    { input: Buffer.from(svg) },
  ])
  .jpeg({ quality: 88 })
  .toFile(out);
console.log(`cafe-overlay: wrote ${out} (${WIDTH}x${HEIGHT})`);
