# Headset performance (P0.8)

Device: Meta Quest 3, Quest Browser. Build: `https://gogh-xr.pardev.net` at fd7a1ab. Run by Paul on 2026-11-05 (results stamped 2026-11-06 04:45–04:50Z, 8:45–8:50 PM PST). Results were read from the headset's localStorage over adb and the DevTools protocol, not transcribed by hand.

## Full-sphere stroke budget

Strokes fill a full sphere around the viewer, uniform per solid angle, so any view direction is the worst case. About half the strokes are on screen in any view, and every stroke runs through the vertex shader. Size is 24 px. a2c draws in random order, and blend draws sorted far to near.

"Holds" means the measured fps is within 1 of the target. The frame-interval p95 runs 5 to 8 percent over the frame budget even when the rate holds, so fps is the signal and p95 shows margin.

| Mode | 72 Hz | 80 Hz | 90 Hz | 120 Hz |
| --- | --- | --- | --- | --- |
| blend | 225,000 holds. 475,000 fails. | Not found: 450,000 already fails. | 325,000 holds. 350,000 fails. | 225,000 holds. 250,000 fails. |
| a2c | Not measured. | 400,000 holds. 475,000 fails. | 350,000 holds. 375,000 fails. | 225,000 holds. No failing N recorded. |

At the default 90 Hz the budget is about 325,000 strokes blended or 350,000 with alpha-to-coverage, with roughly half of them on screen.

Gaps a later run can fill: a2c at 72 Hz, a holding N for blend at 80 Hz, the step between 225,000 and 475,000 for blend at 72 Hz, and a failing N for a2c at 120 Hz.

### Raw results

| Mode | N | Target Hz | Actual Hz | fps | Mean ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| blend | 225,000 | 72 | 72 | 73 | 13.90 | 14.7 | 15.2 |
| blend | 475,000 | 72 | 72 | 69 | 14.73 | 20.7 | 24.4 |
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
| a2c | 400,000 | 80 | 80 | 81 | 12.53 | 13.1 | 13.5 |
| a2c | 475,000 | 80 | 80 | 74 | 13.79 | 15.9 | 16.8 |
| a2c | 350,000 | 90 | 90 | 90 | 11.27 | 12.0 | 19.2 |
| a2c | 375,000 | 90 | 90 | 87 | 11.62 | 14.8 | 17.9 |
| a2c | 225,000 | 120 | 120 | 119 | 8.43 | 9.0 | 11.6 |

One more stored record is discarded: blend at 100,000 and 90 Hz, recorded before the session reported a frame rate. It read 74 fps, which contradicts the 91 fps at 200,000 and 300,000.

## Other findings

| Question | Result |
| --- | --- |
| `supportedFrameRates` (OQ1) | 72, 80, 90, 120, read from `__goghDiag()` over adb. An earlier hand reading of "70" was a misread, so the 72 Hz max-beauty mode stands. |
| GPU timer query available (OQ2) | Unavailable on Quest Browser. The governor must work from frame intervals alone. |
| a2c vs blend visual verdict (OQ4) | Blend looks slightly brighter but not better. Small strokes show flickering transparent stripes, a screen-door effect that is worse with head movement. The likely cause is the bench shader's bristle term modulating alpha, which alpha-to-coverage turns into a coverage dither. P1.3 should keep bristle variation in colour and give a2c a sharpened alpha edge. |
| Foveation artifacts at 0.5 and 1.0 (OQ5) | Not yet tested. |

## History: upper-hemisphere readings

Taken earlier the same evening with the original upper-hemisphere layout, looking straight up as the worst case. They are not comparable with the full-sphere table, because at the same N a view held about twice as many strokes on screen.

| Mode | 72 Hz | 90 Hz | 120 Hz |
| --- | --- | --- | --- |
| blend | 300,000 | 225,000 (275,000 drops to 75 fps) | 150,000 |
| a2c | 325,000 | 225,000 (300,000 drops to 75 fps) | 150,000 |
