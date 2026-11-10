# Headset performance (P0.8)

Device: Meta Quest 3, Quest Browser. Build: `https://gogh-xr.pardev.net` at fd7a1ab. Run by Paul on 2026-11-05 (results stamped 2026-11-06 04:45–04:50Z, 8:45–8:50 PM PST). The 72 Hz fill-in run (blend 325,000 to 475,000 and a2c 425,000 to 525,000, foveation 0) was recorded 2026-11-06 05:35–05:38Z (9:35–9:38 PM PST), the 80 Hz fill-in run (blend 375,000 to 400,000 and a2c 375,000 to 475,000) at 05:46–05:48Z (9:46–9:48 PM PST), and the 120 Hz a2c run (200,000 to 250,000) at 05:49Z (9:49 PM PST). The a2c 400,000 and 475,000 rows at 80 Hz are from that later run, which replaced the earlier records of the same settings, and the a2c 225,000 row at 120 Hz is from the 120 Hz run for the same reason. Results were read from the headset's localStorage over adb and the DevTools protocol, not transcribed by hand.

## Full-sphere stroke budget

Strokes fill a full sphere around the viewer, uniform per solid angle, so any view direction is the worst case. About half the strokes are on screen in any view, and every stroke runs through the vertex shader. Size is 24 px. a2c draws in random order, and blend draws sorted far to near.

"Holds" means the measured fps is within 1 of the target. The frame-interval p95 runs 5 to 8 percent over the frame budget even when the rate holds, so fps is the signal and p95 shows margin.

| Mode | 72 Hz | 80 Hz | 90 Hz | 120 Hz |
| --- | --- | --- | --- | --- |
| blend | 325,000 holds. 425,000 is marginal. 450,000 fails. | 375,000 holds. 400,000 fails. | 325,000 holds. 350,000 fails. | 225,000 holds. 250,000 fails. |
| a2c | 500,000 holds. 525,000 fails. | 450,000 holds. 475,000 fails. | 350,000 holds. 375,000 fails. | 225,000 holds. 250,000 fails. |

At 90 Hz (the `adaptive-90` quality, or `?hz=90`) the budget is about 325,000 strokes blended or 350,000 with alpha-to-coverage, with roughly half of them on screen. At 72 Hz it is 325,000 blended or 500,000 with alpha-to-coverage. Since 2026-11-07 the app's default quality is `adaptive-72`, which requests 72 Hz at session start. The bench (`?bench`) still defaults to 90 Hz.

Blend at 425,000 and 72 Hz reads 73 fps, but its mean of 14.52 ms is over the 13.9 ms budget and its p99 is 24.5 ms, so it is counted as marginal rather than holding.

Blend holds 375,000 at 80 Hz but only 325,000 was confirmed at 72 Hz, because 72 Hz was not run between 325,000 and 425,000. The real 72 Hz blend limit is probably at least 375,000.

One gap remains: blend at 72 Hz between 325,000 and 425,000.

### Bench caveats

- **Blend sort is static.** The blend draw order is sorted far to near once, when the field is built, and is not re-sorted as the viewer moves. It is exact only near the centre of the sphere, so a head that moves far off-centre sees increasingly out-of-order blending. The numbers above were taken with the head near the centre.
- **`gpuMs` covers the whole frame.** The GPU timer query wraps the frame's render pass, so it includes the grid, ground, the HUD panel and the strokes. It is not the stroke cost alone. Quest Browser exposes no timer query anyway (OQ2 below), so the headset rows rest on frame intervals.
- **Stroke size is in screen pixels.** The bench's 24 px is a screen-space size, so a stroke covers the same pixels at any distance. The world's strokes are sized in world units (`LAYER_SIZE`), so the bench's fill cost is not the world's. The bench keeps pixels.
- **Slow frames.** Below about 4 fps the HUD redraw used to exclude every interval, which left the mean and p99 empty. `FrameStats.exclude` now ignores a call made within `count` frames of the last one, so a slow bench keeps about one interval in three instead of none.

