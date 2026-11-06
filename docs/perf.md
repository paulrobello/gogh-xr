# Headset performance (P0.8)

Device: Meta Quest 3, Quest Browser. Build: `https://gogh-xr.pardev.net` at 342252d. Run by Paul on 2026-11-05.

## Highest stroke count that holds the target rate

N steps by 25,000 with the left stick. "Holds" means the HUD reads the target FPS once "settling" clears. Every reading is taken looking straight up, which is the densest view and the worst case. Earlier readings taken at other view angles were discarded.

| Mode | "72 Hz" (see note) | 90 Hz | 120 Hz |
| --- | --- | --- | --- |
| blend | 300,000 | 225,000 (275,000 drops to 75 fps) | 150,000 |
| a2c | 325,000 | 225,000 (300,000 drops to 75 fps) | 150,000 |

Note on the 72 Hz column: Quest 3 reports `supportedFrameRates` of 70, 80, 90 and 120, so `updateTargetFrameRate(72)` is rejected and the session ran at whatever rate it already had. Those two readings are unconfirmed until they are re-measured at 70 or 80 with the Y-button toggle.

These readings used the original upper-hemisphere layout looking straight up. The bench now fills a full sphere, so any view direction is the worst case. At the same N, a view now holds about half as many strokes on screen, while every stroke still runs through the vertex shader. The rows above are therefore not comparable with full-sphere readings and are kept only as history. The full-sphere run replaces them, using the p95 values the bench now records.

## Other findings

| Question | Result |
| --- | --- |
| `supportedFrameRates` (OQ1) | 70, 80, 90, 120. There is no 72, so the PRD's "72 Hz max-beauty mode" must become 70 or 80. |
| GPU timer query available (OQ2) | Unavailable on Quest Browser. The governor must work from frame intervals alone. |
| a2c vs blend visual verdict (OQ4) | Blend looks slightly brighter but not better. Small strokes show flickering transparent stripes, a screen-door effect that is worse with head movement. The likely cause is the bench shader's bristle term modulating alpha, which alpha-to-coverage turns into a coverage dither. P1.3 should keep bristle variation in colour and give a2c a sharpened alpha edge. |
| Foveation artifacts at 0.5 and 1.0 (OQ5) | Not yet tested. |
