# Gogh XR

A Meta Quest 3 WebXR experience: step through a gallery frame and walk inside Van Gogh's *The Starry Night*, painted in more than a million animated GPU brushstrokes.

Status: Phase 0 (foundation and feasibility). The repo has the Vite and three.js scaffold, a desktop preview with WASD and mouse look, WebXR session entry, the `?diag` hooks, a stroke benchmark (`?bench`), the e2e harness and the asset provenance gate. The painting itself arrives in later phases. Requirements are in [PRD.md](PRD.md) and the per-phase plans are in [plans/](plans/). The kanban board tracks the work under the project `gogh-xr`.

## Setup

```sh
make install                    # bun install --frozen-lockfile
bunx playwright install chromium  # once, before make e2e
make dev                        # Vite dev server on http://localhost:4252
```

Gate targets:

- `make checkall` is the fast gate (lint, typecheck, test, build, bundle-check).
- `make checkall-ci` adds gitleaks (working tree and history), `bun audit` and `asset-check`. Run it before any push.
- `make e2e` runs the Playwright suite against the IWER-emulated Quest 3. It is local only.

## License

The source code is MIT licensed (see [LICENSE](LICENSE)). Media under `assets/` and `public/paintings/` is not covered by the MIT license. Its source, license and rights status are listed per file in [assets/PROVENANCE.md](assets/PROVENANCE.md).

| Phase | Plan |
| --- | --- |
| P0 Foundation and feasibility | [phase-0-foundation.md](plans/phase-0-foundation.md) |
| P1 Stroke engine | [phase-1-stroke-engine.md](plans/phase-1-stroke-engine.md) |
| P2 Starry Night world | [phase-2-starry-night-world.md](plans/phase-2-starry-night-world.md) |
| P3 Locomotion and comfort | [phase-3-locomotion-comfort.md](plans/phase-3-locomotion-comfort.md) |
| P4 Living paint | [phase-4-living-paint.md](plans/phase-4-living-paint.md) |
| P5 Gallery, portal and settings | [phase-5-gallery-portal-settings.md](plans/phase-5-gallery-portal-settings.md) |
| P6 Audio | [phase-6-audio.md](plans/phase-6-audio.md) |
| P7 Release | [phase-7-release.md](plans/phase-7-release.md) |
