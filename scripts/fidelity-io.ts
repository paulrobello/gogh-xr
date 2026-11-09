/**
 * Image preparation for the fidelity metric (P2.8), shared by `scripts/fidelity.ts` and
 * `tests/e2e/fidelity.spec.ts`: both images go to FIDELITY_WIDTH × FIDELITY_HEIGHT with sharp's
 * Lanczos (lanczos3) in sRGB, stretched to fill, as raw 8-bit RGB.
 */
import { fileURLToPath } from 'node:url';
import sharp, { type Sharp } from 'sharp';
import { CANVAS_ASPECT } from '../src/paintings/starry-night/canvas-camera.ts';
import { FIDELITY_HEIGHT, FIDELITY_WIDTH, type RgbImage } from './fidelity-lib.ts';

/** The 3840 px Starry Night scan, the bake input. */
export const SCAN_PATH: string = fileURLToPath(
  new URL('../assets/scans/starry-night.jpg', import.meta.url),
);

/**
 * COLOR_INSET of src/demo/canvas/placement.ts, the fractions the world's colour sampling insets
 * frame.webp past its mat. Restated because placement.ts pulls in GLSL `?raw` imports that only
 * Vite resolves; tests/fidelity-io.test.ts keeps the two equal.
 */
export const SCAN_INSET: readonly [number, number] = Object.freeze([
  12 / 1024,
  4 / 811,
]) as readonly [number, number];

/**
 * The viewport the painter camera is captured at: 1280 px wide at CANVAS_ASPECT, height rounded
 * (1280 × 1028), so the capture and the inset scan share one aspect.
 */
export const CAPTURE_SIZE: Readonly<{ width: number; height: number }> = Object.freeze({
  width: 1280,
  height: Math.round(1280 / CANVAS_ASPECT),
});

async function toRgb(image: Sharp): Promise<RgbImage> {
  const { data, info } = await image
    .resize(FIDELITY_WIDTH, FIDELITY_HEIGHT, { fit: 'fill', kernel: 'lanczos3' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected RGB, got ${info.channels} channels`);
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/** The scan inset past its mat by SCAN_INSET, so canvas uv [0, 1]² maps onto it. */
export async function loadScanReference(path: string = SCAN_PATH): Promise<RgbImage> {
  const scan = sharp(path);
  const { width, height } = await scan.metadata();
  if (!width || !height) throw new Error(`${path}: no image size`);
  const left = Math.round(SCAN_INSET[0] * width);
  const top = Math.round(SCAN_INSET[1] * height);
  return toRgb(scan.extract({ left, top, width: width - 2 * left, height: height - 2 * top }));
}

/** A painter-camera capture (PNG bytes or a path), whole frame. */
export function loadCapture(png: Buffer | string): Promise<RgbImage> {
  return toRgb(sharp(png));
}
