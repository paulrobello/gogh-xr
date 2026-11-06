/**
 * Locomotion smoke checks (P3.2): the left stick and WASD move the rig through the Starry Night
 * world, its y follows the terrain, and the rendered eye moves with it. The full locomotion suite
 * is P3.6.
 *
 * `__goghDiag().camera` is the camera that rendered the last frame in world space: three's XR
 * camera while presenting, whose matrices include the rig.
 */
import { createTerrain } from '../../src/world/terrain.ts';
import { expect, test, type Xr } from './fixtures';

interface RigDiag {
  position: [number, number, number];
  yaw: number;
  mode: string;
  seated: boolean;
  grounded: boolean;
  speed: number;
  turnMode: string;
  vignette: number;
}

const SNAP_30 = -Math.PI / 6;

/** The world's terrain: seed 1, as the boot below uses no `?seed`. */
const terrain = createTerrain(1);
const WORLD = 'painting=starry-night&noanim&nogov';

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
