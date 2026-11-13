/**
 * Locomotion smoke checks (P3.2 to P3.5): the left stick and WASD move the rig through the Starry
 * Night world, its y follows the terrain, and the rendered eye moves with it; the right stick and
 * T aim and commit a teleport; F flies and Space climbs. P3.6 adds the heading, rejected-teleport,
 * flight-cap, boundary push-back and seated-offset checks at the end of the file.
 *
 * `__goghDiag().camera` is the camera that rendered the last frame in world space: three's XR
 * camera while presenting, whose matrices include the rig.
 */

import os from 'node:os';
import type { Page } from '@playwright/test';
import {
  createArcResult,
  MAX_RANGE,
  MAX_SLOPE_DEG,
  traceArc,
} from '../../src/locomotion/teleport.ts';
import { PAINTER_SPOT } from '../../src/paintings/starry-night/canvas-camera.ts';
import {
  createFootprintTest,
  createVolumes,
  createVolumeTest,
} from '../../src/paintings/starry-night/footprints.ts';
import { createTerrain } from '../../src/world/terrain.ts';
import { createVillage } from '../../src/world/village.ts';
import { expect, type Quat, test, type Vec3, type Xr } from './fixtures';

interface RigDiag {
  position: [number, number, number];
  yaw: number;
  mode: string;
  altitude: number;
  haze: number;
  seated: boolean;
  grounded: boolean;
  speed: number;
  turnMode: string;
  vignette: number;
  aim: { active: boolean; valid: boolean; reason: string; hit: Vec3 | null };
  lastTeleport: { from: Vec3; to: Vec3; t: number } | null;
}

const SNAP_30 = -Math.PI / 6;

/** The world's terrain: seed 1, as the boot below uses no `?seed`. */
const terrain = createTerrain(1);
/** The world's house and church footprints, as `WorldHandle.blocked` tests them. */
const village = createVillage(1, terrain);
const blocked = createFootprintTest(village);
const volume = createVolumeTest(village);
const volumes = createVolumes(village);
const WORLD = 'painting=starry-night&noanim&nogov';

/** A rotation about +X: a negative angle pitches a -Z ray down. */
function pitch(deg: number): Quat {
  const half = (deg * Math.PI) / 360;
  return [Math.sin(half), 0, 0, Math.cos(half)];
}

/** Asserts a landing the brief calls valid: on the ground, level enough, in bounds, off houses. */
function expectValidLanding(from: Vec3, to: Vec3): void {
  const [x, y, z] = to;
  expect(y).toBeCloseTo(terrain.heightAt(x, z), 3);
  const normal = terrain.normalAt(x, z);
  const slope = (Math.acos(normal[1] / Math.hypot(...normal)) * 180) / Math.PI;
  expect(slope).toBeLessThan(MAX_SLOPE_DEG);
  // In bounds: boundaryFactor is 0 inside 45 m of the painter's spot (src/world/boundary.ts, which
  // the e2e cannot import: its stroke-material chain loads GLSL through Vite).
  expect(Math.hypot(x - PAINTER_SPOT[0], y - PAINTER_SPOT[1], z - PAINTER_SPOT[2])).toBeLessThan(
    45,
  );
  expect(blocked(x, z)).toBe(false);
  expect(Math.hypot(x - from[0], z - from[2])).toBeLessThanOrEqual(MAX_RANGE);
}

async function rig(xr: Xr): Promise<RigDiag> {
  return (await xr.diag()).rig as RigDiag;
}

async function bootWorld(xr: Xr, query: string): Promise<void> {
  await xr.boot(query);
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
    .toBe(true);
}

/**
 * How far the rig's y is from the terrain under the head. Locomotion samples the ground at the
 * camera's world XZ; in XR that is three's union camera, a few cm behind the eyes.
 */
async function groundGap(xr: Xr): Promise<number> {
  const diag = await xr.diag();
  const [x, , z] = diag.camera.position as [number, number, number];
  return Math.abs((diag.rig as RigDiag).position[1] - terrain.heightAt(x, z));
}

test('the left stick walks the rig downhill, y follows the terrain and the XR view moves with it', async ({
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await xr.enterXR();
  await xr.waitFrames(5);
  const before = await xr.diag();
  const start = before.rig as RigDiag;
  const startEye = before.camera.position;
  expect(start.mode).toBe('walk');
  for (const v of start.position) expect(v).toBeCloseTo(0, 3);

  // Yaw 0 faces -Z. The terrain falls away ahead of the painter's spot: -0.33 m at z = -3.
  await xr.stick('left', 0, -1);
  await expect.poll(async () => (await rig(xr)).position[2], { timeout: 60_000 }).toBeLessThan(-3);
  const moving = await rig(xr);
  expect(moving.speed).toBeCloseTo(2, 6);
  // 1.5 s at full stick: the vignette has settled at its full 0.6 strength.
  expect(moving.vignette).toBeCloseTo(0.6, 3);
  await xr.stick('left', 0, 0);
  await expect.poll(async () => (await rig(xr)).speed).toBe(0);
  await expect.poll(async () => (await rig(xr)).vignette, { timeout: 10_000 }).toBe(0);

  await expect.poll(() => groundGap(xr), { timeout: 10_000 }).toBeLessThan(0.005);
  const after = await xr.diag();
  const end = after.rig as RigDiag;
  console.log(`[e2e] locomotion XR rig ${JSON.stringify(end)}`);
  expect(end.grounded).toBe(true);
  expect(Math.abs(end.position[0])).toBeLessThan(0.01);
  expect(end.position[1]).toBeLessThan(-0.3);

  // The rendered eye moved by the rig's displacement: x and z with it, y down the slope.
  const eye = after.camera.position;
  expect(eye[0] - startEye[0]).toBeCloseTo(end.position[0] - start.position[0], 2);
  expect(eye[1] - startEye[1]).toBeCloseTo(end.position[1] - start.position[1], 2);
  expect(eye[2] - startEye[2]).toBeCloseTo(end.position[2] - start.position[2], 2);
});

test('the vignette shader is compiled at boot, so the first move in XR compiles nothing', async ({
  xr,
}) => {
  test.setTimeout(120_000);
  // The bare scene: its ground and grid are in view from the first frame, so nothing else can
  // come into view and compile while moving.
  await xr.boot('scene=bare&noanim');
  await xr.enterXR();
  await xr.waitFrames(5);
  const programs = (await xr.diag()).renderer.programs;
  await xr.stick('left', 0, -1);
  await expect.poll(async () => (await rig(xr)).vignette).toBeGreaterThan(0.1);
  await xr.waitFrames(3);
  expect((await xr.diag()).renderer.programs).toBe(programs);
  await xr.stick('left', 0, 0);
});

test('WASD walks the desktop rig at 2 m/s, 3 m/s with Shift, on the terrain', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await rig(xr)).position[2], { timeout: 30_000 }).toBeLessThan(-1);
  expect((await rig(xr)).speed).toBe(2);
  // XR only: the desktop never shows the vignette.
  expect((await rig(xr)).vignette).toBe(0);
  await page.keyboard.down('ShiftLeft');
  await expect.poll(async () => (await rig(xr)).speed).toBe(3);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  await expect.poll(async () => (await rig(xr)).speed).toBe(0);
  await expect.poll(() => groundGap(xr), { timeout: 10_000 }).toBeLessThan(0.005);
  const after = await xr.diag();
  const end = after.rig as RigDiag;
  console.log(`[e2e] locomotion desktop rig ${JSON.stringify(end)}`);
  const eye = after.camera.position;
  expect(eye[0]).toBeCloseTo(end.position[0], 6);
  expect(eye[1]).toBeCloseTo(end.position[1] + 1.6, 6);
  expect(eye[2]).toBeCloseTo(end.position[2], 6);
});

