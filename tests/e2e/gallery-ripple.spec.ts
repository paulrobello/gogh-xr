/**
 * The gallery ripple: a hand orb at the live painting's surface ripples its scan, and the scan
 * settles back byte for byte once the hand leaves (src/paintings/gallery/ripple.ts).
 *
 * Every test runs in XR through IWER, whose emulated session renders one full-canvas view into the
 * default framebuffer, so a `?shot` canvas read is the XR frame (reactive.spec.ts). The rig stands
 * 1.15 m from the scan with `__goghPose`, outside the portal's 0.6 m threshold, and the IWER head
 * at rig-local (0, 1.6, 0) looks straight at it. The left controller is parked under the floor.
 *
 * The orbs draw at the hand, so each comparison leaves the orb's own pixels out of the measure:
 * the hover pose lies on the head's ray through the contact, 0.45 m nearer the head, and both orb
 * discs, projected from the hand positions the reactive diag reports (the target ray, a few
 * centimetres off the IWER grip pose), are left out. Ripple pixels are counted in the annulus
 * 0.04-0.20 m round the touch position on the scan plane, outside both discs.
 *
 * Every projection is from the eye IWER renders, not the head: with stereo off its one view is the
 * left eye, IPD / 2 (0.0315 m) left of the head, so a point 0.67 m out draws 24 px right of where
 * the head would see it and the scan 14 px right.
 */
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { CAPTURE_SIZE } from '../../scripts/fidelity-io.ts';
import { HANGINGS, SCAN_DEPTH, wallPoint } from '../../src/paintings/gallery/layout.ts';
import { expect, glErrors, test, type Vec3, type Xr } from './fixtures';
import { handOrbsOff, portal, settled } from './helpers';

interface RippleDiag {
  contacts: ({ uv: [number, number]; strength: number } | null)[];
  amplitude: number;
}

const ripple = async (xr: Xr): Promise<RippleDiag> => (await xr.diag()).galleryRipple as RippleDiag;
const calls = async (xr: Xr): Promise<number> =>
  ((await xr.diag()).draw as { calls: number }).calls;

const EYE_HEIGHT = 1.6;
/** The eye's distance from the scan plane, metres. */
const STAND_OFF = 1.15;
/** How far in front of the scan the controller sits: inside the 0.13 m reach with room for the
 * target ray's few centimetres off the grip. */
const TOUCH_OUT = 0.03;
/** How far toward the eye from the touch point the hover pose sits: well past the reach. */
const HOVER_BACK = 0.45;
/** The orb mesh's radius, metres (hand-orbs.ts: the 0.08 m glow times its 1.03 mesh margin). */
const ORB_MESH_RADIUS = 0.0824;
/** Pixels added round each projected orb disc. */
const ORB_MARGIN_PX = 4;
/** The annulus on the scan plane whose pixels must change under the ripple (radius 0.25 m). */
const RIPPLE_INNER = 0.04;
const RIPPLE_OUTER = 0.2;
/** Rig-local, under the floor: no orb in view. */
const PARKED: Vec3 = [0, -60, 0];

