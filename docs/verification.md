# Verification

Phase 0 acceptance criteria from [PRD.md](../PRD.md), with the evidence gathered on 2026-11-05 on branch `p0-foundation` (macOS, Apple M4 Max, Metal GPU backend).

## P0 acceptance

| ID | Criterion | Evidence | Status |
| --- | --- | --- | --- |
| P0-A1 | `make checkall`, `make checkall-ci` and `make e2e` are green on a fresh clone. `make dev`, `make dev-stop` and `make dev-restart` work on port 4252. | `make checkall-ci` exit 0 (includes checkall: lint, typecheck, 12 test files with 100 tests passing, build, bundle-check; then `gitleaks dir` and `gitleaks git` with no leaks over 34 commits, `bun audit` with no vulnerabilities, `asset-check` with 21 files verified). `make e2e E2E_PORT=4283` exit 0, 4 of 4 Playwright tests passed. Fresh clone (2026-11-05, `git clone` of 0424b5f into /tmp, then `make install`): `make checkall-ci` exit 0 (100 tests), `make e2e E2E_PORT=4293` exit 0 (4 of 4). Dev half: `make dev` answered HTTP 200 on 4252, `make dev-stop` printed "Stopped; port 4252 is free." and `lsof` showed no listener, `make dev-restart` answered HTTP 200 again. | Met |
| P0-A2 | The e2e suite boots IWER `metaQuest3`, enters an immersive session, presses a controller trigger, and reads `__goghDiag()`. The production bundle contains no IWER code, checked by a bundle grep in `checkall`. | `tests/e2e/harness.spec.ts` "IWER Quest 3 enters immersive VR and reports a right-trigger press" passed in the e2e run (renderer `ANGLE Metal Renderer: Apple M4 Max`). `bundle-check` printed "dist/ contains no IWER code" inside `make checkall-ci`. | Verified |
| P0-A3 | The desktop preview walks a ground plane with WASD and mouse. | Unit coverage in `tests/walk.test.ts` and `tests/controls.test.ts` passed within the 100 tests. The e2e `setPose` test moves the camera. No interactive desktop session was run in this round. Since P3.2, WASD walking runs through locomotion: `tests/locomotion*.test.ts` and `tests/e2e/locomotion.spec.ts` cover it, and `tests/walk.test.ts` covers mouse look only. | Verified by unit tests, interactive check not run |
| P0-A4 | `assets/PROVENANCE.md` lists all 7 scans with file name, URL, license, painting version and SHA-256. Committed runtime derivatives are a 1024 px `frame.webp` per painting. The Starry Night bake input is the 3840 px source scan in `assets/scans/`, which is never served. A frame that fails vetting is recorded as a placeholder. | `bun scripts/asset-check.ts` printed "asset-check: 21 files verified" and passed inside `make checkall-ci`. It recomputes every hash, requires a row for each painting scan and frame, and now fails on any file under `assets/` or `public/paintings/` that has no row. | Verified |
| P0-A5 | The live site at `https://gogh-xr.pardev.net` renders the bare scene in a browser, verified by a live render, not an HTTP 200. | 2026-11-05, deploy of 342252d (Pages run 42138613476 green, CI run 42138613489 green). In a browser, `https://gogh-xr.pardev.net/?diag` rendered the bare scene (night sky, ground grid, "VR not available" notice). `__goghDiag()` returned build 0.1.0, 181 frames, 2 draw calls on ANGLE Metal. No console errors, and `__goghIwer` is undefined in production. HTTPS certificate approved and enforced. | Met |
| P0-A6 | Headset check. The owner runs the benchmark on the Quest 3. `docs/perf.md` records the measured stroke counts at which 72, 90 and 120 Hz hold, `supportedFrameRates`, timer-query availability, and alpha-to-coverage vs blended cost. The P1 budgets are updated from these numbers. | Run by Paul on 2026-11-05 at fd7a1ab and 7a4de62. `docs/perf.md` records full-sphere counts at 72, 80, 90 and 120 Hz for both modes, `supportedFrameRates` [72, 80, 90, 120], the GPU timer as unavailable, the a2c vs blend cost and look, and foveation. The P1 budget table in `plans/phase-1-stroke-engine.md` is updated from them. One data point remains unmeasured and is listed in `perf.md`. Paul signed off on 2026-11-05. | Met |

## P1 acceptance

Evidence for the Phase 1 criteria from [PRD.md](../PRD.md), gathered on branch `p1-stroke-engine` (macOS, Apple M4 Max, Metal GPU backend).

| ID | Criterion | Evidence | Status |
| --- | --- | --- | --- |
| P1-A2 | A test canvas (the scan on a plane, painted in strokes) is recognizably the painting in the desktop preview, captured with `?shot`. | 2026-11-05, commit bd3bb84, production build served by `vite preview`. Captured `/?diag&shot&demo=canvas&noanim&seed=1` at 1600 × 1200 with `bun scripts/capture-shot.ts <url> docs/shots/p1-canvas.png --wait canvas` (headless Chromium, ANGLE Metal). The canvas holds 200,359 strokes in 56 chunks, all near band and all visible. On the M4 Max the build took 169 ms: 80 ms decode, 57 ms placement, 32 ms batch, with the 176 ms brush atlas counted separately. Quest CPU time is not measured yet. A second capture with no `?seed` was byte-identical. For the comparison, the canvas region of the shot (pixels (128, 67) to (1472, 1133), from the camera and canvas geometry) and the scan (inset 12 px at the sides and 4 px at top and bottom, matching the colour sampling) were both downscaled with Lanczos to 256 px wide. The mean absolute RGB difference is 7.8 of 255, and mean lightness matches (92.0 vs 92.3). These figures came from a one-off comparison script that is not in the repo. Shots and comparison are below. Paul reviewed the shot against the scan and signed off on 2026-11-06. | Met |

### P1-A2 shot

| `?demo=canvas` shot, seed 1 | Scan reference (`frame.webp`) |
| --- | --- |
| ![Test canvas painted in strokes](shots/p1-canvas.png) | ![Starry Night scan](shots/p1-canvas-scan.webp) |

Detail at 100%: ![Moon and stars detail](shots/p1-canvas-detail.png)

At a glance the shot is the painting. The swirls follow the flow field, including the large central double swirl. The stars and the crescent moon read as concentric rings of short strokes. The cypress reads as dark vertical flames, and the village keeps the church spire, the lit windows and the roof lines. Colour and value match the scan closely, because each stroke averages three samples of the scan along its own length.

Several things do not read as the painting.
- The strokes are finer and more uniform than Van Gogh's. A visible stroke fragment is about 1–3 cm on a 4 m canvas, so up close the sky reads as a mosaic of short dabs, not his long continuous ribbons. Longer sky strokes were tried (7 spacings instead of 5.2). They looked more painterly but blurred the dark swirl outlines, and the sky's difference from the scan rose from 9.5 to 12.1, so they were rejected.
- Heavy overlap hides most of each stroke. The painted area per stroke is about 5× its grid cell where the flow is flat and up to 12× in coherent swirls. As a result, the brush shapes show mainly as stroke ends.
- The canvas edge is ragged within about one stroke spacing (9 mm), because strokes centre on the canvas.

## P2 acceptance

Evidence for the Phase 2 criteria from [PRD.md](../PRD.md), gathered on branch `worktree-p2-starry-night` (macOS, Apple M4 Max, Metal GPU backend).