### Raw results

| Mode | N | Target Hz | Actual Hz | fps | Mean ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| blend | 225,000 | 72 | 72 | 73 | 13.90 | 14.7 | 15.2 |
| blend | 325,000 | 72 | 72 | 73 | 13.89 | 14.2 | 14.7 |
| blend | 425,000 | 72 | 72 | 73 | 14.52 | 16.3 | 24.5 |
| blend | 450,000 | 72 | 72 | 70 | 14.58 | 16.9 | 24.8 |
| blend | 475,000 | 72 | 72 | 69 | 14.73 | 20.7 | 24.4 |
| blend | 375,000 | 80 | 80 | 81 | 12.56 | 13.3 | 13.7 |
| blend | 400,000 | 80 | 80 | 77 | 13.12 | 15.1 | 22.2 |
| blend | 450,000 | 80 | 80 | 74 | 13.57 | 15.8 | 17.2 |
| blend | 475,000 | 80 | 80 | 71 | 14.25 | 16.2 | 17.2 |
| blend | 200,000 | 90 | 90 | 91 | 11.13 | 11.5 | 12.0 |
| blend | 300,000 | 90 | 90 | 91 | 11.18 | 11.8 | 12.7 |
| blend | 325,000 | 90 | 90 | 90 | 11.18 | 11.8 | 12.5 |
| blend | 350,000 | 90 | 90 | 89 | 11.53 | 13.3 | 20.3 |
| blend | 475,000 | 90 | 90 | 69 | 14.60 | 16.3 | 16.8 |
| blend | 225,000 | 120 | 120 | 119 | 8.42 | 8.9 | 11.0 |
| blend | 250,000 | 120 | 120 | 116 | 8.70 | 11.1 | 14.1 |
| blend | 350,000 | 120 | 120 | 87 | 11.74 | 13.7 | 14.7 |
| a2c | 425,000 | 72 | 72 | 73 | 13.92 | 14.3 | 14.7 |
| a2c | 500,000 | 72 | 72 | 73 | 13.95 | 14.6 | 15.0 |
| a2c | 525,000 | 72 | 72 | 71 | 14.52 | 16.8 | 24.8 |
| a2c | 375,000 | 80 | 80 | 81 | 12.55 | 13.0 | 13.8 |
| a2c | 400,000 | 80 | 80 | 81 | 12.56 | 13.4 | 13.9 |
| a2c | 425,000 | 80 | 80 | 81 | 12.56 | 13.3 | 13.8 |
| a2c | 450,000 | 80 | 80 | 81 | 12.59 | 13.2 | 14.6 |
| a2c | 475,000 | 80 | 80 | 76 | 13.22 | 17.5 | 22.0 |
| a2c | 350,000 | 90 | 90 | 90 | 11.27 | 12.0 | 19.2 |
| a2c | 375,000 | 90 | 90 | 87 | 11.62 | 14.8 | 17.9 |
| a2c | 200,000 | 120 | 120 | 121 | 8.38 | 8.9 | 9.5 |
| a2c | 225,000 | 120 | 120 | 121 | 8.37 | 8.9 | 9.4 |
| a2c | 250,000 | 120 | 120 | 118 | 8.58 | 10.0 | 15.1 |

One more stored record is discarded: blend at 100,000 and 90 Hz, recorded before the session reported a frame rate. It read 74 fps, which contradicts the 91 fps at 200,000 and 300,000. The 80 Hz run left a second record of the same kind, blend at 325,000 and 90 Hz with no session frame rate and 74 fps, also discarded. Both read close to 72 Hz, the browser default, so they were likely recorded before the 90 Hz request took effect.

## Other findings

