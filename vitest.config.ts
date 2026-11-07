import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __BUILD_SHA__: JSON.stringify('test') },
  // The geometry sweeps take 5-10 s on the shared CI runner, past Vitest's 5 s default.
  test: { environment: 'happy-dom', include: ['tests/**/*.test.ts'], testTimeout: 30_000 },
});
