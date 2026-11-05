# Gogh XR — Suno prompt pack

Written 2026-11-05 from `~/.claude/guides/suno.md`. Generate in Custom mode with Instrumental on. Make 2 or more takes of each cue and pick the best one.

## How the cues are used

| Cue | Where it plays | Energy | Loop | Mix space |
| --- | --- | --- | --- | --- |
| `score-night` | Inside *The Starry Night* while you walk, teleport and fly | Low to medium, slow swells, dreamy and a little restless | Seamless loop, 120 to 180 s, prepared afterwards | Leave the low-mid and high band clear for wind and crickets. No sharp transients that would fight the church bell |
| `score-gallery` | The quiet gallery room with seven framed paintings | Very low, intimate, anticipatory | Seamless loop, 90 to 150 s | Sits under the portal whoosh. Must crossfade cleanly into `score-night` |

## score-night

```text
Style:
Original instrumental nocturne for an immersive walk through a living night painting. Dreamy, luminous and gently restless, wonder tinged with melancholy. Felt piano carries a slow, wandering motif. Soft string ensemble swells and recedes like wind currents. A distant, breathy accordion-like reed texture and a faint celesta shimmer suggest stars. A low sustained cello drone grounds it. Approximately 64 BPM, rubato, flowing, no steady drumbeat. The opening fades in from near silence, the body slowly circles a swirling theme with gentle crescendos, and the ending settles back to a soft sustained chord that can loop into the opening. Duration around two and a half minutes. Keep it sparse in the high frequencies and low-mids to leave room for night wind, crickets and a distant bell.

Exclude styles:
vocals, singing, spoken word, choir, humming, drums, drum kit, percussion loops, hip-hop beats, electronic beats, synth bass, EDM, trap, distorted guitar, electric guitar, brass fanfare, cinematic trailer hits, bass drops, risers, orchestral bombast, fast tempo

Settings:
Instrumental: On
Vocal Gender: not selected
Duration: 2:30 (or nearest available)
Max Mode: Off
Weirdness: 25%
Style Influence: 80%
Variety: Off
Personalize / My Taste: Off
Model: v6 (Paul, 2026-11-05)
```

## score-gallery

```text
Style:
Original instrumental ambient interlude for a quiet museum room at night before stepping into a painting. Hushed, intimate and anticipatory. Solo felt piano plays sparse, gently voiced chords with long sustain pedal. Very soft string pad underneath. An occasional faint celesta note, like light catching a varnished canvas. Approximately 58 BPM, free and rubato, no percussion. Very even dynamics with no crescendo peaks. The opening is near silence, the body is a calm circling progression, and the ending is a soft unresolved chord that loops smoothly. Duration around two minutes. Keep it quieter and simpler than a full score so that a soft swirling transition sound can play over it.

Exclude styles:
vocals, singing, spoken word, choir, humming, drums, percussion, beats, electronic beats, synth bass, EDM, electric guitar, brass, cinematic hits, risers, bass drops, loud dynamics, fast tempo, jazz swing

Settings:
Instrumental: On
Vocal Gender: not selected
Duration: 2:00 (or nearest available)
Max Mode: Off
Weirdness: 20%
Style Influence: 80%
Variety: Off
Personalize / My Taste: Off
Model: v6 (Paul, 2026-11-05)
```

## What to send back

For each take you select:
- the full-song **WAV** download (web interface, Pro/Premier)
- the cue role it fills (`score-night` or `score-gallery`)
- the Suno song link or ID
- the model actually selected
- your account plan when you generated it
- any changes you made to the Style, Exclude or Settings text above

Drop the WAVs anywhere and give me the path. I archive them unchanged with their SHA-256 hashes, then prepare the seamless loops and Opus/MP3 runtime files from copies.
