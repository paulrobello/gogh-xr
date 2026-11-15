/**
 * The café painter view against the scan, with the shared fidelity metric (scripts/fidelity-lib.ts):
 * both at 256 px wide, SSIM on luma and mean ΔE2000 over blocks.
 */
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { compareFidelity, type FidelityResult, type RgbImage } from '../fidelity-lib.ts';

const SCAN = fileURLToPath(
  new URL('../../assets/scans/cafe-terrace-at-night.jpg', import.meta.url),
);
const WIDTH = 256;
/** 256 px at the scan's 1280 × 1596. */
const HEIGHT = 319;

/** Capture at the scan's aspect: this many pixels, or a multiple. */
export const CAFE_CAPTURE_SIZE: Readonly<{ width: number; height: number }> = Object.freeze({
  width: 642,
  height: 800,
});
/**
 * A capture passes with SSIM ≥ and mean ΔE2000 ≤ these. Measured on ANGLE Metal at
 * CAFE_CAPTURE_SIZE on 2026-11-15: 0.9814 and 0.506. The hand-coloured set this replaced scored 0.25
 * and 13.8.
 */
export const CAFE_SSIM_THRESHOLD = 0.95;
export const CAFE_DELTA_E_THRESHOLD = 1.5;

async function load(image: Buffer | string): Promise<RgbImage> {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .resize(WIDTH, HEIGHT, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export async function cafeFidelity(capture: Buffer | string): Promise<FidelityResult> {
  return compareFidelity(await load(SCAN), await load(capture));
}