test('a right-stick push snaps the rig 30° right about the head, once per push', async ({ xr }) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await xr.enterXR();
  // A head walked away from the rig origin: a turn about the origin would swing it by ~0.33 m.
  await xr.setPose({ head: { position: [0.5, 1.6, -0.4], quaternion: [0, 0, 0, 1] } });
  await xr.waitFrames(3);
  const before = await xr.diag();
  expect((before.rig as RigDiag).turnMode).toBe('snap');
  expect((before.rig as RigDiag).yaw).toBe(0);

  await xr.stick('right', 1, 0);
  await expect.poll(async () => (await rig(xr)).yaw).toBeCloseTo(SNAP_30, 9);
  // Held past the threshold: no second snap.
  await xr.waitFrames(30);
  expect((await rig(xr)).yaw).toBeCloseTo(SNAP_30, 9);
  await xr.stick('right', 0, 0);
  const after = await xr.diag();
  console.log(`[e2e] snap XR rig ${JSON.stringify(after.rig)}`);
  const [bx, , bz] = before.camera.position as [number, number, number];
  const [ax, , az] = after.camera.position as [number, number, number];
  expect(Math.hypot(ax - bx, az - bz)).toBeLessThan(0.002);
});

test('?turn=smooth turns the rig continuously, under the vignette at its 0.6 strength', async ({
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, `${WORLD}&turn=smooth`);
  await xr.enterXR();
  await xr.waitFrames(3);
  expect((await rig(xr)).turnMode).toBe('smooth');
  await xr.stick('right', 1, 0);
  // 90°/s to the right: past a quarter turn within a few seconds, never in 30° steps.
  await expect
    .poll(async () => (await rig(xr)).yaw, { timeout: 20_000 })
    .toBeLessThan(-Math.PI / 2);
  expect((await rig(xr)).vignette).toBeCloseTo(0.6, 3);
  await xr.stick('right', 0, 0);
  const stopped = (await rig(xr)).yaw;
  await expect.poll(async () => (await rig(xr)).vignette, { timeout: 10_000 }).toBe(0);
  expect((await rig(xr)).yaw).toBe(stopped);
});

test('desktop E snaps the rig 30° right and Q snaps it back', async ({ page, xr }) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await page.keyboard.down('KeyE');
  await expect.poll(async () => (await rig(xr)).yaw).toBeCloseTo(SNAP_30, 9);
  await page.keyboard.up('KeyE');
  // Past the 250 ms cooldown even at 120 Hz: frame dts sum to at least 0.25 s.
  await xr.waitFrames(30);
  await page.keyboard.down('KeyQ');
  await expect.poll(async () => (await rig(xr)).yaw).toBeCloseTo(0, 9);
  await page.keyboard.up('KeyQ');
});

test('?seated raises a seated head to the 1.6 m standing height', async ({ xr }) => {
  test.setTimeout(180_000);
  await bootWorld(xr, `${WORLD}&seated`);
  await xr.setPose({ head: { position: [0, 1.1, 0], quaternion: [0, 0, 0, 1] } });
  await xr.enterXR();
  await expect.poll(async () => (await rig(xr)).position[1]).toBeCloseTo(0.5, 3);
  expect((await rig(xr)).seated).toBe(true);
  expect((await xr.diag()).camera.position[1]).toBeCloseTo(1.6, 1);
});

