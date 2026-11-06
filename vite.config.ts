import { defineConfig } from 'vite';

// `--mode e2e` builds the IWER-enabled test bundle into its own tree, so the
// production dist/ that bundle-check greps is never overwritten by it.
export default defineConfig(({ mode }) => ({
  server: { host: '0.0.0.0', port: 4252, strictPort: true },
  preview: { host: '0.0.0.0', port: 4253, strictPort: true },
  build: {
    target: 'es2023',
    sourcemap: true,
    chunkSizeWarningLimit: 1000,
    outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
  },
}));
