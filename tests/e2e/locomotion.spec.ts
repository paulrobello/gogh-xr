/**
 * Locomotion smoke checks (P3.2 to P3.5): the left stick and WASD move the rig through the Starry
 * Night world, its y follows the terrain, and the rendered eye moves with it; the right stick and
 * T aim and commit a teleport; F flies and Space climbs. The full locomotion suite is P3.6.
 *
 * `__goghDiag().camera` is the camera that rendered the last frame in world space: three's XR
 * camera while presenting, whose matrices include the rig.
 */
import { MAX_RANGE, MAX_SLOPE_DEG } from '../../src/locomotion/teleport.ts';
import { PAINTER_SPOT } from '../../src/paintings/starry-night/canvas-camera.ts';
import { createFootprintTest } from '../../src/paintings/starry-night/footprints.ts';
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
const blocked = createFootprintTest(createVillage(1, terrain));
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
  await xr.boot('noanim');
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
  await xr.boot('noanim');
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
