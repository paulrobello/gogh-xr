import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  UnsignedByteType,
} from 'three';
import { flags } from '../../diag/flags';
import { ATLAS_SIZE, DEFAULT_BRUSH_SEED, generateBrushAtlas } from './brush-atlas-data';

export * from './brush-atlas-data';

/**
 * Generates the brush atlas (layout and channels in `brush-atlas-data.ts`) into a mipmapped,
 * linear RGBA8 `DataTexture`. `seed` defaults to `?seed`, then to `DEFAULT_BRUSH_SEED`.
 * The caller owns the texture and calls `dispose()` on it when done.
 */
export function createBrushAtlas(seed: number | null = flags.seed): DataTexture {
  const data = generateBrushAtlas(seed ?? DEFAULT_BRUSH_SEED);
  const texture = new DataTexture(
    data,
    ATLAS_SIZE,
    ATLAS_SIZE,
    RGBAFormat,
    UnsignedByteType,
    undefined,
    ClampToEdgeWrapping,
    ClampToEdgeWrapping,
    LinearFilter,
    LinearMipmapLinearFilter,
  );
  texture.name = 'brush-atlas';
  texture.colorSpace = NoColorSpace;
  texture.generateMipmaps = true;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}
