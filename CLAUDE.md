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

## Model routing

Opus 5.5 for complex or visual work, Sonnet 5.5 otherwise.