test('a right-stick push aims the arc from the right controller and its release teleports the head', async ({
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await xr.enterXR();
  // The head walked off the rig origin, and the controller pitched 20° down: the arc lands about
  // 3 m ahead, on the painter's slope.
  await xr.setPose({
    head: { position: [0.3, 1.6, 0.2], quaternion: [0, 0, 0, 1] },
    right: { position: [0.25, 1.4, -0.3], quaternion: pitch(-20) },
  });
  await xr.waitFrames(3);
  const before = await xr.diag();
  expect((before.rig as RigDiag).lastTeleport).toBeNull();

  await xr.stick('right', 0, -1);
  await expect.poll(async () => (await rig(xr)).aim.active).toBe(true);
  const aiming = await rig(xr);
  expect(aiming.aim).toMatchObject({ valid: true, reason: 'ok' });
  const hit = aiming.aim.hit as Vec3;
  // The ray is the controller's, pitched: from its x, not the head's, and short of the ~8 m a
  // level ray from 1.4 m would reach.
  expect(hit[0]).toBeCloseTo(0.25, 3);
  expect(hit[2]).toBeLessThan(-2);
  expect(hit[2]).toBeGreaterThan(-5);

  await xr.stick('right', 0, 0);
  await expect.poll(async () => (await rig(xr)).lastTeleport, { timeout: 10_000 }).not.toBeNull();
  const after = await xr.diag();
  const end = after.rig as RigDiag;
  const jump = end.lastTeleport as NonNullable<RigDiag['lastTeleport']>;
  console.log(`[e2e] teleport XR rig ${JSON.stringify(end)}`);
  expect(end.aim.active).toBe(false);
  expect(jump.to[0]).toBeCloseTo(hit[0], 6);
  expect(jump.to[2]).toBeCloseTo(hit[2], 6);
  // `from` is the head before the jump: three's XR camera, a few cm behind the eyes.
  expect(jump.from[0]).toBeCloseTo((before.camera.position as Vec3)[0], 3);
  expect(jump.from[2]).toBeCloseTo((before.camera.position as Vec3)[2], 3);
  expectValidLanding(jump.from, jump.to);
  // The head, not the rig origin, is on the hit, and the rig stands on the ground at once.
  const [ex, , ez] = after.camera.position as Vec3;
  expect(Math.hypot(ex - jump.to[0], ez - jump.to[2])).toBeLessThan(0.01);
  expect(end.position[1]).toBeCloseTo(jump.to[1], 6);
  expect(end.grounded).toBe(true);
  expect(end.yaw).toBe(0);
});

test('desktop T aims from the eye and its release jumps the eye onto the hit at once', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await xr.waitFrames(5);
  const idle = await xr.diag();
  const idleCalls = (idle.draw as { calls: number }).calls;
  await page.keyboard.down('KeyT');
  await expect.poll(async () => (await rig(xr)).aim.active).toBe(true);
  const aiming = await rig(xr);
  expect(aiming.aim).toMatchObject({ valid: true, reason: 'ok' });
  const hit = aiming.aim.hit as Vec3;
  // The arc is one more draw, on the world's own stroke program: nothing compiles on the aim.
  await xr.waitFrames(2);
  const drawn = await xr.diag();
  expect((drawn.draw as { calls: number }).calls).toBe(idleCalls + 1);
  expect(drawn.renderer.programs).toBe(idle.renderer.programs);
  // E snaps nothing while aiming.
  await page.keyboard.down('KeyE');
  await xr.waitFrames(5);
  expect((await rig(xr)).yaw).toBe(0);
  await page.keyboard.up('KeyE');

  await page.keyboard.up('KeyT');
  await expect.poll(async () => (await rig(xr)).lastTeleport).not.toBeNull();
  const after = await xr.diag();
  const end = after.rig as RigDiag;
  const jump = end.lastTeleport as NonNullable<RigDiag['lastTeleport']>;
  console.log(`[e2e] teleport desktop rig ${JSON.stringify(end)}`);
  expect(jump.to[0]).toBeCloseTo(hit[0], 6);
  expect(jump.to[2]).toBeCloseTo(hit[2], 6);
  expectValidLanding(jump.from, jump.to);
  const eye = after.camera.position as Vec3;
  expect(eye[0]).toBeCloseTo(jump.to[0], 6);
  expect(eye[1]).toBeCloseTo(jump.to[1] + 1.6, 6);
  expect(eye[2]).toBeCloseTo(jump.to[2], 6);
});

test('the bare scene builds the arc and its brush atlas on the first aim, not at boot', async ({
  page,
  xr,
}) => {
  test.setTimeout(120_000);
  await xr.boot('scene=bare&noanim');
  await xr.waitFrames(5);
  const boot = await xr.diag();
  await page.keyboard.down('KeyT');
  await expect.poll(async () => (await rig(xr)).aim.active).toBe(true);
  await xr.waitFrames(2);
  const aimed = await xr.diag();
  await page.keyboard.up('KeyT');
  // The atlas texture and the stroke program first exist once the arc does; it is then one draw.
  expect(aimed.renderer.textures).toBe(boot.renderer.textures + 1);
  expect(aimed.renderer.programs).toBe(boot.renderer.programs + 1);
  expect((aimed.draw as { calls: number }).calls).toBe((boot.draw as { calls: number }).calls + 1);
});

test('desktop F flies near the edge under thicker haze, Space climbs, and F drops back onto the terrain', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  // Eye 49 m out toward -Z, well above the terrain: the radial boundary factor is about 0.9 there.
  await page.evaluate(() => window.__goghPose?.(0, 20, -49, 0, 0));
  await xr.waitFrames(2);
  expect((await rig(xr)).mode).toBe('walk');
  await page.keyboard.down('KeyF');
  await expect.poll(async () => (await rig(xr)).mode).toBe('fly');
  await page.keyboard.up('KeyF');
  // The push drifts the flight inward and the haze thickens.
  await expect.poll(async () => (await rig(xr)).haze, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect
    .poll(async () => (await rig(xr)).position[2], { timeout: 10_000 })
    .toBeGreaterThan(-48.9);
  const before = await rig(xr);
  expect(before.grounded).toBe(false);
  // T aims nothing in flight.
  await page.keyboard.down('KeyT');
  await xr.waitFrames(3);
  expect((await rig(xr)).aim.active).toBe(false);
  await page.keyboard.up('KeyT');
  await xr.waitFrames(2);
  expect((await rig(xr)).lastTeleport).toBeNull();

  await page.keyboard.down('Space');
  await expect
    .poll(async () => (await rig(xr)).altitude, { timeout: 10_000 })
    .toBeGreaterThan(before.altitude + 1);
  await page.keyboard.up('Space');
  const high = await rig(xr);
  console.log(`[e2e] flight desktop rig ${JSON.stringify(high)}`);
  expect(high.altitude).toBeLessThanOrEqual(40 + 1e-6);
  expect(Math.hypot(high.position[0], high.position[2])).toBeLessThanOrEqual(55);

  await page.keyboard.down('KeyF');
  await expect.poll(async () => (await rig(xr)).mode).toBe('walk');
  await page.keyboard.up('KeyF');
  await expect.poll(async () => (await rig(xr)).grounded, { timeout: 5_000 }).toBe(true);
  expect(await groundGap(xr)).toBeLessThan(0.005);
  await expect.poll(async () => (await rig(xr)).haze, { timeout: 5_000 }).toBe(0);
});

