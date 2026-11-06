import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT, gpuArgs, gpuMode } from './tests/e2e/gpu';

// Local only, never in CI. Renders on the Mac GPU through ANGLE/Metal by default.
// `PW_GPU=swiftshader make e2e` opts into software GL for a GPU-less machine.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  retries: 0,
  // SwiftShader renders on the CPU, so it starves past two workers.
  workers: gpuMode === 'swiftshader' ? 2 : '50%',
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // New headless (full Chromium): the headless shell software-renders WebGL.
    channel: 'chromium',
    headless: true,
    launchOptions: { args: gpuArgs },
  },
  webServer: {
    command: `bunx vite build --mode e2e && bunx vite preview --mode e2e --port ${E2E_PORT} --strictPort`,
    url: `http://localhost:${E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
