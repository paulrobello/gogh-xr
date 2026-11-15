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
 * CAFE_CAPTURE_SIZE on 2026-11-15 with the set built in depth: 0.566 and 3.12, each bar a margin
 * off that. The flat set that wore the scan itself scored 0.98 and 0.51 from here and streaked from
 * everywhere else; Starry Night's own painter view scores about 0.31 and 5.7.
 */
export const CAFE_SSIM_THRESHOLD = 0.5;
export const CAFE_DELTA_E_THRESHOLD = 4.5;

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
