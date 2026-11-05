# Phase 6: Audio

PRD: [P6](../PRD.md#p6--audio). Audio production has no code dependencies, so P6.1–P6.3 start in Wave 1. Follow `~/.claude/guides/suno.md`, then `$create-game-audio-assets`, `$elevenlabs`, and finally `$validate-generated-assets`. Keep originals under `assets/audio/source/`, outside `public/`, and never modify them.

## Runtime audio budget (project requirement)

| Property | Budget |
| --- | --- |
| Format | Opus in Ogg, with an MP3 fallback that keeps the normal `Lavc` gapless header |
| Sample rate / channels | 48 kHz. Music stereo, SFX mono (positional) |
| Loudness | Music −18 LUFS ±1. SFX beds −24 LUFS ±2 |
| True peak | ≤ −1 dBTP after encoding |
| Score length | 120–180 s seamless loop |
| Size | ≤ 3 MiB per music file, ≤ 512 KiB per SFX file |

## Cues

| Cue | Source | Use |
| --- | --- | --- |
| `score-night` | Suno (owner) | Ambient bed inside Starry Night |
| `score-gallery` | Suno (owner) | Quieter bed in the gallery room |
| `wind-hill` | ElevenLabs | Looped, positioned near the hilltop and the cypress |
| `crickets` | ElevenLabs | Looped, several sources scattered across the grass |
| `church-bell` | ElevenLabs | One-shot from the steeple at random intervals of 60–120 s |
| `portal-whoosh` | ElevenLabs | One-shot during the portal transition |
| `stroke-rustle` | ElevenLabs | Soft one-shot when strokes react near a hand, rate-limited |

## Tasks

### P6.1: Suno prompt pack
- **Depends on:** none.
- **Steps:**
  - Write `docs/audio/suno-prompts.md` in the guide's template format: separate copy-ready **Style**, **Exclude styles** and **Settings** blocks for `score-night` and `score-gallery`.
  - Describe the music without naming artists or works. The direction is:
    - an original instrumental nocturne;
    - slow, dreamy and slightly restless;
    - felt piano and soft strings, with a distant accordion texture and gentle swells;
    - about 60–70 BPM, rubato;
    - leaving space for night SFX.
  - Settings:
    - Instrumental On.
    - Duration 2:30.
    - Weirdness about 25%.
    - Style Influence about 80%.
    - Variety Off, Max Mode Off and Personalize Off.
    - Model: record what is actually used.
- **Verify:** The file exists and follows the guide template. Paul confirms it is ready to generate.

### P6.2: Owner Suno generation and handoff (owner)
- **Depends on:** P6.1.
- **Steps:**
  - Paul generates the tracks and picks the takes.
  - He supplies the full-song WAVs, song links or IDs, the actual model, his account plan at generation time, and any changes he made to prompts or settings.
  - Archive the WAVs unchanged, with their original filenames and SHA-256 hashes.
- **Verify:** `docs/audio/provenance.md` holds a row for each track with every field the Suno guide requires. Unknown values are recorded as unknown.

### P6.3: ElevenLabs SFX generation
- **Depends on:** none.
- **Steps:**
  - Use `$elevenlabs` with `$create-game-audio-assets` to generate 3–4 candidate takes for each SFX cue in the table.
  - **Confirm the credit spend with Paul before generating.**
  - Archive the originals and record the prompts, settings, IDs and hashes.
  - Paul picks a take for each cue.
- **Verify:** Every cue has a selected source with a complete provenance row.

### P6.4: Mastering, loops and runtime derivatives
- **Depends on:** P6.2, P6.3.
- **Steps:**
  - Write `scripts/audio/master.ts`. It runs pinned FFmpeg (record the version) to trim, apply crossfade loop wrapping (per the guide's tail-to-head rule), normalize, and encode to Opus/Ogg (`+bitexact`, fixed serial) and MP3.
  - Write the runtime files into `public/audio/`.
  - Write `scripts/audio/validate.ts`. On every run it recomputes these checks from the current files:
    - loudness;
    - true peak after encoding;
    - the end-to-start discontinuity;
    - head and tail energy balance;
    - interior gaps;
    - mono compatibility (0.5L + 0.5R);
    - decoded frame counts.

    Give the validator a known-good baseline, plus one mutation for each check, each of which must be rejected for its named reason.
  - Wire the validator into `asset-check`.
- **Verify:**
  - `make checkall-ci` passes.
  - Each mutation fixture fails with its specific reason.

### P6.5: WebAudio mixer and positional sources
- **Depends on:** P5.2, P2.7.
- **Steps:**
  - Write `src/audio/mixer.ts` with an `AudioContext` that unlocks on the first user gesture (Enter VR or the first desktop click).
  - Use separate music and SFX gain buses, wired to the settings volumes.
  - Attach a `PannerNode` (HRTF) to every positional source and the listener to the XR camera.
  - Bound the voice count, rate-limit the rustle, and crossfade between the gallery and world scores on portal transitions.
  - Suspend the context on visibility hidden. Release all buffers and nodes on dispose.
- **Verify:** Unit tests with a fake `AudioContext` cover:
  - gain routing;
  - mute;
  - voice bounds;
  - the rustle rate limit;
  - the crossfade;
  - releasing every node on dispose.

### P6.6: Audio integration and headset check (owner)
- **Depends on:** P6.4, P6.5, P5.5.
- **Steps:**
  - Write an e2e test that unlocks audio on the first gesture and asserts no decode errors, a running context, and that the score is playing (diag).
  - Paul listens on the Quest 3 to:
    - the mix;
    - how the positional SFX are placed, including the bell from the steeple and the wind at the cypress;
    - several loop wraps of each score;
    - the portal crossfade.
- **Verify:**
  - `make e2e` is green.
  - `docs/verification.md` records P6-A3.
  - **The card stays open until Paul signs off.**

## Phase exit
- `make checkall-ci` and `make e2e` are green.
- P6-A1 through P6-A3 have evidence.
- Technical, creative and rights status are recorded separately for each cue.
- One owner-approved push and deploy has happened.
