import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/** Short git SHA for `__BUILD_SHA__`, the scatter cache's build key; 'dev' when git fails. */
function buildSha(): string {
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
  define: { __BUILD_SHA__: JSON.stringify(buildSha()) },
  server: { host: '0.0.0.0', port: 4252, strictPort: true },
  preview: { host: '0.0.0.0', port: 4253, strictPort: true },
  build: {
    target: 'es2023',
    sourcemap: true,
    chunkSizeWarningLimit: 1000,
    outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
  },
}));