| Question | Result |
| --- | --- |
| `supportedFrameRates` (OQ1) | 72, 80, 90, 120, read from `__goghDiag()` over adb. An earlier hand reading of "70" was a misread, so the 72 Hz max-beauty mode stands. |
| GPU timer query available (OQ2) | Unavailable on Quest Browser. The governor must work from frame intervals alone. |
| a2c vs blend visual verdict (OQ4) | Blend looks slightly brighter but not better. Small strokes show flickering transparent stripes, a screen-door effect that is worse with head movement. The likely cause is the bench shader's bristle term modulating alpha, which alpha-to-coverage turns into a coverage dither. P1.3 should keep bristle variation in colour and give a2c a sharpened alpha edge. |
| Foveation artifacts at 0.5 and 1.0 (OQ5) | At 1.0 there is too much blocky shimmer at the edges. At 0.5 the shimmer is still visible but less blocky. Foveation also buys no headroom here: blend at 325,000 and 90 Hz reads 90 to 91 fps with a p95 of 11.8 ms at 0, 0.5 and 1 alike. The bench is therefore not fill-bound at these settings, and the per-stroke vertex cost sets the budget, so stroke count and LOD (P1.4) matter more than foveation. Lowering the default to 0 would remove the artifacts at no measured cost. That should be rechecked with the real scene, whose larger strokes will add fill. The default is now 0. The governor shed foveation to 0.5 until the e018c2f headset reading of the Starry Night world at the painter's spot: 55 to 68 fps against a 72 Hz target at governor level 9 (foveation 0.5, fb scale 0.84), with 151,475 strokes in 339 visible chunks. That frame was read as CPU-bound on per-chunk draws, so foveation was dropped from the shed order. The reading was wrong: the 2026-11-06 headset A/B at e0eac54 (`docs/verification.md`, "Governor sheds foveation first") showed the world GPU-bound rather than CPU-bound: foveation 1 took the frame from 20.95 to 16.53 ms, and a second run measured foveation 0.5 at -16%. Pixel count alone does not explain the frame: 0.49x the pixels plus foveation 1 reads 18.71 ms against 17.2-18.1 ms for foveation 1 alone, and the GPU profiler shows geometry (about 54% of shading time on vertices) plus fragment work, at about 78% utilisation. The governor sheds foveation again, to 0.5 and then 1, before fb scale and density. |

### Foveation results

Blend, 90 Hz, full sphere, recorded 2026-11-06 05:24–05:28Z (9:24–9:28 PM PST).

| N | Foveation | fps | Mean ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- |
| 325,000 | 0 | 90 | 11.17 | 11.8 | 12.3 |
| 325,000 | 0.5 | 91 | 11.15 | 11.8 | 12.0 |
| 325,000 | 1 | 90 | 11.15 | 11.8 | 12.4 |
| 300,000 | 1 | 90 | 11.33 | 12.3 | 18.8 |
| 350,000 | 1 | 86 | 11.65 | 13.7 | 16.5 |
| 375,000 | 0 | 83 | 11.89 | 14.5 | 15.7 |
| 375,000 | 0.5 | 77 | 12.21 | 14.2 | 16.0 |
| 375,000 | 1 | 83 | 12.16 | 14.4 | 15.2 |
| 400,000 | 0.5 | 78 | 12.83 | 14.9 | 17.0 |

## Surface stroke scatter (P2.6)

`bun scripts/scatter-time.ts` times the app's own world scatter, `scatterWorld` (src/paintings/starry-night/world.ts), over the default world: generator seed 1, scatter seed 1, `LAYER_DENSITY`, P2.7's scaled `LAYER_SIZE`, face normals and the ridge override. It runs on the desktop with the real bake rasters, decoded with sharp. The time covers the scatter alone, after a low-density warm-up run. Decoding, the flow field, the histograms, the geometry and the boundary haze are excluded. A time is recorded only when the 1-minute load average is at most 15 both before and after the run.

