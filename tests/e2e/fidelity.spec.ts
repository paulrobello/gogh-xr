/**
 * The painter's-spot fidelity metric (P2.8, P2-A2): the painter-camera view of the Starry Night
 * world against the scan, with the shared metric of scripts/fidelity-lib.ts. The thresholds are the
 * first accepted render's values with a fixed margin (docs/verification.md P2-A2).
 *
 * `?painter` puts the desktop camera on the world's painter camera, so the frame is exactly canvas
 * uv [0, 1]². The viewport is the canvas aspect, the size the thresholds were measured at.
 *
 * The thresholds assume the default GPU backend, ANGLE Metal, on which they were measured.
 * SwiftShader (`PW_GPU=swiftshader`) rasterizes and resolves MSAA differently, so a failure there
 * is not by itself a world regression. Recheck on Metal before reading it as one.
 */
import { CAPTURE_SIZE, loadCapture, loadScanReference } from '../../scripts/fidelity-io.ts';
import {
  compareFidelity,
  DELTA_E_THRESHOLD,
  SSIM_THRESHOLD,
  worstBlocks,
} from '../../scripts/fidelity-lib.ts';
import { CANVAS_PITCH } from '../../src/paintings/starry-night/canvas-camera.ts';
import { expect, glErrors, test } from './fixtures';

test.use({ viewport: { width: CAPTURE_SIZE.width, height: CAPTURE_SIZE.height } });

test('the painter-spot view matches the scan within the P2-A2 thresholds', async ({ page, xr }) => {
  test.setTimeout(150_000);
  await xr.boot('painting=starry-night&noanim&seed=1&shot&painter');
  await expect
    .poll(async () => (await xr.diag()).world !== undefined, { timeout: 90_000 })
    .toBe(true);
  // Let the batch cull and band after the build, as scripts/capture-shot.ts does.
  await xr.waitFrames(5);

  // The hook took: the eye at the painter's eye, pitched up by CANVAS_PITCH with no yaw or roll.
  const { camera } = await xr.diag();
  expect(camera.position).toEqual([0, 1.6, 0]);
  const expected = [Math.sin(CANVAS_PITCH / 2), 0, 0, Math.cos(CANVAS_PITCH / 2)];
  camera.quaternion.forEach((q, i) => {
    expect(q).toBeCloseTo(expected[i], 9);
  });

  const dataUrl = await page.evaluate(() => {
    if (!window.__goghShot) throw new Error('__goghShot is not installed; boot with ?diag&shot');
    return window.__goghShot();
  });
  const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const result = compareFidelity(await loadScanReference(), await loadCapture(png));
  const worst = worstBlocks(result.blocks, 5)
    .map((b) => `(${b.col},${b.row}) ${b.deltaE.toFixed(2)}`)
    .join(' ');
  console.log(
    `[e2e] fidelity SSIM ${result.ssim.toFixed(4)} (≥ ${SSIM_THRESHOLD}), mean ΔE2000 ${result.meanDeltaE.toFixed(4)} (≤ ${DELTA_E_THRESHOLD}), worst ${worst}`,
  );
  expect(result.ssim).toBeGreaterThanOrEqual(SSIM_THRESHOLD);
  expect(result.meanDeltaE).toBeLessThanOrEqual(DELTA_E_THRESHOLD);
  expect(await glErrors(page)).toEqual([]);
});