/** The head's yaw that faces from (ex, ez) toward (tx, tz): yaw 0 faces -Z, positive turns left. */
function yawToward(ex: number, ez: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - ex), -(tz - ez));
}

/** Puts the desktop eye (or the XR rig) 1.6 m over the terrain at (x, z), facing yaw. */
async function placeEye(
  page: Page,
  x: number,
  z: number,
  yaw: number,
  pitchRad = 0,
  ground: Pick<typeof terrain, 'heightAt'> = terrain,
): Promise<void> {
  const y = ground.heightAt(x, z) + 1.6;
  await page.evaluate(([px, py, pz, w, p]) => window.__goghPose?.(px, py, pz, w, p), [
    x,
    y,
    z,
    yaw,
    pitchRad,
  ] as const);
}

test('after a snap turn the left stick walks along the new heading, within the 2 m/s budget', async ({
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await xr.enterXR();
  await xr.waitFrames(3);
  await xr.stick('right', 1, 0);
  await expect.poll(async () => (await rig(xr)).yaw).toBeCloseTo(SNAP_30, 9);
  await xr.stick('right', 0, 0);
  const start = await rig(xr);
  const t0 = Date.now();
  await xr.stick('left', 0, -1);
  await expect
    .poll(
      async () => {
        const p = (await rig(xr)).position;
        return Math.hypot(p[0] - start.position[0], p[2] - start.position[2]);
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(1);
  await xr.stick('left', 0, 0);
  const elapsed = (Date.now() - t0) / 1000;
  await expect.poll(async () => (await rig(xr)).speed).toBe(0);
  const end = await rig(xr);
  const dx = end.position[0] - start.position[0];
  const dz = end.position[2] - start.position[2];
  // Yaw -30° turns right: forward is (sin 30°, -cos 30°) in (x, z).
  expect(Math.atan2(dx, -dz)).toBeCloseTo(Math.PI / 6, 2);
  // Frame dt is clamped to 0.1 s, so the walk can only fall short of 2 m/s, never exceed it.
  expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(2 * elapsed + 0.05);
});

/** A house to aim at, and the open ground to aim from. */
interface Approach {
  /** The eye's x and z. */
  readonly eye: [number, number];
  /** The house centre. */
  readonly target: [number, number];
  /** The house's index in the volumes: the cut must land inside it. */
  readonly volumeIndex: number;
}

/**
 * An eye in open ground with a clear run to a house: no volume within 3 m of the eye or of a point
 * 0.5 m ahead of it (the XR controller sits 0.3 m forward), and the line from the eye to the house
 * centre, at head height, first enters that house's own volume 3.5 m or more away. House 7 is tried
 * first, then the others. Houses are dense: the run is usually found from another azimuth.
 */
function houseApproach(): Approach {
  const order = [7, ...village.houses.map((_, i) => i).filter((i) => i !== 7)];
  const openAt = (x: number, z: number): boolean => {
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * 2 * Math.PI;
      for (const r of [0, 3]) {
        const px = x + r * Math.sin(a);
        const pz = z + r * Math.cos(a);
        if (blocked(px, pz)) return false;
        for (const h of [1.4, 1.6])
          if (volumes.at(px, terrain.heightAt(px, pz) + h, pz) >= 0) return false;
      }
    }
    return true;
  };
  for (const index of order) {
    const house = village.houses[index];
    if (!house) continue;
    const [cx, , cz] = house.center;
    for (let k = 0; k < 16; k += 1) {
      const a = (k / 16) * 2 * Math.PI;
      for (const d of [5, 6, 7, 8, 9, 10]) {
        const x = cx + d * Math.sin(a);
        const z = cz + d * Math.cos(a);
        const ahead: [number, number] = [x - Math.sin(a) * 0.5, z - Math.cos(a) * 0.5];
        if (!openAt(x, z) || !openAt(ahead[0], ahead[1])) continue;
        // March toward the centre at head height: the first volume must be this house, 3.5 m out.
        let first = -1;
        let at = 0;
        for (let m = 0; m <= d * 8 && first < 0; m += 1) {
          const t = m / 8;
          const px = x - Math.sin(a) * t;
          const pz = z - Math.cos(a) * t;
          first = volumes.at(px, terrain.heightAt(px, pz) + 1.4, pz);
          at = t;
        }
        if (first === index && at >= 3.5)
          return { eye: [x, z], target: [cx, cz], volumeIndex: index };
      }
    }
  }
  throw new Error('no open-ground approach to any house');
}

/**
 * Seed 8's world: its terrain climbs past the 45° landing limit, which the default seed's does not
 * (its steepest ground is about 41°). The slope-rejection test boots it with `&seed=8`.
 */
const STEEP_SEED = 8;
const steepTerrain = createTerrain(STEEP_SEED);
const steepBlocked = createFootprintTest(createVillage(STEEP_SEED, steepTerrain));

/**
 * A desktop eye pose, in the `STEEP_SEED` world, whose arc lands on ground steeper than the
 * landing limit, found by scanning the terrain:
 * steep points 12-35 m from the origin, eyes 3-9 m short of them toward the origin, and pitches
 * from +30° to -70°, each traced with the app's own `traceArc` against the world's terrain and
 * footprints. The landing must also sit 2 m clear of every footprint.
 */
function steepPose(): { eye: [number, number]; yaw: number; pitchRad: number; slope: number } {
  const world = { ground: steepTerrain, blocked: steepBlocked };
  const out = createArcResult();
  for (let x = -35; x <= 35; x += 1) {
    for (let z = -35; z <= 35; z += 1) {
      const r = Math.hypot(x, z);
      if (r < 12 || r > 35) continue;
      for (let dist = 3; dist <= 9; dist += 1) {
        const eye: [number, number] = [x - (x / r) * dist, z - (z / r) * dist];
        if (steepBlocked(eye[0], eye[1])) continue;
        const yaw = yawToward(eye[0], eye[1], x, z);
        const origin: Vec3 = [eye[0], steepTerrain.heightAt(eye[0], eye[1]) + 1.6, eye[1]];
        for (let deg = 30; deg >= -70; deg -= 0.5) {
          const p = (deg * Math.PI) / 180;
          traceArc(
            out,
            origin,
            [-Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p)],
            world,
          );
          if (out.reason !== 'slope' || !out.hit) continue;
          const [hx, , hz] = out.hit;
          const n = steepTerrain.normalAt(hx, hz);
          const slope = (Math.acos(n[1] / Math.hypot(...n)) * 180) / Math.PI;
          let clear = slope >= MAX_SLOPE_DEG + 1;
          for (let dx = -2; dx <= 2; dx += 1) {
            for (let dz = -2; dz <= 2; dz += 1) if (steepBlocked(hx + dx, hz + dz)) clear = false;
          }
          if (clear) return { eye, yaw, pitchRad: p, slope };
        }
      }
    }
  }
  throw new Error('no arc lands on a slope past the limit');
}

/**
 * Sweeps the pitch of an eye at `eye` facing `target` until the aim is rejected for `reason`.
 * The caller holds the aim (T) throughout. Returns the rig at that pitch.
 */
async function aimUntilRejected(
  page: Page,
  xr: Xr,
  eye: [number, number],
  target: [number, number],
  reason: string,
): Promise<RigDiag> {
  const yaw = yawToward(eye[0], eye[1], target[0], target[1]);
  for (let deg = -2; deg >= -70; deg -= 4) {
    await placeEye(page, eye[0], eye[1], yaw, (deg * Math.PI) / 180);
    await xr.waitFrames(3);
    const current = await rig(xr);
    if (current.aim.active && current.aim.reason === reason) return current;
  }
  throw new Error(`no pitch gave a ${reason} rejection`);
}

test('desktop T aimed at a house is cut at the building, and its release does not jump', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await page.keyboard.down('KeyT');
  const { eye, target, volumeIndex } = houseApproach();
  const aimed = await aimUntilRejected(page, xr, eye, target, 'building');
  expect(aimed.aim.valid).toBe(false);
  expect(aimed.aim.hit).not.toBeNull();
  const hit = aimed.aim.hit as Vec3;
  // The cut point is inside the house's volume, in the air above the ground, not a landing behind it.
  expect(blocked(hit[0], hit[2])).toBe(true);
  expect(volume(hit[0], hit[1], hit[2])).toBe(true);
  expect(hit[1]).toBeGreaterThan(terrain.heightAt(hit[0], hit[2]) + 0.05);
  // The cut is in the aimed house, across open ground, not against a wall beside the eye.
  expect(volumes.at(hit[0], hit[1], hit[2])).toBe(volumeIndex);
  expect(Math.hypot(hit[0] - eye[0], hit[2] - eye[1])).toBeGreaterThan(3);
  await page.keyboard.up('KeyT');
  await xr.waitFrames(5);
  const after = await rig(xr);
  expect(after.lastTeleport).toBeNull();
  expect(after.aim.active).toBe(false);
  expect(after.position[0]).toBeCloseTo(aimed.position[0], 6);
  expect(after.position[2]).toBeCloseTo(aimed.position[2], 6);
});

