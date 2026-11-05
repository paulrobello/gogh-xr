import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '0.0.0.0', port: 4252, strictPort: true },
  preview: { host: '0.0.0.0', port: 4253, strictPort: true },
  build: { target: 'es2023', sourcemap: true, chunkSizeWarningLimit: 1000 },
});
