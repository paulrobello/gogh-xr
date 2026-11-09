/**
 * The P3.4 landing ring stays visible on the ground (and behind real occluders it stays hidden).
 * T is held through the sweep, so every pose is a desktop aim; the ring is found by its yellow in
 * the two outer thirds of its projected ellipse, where the arc's own strokes (which come down the
 * middle) never reach. Shots go to `.superpowers/sdd/` (`RING_SHOT_PREFIX` names the set).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  createCrownTest,
  createFootprintTest,
} from '../../src/paintings/starry-night/footprints.ts';
import { createCypress } from '../../src/world/cypress.ts';
import { createTerrain } from '../../src/world/terrain.ts';
import { createVillage } from '../../src/world/village.ts';
import { expect, test, type Vec3, type Xr } from './fixtures';

const terrain = createTerrain(1);
const village = createVillage(1, terrain);
const blocked = createFootprintTest(village);
const cypress = createCypress(1, terrain);
const treeBlocked = createCrownTest(cypress, terrain.heightAt);
const WORLD = 'painting=starry-night&noanim&nogov&shot';
const PREFIX = process.env.RING_SHOT_PREFIX ?? 'ring';
const OUT = '.superpowers/sdd';
const VIEW = { width: 1600, height: 1000 };
const FOV_DEG = 70;
/** RING_RADIUS in src/locomotion/arc-mesh.ts, which the e2e cannot import (its GLSL chain). */
const RING_RADIUS = 0.35;
/** Yellow pixels the ring needs in its outer thirds to count as visible. */
const MIN_RING_PIXELS = 12;

interface Aim {
  valid: boolean;
  hit: Vec3 | null;
}

async function place(page: Page, xr: Xr, eye: Vec3, yaw: number, pitch: number): Promise<Aim> {
  await page.evaluate(([x, y, z, h, p]) => window.__goghPose?.(x, y, z, h, p), [
    ...eye,
    yaw,
    pitch,
  ] as const);
  await xr.waitFrames(3);
  return ((await xr.diag()).rig as { aim: Aim }).aim;
}

/** Projects world points to pixels with the diag camera (vertical fov 70 degrees). */
async function project(xr: Xr, points: Vec3[]): Promise<[number, number][]> {
  const { position, quaternion } = (await xr.diag()).camera;
  const [qx, qy, qz, qw] = quaternion as [number, number, number, number];
  const t = Math.tan((FOV_DEG * Math.PI) / 360);
  return points.map((p) => {
    // Rotate the offset by the inverse quaternion: v' = v + 2w(u x v) + 2 u x (u x v), u = -q.xyz.
    const vx = p[0] - (position[0] as number);
    const vy = p[1] - (position[1] as number);
    const vz = p[2] - (position[2] as number);
    const ux = -qx;
    const uy = -qy;
    const uz = -qz;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const dx = vx + 2 * (qw * cx + (uy * cz - uz * cy));
    const dy = vy + 2 * (qw * cy + (uz * cx - ux * cz));
    const dz = vz + 2 * (qw * cz + (ux * cy - uy * cx));
    const f = -dz;
    if (f <= 0.05) return [-1e9, -1e9];
    return [
      VIEW.width / 2 + ((dx / f) * VIEW.height) / 2 / t,
      VIEW.height / 2 - ((dy / f) * VIEW.height) / 2 / t,
    ];
  });
}

/** Warm-yellow pixels (the ring's ARC_VALID_COLOR, shaded) in the outer thirds of the ring ellipse. */
async function ringPixels(
  page: Page,
  xr: Xr,
  hit: Vec3,
): Promise<{ pixels: number; inView: boolean; png: Buffer }> {
  const ring: Vec3[] = Array.from({ length: 24 }, (_, k) => {
    const a = (2 * Math.PI * k) / 24;
    return [hit[0] + Math.cos(a) * RING_RADIUS, hit[1], hit[2] + Math.sin(a) * RING_RADIUS];
  });
  const px = await project(xr, ring);
  const x0 = Math.min(...px.map((p) => p[0]));
  const x1 = Math.max(...px.map((p) => p[0]));
  const y0 = Math.min(...px.map((p) => p[1]));
  const y1 = Math.max(...px.map((p) => p[1]));
  const url = await page.evaluate(() => window.__goghShot?.() ?? '');
  const png = Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64');
  const inView = x0 > 20 && y0 > 20 && x1 < VIEW.width - 20 && y1 < VIEW.height - 20;
  if (!inView) return { pixels: 0, inView, png };
  const pixels = await page.evaluate(
    async ([src, ax0, ax1, ay0, ay1]) => {
      const img = new Image();
      img.src = src as string;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d') as CanvasRenderingContext2D;
      g.drawImage(img, 0, 0);
      const w = (ax1 as number) - (ax0 as number);
      let n = 0;
      for (const [lo, hi] of [
        [ax0 as number, (ax0 as number) + w / 3],
        [(ax1 as number) - w / 3, ax1 as number],
      ] as const) {
        const x = Math.max(0, Math.floor(lo) - 2);
        const y = Math.max(0, Math.floor(ay0 as number) - 3);
        const ww = Math.min(img.width - x, Math.ceil(hi - lo) + 4);
        const hh = Math.min(img.height - y, Math.ceil((ay1 as number) - (ay0 as number)) + 6);
        if (ww <= 0 || hh <= 0) continue;
        const d = g.getImageData(x, y, ww, hh).data;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i] as number;
          const gr = d[i + 1] as number;
          const b = d[i + 2] as number;
          if (r > 150 && gr > 110 && b < 0.6 * gr && r > b * 1.9) n += 1;
        }
      }
      return n;
    },
    [url, x0, x1, y0, y1] as const,
  );
  return { pixels, inView, png };
}

