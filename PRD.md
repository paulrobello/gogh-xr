# Gogh XR — Product Requirements

| Field | Value |
| --- | --- |
| Product | Gogh XR: walk inside Van Gogh paintings in WebXR |
| Repo | `~/Repos/gogh-xr` → `github.com/paulrobello/gogh-xr` (public, MIT) |
| Owner | Paul Robello |
| Status | Planned. No implementation yet |
| Date | 2026-11-05 |
| Live URL (planned) | `https://gogh-xr.pardev.net` |
| Ports | 4252 dev server, 4253 e2e preview (recorded in `~/.claude/used_ports.md`) |

## Overview

Gogh XR is a Meta Quest 3 WebXR experience. You start in a small gallery room and step through the frame of *The Starry Night* (1889) into a walkable 3D version of the painting. The hills, village, church and cypress are built from simple procedural forms. More than a million GPU-instanced brushstrokes cover them, with colors and directions sampled from a public-domain scan of the canvas. Shaders animate those strokes, so the sky swirls, the stars and moon pulse, the cypress flickers like a flame, and strokes part around your head and hands as you move through them.

The visual target is to use as much of the Quest 3's capacity as possible, sustained at 90 Hz. An adaptive quality governor protects that frame rate, and an optional 72 Hz max-beauty mode trades refresh rate for stroke density.

The gallery has seven frames. *The Starry Night* is live. Six more hang as "coming soon": *Chestnut Trees in Blossom*, *Les Alyscamps*, *Café Terrace at Night*, *The Bedroom*, *Wheatfield with Crows* and *Starry Night Over the Rhône*. Each painting is a registry entry, so a later painting needs only a new world module.

## Goals

1. **Presence inside the painting.** At the painter's spot on the hilltop, the headset view reads as *The Starry Night*: same composition, palette and stroke direction. Moving away from that spot reveals a coherent 3D world painted in the same strokes.
2. **Living paint.** All four motions ship in v1: the sky swirl and wind currents, pulsing star and moon halos, the flame-like cypress, and strokes that react to the head and both controllers.
3. **Use the headset's full capacity without dropping frames.** Hold 90 Hz on Quest 3 with the stroke density the device can sustain. The density is measured on the device, not guessed. The governor degrades quality before frames drop.
4. **Free, comfortable movement.** Room-scale walking, teleport, smooth stick movement and flight, plus snap or smooth turn, a tunnel vignette, seated mode and a calm-motion slider.
5. **Extensible gallery.** Painting selection uses a data-driven registry and a gallery portal, so adding a painting is a world module plus a registry entry.
6. **Agent-operable and verifiable.** A desktop preview, IWER-emulated XR tests and in-app diagnostics let agents build and check almost everything without the headset. The owner's per-phase headset check covers what emulation cannot: comfort, sustained frame rate and look.

### Success criteria (v1)

- **SC1.** Starry Night holds a median of 90 fps on Quest 3 in the default mode, measured with OVR Metrics Tool. In a 5-minute session that walks the whole diorama and flies the boundary, fewer than 1% of frames exceed the 11.1 ms budget.
- **SC2.** A screenshot from the painter's spot matches the reference canvas closely enough that the owner accepts it side by side. The phase 2 plan sets the measured check.
- **SC3.** The owner accepts all four locomotion modes and all four comfort options on the headset, with no comfort complaints in a 15-minute session.
- **SC4.** The owner accepts the gallery-to-painting portal and the return path on the headset.
- **SC5.** `make checkall-ci` and the local `make e2e` suite (Playwright with IWER) are green on the release commit.
- **SC6.** The live site at `gogh-xr.pardev.net` renders and enters immersive VR from Quest Browser.

## Non-Goals