test('desktop T aimed past 45 m from the painter is rejected as a boundary, and its release does not jump', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await page.keyboard.down('KeyT');
  const aimed = await aimUntilRejected(page, xr, [0, -42], [0, -60], 'boundary');
  expect(aimed.aim.valid).toBe(false);
  await page.keyboard.up('KeyT');
  await xr.waitFrames(5);
  const after = await rig(xr);
  expect(after.lastTeleport).toBeNull();
  expect(after.position[2]).toBeCloseTo(aimed.position[2], 6);
});

test('WASD and XR stick movement stop at a real village house', async ({ page, xr }) => {
  test.setTimeout(180_000);
  const { eye, target } = houseApproach();
  const yaw = yawToward(eye[0], eye[1], target[0], target[1]);
  const approach = ([x, , z]: Vec3): number =>
    (eye[0] - x) * Math.sin(yaw) + (eye[1] - z) * Math.cos(yaw);
  const walkingAt = async (): Promise<number> => approach((await rig(xr)).position);

  await bootWorld(xr, WORLD);
  await placeEye(page, eye[0], eye[1], yaw);
  await page.keyboard.down('KeyW');
  await expect.poll(walkingAt, { timeout: 15_000 }).toBeGreaterThan(3);
  await expect
    .poll(
      async () => {
        const before = await walkingAt();
        await xr.waitFrames(8);
        return (await walkingAt()) - before;
      },
      { timeout: 20_000 },
    )
    .toBeLessThan(0.01);
  await page.keyboard.up('KeyW');
  const stop = await walkingAt();
  const [x, , z] = (await rig(xr)).position;
  expect(blocked(x, z)).toBe(false);
  expect(blocked(x - Math.sin(yaw) * 0.05, z - Math.cos(yaw) * 0.05)).toBe(true);

  await placeEye(page, eye[0], eye[1], yaw);
  await xr.enterXR();
  await xr.setPose({ head: { position: [0, 1.6, 0], quaternion: [0, 0, 0, 1] } });
  await xr.stick('left', 0, -1);
  await expect.poll(walkingAt, { timeout: 20_000 }).toBeGreaterThan(stop - 0.12);
  await xr.waitFrames(12);
  expect(await walkingAt()).toBeLessThan(stop + 0.12);
  await xr.stick('left', 0, 0);
});

