# 0001. XR emulation for the e2e suite

- Status: accepted
- Date: 2026-11-05
- Resolves: PRD OQ3, risk R-5

## Context

Every later XR test needs an emulated Quest 3 under Playwright. PRD OQ3 asked whether IWER 2.8.0 runs under Playwright headless Chromium. R-5 named the fallbacks if it did not: IWSDK's emulator plugin, or a WebXR polyfill with scripted poses.

## Decision

Use IWER 2.8.0 directly, under Playwright 1.63.0 with the new headless mode of the full Chromium build (`channel: 'chromium'`, `headless: true`). No fallback is needed.

- `vite build --mode e2e` writes an IWER-enabled bundle to `dist-e2e/`. With `?iwer`, `src/main.ts` dynamically imports `src/xr/iwer-install.ts` behind `import.meta.env.MODE === 'e2e'` before any WebXR code reads `navigator.xr`. That module calls `new XRDevice(metaQuest3).installRuntime({ forceInstall: true })` and exposes the device as `window.__goghIwer`.
- `forceInstall: true` is required. Chromium defines a native `navigator.xr` even with no headset attached, and without the flag IWER logs a warning and skips installation.
- The production build drops the guarded branch, so `dist/` contains no IWER module. `make bundle-check` fails in two cases. The first is any match in `dist/` for `XRDevice`, `metaQuest3`, `Meta Quest 3`, `forceInstall` or `__goghIwer`. The first two survive only in sourcemaps, while the last three survive minification. The second is any `iwer-install*` file. Running `make bundle-check BUNDLE_DIR=dist-e2e BUNDLE_GREP_FLAGS=--exclude=*.map` fails on the minified chunk, which proves the check can fire even without sourcemaps.
- `tests/e2e/fixtures.ts` drives the device through `page.evaluate`: `boot`, `enterXR`, `press`, `stick`, `setPose`, `diag` and `waitFrames`. An automatic fixture fails any test on `console.error`, a page error, a Chromium WebGL error or a three shader compile/link log. The only allowlisted message is the 404 for `/favicon.ico`, because the app ships no favicon.
- `requestSession('immersive-vr')` is granted without a separate offer step, so the fixture enters XR by clicking the app's own Enter VR button.

## Evidence

Observed on 2026-11-05 on the Apple M4 Max dev machine, headless:

| Mode | `UNMASKED_RENDERER_WEBGL` | Result |
|---|---|---|
| default (`PW_GPU` unset, Metal ANGLE) | `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)` | 2 passed |
| `PW_GPU=swiftshader` | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)` | 2 passed |

The harness test boots `?iwer&diag`, enters immersive VR, reads `diag().xr.presenting === true`, presses the right trigger and sees `diag().input.selectstart.right` go from 0 to 1, and asserts the renderer string is not a software renderer in Metal mode. A deliberate `console.error` carrying a three shader-error message made a scratch test fail, which confirms the error fixture fires.

## Consequences

- Headed mode was not needed and was not tried.
- The e2e suite is local only and never runs in CI.
- `make preview` now serves the e2e build on port 4253, the same server the Playwright `webServer` starts. Parallel worktrees collide on that port, so both honour `E2E_PORT` (for example `E2E_PORT=4263 make e2e`).
- `enterXR()` waits for two rendered frames after `presenting` turns true. Until an XR frame renders, the camera still holds the desktop pose.
