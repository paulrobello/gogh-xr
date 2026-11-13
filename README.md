# Gogh XR

A Meta Quest 3 WebXR experience. You start in a small gallery of seven Van Gogh paintings, step through the frame of *The Starry Night* and walk inside it. The world is painted in hundreds of thousands of animated GPU brushstrokes that follow the flow of the original paint, with a swirling sky, pulsing stars, a flickering cypress and paint that parts around your head and hands.

Live: <https://gogh-xr.pardev.net>. Open it in Quest Browser and press Enter VR. It also runs on a desktop browser with keyboard and mouse.

Built with three.js, raw GLSL, Vite and bun. Requirements are in [PRD.md](PRD.md), the per-phase plans in [plans/](plans/), and the full flag and system reference in [CLAUDE.md](CLAUDE.md).

## Controls

| Action | Quest 3 | Desktop |
| --- | --- | --- |
| Move | Left stick | WASD (Shift to sprint) |
| Turn | Right stick X (snap by default) | Q and E (mouse look under pointer lock) |
| Teleport | Push the right stick forward, aim, release | Hold T, release to jump |
| Fly (toggle), up and down | Right B, right stick Y | F, then Space and C |
| Settings panel | Right A | M |
| Select, grab | Triggers, grips | Left and right mouse buttons, under pointer lock |
| Recenter | Click both sticks for 1 s | R |
| Return to the gallery | The panel's button | G |
| Performance HUD | Left X | H |

Click the page once to take pointer lock on the desktop. Walking into the Starry Night frame in the gallery, or teleporting onto its threshold, enters the painting.

## Comfort options

All of these are in the settings panel (grab it with a grip to move it, with two hands to scale it) and persist across visits.

- Snap turn (30 or 45 degrees) or smooth turn.
- Comfort vignette strength, and move speed.
- Seated mode with a standing height setting.
- Calm: scales every painted motion from still (0) to full (1).
- Hand orbs on or off.
- Quality: 72 Hz, 90 Hz or max-beauty, plus a fixed quality level or Auto.
- Music and sound-effect volume, and the performance HUD.

## Development

