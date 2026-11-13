# Headset data session (2026-11-11)

This session collects the headset numbers that the open cards need. Each test is one URL. With `?perf`, the app records frame times in the headset and saves a summary of each segment to localStorage. The summaries survive reloads, so all of them can be read over USB in one call at the end.

## Before you start

- Plug the Quest into the Mac by USB.
- Open the Quest Browser. When I'm told you're ready, I start the VrApi log capture and the browser connection (`adb forward tcp:9222 localabstract:chrome_devtools_remote`).
- Start at quality level 5 with foveation Off. T7 changes the level to Auto. Restore level 5 after the governor history is captured.
- **Segment button:** a single left stick click, released. With `?perf`, every click ends the current segment and starts the next one.
  - On an `?ab=` URL the click also switches the variant.
  - A segment shorter than 1 s is dropped, so never double-click.
  - The first second of every segment is skipped.
- After pressing the Meta button or taking the headset off, click once before you continue, so the pause lands in its own segment.

Each test below starts at the painter's spot (the spawn) unless it says otherwise. "30 s" means about 30 seconds. Exact timing doesn't matter.

## T1: frame times around the world (P2.9 c1, P4.7 c1, P7.2)

`https://gogh-xr.pardev.net/?painting=starry-night&perf&diag`

1. Enter VR. At the painter's spot, look slowly around the whole sky and the village for 60 s. Click.
2. Teleport into the village, between the houses. Look around for 60 s. Click.
3. Teleport to the foot of the big cypress. Look up and around it for 60 s. Click.
4. Press right B to fly, and climb about 20 m. Look around for 60 s. Click.

## T2: what the hands' reaction costs (card 01a1c3941b57, hands)

`https://gogh-xr.pardev.net/?painting=starry-night&perf&diag&ab=reactive`

1. Teleport to the foot of the cypress. Hold both hands in the paint and move them slowly, for 30 s. The variant is `on`. Click.
2. Variant `off`. Keep doing the same, the same way, for 30 s. Click.
3. Variant `on`. Put both hands down at your sides and keep looking at the cypress for 30 s. Click.
4. Variant `off`. Keep your hands at your sides for 30 s.

## T3: what the sky motion variants cost (card 01a1c3941b57, wheel versus wave)

`https://gogh-xr.pardev.net/?painting=starry-night&perf&diag&ab=wrap`

Stay at the painter's spot looking at the big swirl, and keep your head still.

1. 30 s on `wheelrun`. Click.
2. 30 s on `wheelflow`. Click.
3. 30 s on `wave`. Click.
4. 30 s on `wheel`.

## T4: hand speed with the predicted frame time (card 01a1bb2274e5 c3)

`https://gogh-xr.pardev.net/?painting=starry-night&perf&diag&ab=trackertime&slow=20`

`slow=20` makes frames drop on purpose. Sweep your right hand left and right at arm's length, at a steady, calm pace (about one sweep a second, never a fast flick).

1. Sweep for 30 s on `predicted`. Click.
2. Sweep for 30 s on `callback`. Click.
3. Sweep for 30 s on `predicted`.

## T5: gallery and portal (P5.8)

`https://gogh-xr.pardev.net/?perf&diag`

1. Walk to each of the seven plaques and read it from about 1 m away. Note any you can't read easily.
2. Walk into Starry Night's frame, then use the panel's Return to gallery. Note anything that stutters or feels wrong.

## T6: audio (P6.6)

Use the same URL as T5, with the volume up.

1. In the gallery, the music plays.
2. Walk through the portal. The music crosses over to the night score with a whoosh.
3. In the world, check that each of these comes from its own place:
   - wind at the cypress
   - crickets in the grass
   - the church bell, which rings within 30 s and then every 1 to 2 minutes
4. Flick a hand quickly through the cypress paint. You should hear a rustle.
5. Check that the panel's music and sound-effect sliders work.

## T7: governor churn (run last) (card 01a1b35d299e)

`https://gogh-xr.pardev.net/?painting=starry-night&perf&diag&hud`

1. Open the panel (right A) and set Quality level all the way left, to **Auto**. Close the panel. Click.
2. Stand at the painter's spot and look around for 2 minutes. Say whether the strokes jump. Click.
3. Walk and teleport around the village for 2 minutes. Click.
4. Leave the page open with **Auto** still selected. Switching quality levels clears the governor history. Restore level 5 after the history is captured.

## When you're done

Leave the browser open on the T7 page and tell me. I read the saved segments with `bun /tmp/gx-cdp.ts 'JSON.stringify(__goghDiag().perf)'` and the governor history with `__goghDiag().governor`, and I stop the VrApi capture. For T5 and T6, your notes are the data, along with your answer to T7 step 2.
