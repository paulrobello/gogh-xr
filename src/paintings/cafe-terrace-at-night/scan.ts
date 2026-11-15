/** The scan as the world uses it: a GPU texture for the paint and CPU pixels for the build. */
import { LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three';
import type { Raster } from '../../demo/canvas/field';

const SCAN_TIMEOUT_MS = 30_000;

/**
 * The scan as an `ImageBitmap`, decoded off the main thread, with its top row first: the paint
 * material reads it by canvas (u, v), v down.
 */
export async function loadScanTexture(url: string, anisotropy: number): Promise<Texture> {
  const response = await fetch(url, { signal: AbortSignal.timeout(SCAN_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none' });
  const texture = new Texture(bitmap);
  texture.flipY = false;
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

export function disposeScanTexture(texture: Texture): void {
  texture.dispose();
  (texture.image as ImageBitmap).close();
}

function mirrored(x: number): number {
  return 1 - Math.abs(1 - (((x % 2) + 2) % 2));
}

/** The scan's sRGB bytes at canvas (u, v), mirrored past its edges as the paint material does. */
export function scanSampler(
  raster: Raster,
): (u: number, v: number) => readonly [number, number, number] {
  const { width, height, data } = raster;
  return (u, v) => {
    const x = Math.min(width - 1, Math.floor(mirrored(u) * width));
    const y = Math.min(height - 1, Math.floor(mirrored(v) * height));
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
}