| ID | Criterion | Evidence | Status |
| --- | --- | --- | --- |
| P2-A1 | Generators are deterministic for a given seed (unit snapshot of vertex and stroke counts and bounds). | 2026-11-06, commit 4768e33. `tests/world-starry-night.test.ts` pins the seed-1 world as literals, over the real `CanvasSource` (frame.webp, regions.png and flow.png decoded with sharp). Generators: vertex and triangle counts and axis-aligned bounds rounded to 1 mm for the terrain (16,384 vertices, 32,258 triangles), ridge, houses, roofs, windows, church, cypress and sky dome. Scatter: the `scatterWorld` total (535,011), the per-layer counts and its `hashStrokeBuffers` (`9724bad8`, then `480f43d7`: SCATTER_VERSION 3 sets the lit-window depth flag in the spare meta byte, with the counts unchanged; then `51173374`: SCATTER_VERSION 6, see [Shared lift share](#shared-lift-share-walking-reorder); now `5b9be613`: SCATTER_VERSION 7 adds the village colours, see [Village house colours](#village-house-colours)). Haze: 30,000 strokes, hash `49bf0339`. Both tests pass inside `make checkall`. A scatter pin change requires a `SCATTER_VERSION` bump. A generator pin change does not, because the cache key carries the build SHA. | Met |
| P2-A2 | The painter's spot screenshot (`?shot`, `?noanim`, fixed seed) is compared to the reference scan with the downscaled perceptual metric defined in the P2 plan, and its threshold is set and recorded here. | 2026-11-06, commit bf9d9a9, production build served by `vite preview`. URL `/?painting=starry-night&diag&shot&noanim&seed=1&painter` (`?painter` puts the desktop camera on the painter camera, so the frame is exactly canvas uv [0, 1]²). Captured at 1280 × 1014 (the canvas aspect) with `bun scripts/fidelity.ts --url "<url>" --capture docs/shots/p2-painter-spot.png`, which runs `scripts/capture-shot.ts --size 1280x1014 --wait world` (headless Chromium, ANGLE Metal). Metric (`scripts/fidelity-lib.ts`): the scan `assets/scans/starry-night.jpg` is inset past its mat by the colour-sampling inset (45 px at the sides, 15 px at top and bottom), and both images go to 256 × 203 with sharp Lanczos in sRGB. SSIM is Wang et al. 2004 on Rec. 709 luma of the gamma-encoded sRGB values (11 × 11 Gaussian, σ 1.5, K1 0.01, K2 0.03, L 255, valid windows). ΔE is the mean CIEDE2000 over 16 × 12 block-mean colours averaged in linear light, CIELAB under D65. Measured **SSIM 0.2943** and **mean ΔE2000 5.6961**. The e2e build gives the same values to 4 decimals. The worst blocks (column, row from the top-left) are (14, 2) 51.4, (11, 11) 43.2, (15, 2) 35.3, (14, 1) 33.5 and (5, 6) 30.9: the moon three times, one near lit window, and the large star left of the swirl. Margin rule: the measured values are rounded to 4 decimals, then SSIM threshold = measured − 0.03 and ΔE threshold = measured + 1.5, giving **SSIM ≥ 0.2643** and **mean ΔE2000 ≤ 7.1961**. They are the exported constants `SSIM_THRESHOLD` and `DELTA_E_THRESHOLD`, and `tests/e2e/fidelity.spec.ts` asserts both. Determinism: a second capture was byte-identical (SHA-256 `960a0b8e…ba57`). A framing check found the capture's best shift against the scan at (0, 0) of a ±3 px search at 64 px wide. The thresholds are Paul accepted them on 2026-11-06 as the regression floor. He judges the look itself in the headset at P2.9 (P2-A4). | Met |
| P2-A3 | Every world surface is stroke-covered, with no bare mesh visible from any point inside the boundary, checked by an e2e sweep of sample poses that counts background-colour pixels. | `tests/e2e/world-coverage.spec.ts` renders 24 poses with `?painting=starry-night&noanim&seed=1&shot&coverage` at 1280 × 720 and fails a pose over 0.5% bare. Maximum binary bare share 0.442% at hill west. The sweep renders through the 70° vertical desktop camera, which is narrower than the Quest 3's roughly 96° vertical view, so the edges of a headset view are not checked here. Widening the sweep is deferred, and the gap is recorded here. The coverage-weighted share, which also counts MSAA rims, peaks at 0.591% at hill west and is logged as telemetry only (ruling P21). The same figures came out of the P2.8 `make e2e` run on 2026-11-06. | Met |

### P2-A2 shot

Scan, capture and ΔE heat map (black 0, red 10, yellow 20 and above), each at 256 × 203 shown at 2×:

![Scan, painter-spot capture and ΔE heat map](shots/p2-fidelity.png)

Full capture: ![Painter-spot capture, seed 1](shots/p2-painter-spot.png)

SSIM is low because the comparison is luma structure at 256 px, where the scan's fine brushwork and the world's 1.8× strokes differ in texture everywhere. The threshold therefore catches gross breakage, such as lost framing, a missing cypress or a blank region, not subtle drift. The block ΔE carries the colour match. Visible gaps in this render, none of them tuned for P2.8:
- The stars and the moon are absent. Their rings are P4.3, so `world.counts` shows `star` and `moon` at 0, and the metric can only improve when they land.
- The distant ridge band on the right (v_down 0.50–0.72) reads as sky strokes, so blocks (15, 6) and (15, 7) are hot.
- The village houses are not legible as houses, and the church reads as a pale ghost.
- One near lit window reads as a large cream blob at the bottom, block (11, 11).

## Stroke flicker

Paul saw strokes behind the front layer strobe in the headset on 2026-11-06 (build ce29161). Head-tracking noise moves the eye about 0.1 mm a frame, and that swapped which of two overlapping strokes won the depth test. The fixes landed on 2026-11-06:
- Commit 934cf30 raises the camera near plane from 0.05 m to 0.1 m (`src/main.ts`). XR inherits it as `depthNear`.
- Commit 38a1f23 adds a depth tie-break in the stroke vertex shader (`src/render/strokes/depth-tie-break.ts`). Each stroke moves towards the eye by a stable per-instance hash share of 2048 depth steps (2^-23 in NDC z each), capped in metres of view depth. Only `gl_Position.z` changes, so early-z holds and no stroke moves on screen. Lit windows carry a flag in the spare meta byte and take the whole range, so almost every wall stroke stays behind them.
- Commit c538925 lowers the cap from 1.5 m to 0.5 m, and uses the step term alone for vertices behind the eye (clip w ≤ 0), where the cap's 1 / w is unbounded.
- Ruling Q21 then sets the cap to 0.25 m.

The probe is `bun scripts/zfight-probe.ts <base-url>`. It captures its poses at the painter's spot (four at first, eight now) with `?painting=starry-night&diag&shot&nogov&nocache` at 1280 × 1014, then captures each pose again unmoved, shifted 0.1 mm and shifted 1 mm along x. It reports the share of pixels whose summed RGB change exceeds 24 (`scripts/zfight-lib.ts`), per screen third. The runs used headless Chromium on ANGLE Metal (Apple M4 Max) against `make dev`. The unmoved capture changed 0.000% at every pose in every run, so the render is deterministic. The before row matches the deployed ce29161 exactly.

A shift that small still flips single pixels on stroke edges by parallax, because one MSAA sample's alpha-to-coverage bit changes. That floor was measured with a diagnostic build that removes the depth fight: near 1.0 m and a 0.5 lift jitter (SCATTER_DEPTH_JITTER), neither of them shippable. It grows linearly with the shift and ignores both settings. Acceptance counts the flips above that floor.

Share of pixels changed after a 0.1 mm shift, top / mid / bottom third (%):

| Build | painter-level (yaw 0, pitch 0) | painter-down (pitch -0.25) | village-look (yaw 0.6, pitch -0.1) | back (yaw π, pitch -0.1) |
| --- | --- | --- | --- | --- |
| Before: near 0.05 | 0.080 / 0.377 / 0.748 | 0.119 / 0.741 / 0.666 | 1.482 / 2.276 / 1.747 | 0.113 / 0.509 / 0.615 |
| Near 0.1 alone | 0.064 / 0.304 / 0.620 | 0.114 / 0.641 / 0.607 | 0.804 / 1.319 / 1.143 | 0.115 / 0.505 / 0.510 |
| After: near 0.1 and tie-break, 0.25 m cap | 0.039 / 0.100 / 0.258 | 0.054 / 0.194 / 0.582 | 0.247 / 0.406 / 0.661 | 0.058 / 0.209 / 0.444 |
| Parallax floor (diagnostic) | 0.039 / 0.080 / 0.260 | 0.053 / 0.147 / 0.529 | 0.048 / 0.094 / 0.461 | 0.031 / 0.052 / 0.346 |

Share after a 1 mm shift, same layout (%):

| Build | painter-level | painter-down | village-look | back |
| --- | --- | --- | --- | --- |
| Before: near 0.05 | 0.477 / 1.306 / 3.131 | 0.624 / 2.637 / 5.326 | 1.683 / 3.255 / 5.430 | 0.585 / 1.605 / 3.594 |
| Near 0.1 alone | 0.472 / 0.947 / 2.509 | 0.629 / 1.960 / 5.194 | 1.137 / 2.028 / 4.804 | 0.584 / 1.125 / 3.421 |
| After: near 0.1 and tie-break, 0.25 m cap | 0.396 / 0.711 / 2.070 | 0.450 / 1.377 / 5.050 | 0.574 / 0.976 / 4.187 | 0.373 / 0.750 / 3.292 |
| Parallax floor (diagnostic) | 0.375 / 0.705 / 2.412 | 0.476 / 1.314 / 5.115 | 0.375 / 0.691 / 4.202 | 0.259 / 0.432 / 3.186 |

Drop in the 0.1 mm flips above the floor, (before − floor) / (build − floor), top / mid. The target is at least 5× at the first three poses and 2.5× at back (ruling Q21; it was 3× at back before). "Floor" means the build reads at or below the floor.

| Build | painter-level | painter-down | village-look | back |
| --- | --- | --- | --- | --- |
| Near 0.1 alone | 1.6× / 1.3× | 1.1× / 1.2× | 1.9× / 1.8× | 1.0× / 1.0× |
| Tie-break, 0.1 m cap | 4.6× / 6.8× | floor / 5.3× | 3.3× / 5.4× | 2.6× / 1.6× |
| After: tie-break, 0.25 m cap | floor / 14.8× | 66× / 12.6× | 7.2× / 7.0× | 3.0× / 2.9× |
| Tie-break, 0.5 m cap (c538925) | 41× / 16.5× | floor / 12.9× | 11.4× / 7.4× | 3.9× / 5.0× |
| Tie-break, 1.5 m cap (38a1f23) | floor / 27.0× | floor / 12.9× | 31.9× / 14.1× | 11.7× / 6.3× |

The near plane alone barely moves the 0.1 mm flips. When the head moves less than one depth step, the flip rate depends only on how far apart the overlapping strokes sit, not on the step. Near 0.1 does cut the 1 mm flips, where the head moves more than a step.

Tie-break range: 1024 steps missed painter-down top (0.073% against a limit of 0.066%), and 2048 cleared every cell. The range is about 1.22e-3·d² m at view depth d, so the 0.25 m cap binds beyond 14 m.

Trade-off: two separate surfaces closer than the cap can trade places, so the cap bounds the reorder. 0.25 m does not exceed the 0.25 m roof overhang or the 0.3 m `OUTLINE_GAP` between neighbouring roofs. In far views, eaves, walls and roof edges still trade places along thin lines where they meet. A surface-id render of the village from 30 m up (pose 0, 30, -10, pitch -0.6) counts the bottom-third pixels whose surface changes against no tie-break: 0.18% at a 0.1 m cap, 0.41% at 0.25 m, 0.78% at 0.5 m and 1.78% at 1.5 m. At 0.25 m, the shipped cap, they are 1 to 3 px lines at the eaves and the wall bases. At 0.5 m those lines are about twice as thick, and at 1.5 m they spread into blobs. A finer id that also splits roofs and walls by facing (16 sectors) gives 0.19%, 0.47% and 0.86% at 0.1, 0.25 and 0.5 m, with no new swaps where differently facing roofs meet. Neighbouring roofs that face the same way share an id there, so a roof-to-roof swap between them is not measured. Ruling Q21 chose 0.25 m over 0.5 m. Its back mid reads 2.9×, short of the earlier 3× target, and that shortfall is within the hash-choice noise. The 0.5 m cap would double the swaps. `tests/strokes-depth-tie-break.test.ts` checks that the cap does not exceed the roof overhang or the roof gap, and checks that the range at the sky dome stays inside the gap to the ridge's farthest reach.

Village from 30 m up, bottom of the frame at half size. Top row: no tie-break, then the 0.25 m cap. Middle row: the surface-id render, then the pixels whose surface changes at 0.25 m. Bottom row: the same mask at 0.5 m, then at 1.5 m.

![Far-village surface swaps by cap](shots/stroke-flicker-silhouette.png)

The coverage and fidelity gates stayed green with their thresholds unchanged. Before is the P2.8 record, and after is the 0.25 m cap:

| Gate | Before | After |
| --- | --- | --- |
| `world-coverage.spec.ts` max bare share (limit 0.5%) | 0.442% at hill west (weighted 0.591%) | 0.440% at hill west (weighted 0.590%) |
| `fidelity.spec.ts` SSIM (limit ≥ 0.2643) | 0.2943 | 0.2967 |
| `fidelity.spec.ts` mean ΔE2000 (limit ≤ 7.1961) | 5.6961 | 5.7021 |
| Near lit window, block (11, 11) ΔE | 43.17 | 42.61 |

The lit windows stay intact in the painter view and up close at the cypress base. In the painter view the church reads slightly paler and more defined, because its overlapping strokes now resolve in a fixed order.


### Sky dome strokes

Paul still saw the outermost sky strokes strobe in the headset on build e018c2f. At the dome's 120 m one window-depth step is about 8.6 mm, so the 0.25 m cap spans only about 29 steps. Dome strokes are about 7 m long, lie tangent to a curved dome and overlap heavily, so they still traded places.

The fix (`src/render/strokes/backdrop-depth.ts`) orders dome strokes by a stable per-instance rank instead of by geometric depth:
- The scatter sets `DEPTH_BACKDROP_FLAG` (bit 1 of the spare meta byte, counted from 0, value 2) on strokes from a surface with `userData.backdrop`, which only the sky dome carries (`src/world/sky.ts`). The boundary haze, `?demo=canvas` and `?strokesTest` also use stroke layer 0 (`STROKE_LAYER.sky`), so the flag selects the dome, not the layer. The ridge is layer `terrain`, region hills, so it uses `STROKE_LAYER.ground` and never gets the flag. Haze keeps its normal depth and the tie-break.
- The vertex shader writes clip z = w × (1 − (16 + 4·rank) · 2^-23) for a flagged stroke. The rank is the top 10 bits of the stroke's position hash, so 1024 ranks 4 steps apart sit between 16 and 4108 steps in front of the far plane. Each quad is flat in depth, so two overlapping dome strokes keep one order whatever the eye does. The 4-step spacing exceeds the GPU's rounding of z / w near 1.
- Stars and moon (layers 1 and 2) get a reserved front tier: the next 256 ranks, nearer than every dome rank. Since the moon and stars landed (see Moon and stars below), the shader takes a flagged star or moon stroke's rank from the top 8 bits of the hash (`h >> 24`) and then offsets it by 1024. Offsetting the dome's 10-bit rank instead would reach rank 2047. That rank still sits behind the 168.7 m world reach the budget test asserts, at about 169.8 m, but ranks 1280-2047 fall outside the 256-rank front tier the test checks, and the real margin shrinks from about 78 m to about 1 m.
- About 284k dome strokes share the 1024 ranks, about 277 per rank. Two overlapping strokes of the same rank sit at the same NDC z, so the GPU's rounding can still flip them under head motion. This residual is inherent: about 2060 ranks fit in front of the 169 m world reach, and the front tier takes 256 of them. The headset check should look for it.
- The nearest reserved rank is at 246 m of view depth at near 0.1 and far 1000. The farthest non-dome surface, seen from anywhere inside the boundary, is 169 m away, so every backdrop stroke draws behind the whole world. `tests/strokes-backdrop-depth.test.ts` checks this budget. A change to the camera's far plane in `src/main.ts` needs that test rerun.
- The dome has no base mesh any more (`base-meshes.ts`). At its true depth it would cover the far-end strokes, and the clear colour is already the dome's under-paint, or magenta in the debug paint.
- SCATTER_VERSION 4. Only the scatter hash changed (`bb6f674f`); every count is the same.

The probe gained three sky-heavy poses at the painter's eye: pitch +0.5, pitch +1.0, and a horizon pose toward the ridge (yaw −0.7, pitch +0.05). Before is e018c2f and after is the backdrop rank, both production builds served by `vite preview` and probed back to back on the same host. The first four poses match the earlier "After" row exactly, so the render is deterministic.

Share of pixels changed after a 0.1 mm shift, top / mid / bottom third (%):

| Pose | Before (e018c2f) | After (backdrop rank) |
| --- | --- | --- |
| painter-level | 0.039 / 0.100 / 0.258 | 0.037 / 0.098 / 0.258 |
| painter-down | 0.054 / 0.194 / 0.582 | 0.051 / 0.194 / 0.582 |
| village-look | 0.247 / 0.406 / 0.661 | 0.050 / 0.337 / 0.661 |
| back | 0.058 / 0.209 / 0.444 | 0.046 / 0.209 / 0.444 |
| sky-up-0.5 (pitch +0.5) | 0.030 / 0.039 / 0.093 | 0.028 / 0.037 / 0.091 |
| sky-up-1.0 (pitch +1.0) | 0.145 / 0.048 / 0.039 | 0.028 / 0.030 / 0.037 |
| ridge-horizon (yaw −0.7, pitch +0.05) | 0.235 / 0.346 / 0.383 | 0.044 / 0.345 / 0.383 |

Share after a 1 mm shift, same layout (%):

| Pose | Before (e018c2f) | After (backdrop rank) |
| --- | --- | --- |
| painter-level | 0.396 / 0.711 / 2.070 | 0.365 / 0.710 / 2.070 |
| painter-down | 0.450 / 1.377 / 5.050 | 0.449 / 1.377 / 5.050 |
| village-look | 0.574 / 0.976 / 4.187 | 0.367 / 0.911 / 4.187 |
| back | 0.373 / 0.750 / 3.292 | 0.297 / 0.750 / 3.292 |
| sky-up-0.5 | 0.316 / 0.370 / 0.676 | 0.288 / 0.343 / 0.662 |
| sky-up-1.0 | 0.429 / 0.332 / 0.354 | 0.226 / 0.281 / 0.345 |
| ridge-horizon | 0.429 / 0.653 / 1.279 | 0.207 / 0.653 / 1.279 |

The sky thirds drop to the parallax floor: village-look top reads 0.050%, against the 0.048% floor measured above, and ridge-horizon top drops 5.3×. The sky's flips now grow linearly with the shift (sky-up-1.0: 0.032% at 0.1 mm, 0.284% at 1 mm over the frame), the signature of edge parallax.

A second measure separates depth fights from edge flips: the share of the frame whose flipped pixel has at least 4 of its 8 neighbours flipped too. A depth fight flips a patch, and a parallax flip a 1 px line. After a 0.1 mm shift (% of the frame):

| Pose | Before | After |
| --- | --- | --- |
| sky-up-1.0 | 0.0206 | 0.0016 |
| ridge-horizon | 0.1059 | 0.0651 |
| village-look | 0.1011 | 0.0450 |
| sky-up-0.5 | 0.0052 | 0.0052 |
| painter-level | 0.0026 | 0.0026 |

In the after build, a diagnostic build that hid the haze measured 0.0000 clustered at sky-up-1.0, so the dome itself no longer fights and the 0.0016 left there is haze. The patches left at ridge-horizon and village-look sit on the horizon band. They are the boundary haze (45-55 m) and the ridge's 3-5 m strokes at 70-110 m, both at normal depth with the 0.25 m cap. With the haze hidden, the ridge alone flickers in large patches (0.63% clustered at ridge-horizon), which the haze mostly covers in the normal view. This is not fixed here.

The coverage and fidelity gates stayed green with their thresholds unchanged:

| Gate | Before (0.25 m cap) | After (backdrop rank) |
| --- | --- | --- |
| `world-coverage.spec.ts` max bare share (limit 0.5%) | 0.440% at hill west (weighted 0.590%) | 0.440% at hill west (weighted 0.590%) |
| `fidelity.spec.ts` SSIM (limit ≥ 0.2643) | 0.2967 | 0.2970 |
| `fidelity.spec.ts` mean ΔE2000 (limit ≤ 7.1961) | 5.7021 | 5.7006 |

### Shared lift share (walking reorder)

On build 616f0c9 Paul saw scattered spots on buildings and ground strobe from the painter's spot, each spot stable. He read one pose over CDP: eye (0.067, 1.551, 0.0), yaw −0.571, pitch −0.26. It is now the probe's `paul-strobe1`. On fce5dab he saw "a ton of strokes changing z-positions" as he walked, at particular angles and distances.

The walking reorder comes from two random orders that disagree:
- The scatter lifts each stroke off its surface by J × length × rand(), where J is `SCATTER_DEPTH_JITTER`, 0.02. That is a world-space order. Seen from in front of a flat face, the stroke lifted more is nearer along every ray, from any view.
- The shader's tie-break is a second, independent order by position hash. It works in depth space, and its size in metres grows with the square of the view depth up to the 0.25 m cap: about 5 mm at 2 m and 30 mm at 5 m, the same size as the lift.

Where the two orders disagree for an overlapping pair, the pair's depth gap crosses zero at some view distance and angle, and past it the order flips as the viewer walks. This does not explain the per-spot strobe in the 0.1 mm probe, which the fix leaves unchanged (below).

The fix (`src/render/strokes/depth-tie-break.ts`) makes one share drive both:
- A scattered stroke carries `DEPTH_RANKED_FLAG` (meta bit 6, value 64). Bits 0 and 1 stay the front and backdrop flags, and bits 2-5 the fit level.
- Its share, in [0, 1), is `sizeShare`: a `lowbias32` hash of its quad length and width as stored in float32. The scatter writes the size exactly and the lift does not move it, so the scatter and the vertex shader compute the same share. One unit test checks the JS hash against a BigInt reference. Another reads the shader's `lowbias32` body and its share lines from `stroke.vert.glsl`, evaluates them statement by statement on fixed sizes, and asserts they equal `sizeShare`. Swapping length and width on either side fails it.
- The lift is J × graded length × share. The graded length leaves out the ±15% size jitter, which would let the lift order and the share order disagree. The shader's tie-break takes the same share of its range.
- The two orders now agree for nearly every overlapping pair, but not for all of them. The lift scales with the graded length, which grows with the distance from the painter's eye, so two overlapping neighbours with close shares can still disagree. Measured on d36f7a4 in the seed-1 world, 0.66% of overlapping ground pairs disagree, 0.18% of building pairs and 0.21% of cypress pairs, against about half of them with two independent orders.
- The lift's old `rand()` draw is kept and discarded, so the brush, flip, phase and colour draws after it stay put.
- Outlines take the size share like every other stroke. Three other designs were tried and dropped:
  - Outline shares in the upper half, [0.5, 1) (dfaf236), so a contour lies over at least half of the body strokes on its face. It raised the clustered flips at 3 of 4 poses (table below) with no visible gain in the near-wall capture, so the controller ruled it backed out: flicker is what Paul reported, and a buried outline at some untested angle gets a targeted fix if it shows up.
  - A top band of shares for outlines (0.75-1) packed overlapping outlines four times as densely in depth and raised the clustered flips at the village poses.
  - A first version with 256 ranks stored in the colour alpha piled equal-rank pairs onto one lift and a narrow bias spread. It raised the bottom-third flips at 6 of 8 poses (+0.02 to +0.09 points).
- Haze, `?demo=canvas` and `?strokesTest` may repeat a size, so they keep the position hash.
- SCATTER_VERSION 6. Every count is unchanged, and the scatter hash is `51173374`. The village colours on top make it SCATTER_VERSION 7, hash `5b9be613` ([Village house colours](#village-house-colours)).

Order stability is measured without parallax, with a fixed eye. An id build colours each stroke by layer and hash, and a temporary uniform scales the tie-break range by 1.25, which is what walking about 12% farther does to the range against the lift. This is a proxy for distance only. It does not sweep the view angle. The table gives the share of the frame whose owning stroke changes. The after column is d36f7a4, whose scatter and shader the final build matches (same scatter hash).

| Pose | Before (fce5dab) | After (d36f7a4) |
| --- | --- | --- |
| painter-level | 3.234% | 1.817% |
| painter-down | 4.732% | 1.944% |
| village-look | 4.192% | 2.304% |
| back | 5.580% | 2.515% |
| ridge-horizon | 3.066% | 1.558% |
| paul-strobe1 | 4.887% | 1.813% |

The whole-stroke reorders on the near ground and the walls are gone. What is left:
- thin lines where tilted terrain strokes cross, since each takes its interpolated normal;
- the cypress;
- the haze, which is unranked.

In the figure, the top row is `paul-strobe1` and the bottom row `village-look`, before on the left and after on the right. Yellow marks a changed owner.

![Owner changes when the tie-break range scales by 1.25](shots/stroke-order-walk.png)

The distance bands (`bands.ts`) cannot cause these reorders. The test holds the eye still under `?nogov`, so no chunk changes band or density, and scaling the tie-break range alone reproduces them. A band still resizes every stroke of a chunk at once when the chunk crosses 6 m or 25 m (0.5 m hysteresis), and the governor resizes and thins chunks in the headset. Neither was measured here.

Clustered is the share of the frame whose flipped pixel has at least 4 of its 8 neighbours flipped, after a 0.1 mm shift (%). The final build reads the same as d36f7a4 at every pose:

| Pose | fce5dab | Upper-half outlines (dfaf236, backed out) | Final |
| --- | --- | --- | --- |
| paul-strobe1 | 0.076 | 0.100 | 0.085 |
| village-look | 0.049 | 0.059 | 0.047 |
| painter-level | 0.008 | 0.003 | 0.005 |
| ridge-horizon | 0.066 | 0.078 | 0.064 |

A near-wall capture shows house 11 from 6 m (eye (9.04, −3.27, −30.74), yaw −0.286, pitch 0.25): fce5dab on the left, the final build in the middle and the backed-out upper-half outlines on the right. In all three, the contour strokes along the corners and the roof line lie over the wall strokes, so this view shows no buried outline with or without the upper-half share.

![House 11 from 6 m: fce5dab, final, and the backed-out upper-half outlines](shots/stroke-outline-near-wall.png)

The 0.1 mm probe covers 8 poses, using production builds served by `vite preview` and probed back to back. Every unmoved capture changed 0.000%. The after column is the final build, which reads the same as d36f7a4 at every pose.

| Pose | Before (fce5dab), all (top / mid / bottom) | After, all (top / mid / bottom) | Parallax floor estimate, all |
| --- | --- | --- | --- |
| painter-level | 0.142 (0.043 / 0.128 / 0.257) | 0.125 (0.043 / 0.095 / 0.238) | 0.139 |
| painter-down | 0.283 (0.053 / 0.226 / 0.570) | 0.285 (0.051 / 0.220 / 0.584) | 0.256 |
| village-look | 0.357 (0.076 / 0.352 / 0.645) | 0.351 (0.076 / 0.309 / 0.667) | 0.215 |
| back | 0.238 (0.060 / 0.258 / 0.397) | 0.249 (0.068 / 0.269 / 0.409) | 0.155 |
| sky-up-0.5 | 0.052 (0.036 / 0.035 / 0.085) | 0.061 (0.036 / 0.039 / 0.109) | 0.053 |
| sky-up-1.0 | 0.037 (0.041 / 0.034 / 0.037) | 0.038 (0.040 / 0.035 / 0.039) | 0.036 |
| ridge-horizon | 0.268 (0.067 / 0.342 / 0.396) | 0.260 (0.070 / 0.349 / 0.361) | 0.102 |
| paul-strobe1 | 0.467 (0.165 / 0.482 / 0.754) | 0.449 (0.180 / 0.442 / 0.724) | 0.267 |

The share after a 1 mm shift, over the whole frame, in the table's pose order (%):
- before: 1.089, 2.342, 1.865, 1.472, 0.446, 0.305, 0.773, 2.434;
- after: 1.031, 2.356, 1.872, 1.467, 0.443, 0.310, 0.806, 2.376.

This fix leaves the 0.1 mm fixed-spot strobe unchanged. Per pose the whole frame moved between −0.018 and +0.011 points, and the eight totals sum 0.026 points lower than before. Single cells moved more:
- `village-look` mid fell 0.043 points and its bottom rose 0.022, `paul-strobe1` mid fell 0.040 and `painter-level` mid 0.033.
- The bottom third rose at 5 of 8 poses, by 0.002 to 0.024 points, and fell at `painter-level`, `ridge-horizon` and `paul-strobe1`. With the backed-out upper-half outlines it rose at 6 of 8, by up to 0.065.

The floor column is an estimate, not a lower bound. It comes from a diagnostic build with near 1.0 m and lift jitter 0.5, on the earlier 256-rank tree, and that build changes the depth precision and the scene as well as removing depth fights. `painter-level` reads 0.125% after, below its 0.139% floor estimate. So the column does not show whether a depth fix could bring `paul-strobe1` (0.449%) or `village-look` (0.351%) to the ≤ 0.2% goal, and neither pose reaches it.

What the fixed-spot flicker is made of, from id builds of fce5dab and of the 256-rank version:
- The id builds classify the flipped pixels at `paul-strobe1`, `village-look` and `ridge-horizon`. Over 93% are stroke against stroke within one layer. Ground leads at every pose, and the second layer is walls and roofs or the cypress, depending on the pose (cypress is 30% at `village-look` on fce5dab). Haze is a few percent.
- Each of these is under 1%: strokes against a base mesh (a `?coverage` id run of the before build), window against wall, and every other cross-layer pair.
- Past about 14 m the 0.25 m cap binds, so the tie-break spans 0.25 m / step(d) steps: about 1,000 at 20 m and 470 at 30 m. Two overlapping strokes whose shares fall within the GPU's 1-2 steps of rounding still fight. A larger range there needs a larger cap, which ruling Q21 rejected.

The gates stayed green with their thresholds unchanged:

| Gate | The overhang record | Before (fce5dab) | After (final) |
| --- | --- | --- | --- |
| `world-coverage.spec.ts` max bare share (limit 0.5%) | 0.459% at village uphill | not measured | 0.451% at hill west (weighted 0.605%) |
| `fidelity.spec.ts` SSIM (limit ≥ 0.2643) | 0.2963 | 0.3202 | 0.3196 |
| `fidelity.spec.ts` mean ΔE2000 (limit ≤ 7.1961) | 5.7457 | 5.7934 | 5.7553 |
| Near lit window, block (11, 11) ΔE | 42.61 (e018c2f) | 37.25 | 37.32 |

The SSIM rise of 0.023 over the overhang record predates this fix. The same capture (`scripts/fidelity.ts --url` with `?painting=starry-night&diag&shot&noanim&seed=1&painter`) reads 0.3202 on fce5dab, so the rise came in with the commits between the overhang record and fce5dab, which were not traced here. This fix moves SSIM by −0.0006. Diagnostic builds of the dfaf236 tree (with the backed-out upper-half outlines), each restoring one layer's old lift (J × length × rand()) and position-hash tie-break, attribute the change:

| Build | SSIM |
| --- | --- |
| fce5dab | 0.3202 |
| Final (same as d36f7a4) | 0.3196 |
| dfaf236 | 0.3191 |
| dfaf236, every layer reverted | 0.3202 |
| dfaf236, ground reverted | 0.3186 |
| dfaf236, buildings and outlines reverted | 0.3209 |
| dfaf236, cypress reverted | 0.3180 |
| dfaf236, sky reverted | 0.3197 |

Reverting every layer gives exactly fce5dab's 0.3202, so the diagnostic reproduces the old order. No single layer moves SSIM by more than 0.002. The buildings and outlines lower it most (0.0018), and the cypress and ground raise it (0.0011 and 0.0005).

The figure crops the painter capture to the band from the ridge to the village (rows 520-820 of 1280 × 1014), fce5dab on top and the final build below. Stroke layout and orientation match, and no upright strokes vanished. An earlier note said fewer strokes stood upright there after the fix. It came from captures taken without `&noanim`, which differ in animation time, and it is withdrawn.

![Ridge-to-village band, fce5dab top and final bottom](shots/stroke-order-band.png)

## Village stroke overhang

Paul saw strokes hang past the house and church edges into the sky on build e018c2f. The scatter placed every stroke at a point on its triangle and drew its whole quad, so a stroke near a face edge stuck out by up to its own width.


### What changed

`src/render/strokes/face-clamp.ts` fits the strokes of the `building`, `roof`, `window` and `church` layers (`FACE_CLAMPED_LAYERS` in `scatter.ts`) into their host face, and the walls, roofs and church get a row of outline strokes. Terrain, cypress, sky and haze strokes are unchanged, bit for bit.
- A face is the set of coplanar triangles joined by shared edges, held as its convex hull. A quad's diagonal and a gable end's eave line never clip a stroke. On the seed-1 village, 448 triangles form 205 faces, all convex.
- What is fitted is the stroke's painted footprint, not its quad. Brush masks span only 50-94% of their quad (`BRUSH_FOOTPRINT`, the largest box measured over atlas seeds 1-12). Fitting the whole quad held the paint a quarter of a stroke inside every edge.
- The clamp: move across by the overhang, or narrow to the face where it is narrower than the stroke. Then slide along the stroke's axis if the face has room for its length, otherwise shrink to the room. The footprint may reach past the face by 10% of its own width. A bevel half-plane at each hull vertex keeps the Euclidean overhang within that margin beside sharp corners.
- Edge alignment (`fitStrokeToFace`): a stroke whose clamped footprint still reaches past a side is turned to run along that side, keeping the way it points. Its scattered centre moves in until its outer long side sits at the edge plus the margin, and it is clamped again at its original size. Between sides it reaches past by as much, it takes the one it already runs most nearly along. The brush's rounded ends then lie along the edge instead of across it.
- Outline pass (`placeOutlines` in `scatter.ts`): every side of every wall, roof and church face gets a row of strokes laid along it and fitted flush inside it the same way, from their own rand stream. There is one per 0.8 of the graded stroke length, thinned evenly so the rows total at most 5% of the face-clamped strokes (`OUTLINE_SHARE`). They use the ridge and bristle brushes, the canvas colour at the edge darkened to 75% (`OUTLINE_DARKEN`), and a lift and tie-break share from their quad size like every other stroke (`sizeShare`, see Shared lift share). Van Gogh draws the village in dark contours, and the row covers the rim the rounded brush ends leave bare. Seed 1 gets 3,105 outline strokes, 3.7% of the 84,264 face-clamped strokes (budget 4,213).
- The shader scales strokes by the distance-band factor (1.05 mid, 1.6 far, more under the governor). The scatter stores the largest factor that still fits as a 4-bit fit level in the spare meta byte, bits 2-5 counted from 0 (mask 60), above the tie-break flag (bit 0, value 1) and the backdrop flag (bit 1, value 2), and the vertex shader caps the factor there. Level k caps at 1 + (k - 1)/16, so the cap tops out at 1.875.
- SCATTER_VERSION 5. The face-clamped strokes keep their count and their triangle, because their rand stream is unchanged. The world gains the 3,105 outline strokes: 538,116 strokes in all, 87,369 in stroke layer `building`, and the scatter hash is `177391e4`.

`tests/world-starry-night.test.ts` measures the overhang on the seed-1 world without the scatter's face grouping. Each stroke is matched to the coplanar village triangles that hold its centre: a window stroke to the panes only, since the wall 2 cm behind a pane would otherwise absorb a stroke spilling past it, and every other stroke to the rest only. The test measures its paint box from the default-seed atlas, at the near, mid and far band factors capped by its fit level, and at the fit cap itself, the largest factor the governor can grow it to (1.875 for an unfitted stroke). Overhang is the furthest corner's distance outside those triangles, as a share of the stroke's footprint width (the `BRUSH_FOOTPRINT` table width, which bounds the measured paint by up to 1.22 times):

| Seed-1 village strokes | Before (c982599, 84,264) | After (87,369, outlines included) |
| --- | --- | --- |
| Over 10% of their footprint width, near / mid / far / cap | 26.4% / 27.6% / 39.5% / 45.0% | 0 / 0 / 0 / 0 |
| Worst overhang, any band | 1.33 footprint widths | 0.083 footprint widths |

With the window fit switched off, the same test fails: 2,886 strokes over 10% at near, worst 1.32 footprint widths. The fit keeps 99.55% of the building, roof and church footprint area and 95.50% of the windows', and under 0.5% of the building, roof and church strokes (3.2% of the window strokes) keep less than a quarter of their area. The test asserts floors of 98% and 1% (93% and 5% for windows).

### Coverage and fidelity

Fitting alone pulls the paint inside the edges and exposes the base mesh along them, because the brush masks have rounded ends and corners. A diagnostic build that drew every quad solid read 0.04% bare at the close house pose, so that band comes from the brush shapes, not from the fit's geometry. Edge alignment closes most of it and the outlines most of the rest. Each step was measured as its own production build. `world-coverage.spec.ts` (limit 0.5% per pose, unchanged):

| Pose | Before (c982599) | Footprint clamp | + edge alignment | + outlines (final) |
| --- | --- | --- | --- | --- |
| village church | 0.080% | 1.720% | 0.114% | 0.096% |
| village uphill | 0.333% | 1.167% | 0.486% | 0.459% |
| village west | 0.296% | 0.926% | 0.353% | 0.298% |
| village street | 0.117% | 0.904% | 0.178% | 0.157% |
| boundary 47 m inward | 0.043% | 0.778% | 0.087% | 0.081% |
| hill slope | 0.094% | 0.556% | 0.210% | 0.208% |
| spot ahead | 0.276% | 0.512% | 0.367% | 0.359% |
| high over the valley | 0.039% | 0.433% | 0.164% | 0.135% |
| max over the 24 poses | 0.440% (hill west) | 1.720% (village church) | 0.486% (village uphill) | 0.459% (village uphill) |

The village poses still read a little more bare than before: rounded brush corners leave small wedges where two edges meet. The worst pose keeps 0.041 percentage points of headroom. The fragment-shader clip against the face edges was not needed, so no per-instance data was added.

| Gate | Before (c982599) | Footprint clamp | + edge alignment | + outlines (final) |
| --- | --- | --- | --- | --- |
| `fidelity.spec.ts` SSIM (limit ≥ 0.2643) | 0.2970 | 0.2992 | 0.2990 | 0.2963 |
| `fidelity.spec.ts` mean ΔE2000 (limit ≤ 7.1961) | 5.7006 | 5.8256 | 5.6130 | 5.7457 |

`docs/shots/village-overhang.png` shows house 11 from 6 m, eye (9.04, −3.27, −30.74), yaw −0.286, pitch 0.25. The left column is c982599 and the right column the final build. The top row is the normal render and the bottom row `?coverage`. Before, strokes hang past the gable and the walls into the sky. After, the house keeps its silhouette with a dark contour along its edges. The bare share at this pose is 0.112%, against 0.081% before and 1.148% with the footprint clamp alone.

## Village house colours

Paul reported from the headset at ground level that the houses and the church "look almost the same pallet at the ground". Every wall, roof and church stroke that the scatter could not read from the scan drew at random from the one village-region histogram, whose blues match the hills. A count over the seed-1 village found a second cause: `projectToCanvas` has no back-face test, so about 30% of the wall, roof and church area that faces away from the painter (backs and far sides) also took scan pixels, painted from whatever house the painting shows along that ray.

### What changed (rulings Q28 and Q30)

- `src/paintings/starry-night/village-tint.ts` splits the village region's colour histogram into bands by texel-weighted L* quantile. Roofs and the church's nave roof take the darker half (L* 1.1-25.0). House walls take the 0.9-0.97 band, and the church walls and spire the 0.97-1 band. Each wall band keeps only bins at or under a texel-weighted chroma quantile of the region: the median for house walls (L* 46.6-56.8), the lower quartile for the church (L* 57.0-78.3). Without the cap, the lit windows' yellows, which are among the village's lightest paint, turned whole walls yellow. The church band lies wholly above the house band, so the church is lighter than every house. The house floor was 0.85 (L* 41.7-56.8) until ruling Q30. 0.9 is the lowest floor that lifts house 19's back past 15.
- `src/world/village.ts` tags every building, roof and church triangle in `userData.tint` with its owner (house index; the church is owner 0) and role. Church triangles that are exactly vertical (tower shaft, nave walls and gables) and the spire (every vertex at or above the tower top) take the church wall tint, as the painting's spire is pale. Only the nave roof is dark.
- Each owner picks one texel-weighted bin per role from its band, seeded from the world seed, the layer and the owner. Each stroke takes one of the 6 bins nearest that tint (CIE76), so a house reads as one object and neighbours differ. The jitter stays within CIE76 5.90 of the tint over the seed-1 houses, which get 15 distinct wall tints and 18 distinct roof tints among 20.
- In `scatter.ts` the change is colour only. A stroke keeps the scan pixel when its face is turned toward the painter's spot and the stroke is in frame on its layer's region. There is no occlusion test, so a turned face hidden behind a nearer house also keeps the scan. On the church walls and spire, those scan pixels are lifted in lightness (see below). Every other village stroke, outlines included (still darkened to 75%), takes its owner's tint. The spire's outlines are therefore the pale tint at 75% (L* 46.5 for seed 1), not the dark roof tint they were before Q30. The tints draw from their own streams (purposes 3 and 4), so positions, normals, tangents, sizes and meta bytes are bit-identical to before. `tests/starry-night-village-tint.test.ts` checks this over the whole seed-1 scatter. The counts are unchanged, and coverage cannot move.
- SCATTER_VERSION 7, on top of the shared lift share's 6. The only pin that moved is the scatter hash, because only colours changed. On their own branch, before integration, the colours moved it from `177391e4` to `54f8c866` (Q28), then `b6a97b83` (Q30). Combined with the shared lift share (`51173374`) it is `5b9be613`. The haze pin and every count stay. The generator pins are unchanged, because the tags live in `userData`.

### Faces turned toward the painter keep the scan

Three builds were measured with those faces moved toward the house tint by α in linear light (house walls and roofs only, never the church). They used earlier settings: the house walls took 0.8-0.95 with no chroma cap, and the poses came from a double-sided raycast. The wall column is house 18's gable, a face turned toward the painter, from eye (10.01, −3.22, −30.94). That pose is not in the final A1 table:

| α | SSIM (limit ≥ 0.2643) | mean ΔE2000 (limit ≤ 7.1961) | house 18 gable wall–ground ΔE |
| --- | --- | --- | --- |
| 0 (keep the scan) | 0.3182 | 5.8646 | 11.1 |
| 0.5 | 0.3030 | 6.8984 | 12.2 |
| 1 (tint everywhere) | 0.2763 | 7.6855 (fails) | 16.5 |

α = 1 breaks fidelity. α = 0.5 spends 1.03 of the 1.40 ΔE margin and still leaves that wall under 15. So these faces keep the scan under the blend (`SEEN_TINT_BLEND` 0), and the church faces turned toward the painter keep it under the blend as well, as Paul asked. The one exception is the Q30 lightness lift on the church front (below): it raises the L* of the lighter scan strokes on the church walls and spire, and keeps their hue.

### Church front lightness lift (ruling Q30)

Paul sees the church from the painter's spot as white with dark trim. The church keeps the scan's hue and trim, but its lighter scan strokes are stretched toward the church wall tint. On church wall and spire triangles only, a seen stroke whose L* is above the church region's texel-weighted median (L* 27.4) moves its L* toward the owner's church wall tint (L* 60.9 for seed 1) by α_L. Its a* and b* are kept. Strokes at or below the median are the painted trim and keep the scan colour (`SEEN_LIGHTNESS_LIFT`, `LIFT_PIVOT_QUANTILE`).

α_L was measured in 0.25 steps on production builds of this change. The pick rule keeps at least half of round 1's fidelity margin (SSIM 0.3180 and ΔE 5.8433, so SSIM ≥ 0.29115 and ΔE ≤ 6.5197) and asks for a church-front wall–ground ΔE ≥ 15:

| α_L | SSIM (rule ≥ 0.29115) | mean ΔE2000 (rule ≤ 6.5197) | church front wall–ground ΔE | church front wall L* |
| --- | --- | --- | --- | --- |
| 0 | 0.3182 | 5.8805 | 5.4 | 38.3 |
| 0.25 | 0.3184 | 5.8984 | 5.8 | 40.4 |
| 0.5 | 0.3183 | 5.9200 | 7.0 | 42.8 |
| 0.75 | 0.3181 | 5.9458 | 8.8 | 45.4 |
| **1 (chosen)** | 0.3176 | 5.9748 | 11.2 | 48.2 |

Every step keeps the margin, and none reaches 15, so α_L = 1, the best value within the margin. The ceiling comes from the pivot: about half of the church region's scan paint lies at or below the median and stays dark by design. As a diagnostic only, the 0.25 quantile pivot (L* 15.8) at α_L = 1 reads 18.2 (wall L* 55.3) with SSIM 0.3153 and ΔE 6.0689, also within the margin. It is not adopted, because the ruling puts the trim boundary at the median.

### Ground-level contrast (A1)

`bun scripts/village-contrast.ts <base-url> --tag T --out DIR --json F` captures `?painting=starry-night&diag&shot&nogov&nocache&noanim&seed=1` at 1280 × 720 through `__goghPose`. The poses are fixed by rule from the seed-1 village before any capture, with an eye 1.6 m above the ground facing the wall, pitched 0.1 rad down:

- the nearest clear house seen from 7 m in front of its wall that faces the spot;
- the nearest clear house seen from 7 m behind it;
- the next house seen at a gable;
- the nearest house seen level from 15 m off its eave-side back wall, because from 7 m the wall top hides the roof;
- the church from 7 m in front and from 7 m behind.

A house is skipped when the eye would stand inside an outline or when the ray to its wall's centre meets something else first.

Attribution is geometric, with no shader change. The script rebuilds the desktop camera on the CPU (70° vertical, YXZ), casts a ray every 4th pixel against the front faces of the village, window, church and cypress base meshes, and marches the terrain's `heightAt`. A sample counts only where its four grid neighbours name the same surface. Church samples split by tint role, so the church wall set holds the walls and, since Q30, the spire, and the dark set holds only the nave roof. "Nearby ground" is the terrain inside the target's box grown by 64 px. ΔE is CIEDE2000 between the two pixel sets' mean colours, averaged in linear light (the fidelity block-mean convention). It measures whether two surfaces read as different paint, not their stroke texture. The columns are fce5dab (before), the ruling Q28 build and the ruling Q30 build, all production builds measured on fce5dab's base, before integration onto the shared lift share, which moves stroke depth only, not colour:

| Pose (eye; yaw) | Wall–ground ΔE, before → Q28 → Q30 (target ≥ 15) | Roof–wall ΔE (target ≥ 10 where the roof is in view) | Wall L* / ground L*, Q30 |
| --- | --- | --- | --- |
| house 2, front (−3.25, −3.58, −10.08; 0.724) | 12.2 → 18.5 → **20.4** | roof hidden, not measured | 48.8 / 32.3 |
| house 19, back (6.95, −3.20, −38.00; 3.055) | 9.4 → 12.8 → **21.2** | roof hidden, not measured | 48.0 / 35.8 |
| house 16, gable (6.99, −3.82, −8.06; −0.290) | 9.1 → 16.2 → **20.3** | roof hidden, not measured | 46.6 / 35.2 |
| house 0, roofs (−32.72, −2.57, −21.63; −1.304) | 11.6 → 15.5 → **17.7** | 3.9 → 34.1 → **36.8** | 51.9 / 37.9 (roof 6.9) |
| church, back (2.37, −4.02, −47.93; 3.142) | 9.8 → 29.2 → **29.1** | nave roof hidden, not measured | 59.6 / 31.7 |
| church, front (2.37, −2.73, −28.73; 0) | 5.9 → 5.6 → 11.2 (misses) | nave roof hidden, not measured | 48.2 / 36.9 |

From the 7 m poses the wall top hides the roof, and the nave roof has no samples at either church pose. The church roof–wall values reported before Q30 (front 4.7 → 6.4, back 5.9 → 40.3) compared the spire, then dark, with the walls. The spire now counts as wall, which is why the church wall sets grew from 5,472 to 6,379 samples (front) and from 6,889 to 7,407 (back).

Church lightness (L*) at ground level, Q30: from behind, the church walls read 59.6, against 31.7 for the nearby ground and 50.7 for the house walls in view (Q28: 59.7, 31.7 and 48.0; before: 33.6, 31.7 and 28.5). From the front they read 48.2, against 36.9 for the ground and 34.3 for the house walls (Q28: 36.1, 36.9 and 32.5; before: 33.4, 36.9 and 22.2).

Open items:

- **Church front.** Wall–ground reaches 11.2 against the 15 target. The lift with the median pivot cannot go further, and a lower pivot would lift strokes the ruling counts as trim.
- **Occluded faces.** Front faces hidden from the painter behind a nearer house keep the scan, and none of the poses measures one.

### Coverage and fidelity

| Gate | Before (fce5dab) | Q28 | Q30 | Q30 on the shared lift share (SCATTER_VERSION 7) |
| --- | --- | --- | --- | --- |
| `fidelity.spec.ts` SSIM (limit ≥ 0.2643) | 0.3202 | 0.3180 | 0.3176 | 0.3163 |
| `fidelity.spec.ts` mean ΔE2000 (limit ≤ 7.1961) | 5.7934 | 5.8433 | 5.9748 | 5.9204 |
| `world-coverage.spec.ts` max bare share (limit 0.5%) | 0.478% at village uphill (weighted 0.615%) | 0.478% at village uphill (weighted 0.608% at hill west, 0.582% at village uphill) | 0.478% at village uphill (weighted 0.608% at hill west, 0.583% at village uphill) | 0.451% at hill west and village uphill (weighted 0.604% at hill west, 0.555% at village uphill) |

The Q28 and Q30 columns were measured on fce5dab's base. There placement is bit-identical to before, so only colour at MSAA rims can move the bare count, and the maximum did not move. The before column was measured on the Q28 build with the tags removed, which reproduces fce5dab's scatter hash `177391e4`. The last column is the colours integrated onto the shared lift share, whose lift changes stroke depth, so its coverage moves too. All runs used headless Chromium on ANGLE Metal (Apple M4 Max). The Q30 and integrated values are from `E2E_PORT=4297 make e2e` runs, 32 of 32 and 37 of 37 passed.

`docs/shots/village-tint.png` shows the six poses, before (fce5dab) on the left and Q30 on the right. From the top: house 2 front, house 19 back, house 16 gable, house 0 roofs, church back, church front.

## Cypress blue patches

Paul reported from the headset on 46eb08f that the cypress "has parts of it in the blue ground color". The cypress region in regions.png comes from regions.json's coarse 29-vertex polygon (`CYPRESS_OUTLINE`), which reaches past the painted tree, mostly along its upper right edge (u 0.2-0.3, v 0.5-0.85, where 33-83% of the region's texels are sky or hill paint). About 11% of the region's texels are nearer the hills' mean colour than the cypress's. They reached the 3D tree two ways: the 43% of its strokes below the frame drew them at random from the region histogram (a speckle with a hard seam at the frame edge), and in-frame strokes copied them from the scan on every face, back faces included, because a back point projects onto the same pixel as the front.

### What changed (ruling: the cypress keeps to its own palette)

- `src/paintings/starry-night/canvas-histogram.ts` gives each region a centre, the texel-weighted mean CIELAB of its colour bins. A region listed in `REGION_PALETTE_RIVALS` keeps only its palette: a colour is in it when its CIEDE2000 distance to the region's centre plus `PALETTE_MARGIN` (2) is below its distance to every rival's centre. Only the cypress is listed, with the hills and the sky as rivals. Bins outside the palette leave its colour histogram (its flow histogram keeps every texel), and a scan pixel outside it falls back to the cleaned histogram, whichever way the stroke faces. Without the margin, 0.06% of the strokes, colours about equidistant from the two centres, stayed.
- CIELAB and CIEDE2000 moved from `scripts/fidelity-lib.ts` to `src/util/cielab.ts`, which the fidelity metric re-exports, so the metric and the check share one implementation.
- SCATTER_VERSION 10. Only the scatter hash pin moved (`5b9be613` to `696165d1`). The counts and the haze hash stay.

### Measured (seed 1)

A stroke is blue when its paint (stored colour times its shade) is nearer, in CIEDE2000, the hills' texel mean (30.0, 4.4, -20.9) than the cypress's (16.7, -2.2, -0.5). Height bands are of the main mass (base y -5.19, 14.57 m tall). This test uses the same centres as the palette check, minus its margin, so the 0% after column shows that the check is applied to every stroke. It is not an independent measure of visible blue. That evidence is the shot below and Paul's headset check.

| Cypress strokes (36,964) | Before | After |
| --- | --- | --- |
| All | 13.82% | 0.00% |
| Height 0-20% | 11.30% | 0.00% |
| Height 20-40% | 5.79% | 0.00% |
| Height 40-60% | 13.14% | 0.00% |
| Height 60-80% | 39.92% | 0.00% |
| Height 80-100% | 51.79% | 0.00% |
| Facing the painter / rim / away | 11.92% / 19.83% / 12.01% | 0% / 0% / 0% |

The painter-spot fidelity (`scripts/fidelity.ts`, dev server, 1280 × 1014, ANGLE Metal) drops from SSIM 0.3163 and ΔE 5.9204 to SSIM 0.2953 and ΔE 6.3258, inside both limits (≥ 0.2643, ≤ 7.1961). The painter now sees dark tree where the polygon's fringe shows sky in the painting, and a stroke that falls back takes three extra draws from its mesh's stream, which reshuffles the later cypress strokes.

`docs/shots/cypress-blue.png` shows before (top) and after (bottom) at the painter spot and three ground poses through `__goghPose`: front (-2.5, 0.02, -4.5, yaw 0.1, pitch -0.25), side (3, -3.9, -10, yaw π/2, pitch 0.25) and back (-3, -3.04, -15, yaw π, pitch 0.3).

## Moon and stars

Card 01a1b3824657741cba3e39e7295536f4, P4.3 pulled forward with static strokes only. Before this change the world counts reported 0 star and 0 moon strokes. From the painter's spot, the moon and star discs showed random sky-histogram colours.

### What changed

- `src/world/sky-lights.ts` places a disc of concentric rings of strokes at each of the 12 sky anchors (`skyAnchors()`). Each disc covers its regions.json circle (11 stars, 1 moon). Every stroke lies on the dome sphere along the painter's ray, faces the eye and runs along its ring. Brushes and the stroke layer come from the stars and moon region styles, so the strokes count as `star` and `moon`.
- Colours come from the full-resolution scan. `make bake` now also writes `public/paintings/starry-night/lights.webp`: a square of the 3840 × 3041 scan around each anchor, 1.1 radii each way, stacked top to bottom (`src/world/sky-scan.ts`). It is lossy WebP at quality 90 with smart chroma subsampling, 819 KB (lossless was 2.8 MB). Each stroke reads its colour there at its projected canvas uv, divided by `strokeShade`. frame.webp is 1024 px wide and blurred the crescent's edge. The extra fetch and decode raise the world's `decodeMs` from 85-93 ms to 119-123 ms (3 loads each from a local preview server).
- Star strokes are drawn 0.012 painting widths long on rings 0.005 apart. Moon strokes are half that, 0.006 on rings 0.0025 apart, so the crescent (about 0.02 painting widths thick) keeps its shape.
- The strokes sit in the dome's own chunks, which are always in the far band (size 1.6). The batch pins them (`isPinnedStroke` in `src/render/strokes/batch.ts`): each chunk orders its sky-light strokes (star or moon layer with `DEPTH_BACKDROP_FLAG`) first, then the rest, each group in importance order, and stores the light count as `pinned`. A band density draws `pinned + bandDrawCount(d, count - pinned)`, so every governor level draws every light and thins only the dome. A chunk with no lights orders and draws exactly as before, and a unit test pins that. The P1 canvas and the stroke test scene use the star and moon layers without the flag, so they are not pinned, and a unit test covers that too. Pinning adds no chunk and no draw call. `SKY_LIGHT_OVERDRAW` is 12, the quad overdraw as drawn at every density. At 8 the moon was solid (per-pixel ΔE 7.47 to 7.83 at the three densities) but dark gaps stayed between the star dabs, which 12 closes.
- The strokes carry `DEPTH_BACKDROP_FLAG`, and the vertex shader puts a flagged stroke on the star or moon layer in the reserved front tier at rank `1024 + (h >> 24)`, in front of every dome rank and behind the world. `?demo=canvas` draws those layers without the flag, at normal depth.
- Ranks are assigned greedily per disc. Each stroke takes the first rank, from a random start, that no earlier stroke within 1.3 longest drawn lengths holds. That is the distance at which two quads of the widest brush (aspect 0.833) can still touch corner to corner. At overdraw 12, at most 117 moon strokes (mean 104) and 121 star strokes (mean 90) sit within that reach of any stroke, so one of the 256 ranks is always free. If all 256 were held, the stroke would take its start rank and count a tie, which the world diag reports as `lightRankTies`. It is 0 at seeds 1 and 2, and a unit test asserts both and the fallback. The stored x coordinate then moves by the fewest float32 steps (micrometres) that make the position hash give that rank. A unit test finds 0 pairs sharing a rank among all pairs closer than 1.3 × 0.0138 painting widths (stars) or 1.3 × 0.0069 (moon). The first version of this change offset neighbouring rings by 85 ranks, which put every third ring one rank from a tie.
- The boundary haze (45-55 m, up to 45 m altitude) covers the painter's whole view of the sky below about 40° elevation, and the front tier draws behind it. The haze is now generated unchanged, and every haze stroke carries `SKY_LIGHT_CULL_FLAG` (iMeta.w bit 7, value 128, unused before). The vertex shader collapses a flagged stroke when its centre, seen from the eye of the view being drawn, lies inside one of 12 cones. Each cone is a disc's angular radius, out to its outermost ring plus half its longest stroke, plus asin of the haze stroke's drawn half diagonal over its distance, the widest angle any point of its quad can sit off its centre's ray (`src/render/strokes/sky-light-cull.ts`, uniform `uSkyLightCones`). Rim tests place a point just inside and just outside each cone from two eyes. The eye is three's `cameraPosition` uniform, which the renderer sets from each camera's `matrixWorld` in the same per-camera block as `viewMatrix`. Each XR eye is its own camera, so each culls for itself. The cull is the last statement of `main` and adds no draw call. The uniforms hold each disc's world centre and radius rather than a fixed direction and cosine, because a fixed direction holds only at the painter's spot. The shader derives the direction and the cosine of the cone per view. The CPU `exclude` path and `hidesSkyLight` are gone.
- For the largest haze stroke at 50 m (half diagonal margin, far-band size), the cones clear 0.435 sr (3.46% of all directions), of which the discs themselves take 0.158 sr. With each haze stroke's own half diagonal they cull 1,086 of the 30,000 haze strokes from the painter's spot, 1,137 from (20, 1.6, 0) and 633 from (0, 1.6, -30). The half-length margin of fix round 1 cleared 0.414 sr and culled 1,032, 1,083 and 605.
- The moon and stars and the haze are generated on every build outside the scatter cache (`assembleWorldStrokes` in `world.ts`). This change leaves the scatter output alone, so the scatter hash pin stays the base's: `5b9be613` at SCATTER_VERSION 7 when it was written, `696165d1` at SCATTER_VERSION 10 after the cypress palette fix it was integrated onto. The pins are 12,294 light strokes (hash `da2a676f`) and the haze. With bit 7 cleared, the haze hashes `49bf0339` as before this change, and every haze stroke carries the bit.
- World counts at seed 1: star 5,943, moon 6,351 (14,853 and 15,876 before pinning). The other layers are unchanged.
- `createSkyLights` takes 20-34 ms for the 12,294 strokes (6 runs, host load about 17). The 30,729 strokes before pinning took 60-78 ms, and the first version 59-87 ms for 7,847: the rank search hashes only the x coordinate and allocates only on a hit.
- The colour test in `tests/world-sky-lights.test.ts` is partly circular: it samples lights.webp with the generator's own `sampleSkyScan`, so it checks the crop choice, the projection and the shade division, not that lights.webp matches the scan. The per-pixel ΔE below is the independent check.

### Measurements

Before is 46eb08f, round 1 is 5696a7f and after is 9664757 (the pinned lights) at the default far density 0.4. All are production builds served by `vite preview`. Round 1 was measured at load 6-10 and after at load 15-18. The painter view is `?painting=starry-night&diag&shot&noanim&seed=1&painter`, captured at 1280 × 1014. "Cull off" is an earlier build of this change (rank reach 1.01 lengths) with the cone uniforms left empty, so the haze hides the discs as before.

| Measure | Before (46eb08f) | Cull off | Cull on, no lights | Round 1 (5696a7f) | After (9664757) |
| --- | --- | --- | --- | --- | --- |
| `fidelity.spec.ts` SSIM (limit ≥ 0.2643) | 0.3163 | 0.3184 | 0.3238 | 0.3713 | 0.3786 |
| `fidelity.spec.ts` mean ΔE2000 (limit ≤ 7.1961) | 5.9204 | 5.8419 | 5.5672 | 3.9019 | 3.8723 |
| Moon block (14, 2) ΔE2000 | 43.68 | 43.29 | 44.06 | 1.56 | 1.05 |
| Moon disc, per-pixel mean ΔE2000 against the scan | 44.06 | 43.17 | 44.31 | 6.85 | 6.18 |
| Moon disc, per-pixel mean ΔE2000, both blurred σ = 3 px | 43.53 | 42.54 | 43.77 | 2.73 | 2.12 |
| Star discs, per-pixel mean ΔE2000, mean of the 11 | 26.92 | 26.23 | 25.84 | 13.31 | 13.14 |
| Chunks / visible chunks at the painter camera | 543 / 117 | 543 / 117 | | 543 / 117 | |
| `world-coverage.spec.ts` max bare share (limit 0.5%) | 0.451% at hill west (weighted 0.604%) | | | 0.451% at hill west (weighted 0.604%) | 0.451% at hill west (weighted 0.604%) |

The per-pixel ΔE is the mean CIEDE2000 over every pixel inside the anchor's circle, capture against the scan (inset past its mat, resized to 1280 × 1014). The moon meets the ≤ 10 bar. Unblurred, much of the remaining 6.18 is brush texture and stroke edges at pixel scale, which the blurred row removes. The stars stay near 13 because their rings are the painting's fine swirl, which strokes 0.012 painting widths long only approximate.

Attribution, from the cull-off and cull-on-without-lights builds: removing the haze in the cones alone gives SSIM +0.005 and mean ΔE -0.27 (cull off to cull on without lights). The discs then give SSIM +0.048 and mean ΔE -1.67 (cull on without lights to after). Most of the gain is the discs' own paint.

Round 1 measurements: draw calls at the default spawn view (`?nogov`, 1280 × 1014) are 147 with the cull on and 147 with it off, and 122 and 122 at the village pose below. In an IWER XR session (`--mode e2e`, `?iwer&nogov`) at the painter's spot, head turned to the moon, both builds draw 402 calls (both eyes) over 195 visible chunks. The stereo capture with the cull on shows the moon and stars uncovered where the cull-off capture shows haze. At that pose the second eye's view held no disc, so the capture does not show one disc in both eyes side by side.

Round 1 coverage moved by at most 0.029 points at any pose against 46eb08f: under the cypress 0.053% to 0.066%, village church 0.094% to 0.117% and high over the valley 0.144% to 0.150%. Spot straight up stays 0.030%.

Flicker probe (`scripts/zfight-probe.ts`), share of pixels changed after a 0.1 mm shift, all (top / mid / bottom), %:

| Pose | Before (46eb08f) | Cull off | Round 1 (5696a7f) |
| --- | --- | --- | --- |
| painter-level | 0.116 (0.043 / 0.093 / 0.212) | 0.116 (0.045 / 0.092 / 0.211) | 0.116 (0.045 / 0.092 / 0.211) |
| painter-down | 0.270 (0.050 / 0.176 / 0.584) | 0.270 (0.051 / 0.176 / 0.585) | 0.271 (0.051 / 0.176 / 0.585) |
| village-look | 0.347 (0.076 / 0.297 / 0.667) | 0.358 (0.076 / 0.297 / 0.701) | 0.360 (0.078 / 0.300 / 0.701) |
| back | 0.249 (0.068 / 0.269 / 0.409) | 0.247 (0.069 / 0.266 / 0.407) | 0.247 (0.069 / 0.266 / 0.407) |
| sky-up-0.5 | 0.061 (0.036 / 0.039 / 0.110) | 0.062 (0.036 / 0.041 / 0.110) | 0.063 (0.037 / 0.045 / 0.107) |
| sky-up-1.0 | 0.038 (0.040 / 0.035 / 0.039) | 0.038 (0.040 / 0.036 / 0.038) | 0.039 (0.040 / 0.036 / 0.041) |
| ridge-horizon | 0.248 (0.070 / 0.337 / 0.337) | 0.245 (0.070 / 0.336 / 0.329) | 0.253 (0.093 / 0.336 / 0.329) |
| paul-strobe1 | 0.434 (0.174 / 0.405 / 0.724) | 0.439 (0.179 / 0.412 / 0.727) | 0.439 (0.179 / 0.412 / 0.727) |

The cull-off column is an earlier build of this change, whose ranks reached only 1.01 longest lengths. The sky poses rise by 0.001 to 0.002 points on all, where the first version of this change lowered them. The ridge-horizon top third rises by 0.023 points over the cull-off build: there the cull uncovers stars at the top of the frame, and their small strokes add edges. Widening the rank reach from 1.01 to 1.3 lengths cut that rise from 0.040 points.

In fix round 1, the village-look bottom third rose from 0.667 to 0.701, and that came from the vertex shader's text, not from what it draws. These builds all read 0.701: the cull off, the cull on without lights, the haze without the cull flag, the cull moved from an early return to the end of `main`, and the eye read from `cameraPosition` instead of the view matrix. The same build with the 30ec370 vertex shader reads 0.667, as the 46eb08f build does. So adding the cull code changes the GPU's rounding for strokes it never culls, probably through the shader compiler, and moves which pixels flip under a 0.1 mm shift. The mechanism is not identified further.

`docs/shots/moon-stars.png` shows the painter view, 46eb08f on the left and the pinned build at the default density on the right. `docs/shots/moon-stars-crops.png` shows the moon, the top-right star and the leftmost star, from 1.25 radii around each anchor: scan, then 5696a7f at the far floor 0.1, then the pinned build at far density 1, 0.28 and 0.1. `docs/shots/moon-stars-village.png`, from the fix round 1 build, looks up at the moon from (-22, 4, -26), 34 m from the painter's spot: cull off on the left, where the haze hides every disc, and on on the right.

![Painter view, before and after the moon and stars](shots/moon-stars.png)

![Moon and two stars: scan, 5696a7f at the floor, pinned at far density 1, 0.28 and 0.1](shots/moon-stars-crops.png)

![Village pose looking up at the moon, cone cull off and on](shots/moon-stars-village.png)

### Pinned lights (fix round 2)

The far band's density was forced in the build (`DEFAULT_BAND_DENSITY.far`) for each column, and the painter view captured as above. The quad overdraw comes from rasterizing every drawn moon quad (stored size × 1.6) into the painter view at 3840 px per painting width, counted per pixel inside the moon's circle (`.superpowers/sdd/overdraw.ts`, not committed). 5696a7f drew a prefix of its 30,729 stored lights, so its overdraw scaled with the density: mean 28.0 and max 42 with all stored strokes drawn (measured), so about 11 at the default 0.4 and about 2.8 at the floor (scaled by the density, not measured). The pinned build draws all 12,294 at every density: mean 11.2, min 3, max 19 over the moon.

| Far density | Moon per-pixel ΔE2000 | Moon, blurred σ 3 px | Moon block (14, 2) | Stars per-pixel ΔE2000 | SSIM | Mean ΔE2000 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 6.16 | 2.17 | 1.06 | 13.10 | 0.3753 | 3.9117 |
| 0.4 (default) | 6.18 | 2.12 | 1.05 | 13.14 | 0.3786 | 3.8723 |
| 0.28 (first shed step) | 6.07 | 2.08 | 0.89 | 13.15 | 0.3772 | 3.9296 |
| 0.1 (floor) | 6.21 | 2.21 | 1.10 | 13.08 | 0.3663 | 3.7094 |
| 0.1, 5696a7f | 22.56 | | 15.22 | | 0.3414 | 4.2256 |

The moon disc stays solid at the floor, and its ΔE moves by 0.14 across the densities, against 22.56 at the floor before. The stars stay near 13 at every density. The coverage and fidelity e2e specs run on the default density.

Flicker probe at the default density, 0.1 mm shift, all (top / mid / bottom), %, for the pinned build and the same build with `invariant gl_Position;` and the cull fed from `iPosition` directly (chunk meshes stay at the identity transform, so `iPosition` is already world space):

| Pose | Pinned | Pinned with invariant |
| --- | --- | --- |
| painter-level | 0.116 (0.042 / 0.095 / 0.212) | 0.116 (0.042 / 0.095 / 0.212) |
| painter-down | 0.270 (0.051 / 0.176 / 0.584) | 0.270 (0.051 / 0.176 / 0.584) |
| village-look | 0.350 (0.084 / 0.300 / 0.667) | 0.381 (0.083 / 0.302 / 0.757) |
| back | 0.249 (0.068 / 0.269 / 0.409) | 0.243 (0.067 / 0.255 / 0.408) |
| sky-up-0.5 | 0.063 (0.035 / 0.045 / 0.109) | 0.063 (0.035 / 0.045 / 0.108) |
| sky-up-1.0 | 0.039 (0.040 / 0.036 / 0.040) | 0.039 (0.040 / 0.036 / 0.041) |
| ridge-horizon | 0.249 (0.072 / 0.337 / 0.337) | 0.256 (0.080 / 0.339 / 0.350) |
| paul-strobe1 | 0.435 (0.175 / 0.405 / 0.724) | 0.430 (0.164 / 0.396 / 0.730) |

`invariant` raises village-look (bottom 0.667 to 0.757) and ridge-horizon, so it was not kept. The pinned build's village-look bottom third reads 0.667 again, as 46eb08f does, and its ridge-horizon all reads 0.249 against 0.248 before. `invariant` and the `iPosition` feed were tested together, so neither was measured on its own.

Cost: at the default far density 0.4 the drawn lights barely change (about 12,290 drawn of 30,729 stored before, all 12,294 now). At the far floor they rise from about 3,070 to 12,294, so a full shed saves about 9,200 fewer strokes than before. The before figures are scaled from the stored count by the density (a prefix of the chunk's order), not measured.

Not done here: the P4.3 pulse and additive halo, and a headset run. The headset check is Paul's.