/**
 * True when the terrain itself stands between the eye and the hit (a crest, a bank): that is a
 * real occluder the ring must stay behind, so such landings say nothing about the ring's lift.
 * `margin` metres of clearance over the sight line absorbs the ring's own pull.
 */
function terrainHides(eye: Vec3, hit: Vec3, margin = 0.1): boolean {
  // Past the hit too: the ring's far side lies up to RING_RADIUS behind it along the sight line.
  const reach = 1 + RING_RADIUS / Math.hypot(hit[0] - eye[0], hit[2] - eye[2]);
  for (let i = 1; i < 120; i += 1) {
    const t = (i / 120) * reach;
    const x = eye[0] + (hit[0] - eye[0]) * t;
    const z = eye[2] + (hit[2] - eye[2]) * t;
    if (terrain.heightAt(x, z) > eye[1] + (hit[1] - eye[1]) * t + margin) return true;
  }
  return false;
}

/** True when the ground at the hit is seen edge-on or from behind (view ray within ~12 degrees of the surface). */
function edgeOn(eye: Vec3, hit: Vec3): boolean {
  const n = terrain.normalAt(hit[0], hit[2]);
  const v: Vec3 = [eye[0] - hit[0], eye[1] - hit[1], eye[2] - hit[2]];
  const d = Math.hypot(...v);
  return (n[0] * v[0] + n[1] * v[1] + n[2] * v[2]) / (d * Math.hypot(...n)) < 0.2;
}

function slopeOf(x: number, z: number): number {
  const n = terrain.normalAt(x, z);
  return (Math.acos(n[1] / Math.hypot(...n)) * 180) / Math.PI;
}

async function boot(page: Page, xr: Xr): Promise<void> {
  await page.setViewportSize(VIEW);
  await xr.boot(WORLD);
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
    .toBe(true);
  await xr.waitFrames(10);
  await page.keyboard.down('KeyT');
  await expect
    .poll(async () => ((await xr.diag()).rig as { aim: { active: boolean } }).aim.active)
    .toBe(true);
}

interface Sample {
  station: string;
  distance: number;
  slopeDeg: number;
  pixels: number;
  eye: Vec3;
  hit: Vec3;
}

/**
 * Stations and their base yaw (0 faces -Z, negative turns right). The bowl stations face the
 * rising rim, where far landings stay in view: on a level or falling aim the landing sits below
 * the frame, because the arc drops under the camera's ray.
 */
const STATIONS: { name: string; at: [number, number]; yaw: number }[] = [
  { name: 'flat', at: [0, 0], yaw: 0 },
  { name: 'slope-right', at: [14, 6], yaw: 0 },
  { name: 'slope-left', at: [-12, 4], yaw: 0 },
  { name: 'terrace', at: [3, -22], yaw: 0 },
  { name: 'bowl-south', at: [0, 22], yaw: 0 },
  { name: 'bowl-west', at: [-22, 0], yaw: -Math.PI / 2 },
  { name: 'bowl-east', at: [25, 2], yaw: Math.PI / 2 },
];
/** Distance buckets, metres: the ring's apparent size and the depth step both change across them. */
const BUCKETS = [
  { name: 'near', min: 2, max: 5 },
  { name: 'mid', min: 5, max: 9 },
  { name: 'far', min: 9, max: 16 },
] as const;