/** A view: the eye's world position and its yaw (0 faces -Z, positive turns left). */
interface View {
  eye: Vec3;
  yaw: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const forwardOf = (v: View): Vec3 => [-Math.sin(v.yaw), 0, -Math.cos(v.yaw)];
const rightOf = (v: View): Vec3 => [Math.cos(v.yaw), 0, -Math.sin(v.yaw)];

/**
 * The view IWER renders for the head at `view`: with stereo off it draws only its left eye, offset
 * by -ipd / 2 along the head's right (XRDeviceBase `updateViews`). `place` gives the head the
 * rig's yaw, so the head's right is the view's.
 */
function renderedView(view: View, ipd: number): View {
  const r = rightOf(view);
  const half = ipd / 2;
  return {
    eye: [view.eye[0] - r[0] * half, view.eye[1] - r[1] * half, view.eye[2] - r[2] * half],
    yaw: view.yaw,
  };
}

/** Rig-local position of world point `p` for the rig `place` sets for `view`. */
function local(view: View, p: Vec3): Vec3 {
  const s = Math.sin(view.yaw);
  const c = Math.cos(view.yaw);
  const dx = p[0] - view.eye[0];
  const dz = p[2] - view.eye[2];
  return [c * dx - s * dz, p[1] - view.eye[1] + EYE_HEIGHT, s * dx + c * dz];
}

/** The view `STAND_OFF` metres in front of `id`'s scan centre, facing it, and its scan corners. */
function facing(id: string): { view: View; centre: Vec3; corners: Vec3[]; normal: Vec3 } {
  const h = HANGINGS.find((x) => x.painting.id === id);
  if (!h) throw new Error(`no hanging ${id}`);
  const centre = [...wallPoint(h.wall, h.s, h.y, SCAN_DEPTH)] as Vec3;
  const n = [...h.wall.normal] as Vec3;
  const eye: Vec3 = [centre[0] + n[0] * STAND_OFF, EYE_HEIGHT, centre[2] + n[2] * STAND_OFF];
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(
    ([a, b]) =>
      [
        ...wallPoint(
          h.wall,
          h.s + ((a as number) * h.width) / 2,
          h.y + ((b as number) * h.height) / 2,
          SCAN_DEPTH,
        ),
      ] as Vec3,
  );
  return { view: { eye, yaw: Math.atan2(n[0], n[2]) }, centre, corners, normal: n };
}

async function place(page: Page, xr: Xr, view: View, right: Vec3): Promise<void> {
  await page.evaluate(([x, y, z, w]) => window.__goghPose?.(x, y, z, w, 0), [
    ...view.eye,
    view.yaw,
  ] as const);
  await xr.setPose({
    head: { position: [0, EYE_HEIGHT, 0], quaternion: [0, 0, 0, 1] },
    left: { position: PARKED },
    right: { position: local(view, right) },
  });
}

async function canvasPixels(page: Page): Promise<{ data: Buffer; width: number; height: number }> {
  const url = await page.evaluate(() =>
    (document.querySelector('canvas') as HTMLCanvasElement).toDataURL('image/png'),
  );
  const png = Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64');
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Frame pixel of world point `q` seen from `view` (pitch 0), `focal` px per unit tangent. Pass the
 * rendered view (`renderedView`), not the head's.
 */
function project(
  view: View,
  q: Vec3,
  focal: number,
  width: number,
  height: number,
): [number, number] {
  const v = sub(q, view.eye);
  const depth = dot(v, forwardOf(view));
  return [width / 2 + (focal * dot(v, rightOf(view))) / depth, height / 2 - (focal * v[1]) / depth];
}

interface Diff {
  /** Changed share of the annulus RIPPLE_INNER-RIPPLE_OUTER round the contact, orb discs out. */
  annulus: number;
  /** Changed pixels outside both orb discs. */
  beyondOrbs: number;
  /** Changed pixels outside the scan's projected box. */
  outsideScan: number;
  changed: number;
}

/** The right hand's disturber position, world: the target ray, a few cm off the IWER grip pose. */
async function rightHand(xr: Xr): Promise<Vec3> {
  const reactive = (await xr.diag()).reactive as {
    disturbers: { tracked: boolean; position: Vec3 }[];
  };
  // The left controller is parked 60 m under the floor.
  const hand = reactive.disturbers.slice(1).find((d) => d.tracked && d.position[1] > -10);
  if (!hand) throw new Error('no tracked right hand in the reactive diag');
  return hand.position;
}

/**
 * Compares frames `a` (the hover) and `b` (the touch). `orbs` are the hand's two positions, whose
 * glow discs (the orb mesh's radius, projected, plus a margin) are left out of the measures, and
 * `contact` the touch position, round which the ripple annulus is measured on the scan plane.
 */
async function diff(
  page: Page,
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
  view: View,
  contact: Vec3,
  orbs: Vec3[],
  corners: Vec3[],
): Promise<Diff> {
  const device = await page.evaluate(() => {
    const d = window.__goghIwer;
    return d ? { fovy: d.fovy, ipd: d.ipd, stereo: d.stereoEnabled } : null;
  });
  if (!device) throw new Error('IWER is not installed; boot with ?iwer');
  // Stereo would split the canvas into two views, which this projection does not model.
  expect(device.stereo).toBe(false);
  const seen = renderedView(view, device.ipd);
  const focal = height / 2 / Math.tan(device.fovy / 2);
  const forward = forwardOf(seen);
  const [cx, cy] = project(seen, contact, focal, width, height);
  const pxPerM = focal / dot(sub(contact, seen.eye), forward);
  const discs = orbs.map((q) => {
    const [x, y] = project(seen, q, focal, width, height);
    return { x, y, r: (focal * ORB_MESH_RADIUS) / dot(sub(q, seen.eye), forward) + ORB_MARGIN_PX };
  });
  const box = corners.map((q) => project(seen, q, focal, width, height));
  const margin = 4;
  const x0 = Math.min(...box.map((p) => p[0])) - margin;
  const x1 = Math.max(...box.map((p) => p[0])) + margin;
  const y0 = Math.min(...box.map((p) => p[1])) - margin;
  const y1 = Math.max(...box.map((p) => p[1])) + margin;
  let ring = 0;
  let ringChanged = 0;
  let beyondOrbs = 0;
  let outsideScan = 0;
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const moved = a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2];
      const onOrb = discs.some((d) => Math.hypot(x - d.x, y - d.y) < d.r);
      const r = Math.hypot(x - cx, y - cy) / pxPerM;
      const inRing = !onOrb && r > RIPPLE_INNER && r < RIPPLE_OUTER;
      if (inRing) ring++;
      if (!moved) continue;
      changed++;
      if (inRing) ringChanged++;
      if (!onOrb) beyondOrbs++;
      if (x < x0 || x > x1 || y < y0 || y > y1) outsideScan++;
    }
  }
  return { annulus: ring > 0 ? ringChanged / ring : 0, beyondOrbs, outsideScan, changed };
}

