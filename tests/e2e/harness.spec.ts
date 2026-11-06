import { expect, test } from './fixtures';
import { gpuMode, isSoftwareRenderer } from './gpu';

test('IWER Quest 3 enters immersive VR and reports a right-trigger press', async ({ xr }) => {
  await xr.boot();

  const before = await xr.diag();
  const renderer = before.renderer.unmaskedRenderer ?? '';
  test.info().annotations.push({ type: 'UNMASKED_RENDERER_WEBGL', description: renderer });
  console.log(`[e2e] app UNMASKED_RENDERER_WEBGL: ${renderer}`);
  if (gpuMode === 'metal') {
    expect(renderer, 'renderer must name the GPU').not.toBe('');
    expect(isSoftwareRenderer(renderer), `software renderer: ${renderer}`).toBe(false);
    expect(renderer).toMatch(/Apple|NVIDIA|AMD|Intel|Metal/);
  }

  expect(before.xr.supported).toBe(true);
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
  await xr.boot();
  await xr.enterXR();
  const start = (await xr.diag()).camera.position;
  // IWER's default head sits at (0, 1.6, 0); move it by (+0.4, -0.4, -0.3).
  await xr.setPose({ head: { position: [0.4, 1.2, -0.3], quaternion: [0, 0, 0, 1] } });
  const end = (await xr.diag()).camera.position;
  expect(end[0] - start[0]).toBeCloseTo(0.4, 2);
  expect(end[1] - start[1]).toBeCloseTo(-0.4, 2);
  expect(end[2] - start[2]).toBeCloseTo(-0.3, 2);
});