test('the landing ring is visible at near, mid and far landings on flat ground and slopes', async ({
  page,
  xr,
}) => {
  test.setTimeout(1_200_000);
  mkdirSync(OUT, { recursive: true });
  await boot(page, xr);
  const samples: Sample[] = [];
  // Worst (fewest ring pixels) shot per station and bucket, kept for review.
  const worst = new Map<string, { pixels: number; png: Buffer }>();
  for (const s of STATIONS) {
    const eye: Vec3 = [s.at[0], terrain.heightAt(s.at[0], s.at[1]) + 1.6, s.at[1]];
    for (const turn of [-0.5, 0, 0.5]) {
      for (let deg = -55; deg <= 30; deg += 2) {
        const aim = await place(page, xr, eye, s.yaw + turn, (deg * Math.PI) / 180);
        if (!aim.valid || !aim.hit) continue;
        const hit = aim.hit;
        const distance = Math.hypot(hit[0] - eye[0], hit[2] - eye[2]);
        if (terrainHides(eye, hit) || edgeOn(eye, hit)) continue;
        const bucket = BUCKETS.find((b) => distance >= b.min && distance < b.max);
        if (!bucket) continue;
        const { pixels, inView, png } = await ringPixels(page, xr, hit);
        if (!inView) continue;
        samples.push({
          station: s.name,
          distance,
          slopeDeg: slopeOf(hit[0], hit[2]),
          pixels,
          eye,
          hit,
        });
        const key = `${s.name}-${bucket.name}`;
        const prev = worst.get(key);
        if (!prev || pixels < prev.pixels) worst.set(key, { pixels, png });
      }
    }
  }
  for (const [key, { png }] of worst) writeFileSync(`${OUT}/${PREFIX}-${key}-worst.png`, png);
  const lines: string[] = [];
  const hidden: string[] = [];
  for (const s of STATIONS) {
    for (const b of BUCKETS) {
      const group = samples.filter(
        (m) => m.station === s.name && m.distance >= b.min && m.distance < b.max,
      );
      if (group.length === 0) {
        lines.push(`${s.name} ${b.name}: no in-view landings`);
        continue;
      }
      const low = group.reduce((a, c) => (c.pixels < a.pixels ? c : a));
      const bad = group.filter((m) => m.pixels < MIN_RING_PIXELS);
      const line = `${s.name} ${b.name}: ${group.length} landings, ${bad.length} hidden, min px ${low.pixels} at ${low.distance.toFixed(1)} m slope ${low.slopeDeg.toFixed(1)}`;
      lines.push(line);
      if (bad.length > 0) hidden.push(line);
    }
  }
  console.log(`[ring]\n${lines.join('\n')}`);
  expect(hidden).toEqual([]);
  // No far (9 m and more) landing is ever in view on the desktop: the arc drops below the camera's
  // ray, so the landing leaves the frame. Near and mid must have samples.
  for (const b of BUCKETS.slice(0, 2)) {
    expect(samples.filter((m) => m.distance >= b.min && m.distance < b.max).length).toBeGreaterThan(
      5,
    );
  }
});

test('a cypress between the eye and the landing hides the ring', async ({ page, xr }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  await boot(page, xr);
  // An arc is cut at a house, so no valid landing lies behind one. Foliage is soft: an arc passes
  // through the cypress and lands behind it. Eyes just south of the main mass, aiming north: keep
  // the first valid landing whose sight line runs through the crown.
  let found: (Sample & { png: Buffer }) | null = null;
  const [bx, , bz] = cypress.main.base;
  for (const back of [9, 8, 7, 6]) {
    const eye: Vec3 = [bx, terrain.heightAt(bx, bz + back) + 1.6, bz + back];
    if (blocked(eye[0], eye[2]) || treeBlocked(eye[0], eye[2])) continue;
    for (let deg = -10; deg <= 30 && found === null; deg += 1) {
      const aim = await place(page, xr, eye, 0, (deg * Math.PI) / 180);
      if (!aim.valid || !aim.hit) continue;
      const hit = aim.hit;
      // The crown between: at least 15 of 80 sight-line samples inside it, the first one 1.5 m or
      // more from the eye, and the hit itself clear of it (a crown landing is rejected anyway).
      let inside = 0;
      let first = Number.POSITIVE_INFINITY;
      for (let i = 1; i < 80; i += 1) {
        const t = i / 80;
        const x = eye[0] + (hit[0] - eye[0]) * t;
        const z = eye[2] + (hit[2] - eye[2]) * t;
        const sight = eye[1] + (hit[1] - eye[1]) * t;
        if (treeBlocked(x, z) && sight < terrain.heightAt(x, z) + 3.5) {
          inside += 1;
          first = Math.min(first, t * Math.hypot(hit[0] - eye[0], hit[2] - eye[2]));
        }
      }
      if (inside < 15 || first < 1.5 || treeBlocked(hit[0], hit[2])) continue;
      if (Math.hypot(hit[0] - eye[0], hit[2] - eye[2]) < 6) continue;
      const { pixels, inView, png } = await ringPixels(page, xr, hit);
      if (!inView) continue;
      found = {
        station: 'cypress',
        eye,
        hit,
        distance: Math.hypot(hit[0] - eye[0], hit[2] - eye[2]),
        slopeDeg: slopeOf(hit[0], hit[2]),
        pixels,
        png,
      };
    }
    if (found) break;
  }
  expect(found, 'no landing behind the cypress').not.toBeNull();
  const r = found as Sample & { png: Buffer };
  writeFileSync(`${OUT}/${PREFIX}-occluded.png`, r.png);
  console.log(
    `[ring] occluded: dist ${r.distance.toFixed(1)} m ring px ${r.pixels} eye ${r.eye} hit ${r.hit}`,
  );
  expect(r.pixels).toBeLessThan(MIN_RING_PIXELS / 2);
});
