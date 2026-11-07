/**
 * The full-resolution scan around the moon and the 11 stars, for their stroke colours. `make bake`
 * cuts one square per sky anchor out of the 3840 × 3041 scan and stacks them top to bottom, at
 * x = 0, in public/paintings/starry-night/lights.webp. frame.webp is 1024 px wide, too coarse for
 * the crescent's edge. Canvas uv maps onto the scan past the mat by COLOR_INSET, as it maps onto
 * frame.webp.
 */

import { type Raster, sampleColor } from '../demo/canvas/field';
import { COLOR_INSET } from '../demo/canvas/placement';
import { type SkyAnchor, skyAnchors } from './sky';

/** Width and height of assets/scans/starry-night.jpg, the bake input. */
export const SKY_SCAN_SIZE: readonly [number, number] = Object.freeze([3840, 3041]);
/** Each crop's half edge is this many anchor radii, so the whole disc fits. */
const CROP_RADII = 1.1;

/** One anchor's square of the scan, in scan pixels, and its row in lights.webp. */
export interface SkyScanCrop {
  readonly left: number;
  readonly top: number;
  readonly size: number;
  /** Top row of the crop in lights.webp. */
  readonly y: number;
}

/** Scan pixel coordinates (x right, y down, pixel k spans [k, k + 1)) of canvas uv (v up). */
export function scanPixel(uv: readonly [number, number]): [number, number] {
  const [width, height] = SKY_SCAN_SIZE;
  return [
    (COLOR_INSET[0] + uv[0] * (1 - 2 * COLOR_INSET[0])) * width,
    (COLOR_INSET[1] + (1 - uv[1]) * (1 - 2 * COLOR_INSET[1])) * height,
  ];
}

/** The crops in `skyAnchors()` order, each kept inside the scan. */
export function skyScanCrops(anchors: readonly SkyAnchor[] = skyAnchors()): SkyScanCrop[] {
  const [width, height] = SKY_SCAN_SIZE;
  let y = 0;
  return anchors.map((anchor) => {
    const half = Math.ceil(anchor.radius * CROP_RADII * width);
    const size = 2 * half;
    const [cx, cy] = scanPixel(anchor.uv);
    const left = Math.min(Math.max(Math.round(cx) - half, 0), width - size);
    const top = Math.min(Math.max(Math.round(cy) - half, 0), height - size);
    const crop = { left, top, size, y };
    y += size;
    return crop;
  });
}

/** lights.webp's size for `crops`: the widest crop by the stacked height. */
export function skyScanAtlasSize(crops: readonly SkyScanCrop[]): [number, number] {
  return [Math.max(...crops.map((c) => c.size)), crops.reduce((sum, c) => sum + c.size, 0)];
}

/**
 * The scan's colour at canvas uv, bilinear, read from `crop`'s square of lights.webp (`atlas`), or
 * null when uv falls outside that square.
 */
export function sampleSkyScan(
  atlas: Raster,
  crop: SkyScanCrop,
  uv: readonly [number, number],
): [number, number, number] | null {
  const [x, y] = scanPixel(uv);
  const lx = x - crop.left;
  const ly = y - crop.top;
  if (!(lx >= 0.5 && ly >= 0.5 && lx <= crop.size - 0.5 && ly <= crop.size - 0.5)) return null;
  return sampleColor(atlas, lx / atlas.width, 1 - (crop.y + ly) / atlas.height);
}
