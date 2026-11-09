/**
 * The build id (P7.1): a SHA-256 over the emitted bundle (every chunk and asset except sourcemaps),
 * the package version and every file under public/, so an asset-only change is a new build too.
 * A bundle cannot hold its own hash, so the id goes into index.html as a meta tag, which the
 * running page reads as its baseline, and into the same-origin `version.json` the poller fetches.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { BUILD_ID_META } from '../src/update/build-id.ts';

export function buildFingerprint(
  entries: ReadonlyArray<readonly [string, string | Uint8Array]>,
  version: string,
  publicDirectory: string,
): string {
  const files: Array<readonly [string, string | Uint8Array]> = [...entries];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const name = `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, name);
      else if (entry.isFile()) files.push([name, readFileSync(path)]);
    }
  };
  if (existsSync(publicDirectory)) visit(publicDirectory, 'public');
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash('sha256').update(version).update('\0');
  for (const [name, contents] of files)
    hash.update(name).update('\0').update(contents).update('\0');
  return hash.digest('hex');
}

/** Stamps the build id into index.html and emits `version.json` `{ buildId, version }`. */
export function versionManifestPlugin(version: string, publicDirectory: string): Plugin {
  return {
    name: 'gogh-build-version',
    apply: 'build',
    enforce: 'post',
    // `order: 'post'` runs after Vite's own last rewrite of the chunks (the dynamic-import preload
    // lists), so the id covers the bytes that land in dist/.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const entries = Object.entries(bundle)
          .filter(([name]) => !name.endsWith('.map'))
          .map(([name, item]) => [name, item.type === 'chunk' ? item.code : item.source] as const);
        const buildId = buildFingerprint(entries, version, publicDirectory);
        const html = bundle['index.html'];
        if (html?.type !== 'asset') throw new Error('the build id needs index.html in the bundle');
        const source =
          typeof html.source === 'string' ? html.source : Buffer.from(html.source).toString('utf8');
        if (!source.includes('</head>')) throw new Error('index.html has no </head>');
        html.source = source.replace(
          '</head>',
          `  <meta name="${BUILD_ID_META}" content="${buildId}" />\n  </head>`,
        );
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: `${JSON.stringify({ buildId, version })}\n`,
        });
      },
    },
  };
}
