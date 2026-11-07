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
| P2-A1 | Generators are deterministic for a given seed (unit snapshot of vertex and stroke counts and bounds). | 2026-11-06, commit 4768e33. `tests/world-starry-night.test.ts` pins the seed-1 world as literals, over the real `CanvasSource` (frame.webp, regions.png and flow.png decoded with sharp). Generators: vertex and triangle counts and axis-aligned bounds rounded to 1 mm for the terrain (16,384 vertices, 32,258 triangles), ridge, houses, roofs, windows, church, cypress and sky dome. Scatter: the `scatterWorld` total (535,011), the per-layer counts and its `hashStrokeBuffers` (`9724bad8`, then `480f43d7`: SCATTER_VERSION 3 sets the lit-window depth flag in the spare meta byte, with the counts unchanged; then `51173374`: SCATTER_VERSION 6, see [Shared lift share](#shared-lift-share-walking-reorder); then `5b9be613`: SCATTER_VERSION 7 adds the village colours, see [Village house colours](#village-house-colours); then `6ed76c8a` on 46eb08f's base: SCATTER_VERSION 8 raises the dark house-wall strokes and darkens the church trim, see [Upper walls and church trim](#upper-walls-and-church-trim); then `696165d1`: SCATTER_VERSION 10 keeps the cypress in its own palette, see [Cypress blue patches](#cypress-blue-patches); now `cf326988`: SCATTER_VERSION 11 is the wall raise with the trim on every structure, on the cypress fix and the moon and stars, see [Trim on every structure](#trim-on-every-structure-ruling-q31)). Haze: 30,000 strokes, hash `49bf0339`. Both tests pass inside `make checkall`. A scatter pin change requires a `SCATTER_VERSION` bump. A generator pin change does not, because the cache key carries the build SHA. | Met |
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
- SCATTER_VERSION 6. Every count is unchanged, and the scatter hash is `51173374`. The village colours on top make it SCATTER_VERSION 7, hash `5b9be613` ([Village house colours](#village-house-colours)), and the house wall raise and church trim SCATTER_VERSION 8, hash `6ed76c8a`, on that base. On the cypress palette fix (SCATTER_VERSION 10, hash `696165d1`), the wall raise with the trim on every structure is SCATTER_VERSION 11, hash `cf326988`.

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
- Outline pass (`placeOutlines` in `scatter.ts`): every side of every wall, roof and church face gets a row of strokes laid along it and fitted flush inside it the same way, from their own rand stream. There is one per 0.8 of the graded stroke length, thinned evenly so the rows total at most 5% of the face-clamped strokes (`OUTLINE_SHARE`). They use the ridge and bristle brushes, the canvas colour at the edge darkened to 75% (`OUTLINE_DARKEN`), and a lift and tie-break share from their quad size like every other stroke (`sizeShare`, see Shared lift share). Van Gogh draws the village in dark contours, and the row covers the rim the rounded brush ends leave bare. Seed 1 gets 3,105 outline strokes, 3.7% of the 84,264 face-clamped strokes (budget 4,213). Since ruling Q31 every outlined layer is a tagged village mesh, whose outlines take their region's trim undarkened instead ([Trim on every structure](#trim-on-every-structure-ruling-q31)).
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
- In `scatter.ts` the change is colour only. A stroke keeps the scan pixel when its face is turned toward the painter's spot and the stroke is in frame on its layer's region. There is no occlusion test, so a turned face hidden behind a nearer house also keeps the scan. On the church walls and spire, those scan pixels are lifted in lightness, and on house walls the ones darker than the wall band are raised to its floor (both below). Every other village stroke takes its owner's tint. Outlines are darkened to 75%, and on the church walls and spire they draw from the church trim instead of the wall tint, so they read dark (mean L* 8.2 for seed 1, see [Upper walls and church trim](#upper-walls-and-church-trim)). Since ruling Q31, every outline on the houses, roofs, church and spire draws from its region's trim, undarkened ([Trim on every structure](#trim-on-every-structure-ruling-q31)). The tints draw from their own streams (purposes 3 and 4), so positions, normals, tangents, sizes and meta bytes are bit-identical to before. `tests/starry-night-village-tint.test.ts` checks this over the whole seed-1 scatter. The counts are unchanged, and coverage cannot move.
- SCATTER_VERSION 7, on top of the shared lift share's 6. The only pin that moved is the scatter hash, because only colours changed. On their own branch, before integration, the colours moved it from `177391e4` to `54f8c866` (Q28), then `b6a97b83` (Q30). Combined with the shared lift share (`51173374`) it is `5b9be613`. The house wall raise and church trim make it SCATTER_VERSION 8, hash `6ed76c8a`. On the cypress palette fix, the wall raise with the trim on every structure is SCATTER_VERSION 11, hash `cf326988`. The haze pin and every count stay. The generator pins are unchanged, because the tags live in `userData`.

### Faces turned toward the painter keep the scan

Three builds were measured with those faces moved toward the house tint by α in linear light (house walls and roofs only, never the church). They used earlier settings: the house walls took 0.8-0.95 with no chroma cap, and the poses came from a double-sided raycast. The wall column is house 18's gable, a face turned toward the painter, from eye (10.01, −3.22, −30.94). That pose is not in the final A1 table:

| α | SSIM (limit ≥ 0.2643) | mean ΔE2000 (limit ≤ 7.1961) | house 18 gable wall–ground ΔE |
| --- | --- | --- | --- |
| 0 (keep the scan) | 0.3182 | 5.8646 | 11.1 |
| 0.5 | 0.3030 | 6.8984 | 12.2 |
| 1 (tint everywhere) | 0.2763 | 7.6855 (fails) | 16.5 |

α = 1 breaks fidelity. α = 0.5 spends 1.03 of the 1.40 ΔE margin and still leaves that wall under 15. So these faces keep the scan under the blend (`SEEN_TINT_BLEND` 0), and the church faces turned toward the painter keep it under the blend as well, as Paul asked. There are two exceptions, and both move L* only and keep the hue. The Q30 lightness lift on the church front (below) raises the lighter scan strokes on the church walls and spire. The house wall raise ([Upper walls and church trim](#upper-walls-and-church-trim)) raises the house-wall scan strokes darker than the wall band up to its floor.

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

### Upper walls and church trim

The figures in this section were measured on 46eb08f's base. SCATTER_VERSION 11 keeps α_W 1 on the cypress palette fix and the moon and stars, see [Trim on every structure](#trim-on-every-structure-ruling-q31).

Paul checked 46eb08f in the headset at ground level. The church read mostly white with no dark trim, and the houses read white at the bottom with ground colours on the top half.

Diagnosis (seed 1, at 46eb08f). The roofs are not the cause: at the roofs pose the roof reads L* 6.4 against 33.5 for the ground (roof–ground ΔE 20.5, roof–wall 36.7), and the roof tint strokes average L* 14.5. The cause is the scan pixel kept on house walls turned toward the painter. Such a stroke keeps the scan when it projects into the painting's village region. The 3D walls rise past the painted wall tops, so their upper parts project onto the painting's dark roofs and shadows, while their lower parts more often fall below the frame and take the pale wall tint. Over the 24,236 painter-facing house-wall strokes, by height up the wall from base to eaves:

| Height band | Strokes | Out of frame (tint) | On the village region (scan kept) | Other region (tint) | Scan-kept L* | Tint L* |
| --- | --- | --- | --- | --- | --- | --- |
| 0-25% | 5,404 | 48.7% | 39.2% | 12.1% | 23.9 | 51.4 |
| 25-50% | 5,563 | 37.7% | 49.3% | 13.0% | 24.0 | 51.3 |
| 50-75% | 5,362 | 23.9% | 62.1% | 14.0% | 25.4 | 51.0 |
| 75-100% | 5,388 | 15.4% | 62.2% | 22.4% | 29.0 | 50.6 |
| gable, above the eaves | 2,519 | 3.7% | 58.8% | 37.5% | 33.1 | 49.8 |

The church outlines took the pale church wall tint at 75%: its 294 outline strokes averaged L* 38.7 (42.2 on vertical faces, 32.6 on sloped ones), and only 21.1% were at L* 30 or below.

House walls. A painter-facing house-wall stroke whose scan pixel is darker than the house wall band's floor (L* 46.6) has its L* raised toward that floor by α_W (`SEEN_WALL_LIFT`, `raiseLightness`). Its a* and b* are kept, so the wall keeps the scan's hue. The half-margin rule binds α_L only, so α_W answers to the fidelity thresholds. Production builds on 46eb08f, all with the church trim below:

| Variant | SSIM (limit ≥ 0.2643) | mean ΔE2000 (limit ≤ 7.1961) | house 2 front, wall L* upper / lower half | house 16 gable, wall L* upper / lower half | wall–ground ΔE, house 2 front / house 16 gable |
| --- | --- | --- | --- | --- | --- |
| 46eb08f | 0.3163 | 5.9204 | 41.4 / 52.8 | 39.3 / 53.0 | 21.5 / 19.9 |
| trim only (α_W 0) | 0.3163 | 5.9146 | 41.4 / 52.8 | 39.3 / 53.0 | 21.5 / 19.9 |
| tint replaces the scan below the floor | 0.2908 | 7.7074 (fails) | 52.6 / 53.0 | 54.9 / 54.7 | 23.7 / 26.4 |
| α_W 0.5 | 0.3108 | 6.3296 | 44.7 / 52.9 | 43.5 / 53.4 | 22.4 / 20.2 |
| α_W 0.75 | 0.3036 | 6.6699 | 46.8 / 52.9 | 46.3 / 53.7 | 23.0 / 20.7 |
| **α_W 1 (chosen)** | 0.2946 | 7.0740 | 49.2 / 52.9 | 49.6 / 54.1 | 23.7 / 21.4 |

Replacing the scan with the tint breaks fidelity. α_W = 1 is the largest raise, and brings each wall's upper half to within 4.5 L* of its lower half. It spends 1.15 of the 1.28 ΔE margin left at 46eb08f. The cost is in the painter-spot view: the raised strokes lighten the foreground houses' painted shadows there too.

Church trim. Each church owner also picks a trim colour from the church region's paint at or below the lift pivot (L* 27.4), with no chroma cap (`trimBand`, `trimSeed`). An outline stroke on church wall and spire triangles keeps the scan when the painter sees it and its scan L* is at or below the pivot, so painted trim stays painted. Otherwise it takes a colour around the trim tint (`outlinePaint`). Outlines are still darkened to 75%. The outlines were found by dumping the seed-1 church strokes' paint L* at `OUTLINE_DARKEN` 0.75 and 0.5, as the strokes that differ:

| Church strokes | 46eb08f | Trim |
| --- | --- | --- |
| outline mean L* (294 strokes) | 38.7 | **8.2** |
| outline mean L*, vertical faces / sloped faces | 42.2 / 32.6 | 7.9 / 8.7 |
| outline share at L* ≤ 30 | 21.1% | 99.7% |
| body mean L* | 47.7 | 47.7 |

α_L stays 1. The church front wall still reads 56.1 on its upper half and 44.0 on its lower half, so the face keeps its painted variation, and the church front shot shows the dark outlines on the tower and spire edges.

Contrast at ground level (`scripts/village-contrast.ts`, same poses as A1 below), 46eb08f → this change:

| Pose | Wall–ground ΔE | Roof–wall ΔE | Roof–ground ΔE | Wall L*, upper / lower half | Wall / ground / other house walls L*, after |
| --- | --- | --- | --- | --- | --- |
| house 2, front | 21.5 → **23.7** | roof hidden | roof hidden | 41.4 / 52.8 → 49.2 / 52.9 | 51.5 / 33.2 / 47.9 |
| house 19, back | 21.0 → **21.0** | roof hidden | roof hidden | 48.7 / 48.5 → 48.7 / 48.5 | 48.6 / 33.3 / 49.8 |
| house 16, gable | 19.9 → **21.4** | roof hidden | roof hidden | 39.3 / 53.0 → 49.6 / 54.1 | 51.9 / 36.8 / 48.3 |
| house 0, roofs | 22.1 → **22.1** | 36.7 → **36.7** | 20.5 → **20.5** | 51.8 / 50.9 → 51.8 / 50.9 | 51.4 / 33.5 / 52.1 (roof 6.4) |
| church, front | 13.0 → 12.6 | nave roof hidden | nave roof hidden | 56.5 / 44.3 → 56.1 / 44.0 | 48.5 / 35.5 / 47.4 |
| church, back | 30.2 → **30.1** | nave roof hidden | nave roof hidden | 59.8 / 59.8 → 59.7 / 59.7 | 59.7 / 32.2 / 51.0 |

House 19's back and house 0's back wall face away from the painter, so they never kept the scan and do not move. The 46eb08f values differ from the A1 table's Q30 column, which was measured before integration onto the shared lift share.

### Trim on every structure (ruling Q31)

Paul compared the village with the scan and noted that every structure in the painting has black trim and outlines. Ruling Q31 asked for that trim and for per-building palettes. The review of dad7f6d held the palettes, so this build ships the trim alone, with 0579a44's wall raise and church trim, on top of the cypress palette fix.

What changed:

- `trimBand` (`village-tint.ts`) is now each layer region's paint at or below its texel-weighted median L* (the lift pivot), with no chroma cap: L* 1.1-25.0 for the village region (mean 15.3) and L* 1.1-27.4 for the church region (mean 15.4).
- Every outline on a tagged mesh (house walls, roofs, the church walls, spire and nave roof, all roles) draws from its region's trim (`outlinePaint`). It keeps the scan pixel only where the painter sees the face and the pixel is at or below the median, so painted trim stays painted. Otherwise it draws one texel-weighted bin of the trim band (`drawBand`), one draw from the mesh's outline tint stream, so positions stay bit-identical.
- No `OUTLINE_DARKEN` on the trim. Untagged meshes keep the 0.75 darkening. `trimSeed` and the per-owner church trim pick are gone, and `outlinePaint` lost its unused layer argument.
- Body strokes are 0579a44's: no per-building palettes, no palette floors, and the house wall raise at full strength (α_W 1, `SEEN_WALL_LIFT`), so the walls read pale from base to eaves.
- SCATTER_VERSION 11, scatter hash `cf326988`, every count unchanged. The moon and stars (a649d39) are a separate stroke set, so the scatter hash is the same on dab260e and on a649d39.

Measured over the seed-1 scatter, counting the outline strokes from `placeOutlines`' index ranges: **3,105 outline strokes, mean L* 15.4**, 47.9% at or below L* 15 and 69.6% at or below 20. 2,795 (90.0%) draw from the trim band (mean L* 15.3), and 310 (10.0%) keep the scan's painted trim (mean L* 15.9). At 0579a44 only the church outlines took a trim (294 strokes, mean L* 8.2 after the 0.75 darkening), and the house and roof outlines took the wall or roof paint darkened to 75%. The wall raise does not touch outlines.

Fidelity at the painter's spot, on a649d39 (the cypress fix with the moon and stars), from `E2E_PORT=4297 make e2e`: **SSIM 0.3347, mean ΔE2000 5.4771** (limits ≥ 0.2643 and ≤ 7.1961), leaving 1.72 of the ΔE margin. Coverage: max bare 0.451% at hill west (weighted 0.604% at hill west).

On dab260e, before the moon and stars, the full raise did not fit. There the cypress fix alone had moved the base from ΔE 5.9204 to 6.3258, and α_W 1 added about 1.14 on top. Measured on dab260e (production build served by `vite preview`, `scripts/fidelity.ts`):

| α_W | SSIM (≥ 0.2643) | Mean ΔE2000 (≤ 7.1961) |
| --- | --- | --- |
| 1 (e2e 36 of 37, `fidelity.spec.ts` failed) | 0.2727 | 7.4659 (fails) |
| 0.75 | 0.2817 | 7.0647 |
| 0.5 | 0.2888 | 6.7278 |
| 0, trim only | 0.2945 | 6.3233 |

The moon and stars lower the base: a649d39 measures mean ΔE 4.3370 before this change, which gives the full raise room again. The trim itself costs nothing measurable: on dab260e, α_W 0 gives 6.3233 against 6.3258 for the cypress fix alone.

Contrast at ground level (`scripts/village-contrast.ts`, the 0579a44 poses), 0579a44 → this build:

| Pose | Wall–ground ΔE | Roof–wall ΔE | Roof–ground ΔE | Wall L*, upper / lower half | Wall / ground L* |
| --- | --- | --- | --- | --- | --- |
| house 2, front | 23.7 → **23.5** | roof hidden | roof hidden | 48.9 / 52.8 | 51.3 / 33.2 |
| house 19, back | 21.0 → **20.9** | roof hidden | roof hidden | 48.6 / 48.3 | 48.5 / 33.3 |
| house 16, gable | 21.4 → **21.4** | roof hidden | roof hidden | 49.6 / 54.0 | 51.9 / 36.8 |
| house 0, roofs | 22.1 → **21.8** | 36.7 → **36.4** | 20.5 → **20.5** | 51.5 / 50.7 | 51.0 / 33.5 (roof 6.4) |
| church, back | 30.1 → **30.1** | nave roof hidden | nave roof hidden | 59.7 / 59.7 | 59.7 / 32.2 |
| church, front | 12.6 → **12.6** | nave roof hidden | nave roof hidden | 56.2 / 44.0 | 48.5 / 35.5 |

Per-building palettes are held until the village layout move (ruling Q32). On dad7f6d each building sampled the scan inside its own silhouette through the painter camera, but the seed-1 3D houses do not stand where the painted houses are. Their roofs project onto the cypress (houses 3-6), the bushes at the bottom left (house 2) and the hill band above the painted roofs (houses 7-19), while the painted houses Paul described stand at or below the church's base line. So the palettes sampled foliage and hills: roofs came out blue-grey, walls olive, 17 of 42 building roles fell back to a neighbour or the band tint, ground contrast fell at house 19's back (21.0 → 13.5) and house 0's roofs (roof–wall 36.7 → 14.2), and fidelity did not move (SSIM 0.2940, ΔE 7.0737 against 0.2946 and 7.0740). The palettes come back once the 3D houses sit on their painted counterparts.

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

- **Church front.** Wall–ground reaches 12.6 (11.2 before integration, 13.0 at 46eb08f) against the 15 target. The lift with the median pivot cannot go further, and a lower pivot would lift strokes the ruling counts as trim.
- **Fidelity margin.** On 46eb08f's base the house wall raise at α_W 1 left 0.12 of the ΔE margin (7.0740 against 7.1961). On dab260e (the cypress fix alone) α_W 1 broke it (7.4659). On a649d39 (the cypress fix with the moon and stars) α_W 1 gives 5.4771, leaving 1.72. See [Trim on every structure](#trim-on-every-structure-ruling-q31).
- **Upper wall hue.** The raise keeps the scan's a* and b*, so the raised walls stay bluer than the tint. Over the seed-1 painter-facing house-wall strokes in the top quarter, the scan-kept strokes average Lab (47.4, −0.6, −11.7) against the tint's (50.9, −6.3, −1.4): ΔE2000 11.2 from the tint, and 14.8 from the house 2 front ground against 24.6 for the tint. These figures were measured at α_W 1 on 46eb08f's base. A hue blend toward the tint would cost fidelity, and SCATTER_VERSION 11 leaves 1.72 of the ΔE margin.
- **Church trim darkness.** Resolved by ruling Q31: the outlines no longer stack `OUTLINE_DARKEN` on the trim ([Trim on every structure](#trim-on-every-structure-ruling-q31)).
- **Occluded faces.** Front faces hidden from the painter behind a nearer house keep the scan, and none of the poses measures one.

### Coverage and fidelity

| Gate | Before (fce5dab) | Q28 | Q30 | Q30 on the shared lift share (SCATTER_VERSION 7) | Wall raise and church trim (SCATTER_VERSION 8) | Wall raise and trim on every structure, on the cypress fix and the moon and stars (SCATTER_VERSION 11) |
| --- | --- | --- | --- | --- | --- | --- |
| `fidelity.spec.ts` SSIM (limit ≥ 0.2643) | 0.3202 | 0.3180 | 0.3176 | 0.3163 | 0.2946 | 0.3347 |
| `fidelity.spec.ts` mean ΔE2000 (limit ≤ 7.1961) | 5.7934 | 5.8433 | 5.9748 | 5.9204 | 7.0740 | 5.4771 |
| `world-coverage.spec.ts` max bare share (limit 0.5%) | 0.478% at village uphill (weighted 0.615%) | 0.478% at village uphill (weighted 0.608% at hill west, 0.582% at village uphill) | 0.478% at village uphill (weighted 0.608% at hill west, 0.583% at village uphill) | 0.451% at hill west and village uphill (weighted 0.604% at hill west, 0.555% at village uphill) | 0.451% at hill west and village uphill (weighted 0.604% at hill west, 0.555% at village uphill) | 0.451% at hill west (weighted 0.604% at hill west) |

The Q28 and Q30 columns were measured on fce5dab's base. There placement is bit-identical to before, so only colour at MSAA rims can move the bare count, and the maximum did not move. The before column was measured on the Q28 build with the tags removed, which reproduces fce5dab's scatter hash `177391e4`. The SCATTER_VERSION 7 column is the colours integrated onto the shared lift share, whose lift changes stroke depth, so its coverage moves too. The SCATTER_VERSION 8 column changes colour only, and its coverage did not move. The SCATTER_VERSION 11 column sits on the cypress palette fix and the moon and stars, and changes village colour only. All runs used headless Chromium on ANGLE Metal (Apple M4 Max). The Q30, integrated, SCATTER_VERSION 8 and 11 values are from `E2E_PORT=4297 make e2e` runs, 32 of 32, 37 of 37, 37 of 37 and 37 of 37 passed.

`docs/shots/village-tint.png` shows three ground-level poses, 46eb08f on the left and the house wall raise with the church trim on the right. From the top: house 2 front, house 16 gable, church front. It was captured on 46eb08f's base at α_W 1, before the cypress fix and the trim on every structure, and was not regenerated for SCATTER_VERSION 11.

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

The rings, rank reach, pins, counts and timings from here to "Pinned lights" describe the lights up to a649d39. "Brushwork matched to the dome" at the end of this section replaced the rings and holds the current figures.

### What changed

- `src/world/sky-lights.ts` places a disc of concentric rings of strokes at each of the 12 sky anchors (`skyAnchors()`). Each disc covers its regions.json circle (11 stars, 1 moon). Every stroke lies on the dome sphere along the painter's ray, faces the eye and runs along its ring. Brushes and the stroke layer come from the stars and moon region styles, so the strokes count as `star` and `moon`.
- Colours come from the full-resolution scan. `make bake` now also writes `public/paintings/starry-night/lights.webp`: a square of the 3840 × 3041 scan around each anchor, 1.1 radii each way, stacked top to bottom (`src/world/sky-scan.ts`). It is lossy WebP at quality 90 with smart chroma subsampling, 819 KB (lossless was 2.8 MB). Each stroke reads its colour there at its projected canvas uv, divided by `strokeShade`. frame.webp is 1024 px wide and blurred the crescent's edge. The extra fetch and decode raise the world's `decodeMs` from 85-93 ms to 119-123 ms (3 loads each from a local preview server).
- Star strokes are drawn 0.012 painting widths long on rings 0.005 apart. Moon strokes are half that, 0.006 on rings 0.0025 apart, so the crescent (about 0.02 painting widths thick) keeps its shape.
- The strokes sit in the dome's own chunks, which are always in the far band (size 1.6). The batch pins them (`isPinnedStroke` in `src/render/strokes/batch.ts`): each chunk orders its sky-light strokes (star or moon layer with `DEPTH_BACKDROP_FLAG`) first, then the rest, each group in importance order, and stores the light count as `pinned`. A band density draws `pinned + bandDrawCount(d, count - pinned)`, so every governor level draws every light and thins only the dome. A chunk with no lights orders and draws exactly as before, and a unit test pins that. The P1 canvas and the stroke test scene use the star and moon layers without the flag, so they are not pinned, and a unit test covers that too. Pinning adds no chunk and no draw call. `SKY_LIGHT_OVERDRAW` is 12, the quad overdraw as drawn at every density. At 8 the moon was solid (per-pixel ΔE 7.47 to 7.83 at the three densities) but dark gaps stayed between the star dabs, which 12 closes.
- The strokes carry `DEPTH_BACKDROP_FLAG`, and the vertex shader puts a flagged stroke on the star or moon layer in the reserved front tier at rank `1024 + (h >> 24)`, in front of every dome rank and behind the world. `?demo=canvas` draws those layers without the flag, at normal depth.
- Ranks are assigned greedily per disc. Each stroke takes the first rank, from a random start, that no earlier stroke within 1.3 longest drawn lengths holds. That is the distance at which two quads of the widest brush (aspect 0.833) can still touch corner to corner. At overdraw 12, at most 117 moon strokes (mean 104) and 121 star strokes (mean 90) sit within that reach of any stroke, so one of the 256 ranks is always free. If all 256 were held, the stroke would take its start rank and count a tie, which the world diag reports as `lightRankTies`. It is 0 at seeds 1 and 2, and a unit test asserts both and the fallback. The stored x coordinate then moves by the fewest float32 steps (micrometres) that make the position hash give that rank. A unit test finds 0 pairs sharing a rank among all pairs closer than 1.3 × 0.0138 painting widths (stars) or 1.3 × 0.0069 (moon). The first version of this change offset neighbouring rings by 85 ranks, which put every third ring one rank from a tie.
- The boundary haze (45-55 m, up to 45 m altitude) covers the painter's whole view of the sky below about 40° elevation, and the front tier draws behind it. The haze is now generated unchanged, and every haze stroke carries `SKY_LIGHT_CULL_FLAG` (iMeta.w bit 7, value 128, unused before). The vertex shader collapses a flagged stroke when its centre, seen from the eye of the view being drawn, lies inside one of 12 cones. Each cone is a disc's angular radius, out to its outermost ring plus half its longest stroke, plus asin of the haze stroke's drawn half diagonal over its distance, the widest angle any point of its quad can sit off its centre's ray (`src/render/strokes/sky-light-cull.ts`, uniform `uSkyLightCones`). Rim tests place a point just inside and just outside each cone from two eyes. The eye is three's `cameraPosition` uniform, which the renderer sets from each camera's `matrixWorld` in the same per-camera block as `viewMatrix`. Each XR eye is its own camera, so each culls for itself. The cull is the last statement of `main` and adds no draw call. The uniforms hold each disc's world centre and radius rather than a fixed direction and cosine, because a fixed direction holds only at the painter's spot. The shader derives the direction and the cosine of the cone per view. The CPU `exclude` path and `hidesSkyLight` are gone.
- For the largest haze stroke at 50 m (half diagonal margin, far-band size), the cones clear 0.435 sr (3.46% of all directions), of which the discs themselves take 0.158 sr. With each haze stroke's own half diagonal they cull 1,086 of the 30,000 haze strokes from the painter's spot, 1,137 from (20, 1.6, 0) and 633 from (0, 1.6, -30). The half-length margin of fix round 1 cleared 0.414 sr and culled 1,032, 1,083 and 605.
- 2026-11-06: the haze is no longer cleared with a hard edge. Inside each cone it still collapses, and past the cone it is now thinned over a feather of `SKY_LIGHT_FEATHER` (3) anchor radii plus one haze half diagonal, by shrinking each quad, so no rim shows in front of a disc (`src/render/strokes/sky-light-cull.ts`). The figures in the two bullets above are for the hard clear.
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

2026-11-06: the haze is no longer cleared with a hard edge. Inside each cone it still collapses, and past the cone it is now thinned over a feather of `SKY_LIGHT_FEATHER` (3) anchor radii plus one haze half diagonal, by shrinking each quad, so no rim shows in front of a disc (`src/render/strokes/sky-light-cull.ts`). The figures above are for the hard clear.

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

### Brushwork matched to the dome

Paul, in the headset at a649d39: the moon's strokes did not match the surrounding strokes, so it read as a flat disc. The rings above were 0.006 painting widths long on the moon and 0.012 on the stars, against about 0.05 for the dome strokes around them, all running along their ring and stopping at a hard circle.

What changed in `src/world/sky-lights.ts`:

- Size and brushes: every light stroke uses the dome's stroke size at the dome's radius (`strokeSizeAt(WORLD_DOME_SIZE, SKY_DOME_RADIUS)`, 3.97 m stored, the far band draws it 1.6 times larger), the scatter's ±15% length jitter and the sky region's brushes (comma, crescent, ridge). `WORLD_DOME_SIZE` in `world.ts` is the sky size the scatter resolves. The half-length moon strokes are gone.
- Finer strokes only at colour edges, for the stars: a stroke splits into four at half size, at most twice (`SKY_LIGHT_FINE_LEVELS`), where the scan's colour steps across its footprint. The step is the CIEDE2000 difference between the mean colours of the footprint's two halves, end against end or side against side, from 15 samples, and the threshold is 20 (`SKY_LIGHT_EDGE_DE`). By paint area the stars are 49% full size, 29% half and 22% quarter (435, 1,029 and 3,207 strokes), because a star is only one to three dome strokes across and its core's edge splits most of the strokes over it. A first version split on the largest difference from the footprint's mean. It split almost everything into quarter strokes, because brush texture and halo rings read as spread: at threshold 20, 94% of the star strokes were quarter size.
- The moon does not split (fix round 2). At threshold 20 it split only on its outer edge: the crescent's gold and the cream disc it bites into differ by about ΔE 14 in the scan, so the half means across the inner edge never reached 20, and the horns and the concave edge were lost (blurred moon ΔE 4.32). Fix round 1 lowered the moon's threshold to 7, which held the crescent (blurred ΔE 2.22) but put 62% of the moon's paint area at quarter size, with a disc median stroke of 0.0131 painting widths against the dome's 0.0503. That brought back the mismatch Paul reported. Ruling (coordinator, for Paul's complaint): stroke match wins over crescent sharpness. So every moon cell now holds a dome-size stroke, and the crescent's edges get extra quarter-size strokes on top (`SKY_LIGHT_MOON_EDGE_LEVEL` 2). They sit on their own jittered grid over the disc at quad overdraw 3 (`SKY_LIGHT_MOON_EDGE_OVERDRAW`) and are kept only where their footprint straddles the crescent's gold: at least 3 of its 15 samples have CIELAB b* over 50 (`SKY_LIGHT_GOLD_B`) and at least 3 do not. The gold reads b* 55 to 75 and the cream and the halo 35 to 45. An edge stroke takes the highest rank free of its neighbours, and every other light starts its rank search in the lower half, so the edge strokes draw over the dome-size moon strokes (a unit test checks every overlapping pair). The moon is 167 full-size and 97 edge strokes: 96.7% of its paint area is at full size, and the disc's median drawn length is 0.0432 painting widths, 14% under the dome's 0.0503. Overdraw 6 brought the blurred ΔE to 3.07 but put the disc median at a quarter stroke (0.0139). Half-size edge strokes at overdraw 3 read 3.51. Colouring each edge stroke from only its centre's side of the gold made no difference (3.37 against 3.32).
- Orientation from the flow field, as the dome: each stroke runs along `flow.png` at its uv (`cameraDirection`, now exported from `scatter.ts`). The choice rests on a structure tensor of the 3840 px scan (12 px cells, coherence weighted, `.superpowers/sdd/scan-tensor.ts`, not committed). Against the scan's own stroke direction, the flow field is off by 14.0° in the moon disc, 12.0° in its rim band and 36.9° outside it. Tangential to the anchor is off by 27.7°, 13.3° and 36.2°. For the stars the flow field is off by 20.2°, 23.2° and 26.3°, and tangential by 19.3°, 37.8° and 45.9°. The flow field is as good or better in every zone but the star discs, where it is 0.9° worse, and it is the field the dome uses.
- Colour: the mean of the scan at five points along the stroke's drawn length, from `lights.webp` and, past its 1.1-radius crops, from frame.webp. A point sample under a stroke this long painted whole strokes in the colour of a thin dark contour.
- No hard rim: strokes are placed on a jittered grid out to 1.5 anchor radii (`SKY_LIGHT_RIM`). Inside one radius every cell holds a stroke, and from there to 1.5 radii a stroke is kept with probability 1 − smoothstep(1, 1.5, ρ). The dome's strokes, in the tier behind, show through the gaps more and more. The halo colours come from the scan, like the disc's.
- Ranks: one picker for all 12 anchors, because neighbouring stars' reaches overlap, by up to 0.09 painting widths (stars 2 and 3). Two strokes can overlap only when their centres are closer than the sum of their drawn half diagonals, so the reach is per pair. The picker works in metres on the dome (fix round 1). The first version worked in painting widths with one metres-per-width per anchor, measured along u, but a painting width spans a different length on the dome in each direction (the review measured 118 to 142 m around the moon against 125.4, and 109 to 138 m around star 1 against 123.2), and the 1% margin did not cover that. Measured in metres from the stored positions and sizes, that version left 26 same-rank overlapping pairs at seed 1 and 29 at seed 2, though its own metric counted 0. A full-size stroke beside quarter-size ones can overlap more than 256 strokes in all, so the strokes are ranked full size first, then half, then quarter, and each takes a rank its already-ranked overlapping neighbours do not hold. Measured in metres, at most 92 already-ranked strokes overlap any stroke at seed 1 and 88 at seed 2, against 256 ranks. Among 173,865 overlapping pairs at seed 1 and 171,314 at seed 2 none shares a rank, and `lightRankTies` is 0 at both. The unit test measures this from the stored strokes alone (their positions, sizes and the shader's rank hash), independent of the generator's metric.
- Each grid cell's random numbers come from a hash of the anchor, the cell and its split path (fix round 1; the moon's edge grid has a path of its own), so one split that flips, for instance under a different image decoder, moves only the strokes of that cell, not every later stroke of the anchor.
- The haze cones reach the farthest dome point of the 1.5-radius rim plus the longest drawn stroke's half diagonal in metres.
- Pins: 4,935 light strokes, hash `1e63faa8` (6,485 and `6e5aa838` at fix round 1, 4,936 and `65f75ec3` before it, 12,294 and `da2a676f` before this change). World counts at seed 1: moon 264 and star 4,671. `world-coverage.spec.ts` asserts both counts in the browser, so the browser's image decoder must split the same strokes as sharp's. The scatter pin stays `cf326988` and the haze `49bf0339` (both e0eac54's), so SCATTER_VERSION stays 11: the lights are generated outside the scatter cache, and exporting `cameraDirection` changes no scatter output. `createSkyLights` takes 66 to 69 ms in Bun on this host (3 runs, seeds 1 and 2, 1-minute load about 11), against 41-46 ms before fix round 1 and about 92 ms at fix round 1. The metre picker searches 27 cells per stroke where the painting-width one searched 9, and the edge grid tests the crescent mask at each of its cells. The split of the cost was not profiled. The headset's `scatterMs` is still to be read on the Quest.

Stroke orientation and length around the anchors, from the stroke data (`.superpowers/sdd/brush-hist.ts`, not committed), seen from the painter's spot. "Off the scan" is the coherence-weighted mean angle to the scan's structure tensor at the stroke's uv, 0-90°. "Off tangential" gives the share per 15° bin. The tensor gives no stroke length, so the length reference is the dome's own strokes, as item 1 of the card asks. Disc is ρ < 1, rim 1 to 1.5 and outside 1.5 to 2.2 anchor radii.

| Zone | Strokes | Off the scan | Off tangential, % per 15° | Drawn length p10 / p50 / p90, painting widths |
| --- | --- | --- | --- | --- |
| Moon disc, scan | | | 39 / 25 / 13 / 12 / 6 / 5 | |
| Moon disc, a649d39 | 6,351 | 27.9° | 100 / 0 / 0 / 0 / 0 / 0 | 0.0053 / 0.0060 / 0.0067 |
| Moon disc, after | 197 | 13.6° | 61 / 17 / 12 / 5 / 2 / 3 | 0.0115 / 0.0432 / 0.0551 |
| Moon rim, scan | | | 69 / 24 / 3 / 1 / 0 / 2 | |
| Moon rim, a649d39 (dome only) | 469 | 10.9° | 90 / 8 / 0 / 1 / 1 / 0 | 0.0441 / 0.0507 / 0.0565 |
| Moon rim, after (lights over the dome) | 67 | 11.5° | 90 / 10 / 0 / 0 / 0 / 0 | 0.0444 / 0.0508 / 0.0569 |
| Moon outside, dome | 1,045 | 22.3° | 69 / 13 / 4 / 4 / 5 / 4 | 0.0443 / 0.0503 / 0.0565 |
| Star discs, scan | | | 56 / 24 / 10 / 4 / 3 / 3 | |
| Star discs, a649d39 | 5,943 | 19.5° | 100 / 0 / 0 / 0 / 0 / 0 | 0.0106 / 0.0120 / 0.0134 |
| Star discs, after | 3,358 | 20.6° | 66 / 22 / 5 / 3 / 2 / 2 | 0.0094 / 0.0116 / 0.0234 |
| Star rims, after | 1,313 | 21.3° | 44 / 21 / 12 / 7 / 6 / 10 | 0.0093 / 0.0119 / 0.0393 |
| Star outside, dome | 4,200 | 20.7° | 22 / 19 / 18 / 14 / 13 / 14 | 0.0351 / 0.0410 / 0.0492 |

The moon disc's strokes are 13.6° off the scan's direction, against 27.9° for the rings, and their spread off tangential follows the scan's, where the rings were all tangential. Their median length is 0.0432 painting widths, 14% under the dome's 0.0503: the disc holds about 100 dome-size strokes and the 97 quarter-size edge strokes. The count is bimodal, so the median lands on the shortest dome-size stroke and only just clears the 20% target. By count about half the disc's strokes are quarter size, while by paint area 96.7% is full size. The rim band holds only dome-size strokes (median 0.0508). The stars stay short: by stroke count most star strokes are quarter size, for the reason given above. Their direction is about as far off the scan as before (20.6° against 19.5°), and no longer all tangential. These figures come from probes under `.superpowers/sdd/` (`scan-tensor.ts`, `brush-hist.ts`), which are not committed.

Painter view, `?painting=starry-night&diag&shot&noanim&seed=1&painter` at 1280 × 1014, production builds served by `vite preview`, far density forced in the build as above. The branch is rebased onto e0eac54 (the wall raise, the trim on every structure and the building under-paint), and before is e0eac54 itself.

| Far density | Build | Moon per-pixel ΔE2000 | Moon, blurred σ 3 px | Moon block (14, 2) | Stars per-pixel ΔE2000 | SSIM | Mean ΔE2000 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | after | 6.49 | 3.32 | 0.51 | 12.80 | 0.3405 | 5.4558 |
| 1 | 9fa50c7 (moon threshold 20) | 7.28 | 4.32 | 0.43 | 12.82 | 0.3396 | 5.4160 |
| 1 | bd6fd20 (moon threshold 7) | 5.64 | 2.23 | 0.17 | 12.82 | 0.3478 | 5.4250 |
| 0.4 (default) | e0eac54 | 6.18 | 2.12 | 1.05 | 13.38 | 0.3347 | 5.4964 |
| 0.4 (default) | 9fa50c7 (moon threshold 20) | 7.28 | 4.32 | 0.43 | 12.83 | 0.3391 | 5.3854 |
| 0.4 (default) | bd6fd20 (moon threshold 7) | 5.65 | 2.22 | 0.17 | 12.85 | 0.3494 | 5.4228 |
| 0.4 (default) | after | 6.49 | 3.32 | 0.52 | 12.83 | 0.3420 | 5.4495 |
| 0.1 (floor) | e0eac54 | 6.21 | 2.21 | 1.10 | 13.32 | 0.3222 | 5.3779 |
| 0.1 (floor) | after | 6.46 | 3.29 | 0.52 | 12.77 | 0.3298 | 5.3158 |

The moon stays under the ≤ 10 bar at density 1 and at the floor: per-pixel ΔE 6.49 and 6.46, against 6.18 and 6.21 for e0eac54's rings. Blurred by σ 3 px it reads 3.32 at the default, over the 3.0 aim: dome-size strokes still carry gold past the crescent's edges, and the edge strokes on top recover part of it (4.32 without them, 2.22 with the moon split to quarters). The block ΔE falls from 1.05 to 0.52. In the shot the crescent's concave edge and its horns show from the painter's spot and from 20 m east, softer than in the scan. At the default and the floor, SSIM rises by 0.007 and 0.008 over e0eac54, and mean ΔE falls by 0.047 and 0.062. There is no e0eac54 measurement at density 1. Before the rebase, on a649d39, the threshold-20 version read SSIM 0.3573 to 0.3617 and mean ΔE 4.3370 to 4.2260 at the default. The absolute SSIM and mean ΔE values differ from the tables above, which were measured on earlier bases.

The stars are drawn as at threshold 20, apart from the per-cell random numbers and the lower-half rank starts. Fix round 2 leaves them as at fix round 1. Their cores (mean L* inside 0.25 anchor radii, painter view) are within 5.1 of the scan's for every star. The core of star 6, right of the central swirl (left of the moon in the shot), reads 64.6 against the scan's 68.0 and the rings' 69.7, so it is a little dimmer than in the painting.

Moon quad overdraw, rasterized as above at 3840 px per painting width: inside the circle mean 11.6, min 4, max 21 (a649d39 and e0eac54: 11.2, 3, 19). In the rim band from 1 to 1.25 radii mean 8.5, min 2, max 16 (before: 0.3). From 1.25 to 1.5 radii mean 3.6, min 0, max 11 (before: 0). The lights taper into the dome instead of stopping at the circle. 264 moon strokes are drawn, against 6,351 before.

`E2E_PORT=4301 make e2e` on fix round 2: 37 passed, exit 0, 1-minute load 11.75 before and 10.42 after. `fidelity.spec.ts` reads SSIM 0.3420 and mean ΔE2000 5.4495. `world-coverage.spec.ts` reads max bare 0.451% at hill west (weighted 0.604%), as for SCATTER_VERSION 11 on main, so the wider haze cones uncover no bare dome. Its boot test reads moon 264 and star 4,671 from `__goghDiag()`, the unit pins. At bd6fd20 (fix round 1) the run read the same coverage with SSIM 0.3494 and mean ΔE 5.4228, and at 9fa50c7 SSIM 0.3391 and mean ΔE 5.3854.

Draw calls with `?nogov`: 147 at the painter view and 128 at (20, 1.6, 0) facing the moon, for both e0eac54 and this change (and for a649d39 before the rebase). Pinning still adds no chunk, and the lights stay in the dome's chunks.

`docs/shots/moon-brushwork.png`, columns scan, e0eac54 and this change (fix round 2). Top: the painter view at 2.2 moon radii. Middle: from (20, 1.6, 0), 20 m east of the painter's spot, facing the moon (the scan column shows the painting at 4 radii, for context). Bottom: the moon's lower-left rim band, about 0.6 to 1.6 radii, at 4×.

![Moon brushwork: scan, e0eac54 and after, at the painter's spot, 20 m east and at the rim](shots/moon-brushwork.png)

## Building z-fighting report (dab260e)

Paul reported "lots of z-fighting on buildings" in the headset on dab260e. The diagnosis was run on a649d39 (origin/main) against 6dbfc09, the strobe fix, with the scratch probes in `.superpowers/sdd/bz/` (not committed). It used 16 ground-level poses at 3 to 25 m from house 6, house 2 and the church: facing the walls and at grazing angles, headless Chromium on ANGLE Metal (Apple M4 Max), 1280 × 1014, seed 1, `?nogov&nocache&noanim`.

### Diagnosis

No systematic depth regression since 6dbfc09 was found, with one local exception at h6-face-3m, below:

- 46eb08f (village colours) changes colour only, and placement is bit-identical.
- The outline strokes never change winner under a shift, at any pose.
- a649d39's pinned prefix in `batch.ts` holds only the star and moon strokes.
- The `stroke.vert.glsl` changes since 6dbfc09 are the moon and star front tier inside the backdrop branch, and the sky-light cull behind `SKY_LIGHT_CULL_FLAG`, which only the boundary haze carries. Neither reaches a village stroke.
- 2026-11-06: the haze is no longer cleared with a hard edge. Inside each cone it still collapses, and past the cone it is now thinned over a feather of `SKY_LIGHT_FEATHER` (3) anchor radii plus one haze half diagonal, by shrinking each quad, so no rim shows in front of a disc (`src/render/strokes/sky-light-cull.ts`). It too reaches only strokes with `SKY_LIGHT_CULL_FLAG`.

An id build, each stroke coloured by its layer, shifts the camera 0.1 mm and counts the pixels whose winning surface changes. Its per-layer shares are the same on both commits to within 0.03 points of the frame at 14 of the 16 poses. The two exceptions are a649d39's wall share at h6-face-3m (0.329 against 0.255) and its ground share at h2-face-7m (0.361 against 0.166).

The h6-face-3m rise reproduces exactly on two more runs of each build:

- 0.260% of the frame flips on both commits.
- 0.075% flips only on a649d39, and 0.001% only on 6dbfc09.
- The a649d39-only flips sit in two small clusters about 30 px across, each the overlap of one wall stroke pair. A few wall pairs have become near-ties.

Its cause was not found, and the fix below does not address it.

The colour flicker under the same shift is lower on a649d39 at 15 of the 16 poses. The exception is h2-face-7m, whose rise (clustered 0.038 to 0.224) is a ground patch, not a building.

The building fights that remain are the old residual: two wall strokes whose lift shares nearly match. These fights are smallest where the 0.25 m range cap binds, beyond about 14 m. A 4× range removes most of their clustered flips, but those flips are only 0.01 to 0.03% of the frame.

What changed is what a gap between strokes looks like:

- 46eb08f paints the house walls in pale tints, which measure Rec. 709 luma 111 against 63 before. Each stroke's colour is `jitterTint` around its owner's tint, mixed toward the scan by `SEEN_TINT_BLEND` where the face is turned toward the painter (a649d39 `src/render/strokes/scatter.ts:443-456`). The tags come from `src/world/village.ts:598-607`.
- The base meshes under the strokes stayed at the region mean × `UNDERPAINT_SHADE` 0.6, luma 47 (a649d39 `src/paintings/starry-night/base-meshes.ts:23` and `baseColor` at `:53`).
- A gap between wall strokes therefore reads as a dark speck where it used to read as a slightly darker wall.

The gaps move whenever the stroke set changes, so they flash. That happens at a band switch, at 6 m on the 24 m chunks (`NEAR_BAND_MAX_M`, `src/render/strokes/bands.ts:11`; density 1 to 0.9, size × 1.05), and when the governor sheds near density in XR. The desktop probe forces the near band from 1 to 0.9 and counts the building pixels that go from light (luma > 90) to dark (< 60).

The 6 m band switch, the governor's oscillation in the headset, and XR stereo were not measured. The depth buffer is 24-bit in XR, against the desktop default, which was not compared either.

### Fix

`createBaseMeshes` takes the scatter seed, and each tinted village triangle under-paints in its owner's tint (`pickTint`, the same pick its strokes jitter around) × `TINT_UNDERPAINT_SHADE` 0.85, as vertex colours. Other layers keep the region mean × 0.6. This is base mesh only, so the scatter output, its hash and `SCATTER_VERSION` do not change, and the debug paint stays flat magenta.

### Measured

Each cell is % of the frame, before (a649d39) and after.

- Colour flips: 0.1 mm shift, summed RGB difference > 24.
- Clustered: at least 4 of 8 neighbours flipped.
- Id flips: the a649d39 id build's winner changes for wall, roof, church, outline and ground, with the 6dbfc09 values after the slash.
- Density step: building pixels that go from light to dark between near density 1 and 0.9.

| Pose | Colour flips 6dbf / a649 / fix | Clustered 6dbf / a649 / fix | Id flips a649 (wall, roof, church, outline, ground) / 6dbf | Density step light-to-dark 6dbf / a649 / fix |
| --- | --- | --- | --- | --- |
| h6-face-3m | 0.230 / 0.086 / 0.081 | 0.048 / 0.018 / 0.018 | 0.329, 0.038, 0, 0, 0.025 / 0.255, 0.037, 0, 0, 0.037 | 0.386 / 0.172 / 0.012 |
| h6-face-7m | 0.319 / 0.166 / 0.165 | 0.025 / 0.012 / 0.012 | 0.015, 0.011, 0, 0, 0.066 / 0.015, 0.010, 0, 0, 0.074 | 0.028 / 0.007 / 0.003 |
| h6-face-15m | 0.517 / 0.485 / 0.486 | 0.089 / 0.078 / 0.078 | 0.055, 0.019, 0.006, 0, 0.572 / same to 0.001 | 0.045 / 0.013 / 0.011 |
| h6-face-25m | 0.186 / 0.177 / 0.177 | 0.023 / 0.016 / 0.016 | 0, 0, 0, 0, 0.235 / 0, 0, 0, 0, 0.238 | 0 / 0 / 0 |
| h6-graze-6m | 0.211 / 0.112 / 0.110 | 0.047 / 0.025 / 0.025 | 0.160, 0.004, 0, 0, 0.070 / 0.146, 0.004, 0, 0, 0.070 | 0.230 / 0.071 / 0.001 |
| h6-graze-15m | 0.269 / 0.228 / 0.227 | 0.051 / 0.032 / 0.032 | 0.052, 0.019, 0, 0, 0.257 / 0.066, 0.019, 0, 0, 0.256 | 0.098 / 0.028 / 0.009 |
| h2-face-3m | 0.113 / 0.056 / 0.054 | 0.003 / 0.001 / 0.001 | 0.095, 0.081, 0, 0, 0.053 / 0.073, 0.054, 0, 0, 0.053 | 0.758 / 0.118 / 0.005 |
| h2-face-7m | 0.190 / 0.357 / 0.354 | 0.038 / 0.224 / 0.224 | 0.072, 0.053, 0.002, 0, 0.361 / 0.054, 0.057, 0.002, 0, 0.166 | 0.220 / 0.073 / 0.038 |
| h2-face-15m | 0.251 / 0.220 / 0.219 | 0.032 / 0.021 / 0.020 | 0.051, 0.032, 0.004, 0, 0.258 / same to 0.003 | 0.056 / 0.015 / 0.007 |
| h2-face-25m | 0.325 / 0.283 / 0.283 | 0.066 / 0.052 / 0.052 | 0.062, 0.040, 0.004, 0, 0.298 / same to 0.003 | 0.023 / 0.006 / 0.003 |
| h2-graze-6m | 0.196 / 0.178 / 0.177 | 0.018 / 0.017 / 0.017 | 0.048, 0.018, 0, 0, 0.164 / 0.031, 0.017, 0, 0, 0.164 | 0.077 / 0.058 / 0.000 |
| h2-graze-15m | 0.189 / 0.179 / 0.179 | 0.026 / 0.022 / 0.022 | 0.011, 0.014, 0, 0, 0.184 / 0.017, 0.014, 0, 0, 0.186 | 0.027 / 0.037 / 0.007 |
| church-face-7m | 0.086 / 0.081 / 0.079 | 0.001 / 0.001 / 0.001 | 0.035, 0.005, 0.045, 0, 0.041 / same to 0.001 | 0.073 / 0.351 / 0.278 |
| church-face-15m | 0.088 / 0.083 / 0.083 | 0.007 / 0.007 / 0.007 | 0.110, 0.004, 0.012, 0, 0.049 / same | 0.200 / 0.202 / 0.186 |
| church-face-25m | 0.174 / 0.114 / 0.112 | 0.038 / 0.017 / 0.017 | 0.148, 0.004, 0.004, 0, 0.074 / same to 0.001 | 0.194 / 0.071 / 0.040 |
| church-graze-10m | 0.092 / 0.040 / 0.035 | 0.003 / 0.003 / 0.003 | 0.107, 0, 0.006, 0, 0.008 / 0.107, 0.001, 0.006, 0, 0.008 | 1.024 / 0.084 / 0.029 |

The fix leaves the shift flicker where it was, which is expected, since the base meshes play no part in a fight between two strokes. The light-to-dark change falls at every house pose, 0.172 to 0.012 at h6-face-3m and 0.118 to 0.005 at h2-face-3m.

The church front at 7 m is not fixed. It keeps most of its rise, 0.351 to 0.278 against 0.073 on 6dbfc09. By the id capture, those pixels are church (2,623), outline (627) and window (353) pixels whose replacement averages RGB (31, 39, 63). A gap to the church wall's new under-paint, RGB (119, 126, 133) at about luma 125, cannot pass the < 60 test. The result is consistent with dark church strokes showing under the lifted pale strokes painted toward the painter (ruling Q30). It is not settled, though. The nave roof's under-paint, RGB (24, 24, 31), could pass the test, and no `?coverage` capture was taken to rule it out.

Painter-view fidelity (`scripts/fidelity.ts`, production build): SSIM 0.3573 to 0.3571 (limit ≥ 0.2643), mean ΔE2000 4.3370 to 4.3490 (limit ≤ 7.1961).

The `E2E_PORT=4291 make e2e` run on the fix passed 37 of 37. Its `fidelity.spec.ts` read SSIM 0.3571 and mean ΔE2000 4.3490. Its `world-coverage.spec.ts` maximum bare share was 0.451% at hill west (weighted 0.604%), against the 0.5% limit. The coverage sweep paints the base magenta, so the fix cannot move it.

The light-to-dark measure is the gap colour the fix changes, so it shows the gaps read less, not that the headset flicker is gone. The headset check is Paul's.

`docs/shots/building-zfight.png` shows church-face-7m and h6-face-3m at near density 0.9, before on the left and after on the right, with the building pixels that went from light to dark marked red.

![Church front at 7 m and house 6 at 3 m, before and after, light-to-dark pixels in red](shots/building-zfight.png)

## Headset shimmer diagnosis (2026-11-06, on 6d82235)

Paul saw a lot of z-fight on the ground, the buildings and the sky on the Quest 3. It looked the same whether he moved or held still. No fix is applied here. The evidence below does not support a depth-separation change within the Q21 cap (the 2 m cap does reach the nowrite bound). The one change that would cut stroke depth ties is a wider tie-break cap, and that reverses ruling Q21, so it is Paul's call.

### Diagnostics added

- `?zdiag=<mode>` (`src/render/zdiag.ts`, parsed in `src/diag/flags.ts`) applies one change through three's materials, atlas and render order. It is honoured in production like `?slow`. `__goghDiag().zdiag` is `{ mode, applied, frozen }`.
- The modes:
  - `nowrite`: strokes drop depthWrite and draw after the base meshes, back to front by chunk.
  - `strokeorder`: strokes test depth ALWAYS with depthWrite on and draw before the base meshes. This is the live headset A/B.
  - `paintorder`: `strokeorder` with the chunks drawn back to front.
  - `nosort`: each chunk keeps its first frame's render order.
  - `noa2c`: strokes drop alpha-to-coverage and discard below alpha 0.5.
  - `sharp`: strokes keep alpha-to-coverage, and the R3 coverage sharpening runs at twice its gain, so the rim is half a pixel wide (Sharper alpha-to-coverage, below).
  - `sharp4`: `sharp` at four times the R3 gain, a quarter-pixel rim.
  - `nomip`: the brush atlas samples mip 0 only.
  - `mip`: trilinear mips plus the GPU's largest anisotropy.
  - `freeze`: XR only. Every frame renders with the first presenting frame's eye poses and projections. Not yet run in a headset or IWER.
- `StrokeBatch.setOrderPolicy` (`batch.ts`) carries the render order changes.
- `scripts/shimmer-probe.ts <base-url> [frames] [modes] [norot]` renders 8 frames per pose. Each frame jitters the eye by ±(0.1-0.3) mm per axis and up to ±0.01° of yaw and pitch, from a fixed seed. It reports per-pixel temporal flicker (`temporalFlicker` in `scripts/zfight-lib.ts`) as three numbers, all as % of the frame:
  - flicker: pixels that change by more than 24 summed RGB between any two consecutive frames;
  - per frame: the mean share that changes per frame;
  - clustered: flickering pixels with at least 4 of their 8 neighbours flickering too. A depth fight flips patches, while edge resampling flips 1 px lines.
- `norot` drops the rotation jitter.
- The runs used a production build served by `vite preview`, on headless Chromium on ANGLE Metal (Apple M4 Max) at 1280 × 1014, with `?painting=starry-night&diag&shot&nogov&nocache`. The 1-minute load average was 11-15. An unmoved repeat changed nothing at any pose.

### The live strokeorder A/B hid the world strokes

The chunks draw front to back, so the sky dome's chunks draw last. Under depthFunc ALWAYS their far-plane depth is the last write at almost every pixel. The base meshes then draw at render order 1e6, pass the depth test, and paint flat over every ground, building, cypress and ridge stroke. Only the dome above the ridge keeps its strokes. The shimmer was gone in the headset because the ground and buildings were flat base meshes. That A/B does not show that stroke-against-stroke depth ties cause the ground and building shimmer. Its sky observation still counts.

Painter view, base on top and `strokeorder` below:

![Base and zdiag=strokeorder, painter view](shots/shimmer-strokeorder.jpg)

`nowrite` (top) and `paintorder` (below) keep the world strokes visible. They remove stroke-against-stroke depth tests, at the cost of wrong occlusion at chunk seams. For example, dome strokes paint over the far hills, and wall strokes partly cover the lit windows:

![zdiag=nowrite and zdiag=paintorder, painter view](shots/shimmer-nowrite-paintorder.jpg)

### Flicker per mode

With rotation and translation jitter, 8 frames: flicker / per frame / clustered (% of frame).

| Mode | ground (pitch −0.45) | paul-strobe1 | village | wall (house 11, 6 m) | ridge | sky (pitch +0.5) |
| --- | --- | --- | --- | --- | --- | --- |
| base | 10.09 / 4.32 / 2.83 | 10.83 / 4.56 / 2.88 | 10.35 / 4.22 / 2.88 | 3.56 / 1.37 / 0.71 | 9.47 / 3.71 / 2.22 | 6.93 / 2.54 / 1.16 |
| strokeorder (world strokes hidden) | 0.66 / 0.24 / 0.14 | 1.05 / 0.38 / 0.15 | 3.18 / 1.16 / 0.48 | 1.73 / 0.62 / 0.18 | 2.92 / 1.04 / 0.41 | 5.28 / 1.92 / 0.62 |
| paintorder | 8.70 / 3.68 / 1.91 | 9.16 / 3.78 / 1.82 | 8.62 / 3.42 / 1.76 | 3.29 / 1.28 / 0.47 | 8.70 / 3.35 / 1.57 | 7.07 / 2.60 / 1.00 |
| nowrite | 9.30 / 3.97 / 2.15 | 9.87 / 4.14 / 2.17 | 9.46 / 3.83 / 2.21 | 3.27 / 1.27 / 0.48 | 8.83 / 3.42 / 1.67 | 7.06 / 2.59 / 0.98 |
| nosort | same as base to 0.001 | | | | | |
| noa2c | 6.61 / 2.64 / 0.57 | 6.60 / 2.64 / 0.62 | 6.91 / 2.64 / 0.63 | 2.76 / 1.01 / 0.31 | 5.83 / 2.17 / 0.46 | 4.73 / 1.65 / 0.24 |
| nomip | 10.57 / 4.36 / 2.12 | 11.29 / 4.57 / 2.38 | 11.20 / 4.35 / 2.45 | 4.69 / 1.63 / 0.82 | 10.72 / 3.97 / 2.04 | 9.51 / 3.17 / 1.49 |
| mip (anisotropy) | 10.06 / 4.39 / 2.70 | 10.75 / 4.62 / 2.72 | 10.35 / 4.28 / 2.77 | 3.59 / 1.37 / 0.66 | 9.36 / 3.74 / 2.04 | 7.01 / 2.57 / 1.09 |

The same with translation jitter only (`norot`):

| Mode | ground | paul-strobe1 | village | wall | ridge | sky |
| --- | --- | --- | --- | --- | --- | --- |
| base | 4.92 / 2.14 / 0.99 | 3.98 / 1.66 / 0.80 | 2.82 / 1.29 / 0.61 | 0.76 / 0.34 / 0.17 | 1.28 / 0.55 / 0.19 | 0.58 / 0.27 / 0.14 |
| paintorder | 3.76 / 1.63 / 0.47 | 2.71 / 1.14 / 0.30 | 1.58 / 0.74 / 0.09 | 0.52 / 0.23 / 0.05 | 0.76 / 0.33 / 0.01 | 0.39 / 0.19 / 0.002 |
| nowrite | 4.22 / 1.83 / 0.57 | 3.31 / 1.39 / 0.46 | 2.14 / 0.99 / 0.24 | 0.51 / 0.23 / 0.05 | 0.85 / 0.36 / 0.04 | 0.39 / 0.19 / 0.001 |
| noa2c | 2.86 / 1.22 / 0.36 | 2.33 / 0.94 / 0.28 | 1.80 / 0.81 / 0.30 | 0.64 / 0.29 / 0.17 | 0.82 / 0.35 / 0.13 | 0.46 / 0.22 / 0.13 |
| nomip | 4.50 / 2.02 / 0.73 | 3.62 / 1.57 / 0.61 | 2.71 / 1.26 / 0.55 | 0.78 / 0.34 / 0.17 | 1.30 / 0.56 / 0.20 | 0.62 / 0.29 / 0.14 |

Depth separation sweeps on base, with rotation (shader constants only, reverted):

| Build | ground | paul-strobe1 | village | wall | ridge | sky |
| --- | --- | --- | --- | --- | --- | --- |
| 2048 steps, 0.25 m cap (shipped) | 10.09 / 4.32 / 2.83 | 10.83 / 4.56 / 2.88 | 10.35 / 4.22 / 2.88 | 3.56 / 1.37 / 0.71 | 9.47 / 3.71 / 2.22 | 6.93 / 2.54 / 1.16 |
| 16384 steps, 0.25 m cap | 9.72 / 4.14 / 2.59 | 10.64 / 4.48 / 2.78 | 10.07 / 4.09 / 2.67 | 3.40 / 1.32 / 0.61 | 9.46 / 3.71 / 2.23 | 6.89 / 2.53 / 1.14 |
| 16384 steps, 2 m cap (6 frames) | 8.92 / 3.34 / 2.08 | 9.67 / 3.68 / 2.14 | 9.36 / 3.55 / 2.25 | 3.09 / 1.16 / 0.47 | 8.79 / 3.34 / 1.74 | 6.67 / 2.49 / 0.97 |

### Findings

- **F1. Most of the desktop flicker is resampling, not depth.** Removing stroke-against-stroke depth tests outright (`paintorder`, `nowrite`) cuts total flicker by only 8-25% under rotation jitter. A 0.01° turn moves the image about 0.13-0.15 px near the view centre (1014 px frame height, f = 507 / tan(FOV/2) px: 0.15 px at the 60° painter FOV, 0.13 px at the 70° default FOV). The dense, high-contrast stroke edges then change one or more of their 4 MSAA samples, which crosses the 24-level threshold. No depth or sort change can remove that, and mips and anisotropy do not move it.
- **F2. Depth ties are real and show as clustered patches.** With translation jitter only, removing the depth tests drops clustered flicker as follows:
  - sky: 0.14 to 0.002;
  - ridge: 0.19 to 0.01-0.04;
  - village: 0.61 to 0.09-0.24;
  - wall: 0.17 to 0.05;
  - near ground: 0.99 to 0.47-0.57.

  These are the overlapping-stroke fights the earlier probes found. They are small against F1 in total pixels, but they flip whole patches, which reads as z-fight.
- **F3. Separation helps only with a wider cap.** Eight times the steps alone barely moves clustered flicker, because past 14 m the 0.25 m cap binds and the steps do not reach it. With a 2 m cap, clustered flicker reaches the `nowrite` bound at every pose (ground 2.83 to 2.08, against `nowrite`'s 2.15). That cap lets separate surfaces up to 2 m apart trade places. The stroke flicker section measured 0.41% of the far village swapping surfaces at 0.25 m, 0.78% at 0.5 m and 1.78% at 1.5 m, and ruling Q21 chose 0.25 m. Raising it is Paul's decision.
- **F4. Alpha-to-coverage drives much of the near-ground patching.** `noa2c` cuts ground clustered flicker from 2.83 to 0.57 with rotation and from 0.99 to 0.36 without, more than removing depth tests does. The sharpened coverage (ruling R3) gives every bristle gap a 1 px a2c rim, and those rims re-dither as the view moves. Apple and Adreno lay out a2c sample masks differently, so this is the result most likely to differ in the headset.
- **F5. The sky's remaining depth fight is probably the backdrop rank (hypothesis, not tested).** About 277 dome strokes share each of the 1024 ranks, and same-rank pairs tie at one NDC z (Sky dome strokes, above). The 0.25 m cap does not touch them.
- `nosort` changes nothing, so the chunk sort is stable for a still eye. `nomip` is worse everywhere, and `mip` (anisotropy) changes nothing.

### Sharper alpha-to-coverage (`?zdiag=sharp` and `sharp4`, 2026-11-06, on e5c1cf0)

The brief for this run proposed Ben Golus's sharpened alpha-to-coverage, `alpha = (a − 0.5) / max(fwidth(a), 1e-4) + 0.5`, as the middle ground between base and `noa2c`. Base already is that formula. `stroke.frag.glsl` has computed it since the stroke core (a29943d, ruling R3), so base is sharpened a2c with a rim 1 px wide on an axis-aligned edge and √2 px on a diagonal (`fwidth` is |dx| + |dy|). `sharp` therefore tests the next step: the same formula at twice the gain (`… * float(ZDIAG_SHARP_GAIN) + 0.5` with the define at 2), which halves the rim. `sharp4` sets it to 4, a quarter-pixel rim. Raising the gain further tends to `noa2c`'s cut-out, still with a2c on.

No `sharpmip` mode was added, because the atlas mips do not thin the coverage. A CPU model of the mip chain (a 2 × 2 box filter of the coverage channel, which is what `generateMipmap` usually does, although WebGL leaves the filter to the implementation) keeps the area above coverage 0.5, summed over the 16 brushes, within 1.2% of mip 0 through mip 5, and the mean coverage within 0.1% at every level. Per brush the area stays within 4% through mip 4 and spreads to 0.86-1.07 of mip 0 at mip 5 (about a 15 px stroke), in both directions, so it does not thin systematically. The brushes are solid shape masks, not thin bristles, so the 0.5 contour survives the box filter. Mip 6 is the first level where nearly every brush thins, by 12% on average and 27% at worst (brush 5), and a stroke reaches it only when its 480-texel brush is drawn about 7.5 px long.

Flicker / per frame / clustered (% of frame), 8 frames, the same poses, URL and build path as above (production build, `vite preview`, headless Chromium on ANGLE Metal, Apple M4 Max). The `sharp4` rows were first measured from a temporary shader edit, and the committed mode reproduced them to three decimals. The 1-minute load average was 20-35, over the 15 bar, but the metric is pixel content at fixed poses rather than timing, and base reproduced the earlier table to three decimals.

With rotation and translation jitter:

| Mode | ground | paul-strobe1 | village | wall | ridge | sky |
| --- | --- | --- | --- | --- | --- | --- |
| base (R3, gain 1) | 10.09 / 4.32 / 2.83 | 10.83 / 4.56 / 2.88 | 10.35 / 4.22 / 2.88 | 3.56 / 1.37 / 0.71 | 9.47 / 3.71 / 2.22 | 6.93 / 2.54 / 1.16 |
| sharp (gain 2) | 8.70 / 4.04 / 1.35 | 9.26 / 4.30 / 1.48 | 9.08 / 3.98 / 1.55 | 3.25 / 1.34 / 0.44 | 8.09 / 3.52 / 1.12 | 6.20 / 2.45 / 0.48 |
| sharp4 (gain 4) | 7.71 / 3.61 / 0.84 | 8.03 / 3.83 / 0.93 | 8.11 / 3.61 / 1.00 | 3.05 / 1.26 / 0.36 | 7.04 / 3.16 / 0.70 | 5.59 / 2.28 / 0.32 |
| noa2c | 6.61 / 2.64 / 0.57 | 6.60 / 2.64 / 0.62 | 6.91 / 2.64 / 0.63 | 2.76 / 1.01 / 0.31 | 5.83 / 2.17 / 0.46 | 4.73 / 1.65 / 0.24 |

With translation jitter only (`norot`):

| Mode | ground | paul-strobe1 | village | wall | ridge | sky |
| --- | --- | --- | --- | --- | --- | --- |
| base | 4.92 / 2.14 / 0.99 | 3.98 / 1.66 / 0.80 | 2.82 / 1.29 / 0.61 | 0.76 / 0.34 / 0.17 | 1.28 / 0.55 / 0.19 | 0.58 / 0.27 / 0.14 |
| sharp | 4.31 / 2.02 / 0.60 | 3.53 / 1.59 / 0.49 | 2.60 / 1.24 / 0.47 | 0.74 / 0.33 / 0.17 | 1.24 / 0.54 / 0.17 | 0.56 / 0.27 / 0.14 |
| sharp4 | 3.72 / 1.81 / 0.44 | 3.13 / 1.45 / 0.37 | 2.36 / 1.16 / 0.38 | 0.73 / 0.34 / 0.17 | 1.21 / 0.53 / 0.15 | 0.57 / 0.27 / 0.14 |
| noa2c | 2.86 / 1.22 / 0.36 | 2.33 / 0.94 / 0.28 | 1.80 / 0.81 / 0.30 | 0.64 / 0.29 / 0.17 | 0.82 / 0.35 / 0.13 | 0.46 / 0.22 / 0.13 |

- `sharp` cuts the clustered flicker, the patch flips that read as z-fight, by about half: ground 2.83 to 1.35 and sky 1.16 to 0.48 with rotation. `sharp4` takes it to 0.84 and 0.32, against `noa2c`'s 0.57 and 0.24.
- Per-frame flicker falls much less (ground 4.32 to 4.04), so most of F1's single-pixel edge resampling stays while a2c is on.
- With translation only, `sharp` leaves the wall, ridge and sky clustered flicker where base has it. Those patches are F2's depth ties, which coverage does not touch.
- Fidelity (`scripts/fidelity.ts --url` with `?painting=starry-night&diag&shot&noanim&seed=1&painter&zdiag=sharp`): SSIM 0.3415 and mean ΔE2000 5.4522, and with `zdiag=sharp4` SSIM 0.3412 and 5.4514, all inside SSIM ≥ 0.2643 and ΔE ≤ 7.1961. Base on the same build read 0.3420 and 5.4495.

Stills at the ground and sky poses. The rows are base, `noa2c`, `sharp` and `sharp4`. Each row shows the full frame at half size on the left, and a 4x nearest-neighbour crop of the 160 × 128 px at the view centre on the right. `sharp` keeps anti-aliased edges, slightly crisper than base with faint steps on shallow edges. `sharp4` shows steps on most edges, close to `noa2c`'s hard staircase.

![zdiag base, noa2c, sharp and sharp4 at the ground pose](shots/shimmer-sharp-ground.jpg)

![zdiag base, noa2c, sharp and sharp4 at the sky pose](shots/shimmer-sharp-sky.jpg)

Gates: `make checkall` exited 0, and `E2E_PORT=4297 make e2e` exited 0 with 37 of 37 passed. Without `ZDIAG_SHARP_GAIN` the shader compiles the same alpha line as before, so the default output is unchanged, and SCATTER_VERSION stays 11.

Recommendation: compare base, `sharp`, `sharp4` and `noa2c` in one headset session. On the desktop `sharp` halves the patch flicker, stays within 0.001 SSIM and 0.003 ΔE of base, and keeps anti-aliased edges. `sharp4` comes closer to `noa2c`'s flicker, at the cost of visible steps. If the headset agrees, raising the default R3 gain to the lowest one that clears the shimmer is the cheapest fix, and that is Paul's call.

### For the headset

These URLs need a deployed build, which needs an approved push.

- `?painting=starry-night&zdiag=nowrite`: no stroke-against-stroke depth tests, with the strokes still visible. If the shimmer drops, depth ties are the cause.
- `?painting=starry-night&zdiag=noa2c`: tests F4.
- `?painting=starry-night&zdiag=sharp`: the half-pixel a2c rim. If it cuts the shimmer about as much as `noa2c`, a higher default R3 gain can fix it without losing anti-aliased edges.
- `?painting=starry-night&zdiag=sharp4`: the quarter-pixel a2c rim, between `sharp` and `noa2c`.
- `?painting=starry-night&zdiag=freeze`: the same pixels every frame. If the shimmer stays, that points to the compositor's reprojection (or the MSAA / alpha-to-coverage resolve) and not render-time jitter. Leave this mode with the Quest button, because the frozen view makes the in-app Exit VR control hard to reach.
- `?painting=starry-night&zdiag=strokeorder`: reproduces the live test, with the world strokes hidden. Reference only.
- Add `&diag&hud` to any of them to read `__goghDiag().zdiag`.
- Also worth reading: frame-to-frame deltas of `__goghDiag().camera` over CDP while Paul holds still. The real rotation noise decides how much of the shimmer F1 accounts for.

### Gates

`make checkall` exited 0. `E2E_PORT=4321 make e2e` exited 0, 37 of 37 passed. The scatter did not change and the default shader output is unchanged (`stroke.frag.glsl` gained an `#ifdef ZDIAG_ALPHA_TEST` block that is off by default), so SCATTER_VERSION stays 11. Fidelity and coverage run inside the e2e suite.

## Governor sheds foveation first (2026-11-06, on e0eac54)

### Headset evidence

Quest 3, deployed e0eac54, painter's area, 72 Hz (13.89 ms budget). The runs were driven over CDP (adb forward to `chrome_devtools_remote`), and the frame interval comes from `XRSession.requestAnimationFrame` timestamps over 3.5 s windows. The script patched `gl.viewport`, `gl.drawElementsInstanced` and `XRProjectionLayer.fixedFoveation` live.

| Condition | Mean frame |
| --- | --- |
| As shipped (governor level 3: near 0.7, far 0.28, fb 0.85 requested) | 20.95 ms |
| `fixedFoveation` = 1 | 16.53 ms |
| Every draw into a viewport 1/4 wide and 1/4 high (1/16 of the pixels, same draw calls) | 13.89 ms (vsync cap) |
| Skip every 2nd instanced draw | 14.10 ms |
| Skip 3 in 4 instanced draws | 13.89 ms |
| As shipped again | 21.12 ms |

There are 350 to 400 draw calls per frame. Main-thread JS takes 6 to 7 ms of each 21 ms frame, and the thread then waits. The frame is therefore GPU-bound, not CPU or draw-call bound. A first draft of this section called it fill-bound. The profile below shows pixel count alone does not explain it. The e018c2f reading that called it CPU-bound on per-chunk draws was wrong for the current world. PRD D3 still holds: multiview helps only CPU-bound apps.

A second headset run on 2026-11-06 (deployed build, 72 Hz, governor level 4, mean frame over 3.5 s windows, interleaved, driven over CDP) measured foveation 0.5 and broke the frame down by layer:

| Condition | Mean frame |
| --- | --- |
| Base | 22.39, 21.55 and 21.61 ms (mean 21.85) |
| Foveation 0.5 | 18.31 and 18.22 ms (0.84 of base) |
| Foveation 1 | 18.08 and 17.24 ms (0.81 of base, about 3% past 0.5) |
| Skip every alpha-to-coverage stroke draw | 13.89 ms (vsync cap) |
| Skip the blended draws (the haze) | 20.98 ms, against 21.9 ms |
| Skip the non-instanced base meshes | 22.81 ms (no gain) |

So the cost is in the alpha-to-coverage strokes. The haze buys about 1 ms, and the base meshes nothing.

A third run on 2026-11-06 (72 Hz, governor off) tested pixel count directly. A static render scale of 0.7 applied at layer creation gives an `XRProjectionLayer` texture of 2352 × 1232 side by side, 1176 × 1232 per eye against the default of about 1680 × 1760, so about 0.49x the pixels. With foveation 1 on top it reads 18.71 ms mean, barely better than foveation 1 alone at scale 1 (17.2 to 18.1 ms). `ovrgpuprofiler` on the Quest at that setting:

| Metric | Value |
| --- | --- |
| GPU clock | 545 MHz |
| GPU utilisation | about 78% |
| Shading time on vertices / fragments | about 54% / 46% |
| Pre-clipped polygons | 85M/s, about 1.6M per frame at about 53 fps |
| Vertices shaded | 165M/s |
| Average polygon area | about 25 px |
| Primitives trivially rejected | 23% |
| Bus busy | 16.5% |
| Stalled on memory | 0.1% |

So the frame is bound by geometry, many tiny stroke triangles processed in the tiler's binning and render passes, plus fragment work, with the GPU not fully saturated. It is not bound by pixel fill alone. Halving the pixels barely moves it, while skipping draws (which removes their geometry and their fragments together) and foveation both pay. Foveation 0.5 is most of foveation's gain, and step 1 adds about 3%, which sits on the no-gain bar, so it can read as no-gain against 0.5. That is one reason the two foveation steps hold apart.

### What three 0.186 supports

- `WebXRManager.setFoveation(v)` sets `fixedFoveation` on the projection layer (or on an `XRWebGLLayer` that has it) at any time, mid-session included. The governor uses it.
- `WebXRManager.setFramebufferScaleFactor` refuses while presenting. three never calls `XRView.requestViewportScale`.
- `src/xr/viewport-scale.ts` already did what the brief proposed. It calls `requestViewportScale` on three's own `XRView`, immediately before three's `XRWebGLBinding.getViewSubImage(layer, view)`, inside three's XR frame handler. A second hook through `renderer.xr.getFrame()` would call `getViewerPose` again and get different `XRView` objects, so it could change nothing.
- On Quest Browser three takes the projection-layer path, and the measured `fbScaleApplied` is 1 at a requested 0.85. So Quest ignores `requestViewportScale` for projection layers, and dynamic viewport scaling is unavailable on the path three uses there. The fb-scale step stays in the order, because it does pay on a runtime that honours the request. On Quest the no-gain rule undoes it and holds it with the back-off below.
- Not tried: forcing the `XRWebGLLayer` path (by hiding `createProjectionLayer`), where the WebXR core spec applies the request at `XRWebGLLayer.getViewport`. Whether Quest Browser honours it there is unverified. That changes the MSAA path, and it can only be judged on the headset.

### New shed order

1. Foveation 0 to 0.5 (step `foveation`).
2. Framebuffer scale 1 to 0.85.
3. Foveation to 1 (step `foveation-max`), the last resort, which P0.8 found blocky at the edges. It has its own hold, so a 0.5 step that window noise reads as no-gain does not block it. On Quest fb scale is always no-gain, so foveation 1 is the only measured lever.
4. Far, mid and near density, with the existing floors and yield checks.
5. The 72 Hz request, after 3 s of overrun with nothing left to shed.

Restore and recovery run in the reverse order. `__goghDiag().governor.foveation` and the HUD now show the live foveation (0, 0.5 or 1). `xr/session.ts` still sets 0 at session start, but it does so after an awaited `updateTargetFrameRate`, which can land after a governor shed. So every judged frame re-asserts the governor's value when `renderer.xr.getFoveation()` reports another. The bench (`?bench`) never runs the governor and keeps its own foveation steps.

### Why density sheds buy nothing

Each density step multiplies the band's stroke size by sqrt(from / to) (`densityShed` in `src/render/governor.ts`, following the 1/sqrt(d) law in `src/render/strokes/bands.ts`). That keeps drawn × size² constant: a 30% cut in count comes with a 1/0.7 growth in quad area. The unit test "each density shed multiplies by 0.7 and raises the size by 1/sqrt of the density ratio" pins exactly these values. The painted area, and with it the fragment work and overdraw, stays the same by construction. A density shed cuts instances, and with them vertices, by 30%, yet near 0.34 with far 0.28 still reads about 21 ms. Given the geometry-heavy profile above, why that vertex saving does not show is not explained by this evidence. A first draft said fill dominates, which the profile contradicts. `MIN_SHED_YIELD` judges a step by its instance count, which the headset shows does not predict frame time here.

The cheap code fix would be a weaker size law, for example size × (from / to)^0.25, under which a 0.7 step cuts painted area by about 16%. I did not make it. It trades coverage for fragment work, and the profile above suggests fragment work is only part of the cost. Also, the coverage and fidelity specs run on the desktop at the default densities, where the governor never judges, so nothing would catch gaps at shed densities. It needs a density override flag and a coverage sweep at shed levels first. The cut-the-draw-count A/B rows (skip half: 14.10 ms) remove whole strokes with no size growth, which is the upper bound such a change could reach. No desktop fragment-count measurement was taken, although the brief asked for one: the size law fixes the painted-area ratio analytically, so it could only confirm it, and it did not fit the time budget. The haze (30,000 large blended strokes), the sky dome at far density and pinned layers are not density-governed, so they were not the cause of the no-gain result. The layer breakdown above puts the cost in the alpha-to-coverage strokes: skipping them reaches the vsync cap, while skipping the haze saves about 1 ms and the base meshes nothing.

### Hold back-off

A no-gain undo, a recover-back and a kept recovery each hold their step. The density bands share one hold (`density`, fix round 1): under the sqrt size law every band keeps its painted area, so one band's no-gain predicts the others', and a density no-gain or recovery result holds all three. The first hold of a step lasts 30 s, and each further hold of the same step doubles: 30, 60, 120, 240, then 300 s (`MAX_HOLD_MS`). A reported frame-rate change (or an applied 72 Hz request) and a new session (a new machine) restart the doubling. A shed that pays restarts it for that step. An interrupt (a hidden session) still clears the holds but keeps the doubling. Wall flips over 10 minutes of the simulated headset frame (72 Hz, vsync-locked with a deterministic debt, fb scale ignored, density free, at the headset-measured costs: base 21.85 ms, foveation 0.5 0.84 and foveation 1 0.81 of base). A flip is any density event, shed, undo or recovery, since each one adds or removes wall strokes. The script was `bun /tmp/gx-fill-scripts/flips.ts <governor module>`.

| Governor | Density events in 10 min |
| --- | --- |
| e0eac54 (density first, fixed 30 s holds, no foveation) | 124 (62 sheds, 60 no-gain undos, 2 recovers) |
| 819b25a (foveation first, per-band doubling holds) | 32 (16 sheds, 15 undos, 1 recover) |
| Fix round 1 (shared `density` hold) | 10 (5 far sheds, 5 undos, at 0, 30, 90, 210 and 450 s) |

With window noise (random vsync misses at the same costs, 8 seeds, 300 s), fix round 1 makes 8 to 16 density events per seed, from useless sheds that stick by chance and their recovery.

### Unit evidence

`tests/governor.test.ts`, "governor foveation steps and hold back-off", drives 72 Hz vsync-locked traces in which each frame takes one or two vsyncs, with a deterministic debt so the mean tracks the frame cost from the table above.

The costs are the headset-measured ones from the second run above, taken over CDP on 2026-11-06: base 21.85 ms, foveation 0.5 0.84 and foveation 1 0.81 of base. An earlier draft of this section used an assumed 0.89 for foveation 0.5, before it was measured.

- With fb scale applied (cost × scale², a pixel-count model the profile above does not support on Quest): foveation 0.5 and fb 0.85 are shed first and held for more than 95% of 10 minutes. Density is never shed, and foveation never reaches 1. This trace assumes fb scale applies, which Quest does not do on the projection layer.
- As measured on the headset, with fb scale ignored and density free: without noise, foveation 1 (3.6% under 0.5, just over the bar) holds for more than 95% of the time. Only far density is ever tried, 3 to 5 times in 10 minutes, with each gap about double the last. Near density is below full for under 1% of the time. Each recovery test of foveation 1 is reverted.
- The same costs with window noise (8 seeds, 300 s): foveation stays at 0.5 or 1 for at least 97% of the time on every seed. Foveation 1 itself is held for anywhere from 1% to 97% of the time, seed by seed, because its 3% gain sits on the bar. Density events stay at 16 or fewer per seed.
- Hypothetical costs with window noise (8 seeds, 300 s), where 0.5 buys 2% (under the 3% bar) and 1 buys 22%: every seed reaches foveation 1 and holds it for more than 85% of the time (worst 0.89). With the shared foveation id of 819b25a, 0.5's no-gain would have held 1 back.
- A constant overrun shows foveation hold gaps of 30, 60, 120, 240, 300 and 300 s, and a frame-rate change restarts at 30 s.

The CPU-bound recovery traces with window noise keep their original 120 s bounds after fix round 1: per-seed mean level under 3 (worst measured 2.88) and across-seed mean under 2 (worst 0.76). 819b25a had loosened them to 3.5 and 2.5. The recovery-hold doubling never resets on a CPU-bound frame, so a 600 s check was added: the across-seed mean must stay under 1 and the worst seed under 3.5. The measured values are 0.66 and 1.79 at worst, at miss rate 0.31. The shared density hold costs the GPU-bound trace, where every step pays, a little: its worst mean level is 2.46 (bound now 2.2, was 2.5), and at least one recovery restore per seed is reverted instead of half, because a recovery that noise keeps now holds every density band.

### Not verified

There is no headset in this session (no adb). The foveation steps, the back-off and the shed order are verified only in unit tests and in the desktop gates. The governor itself has not been run with these changes on the headset. Foveation does not reach 72 Hz in the painter's area: the measured foveation 1 frame is 17.2 to 18.1 ms. Even 0.49x the pixels with foveation 1 reads 18.71 ms. The remaining cost is the alpha-to-coverage strokes' geometry plus fragment work. Whether 0.5 shimmers acceptably in the world is Paul's check.
