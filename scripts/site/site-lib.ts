/** Shared by `scripts/site/generate.ts` and `tests/site-meta.test.ts`. */

export const SITE_ORIGIN = 'https://gogh-xr.pardev.net';
export const SOURCE_DIR = 'assets/site';
export const SHARE_IMAGE = { file: 'public/og-image.jpg', width: 1200, height: 630 } as const;

export interface IconOutput {
  /** Repo-relative output path. */
  file: string;
  /** Source SVG under `SOURCE_DIR`. */
  source: 'icon.svg' | 'icon-small.svg' | 'icon-maskable.svg';
  /** Square edge in pixels. */
  size: number;
}

/** `icon-small.svg` is the simplified mark, drawn for 48 px and below. */
export const ICON_OUTPUTS: readonly IconOutput[] = [
  { file: 'public/favicon-16x16.png', source: 'icon-small.svg', size: 16 },
  { file: 'public/favicon-32x32.png', source: 'icon-small.svg', size: 32 },
  { file: 'public/favicon-48x48.png', source: 'icon-small.svg', size: 48 },
  // iOS masks the corners itself, so the touch icon is the full-bleed art.
  { file: 'public/apple-touch-icon.png', source: 'icon-maskable.svg', size: 180 },
  { file: 'public/icons/icon-192.png', source: 'icon.svg', size: 192 },
  { file: 'public/icons/icon-512.png', source: 'icon.svg', size: 512 },
  { file: 'public/icons/icon-maskable-192.png', source: 'icon-maskable.svg', size: 192 },
  { file: 'public/icons/icon-maskable-512.png', source: 'icon-maskable.svg', size: 512 },
];

export const ICO_FILE = 'public/favicon.ico';
export const ICO_SIZES: readonly number[] = [16, 32, 48];
export const SVG_FAVICON = { file: 'public/favicon.svg', source: 'icon-small.svg' } as const;
export const SOURCE_FILES: readonly string[] = [
  'icon.svg',
  'icon-small.svg',
  'icon-maskable.svg',
  'share-starry-night.jpg',
  'share-cafe-terrace.jpg',
];

/** An ICO whose images are stored as PNG, one per entry. */
export function encodeIco(images: ReadonlyArray<{ size: number; png: Uint8Array }>): Uint8Array {
  const header = 6 + 16 * images.length;
  const out = new Uint8Array(header + images.reduce((sum, image) => sum + image.png.length, 0));
  const view = new DataView(out.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, images.length, true);
  let offset = header;
  images.forEach((image, i) => {
    const entry = 6 + 16 * i;
    out[entry] = image.size % 256;
    out[entry + 1] = image.size % 256;
    view.setUint16(entry + 4, 1, true);
    view.setUint16(entry + 6, 32, true);
    view.setUint32(entry + 8, image.png.length, true);
    view.setUint32(entry + 12, offset, true);
    out.set(image.png, offset);
    offset += image.png.length;
  });
  return out;
}

/** The PNG images inside an ICO written by `encodeIco`. */
export function decodeIco(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) throw new Error('not an ICO');
  const images: Uint8Array[] = [];
  for (let i = 0; i < view.getUint16(4, true); i++) {
    const entry = 6 + 16 * i;
    const length = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    images.push(bytes.subarray(offset, offset + length));
  }
  return images;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