- **Hand tracking** is deselected for v1. Controllers and the desktop preview are the inputs. It is a roadmap item and will reuse the same actions.
- **Passthrough/MR** is out of scope. Gogh XR is a fully immersive VR experience.
- **A native APK** (Unity, Godot or Unreal) is excluded. The runtime is WebXR in Quest Browser.
- **Gaussian splats** were considered and rejected. Sorting cost in stereo on Quest is a risk, and no splat source exists for a painting.
- **Full-screen post-processing** is excluded. It disables fixed foveation and MSAA on Quest, per Meta's FFR guidance. Glow comes from additive halo strokes.
- **A physics engine** is excluded. Collision is only ground-following on the terrain heightfield. Buildings and trees are non-solid, and their strokes part around you.
- **Worlds for the six other paintings.** They are "coming soon" frames in v1. Each one is a separate later project or phase.
- **Multiview** (`OCULUS_multiview` / `OVR_multiview2`) is excluded from v1. See Architecture Direction, decision D3.
- **WebGPU/TSL** is excluded. WebGPU does not reliably bind to immersive WebXR sessions in Quest Browser.
- **Running browser or e2e suites in CI** is excluded. They are a local-only done gate, per the house rule in `~/.claude/guides/git-ci.md`.
- **Multiplayer, accounts and analytics** are excluded.

## Reference Projects

| Repo | What is reused |
| --- | --- |
| `~/Repos/mux-xr` | Quest 3 WebXR baseline. Reused pieces: <ul><li>Version pins: three 0.186.1, Vite 8.3.5, TypeScript 7.0.2, Vitest 5.0.3, Biome 2.5.15, bun 1.4.4, Playwright 1.63.0, troika-three-text 0.52.5.</li><li>Makefile shape: `checkall` = lint + typecheck + test + build; `checkall-ci` adds gitleaks and `bun audit`.</li><li>`dev-stop` that waits for the port to free.</li><li>The controller contract (trigger selects, grip manipulates).</li><li>Troika SDF labels with `configureTextBuilder({ useWorker: false })` and local fonts.</li><li>Build-version polling and XR-safe reload (`src/update-check.ts`, `src/reload.ts`).</li><li>Device-local settings validation and versioning.</li><li>The `docs/verification.md` evidence log.</li></ul> |
| `~/Repos/the-cube` | Vite + bun + Playwright/Vitest layout. Reused pieces: <ul><li>The GPU-default `playwright.config.ts`: Metal ANGLE flags, `PW_GPU=swiftshader` opt-in, `"50%"` workers, and logging `UNMASKED_RENDERER_WEBGL`.</li><li>Module-per-domain `src/` layout.</li><li>Perf and balance docs under `docs/`.</li><li>Object pooling for transient effects.</li></ul> |
| `~/Repos/webxr1` | IWSDK starter. Its dev plugin already wraps an XR emulator in the browser, which is prior art for the IWER-in-Playwright harness (P0). IWSDK itself is not adopted, because it pins `super-three` 0.185, which conflicts with the mux-xr pins. |
| `~/Repos/parsplat` | Considered for splat rendering (Spark) and rejected. See Non-Goals. |
| `~/.claude/guides/webxr.md` | House WebXR rules: <ul><li>Controller contract.</li><li>Laser and contact hover.</li><li>Grabbable UI roots with bounded scale.</li><li>Recenter with both stick-clicks.</li><li>SDF text.</li><li>Device-local persistence.</li><li>Update notices.</li><li>Keeping physical acceptance separate from browser evidence.</li></ul> |

Vault prior art used: `Patterns/mux-xr-quest-interaction-patterns.md`, covering the `Group.lookAt` +Z vs controller-ray −Z trap and the IWSDK stick conventions. `Patterns/gpu-resource-cleanup-patterns-webgpu-and-threejs.md` covers InstancedMesh disposal. `Debugging/gpu-default-playwright-fixes-render-timeouts.md` covers Playwright GPU settings, and `Patterns/github-pages-https-certificate-provisioning-pattern.md` covers Pages domain binding.

## Architecture Direction

### Stack (pinned in plan files, not manifests, until P0 scaffolds them)

The stack is bun 1.4.4, TypeScript 7.0.2, Vite 8.3.5, three 0.186.1 with @types/three 0.186.0 and @types/webxr 0.5.24, troika-three-text 0.52.5, Biome 2.5.15, Vitest 5.0.3 with happy-dom 21.0.4, Playwright 1.63.0 and iwer 2.8.0 (dev/test only). Pre-commit runs gitleaks and detect-private-key.

