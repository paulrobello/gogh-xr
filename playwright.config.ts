import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT, gpuArgs, gpuMode } from './tests/e2e/gpu';

/**
 * Specs that hold a frame-time bar. They must not share the CPU with the parallel phase's other
 * Chromiums, which stretched the portal's longest build step past its 27.8 ms bar. As the `e2e`
 * project's teardown they start once every other spec has finished, pass or fail, and a run that
 * names only them still runs only them.
 */
const TIMING_SPECS = /portal\.spec\.ts$/;

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
  projects: [
    { name: 'e2e', testIgnore: TIMING_SPECS, teardown: 'timing' },
    { name: 'timing', testMatch: TIMING_SPECS, workers: 1 },
  ],
  webServer: {
    command: 'make preview',
    env: { E2E_PORT: String(E2E_PORT) },
    url: `http://localhost:${E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
