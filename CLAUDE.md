# gogh-xr

A Meta Quest 3 WebXR experience built with three.js, Vite and bun. Requirements live in [PRD.md](PRD.md) and the phase plans in [plans/](plans/).

## Make targets

`install build test lint fmt typecheck checkall checkall-ci bundle-check asset-check e2e dev dev-start dev-stop dev-restart preview pre-commit`

## Ports

- 4252: Vite dev server (`make dev`)
- 4253: Vite preview for the e2e suite (`make preview`)

## Gate rules

- `make checkall` is the fast gate while iterating (lint, typecheck, test, build, bundle-check).
- `make checkall-ci` must pass before any push. It adds gitleaks, `bun audit` and `asset-check`.
- `make e2e` is local-only and never runs in CI.
- Never pipe a gate. Redirect to a file, capture the exit code, then tail the log.
- No push without Paul's approval.

## URL flags

Parsed in `src/diag/flags.ts`.

- `?diag`: installs `window.__goghDiag()` (renderer info, XR state, frame rates, camera pose, counts).
- `?iwer`: installs the IWER Meta Quest 3 emulator. Only honoured in `--mode e2e` builds, never in production.
- `?bench=N`: runs the stroke benchmark with N strokes (default 100000, capped at 2,000,000). A non-numeric value uses the default.
- `&mode=a2c|blend`: benchmark transparency mode, alpha-to-coverage (default) or blended. In the headset, the left controller's X button toggles the mode and resets the order to that mode's default.
- `&size=px`: benchmark stroke size in pixels (default 24).
- `&order=sorted|random`: benchmark draw order. Default is random for a2c and sorted for blend.
- `?hz=72|90|120`: requested XR target frame rate (default 90). Quest 3 supports 70, 80, 90 and 120, so 72 is rejected and the session keeps its own rate. In the headset, the left controller's Y button steps the target through the supported rates.
- `?shot`: boolean, honoured only together with `?diag`. Enables `window.__goghShot()` (canvas PNG data URL) and `preserveDrawingBuffer`. It takes no value.

## Model routing

Opus 5.5 for complex or visual work, Sonnet 5.5 otherwise.
