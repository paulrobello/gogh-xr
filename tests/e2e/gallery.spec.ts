/**
 * The gallery (P5.4): the default boot renders with no errors, all seven scans load, the viewer
 * spawns 4 m from Starry Night facing it, the walls hold a walking viewer in, `?painting` still
 * deep-links into Starry Night, and the room's strokes cover their base meshes at four poses.
 *
 * Coverage works as in world-coverage.spec.ts: under `?coverage` the base mesh and the clear colour
 * are magenta and the strokes draw, so a magenta pixel is a gap. The scans and plaque cards are not
 * stroke surfaces, so they draw normally there; `?bare` paints the scans magenta too, hides the
 * plaques and the strokes, and calibrates the count at about 100%.
 *
 * `GALLERY_SHOTS=1` also writes the three docs/shots captures.
 */
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { HANGINGS, MOULDING_DEPTH, wallPoint } from '../../src/paintings/gallery/layout.ts';
import { mulberry32 } from '../../src/util/prng.ts';
import { expect, glErrors, test, type Xr } from './fixtures';

const MAX_BARE = 0.005;
/** The brief's cap on strokes drawn from the spawn. */
const SPAWN_BUDGET = 150_000;

interface FrameDiag {
  id: string;
  loaded: boolean;
  naturalWidth: number;
  naturalHeight: number;
  keep: [number, number];
}

interface GalleryDiag {
  painting: string;
  seed: number;
  debug: string | null;
  counts: Record<string, number>;
  total: number;
  times: Record<string, number>;
  strokes: { chunks: number; visibleChunks: number; total: number; visible: number };
  frames: FrameDiag[];
  plaques: {
    state: string;
    ms: number;
    drawCallsPerPlaque: number;
    lines: number;
    texts: string[];
  };
}

interface Pose {
  name: string;
  position: [number, number, number];
  yaw: number;
  pitch: number;
}

/** Spawn, the Starry Night wall close up, the east side wall and the back wall. */
const POSES: readonly Pose[] = [
  { name: 'spawn', position: [0, 1.6, 0], yaw: 0, pitch: 0 },
  { name: 'starry night wall', position: [0.3, 1.6, -2.4], yaw: 0, pitch: -0.05 },
  { name: 'east side wall', position: [-0.5, 1.6, 1], yaw: -Math.PI / 2, pitch: 0 },
  { name: 'back wall', position: [0, 1.6, 1.5], yaw: Math.PI, pitch: 0 },
];

