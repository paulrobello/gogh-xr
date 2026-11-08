/**
 * Reactive strokes (P4.5): strokes make way round the head and the controllers, and spring back.
 *
 * Every test runs in XR through IWER, whose emulated session renders one full-canvas view into the
 * default framebuffer, so a `?shot` canvas read is the XR frame. `?motionlayers=reactive` keeps
 * only the reactive motion open, so no layer motion moves a stroke between shots (R-P4j). Poses
 * are placed with `__goghPose`, which moves the rig, and the IWER head and controller poses,
 * which are rig-local: the head stands at (0, 1.6, 0) and looks along the rig's yaw, pitched by
 * its own quaternion.
 *
 * The cypress and village poses come from the seed-1 geometry (src/world/cypress.ts, village.ts):
 * the main cypress's axis ring 9 is centred at (-3.36, -1.55, -9.35), its hull 1.29 m from the
 * axis towards the painter along (0.338, 0, 0.941). House 10's front wall centre is at
 * (4.56, -2.63, -16.68), facing (-0.186, 0, 0.983).
 */
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { MAX_MOTION_DT_S } from '../../src/motion/clock.ts';
import { REACTIVE_MOTION_BIT } from '../../src/motion/layers.ts';
import {
  HAND_STRENGTH,
  HEAD_STRENGTH,
  REACTIVE_RADIUS,
  REACTIVE_REACH,
  type ReactiveField,
  reactiveMotion,
  WAKE_WINDOW_S,
} from '../../src/motion/reactive.ts';
import { luma, shiftAt } from './block-match';
import { expect, glErrors, test, type Vec3, type Xr } from './fixtures';

const VIEW = { width: 1280, height: 1014 } as const;
/** Most bare share allowed at any pose (P2-A3). */
const MAX_BARE = 0.005;
/** Rig-local, 60 m under the floor: no stroke is within the radius of it. */
const PARKED: Vec3 = [0, -60, 0];
const EYE_HEIGHT = 1.6;

interface DisturberDiag {
  tracked: boolean;
  position: Vec3;
  velocity: Vec3;
  strength: number;
  wake: number;
  wakeWeight: number;
  jumps: number;
}
interface ReactiveDiag {
  frames: number;
  discontinuity: number;
  resets: number;
  boxStrokes: number | null;
  disturbers: DisturberDiag[];
  box: { min: Vec3; max: Vec3 } | null;
}

async function reactive(xr: Xr): Promise<ReactiveDiag> {
  return (await xr.diag()).reactive as ReactiveDiag;
}

/** A view: the eye's world position, its yaw (0 faces -Z) and pitch (up positive). */
interface View {
  eye: Vec3;
  yaw: number;
  pitch: number;
}

const AXIS_9: Vec3 = [-3.36, -1.55, -9.35];
const CYPRESS_OUT: Vec3 = [0.338, 0, 0.941];
const CYPRESS_HULL = 1.29;
/** The eye `distance` metres out from the cypress hull, facing its axis. */
function cypressView(distance: number): View {
  const r = CYPRESS_HULL + distance;
  return {
    eye: [AXIS_9[0] + r * CYPRESS_OUT[0], AXIS_9[1], AXIS_9[2] + r * CYPRESS_OUT[2]],
    yaw: Math.atan2(CYPRESS_OUT[0], CYPRESS_OUT[2]),
    pitch: 0,
  };
}
const HOUSE_WALL: Vec3 = [4.56, -2.63, -16.68];
const HOUSE_OUT: Vec3 = [-0.186, 0, 0.983];
/** The eye `distance` metres out from house 10's front wall, facing it. */
function villageView(distance: number): View {
  return {
    eye: [
      HOUSE_WALL[0] + distance * HOUSE_OUT[0],
      HOUSE_WALL[1],
      HOUSE_WALL[2] + distance * HOUSE_OUT[2],
    ],
    yaw: Math.atan2(HOUSE_OUT[0], HOUSE_OUT[2]),
    pitch: 0,
  };
}

/** Rig-local point `distance` metres ahead of the head along its view. */
function ahead(view: View, distance: number): Vec3 {
  return [0, EYE_HEIGHT + distance * Math.sin(view.pitch), -distance * Math.cos(view.pitch)];
}

/** The world position of rig-local `local` for the rig `place` set for `view`. */
function world(view: View, local: Vec3): Vec3 {
  const s = Math.sin(view.yaw);
  const c = Math.cos(view.yaw);
  const [x, y, z] = local;
  return [view.eye[0] + c * x + s * z, view.eye[1] - EYE_HEIGHT + y, view.eye[2] - s * x + c * z];
}

