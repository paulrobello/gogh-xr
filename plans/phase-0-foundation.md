# Phase 0: Foundation and Feasibility

PRD: [P0](../PRD.md#p0--foundation-and-feasibility). This phase is done when P0-A1 through P0-A6 hold. P0-A6 is the owner's headset benchmark, and it rewrites the stroke budgets that P1 uses.

## Pinned versions (scaffold these exactly)

| Package | Version | Kind |
| --- | --- | --- |
| bun (`packageManager`) | 1.4.4 | toolchain |
| three | 0.186.1 | dep |
| troika-three-text | 0.52.5 | dep (proven on r186 in mux-xr; do not take 0.53.1 without a check) |
| typescript | 7.0.2 | dev |
| vite | 8.3.5 | dev |
| @types/three | 0.186.0 | dev |
| @types/webxr | 0.5.24 | dev |
| @types/node | 26.6.4 | dev |
| @biomejs/biome | 2.5.15 | dev |
| vitest | 5.0.3 | dev |
| happy-dom | 21.0.4 | dev |
| playwright / @playwright/test | 1.63.0 | dev |
| iwer | 2.8.0 | dev (test builds only) |

Pre-commit hooks: gitleaks and `detect-private-key` from `pre-commit/pre-commit-hooks`. Use the rev baseline in `~/.claude/guides/git-ci.md`. Ports: 4252 for dev, 4253 for the e2e preview.

## Tasks

### P0.1: Scaffold repo, Makefile and gates
- **Depends on:** none.
- **Steps:**
  - Create `package.json` with the pins above, scripts mirroring mux-xr, `vite --host 0.0.0.0 --port 4252 --strictPort`, and preview on 4253.
  - Create `tsconfig.json` (strict), `biome.json`, `vite.config.ts` and `vitest.config.ts` (happy-dom).
  - Add an MIT `LICENSE`, the house `.gitignore` from `git-ci.md`, `CLAUDE.md` (gates, ports, flags, the PRD link) and `.pre-commit-config.yaml`.
  - The Makefile carries `install build test lint fmt typecheck checkall checkall-ci e2e dev dev-start dev-stop dev-restart preview pre-commit`.
    - `checkall` runs, fail-fast: `lint`, `typecheck`, `test`, `build`, `bundle-check`.
    - `checkall-ci` runs `checkall`, then `gitleaks dir . --redact --no-banner`, then `bun audit --audit-level high`, then `asset-check`.
    - `dev-stop` resolves the port holder with `lsof` at action time and polls until 4252 is free (about 2 s, SIGKILL escalation). See vault `Patterns/makefile-dev-restart-must-wait-for-port-release.md`.
  - `bundle-check` greps `dist/` for IWER symbols and fails if any are found. It is a no-op stub until P0.3.
- **Verify:**
  - `make checkall` and `make checkall-ci` exit 0. Capture the real exit code without a pipe.
  - `make dev`, then `make dev-restart`, succeeds with no "port in use" error.
  - `pre-commit run gitleaks --all-files` passes.

### P0.2: Bare XR scene, desktop preview and diagnostic flags
- **Depends on:** P0.1.
- **Steps:**
  - `src/main.ts` sets up a `WebGLRenderer` with `antialias: true` (4x MSAA projection layer) and `renderer.xr.enabled`.
  - Use one shared session request (`immersive-vr`, optional `local-floor` and `bounded-floor`, plus `medium-fixed-foveation-level`), triggered by an Enter VR button, with clear error notices.
  - On session start:
    - Call `session.updateTargetFrameRate(90)` when it is supported.
    - Record `session.supportedFrameRates` and `session.frameRate`.
    - Call `renderer.xr.setFoveation(0)`. It was 0.5 until P0.8 showed edge shimmer at 0.5 and 1.0 with no frame-time gain.
  - The desktop preview is WASD plus mouse-look on pointer lock, with a ground plane and a placeholder sky.
  - `src/diag/` parses these flags: `?seed`, `?noanim`, `?shot=<ms>` (exposes `window.__goghShot()`, which returns a PNG data URL from `preserveDrawingBuffer` in diag mode only), `?diag` (exposes `window.__goghDiag()`, which returns renderer info, the XR state, frame-rate data, the camera pose and the counts) and `?hud`.
- **Verify:**
  - `make checkall` passes.
  - Unit tests cover flag parsing and the diag payload shape.
  - Run `?diag` manually in the desktop browser.

### P0.3: Playwright GPU config and IWER harness proof
- **Depends on:** P0.2.
- **Steps:**
  - Create `playwright.config.ts` from the-cube's GPU default:
    - `channel: 'chromium'`, headless.
    - `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`.
    - `PW_GPU=swiftshader` as an opt-in.
    - `workers: '50%'`.
    - Log `UNMASKED_RENDERER_WEBGL`.
    - `webServer` runs a preview of a test build on 4253.
  - Test build mode (`vite build --mode e2e`): `?iwer` dynamically imports `iwer`, then calls `new XRDevice(metaQuest3).installRuntime()` before any WebXR code.
    - The production build tree-shakes this path out entirely, through an `import.meta.env.MODE === 'e2e'` guard.
    - `bundle-check` greps the production `dist/` for `XRDevice` and `metaQuest3` and must find nothing.
  - Add `tests/e2e/fixtures.ts`:
    - Helpers for `enterXR()`, `press(hand, button)`, `stick(hand, x, y)`, `setPose(...)` and `diag()`, driven through `page.evaluate` on the IWER device.
    - Fail the test on any `console.error`, `pageerror`, WebGL error, or three's shader compile/link log.
- **Verify:**
  - `make e2e` passes these steps:
    - Boot `?iwer&diag`.
    - Enter immersive VR.
    - Read `diag().xr.presenting === true`.
    - Press the right trigger and observe a counter in diag.
    - Assert the renderer string names the GPU, not SwiftShader.
  - `make checkall` `bundle-check` passes.
  - If IWER cannot run headless, record the finding (OQ3), then try headed mode, then fall back per PRD R-5. Document the result in `docs/decisions/0001-xr-emulation.md`.

### P0.4a: Scan vetting (no code)
- **Depends on:** none.
- **Steps:** For each of the 7 paintings, choose the Wikimedia Commons file and record:
  - the painting version;
  - the license tag on the file page (photographer tags as well as the artwork itself);
  - the source dimensions;
  - the thumbnail URL at the target width (`https://upload.wikimedia.org/wikipedia/commons/thumb/<a>/<ab>/<File>/<W>px-<File>`).

  Starting candidates, from research on 2026-11-05:
  - Starry Night: `Van Gogh - Starry Night - Google Art Project.jpg`, 44567×35291, PD.
  - The Bedroom: the 1888 Van Gogh Museum version, `Vincent van Gogh - De slaapkamer - Google Art Project.jpg`.
  - Wheatfield with Crows: `Vincent van Gogh - Wheatfield with crows - Google Art Project.jpg`.
  - Starry Night Over the Rhône: `Starry Night Over the Rhone.jpg`. Confirm that it is the Musée d'Orsay painting.
  - Café Terrace at Night: only a Yorck file was found. Check its license tag or find another file.
  - Les Alyscamps: there are several 1888 versions. Pick one with a clean license.
  - Chestnut Trees in Blossom (1890): confirm it is the "Blossoming Chestnut Trees" painting, not "Blossoming Chestnut Branches".

  Any file that fails the check is marked `placeholder`.
- **Verify:** `assets/PROVENANCE.md` has a draft table with one row per painting. Every row has a version, a license, a URL and a status.

### P0.4b: Scan fetch and derivatives
- **Depends on:** P0.1, P0.4a.
- **Steps:**
  - Create `scripts/scans/fetch.ts`. It downloads only the thumbnail URLs from `PROVENANCE.md`. Commons serves only snapped thumbnail widths, so it fetches Starry Night at 3840 px (never upscaled) and each frame painting at 1280 px, then downscales each frame locally to 1024 px on the long edge. Never fetch the 696 MB original.
    - **Ask Paul for approval before running it. List the file names, the source and the sizes.**
  - Store the fetched files under `assets/scans/` (source tier, not served).
  - Write the runtime derivatives to `public/paintings/<id>/frame.webp` only. The Starry Night 3840 px source (`assets/scans/starry-night.jpg`) is a bake input for Phase 1 and is not copied to `public/`.
  - Record the SHA-256 of every source file and every derivative.
  - `asset-check` (in `checkall-ci`) recomputes the hashes and fails on drift or on a derivative that has no provenance row.
- **Verify:**
  - `make checkall-ci` passes, including `asset-check`.
  - Mutating one byte of a derivative makes `asset-check` fail and name that file.

### P0.5: Cloudflare DNS record (no code)
- **Depends on:** none.
- **Steps:**
  - Confirm with Paul before creating the record.
  - Create a DNS-only (grey cloud) `CNAME gogh-xr.pardev.net → paulrobello.github.io` in the `pardev.net` zone. Take the token from parvault, as in `~/.claude/guides/infrastructure.md`.
- **Verify:** `dig +short gogh-xr.pardev.net CNAME` returns `paulrobello.github.io.`, and the record is not proxied.

### P0.6: GitHub repo, Pages workflow and custom domain
- **Depends on:** P0.1, P0.5, and **Paul's approval for the first push**.
- **Steps:**
  1. `gh repo create paulrobello/gogh-xr --public`. Push after approval.
  2. Add `.github/workflows/ci.yml`, which runs `make checkall` only, with no browser suite (house rule).
  3. Add `.github/workflows/pages.yml`, which builds and deploys with `actions/deploy-pages`. Pin action refs per `git-ci.md`.
  4. Set Pages `build_type=workflow`.
  5. Only after DNS is authoritative (P0.5 verified), commit `public/CNAME` containing `gogh-xr.pardev.net`.
  6. `PUT /repos/paulrobello/gogh-xr/pages` with `cname=gogh-xr.pardev.net`. Wait for the certificate, and set `https_enforced` once it is issued.
- **Verify:**
  - The workflow run is green. Check it with `gh run watch <id> --exit-status`, because the Pages `status: null` value is expected for workflow deploys.
  - A live render of `https://gogh-xr.pardev.net/?diag` in a browser shows the scene, and `diag()` responds. An HTTP 200 alone does not count.
  - A certificate stuck in `authorization_pending` for more than 30 minutes triggers the remove-and-re-add rebind from the vault pattern.

### P0.7: Stroke stress benchmark scene
- **Depends on:** P0.2.
- **Steps:**
  - `?bench=<N>&mode=a2c|blend&size=<px>` fills a full sphere around the viewer with N instanced stroke quads, uniform per solid angle, so every view direction is the worst case. Each settings combination records mean, p95 and p99 once its window settles, persisted in localStorage and shown on the HUD. Use one `InstancedMesh` per 64k-instance chunk and a procedural brush alpha.
    - `a2c` uses `alphaToCoverage: true` in an opaque pass.
    - `blend` uses sorted alpha blending.
  - In XR, left stick X steps N by ±25k, the left X button toggles a2c and blend, the left Y button steps the target frame rate through `supportedFrameRates`, and the right A button steps fixed foveation through 0, 0.5 and 1.
  - The HUD shows:
    - FPS (render callbacks per second);
    - mean and p99 frame ms;
    - the target and supported frame rates;
    - N and the mode;
    - GPU ms when `EXT_disjoint_timer_query_webgl2` is present, otherwise "GPU timer: unavailable".
  - Dispose both the meshes and the geometry when N changes.
- **Verify:**
  - Unit tests cover the chunking math and the disposal calls.
  - An e2e test boots `?iwer&diag&bench=100000` and asserts the instance count in diag with no WebGL errors.

### P0.8: Headset benchmark session (owner)
- **Depends on:** P0.7. Run on the live HTTPS site (`https://gogh-xr.pardev.net/?diag&bench=<N>`), which ships the benchmark. Or run locally over `adb reverse tcp:4252 tcp:4252` (adb lives at `~/Library/Android/sdk/platform-tools/adb`) and open `http://localhost:4252` on the headset.
- **Steps:**
  - Paul runs the benchmark on the Quest 3, with OVR Metrics Tool active.
  - For each mode (a2c, blend) and each target rate (72, 90, and 120 if it is supported), step N up until frames drop. Use stroke sizes that match the near, mid and far bands.
  - Record in `docs/perf.md`:
    - the highest N that holds for each mode and rate;
    - `supportedFrameRates` (OQ1);
    - whether the timer query is available (OQ2);
    - the visual verdict on a2c vs blend (OQ4);
    - foveation artifacts at 0.5 and 1.0 (OQ5).
  - Update the visible-stroke budget table in `plans/phase-1-stroke-engine.md` from these numbers.
- **Verify:**
  - `docs/perf.md` holds the measured table with the date, the build id and the OVR screenshots.
  - The P1 budget table cites it.
  - **The card stays open until Paul signs off.**

## Phase exit
- `make checkall-ci` and `make e2e` are green.
- P0-A1 through P0-A6 have evidence in `docs/verification.md`.
- One owner-approved push and deploy has happened.