Requires [bun](https://bun.sh), and ffmpeg 9.0.2 for the audio checks.

```sh
make install                      # bun install --frozen-lockfile
bunx playwright install chromium  # once, before make e2e
make dev                          # Vite dev server on http://localhost:4252
```

Ports: the dev server uses 4252 and the e2e preview server 4253 (override with `E2E_PORT`). Both are set in `scripts/ports.ts`.

Make targets:

- `make checkall` is the fast gate: lint, typecheck, test, build and bundle-check (which also enforces the gzip size budget).
- `make checkall-ci` adds gitleaks, `bun audit` and `asset-check`. Run it before any push.
- `make e2e` runs the Playwright suite against the IWER-emulated Quest 3. It is local only. `make preview` serves the e2e build and `make update-ab` runs the served build A-to-B update check.
- `make asset-check` verifies asset provenance and the audio files. `make audio` and `make audio-audition` master the audio, and `make bake` regenerates the Starry Night bake outputs.
- `make build`, `test`, `lint`, `fmt`, `typecheck`, `bundle-check` and `pre-commit` run one step each. `make dev-start`, `dev-stop` and `dev-restart` manage the dev server.

### Testing on the headset

Not yet verified on a device. The plan, from [PRD.md](PRD.md) decision D16, is to run the dev server and forward it over USB, which Quest Browser treats as a secure context, so no certificates are needed:

1. Enable developer mode on the Quest 3 and connect it with USB, then accept the debugging prompt in the headset.
2. Run `make dev`.
3. Run `adb reverse tcp:4252 tcp:4252`.
4. Open `http://localhost:4252` in Quest Browser and press Enter VR.

### Flags

Flags go in the page URL. The ones you are most likely to use:

| Flag | Effect |
| --- | --- |
| `?painting=starry-night` | Boot straight into the Starry Night world. |
| `?hud` | Show the performance HUD. |
| `?diag` | Install `window.__goghDiag()` for renderer, XR and stroke state. |
| `?bench=N` | Run the stroke benchmark with N strokes. |
| `?beauty`, `?hz=72\|90\|120` | Max-beauty mode, or the XR target frame rate. |
| `?calm=0..1`, `?noanim` | Scale or freeze the painted motion. |
| `?seated`, `?turn=snap\|smooth` | Seated mode and turn mode for the session. |
| `?seed=N` | Seed for the generated world. |
| `?mute` | Start with the master audio gain at 0. |
| `?scene=bare` | Boot the bare test scene instead of the gallery. |

These override the stored setting for the session and are never written back. The testing-only flags (`?zdiag`, `?ab`, `?wrap`, `?nogov`, `?slow`, `?nocache`, `?update`, `?iwer` and the rest) are documented in [CLAUDE.md](CLAUDE.md).

## Status

Paul approved the live Quest 3 release on November 13, 2026. The [performance report](docs/perf.md#sc1-release-candidate-route-p72-2026-11-13) records the Quest run, and [final release acceptance](docs/verification.md#p74-final-release-acceptance-2026-11-13) tracks the release gates.

| Phase | What | Built | Headset check | PRD | Plan |
| --- | --- | --- | --- | --- | --- |
| P0 | Foundation and feasibility | Yes | Signed off | [P0](PRD.md#p0--foundation-and-feasibility) | [plan](plans/phase-0-foundation.md) |
| P1 | Stroke engine | Yes | Signed off | [P1](PRD.md#p1--stroke-engine) | [plan](plans/phase-1-stroke-engine.md) |
| P2 | Starry Night world | Yes | Signed off | [P2](PRD.md#p2--starry-night-world) | [plan](plans/phase-2-starry-night-world.md) |
| P3 | Locomotion and comfort | Yes | Signed off | [P3](PRD.md#p3--locomotion-and-comfort-parallel-with-p4) | [plan](plans/phase-3-locomotion-comfort.md) |
| P4 | Living paint | Yes | Signed off | [P4](PRD.md#p4--living-paint-parallel-with-p3) | [plan](plans/phase-4-living-paint.md) |
| P5 | Gallery, portal and settings | Yes | Signed off | [P5](PRD.md#p5--gallery-portal-and-settings) | [plan](plans/phase-5-gallery-portal-settings.md) |
| P6 | Audio | Yes | Signed off | [P6](PRD.md#p6--audio) | [plan](plans/phase-6-audio.md) |
| P7 | Release | Release gates and Quest performance pass complete | Signed off | [P7](PRD.md#p7--release) | [plan](plans/phase-7-release.md) |

## Credits and provenance

- The seven paintings are public domain, scanned by Google Art Project, the Kröller-Müller Museum, the Van Gogh Museum and others and sourced from Wikimedia Commons. File names, URLs, license tags and SHA-256 hashes are in [assets/PROVENANCE.md](assets/PROVENANCE.md).
- The two music scores were generated by Paul in Suno. The wind, crickets, church bell, portal whoosh and stroke rustle effects were generated with the ElevenLabs sound-effects API. Source hashes are in [assets/PROVENANCE.md](assets/PROVENANCE.md). Prompts, settings, approval status and loop validation are in [docs/audio/provenance.md](docs/audio/provenance.md), [docs/audio/suno-prompts.md](docs/audio/suno-prompts.md) and [docs/audio/derivatives.md](docs/audio/derivatives.md).
- Release rights for the Suno and ElevenLabs output still need a check against their current terms before release.

## License

The source code is MIT licensed (see [LICENSE](LICENSE)). Media under `assets/` and `public/` (the paintings and the audio) is not covered by the MIT license. Its source, license and rights status are listed per file in [assets/PROVENANCE.md](assets/PROVENANCE.md).
