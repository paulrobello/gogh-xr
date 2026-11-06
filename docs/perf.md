# Headset performance (P0.8)

Device: Meta Quest 3, Quest Browser. Build: `https://gogh-xr.pardev.net` at fd7a1ab. Run by Paul on 2026-11-05 (results stamped 2026-11-06 04:45–04:50Z, 8:45–8:50 PM PST). The 72 Hz fill-in run (blend 325,000 to 475,000 and a2c 425,000 to 525,000, foveation 0) was recorded 2026-11-06 05:35–05:38Z (9:35–9:38 PM PST), the 80 Hz fill-in run (blend 375,000 to 400,000 and a2c 375,000 to 475,000) at 05:46–05:48Z (9:46–9:48 PM PST), and the 120 Hz a2c run (200,000 to 250,000) at 05:49Z (9:49 PM PST). The a2c 400,000 and 475,000 rows at 80 Hz are from that later run, which replaced the earlier records of the same settings, and the a2c 225,000 row at 120 Hz is from the 120 Hz run for the same reason. Results were read from the headset's localStorage over adb and the DevTools protocol, not transcribed by hand.

## Full-sphere stroke budget

Strokes fill a full sphere around the viewer, uniform per solid angle, so any view direction is the worst case. About half the strokes are on screen in any view, and every stroke runs through the vertex shader. Size is 24 px. a2c draws in random order, and blend draws sorted far to near.

"Holds" means the measured fps is within 1 of the target. The frame-interval p95 runs 5 to 8 percent over the frame budget even when the rate holds, so fps is the signal and p95 shows margin.

| Mode | 72 Hz | 80 Hz | 90 Hz | 120 Hz |
| --- | --- | --- | --- | --- |
| blend | 325,000 holds. 425,000 is marginal. 450,000 fails. | 375,000 holds. 400,000 fails. | 325,000 holds. 350,000 fails. | 225,000 holds. 250,000 fails. |
| a2c | 500,000 holds. 525,000 fails. | 450,000 holds. 475,000 fails. | 350,000 holds. 375,000 fails. | 225,000 holds. 250,000 fails. |

At the default 90 Hz the budget is about 325,000 strokes blended or 350,000 with alpha-to-coverage, with roughly half of them on screen. At 72 Hz it is 325,000 blended or 500,000 with alpha-to-coverage.

Blend at 425,000 and 72 Hz reads 73 fps, but its mean of 14.52 ms is over the 13.9 ms budget and its p99 is 24.5 ms, so it is counted as marginal rather than holding.

Blend holds 375,000 at 80 Hz but only 325,000 was confirmed at 72 Hz, because 72 Hz was not run between 325,000 and 425,000. The real 72 Hz blend limit is probably at least 375,000.

One gap remains: blend at 72 Hz between 325,000 and 425,000.

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
| Foveation artifacts at 0.5 and 1.0 (OQ5) | At 1.0 there is too much blocky shimmer at the edges. At 0.5 the shimmer is still visible but less blocky. Foveation also buys no headroom here: blend at 325,000 and 90 Hz reads 90 to 91 fps with a p95 of 11.8 ms at 0, 0.5 and 1 alike. The bench is therefore not fill-bound at these settings, and the per-stroke vertex cost sets the budget, so stroke count and LOD (P1.4) matter more than foveation. Lowering the default to 0 would remove the artifacts at no measured cost. That should be rechecked with the real scene, whose larger strokes will add fill. |

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

## History: upper-hemisphere readings

Taken earlier the same evening with the original upper-hemisphere layout, looking straight up as the worst case. They are not comparable with the full-sphere table, because at the same N a view held about twice as many strokes on screen.

| Mode | 72 Hz | 90 Hz | 120 Hz |
| --- | --- | --- | --- |
| blend | 300,000 | 225,000 (275,000 drops to 75 fps) | 150,000 |
| a2c | 325,000 | 225,000 (300,000 drops to 75 fps) | 150,000 |
