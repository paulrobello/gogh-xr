# gogh-xr

A Meta Quest 3 WebXR experience built with three.js, Vite and bun. Requirements live in [PRD.md](PRD.md) and the phase plans in [plans/](plans/).

## Make targets

`install build test lint fmt typecheck checkall checkall-ci bundle-check asset-check bake e2e dev dev-start dev-stop dev-restart preview pre-commit`

## Ports

- 4252: Vite dev server (`make dev`)
- 4253: Vite preview for the e2e suite (`make preview`)

## Gate rules

- `make checkall` is the fast gate while iterating (lint, typecheck, test, build, bundle-check).
- `make checkall-ci` must pass before any push. It adds gitleaks, `bun audit` and `asset-check`.
- `make e2e` is local-only and never runs in CI.
- `make bake` regenerates the Starry Night bake outputs (palette, flow field, region ids) from the 3840 px scan and rewrites their PROVENANCE.md rows. It is not part of `checkall`, and `asset-check` verifies the committed outputs.
- Never pipe a gate. Redirect to a file, capture the exit code, then tail the log.
- No push without Paul's approval.

## URL flags

Parsed in `src/diag/flags.ts`.

- `?diag`: installs `window.__goghDiag()` (renderer info, XR state, frame rates, camera pose, counts).
- `?iwer`: installs the IWER Meta Quest 3 emulator. Only honoured in `--mode e2e` builds, never in production.
- `?bench=N`: runs the stroke benchmark with N strokes (default 100000, capped at 2,000,000). A non-numeric value uses the default. Strokes fill a full sphere, so every view direction reads the same. In XR, the right controller's A button steps fixed foveation through 0 (the app default), 0.5 and 1. Each settings combination, foveation included, records fps, mean, p95 and p99 once its window settles. Results persist in localStorage under `gogh-xr.bench.results.v1`, show on the HUD, and appear as `benchResults` in `__goghDiag()`.
- `&mode=a2c|blend`: benchmark transparency mode, alpha-to-coverage (default) or blended. In the headset, the left controller's X button toggles the mode and resets the order to that mode's default.
- `&size=px`: benchmark stroke size in pixels (default 24).
- `&order=sorted|random`: benchmark draw order. Default is random for a2c and sorted for blend.
- `?hz=72|90|120`: requested XR target frame rate (default 90). Quest 3 reports `supportedFrameRates` of 72, 80, 90 and 120. In the headset, the left controller's Y button steps the target through the supported rates.
- `?beauty`: boolean, max-beauty mode. Targets 72 Hz with the max-beauty budget (500k drawn), and the governor starts from the max-beauty densities (`BEAUTY_BAND_DENSITY`). It wins over `?hz`, which it ignores. The bench (`?bench`) ignores it.
- `?slow=<ms>`: testing only. Busy-waits on the CPU for that many ms every frame, to force overruns for the governor. Clamped to 0-50. A malformed value means 0 (off). It is honoured in production builds on purpose: it is URL-only, it only slows the page that asks for it, and the P1.8 headset check needs it on the deployed build.
- `?nogov`: boolean, testing only. Keeps the quality governor off, so densities stay fixed. The e2e specs that check stroke counts in XR use it, because headless Chromium's 60 Hz vsync already overruns the 90 Hz budget. Like `?slow`, it is honoured in production builds on purpose, since it is URL-only and affects only the page that sets it.
- The quality governor (`src/render/governor.ts`) runs in XR for every scene with a stroke batch (`?strokesTest`, `?demo=canvas`), never for `?bench`. Its budget follows the frame rate the session reports, and the 72 Hz fallback commits only once `updateTargetFrameRate` resolves. With `?diag`, `__goghDiag().governor` shows its mode, target, reported frame rate, rate request state, level, densities, framebuffer scale, foveation, last window mean, notice and a bounded history of shed, restore and rate events.
- `?shot`: boolean, honoured only together with `?diag`. Enables `window.__goghShot()` (canvas PNG data URL) and `preserveDrawingBuffer`. It takes no value.
- `?strokesTest`: boolean. Builds the deterministic stroke-engine test scene (`src/render/strokes/test-scene.ts`): 6000 strokes over 14 chunks, including a sky wall at z = -2 and a building wall behind the viewer at z = +6. It registers `strokes` in `__goghDiag()`, reporting `{ chunks, visibleChunks, total, visible, atlasMs }`.
- `?demo=canvas`: the P1 test canvas (`src/demo/canvas/`). It repaints the painting in about 200k strokes on a 4 × 3.17 m plane centred at (0, 1.6, -2.55), facing the XR origin. In this mode the desktop viewer starts at the origin too. Placement is deterministic for `?seed`, and no seed means seed 1. It registers `canvas` in `__goghDiag()`: `{ seed, count, decodeMs, placeMs, batchMs, buildMs, strokes }`, where `strokes` holds the batch stats. Capture the P1-A2 shot with `bun scripts/capture-shot.ts "http://localhost:PORT/?diag&shot&demo=canvas&noanim&seed=1" docs/shots/p1-canvas.png --wait canvas`.

## Model routing

Opus 5.5 for complex or visual work, Sonnet 5.5 otherwise.