test('a right-stick aim at a house in XR is rejected and the release leaves the rig put', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await xr.enterXR();
  // The rig stands in open ground facing a house. The controller pitches down until the arc meets
  // its walls.
  const { eye, target, volumeIndex } = houseApproach();
  await placeEye(page, eye[0], eye[1], yawToward(eye[0], eye[1], target[0], target[1]));
  await xr.waitFrames(3);
  await xr.setPose({ right: { position: [0, 1.4, -0.3], quaternion: pitch(14) } });
  await xr.stick('right', 0, -1);
  let found: RigDiag | null = null;
  for (let deg = 14; deg >= -40 && !found; deg -= 2) {
    await xr.setPose({ right: { position: [0, 1.4, -0.3], quaternion: pitch(deg) } });
    await xr.waitFrames(2);
    const current = await rig(xr);
    if (current.aim.active && current.aim.reason === 'building') found = current;
  }
  expect(found, 'an arc landing on the house').not.toBeNull();
  const held = found as RigDiag;
  expect(held.aim.valid).toBe(false);
  const cut = held.aim.hit as Vec3;
  expect(cut).not.toBeNull();
  expect(volumes.at(cut[0], cut[1], cut[2])).toBe(volumeIndex);
  expect(Math.hypot(cut[0] - eye[0], cut[2] - eye[1])).toBeGreaterThan(3);
  await xr.stick('right', 0, 0);
  await xr.waitFrames(5);
  const after = await rig(xr);
  expect(after.lastTeleport).toBeNull();
  expect(after.position[0]).toBeCloseTo(held.position[0], 6);
  expect(after.position[2]).toBeCloseTo(held.position[2], 6);
});

test("desktop T aimed up the painter's hill from its foot lands, even on ground past the old 35° limit", async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await page.keyboard.down('KeyT');
  const seen: string[] = [];
  let validSteep = 0;
  for (const azDeg of [0, 90, 180, 270]) {
    const a = (azDeg * Math.PI) / 180;
    const eye: [number, number] = [13 * Math.sin(a), -13 * Math.cos(a)];
    const yaw = yawToward(eye[0], eye[1], 0, 0);
    for (let deg = 0; deg <= 24; deg += 4) {
      await placeEye(page, eye[0], eye[1], yaw, (deg * Math.PI) / 180);
      await xr.waitFrames(3);
      const { aim } = await rig(xr);
      if (!aim.active || !aim.hit) continue;
      const n = terrain.normalAt(aim.hit[0], aim.hit[2]);
      const slope = (Math.acos(n[1] / Math.hypot(...n)) * 180) / Math.PI;
      seen.push(`az${azDeg} pitch${deg}: ${aim.reason} ${slope.toFixed(1)}deg`);
      if (slope >= 35) {
        expect(aim.reason, seen.join(' | ')).toBe('ok');
        validSteep += 1;
      }
    }
  }
  console.log(`[e2e] hill climb aims ${seen.join(' | ')}`);
  await page.keyboard.up('KeyT');
  expect(validSteep).toBeGreaterThan(0);
});

test('desktop T aimed at a slope past the 45° limit is rejected as a slope, and its release does not jump', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  const { eye, yaw, pitchRad, slope } = steepPose();
  expect(slope).toBeGreaterThan(MAX_SLOPE_DEG);
  await bootWorld(xr, `${WORLD}&seed=${STEEP_SEED}`);
  await page.keyboard.down('KeyT');
  await placeEye(page, eye[0], eye[1], yaw, pitchRad, steepTerrain);
  await expect.poll(async () => (await rig(xr)).aim.reason).toBe('slope');
  const aimed = await rig(xr);
  expect(aimed.aim.valid).toBe(false);
  expect(aimed.aim.hit).not.toBeNull();
  await page.keyboard.up('KeyT');
  await xr.waitFrames(5);
  const after = await rig(xr);
  expect(after.lastTeleport).toBeNull();
  expect(after.position[0]).toBeCloseTo(aimed.position[0], 6);
  expect(after.position[2]).toBeCloseTo(aimed.position[2], 6);
});

test('desktop ?turn=smooth: E held turns the rig continuously, not in 30° steps', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, `${WORLD}&turn=smooth`);
  let prev = (await rig(xr)).yaw;
  let total = 0;
  await page.keyboard.down('KeyE');
  // Unwrapped yaw travelled. One held key press snaps once (-0.52 rad), so passing -1 rad can only
  // come from continuous turning.
  await expect
    .poll(
      async () => {
        const yaw = (await rig(xr)).yaw;
        const delta = yaw - prev;
        total += delta - 2 * Math.PI * Math.round(delta / (2 * Math.PI));
        prev = yaw;
        return total;
      },
      { timeout: 20_000 },
    )
    .toBeLessThan(-1);
  expect((await rig(xr)).turnMode).toBe('smooth');
  await page.keyboard.up('KeyE');
});

/** Places the eye at (x, y, z) facing -Z, whatever the mode. */
async function placeAt(page: Page, x: number, y: number, z: number): Promise<void> {
  await page.evaluate(([px, py, pz]) => window.__goghPose?.(px, py, pz, 0, 0), [x, y, z] as const);
}

const CAP = 40 + 1e-6;