| Date | Stored strokes | Scatter time | Load before | Load after | Host |
| --- | --- | --- | --- | --- | --- |
| 2026-11-06 | 535,114 (P2.6 `scatterSurfaces`, SCATTER_VERSION 2) | not measured (host load 42.03), superseded by the next row | 42.03 | | bun 1.4.4, darwin/arm64 |
| 2026-11-06 | 535,011 world scatter (commit c121951), plus 30,000 haze for 565,011 stored | 367 ms | 2.43 | 2.43 | minimac, Apple M4, bun 1.4.4, darwin/arm64 |

## World chunk size (ruling Q5)

The e018c2f headset reading at the painter's spot (55 to 68 fps against 72 Hz, 151,475 strokes in 339 visible chunks) was read as CPU-bound on per-chunk draws, since without multiview each visible chunk draws once per eye. The 2026-11-06 headset A/B at e0eac54 disproved that for the current world: main-thread JS is 6 to 7 ms of a 21 ms frame, and drawing into a sixteenth of the pixels with the same draw calls holds 72 Hz, so the frame is GPU-bound. A later profile puts it on stroke geometry plus fragment work, not pixel count alone (`docs/verification.md`, "Governor sheds foveation first"). The chunk-size change below still cuts draw calls, but that was not what held the frame back. `WORLD_CELL_SIZE` (src/paintings/starry-night/world.ts) went from 16 m to 24 m. Measured on 2026-11-06 at the four `scripts/zfight-probe.ts` poses, all at the painter's eye, with the governor off (`?nogov`) and the default densities. Desktop is the 70° viewer at 1280 × 1014 in the e2e build. XR is IWER's Quest 3 through `setPose`, where draw calls cover both eyes. Quest frustum is the unit-test cull with a 96° vertical frustum, no renderer. Each cell reads visible chunks / draw calls / drawn strokes, or visible chunks / drawn strokes for the Quest frustum.

| Pose | Desktop 16 m | Desktop 24 m | IWER XR 16 m | IWER XR 24 m | Quest frustum 16 m | Quest frustum 24 m |
| --- | --- | --- | --- | --- | --- | --- |
| painter-level | 288 / 292 / 213,312 | 142 / 148 / 248,778 | 324 / 642 / 168,076 | 150 / 306 / 215,577 | 420 / 227,841 | 189 / 259,160 |
| painter-down | 288 / 292 / 213,210 | 131 / 137 / 242,451 | 307 / 620 / 166,703 | 142 / 290 / 212,660 | 407 / 225,781 | 190 / 260,507 |
| village-look | 260 / 265 / 204,450 | 124 / 130 / 243,673 | 313 / 618 / 166,809 | 141 / 286 / 214,433 | 386 / 226,893 | 179 / 258,613 |
| back | 220 / 223 / 156,378 | 106 / 109 / 204,093 | 376 / 754 / 222,894 | 175 / 362 / 255,927 | 352 / 171,350 | 157 / 217,198 |

The world has 1,299 chunks at 16 m and 543 at 24 m. Over the 24 coverage poses with the Quest frustum, the maximum is 597 visible chunks and 228,787 drawn at 16 m, and 267 and 272,986 at 24 m, inside the 325k default budget. 24 m halves the draw calls for about 14 to 31% more drawn strokes. The IWER rows look turned 180° against the others: its painter-level matches the Quest-frustum back pose, so its poses are compared only between cell sizes. The headset frame time at 24 m is not measured yet.

## Motion (P4.6)

Desktop GPU frame time of the Starry Night world with motion frozen and running, recorded 2026-11-07 (early morning PST). The runner was `bun scripts/motion-perf.ts --base <preview URL> --seconds 5 --repeats 5 --out <file>` against a `vite preview --mode e2e` of the build, because `?motionlayers` and IWER exist only in `--mode e2e`. The stroke shader is the production one, because `MOTION_PHASE_PIN` is unset. The build was made at 05:32 PST from the tree at c66bc88. The later commits change no render path: 36971ea edits a `motion.glsl` comment, and 137b5ef adds the e2e-only `__goghMoonDisc` probe.

