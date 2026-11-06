# Phase 1: Stroke Engine

PRD: [P1](../PRD.md#p1--stroke-engine). Phase 1 builds the renderer that every world uses. It needs P0 complete, with the P0.8 budgets measured on the headset.

## Visible-stroke budget (starting values; replace with P0.8 measurements)

| Mode | Target | Visible strokes (governor range) | Source |
| --- | --- | --- | --- |
| Default | 90 Hz | 250k (100k–400k) | Planning estimate, 2026-11-05 |
| Max beauty | 72 Hz | 600k | Planning estimate |
| Authored world total | — | 1–1.5M across bands | Planning estimate |

Distance bands are Near (0–6 m), Mid (6–25 m) and Far (25 m to the boundary). Each band sets its own stroke size, density and update rate.

## Tasks

### P1.1: Scan analysis bake
- **Depends on:** P0.4b.
- **Steps:**
  - `scripts/bake/analyze-scan.ts` reads `assets/scans/starry-night.jpg` and writes the following to `public/paintings/starry-night/`:
    - **Palette.** k-means with 24 swatches, written to `palette.json`.
    - **Orientation field.** A structure tensor over Gaussian-smoothed luminance at 1024², encoded as RG8 angle plus coherence in `flow.png`.
    - **Region masks.** Sky, stars, moon, cypress, village, hills and church. Use a hand-authored polygon JSON (`regions.json`, committed) and rasterize it to `regions.png`.
    - **Stroke-length hint.** The local coherence, written to `flow.png` B.
  - The bake is deterministic. `make bake` runs it, and `asset-check` verifies the output hashes against `assets/PROVENANCE.md`.
- **Verify:** Unit tests on synthetic images:
  - Horizontal stripes give 0°.
  - Concentric rings give tangential angles within ±3°.
  - A noise image has coherence below 0.2.
  - A checked-in 64² fixture gives the same bake output twice.

### P1.2: Brush-alpha atlas
- **Depends on:** P0.1.
- **Steps:**
  - `src/render/strokes/brush-atlas.ts` procedurally generates a 2048² atlas with 16 brush masks: a tapered impasto ridge, bristle streaks, dab, comma and crescent. Ridge relief goes in a height channel, which the shader uses for fake lighting.
  - Generate once at boot into a `DataTexture` with mipmaps.
  - Use the `?seed` flag for determinism.
- **Verify:** Unit tests check that each mask has a non-empty alpha coverage of 15–70% and that a fixed seed produces the same atlas hash.

### P1.3: Instanced stroke core
- **Depends on:** P0.7, P1.2.
- **Steps:**
  - `StrokeBatch` holds one `InstancedBufferGeometry` (a unit quad) per spatial chunk. Each instance carries:
    - `position` (vec3);
    - `normal` (oct-encoded);
    - `tangent` (angle about the normal);
    - `color` (RGBA8);
    - `size` (vec2);
    - `brush` (u8);
    - `layer` (u8: sky/star/moon/cypress/ground/building);
    - `phase` (u8).
  - Use a `RawShaderMaterial` in GLSL ES 3.00 that:
    - billboards the quad onto its surface plane and orients it along the tangent;
    - samples the atlas for alpha and relief;
    - lights the relief with a cheap fixed moonlight term;
    - writes `alphaToCoverage: true` with no blending.
  - Sort chunks front-to-back by camera distance every frame on the CPU (chunk count is in the low hundreds).
  - Cull chunks against the frustum by their bounding spheres.
  - Shaders live in `src/render/strokes/*.glsl`, imported with `?raw`.
  - `dispose()` releases the geometry, the material and the textures.
- **Verify:**
  - Unit tests cover instance packing and unpacking round trips, chunk bounds and sort order, and disposal.
  - The e2e suite renders `?iwer&diag&strokesTest` with no WebGL or shader errors, and `diag().strokes.visible` is greater than 0.

### P1.4: Distance-band LOD and density control
- **Depends on:** P1.3.
- **Steps:**
  - Each chunk stores its instances sorted by importance (a stratified random order), so a density scalar `d ∈ [0,1]` draws the first `d·count` instances. This changes only the instance count, with no rebuild.
  - Each band has its own `d`, its own stroke-size multiplier, and a distance hysteresis of 0.5 m.
  - The API is `setDensity(band, d)` plus `visibleCount()`.
- **Verify:** Unit tests check that the density sets the draw count exactly, that hysteresis prevents flapping in a scripted back-and-forth path, and that visible counts match the budget table.

### P1.5: Test canvas demo
- **Depends on:** P1.1, P1.3.
- **Steps:**
  - `?demo=canvas` places a 4 × 3.17 m plane in front of the viewer.
  - Fill the plane with about 200k strokes. Take color from the scan and orientation from `flow.png`, and pick the brush by region.
  - This demo is the first visual proof of the painterly look.
- **Verify:**
  - Capture `?shot` with `?noanim&seed=1`, commit it as `docs/shots/p1-canvas.png`, and compare it side by side with the scan in `docs/verification.md`.
  - The e2e suite asserts there are no errors.

### P1.6: Quality governor and frame-rate control
- **Depends on:** P1.4, P0.8.
- **Steps:**
  - `src/render/governor.ts` is a state machine over per-frame timings:
    - Use the GPU timer when one is available, otherwise frame delta.
    - Budget is 11.1 ms at 90 Hz and 13.9 ms at 72 Hz.
    - Use a 0.5 s window to decide when to shed and a 3 s window to decide when to restore.
  - Shed in this order:
    1. Far density, then mid, then near, down to the minimums in the budget table.
    2. Framebuffer scale, from 1.0 down to 0.85.
    3. Foveation, from 0 up to 0.5. P0.8 found 1.0 too blocky and saw no frame-time gain from foveation on the bench, so this step is a last resort.
    4. After 3 s of continuous overrun at minimum quality, call `updateTargetFrameRate(72)` and show a HUD notice.
  - Restore in reverse order, with hysteresis.
  - The "Max beauty" mode targets 72 Hz with the higher budget.
  - Add a `?slow=<ms>` flag that busy-waits on the CPU each frame. It exists only for testing the governor.
- **Verify:**
  - Unit tests: a scripted timing trace drives the exact shed and restore sequence, with no oscillation on a trace that sits right at the budget.
  - The e2e test uses `?iwer&slow=14`. It asserts that the governor reaches density-minimum, then requests 72, and the diag shows the sequence.

### P1.7: Perf HUD
- **Depends on:** P1.6.
- **Steps:**
  - A Troika SDF HUD (`configureTextBuilder({ useWorker: false })`, local font with its license) shows:
    - fps;
    - mean and p99 frame ms;
    - GPU ms, or "n/a";
    - target Hz;
    - the governor level and per-band density;
    - visible strokes;
    - foveation;
    - framebuffer scale.
  - The HUD follows the head at a comfortable distance, about 0.3 m wide. `?hud` turns it on, and later the settings panel can too.
  - Update the HUD text at 4 Hz, not every frame.
- **Verify:**
  - The e2e test asserts that the HUD text matches `diag()` within one update.
  - A unit test confirms the HUD redraws only when its values change.

### P1.8: Headset check P1 (owner)
- **Depends on:** P1.5, P1.6, P1.7, and an owner-approved deploy.
- **Steps:**
  - Paul views `?demo=canvas&hud` on the Quest 3:
    - near, at arm's length;
    - at 2 m;
    - at oblique angles.
  - He records the stroke-look verdict, the OVR Metrics frame times at the default budget, and the governor behaviour under the benchmark load.
- **Verify:**
  - `docs/verification.md` records P1-A4 with OVR screenshots.
  - **The card stays open until Paul signs off.**

### P1.9: Multiview contingency (conditional)
- **Depends on:** P1.8.
- **Trigger:** Open this card only if P1.8 profiling shows the app is CPU-bound. Meta's test is to disable rendering and see whether frame time stays above budget. Otherwise close it as not needed, with the evidence.
- **Steps (if opened):**
  - Prototype `OCULUS_multiview` per Meta's [web-multiview doc](https://developers.meta.com/horizon/documentation/web/web-multiview/): projection layer `textureType: 'texture-array'`, `framebufferTextureMultisampleMultiviewOVR`, and `layout(num_views=2)` with `gl_ViewID_OVR` in the stroke shaders.
  - Do the prototype on a patched local copy of the three r186 `WebXRManager`.
  - Measure before and after on the headset.
- **Verify:** The before and after OVR numbers are recorded in `docs/decisions/0002-multiview.md`.

## Phase exit
- `make checkall-ci` and `make e2e` are green.
- P1-A1 through P1-A4 have evidence.
- One owner-approved push and deploy has happened.
