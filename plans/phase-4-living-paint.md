# Phase 4: Living Paint

PRD: [P4](../PRD.md#p4--living-paint-parallel-with-p3). This phase runs in parallel with P3. It owns the `src/motion/` path and the motion sections of the stroke shaders. Every motion is computed in the vertex shader from uniforms and per-instance `layer` and `phase` values, and no simulation state is stored (PRD D7).

## Tasks

### P4.1: Motion uniform system and calm scaling
- **Depends on:** P1.3.
- **Steps:**
  - `src/motion/clock.ts` provides `uTime`, `uCalm` (0–1, default 1) and `uFreeze`.
  - `?noanim` sets `uFreeze` so that the time is fixed.
  - A shared GLSL include `motion.glsl` dispatches on `layer` to the per-layer motion functions.
  - Every motion amplitude and speed is multiplied by `uCalm`. At `uCalm` 0 strokes are static.
- **Verify:**
  - Unit tests check the uniform plumbing and that calm scaling reaches every layer.
  - In e2e, `?noanim` makes two shots taken 500 ms apart pixel-identical.

### P4.2: Sky swirl and wind currents
- **Depends on:** P4.1, P2.5, P2.6.
- **Steps:**
  - Fit the vortex centres and radii to the painting's spirals: the large central double swirl and the smaller eddies. Author them in `regions.json` and project them onto the dome.
  - Each sky stroke moves along the analytic velocity field (a sum of Rankine-style vortices plus a horizontal drift). The stroke's orientation is updated to follow the flow.
  - Each stroke loops along a short arc and wraps with a phase offset. This keeps strokes from drifting off their region.
- **Verify:** Unit tests check that the velocity field is continuous, its speed is bounded, it circulates in the correct direction for each canvas swirl, and wrapped strokes stay inside their region radius.

### P4.3: Pulsing star and moon halos
- **Depends on:** P4.1, P2.5.
- **Steps:**
  - Star and moon strokes form concentric rings around the anchors.
  - Ring radius and brightness pulse outward with a per-star phase and period of 3–7 s.
  - Each halo also gets a small additive-blend pass, the only blended pass, drawn after the opaque strokes.
  - The moon is a crescent with its own slower halo.
- **Verify:**
  - Unit tests check that the ring phase math is periodic and that halo brightness is bounded.
  - The e2e test counts additive draw calls and requires at most 2.

### P4.4: Cypress flame
- **Depends on:** P4.1, P2.4.
- **Steps:**
  - Cypress strokes rise along the lobe tangent. Lateral flicker uses noise keyed by lobe id and height, with amplitude growing toward the tips.
  - Strokes respawn at the base of their lobe with a phase offset, so the tree reads as licking upward like a flame.
- **Verify:** Unit tests check that the vertical speed is positive along the lobes, that the flicker amplitude rises with height, and that respawn keeps every stroke inside the hull.

### P4.5: Reactive strokes
- **Depends on:** P4.1.
- **Steps:**
  - `src/motion/reactive.ts` pushes the head and both controller positions into `uDisturbers[3]`, along with each one's velocity.
  - It keeps a short CPU history of 8 samples per disturber at about 60 ms intervals and passes it as `uWake[24]`.
  - The vertex shader displaces strokes within a 0.6 m radius away from the current position, with smooth falloff. It also swirls them around the recent wake, with a time decay of about 1.2 s. Displaced strokes spring back.
  - Calm mode scales the displacement.
- **Verify:** Unit tests check that the falloff is 0 beyond the radius and that the wake decay is monotonic and bounded. A unit test of the GLSL-equivalent TypeScript reference function checks that displacement is never larger than the radius.

### P4.6: Motion integration e2e
- **Depends on:** P4.2, P4.3, P4.4, P4.5, P2.7.
- **Steps:**
  - The e2e test runs `?painting=starry-night&iwer&diag`:
    - It moves an IWER controller through cypress strokes and asserts that the reactive uniforms update.
    - It checks that diag reports a nonzero frame delta of motion at calm 1 and zero at calm 0.
    - It requires no shader errors.
  - Record desktop GPU frame time before and after enabling motion in `docs/perf.md`.
- **Verify:** `make e2e` is green.

### P4.7: Headset check P4 (owner)
- **Depends on:** P4.6, and an owner-approved deploy.
- **Steps:** Paul judges the four motions and the calm slider from the painter's spot, while walking through the cypress, and in flight. Record his verdict and the OVR frame times. If the reactive wake looks flat, file the ping-pong wake-texture polish card (PRD D7).
- **Verify:**
  - `docs/verification.md` records P4-A3.
  - **The card stays open until Paul signs off.**

## Phase exit
- `make checkall-ci` and `make e2e` are green.
- P4-A1 through P4-A3 have evidence.