- Host: Apple M4 Max, headless Chromium (new headless) on the GPU. `UNMASKED_RENDERER_WEBGL` reads `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)`.
- `EXT_disjoint_timer_query_webgl2` is available. Each animation frame gets one `TIME_ELAPSED` query, begun at the frame's first rAF callback and ended at the next frame's, so it covers every GPU command of the frame. Disjoint results are dropped.
- Each run is one boot and one view. It is the mean and p95 over 5 s (about 300 frames) after 30 settle frames. The rAF interval reads 16.67 ms in every run because it is vsync-capped, so only the GPU time can show the motion's cost.
- The desktop configurations ran 5 times, interleaved: every configuration and view once per pass, then the next pass. The IWER rows ran once, on the first pass, because their timings are not a cost.
- Setup: 1280 × 1014 viewport, seed 1, `?nogov`, so the densities stay fixed.
- Views:
  - "painter" on the desktop boots with `?painter`: the 60° painter camera of the fidelity capture, framing canvas uv [0, 1]².
  - "spot ahead" is the eye at (0, 1.6, 0) facing -Z at pitch 0, with the 70° desktop field of view.
  - The IWER rows put the head at the same poses, pitched by `CANVAS_PITCH` for "painter", with IWER's own field of view.
- Configurations:
  - (a) `?noanim`.
  - (b) Every layer moving, on the running clock.
  - (c) `?motionlayers=reactive`. On the desktop the eye is the only disturber, and no stroke lies within its 0.6 m radius at these views.
  - (d1) and (d2) are IWER only. See the box section below.
- Load: every kept run had a 1-minute load average at or below 15 before and after, and the highest was 13.6. One run ended at 16.0 and was discarded and re-run: (c) spot ahead, pass 1.

### Desktop

| Configuration | View | Runs | GPU median ms | Spread (min-max) ms | p95 median ms | vs (a), medians | Draw calls | Drawn strokes | Load range |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (a) noanim | painter | 5 | 3.62 | 3.50-3.64 | 4.25 |  | 127 | 249,207 | 6.2-13.1 |
| (a) noanim | spot ahead | 5 | 3.84 | 3.69-3.86 | 4.48 |  | 148 | 256,276 | 6.2-12.3 |
| (b) motion, every layer | painter | 5 | 3.56 | 2.74-3.61 | 3.98 | -1.7% | 127 | 249,207 | 6.7-11.3 |
| (b) motion, every layer | spot ahead | 5 | 3.86 | 2.97-4.11 | 4.73 | +0.7% | 150 | 257,238 | 6.8-10.9 |
| (c) motion, reactive only | painter | 5 | 3.63 | 3.59-3.66 | 4.20 | +0.2% | 127 | 249,207 | 6.5-10.4 |
| (c) motion, reactive only | spot ahead | 5 | 3.86 | 2.94-4.40 | 4.54 | +0.6% | 148 | 256,276 | 6.3-13.6 |

Motion is within noise, under 15%. The motion medians sit between -1.7% and +0.7% of `?noanim`, inside the run-to-run spread of about ±0.1 ms for the steady runs. Three runs read 2.7-3.0 ms against 3.5-4.4 ms for the rest, which is why some spreads are wide. A single 5 s run per row, as in the first record, cannot resolve a 2-4% difference.

The wake loop's cost is not in this table. On the desktop the eye is the only disturber, so the reactive box is a 1.2 m cube round it, and at these views no stroke is inside it (0 box strokes).

### Reactive box (IWER)

No row measures the wake-loop GPU cost. The IWER GPU timings are not a cost. In an earlier single-run record, motion read 8% to 23% cheaper than `?noanim` in IWER, which no shader change can do. These rows therefore record only the counts.

