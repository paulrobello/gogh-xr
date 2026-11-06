# Headset performance (P0.8)

Device: Meta Quest 3, Quest Browser. Build: `https://gogh-xr.pardev.net` at 342252d. Run by Paul on 2026-11-05.

## Highest stroke count that holds the target rate

N steps by 25,000 with the left stick. "Holds" means the HUD reads the target FPS once "settling" clears. Every reading is taken looking straight up, which is the densest view and the worst case. Earlier readings taken at other view angles were discarded.

| Mode | 72 Hz | 90 Hz | 120 Hz |
| --- | --- | --- | --- |
| blend | | 225,000 (275,000 drops to 75 fps) | |
| a2c | 325,000 | 225,000 (300,000 drops to 75 fps) | |

## Other findings

| Question | Result |
| --- | --- |
| `supportedFrameRates` (OQ1) | |
| GPU timer query available (OQ2) | |
| a2c vs blend visual verdict (OQ4) | |
| Foveation artifacts at 0.5 and 1.0 (OQ5) | |
