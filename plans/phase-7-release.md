# Phase 7: Release

PRD: [P7](../PRD.md#p7--release). P7.1 can start as soon as P0.2 is done, because its A→B check runs against locally served builds. Everything else in this phase waits for P3 through P6 to pass their headset checks.

## Tasks

### P7.1: Build-version polling and XR-safe reload
- **Depends on:** P0.2. The HUD action uses P5.6 once that task lands. Until then, use a plain notice.
- **Steps:**
  - Port mux-xr's `src/update-check.ts` and `src/reload.ts` behaviour, following the "Frontend version notifications" section of `~/.claude/guides/webxr.md`:
    - Embed the build id at build time and emit a same-origin `version.json`. The id fingerprints the bundles, the package version and the public assets.
    - Check once immediately, then every 30 s, with a 5 s timeout and cache-bypassing requests that never overlap.
    - On desktop, reload automatically.
    - In XR, show a "Update: Reload" action on the HUD (P5.6). It waits for the session to end before navigating with a cache-busting URL that keeps the query and fragment.
    - Do not use the first poll as the baseline.
- **Verify:**
  - Unit tests cover:
    - the poll schedule;
    - aborting a request on teardown;
    - a rollback clearing the notice;
    - the reload URL keeping the query and fragment.
  - A script runs a served build A then build B and checks both modes: desktop reloads automatically, and XR (IWER) shows the action and reloads only after it is selected. Check that the notice is actually visible as computed, not just that the `hidden` attribute changed.

### P7.2: Performance pass against SC1
- **Depends on:** P3.7, P4.7, P5.8, P6.6.
- **Steps:**
  - Paul runs the SC1 session at the shipped default (fixed level 5) on Quest 3 with OVR Metrics: 5 minutes covering the whole diorama, the boundary in flight, the cypress walk-through, and the portal both ways.
  - If the default falls below the 22 fps floor, profile the failing segment and repeat the route after any tuning. For a 72 Hz Auto run, record the median and the share of frames over 13.9 ms separately.
  - Record every result in `docs/perf.md` with the build id.
- **Verify:**
  - `docs/perf.md` shows the median frame rate and the share of frames over budget for the release candidate. Every one-second Quest Browser VrApi sample in the marked route must meet the 22 fps floor at the shipped default. Any 90 Hz measurements are diagnostic only.
  - **The card stays open until Paul signs off.**

### P7.3: README and docs
- **Depends on:** P7.2.
- **Steps:**
  - Write `README.md` covering:
    - what the app is;
    - the live URL;
    - the controls;
    - comfort options;
    - development (bun, make targets, ports, `adb reverse` headset workflow, flags);
    - a phase status table linking to the PRD sections;
    - credits and provenance for the scans and audio;
    - the licence.
  - Sync `CLAUDE.md` with the final gates and flags.
- **Verify:** Every flag, make target and port listed in the README exists in the code and the Makefile. Check each one with a grep and record the result in `docs/verification.md`.

### P7.4: Release verification and final acceptance (owner)
- **Depends on:** P7.1, P7.2, P7.3.
- **Steps:**
  - Run `make checkall-ci` and `make e2e` on the release commit.
  - Push and deploy under Paul’s standing approval for gogh-xr.
  - Do a live render check of `https://gogh-xr.pardev.net`.
  - Paul does the final headset acceptance on the live URL, from the gallery through to Starry Night and back, covering every motion, locomotion mode and comfort option.
- **Verify:**
  - `docs/verification.md` holds evidence for each of SC1 through SC6, one criterion at a time.
  - The CI run for the release commit is green (`gh run watch`).
  - **The card stays open until Paul signs off.**
