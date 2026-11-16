// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  decodeIco,
  encodeIco,
  ICO_FILE,
  ICO_SIZES,
  ICON_OUTPUTS,
  pngSize,
  SHARE_IMAGE,
  SITE_ORIGIN,
  SOURCE_DIR,
  SVG_FAVICON,
} from '../scripts/site/site-lib.ts';

const root = resolve(import.meta.dirname, '..');
const bytes = (path: string): Uint8Array => new Uint8Array(readFileSync(resolve(root, path)));
const html = readFileSync(resolve(root, 'index.html'), 'utf8');

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}
interface Manifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}
const manifest = JSON.parse(
  readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8'),
) as Manifest;

/** Attributes of every `<tag ...>` in index.html. */
function tags(tag: 'meta' | 'link'): Array<Record<string, string>> {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((match) =>
    Object.fromEntries(
      [...(match[1] as string).matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
    ),
  );
}
const meta = (key: string): string | undefined =>
  tags('meta').find((t) => t.property === key || t.name === key)?.content;
/** The public file a root-relative or site-absolute URL names. */
const publicFile = (url: string): string =>
  `public/${url.replace(`${SITE_ORIGIN}/`, '').replace(/^\//, '')}`;

describe('site icons', () => {
  it('writes every icon at its stated size', () => {
    for (const icon of ICON_OUTPUTS) {
      expect(pngSize(bytes(icon.file)), icon.file).toEqual({
        width: icon.size,
        height: icon.size,
      });
    }
  });

  it('packs the 16, 32 and 48 px PNGs into favicon.ico', () => {
    const images = decodeIco(bytes(ICO_FILE));
    expect(images.map((png) => pngSize(png).width)).toEqual([...ICO_SIZES]);
    expect(decodeIco(encodeIco(images.map((png) => ({ size: pngSize(png).width, png }))))).toEqual(
      images,
    );
  });

  it('serves the simplified mark as the SVG favicon', () => {
    expect(bytes(SVG_FAVICON.file)).toEqual(bytes(`${SOURCE_DIR}/${SVG_FAVICON.source}`));
  });

  it('keeps the maskable mark inside the safe zone on a full-bleed tile', async () => {
    const { data, info } = await sharp(resolve(root, 'public/icons/icon-maskable-512.png'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const safe = 0.4 * info.width;
    let warmInside = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * 4;
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]] as number[];
        expect(a, `alpha at ${x},${y}`).toBe(255);
        const outside = Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2) > safe;
        // Every pixel of the mark, gold or blue stroke, is brighter than the night tile.
        if (outside)
          expect(Math.max(r, g), `mark outside the safe zone at ${x},${y}`).toBeLessThan(90);
        else if (r > 200 && r > b) warmInside++;
      }
    }
    expect(warmInside).toBeGreaterThan(10_000);
  });
});

describe('web app manifest', () => {
  it('describes a standalone app relative to the site base', () => {
    expect(manifest.name).toBe('Gogh XR');
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.description.length).toBeGreaterThan(40);
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('names icons that exist at their stated size', () => {
    for (const icon of manifest.icons) {
      const file = `public/${icon.src}`;
      expect(existsSync(resolve(root, file)), file).toBe(true);
      const { width, height } = pngSize(bytes(file));
      expect(`${width}x${height}`, file).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
    }
    for (const purpose of ['any', 'maskable']) {
      expect(
        manifest.icons.filter((icon) => icon.purpose === purpose).map((icon) => icon.sizes),
      ).toEqual(['192x192', '512x512']);
    }
  });
});

describe('index.html head', () => {
  it('links the favicons, the touch icon and the manifest', () => {
    const links = tags('link');
    const icons = links.filter((link) => link.rel === 'icon').map((link) => link.href);
    expect(icons).toEqual([
      '/favicon.ico',
      '/favicon.svg',
      '/favicon-32x32.png',
      '/favicon-16x16.png',
    ]);
    const touch = links.find((link) => link.rel === 'apple-touch-icon');
    expect(touch?.href).toBe('/apple-touch-icon.png');
    expect(links.find((link) => link.rel === 'manifest')?.href).toBe('/manifest.webmanifest');
    for (const href of [...icons, touch?.href, '/manifest.webmanifest']) {
      expect(existsSync(resolve(root, publicFile(href as string))), href).toBe(true);
    }
    for (const link of links.filter((l) => l.sizes && l.type === 'image/png')) {
      const { width, height } = pngSize(bytes(publicFile(link.href as string)));
      expect(`${width}x${height}`).toBe(link.sizes);
    }
    expect(pngSize(bytes('public/apple-touch-icon.png')).width).toBe(180);
  });

  it('matches the manifest theme colour', () => {
    expect(meta('theme-color')).toBe(manifest.theme_color);
  });

  it('carries the Open Graph and Twitter tags on the deployed origin', async () => {
    expect(readFileSync(resolve(root, 'public/CNAME'), 'utf8').trim()).toBe(
      new URL(SITE_ORIGIN).host,
    );
    expect(meta('og:type')).toBe('website');
    expect(meta('og:url')).toBe(`${SITE_ORIGIN}/`);
    expect(meta('og:title')).toContain('Gogh XR');
    expect(meta('og:description')?.length).toBeGreaterThan(40);
    expect(meta('description')?.length).toBeGreaterThan(40);
    expect(meta('twitter:card')).toBe('summary_large_image');
    expect(meta('twitter:title')).toBe(meta('og:title'));
    expect(meta('twitter:description')).toBe(meta('og:description'));
    expect(meta('og:image:alt')?.length).toBeGreaterThan(20);
    expect(meta('twitter:image:alt')).toBe(meta('og:image:alt'));

    const image = meta('og:image') as string;
    expect(image).toBe(`${SITE_ORIGIN}/${SHARE_IMAGE.file.replace('public/', '')}`);
    expect(meta('twitter:image')).toBe(image);
    const info = await sharp(resolve(root, publicFile(image))).metadata();
    expect(info.format).toBe('jpeg');
    expect([info.width, info.height]).toEqual([SHARE_IMAGE.width, SHARE_IMAGE.height]);
    expect(meta('og:image:type')).toBe('image/jpeg');
    expect(meta('og:image:width')).toBe(String(SHARE_IMAGE.width));
    expect(meta('og:image:height')).toBe(String(SHARE_IMAGE.height));
  });
});
