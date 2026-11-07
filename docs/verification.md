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
| P2-A1 | Generators are deterministic for a given seed (unit snapshot of vertex and stroke counts and bounds). | 2026-11-06, commit 4768e33. `tests/world-starry-night.test.ts` pins the seed-1 world as literals, over the real `CanvasSource` (frame.webp, regions.png and flow.png decoded with sharp). Generators: vertex and triangle counts and axis-aligned bounds rounded to 1 mm for the terrain (16,384 vertices, 32,258 triangles), ridge, houses, roofs, windows, church, cypress and sky dome. Scatter: the `scatterWorld` total (535,011), the per-layer counts and its `hashStrokeBuffers` (`9724bad8`, now `480f43d7`: SCATTER_VERSION 3 sets the lit-window depth flag in the spare meta byte, with the counts unchanged). Haze: 30,000 strokes, hash `49bf0339`. Both tests pass inside `make checkall`. A scatter pin change requires a `SCATTER_VERSION` bump. A generator pin change does not, because the cache key carries the build SHA. | Met |
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
- Stars and moon (layers 1 and 2) get a reserved front tier: the next 256 ranks, nearer than every dome rank. Today the shader puts every flagged stroke in the dome tier. When those layers land, their scatter sets the flag, and the shader takes their rank from the top 8 bits of the hash (`h >> 24`) and then offsets it by 1024. Offsetting the dome's 10-bit rank instead would reach rank 2047. That rank still sits behind the 168.7 m world reach the budget test asserts, at about 169.8 m, but ranks 1280-2047 fall outside the 256-rank front tier the test checks, and the real margin shrinks from about 78 m to about 1 m.
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
- SCATTER_VERSION 6. Every count is unchanged, and the scatter hash is `51173374`.

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