/** Boots the gallery in XR and waits for its plaques, so nothing in the room changes after. */
async function bootGallery(xr: Xr): Promise<void> {
  await xr.boot('shot');
  await settled(xr, 'gallery');
  await xr.enterXR();
}

/** Touch point on `id`'s scan, `up` metres above its centre, and the hover on the eye's ray. */
function poses(id: string, up: number) {
  const f = facing(id);
  const touch: Vec3 = [
    f.centre[0] + f.normal[0] * TOUCH_OUT,
    f.centre[1] + up,
    f.centre[2] + f.normal[2] * TOUCH_OUT,
  ];
  const ray = sub(f.view.eye, touch);
  const len = Math.hypot(...ray);
  const hover: Vec3 = [
    touch[0] + (ray[0] / len) * HOVER_BACK,
    touch[1] + (ray[1] / len) * HOVER_BACK,
    touch[2] + (ray[2] / len) * HOVER_BACK,
  ];
  return { ...f, touch, hover };
}

/**
 * The grip pose that puts the hand's target ray at `p.touch`: IWER's target ray sits a few
 * centimetres off the grip it is given, and the quaternion is the same at hover and touch, so the
 * offset measured at hover holds.
 */
const touchGrip = (p: ReturnType<typeof poses>, hoverHand: Vec3): Vec3 =>
  sub(p.touch, sub(hoverHand, p.hover));

/** The hand's signed distance from the scan plane, metres: the ripple's contact test. */
async function touchDistance(xr: Xr, p: ReturnType<typeof poses>): Promise<Vec3> {
  const hand = await rightHand(xr);
  const d = dot(sub(hand, p.centre), p.normal);
  console.log(
    `[e2e] gallery ripple: hand ${hand.map((v) => v.toFixed(3)).join(', ')}, ${d.toFixed(3)} m off the scan`,
  );
  // The contact band: 0.13 m in front to 0.06 m behind.
  expect(d).toBeGreaterThan(-0.06);
  expect(d).toBeLessThan(0.13);
  return hand;
}

