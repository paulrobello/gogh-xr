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
}

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
  expect((await rig(xr)).speed).toBeCloseTo(2, 6);
  await xr.stick('left', 0, 0);
  await expect.poll(async () => (await rig(xr)).speed).toBe(0);

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

test('WASD walks the desktop rig at 2 m/s, 3 m/s with Shift, on the terrain', async ({
  page,
  xr,
}) => {
  test.setTimeout(180_000);
  await bootWorld(xr, WORLD);
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await rig(xr)).position[2], { timeout: 30_000 }).toBeLessThan(-1);
  expect((await rig(xr)).speed).toBe(2);
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

test('?seated raises a seated head to the 1.6 m standing height', async ({ xr }) => {
  test.setTimeout(180_000);
  await bootWorld(xr, `${WORLD}&seated`);
  await xr.setPose({ head: { position: [0, 1.1, 0], quaternion: [0, 0, 0, 1] } });
  await xr.enterXR();
  await expect.poll(async () => (await rig(xr)).position[1]).toBeCloseTo(0.5, 3);
  expect((await rig(xr)).seated).toBe(true);
  expect((await xr.diag()).camera.position[1]).toBeCloseTo(1.6, 1);
});