async function bootXr(page: Page, xr: Xr, extra: string): Promise<void> {
  await xr.boot(`painting=starry-night&seed=1&shot&nogov&nohalo&${extra}`);
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
    .toBe(true);
  await xr.enterXR();
  void page;
}

/** Places the rig and the head for `view`, and both controllers at rig-local `left` and `right`. */
async function place(page: Page, xr: Xr, view: View, left: Vec3, right: Vec3): Promise<void> {
  const [x, y, z] = view.eye;
  await page.evaluate(
    ([px, py, pz, yaw]) => {
      if (!window.__goghPose) throw new Error('__goghPose is not installed; boot with ?diag');
      window.__goghPose(px, py, pz, yaw, 0);
    },
    [x, y, z, view.yaw] as const,
  );
  await xr.setPose({
    head: {
      position: [0, EYE_HEIGHT, 0],
      quaternion: [Math.sin(view.pitch / 2), 0, 0, Math.cos(view.pitch / 2)],
    },
    left: { position: left },
    right: { position: right },
  });
}

/** Waits out the wake window, so a still pose has no wake and no velocity left. */
async function settle(page: Page, xr: Xr): Promise<void> {
  await page.waitForTimeout(WAKE_WINDOW_S * 1000 + 300);
  await xr.waitFrames(4);
}

/** The canvas keeps its drawing buffer (`?shot`): the last XR frame, as raw RGBA. */
async function canvasPixels(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    return canvas.toDataURL('image/png');
  });
  const png = Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64');
  return sharp(png).ensureAlpha().raw().toBuffer();
}

async function canvasSize(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });
}

/** Mostly magenta pixels, as world-coverage.spec.ts counts them, over the last XR frame. */
function bareShare(raw: Buffer): number {
  let bare = 0;
  const pixels = raw.length / 4;
  for (let i = 0; i < raw.length; i += 4) {
    if (raw[i] > 192 && raw[i + 1] < 64 && raw[i + 2] > 192) bare++;
  }
  return bare / pixels;
}

/**
 * Pixels that differ between `a` and `b`, split by the distance from the frame centre: inside
 * `inner` px, the mean channel difference; past `outer` px, the count of differing pixels.
 */
function radialDiff(
  a: Buffer,
  b: Buffer,
  size: { width: number; height: number },
  inner: number,
  outer: number,
): { innerMean: number; innerChanged: number; outerChanged: number; changed: number } {
  const { width, height } = size;
  const cx = width / 2;
  const cy = height / 2;
  let sum = 0;
  let n = 0;
  let innerChanged = 0;
  let outerChanged = 0;
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4;
      const d =
        Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]);
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > 0) changed++;
      if (r <= inner) {
        sum += d / 3;
        n++;
        if (d > 0) innerChanged++;
      } else if (r > outer && d > 0) {
        outerChanged++;
      }
    }
  }
  return { innerMean: sum / n, innerChanged: innerChanged / n, outerChanged, changed };
}