"Box strokes" counts the drawn strokes whose rest centre is inside the reactive box, which are the strokes that run the reactive loops. The box is one axis-aligned box round every weighted disturber and its wake samples, grown by `REACTIVE_RADIUS` (0.6 m when measured; since 2026-11-09 a disturber grows it by its radius plus its capped half-diagonal, 0.6 m for the head and 0.696 m for a hand, and a wake sample by its disturber's radius). The head is always one of the disturbers.

| Configuration | View | GPU ms | Draw calls | Drawn strokes | Box strokes (end / most) | Box min | Box max | Tracked (head, slot 0, slot 1) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| XR (a) noanim | painter | IWER, not a cost | 378 | 265,603 | 2,681 / 2,681 | (-0.60, -60.60, -0.60) | (0.60, 2.19, 0.62) | yes, yes, yes |
| XR (a) noanim | spot ahead | IWER, not a cost | 366 | 265,113 | 2,682 / 2,682 | (-0.60, -60.60, -0.60) | (0.60, 2.20, 0.62) | yes, yes, yes |
| XR (b) motion, every layer | painter | IWER, not a cost | 382 | 266,404 | 2,681 / 2,681 | (-0.60, -60.60, -0.60) | (0.60, 2.19, 0.62) | yes, yes, yes |
| XR (b) motion, every layer | spot ahead | IWER, not a cost | 366 | 265,113 | 2,682 / 2,682 | (-0.60, -60.60, -0.60) | (0.60, 2.20, 0.62) | yes, yes, yes |
| XR (c) motion, reactive only | painter | IWER, not a cost | 378 | 265,603 | 2,681 / 2,681 | (-0.60, -60.60, -0.60) | (0.60, 2.19, 0.62) | yes, yes, yes |
| XR (c) motion, reactive only | spot ahead | IWER, not a cost | 366 | 265,113 | 2,682 / 2,682 | (-0.60, -60.60, -0.60) | (0.60, 2.20, 0.62) | yes, yes, yes |
| XR (d1) far-reach union box | painter | IWER, not a cost | 382 | 266,404 | 22,098 / 22,098 | (-3.79, -60.60, -8.92) | (0.60, 2.19, 0.62) | yes, yes, yes |
| XR (d1) far-reach union box | spot ahead | IWER, not a cost | 366 | 265,113 | 22,045 / 22,092 | (-3.78, -60.60, -8.92) | (0.60, 2.20, 0.62) | yes, yes, yes |
| XR (d2) hand at reach in the cypress | at the cypress | IWER, not a cost | 316 | 215,321 | 1,100 / 1,108 | (-3.78, -2.35, -8.98) | (-2.18, -0.77, -7.14) | yes, no, yes |

- Rows (a) to (c) and (d1) park both controllers 60 m under the floor, rig-local, and both stay tracked. The union box therefore runs from the head down to y -60.6. That column holds about 2,700 ground strokes under the painter's spot, which run the loops even with no hand near anything.
- (d1) is the far-reach union-box pose. The rig stands at the painter's spot, and the right controller circles 0.2 m at 1.5 m/s, 0.2 m inside the main cypress's hull, about 9 m from the head. The box spans the head, that far hand and the parked controller: 4.4 × 62.8 × 9.5 m. No arm reaches 9 m, so its 22,000 box strokes overstate any real pose. It is an upper-bound pose, not a hand in the cypress.
- (d2) is a realistic reach. The rig puts the head 0.4 m out from the cypress hull, facing its axis. The right hand circles the same way 0.6 m ahead, so it is 0.2 m inside the hull. The left controller is disconnected, so it is untracked with strength 0. The box is 1.60 × 1.58 × 1.85 m and holds about 1,100 box strokes, 0.5% of those drawn.

**Quest wake-loop cost, estimate carried to P4.7 (not measured).** The loop costs about 470 scalar operations per vertex for a stroke inside the box (`src/motion/motion.glsl`).

- At (d1): 22,098 box strokes × 4 vertices × 2 views × 470 is about 83 M operations per frame, or about 166 M if Adreno's binning pass also runs the position path.
  - From ALU throughput it is about 0.2-0.7 ms.
  - Scaled from the headset's measured vertex time in this file, it is about 2.4-4.0 ms. That is out of the 13.9 ms budget at 72 Hz, on a frame that already misses 72 Hz.
- A realistic reach of 1,000-5,000 box strokes, (d2) included, scales this down to about 0.01-0.9 ms.

The P4.7 headset A/B measures it at a realistic reach. If it is too slow, the levers, in order, are:

1. Test the rest centre against up to three per-disturber boxes (the head and each hand, each grown by its own wake) in place of the one union box. That costs a few operations per vertex and removes the empty volume between the head and a reaching hand, and the parked-controller column.
2. A uniform count of active wake samples, so a still hand's zero-weight samples skip the 24-sample wake loop.
3. A per-chunk wake budget, if 1 and 2 are not enough.

None of them is implemented.

### Per-chunk reactive cull growth

At f783588 the reactive bit grew every chunk's cull sphere while it was open. It now grows only a chunk whose box round its strokes' rest centres overlaps the reactive box (`src/render/strokes/batch.ts`). These drawn counts come from the first, single-run record, whose desktop "painter" view used the 70° desktop field of view rather than `?painter`:

| Configuration | View | Drawn at f783588 (every chunk grows) | Drawn now (per-chunk growth) |
| --- | --- | --- | --- |
| (a) noanim | painter pose, 70° | 256,222 | 256,222 |
| (a) noanim | spot ahead | 256,276 | 256,276 |
| (b) motion, every layer | painter pose, 70° | 259,572 | 256,995 |
| (b) motion, every layer | spot ahead | 258,787 | 257,238 |
| (c) motion, reactive only | painter pose, 70° | 259,572 | 256,222 |
| (c) motion, reactive only | spot ahead | 258,172 | 256,276 |
| XR (b) motion, every layer | painter | 268,735 | 266,404 |
| XR (b) motion, every layer | spot ahead | 267,567 | 265,113 |
| XR (d1) far-reach union box | painter | 268,735 | 266,404 |
| XR (d1) far-reach union box | spot ahead | 267,567 | 265,113 |

With no stroke near a disturber, reactive-only motion now draws exactly the `?noanim` strokes. With every layer moving, it draws exactly what the layer growth alone draws.

At spot ahead in the e2e's 1280 × 720 view it draws 260,604 strokes with every layer open and 260,604 with the reactive bit closed (`?motionlayers=sky,star,moon,cypress`, the P4.4 cull). f783588 drew 262,478 there (+1,874). `tests/e2e/world-coverage.spec.ts` holds that equality at 24 phases, 0.5 s apart over the 12 s sway period.

### Quest (pending owner, P4.7)

| Row | Result |
| --- | --- |
| Default-path A/B of the motion shader, `?noanim` against motion on (P4.2 M3) | pending owner (P4.7) |
| Global reactive growth against per-chunk growth, drawn strokes and frame time | pending owner (P4.7) |
| Box stroke count and wake-loop cost with a hand at reach in the cypress, against the estimate above and levers 1-3 | pending owner (P4.7) |
| XR recenter resets the reactive wake (no drag across the jump) | pending owner (P4.7) |

If the Quest shows motion costing more than 15% GPU time over `?noanim`, the first lever for the layer motion is P4.2 M3: bake each sky stroke's swirl rotation vector Omega at build instead of summing the four vortices per vertex. The reactive levers are above. Neither is implemented.

## History: upper-hemisphere readings

Taken earlier the same evening with the original upper-hemisphere layout, looking straight up as the worst case. They are not comparable with the full-sphere table, because at the same N a view held about twice as many strokes on screen.

| Mode | 72 Hz | 90 Hz | 120 Hz |
| --- | --- | --- | --- |
| blend | 300,000 | 225,000 (275,000 drops to 75 fps) | 150,000 |
| a2c | 325,000 | 225,000 (300,000 drops to 75 fps) | 150,000 |