test.describe('gallery ripple', () => {
  test.use({ viewport: CAPTURE_SIZE });

  test('a controller at Starry Night ripples the scan inside the frame and settles back', async ({
    page,
    xr,
  }) => {
    test.setTimeout(180_000);
    await bootGallery(xr);
    const p = poses('starry-night', 0.05);
    await place(page, xr, p.view, p.hover);
    await page.waitForTimeout(1000);
    await xr.waitFrames(6);
    expect(await ripple(xr)).toEqual({ contacts: [null, null], amplitude: 1 });
    const hover = await canvasPixels(page);
    const hoverCalls = await calls(xr);
    const hoverHand = await rightHand(xr);

    await place(page, xr, p.view, touchGrip(p, hoverHand));
    await page.waitForTimeout(500);
    await xr.waitFrames(6);
    await touchDistance(xr, p);
    const touching = await ripple(xr);
    const touch = await canvasPixels(page);
    const touchCalls = await calls(xr);
    const touchHand = await rightHand(xr);
    console.log(`[e2e] gallery ripple contact ${JSON.stringify(touching.contacts)}`);
    expect(touching.contacts[0]).toBeNull();
    const right = touching.contacts[1];
    expect(right).not.toBeNull();
    expect(right?.strength ?? 0).toBeGreaterThan(0.5);
    // The target ray sits a few centimetres off the IWER grip pose.
    expect(Math.abs((right?.uv[0] ?? 0) - 0.5)).toBeLessThan(0.1);
    expect(Math.abs((right?.uv[1] ?? 0) - (0.5 + 0.05 / 0.737))).toBeLessThan(0.15);
    // No new draw call, and the hand never opens the portal.
    expect(touchCalls).toBe(hoverCalls);
    expect((await portal(xr)).state).toBe('idle');
    expect((await xr.diag()).painting).toBe('gallery');

    const d = await diff(
      page,
      hover.data,
      touch.data,
      touch.width,
      touch.height,
      p.view,
      touchHand,
      [hoverHand, touchHand],
      p.corners,
    );
    console.log(
      `[e2e] gallery ripple: annulus ${(d.annulus * 100).toFixed(1)}% changed, ${d.beyondOrbs} px beyond the orbs, ${d.outsideScan} px outside the scan, ${d.changed} px in all`,
    );
    expect(d.annulus).toBeGreaterThan(0.1);
    expect(d.outsideScan).toBe(0);

    // Away again: the strength eases to exactly 0 within 0.8 s and the frame is the hover frame.
    await place(page, xr, p.view, p.hover);
    await page.waitForTimeout(1500);
    await xr.waitFrames(6);
    expect((await ripple(xr)).contacts).toEqual([null, null]);
    const back = await canvasPixels(page);
    expect(back.data.equals(hover.data)).toBe(true);
    expect(await glErrors(page)).toEqual([]);
  });

  test('a controller at a coming-soon frame changes nothing but its orb', async ({ page, xr }) => {
    test.setTimeout(180_000);
    await bootGallery(xr);
    const p = poses('chestnut-trees-in-blossom', 0.05);
    await place(page, xr, p.view, p.hover);
    await page.waitForTimeout(1000);
    await xr.waitFrames(6);
    const hover = await canvasPixels(page);
    const hoverCalls = await calls(xr);
    const hoverHand = await rightHand(xr);
    await place(page, xr, p.view, touchGrip(p, hoverHand));
    await page.waitForTimeout(500);
    await xr.waitFrames(6);
    await touchDistance(xr, p);
    expect((await ripple(xr)).contacts).toEqual([null, null]);
    const touch = await canvasPixels(page);
    expect(await calls(xr)).toBe(hoverCalls);
    const touchHand = await rightHand(xr);
    const d = await diff(
      page,
      hover.data,
      touch.data,
      touch.width,
      touch.height,
      p.view,
      touchHand,
      [hoverHand, touchHand],
      p.corners,
    );
    console.log(
      `[e2e] gallery ripple at a coming-soon frame: ${d.beyondOrbs} px beyond the orbs, ${d.changed} px in all`,
    );
    expect(d.beyondOrbs).toBe(0);
    expect(await glErrors(page)).toEqual([]);
  });

  test('with the hand orbs off a controller at Starry Night changes nothing', async ({
    page,
    xr,
  }) => {
    test.setTimeout(180_000);
    await handOrbsOff(page);
    await bootGallery(xr);
    const p = poses('starry-night', 0.05);
    await place(page, xr, p.view, p.hover);
    await page.waitForTimeout(1000);
    await xr.waitFrames(6);
    const hover = await canvasPixels(page);
    await place(page, xr, p.view, touchGrip(p, await rightHand(xr)));
    await page.waitForTimeout(500);
    await xr.waitFrames(6);
    await touchDistance(xr, p);
    expect((await ripple(xr)).contacts).toEqual([null, null]);
    // No orb and no ripple: the frame does not change at all.
    expect((await canvasPixels(page)).data.equals(hover.data)).toBe(true);
    expect(await glErrors(page)).toEqual([]);
  });
});