/** Pixels from the frame centre to a point `angle` radians off the view axis. */
async function pixelsAt(page: Page, angle: number, height: number): Promise<number> {
  const fovy = await page.evaluate(() => window.__goghIwer?.fovy ?? Math.PI / 2);
  return ((height / 2) * Math.tan(angle)) / Math.tan(fovy / 2);
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Frame pixel of world point `q` for `view` (pitch 0), `focal` px per unit tangent. */
function project(view: View, q: Vec3, focal: number): [number, number] {
  const v = sub(q, view.eye);
  const forward = sub(world(view, ahead(view, 1)), view.eye);
  const right = sub(world(view, [1, EYE_HEIGHT, 0]), view.eye);
  const depth = dot(v, forward);
  return [
    VIEW.width / 2 + (focal * dot(v, right)) / depth,
    VIEW.height / 2 - (focal * v[1]) / depth,
  ];
}

/**
 * Whether a measured shift agrees with a predicted one: it points the same way (cosine over 0.7)
 * and its length is within a factor of 2.5 of the prediction.
 */
function agrees(measured: [number, number], predicted: [number, number]): boolean {
  const lm = Math.hypot(...measured);
  const lp = Math.hypot(...predicted);
  if (lm === 0 || lp === 0) return false;
  const cosine = (measured[0] * predicted[0] + measured[1] * predicted[1]) / (lm * lp);
  return cosine > 0.7 && lm > lp / 2.5 && lm < lp * 2.5;
}

test.describe('reactive strokes (P4.5)', () => {
  test.use({ viewport: VIEW });

  test('a controller in the cypress pushes the strokes within its radius, the rest hold, and they spring back (R-P4g)', async ({
    page,
    xr,
  }) => {
    test.setTimeout(240_000);
    await bootXr(page, xr, 'motionlayers=reactive');
    expect(((await xr.diag()).motion as { layers: number }).layers).toBe(REACTIVE_MOTION_BIT);
    // The eye 2.4 m out from the hull: no stroke within the head's radius. The controller 0.1 m
    // inside the hull, straight ahead, so it projects onto the frame centre.
    const view = cypressView(2.4);
    const inside = ahead(view, 2.5);
    await place(page, xr, view, PARKED, PARKED);
    await settle(page, xr);
    const before = await reactive(xr);
    const far = await canvasPixels(page);
    await place(page, xr, view, PARKED, inside);
    await settle(page, xr);
    const pushed = await canvasPixels(page);
    const during = await reactive(xr);
    await place(page, xr, view, PARKED, PARKED);
    await settle(page, xr);
    const back = await canvasPixels(page);
    const after = await reactive(xr);

    // The diag follows the IWER poses: the head at the eye (IWER's view origin sits a couple of
    // centimetres off its head pose), one controller slot at the pushing point (its target ray
    // sits a few centimetres off the grip), and nothing moving once still.
    expect(during.frames).toBeGreaterThan(before.frames);
    const [headDiag] = during.disturbers;
    expect(headDiag.tracked).toBe(true);
    expect(headDiag.strength).toBe(HEAD_STRENGTH);
    for (let a = 0; a < 3; a++)
      expect(Math.abs(headDiag.position[a] - view.eye[a])).toBeLessThan(0.05);
    const target = world(view, inside);
    const hands = during.disturbers.slice(1);
    expect(hands.every((d) => d.tracked && d.strength === HAND_STRENGTH)).toBe(true);
    const nearest = Math.min(
      ...hands.map((d) => Math.hypot(...d.position.map((v, a) => v - target[a]))),
    );
    console.log(`[e2e] reactive: nearest controller ${nearest.toFixed(3)} m from the push point`);
    expect(nearest).toBeLessThan(0.15);
    for (const d of [...during.disturbers, ...after.disturbers]) {
      expect(Math.hypot(...d.velocity)).toBe(0);
    }
    // Each placed pose is a discontinuity: the histories restarted, so no wake was drawn across
    // the map.
    expect(after.resets).toBeGreaterThan(before.resets);
    expect(after.discontinuity).toBeGreaterThan(before.discontinuity);

    const size = await canvasSize(page);
    expect(size).toEqual(VIEW);
    // Strokes whose centre is within the radius move by at most the reach; each spans at most
    // about 0.5 m past its centre on the cypress. Seen 2.4 m off, anything changed lies inside
    // asin((R + reach + 0.5) / 2.4) of the centre.
    const outer = await pixelsAt(
      page,
      Math.asin((REACTIVE_RADIUS + REACTIVE_REACH + 0.5) / 2.4),
      size.height,
    );
    const inner = await pixelsAt(page, Math.atan(0.3 / 2.4), size.height);
    const moved = radialDiff(far, pushed, size, inner, outer);
    const sprung = radialDiff(far, back, size, inner, outer);
    console.log(
      `[e2e] reactive cypress: inner ${inner.toFixed(0)} px mean diff ${moved.innerMean.toFixed(2)}, ${(moved.innerChanged * 100).toFixed(1)}% changed; past ${outer.toFixed(0)} px ${moved.outerChanged} changed; ${moved.changed} changed in all; back vs far ${sprung.changed}`,
    );
    expect(moved.innerMean).toBeGreaterThan(2);
    expect(moved.innerChanged).toBeGreaterThan(0.2);
    expect(moved.outerChanged).toBe(0);

    // Direction: a patch on the hull 0.3 m right of the push point, near the push's peak, moves
    // outward, away from the controller, by about what the TS mirror predicts for a stroke there on
    // the ring-9 circle (measured 22.3 px against 17.7 px). The flipped prediction, a push toward
    // the controller, must fail the same check, so a reversed push in motion.glsl fails this test.
    // Only the right: left of the push point the hull turns away from the ring-9 circle, so the
    // strokes there sit past the radius and the circle's prediction does not hold.
    const focal =
      size.height /
      2 /
      Math.tan((await page.evaluate(() => window.__goghIwer?.fovy ?? Math.PI / 2)) / 2);
    const field: ReactiveField = {
      disturbers: [
        { position: headDiag.position, velocity: [0, 0, 0], strength: HEAD_STRENGTH },
        { position: target, velocity: [0, 0, 0], strength: HAND_STRENGTH },
        { position: PARKED, velocity: [0, 0, 0], strength: 0 },
      ],
      wake: [],
    };
    const farL = luma(far);
    const pushedL = luma(pushed);
    {
      const side = 1;
      const phi = (side * 0.3) / CYPRESS_HULL;
      const out: Vec3 = [
        CYPRESS_OUT[0] * Math.cos(phi) + CYPRESS_OUT[2] * Math.sin(phi),
        0,
        -CYPRESS_OUT[0] * Math.sin(phi) + CYPRESS_OUT[2] * Math.cos(phi),
      ];
      const q: Vec3 = [
        AXIS_9[0] + CYPRESS_HULL * out[0],
        AXIS_9[1],
        AXIS_9[2] + CYPRESS_HULL * out[2],
      ];
      const u = reactiveMotion(q, out, field).offset;
      const [px, py] = project(view, q, focal);
      const [mx, my] = project(view, [q[0] + u[0], q[1] + u[1], q[2] + u[2]], focal);
      const predicted: [number, number] = [mx - px, my - py];
      const m = shiftAt(farL, pushedL, Math.round(px), Math.round(py), 10, 36);
      const measured: [number, number] = [m.dx, m.dy];
      console.log(
        `[e2e] reactive push 0.3 m right: predicted (${predicted[0].toFixed(1)}, ${predicted[1].toFixed(1)}) px (${(Math.hypot(...u) * 100).toFixed(1)} cm), measured (${m.dx.toFixed(1)}, ${m.dy.toFixed(1)}) px, sharpness ${m.sharpness.toFixed(1)}`,
      );
      // Outward: away from the frame centre, where the controller projects.
      expect(Math.sign(predicted[0])).toBe(side);
      expect(m.sharpness).toBeGreaterThan(3);
      expect(agrees(measured, predicted)).toBe(true);
      expect(agrees(measured, [-predicted[0], -predicted[1]])).toBe(false);
    }
    // Spring back: with the controller gone the frame is the far frame, byte for byte.
    expect(back.equals(far)).toBe(true);
    expect(await glErrors(page)).toEqual([]);
  });

  test('a controller at the surface or just inside it keeps the cypress and the village within 0.5% bare (R-P4o)', async ({
    page,
    xr,
  }) => {
    test.setTimeout(600_000);
    // Every motion layer open, as shipped, at the pinned-coverage checks' two times
    // (world-coverage.spec.ts), so the cypress flame's wrap and the push meet in one frame and the
    // pair of frames differs by the push alone. Each row is [eye metres off the surface, controller
    // metres ahead of the eye]: at 0.3-0.4 m off the surface the head pushes as well (its radius is
    // 0.6 m), and the controller reaches the surface or 0.1 m past it. The ruling's own pose is the
    // eye 0.3 m off the cypress with the controller 0.3 m ahead. The 0.3 m-deep rows are measured
    // and reported, not held.
    const held: readonly [number, number, string][] = [
      [0.6, 0.3, '0.3 m short'],
      [0.3, 0.3, 'at the surface (ruling pose)'],
      [0.4, 0.4, 'at the surface'],
      [0.4, 0.5, '0.1 m inside'],
    ];
    const measured: readonly [number, number, string][] = [[0.4, 0.7, '0.3 m inside']];
    const rows: {
      name: string;
      time: number;
      label: string;
      far: number;
      near: number;
      hold: boolean;
    }[] = [];
    for (const time of [0.5, 3.7]) {
      await bootXr(page, xr, `coverage&motiont=${time}`);
      expect(((await xr.diag()).world as { debug: string }).debug).toBe('coverage');
      const motion = (await xr.diag()).motion as { time: number; layers: number };
      expect(motion.time).toBe(time);
      expect(motion.layers & REACTIVE_MOTION_BIT).toBe(REACTIVE_MOTION_BIT);
      for (const [name, at] of [
        ['cypress', cypressView],
        ['village', villageView],
      ] as const) {
        const parkedAt = new Map<number, Buffer>();
        for (const [eye, hand, label] of [...held, ...measured]) {
          const view = at(eye);
          let parked = parkedAt.get(eye);
          if (!parked) {
            await place(page, xr, view, PARKED, PARKED);
            await settle(page, xr);
            parked = await canvasPixels(page);
            parkedAt.set(eye, parked);
          }
          await place(page, xr, view, PARKED, ahead(view, hand));
          await settle(page, xr);
          const near = await canvasPixels(page);
          // The controller reaches the surface: the frames differ.
          expect(near.equals(parked), `${name} ${label} at ${time}`).toBe(false);
          const row = {
            name,
            time,
            label: `eye ${eye} m off, controller ${hand} m ahead, ${label}`,
            far: bareShare(parked),
            near: bareShare(near),
            hold: held.some((h) => h[0] === eye && h[1] === hand),
          };
          console.log(
            `[e2e] reactive coverage ${name} at motiont ${time}, ${row.label}: parked ${(row.far * 100).toFixed(3)}%, held ${(row.near * 100).toFixed(3)}%${row.hold ? '' : ' (measured, not held)'}`,
          );
          rows.push(row);
        }
      }
    }
    for (const r of rows) {
      expect(r.far, `${r.name} ${r.label} at ${r.time}`).toBeLessThanOrEqual(MAX_BARE);
      if (r.hold) expect(r.near, `${r.name} ${r.label} at ${r.time}`).toBeLessThanOrEqual(MAX_BARE);
    }
    expect(await glErrors(page)).toEqual([]);
  });

  test('counts the drawn strokes inside the reactive box, still and through a 1.5 m/s sweep (I2)', async ({
    page,
    xr,
  }) => {
    test.setTimeout(240_000);
    // The cypress coverage pose: the eye 0.6 m off the hull, the controller 0.3 m ahead of it.
    await bootXr(page, xr, '');
    const view = cypressView(0.6);
    await place(page, xr, view, PARKED, ahead(view, 0.3));
    await settle(page, xr);
    const still = await reactive(xr);
    expect(still.boxStrokes).not.toBeNull();
    // A sweep across the hull at 1.5 m/s for one wake window, 0.3 m ahead of the eye, rig-local
    // x from -0.9 m: the box stretches along the weighted wake.
    const swept = await page.evaluate(
      async ([window_s, eyeHeight]) => {
        const device = window.__goghIwer;
        const diag = window.__goghDiag;
        if (!device || !diag) throw new Error('boot with ?iwer&diag');
        const right = device.controllers.right;
        if (!right) throw new Error('no right controller');
        let most = 0;
        let span = 0;
        const t0 = performance.now();
        await new Promise<void>((done) => {
          const step = (now: number): void => {
            const t = (now - t0) / 1000;
            right.position.set(-0.9 + 1.5 * t, eyeHeight, -0.3);
            const r = diag().reactive as {
              boxStrokes: number | null;
              box: { min: number[]; max: number[] } | null;
            };
            most = Math.max(most, r.boxStrokes ?? 0);
            if (r.box) span = Math.max(span, r.box.max[0] - r.box.min[0]);
            if (t < window_s) requestAnimationFrame(step);
            else done();
          };
          requestAnimationFrame(step);
        });
        return { most, span };
      },
      [WAKE_WINDOW_S, EYE_HEIGHT] as const,
    );
    console.log(
      `[e2e] reactive box strokes at the cypress pose: still ${still.boxStrokes}, through a 1.5 m/s sweep up to ${swept.most} (box up to ${swept.span.toFixed(2)} m along world x)`,
    );
    expect(still.boxStrokes ?? 0).toBeGreaterThan(0);
    expect(swept.most).toBeGreaterThan(still.boxStrokes ?? 0);
    expect(await glErrors(page)).toEqual([]);
  });
  test('motion integration: a controller swept through the cypress updates the reactive uniforms, the motion time steps at calm 1 and holds at calm 0 (P4.6)', async ({
    page,
    xr,
  }) => {
    test.setTimeout(300_000);
    /** Motion time steps over the next `frames` animation frames, read in the page. */
    const deltas = (frames: number): Promise<{ delta: number; time: number }[]> =>
      page.evaluate(
        (n) =>
          new Promise((done) => {
            const out: { delta: number; time: number }[] = [];
            const step = (): void => {
              const diag = window.__goghDiag;
              if (!diag) throw new Error('boot with ?diag');
              const m = (diag() as { motion: { delta: number; time: number } }).motion;
              out.push({ delta: m.delta, time: m.time });
              if (out.length < n) requestAnimationFrame(step);
              else done(out);
            };
            requestAnimationFrame(step);
          }),
        frames,
      );
    /**
     * Sweeps the right controller rig-local along x from -0.4 to 0.4 m at 1.5 m/s, `ahead` metres
     * in front of the eye at eye height, and reads the reactive diag every frame of the sweep.
     */
    const sweep = (
      ahead: number,
    ): Promise<
      { box: { min: Vec3; max: Vec3 } | null; hand: DisturberDiag; boxStrokes: number | null }[]
    > =>
      page.evaluate(
        ([z, eyeHeight]) =>
          new Promise((done) => {
            const device = window.__goghIwer;
            const diag = window.__goghDiag;
            if (!device || !diag) throw new Error('boot with ?iwer&diag');
            const right = device.controllers.right;
            if (!right) throw new Error('no right controller');
            const out: {
              box: { min: Vec3; max: Vec3 } | null;
              hand: DisturberDiag;
              boxStrokes: number | null;
            }[] = [];
            const t0 = performance.now();
            const step = (now: number): void => {
              const t = (now - t0) / 1000;
              right.position.set(-0.4 + 1.5 * Math.min(t, 0.8 / 1.5), eyeHeight, -z);
              const r = diag().reactive as ReactiveDiag;
              // The swept slot: the other one is parked 60 m under the floor.
              const hand = r.disturbers
                .slice(1)
                .reduce((a, b) => (b.position[1] > a.position[1] ? b : a));
              out.push({ box: r.box, hand, boxStrokes: r.boxStrokes });
              if (t < 0.8 / 1.5) requestAnimationFrame(step);
              else done(out);
            };
            requestAnimationFrame(step);
          }),
        [ahead, EYE_HEIGHT] as const,
      );

    // Calm 1, every motion layer open, as shipped.
    await bootXr(page, xr, '');
    const view = cypressView(2.4);
    // The controller 0.1 m inside the hull: the sweep runs through the cypress strokes.
    const inside = 2.5;
    await place(page, xr, view, PARKED, PARKED);
    await settle(page, xr);
    const live = await deltas(12);
    console.log(
      `[e2e] integration calm 1 motion deltas ${live.map((d) => d.delta.toFixed(4)).join(' ')}`,
    );
    expect(live.some((d) => d.delta > 0)).toBe(true);
    for (const d of live) expect(d.delta).toBeLessThanOrEqual(MAX_MOTION_DT_S + 1e-9);
    expect(live.at(-1)?.time ?? 0).toBeGreaterThan(live[0].time);
    const before = await reactive(xr);
    await place(page, xr, view, PARKED, [-0.4, EYE_HEIGHT, -inside]);
    const frames = await sweep(inside);
    const after = await reactive(xr);

    // The uniforms follow the sweep: the hand's strength and velocity, its wake weights and the
    // box round it, frame by frame.
    expect(after.frames).toBeGreaterThan(before.frames + frames.length - 1);
    expect(frames.length).toBeGreaterThan(5);
    const moving = frames.filter((f) => Math.hypot(...f.hand.velocity) > 1);
    expect(moving.length).toBeGreaterThan(frames.length / 2);
    expect(moving.every((f) => f.hand.strength === HAND_STRENGTH)).toBe(true);
    expect(Math.max(...frames.map((f) => f.hand.wakeWeight))).toBeGreaterThan(0);
    for (const f of frames) {
      if (!f.box) throw new Error('the reactive box is empty during the sweep');
      // The box holds the hand grown by the radius on every axis.
      for (let a = 0; a < 3; a++) {
        expect(f.hand.position[a] - REACTIVE_RADIUS).toBeGreaterThan(f.box.min[a] - 1e-4);
        expect(f.hand.position[a] + REACTIVE_RADIUS).toBeLessThan(f.box.max[a] + 1e-4);
      }
    }
    const first = frames[0].box as { min: Vec3; max: Vec3 };
    const last = frames.at(-1)?.box as { min: Vec3; max: Vec3 };
    // The box moves with the hand between the first and the last frame.
    const moves = Math.max(
      ...[0, 1, 2].flatMap((a) => [
        Math.abs(last.min[a] - first.min[a]),
        Math.abs(last.max[a] - first.max[a]),
      ]),
    );
    expect(moves).toBeGreaterThan(0.2);
    expect(Math.max(...frames.map((f) => f.boxStrokes ?? 0))).toBeGreaterThan(0);
    console.log(
      `[e2e] integration sweep: ${frames.length} frames, hand wake weight up to ${Math.max(...frames.map((f) => f.hand.wakeWeight)).toFixed(3)}, box moved up to ${moves.toFixed(2)} m, box strokes up to ${Math.max(...frames.map((f) => f.boxStrokes ?? 0))}`,
    );
    expect(await glErrors(page)).toEqual([]);

    // Calm 0 closes the gate: the motion time holds, the tracker still writes its uniforms, and a
    // controller inside the cypress moves nothing.
    await bootXr(page, xr, 'calm=0');
    await place(page, xr, view, PARKED, PARKED);
    await settle(page, xr);
    const still = await deltas(12);
    expect(still.every((d) => d.delta === 0)).toBe(true);
    expect(still.every((d) => d.time === still[0].time)).toBe(true);
    const parkedStill = await canvasPixels(page);
    const quiet = await reactive(xr);
    await place(page, xr, view, PARKED, [-0.4, EYE_HEIGHT, -inside]);
    const framesStill = await sweep(inside);
    const sweptStill = await canvasPixels(page);
    expect((await reactive(xr)).frames).toBeGreaterThan(quiet.frames);
    expect(Math.max(...framesStill.map((f) => f.hand.wakeWeight))).toBeGreaterThan(0);
    expect(sweptStill.equals(parkedStill)).toBe(true);
    expect(await glErrors(page)).toEqual([]);
  });
  /**
   * Samples the reactive diag every animation frame for `ms`, optionally sweeping the right
   * controller rig-local along x from -0.4 m at 1.5 m/s for 0.8/1.5 s, `z` metres ahead of the eye.
   * Reports the largest wake weight and speed over every disturber (the swept hand alone for the
   * sweep), the swept hand's strongest single wake sample, the largest box stroke count and how far
   * the rig moved.
   *
   * The sweep is a function of the XR frame's own time, set in the controller's `onFrameStart`
   * just before IWER copies the pose into the target-ray space. IWER stamps a frame with
   * `performance.now()` inside its callback, which jitters by ±2-4 ms against the window rAF
   * stamp, and it reads a pose set from rAF only on the next tick. A rAF-timed sweep therefore
   * reached the tracker at 1.5 × (previous rAF interval) / (this XR interval): 1.34-1.71 m/s on a
   * quiet host, past 2 m/s under load.
   */
  const watch = (
    page: Page,
    ms: number,
    sweepAhead: number | null,
  ): Promise<{
    weight: number;
    peak: number;
    speed: number;
    handSpeed: number;
    boxStrokes: number;
    moved: number;
  }> =>
    page.evaluate(
      ([duration, z, eyeHeight]) =>
        new Promise((done) => {
          const device = window.__goghIwer;
          const diag = window.__goghDiag;
          if (!device || !diag) throw new Error('boot with ?iwer&diag');
          const right = device.controllers.right;
          if (!right) throw new Error('no right controller');
          const rig0 = (diag().rig as { position: number[] }).position;
          const start = [rig0[0], rig0[1], rig0[2]];
          const out = { weight: 0, peak: 0, speed: 0, handSpeed: 0, boxStrokes: 0, moved: 0 };
          if (z !== null) {
            const frameStart = right.onFrameStart.bind(right);
            let sweepT0: number | null = null;
            right.onFrameStart = (frame) => {
              const time = frame.predictedDisplayTime;
              sweepT0 ??= time;
              const t = (time - sweepT0) / 1000;
              right.position.set(-0.4 + 1.5 * Math.min(t, 0.8 / 1.5), eyeHeight, -z);
              frameStart(frame);
            };
          }
          const t0 = performance.now();
          const step = (now: number): void => {
            const t = (now - t0) / 1000;
            const d = diag() as {
              reactive: {
                boxStrokes: number | null;
                disturbers: {
                  velocity: number[];
                  wakeWeight: number;
                  wakePeak: number;
                  position: number[];
                }[];
              };
              rig: { position: number[] };
            };
            for (const dist of d.reactive.disturbers) {
              out.speed = Math.max(
                out.speed,
                Math.hypot(dist.velocity[0], dist.velocity[1], dist.velocity[2]),
              );
              if (z === null) out.weight = Math.max(out.weight, dist.wakeWeight);
            }
            if (z !== null) {
              const hand = d.reactive.disturbers
                .slice(1)
                .reduce((a, b) => (b.position[1] > a.position[1] ? b : a));
              out.weight = Math.max(out.weight, hand.wakeWeight);
              out.peak = Math.max(out.peak, hand.wakePeak);
              out.handSpeed = Math.max(
                out.handSpeed,
                Math.hypot(hand.velocity[0], hand.velocity[1], hand.velocity[2]),
              );
            }
            out.boxStrokes = Math.max(out.boxStrokes, d.reactive.boxStrokes ?? 0);
            out.moved = Math.hypot(
              d.rig.position[0] - start[0],
              d.rig.position[1] - start[1],
              d.rig.position[2] - start[2],
            );
            if (t * 1000 < duration) requestAnimationFrame(step);
            else {
              Reflect.deleteProperty(right, 'onFrameStart');
              done(out);
            }
          };
          requestAnimationFrame(step);
        }),
      [ms, sweepAhead, EYE_HEIGHT] as const,
    );

  test('stick-walking past strokes with a hand held still leaves no wake, and the static push still moves them (Q41)', async ({
    page,
    xr,
  }) => {
    test.setTimeout(240_000);
    await bootXr(page, xr, 'motionlayers=reactive');
    const view = cypressView(2.4);
    // The controller 0.8 m short of the hull, still in the rig while the stick walks the rig up to
    // it: the walk brings the hull into the hand's reach, not the hand's motion.
    const inside = ahead(view, 1.6);
    await place(page, xr, view, PARKED, inside);
    await settle(page, xr);
    const held = await watch(page, 300, null);
    expect(held.speed).toBe(0);
    await xr.stick('left', 0, -1);
    const walking = await watch(page, 350, null);
    await xr.stick('left', 0, 0);
    console.log(
      `[e2e] walking past a held hand: rig moved ${walking.moved.toFixed(2)} m, wake weight ${walking.weight.toExponential(2)}, speed ${walking.speed.toExponential(2)}, box strokes up to ${walking.boxStrokes}`,
    );
    expect(walking.moved).toBeGreaterThan(0.3);
    expect(walking.weight).toBeLessThan(1e-3);
    expect(walking.speed).toBeLessThan(1e-3);
    // The proximity push is tied to world positions: strokes were within the hand's box.
    expect(walking.boxStrokes).toBeGreaterThan(0);
    await settle(page, xr);
    const hand = await canvasPixels(page);
    // The same rig pose with the hand parked 60 m down: the held hand's push is what differs.
    await xr.setPose({ right: { position: PARKED }, left: { position: PARKED } });
    await settle(page, xr);
    const parked = await canvasPixels(page);
    const diff = radialDiff(hand, parked, await canvasSize(page), 1e9, 1e9);
    console.log(
      `[e2e] static push after the walk: ${diff.changed} pixels differ from the parked hand`,
    );
    expect(diff.changed).toBeGreaterThan(100);
    expect(await glErrors(page)).toEqual([]);
  });

  test('a controller swept physically leaves the same wake weight whether the rig is still or walking at 2 m/s (Q41)', async ({
    page,
    xr,
  }) => {
    test.setTimeout(240_000);
    await bootXr(page, xr, 'motionlayers=reactive');
    const view = cypressView(2.4);
    const inside = 2.5;
    await place(page, xr, view, PARKED, [-0.4, EYE_HEIGHT, -inside]);
    await settle(page, xr);
    const still = await watch(page, 900, inside);
    await place(page, xr, view, PARKED, [-0.4, EYE_HEIGHT, -inside]);
    await settle(page, xr);
    await xr.stick('left', 0, -1);
    const walking = await watch(page, 900, inside);
    await xr.stick('left', 0, 0);
    console.log(
      `[e2e] sweep wake: rig still sum ${still.weight.toFixed(3)} peak ${still.peak.toFixed(3)} (hand ${still.handSpeed.toFixed(2)} m/s), rig walking sum ${walking.weight.toFixed(3)} peak ${walking.peak.toFixed(3)} (hand ${walking.handSpeed.toFixed(2)} m/s, rig moved ${walking.moved.toFixed(2)} m)`,
    );
    expect(walking.moved).toBeGreaterThan(0.5);
    expect(still.weight).toBeGreaterThan(0.3);
    // The strongest single sample, not the sum: the sum follows how many samples irregular frame
    // timing took and how old they were on the frame it peaked.
    expect(still.peak).toBeGreaterThan(0.5);
    expect(walking.peak).toBeGreaterThan(still.peak * 0.75);
    expect(walking.peak).toBeLessThan(still.peak * 1.25);
    // Catches a reintroduced clock lag: the rAF-timed sweep read up to 1.71 m/s.
    expect(still.handSpeed).toBeCloseTo(1.5, 1);
    expect(walking.handSpeed).toBeCloseTo(1.5, 1);
    // Rig-relative, the hand reads the 1.5 m/s sweep. World velocity would add the rig's motion: at
    // least hypot(1.5, 2) = 2.5 m/s from the 2 m/s walk along rig -z, and a forced world-velocity
    // tracker read 3.00 m/s, the clamp. This bar carries the Q41 check: the wake share is capped at
    // 1 from 1.5 m/s, so the peak bars read the same (0.946) under world velocity.
    expect(walking.handSpeed).toBeLessThan(2);
    expect(await glErrors(page)).toEqual([]);
  });
});