async function gallery(xr: Xr, until?: (g: GalleryDiag) => boolean): Promise<GalleryDiag> {
  await expect
    .poll(
      async () => {
        const world = (await xr.diag()).world as GalleryDiag | undefined;
        return world !== undefined && (until ? until(world) : true);
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  return (await xr.diag()).world as GalleryDiag;
}

const plaquesSettled = (g: GalleryDiag): boolean => g.plaques.state !== 'pending';

async function visit(page: Page, xr: Xr, { position, yaw, pitch }: Pose): Promise<void> {
  await page.evaluate(
    ([x, y, z, h, p]) => {
      if (!window.__goghPose) throw new Error('__goghPose is not installed; boot with ?diag');
      window.__goghPose(x, y, z, h, p);
    },
    [...position, yaw, pitch] as const,
  );
  await xr.waitFrames(3);
}

/** Share of mostly magenta pixels in the last frame (`?shot` keeps the drawing buffer). */
function bareShare(page: Page): Promise<number> {
  return page.evaluate(() => {
    const gl = document.querySelector('canvas') as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = gl.width;
    copy.height = gl.height;
    const context = copy.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas context is not available');
    context.drawImage(gl, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let bare = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 192 && data[i + 1] < 64 && data[i + 2] > 192) bare++;
    }
    return bare / (data.length / 4);
  });
}

test('the default boot is the gallery: no errors, seven scans loaded, the spawn facing Starry Night', async ({
  page,
  xr,
}) => {
  test.setTimeout(120_000);
  await xr.boot('noanim');
  const world = await gallery(xr, plaquesSettled);
  await xr.waitFrames(5);
  const diag = await xr.diag();
  expect(world.painting).toBe('gallery');
  expect(world.debug).toBeNull();
  expect(world.total).toBeGreaterThan(0);
  expect(world.total).toBeLessThanOrEqual(SPAWN_BUDGET);

  expect(world.frames.map((f) => f.id)).toEqual([
    'starry-night',
    'chestnut-trees-in-blossom',
    'les-alyscamps',
    'cafe-terrace-at-night',
    'bedroom',
    'wheatfield-with-crows',
    'starry-night-over-the-rhone',
  ]);
  for (const frame of world.frames) {
    expect(frame.loaded, frame.id).toBe(true);
    expect(Math.max(frame.naturalWidth, frame.naturalHeight), frame.id).toBe(1024);
  }

  expect(world.plaques.state).toBe('built');
  expect(world.plaques.lines).toBe(14);
  expect(world.plaques.texts.filter((t) => t.endsWith('\nComing soon'))).toHaveLength(5);

  // The spawn: the eye 4 m from the Starry Night wall, facing -Z with no pitch or roll.
  expect(diag.camera.position).toEqual([0, 1.6, 0]);
  const q = diag.camera.quaternion;
  expect(Math.abs(q[0]) + Math.abs(q[1]) + Math.abs(q[2])).toBeLessThan(1e-9);
  const visible = (diag.world as GalleryDiag).strokes.visible;
  expect(visible).toBeGreaterThan(0);
  expect(visible).toBeLessThanOrEqual(SPAWN_BUDGET);
  console.log(
    `[e2e] gallery spawn drawn ${visible}, draw ${JSON.stringify(diag.draw)}, times ${JSON.stringify(world.times)}, plaques ${world.plaques.ms.toFixed(0)} ms, ${world.plaques.drawCallsPerPlaque} draws per plaque in view`,
  );
  console.log(`[e2e] gallery counts ${JSON.stringify(world.counts)} total ${world.total}`);
  console.log(`[e2e] gallery crops ${JSON.stringify(world.frames.map((f) => [f.id, f.keep]))}`);
  expect(await glErrors(page)).toEqual([]);
});

test('in XR the IWER head spawns in the gallery within the stroke budget', async ({ page, xr }) => {
  test.setTimeout(120_000);
  await xr.boot('noanim&nogov');
  await gallery(xr);
  await xr.enterXR();
  await xr.waitFrames(5);
  const diag = await xr.diag();
  const [x, y, z] = diag.camera.position;
  expect(Math.hypot(x, y - 1.6, z)).toBeLessThan(0.05);
  const drawn = (diag.world as GalleryDiag).strokes.visible;
  expect(drawn).toBeLessThanOrEqual(SPAWN_BUDGET);
  console.log(`[e2e] gallery XR drawn at the spawn ${drawn}, draw ${JSON.stringify(diag.draw)}`);
  expect(await glErrors(page)).toEqual([]);
});

test('the walls hold a walking viewer in: W stops 0.3 m short of the Starry Night wall', async ({
  page,
  xr,
}) => {
  test.setTimeout(120_000);
  await xr.boot('noanim&nogov');
  await gallery(xr);
  // Walk around the bench, then straight at the wall.
  await page.evaluate(() => window.__goghPose?.(2, 1.6, 0, 0, 0));
  await xr.waitFrames(2);
  await page.keyboard.down('KeyW');
  await expect
    .poll(async () => ((await xr.diag()).rig as { position: number[] }).position[2], {
      timeout: 20_000,
    })
    .toBeLessThan(-3.69);
  await xr.waitFrames(10);
  const rig = (await xr.diag()).rig as { position: number[] };
  await page.keyboard.up('KeyW');
  expect(rig.position[2]).toBeCloseTo(-3.7, 6);
  expect(rig.position[0]).toBeCloseTo(2, 6);
  expect(await glErrors(page)).toEqual([]);
});

test('?painting=starry-night still deep-links into the Starry Night world', async ({ xr }) => {
  test.setTimeout(150_000);
  await xr.boot('painting=starry-night&noanim');
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
    .toBe(true);
  expect(((await xr.diag()).world as { painting: string }).painting).toBe('starry-night');
});

test('?scene=bare boots the bare scene with no world', async ({ page, xr }) => {
  await xr.boot('scene=bare');
  // Past the gallery's build window (imports, scatter, batch and atlas: about 0.3 s), so a gallery
  // boot would have registered its world and bound its batch by now.
  await page.waitForTimeout(1500);
  await xr.waitFrames(5);
  const diag = await xr.diag();
  expect(diag.world).toBeUndefined();
  // The bare scene's placeholder ground and grid, and no stroke batch.
  expect(diag.draw).toEqual({ calls: 2, visibleChunks: null });
});

test('?bare calibrates the gallery count: with the strokes hidden, every pose reads magenta', async ({
  page,
  xr,
}) => {
  test.setTimeout(120_000);
  await xr.boot('noanim&nogov&shot&bare');
  expect((await gallery(xr)).debug).toBe('bare');
  for (const pose of POSES) {
    await visit(page, xr, pose);
    const share = await bareShare(page);
    console.log(`[e2e] gallery bare ${pose.name}: ${(share * 100).toFixed(2)}%`);
    expect(share, pose.name).toBeGreaterThan(0.99);
  }
});

test('at the four gallery poses at most 0.5% of the view is bare', async ({ page, xr }) => {
  test.setTimeout(120_000);
  await xr.boot('noanim&nogov&shot&coverage');
  expect((await gallery(xr, plaquesSettled)).debug).toBe('coverage');
  const rows: string[] = [];
  for (const pose of POSES) {
    await visit(page, xr, pose);
    const share = await bareShare(page);
    const drawn = ((await xr.diag()).world as GalleryDiag).strokes.visible;
    rows.push(`${pose.name} ${(share * 100).toFixed(3)}% (drawn ${drawn})`);
    console.log(
      `[e2e] gallery coverage ${pose.name}: bare ${(share * 100).toFixed(3)}%, drawn ${drawn}`,
    );
    expect(share, pose.name).toBeLessThanOrEqual(MAX_BARE);
  }
  test.info().annotations.push({ type: 'gallery coverage', description: rows.join('; ') });
  expect(await glErrors(page)).toEqual([]);
});

/** The page with the Enter VR button hidden, so a capture shows only the canvas. */
async function hideButton(page: Page): Promise<void> {
  await page.addStyleTag({ content: '#enter-vr { display: none !important; }' });
}

test('docs/shots captures (GALLERY_SHOTS=1)', async ({ page, xr }) => {
  test.skip(!process.env.GALLERY_SHOTS, 'set GALLERY_SHOTS=1 to write docs/shots');
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await xr.boot('noanim&nogov&shot');
  await gallery(xr, plaquesSettled);
  await hideButton(page);
  await xr.waitFrames(5);
  await page.screenshot({ path: 'docs/shots/p54-gallery-wide.jpg', type: 'jpeg', quality: 90 });

  await xr.boot('noanim&nogov&shot&painter');
  await gallery(xr, plaquesSettled);
  await hideButton(page);
  await xr.waitFrames(5);
  await page.screenshot({ path: 'docs/shots/p54-gallery-starry.jpg', type: 'jpeg', quality: 90 });

  // The west wall, Wheatfield and the Rhône, the darkest scan, from across the room.
  await xr.boot('noanim&nogov&shot');
  await gallery(xr, plaquesSettled);
  await hideButton(page);
  await visit(page, xr, { name: 'west wall', position: [2.2, 1.6, 1], yaw: Math.PI / 2, pitch: 0 });
  await xr.waitFrames(3);
  await page.screenshot({ path: 'docs/shots/p54-gallery-west.jpg', type: 'jpeg', quality: 90 });

  // Starry Night's plaque from 1.5 m at 45° to its right. The desktop view at 70° over 720 px is
  // about 10 px per degree against the Quest 3's 25, so this renders at 2.5× and crops 1280 × 720
  // around the card: about Quest density.
  await page.setViewportSize({ width: 3200, height: 1800 });
  await xr.boot('noanim&nogov&shot');
  await gallery(xr, plaquesSettled);
  await hideButton(page);
  const plaque = { x: 0.8505, y: 1.3, z: -3.988 };
  const d = 1.5 / Math.SQRT2;
  const eye = { x: plaque.x + d, y: 1.6, z: plaque.z + d };
  const pitch = -Math.atan2(eye.y - plaque.y, 1.5);
  await visit(page, xr, {
    name: 'plaque',
    position: [eye.x, eye.y, eye.z],
    yaw: Math.PI / 4,
    pitch,
  });
  await xr.waitFrames(3);
  await page.screenshot({
    path: 'docs/shots/p54-plaque.jpg',
    type: 'jpeg',
    quality: 92,
    clip: { x: 960, y: 540, width: 1280, height: 720 },
  });
});

/** A frame's moulding bars as screen rects, from a pinhole projection of the placed desktop eye. */
interface BarProbe {
  name: string;
  eye: [number, number, number];
  yaw: number;
  frames: string[];
}

const MOULDING_PROBES: readonly BarProbe[] = [
  {
    name: 'south',
    eye: [2.4, 1.6, -3.6],
    yaw: Math.PI,
    frames: ['cafe-terrace-at-night', 'bedroom'],
  },
  { name: 'north', eye: [0, 1.6, 5.7], yaw: 0, frames: ['starry-night'] },
];
const PROBE_VIEW = { width: 3200, height: 1800 };
/** The desktop camera's vertical field of view (src/main.ts). */
const DESKTOP_FOV_DEG = 70;

function project(eye: readonly number[], yaw: number, p: readonly number[]): [number, number] {
  const f = [-Math.sin(yaw), 0, -Math.cos(yaw)];
  const r = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const z = d[0] * f[0] + d[2] * f[2];
  const t = Math.tan((DESKTOP_FOV_DEG * Math.PI) / 360);
  const aspect = PROBE_VIEW.width / PROBE_VIEW.height;
  const x = (d[0] * r[0] + d[2] * r[2]) / z / (t * aspect);
  const y = d[1] / z / t;
  return [((x + 1) / 2) * PROBE_VIEW.width, ((1 - y) / 2) * PROBE_VIEW.height];
}

interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The four bars of a hanging's moulding front face, inset by `inset` px, plus the frame's box. */
function barRects(
  eye: readonly number[],
  yaw: number,
  id: string,
  inset: number,
): { bars: ScreenRect[]; box: ScreenRect } {
  const h = HANGINGS.find((x) => x.painting.id === id);
  if (!h) throw new Error(`no hanging ${id}`);
  const rect = (s0: number, s1: number, y0: number, y1: number): ScreenRect => {
    const a = project(eye, yaw, wallPoint(h.wall, s0, y0, MOULDING_DEPTH));
    const b = project(eye, yaw, wallPoint(h.wall, s1, y1, MOULDING_DEPTH));
    return {
      x0: Math.ceil(Math.min(a[0], b[0]) + inset),
      x1: Math.floor(Math.max(a[0], b[0]) - inset),
      y0: Math.ceil(Math.min(a[1], b[1]) + inset),
      y1: Math.floor(Math.max(a[1], b[1]) - inset),
    };
  };
  const { outer, scan } = h;
  return {
    bars: [
      rect(outer.s0, outer.s1, scan.y1, outer.y1),
      rect(outer.s0, outer.s1, outer.y0, scan.y0),
      rect(outer.s0, scan.s0, scan.y0, scan.y1),
      rect(scan.s1, outer.s1, scan.y0, scan.y1),
    ],
    box: rect(outer.s0 - 0.08, outer.s1 + 0.08, outer.y0 - 0.08, outer.y1 + 0.08),
  };
}

/**
 * Per bar pixel, its luma times 2 plus 1 where the pixel is cool (blue over red, the wall's slate):
 * one number carries both the class and the brightness.
 */
function coolMask(page: Page, bars: ScreenRect[]): Promise<number[]> {
  return page.evaluate((rects) => {
    const gl = document.querySelector('canvas') as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = gl.width;
    copy.height = gl.height;
    const context = copy.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas context is not available');
    context.drawImage(gl, 0, 0);
    const scale = gl.width / window.innerWidth;
    const out: number[] = [];
    for (const r of rects) {
      const x0 = Math.round(r.x0 * scale);
      const y0 = Math.round(r.y0 * scale);
      const w = Math.max(0, Math.round((r.x1 - r.x0) * scale));
      const h = Math.max(0, Math.round((r.y1 - r.y0) * scale));
      if (w === 0 || h === 0) continue;
      const { data } = context.getImageData(x0, y0, w, h);
      for (let i = 0; i < data.length; i += 4) {
        const luma = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
        out.push(luma * 2 + (data[i + 2] > data[i] ? 1 : 0));
      }
    }
    return out;
  }, bars);
}

test('far moulding probe (GALLERY_MOULDING=<label>): no wall slate in the gold bars, no new flicker', async ({
  page,
  xr,
}) => {
  const label = process.env.GALLERY_MOULDING;
  test.skip(!label, 'set GALLERY_MOULDING=<label> to probe the far mouldings');
  test.setTimeout(150_000);
  await page.setViewportSize(PROBE_VIEW);
  await xr.boot('noanim&nogov&shot');
  await gallery(xr, plaquesSettled);
  await page.addStyleTag({ content: '#enter-vr { display: none !important; }' });
  const rand = mulberry32(7);
  const rows: string[] = [];
  for (const probe of MOULDING_PROBES) {
    const masks: number[][] = [];
    // Frame 0 at the exact pose, then 7 seeded sub-millimetre jitters, as scripts/shimmer-probe.ts.
    for (let k = 0; k < 8; k++) {
      const j = k === 0 ? [0, 0, 0] : [0, 1, 2].map(() => (rand() - 0.5) * 1e-3);
      const eye = [probe.eye[0] + j[0], probe.eye[1] + j[1], probe.eye[2] + j[2]] as const;
      await visit(page, xr, { name: probe.name, position: [...eye], yaw: probe.yaw, pitch: 0 });
      const bars = probe.frames.flatMap((id) => barRects(probe.eye, probe.yaw, id, 2).bars);
      masks.push(await coolMask(page, bars));
      if (k === 0) {
        for (const id of probe.frames) {
          const { box } = barRects(probe.eye, probe.yaw, id, 0);
          const clip = { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 };
          const png = await page.screenshot({ clip });
          await sharp(png)
            .resize({ width: clip.width * 3, kernel: 'nearest' })
            .png()
            .toFile(`docs/shots/p54-moulding-${label}-${id}.png`);
        }
      }
    }
    const n = masks[0].length;
    const cool = masks.map((m) => m.reduce((a, b) => a + (b & 1), 0) / n);
    // Flicker: a bar pixel whose class flips, or whose luma swings by more than 12 (a stroke of
    // another tone taking the pixel), across the jittered frames.
    let flips = 0;
    let swings = 0;
    for (let i = 0; i < n; i++) {
      const first = masks[0][i] & 1;
      if (masks.some((m) => (m[i] & 1) !== first)) flips++;
      const lumas = masks.map((m) => m[i] >> 1);
      if (Math.max(...lumas) - Math.min(...lumas) > 12) swings++;
    }
    const row = `${probe.name}: ${n} bar px, slate ${(cool[0] * 100).toFixed(3)}% (max over jitter ${(Math.max(...cool) * 100).toFixed(3)}%), class flicker ${((flips / n) * 100).toFixed(3)}%, luma flicker ${((swings / n) * 100).toFixed(3)}%`;
    rows.push(row);
    console.log(`[e2e] moulding ${label} ${row}`);
  }
  test.info().annotations.push({ type: 'moulding', description: rows.join('; ') });
});