/** Polls until the radius moves less than 2 cm between samples 10 frames apart, and returns it. */
async function settledRadius(xr: Xr): Promise<number> {
  let last = Number.POSITIVE_INFINITY;
  let settled = Number.NaN;
  await expect
    .poll(
      async () => {
        const now = radiusOf(await rig(xr));
        const done = Math.abs(now - last) < 0.02;
        last = now;
        await xr.waitFrames(10);
        if (done) settled = now;
        return done;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return settled;
}
const radiusOf = (r: RigDiag): number => Math.hypot(r.position[0], r.position[2]);

test('desktop flight clamps a head placed 45 m up to the 40 m cap, and the soft band approaches it from below', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await placeAt(page, 0, terrain.heightAt(0, 0) + 45, 0);
  await xr.waitFrames(2);
  await page.keyboard.down('KeyF');
  await expect.poll(async () => (await rig(xr)).mode).toBe('fly');
  await page.keyboard.up('KeyF');
  await xr.waitFrames(2);
  const clamped = await rig(xr);
  expect(clamped.altitude).toBeLessThanOrEqual(CAP);
  expect(clamped.altitude).toBeGreaterThan(39.9);
  await page.keyboard.down('Space');
  await xr.waitFrames(20);
  await page.keyboard.up('Space');
  expect((await rig(xr)).altitude).toBeLessThanOrEqual(CAP);

  // Climbing from 38.5 m: the soft band slows it, so it nears the cap without reaching it.
  await placeAt(page, 0, terrain.heightAt(0, 0) + 38.5, 0);
  await xr.waitFrames(2);
  await page.keyboard.down('KeyF');
  await expect.poll(async () => (await rig(xr)).mode).toBe('fly');
  await page.keyboard.up('KeyF');
  await page.keyboard.down('Space');
  let max = 0;
  await expect
    .poll(
      async () => {
        max = Math.max(max, (await rig(xr)).altitude);
        return max;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(38.8);
  await page.keyboard.up('Space');
  expect(max).toBeLessThan(40);
  expect(max).toBeGreaterThan(38.5);
});

test('flight in XR: right B toggles it, the right stick climbs, a head placed 45 m up is clamped to 40 m', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await xr.enterXR();
  await xr.waitFrames(3);
  await xr.press('right', 'b-button');
  await expect.poll(async () => (await rig(xr)).mode).toBe('fly');
  // Right stick forward is vertical up.
  await xr.stick('right', 0, -1);
  await expect.poll(async () => (await rig(xr)).altitude, { timeout: 30_000 }).toBeGreaterThan(2.5);
  await xr.stick('right', 0, 0);

  // A placed pose returns the rig to walk. Flying from 45 m up clamps to the cap at once.
  await placeAt(page, 0, terrain.heightAt(0, 0) + 45, 0);
  await xr.waitFrames(2);
  await xr.press('right', 'b-button');
  await expect.poll(async () => (await rig(xr)).mode).toBe('fly');
  await xr.waitFrames(2);
  const clamped = await rig(xr);
  expect(clamped.altitude).toBeLessThanOrEqual(CAP);
  expect(clamped.altitude).toBeGreaterThan(39.9);
  await xr.stick('right', 0, -1);
  await xr.waitFrames(10);
  await xr.stick('right', 0, 0);
  expect((await rig(xr)).altitude).toBeLessThanOrEqual(CAP);
});

test('desktop flight places a head at 70 m inside the 55 m radius at once', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await placeAt(page, 0, 20, -70);
  await xr.waitFrames(2);
  await page.keyboard.down('KeyF');
  await expect.poll(async () => (await rig(xr)).mode).toBe('fly');
  await page.keyboard.up('KeyF');
  await xr.waitFrames(2);
  const clamped = radiusOf(await rig(xr));
  // Unclamped, the 3 m/s push needs about 5 s to bring 70 m under 55.
  expect(clamped).toBeLessThanOrEqual(55 + 1e-6);
  expect(clamped).toBeGreaterThan(53);
});

test('desktop flight: W held outward rests at the push equilibrium, and the radius falls once released', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await placeAt(page, 0, 20, -54);
  await xr.waitFrames(2);
  await page.keyboard.down('KeyF');
  await expect.poll(async () => (await rig(xr)).mode).toBe('fly');
  await page.keyboard.up('KeyF');
  // W faces -Z, outward here. Full stick stalls short of 50 m: the push wins from 45 m out.
  await page.keyboard.down('KeyW');
  await expect.poll(async () => radiusOf(await rig(xr)), { timeout: 30_000 }).toBeLessThan(50.5);
  const rest = await settledRadius(xr);
  console.log(`[e2e] boundary rest radius ${rest}`);
  expect(rest).toBeGreaterThanOrEqual(48.5);
  expect(rest).toBeLessThanOrEqual(50);
  await page.keyboard.up('KeyW');
  await expect
    .poll(async () => radiusOf(await rig(xr)), { timeout: 15_000 })
    .toBeLessThan(rest - 0.5);
});

test('flight in XR: the left stick outward rests at the push equilibrium, and the radius falls once released', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await xr.enterXR();
  await placeAt(page, 0, 20, -54);
  await xr.waitFrames(2);
  await xr.press('right', 'b-button');
  await expect.poll(async () => (await rig(xr)).mode).toBe('fly');
  await xr.stick('left', 0, -1);
  await expect.poll(async () => radiusOf(await rig(xr)), { timeout: 30_000 }).toBeLessThan(50.5);
  const rest = await settledRadius(xr);
  console.log(`[e2e] XR boundary rest radius ${rest}`);
  expect(rest).toBeGreaterThanOrEqual(48.5);
  expect(rest).toBeLessThanOrEqual(50);
  await xr.stick('left', 0, 0);
  await expect
    .poll(async () => radiusOf(await rig(xr)), { timeout: 15_000 })
    .toBeLessThan(rest - 0.5);
});

test('without ?seated a 1.1 m head leaves the rig on the ground', async ({ xr }) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await xr.setPose({ head: { position: [0, 1.1, 0], quaternion: [0, 0, 0, 1] } });
  await xr.enterXR();
  await xr.waitFrames(10);
  const r = await rig(xr);
  expect(r.seated).toBe(false);
  expect(r.position[1]).toBeCloseTo(terrain.heightAt(0, 0), 2);
});