troika 0.53.1 is the latest release. 0.52.5 is pinned because it is proven on three 0.186.1 in mux-xr.

### Decisions

- **D1. Renderer.** three.js `WebGLRenderer` on WebGL2, with custom `RawShaderMaterial`/`ShaderMaterial` in GLSL ES 3.00 and standard per-eye stereo.
- **D2. Strokes.**
  - Each stroke is one instanced quad. Per-instance data (position, normal, flow tangent, color, width, length, layer id and phase) is packed into instance attributes or data textures.
  - Strokes are grouped in spatial chunks by distance band, with one draw call per chunk and material.
  - The target is about 20–40 draw calls per eye.
  - Strokes render with alpha-to-coverage and 4x MSAA in a single opaque pass, sorted front-to-back by chunk, with no alpha blending.
  - Star and moon halos are the exception: they use a small additive pass.
  - Stroke shapes come from a small atlas of brush-alpha masks generated procedurally at build time.
- **D3. No multiview in v1.** three r186's `WebXRManager` and `WebGLRenderer` contain no multiview path. Meta's [multiview doc](https://developers.meta.com/horizon/documentation/web/web-multiview/) says multiview only helps CPU-bound apps, and our risk is GPU fill rate. Instancing already cuts draw calls. A contingency card (P1) opens only if headset profiling shows the app is CPU-bound.
- **D4. No full-screen post-processing.** Offscreen passes, such as baking the flow field or a reveal mask, run before the eye pass. This keeps fixed foveation and MSAA active, per Meta's [FFR doc](https://developers.meta.com/horizon/documentation/web/webxr-ffr/).
- **D5. Flow field from the canvas.**
  - A build-time script derives, from the 3840 px source scan in `assets/scans/`: a palette, a stroke-orientation field (structure tensor of the luminance), and region masks for sky, stars, moon, cypress, village, hills and church.
  - The 3D world projects these onto procedural geometry from the painter's spot, which is the camera pose that reproduces the canvas framing.
  - Surfaces outside the canvas frustum extrapolate color and flow from the nearest region of the same type.
- **D6. Procedural world.** All forms are TypeScript generators with fixed seeds:
  - a heightfield for the hills;
  - extruded houses with lit windows;
  - a church with a steeple;
  - a spline-swept cypress;
  - a sky dome and distant ridge as a painted backdrop.

  Strokes carry the detail, and the forms stay low-poly.
- **D7. Motion is stateless in the vertex shader.**
  - The sky swirl advects along analytic vortex fields, fitted to the painting's spirals.
  - Star and moon halos pulse as phase-offset concentric rings.
  - Cypress strokes rise with a flame-like noise.
  - Reactive strokes are displaced away from up to three points (head and both controllers) with a falloff radius and a time-decayed wake. The points' recent positions are passed as uniforms.
  - There is no stored GPU simulation. A ping-pong wake texture is a later polish card, used only if the headset check finds the stateless wake flat.
- **D8. Quality governor.**
  - At session start the app requests 90 Hz via `XRSession.updateTargetFrameRate` and records `supportedFrameRates`. three r186 does not wrap these calls.
  - The governor reads the frame time and the GPU time where `EXT_disjoint_timer_query_webgl2` exists.
  - Under load it sheds in this order: visible stroke density, then framebuffer scale, then fixed foveation from the default 0 up to 0.5. P0.8 found 1.0 too blocky and measured no frame-time gain from foveation on the bench.
  - After about 3 s of sustained overrun it drops to 72 Hz and shows a HUD notice.
  - A "Max beauty" setting runs at 72 Hz with a higher stroke budget.
- **D9. Locomotion.** Room-scale walking is native.
  - Left stick moves smoothly relative to the head.
  - Right stick X snap-turns 30° (smooth turn optional).
  - Right stick forward aims a teleport arc, and releasing it jumps.
  - Right B toggles flight. While flying, right stick Y moves up and down and teleport is disabled.
  - Ground-follow uses the terrain heightfield.
  - A soft boundary sphere of about 50 m radius and 40 m altitude thickens the strokes into painted haze and pushes you back gently.
  - The tunnel vignette applies to smooth movement, smooth turn and flight.
- **D10. UI.**
  - The left menu button opens a grabbable settings panel, which follows the WebXR guide's manipulation contract and uses Troika SDF text.
  - Trigger only selects UI and frames. Grip only grabs the panel.
  - Holding both stick-clicks for 1 s recenters the UI.
  - The desktop preview has WASD/mouse walking with the same actions.
- **D11. Portal.**
  - In the gallery you enter by walking or teleporting through the Starry Night frame plane.
  - The canvas strokes unfurl into 3D over about 2 s. A plain fade replaces this when Calm motion is low.
  - "Return to gallery" lives in the settings panel.
- **D12. Persistence.** Comfort and quality settings are saved in versioned, validated `localStorage` on the device. Last position is not saved.
- **D13. Audio.** WebAudio with positional panners.
  - The ambient score comes from Suno: the owner generates it from a prompt pack and hands back WAV files.
  - Agents generate the SFX with ElevenLabs: wind, crickets, a distant church bell and the portal whoosh.
  - Both go through `$create-game-audio-assets` and `$validate-generated-assets`, with provenance recorded.
  - Audio unlocks on the first user gesture, with independent music and SFX volume.
- **D14. Painting registry.** `src/paintings/registry.ts` lists every painting with: `{ id, title, year, museum, scanProvenance, frameImage, status: 'live' | 'coming-soon', world?: () => Promise<WorldModule> }`. A `WorldModule` exposes `build`, `update`, `dispose`, `spawnPose` and `painterSpot`.
- **D15. Agent operability.** URL flags (all compiled out or inert in production except the HUD toggle):
  - `?iwer` installs the IWER Quest 3 runtime and works in test builds only.
  - `?seed=` fixes randomness.
  - `?noanim` freezes time.
  - `?diag&shot` (a boolean, diag mode only) enables `window.__goghShot()`, which writes a canvas PNG.
  - `?diag` exposes `window.__goghDiag()`, which returns renderer info, stroke counts, governor state, the active painting and the pose.
  - `?hud` shows the perf HUD.
- **D16. Delivery.**
  - The site is served by GitHub Pages from a workflow deploy, at `gogh-xr.pardev.net`.
  - Development on the headset uses `adb reverse tcp:4252 tcp:4252` to `http://localhost:4252`, which is a secure context, so no LAN certificates are needed.
  - Each phase ends with one push and deploy that the owner approves.
  - The app polls for new builds: desktop reloads automatically, and in XR a Reload action appears on the HUD.

### Module layout (planned)

```text
src/
  main.ts                 boot, flags, renderer, XR session
  xr/                     session, frame-rate, foveation, controllers, input actions
  render/strokes/         stroke instancing, chunks, brush atlas, shaders (*.glsl)
  render/governor.ts      quality governor
  world/                  terrain, buildings, cypress, sky dome, boundary
  paintings/              registry, starry-night/ world module, gallery/
  motion/                 swirl, halos, flame, reactive uniforms
  locomotion/             walk, teleport, smooth, flight, turn, vignette, seated
  ui/                     settings panel, HUD, notices, troika labels
  audio/                  mixer, positional sources
  settings/               schema, validation, storage
  update/                 build-id polling, reload
  diag/                   flags, __goghDiag, __goghShot
scripts/                  scan fetch/derive, flow-field bake, dev-stop, e2e
assets/                   source scans + PROVENANCE.md (non-runtime)
public/                   runtime derivatives, CNAME, version manifest
tests/unit/               Vitest
tests/e2e/                Playwright + IWER
docs/                     verification.md, perf.md, audio/, decisions/
```

### Gates

| Gate | Contents | Where it runs |
| --- | --- | --- |
| `make checkall` | Biome lint, then `tsc --noEmit`, Vitest unit tests, `vite build`, and `bundle-check` (no IWER code in the production bundle), ordered fail-fast | Local and CI |
| `make checkall-ci` | `checkall` plus `gitleaks dir`, `bun audit --audit-level high`, and the asset/provenance check | Local, before any push. CI-parity gate |
| `make e2e` | Playwright 1.63.0 on Chromium with Metal ANGLE and IWER 2.8.0 Quest 3 emulation. It fails on shader-compile errors, WebGL errors and console errors | Local only, never in CI. Part of each phase's done gate |
| Headset check | The owner's checklist per phase, evidenced by the HUD and OVR Metrics Tool, logged in `docs/verification.md` | Owner, on the Quest 3. Cards stay open until sign-off |

## Phases

The owner chose "everything in MVP", so v1 is P0 through P7. P3 and P4 run in parallel after P2. Audio asset production (P6.1–P6.3) starts in Wave 1 because it has no code dependency. Every phase ends with green `make checkall-ci` and `make e2e`, an owner headset check, and one owner-approved push and deploy.

### P0 — Foundation and feasibility

Scope:
- Scaffold with the pinned stack, a Makefile, pre-commit, Biome, Vitest and the GPU-default Playwright config.
- A bare scene that enters immersive VR, plus the desktop preview walk mode.
- IWER-in-Playwright proof.
- Diagnostic flags.
- Pages workflow and `gogh-xr.pardev.net` DNS.
- Scan sourcing and provenance.
- A stroke stress benchmark scene with a HUD.

Acceptance:
- **P0-A1.** `make checkall`, `make checkall-ci` and `make e2e` are green on a fresh clone. `make dev`, `make dev-stop` and `make dev-restart` work on port 4252.
- **P0-A2.** The e2e suite boots IWER `metaQuest3`, enters an immersive session, presses a controller trigger, and reads `__goghDiag()`. The production bundle contains no IWER code, checked by a bundle grep in `checkall`.
- **P0-A3.** The desktop preview walks a ground plane with WASD and mouse.
- **P0-A4.** `assets/PROVENANCE.md` lists all 7 scans with file name, URL, license, painting version and SHA-256. Committed runtime derivatives are a 1024 px `frame.webp` per painting. The Starry Night bake input is the 3840 px source scan in `assets/scans/`, which is never served. A frame that fails vetting is recorded as a placeholder.
- **P0-A5.** The live site at `https://gogh-xr.pardev.net` renders the bare scene in a browser, verified by a live render, not an HTTP 200.
- **P0-A6.** Headset check. The owner runs the benchmark on the Quest 3. `docs/perf.md` records the measured stroke counts at which 72, 90 and 120 Hz hold, `supportedFrameRates`, timer-query availability, and alpha-to-coverage vs blended cost. The P1 budgets are updated from these numbers.

### P1 — Stroke engine

Scope:
- Build-time scan analysis: palette, structure-tensor flow field and region masks.
- Brush-alpha atlas.
- Chunked instanced stroke renderer with alpha-to-coverage.
- Distance-band LOD.
- Quality governor with frame-rate control and foveation.
- Perf HUD.
- Multiview contingency card, opened only if the app is shown to be CPU-bound.

Acceptance:
- **P1-A1.** Unit tests cover flow-field orientation on synthetic images, stroke placement density per band, and the governor's state machine.
- **P1-A2.** A test canvas (the scan on a plane, painted in strokes) is recognizably the painting in the desktop preview, captured with `?shot`.
- **P1-A3.** The governor's degradation order and the 72 Hz fallback are verified by unit tests and by an IWER e2e run with a forced slow-frame flag.
- **P1-A4.** Headset check. The owner confirms the stroke look, and OVR Metrics shows 90 Hz held at the P0-measured budget.

### P2 — Starry Night world

Scope:
- Procedural terrain and hills.
- Village houses with lit windows.
- Church.
- Cypress.
- Sky dome and distant ridge.
- Stroke coverage of every surface from the flow field.
- Painter's spot and canvas projection.
- Extrapolation outside the canvas frustum.
- Boundary haze.

Acceptance:
- **P2-A1.** Generators are deterministic for a given seed (unit snapshot of vertex and stroke counts and bounds).
- **P2-A2.** The painter's spot screenshot (`?shot`, `?noanim`, fixed seed) is compared to the reference scan. The comparison uses the downscaled perceptual metric defined in the P2 plan, and its threshold is set and recorded in `docs/verification.md`.
- **P2-A3.** Every world surface is stroke-covered, with no bare mesh visible from any point inside the boundary. This is checked by an e2e sweep of sample poses that counts background-color pixels.
- **P2-A4.** Headset check. The owner accepts the world's look from the painter's spot and while walking, and the frame rate holds.

### P3 — Locomotion and comfort (parallel with P4)

Scope:
- Room-scale walking with ground-follow.
- Smooth stick movement.
- Snap and smooth turn.
- Teleport arc.
- Flight with altitude cap and boundary push-back.
- Tunnel vignette.
- Seated mode.
- Desktop-preview equivalents.

Acceptance:
- **P3-A1.** Unit tests cover deadzone, elapsed-time scaling, snap-turn increments, teleport arc and landing validation, flight cap and boundary response.
- **P3-A2.** IWER e2e tests drive each mode through controller stick and button input and assert the resulting rig pose from `__goghDiag()`.
- **P3-A3.** Headset check. The owner accepts every mode and comfort option for comfort (SC3).

### P4 — Living paint (parallel with P3)

Scope:
- Sky swirl and wind currents.
- Pulsing star and moon halos (additive pass).
- Cypress flame.
- Reactive strokes driven by head and controllers.
- Calm-motion scaling of all motion.

Acceptance:
- **P4-A1.** Unit tests cover the vortex-field math (continuity, bounded speed) and the falloff and wake decay of the reactive uniforms.
- **P4-A2.** `?noanim` freezes all motion, giving deterministic shots. Calm motion at 0 freezes the strokes and at 1 gives the full motion, verified by diag frame-delta.
- **P4-A3.** Headset check. The owner accepts all four motions and the calm slider, and the frame rate holds.

### P5 — Gallery, portal and settings

Scope:
- Gallery room with 7 frames and plaques.
- Painting registry.
- Walk-through portal with stroke-unfurl transition and fade fallback.
- Return to gallery.
- Grabbable settings panel with all comfort and quality options.
- HUD notices.
- Versioned `localStorage` settings.
- Recenter.

Acceptance:
- **P5-A1.** Unit tests cover registry validation, the settings schema with version migration and rejection of invalid stored data, and portal crossing detection.
- **P5-A2.** An IWER e2e test enters the gallery, crosses the Starry Night frame, returns to the gallery, changes a setting, reloads, and finds the setting kept.
- **P5-A3.** Headset check. The owner accepts the gallery, portal, panel manipulation and text crispness (SC4).

### P6 — Audio

Scope:
- Suno prompt pack and owner handoff for the score.
- ElevenLabs SFX for wind, crickets, church bell and portal whoosh.
- Mastering and seamless loops.
- WebAudio mixer with positional sources.
- Gesture unlock.
- Music and SFX volume in settings.

Acceptance:
- **P6-A1.** `docs/audio/` holds the prompt pack, provenance (provider, IDs, model, settings, hashes) and loop validation (seam, loudness and true-peak checks recomputed from the files).
- **P6-A2.** Unit tests cover the mixer volume, mute and disposal logic. An e2e test confirms audio unlocks on first gesture and that there are no decode errors.
- **P6-A3.** Headset check. The owner accepts the mix, positional placement and loop seams.

### P7 — Release

Scope:
- Build-version polling and XR-safe reload.
- Perf pass against SC1.
- README with phase status.
- Final verification log.
- Release push and deploy.

Acceptance:
- **P7-A1.** A served build A→B transition is verified: desktop reloads automatically, and in XR the HUD shows a Reload action and the app ends the session before navigating.
- **P7-A2.** SC1–SC6 are each evidenced in `docs/verification.md`.
- **P7-A3.** Headset check. The owner gives final acceptance on the live URL.

## Roadmap (after v1)

Owner-requested items with no phase yet. Each needs its own plan before it is scheduled.

- **RM1. Find the painter's spot.** An optional start mode. Today a world starts the viewer at the painter's spot (`painterSpot`, D14). In this mode the viewer starts somewhere in the middle of the world instead, and the objective is to find the spot where the 3D world lines up into the painting. Reaching it ends the round, for example by settling the view into the canvas framing. Builds on P2 (the painter's spot and its perceptual match metric), P3 (locomotion) and P5 (the settings panel, where the mode is chosen). Decided by Paul on 2026-11-06:
  - **Start.** A random position in the world.
  - **Hints.** Only when the player asks for one. Nothing is shown unprompted.
  - **No timer or score.**
  - **Reference view.** A HUD panel can show the painting, so the player can try to line up their view with it.
  - **Found.** The view is within 10% of the painter's-spot view, which means a match of 90% or better. The threshold is a tunable setting for testing.
  - **Match readout.** The HUD can show the current percent match.
  Open for its plan:
  - how the percent match is computed in real time on Quest, for example pose and view-angle error against `painterSpot`, or a downscaled image compare;
  - what a hint looks like;
  - what happens when the player finds the spot.

## Risks

- **R-1. Fill rate and overdraw.** Dense alpha-to-coverage strokes at 4x MSAA may cap the visible count far below targets. Mitigations: the P0 benchmark measures the cap first, there are distance bands, the governor sheds density, and stroke size is tuned per band.
- **R-2. Alpha-to-coverage quality.** It can look dithered or aliased compared with blended paint. P0 benchmarks both. If blending wins visually, sorted blending is limited to the near band.
- **R-3. Frame-rate API behavior.** On Quest 3 the browser defaults to 72 Hz. `updateTargetFrameRate` behavior and whether 120 Hz is available are unverified until P0 measures them.
- **R-4. No GPU timer on device.** If `EXT_disjoint_timer_query_webgl2` is missing, the governor uses frame time only, and OVR Metrics becomes the only GPU evidence.
- **R-5. IWER in Playwright is undocumented.** P0 proves it first. If it fails, the e2e suite falls back to IWSDK's emulator plugin or to a WebXR polyfill with scripted poses.
- **R-6. Canvas fidelity.** Projecting a 2D painting onto 3D forms may smear at grazing angles. Mitigations: the painter's spot metric, extrapolation rules and early review on the headset.
- **R-7. Motion comfort.** A swirling sky and reactive strokes may cause discomfort. Mitigations: the calm-motion slider, vignette and per-phase owner comfort checks.
- **R-8. Scan licensing.** Some Wikimedia photos (Yorck, anagoria) may carry photographer tags. Each file is vetted, and a placeholder is used if a file fails.
- **R-9. Pages domain and certificate.** If the custom domain is bound before DNS is authoritative, the certificate may stall. Follow the house order and verify a live render.
- **R-10. Troika on r186.** It is proven at 0.52.5 in mux-xr. 0.53.1 is not adopted without a check.

## Open Questions

These are all measured on the device in P0 or P1, not decided now:

- **OQ1.** The actual `supportedFrameRates` on the owner's Quest 3, and whether 120 Hz is available to WebXR.
- **OQ2.** Whether `EXT_disjoint_timer_query_webgl2` is exposed in Quest Browser.
- **OQ3.** Whether IWER 2.8.0 runs under Playwright headless Chromium, and how.
- **OQ4.** The cost and look of alpha-to-coverage vs blended strokes at the target density.
- **OQ5.** How the 0–1 `fixedFoveation` values map to Quest 3 levels, and how visible the artifacts are on high-contrast strokes.
- **OQ6.** The painter's-spot perceptual metric and its threshold, set in the P2 plan after the first renders. Set in P2.8: SSIM on Rec. 709 luma and mean CIEDE2000 over a 16 × 12 block grid, at 256 px, with provisional thresholds from the first render. See `docs/verification.md` P2-A2.
