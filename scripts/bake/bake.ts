import sharp from 'sharp';
import { COLOR_INSET } from '../../src/demo/canvas/placement.ts';
import { SKY_SCAN_SIZE, skyScanAtlasSize, skyScanCrops } from '../../src/world/sky-scan.ts';
import {
  encodeFlow,
  kmeansPalette,
  orientationField,
  type RegionsDoc,
  rasterizeRegions,
  type Swatch,
} from './scan-analysis.ts';

export interface BakeOptions {
  /** Edge of the square flow and region rasters. */
  fieldSize?: number;
  /** Width of the aspect-preserving downscale that k-means samples. */
  paletteWidth?: number;
  /** Palette swatch count. */
  k?: number;
  /** k-means++ seed. */
  seed?: number;
}

export interface BakeOutput {
  /** palette.json text. */
  palette: string;
  /** flow.png bytes: RGB8, R/G = doubled-angle stroke orientation, B = coherence. */
  flow: Buffer;
  /** regions.png bytes: 8-bit greyscale, one region id per pixel. */
  regions: Buffer;
}

/** Fixed PNG options so the encoded bytes are stable from run to run. */
const PNG = { compressionLevel: 9, adaptiveFiltering: true, palette: false } as const;

function paletteJson(k: number, seed: number, swatches: Swatch[]): string {
  const rows = swatches.map(
    (s) => `    { "hex": "${s.hex}", "rgb": [${s.rgb.join(', ')}], "weight": ${s.weight} }`,
  );
  return [
    '{',
    `  "k": ${k},`,
    `  "seed": ${seed},`,
    '  "space": "oklab",',
    '  "order": "oklab lightness, dark to light",',
    '  "swatches": [',
    rows.join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

/** A pixel rectangle of an image, left and top inclusive. */
export interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The painted canvas inside a `width` × `height` scan: the scan inset past its mat by COLOR_INSET,
 * rounded to whole pixels. Canvas uv [0, 1]² covers exactly this rectangle, as it covers
 * frame.webp past the same inset. On the 3840 × 3041 scan it is 3750 × 3011 at (45, 15).
 */
export function canvasRect(width: number, height: number): PixelRect {
  const left = Math.round(COLOR_INSET[0] * width);
  const top = Math.round(COLOR_INSET[1] * height);
  return { left, top, width: width - 2 * left, height: height - 2 * top };
}

/**
 * Runs the scan bake on one image. Every output covers the painted canvas only, the scan cropped
 * to {@link canvasRect}, so the mat never reaches a swatch, a flow texel or a region texel. The
 * flow field and region raster are square (`fieldSize`²), so the canvas is squashed to fit and
 * both are sampled by canvas uv. θ in flow.png is corrected back to painting space (see
 * {@link orientationField}'s `aspect`).
 */
export async function bakeScan(
  input: string | Buffer,
  regionsDoc: RegionsDoc,
  opts: BakeOptions = {},
): Promise<BakeOutput> {
  const { fieldSize = 1024, paletteWidth = 256, k = 24, seed = 1 } = opts;
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) throw new Error('bakeScan: input has no dimensions');
  const canvas = canvasRect(meta.width, meta.height);

  const field = await sharp(input)
    .extract(canvas)
    .removeAlpha()
    .toColourspace('srgb')
    .resize(fieldSize, fieldSize, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  const lum = new Float32Array(fieldSize * fieldSize);
  for (let i = 0; i < lum.length; i++) {
    lum[i] =
      (0.2126 * (field[i * 3] as number) +
        0.7152 * (field[i * 3 + 1] as number) +
        0.0722 * (field[i * 3 + 2] as number)) /
      255;
  }
  const { angle, coherence } = orientationField(lum, fieldSize, fieldSize, {
    aspect: canvas.width / canvas.height,
  });
  const raw = { width: fieldSize, height: fieldSize };
  const flow = await sharp(encodeFlow(angle, coherence), { raw: { ...raw, channels: 3 } })
    .png(PNG)
    .toBuffer();

  const ids = rasterizeRegions(regionsDoc, fieldSize, fieldSize);
  const regions = await sharp(ids, { raw: { ...raw, channels: 1 } })
    .toColourspace('b-w')
    .png(PNG)
    .toBuffer();

  const sample = await sharp(input)
    .extract(canvas)
    .removeAlpha()
    .toColourspace('srgb')
    .resize({ width: paletteWidth, kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  const palette = paletteJson(k, seed, kmeansPalette(new Uint8Array(sample), k, seed));

  return { palette, flow, regions };
}

/**
 * The scan's crops around the moon and star anchors (src/world/sky-scan.ts), stacked top to bottom
 * at x = 0 on black. Lossy WebP at quality 90 keeps the full-resolution luma in about 0.8 MB, a
 * third of the lossless size; smart chroma subsampling keeps the crescent's colour edge.
 */
export async function bakeSkyLights(input: string | Buffer): Promise<Buffer> {
  const { width, height } = await sharp(input).metadata();
  if (width !== SKY_SCAN_SIZE[0] || height !== SKY_SCAN_SIZE[1]) {
    throw new Error(
      `bakeSkyLights: scan is ${width}x${height}, sky-scan.ts expects ${SKY_SCAN_SIZE}`,
    );
  }
  const crops = skyScanCrops();
  const [atlasWidth, atlasHeight] = skyScanAtlasSize(crops);
  const tiles = await Promise.all(
    crops.map(async (c) => ({
      input: await sharp(input)
        .removeAlpha()
        .toColourspace('srgb')
        .extract({ left: c.left, top: c.top, width: c.size, height: c.size })
        .png()
        .toBuffer(),
      left: 0,
      top: c.y,
    })),
  );
  return sharp({
    create: { width: atlasWidth, height: atlasHeight, channels: 3, background: '#000000' },
  })
    .composite(tiles)
    .webp({ quality: 90, smartSubsample: true, effort: 6 })
    .toBuffer();
}