test('?seated with a 1.3 m head raises the rig 0.3 m', async ({ xr }) => {
  test.setTimeout(180_000);
  await bootWorld(xr, `${WORLD}&seated`);
  await xr.setPose({ head: { position: [0, 1.3, 0], quaternion: [0, 0, 0, 1] } });
  await xr.enterXR();
  await expect
    .poll(async () => (await rig(xr)).position[1])
    .toBeCloseTo(terrain.heightAt(0, 0) + 0.3, 3);
  expect((await rig(xr)).seated).toBe(true);
});

test('flight in XR: the right stick climbing from 38.5 m nears the cap and stays under 40 m', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await xr.enterXR();
  await placeAt(page, 0, terrain.heightAt(0, 0) + 38.5, 0);
  await xr.waitFrames(2);
  await xr.press('right', 'b-button');
  await expect.poll(async () => (await rig(xr)).mode).toBe('fly');
  await xr.stick('right', 0, -1);
  let max = 0;
  await expect
    .poll(
      async () => {
        max = Math.max(max, (await rig(xr)).altitude);
        return max;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(38.8);
  await xr.stick('right', 0, 0);
  expect(max).toBeLessThan(40);
  expect(max).toBeGreaterThan(38.5);
});

interface RigSample {
  /** The frame time the app's own loop received: the XR frame's clock in XR, rAF's on the desktop. */
  t: number;
  /** `performance.now()` when the callback returned, ms. */
  wall: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Records the rig position after every app frame. It wraps the frame callbacks of whichever loop
 * the app drives (the XR session's in XR, the window's on the desktop), so each sample carries the
 * exact `time` argument `renderFrame` computed its dt from.
 *
 * The time must come from that argument. IWER stamps XR frames with its own clock, so a window
 * rAF timer or `Date.now()` measures a different interval than the one the rig integrated.
 */
async function startRigRecorder(page: Page, xrLoop: boolean): Promise<void> {
  await page.evaluate((useXr) => {
    const w = window as unknown as {
      __goghDiag: () => { rig: { position: number[] } };
      __rigRec?: { samples: unknown[]; restore: () => void };
    };
    const target = (useXr ? XRSession.prototype : window) as unknown as {
      requestAnimationFrame: (cb: (t: number, f?: unknown) => void) => number;
    };
    const original = target.requestAnimationFrame;
    const samples: RigSample[] = [];
    target.requestAnimationFrame = function (this: unknown, cb) {
      return original.call(this, (t: number, f?: unknown) => {
        cb(t, f);
        const p = w.__goghDiag().rig.position;
        samples.push({ t, wall: performance.now(), x: p[0] ?? 0, y: p[1] ?? 0, z: p[2] ?? 0 });
      });
    };
    w.__rigRec = {
      samples,
      restore: () => {
        target.requestAnimationFrame = original;
      },
    };
  }, xrLoop);
}

async function stopRigRecorder(page: Page): Promise<RigSample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __rigRec?: { samples: unknown[]; restore: () => void } };
    if (!w.__rigRec) throw new Error('the rig recorder is not running');
    w.__rigRec.restore();
    const samples = w.__rigRec.samples as RigSample[];
    w.__rigRec = undefined;
    return samples;
  });
}

/** Horizontal speed over [from, to] seconds of frame time, from the rig's XZ alone. */
function horizontalSpeed(samples: RigSample[], from: number, to: number): number {
  const t0 = samples[0]?.t ?? 0;
  const win = samples.filter((s) => s.t - t0 >= from * 1000 && s.t - t0 <= to * 1000);
  const a = win[0];
  const b = win[win.length - 1];
  if (!a || !b || b.t <= a.t) throw new Error(`no samples in ${from}-${to} s`);
  return Math.hypot(b.x - a.x, b.z - a.z) / ((b.t - a.t) / 1000);
}

function reportWalk(label: string, samples: RigSample[], load: [number, number]): number {
  const first = samples.find((s) => Math.hypot(s.x, s.z) > 1e-6);
  const origin = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !origin || !last) throw new Error('the rig never moved');
  const t0 = origin.t;
  const steady = horizontalSpeed(samples, (first.t - t0) / 1000 + 0.3, (last.t - t0) / 1000);
  const wallSpeed =
    Math.hypot(last.x - first.x, last.z - first.z) / ((last.wall - first.wall) / 1000);
  const total = Math.hypot(last.x - origin.x, last.y - origin.y, last.z - origin.z);
  console.log(
    `[e2e] ${label}: ${samples.length} frames, first move ${((first.t - t0) / 1000).toFixed(3)} s in, steady ${steady.toFixed(3)} m/s (frame time), ${wallSpeed.toFixed(3)} m/s (wall), 3D total ${total.toFixed(2)} m, load ${load[0].toFixed(1)} -> ${load[1].toFixed(1)}`,
  );
  return steady;
}

test('full left stick walks the rig at moveSpeed horizontally, in XR frame time', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await xr.enterXR();
  await xr.waitFrames(5);
  await startRigRecorder(page, true);
  await xr.waitFrames(5);
  const before = os.loadavg()[0] ?? 0;
  await xr.stick('left', 0, -1);
  await page.waitForTimeout(1500);
  const after = os.loadavg()[0] ?? 0;
  const samples = await stopRigRecorder(page);
  await xr.stick('left', 0, 0);
  const steady = reportWalk('xr walk', samples, [before, after]);
  expect(steady).toBeGreaterThan(2 * 0.95);
  expect(steady).toBeLessThan(2 * 1.05);
});

test('W walks the desktop rig at moveSpeed horizontally, in rAF frame time', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await xr.waitFrames(5);
  await startRigRecorder(page, false);
  await xr.waitFrames(5);
  const before = os.loadavg()[0] ?? 0;
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  const after = os.loadavg()[0] ?? 0;
  await page.keyboard.up('KeyW');
  const samples = await stopRigRecorder(page);
  const steady = reportWalk('desktop walk', samples, [before, after]);
  expect(steady).toBeGreaterThan(2 * 0.95);
  expect(steady).toBeLessThan(2 * 1.05);
});
