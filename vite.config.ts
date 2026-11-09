import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { versionManifestPlugin } from './scripts/build-version.ts';
import { DEV_PORT, E2E_PORT } from './scripts/ports.ts';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

/**
 * Short git SHA for `__BUILD_SHA__`, the scatter cache's build key; 'dev' when git fails.
 * In an e2e build only, `GOGH_BUILD_SHA` overrides it: the update A-to-B check
 * (scripts/update-ab.ts) builds two genuinely different bundles from one tree with it. A
 * production build ignores it. The build id (`version.json`) is separate.
 */
function buildSha(mode: string): string {
  const override = process.env.GOGH_BUILD_SHA?.trim();
  if (override && mode === 'e2e') return override;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

// `--mode e2e` builds the IWER-enabled test bundle into its own tree, so the
// production dist/ that bundle-check greps is never overwritten by it.
export default defineConfig(({ mode }) => ({
  define: { __BUILD_SHA__: JSON.stringify(buildSha(mode)) },
  plugins: [versionManifestPlugin(version, fileURLToPath(new URL('./public', import.meta.url)))],
  server: { host: '0.0.0.0', port: DEV_PORT, strictPort: true },
  preview: { host: '0.0.0.0', port: E2E_PORT, strictPort: true },
  build: {
    target: 'es2023',
    // The e2e build keeps linked maps for debugging; production maps are emitted but unreferenced.
    sourcemap: mode === 'e2e' ? true : 'hidden',
    outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
  },
}));
