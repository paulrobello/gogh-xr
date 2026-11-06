import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __BUILD_SHA__: JSON.stringify('test') },
  test: { environment: 'happy-dom', include: ['tests/**/*.test.ts'] },
});
