import { expect, test } from './fixtures';
import { gpuMode, isSoftwareRenderer } from './gpu';

test('IWER Quest 3 enters immersive VR and reports a right-trigger press', async ({ xr }) => {
  await xr.boot('scene=bare');

  const before = await xr.diag();
  const renderer = before.renderer.unmaskedRenderer ?? '';
  test.info().annotations.push({ type: 'UNMASKED_RENDERER_WEBGL', description: renderer });
  console.log(`[e2e] app UNMASKED_RENDERER_WEBGL: ${renderer}`);
  if (gpuMode === 'metal') {
    expect(renderer, 'renderer must name the GPU').not.toBe('');
    expect(isSoftwareRenderer(renderer), `software renderer: ${renderer}`).toBe(false);
    expect(renderer).toMatch(/Apple|NVIDIA|AMD|Intel|Metal/);
  }

  await expect.poll(async () => (await xr.diag()).xr.supported).toBe(true);
  await xr.enterXR();
  const presenting = await xr.diag();
  expect(presenting.xr.presenting).toBe(true);
  expect(presenting.xr.sessionMode).toBe('immersive-vr');
  expect(presenting.input?.selectstart.right).toBe(0);

  await xr.press('right', 'trigger');
  await expect.poll(async () => (await xr.diag()).input?.selectstart.right).toBe(1);
  expect((await xr.diag()).input?.selectstart.left).toBe(0);
});

test('setPose moves the XR camera by the head offset', async ({ xr }) => {
  await xr.boot('scene=bare');
  await xr.enterXR();
  const start = (await xr.diag()).camera.position;
  // IWER's default head sits at (0, 1.6, 0); move it by (+0.4, -0.4, -0.3).
  await xr.setPose({ head: { position: [0.4, 1.2, -0.3], quaternion: [0, 0, 0, 1] } });
  const end = (await xr.diag()).camera.position;
  expect(end[0] - start[0]).toBeCloseTo(0.4, 2);
  expect(end[1] - start[1]).toBeCloseTo(-0.4, 2);
  expect(end[2] - start[2]).toBeCloseTo(-0.3, 2);
});

test('the input layer reports the controller and the keyboard in diag', async ({ xr, page }) => {
  await xr.boot('scene=bare');
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await xr.diag()).input?.actions?.move.y).toBe(1);
  await page.keyboard.up('KeyW');
  await expect.poll(async () => (await xr.diag()).input?.actions?.move.y).toBe(0);

  await xr.enterXR();
  // xr-standard: forward on the stick is negative Y, reported as move.y = +1.
  await xr.stick('left', 0, -1);
  await expect.poll(async () => (await xr.diag()).input?.actions?.move.y).toBeCloseTo(1, 6);
  await xr.stick('left', 0, 0);
  await xr.stick('right', 0, -1);
  await expect.poll(async () => (await xr.diag()).input?.actions?.vertical).toBeCloseTo(1, 6);
  await xr.stick('right', 0, 0);
  await expect.poll(async () => (await xr.diag()).input?.actions?.vertical).toBe(0);
});

test('IWER trigger and squeeze reach select and grip at their xr-standard indices', async ({
  xr,
  page,
}) => {
  const hold = (button: string, value: number) =>
    page.evaluate(([b, v]) => window.__goghIwer?.controllers.right?.updateButtonValue(b, v), [
      button,
      value,
    ] as const);
  await xr.boot('scene=bare');
  await xr.enterXR();
  const actions = async () => (await xr.diag()).input?.actions;

  await hold('trigger', 1);
  await expect.poll(async () => (await actions())?.select.down).toBe(true);
  expect((await actions())?.grip.down).toBe(false);
  await hold('trigger', 0);
  await expect.poll(async () => (await actions())?.select.down).toBe(false);

  await hold('squeeze', 1);
  await expect.poll(async () => (await actions())?.grip.down).toBe(true);
  expect((await actions())?.select.down).toBe(false);
  await hold('squeeze', 0);
  await expect.poll(async () => (await actions())?.grip.down).toBe(false);
});
