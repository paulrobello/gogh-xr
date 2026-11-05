# Phase 2: Starry Night World

PRD: [P2](../PRD.md#p2--starry-night-world). Build the walkable 50 m diorama and paint every surface in strokes taken from the canvas. Requires P1.1 (bake), P1.4 (LOD) and the P0.2 scene.

## World layout (reference, metres, +Y up, painter's spot at origin facing −Z)

| Element | Placement |
| --- | --- |
| Painter's spot | (0, hill height, 0). This is the hilltop vantage that reproduces the canvas framing. |
| Cypress | The left foreground, about 4–6 m from the spot, rising about 14 m. |
| Village | Below and ahead, 15–40 m out, with about 20 houses with lit windows. |
| Church | The village centre, with a steeple about 12 m tall. |
| Hills | A rolling heightfield that falls from the spot into the valley, plus a distant ridge as a backdrop mesh. |
| Sky dome | Radius about 120 m. It holds the swirls, 11 stars and the crescent moon at the canvas positions projected onto the dome. |
| Boundary | A soft sphere of about 50 m radius and a 40 m altitude cap, filled with painted haze. |

## Tasks

### P2.1: Painter's spot and canvas projection
- **Depends on:** P1.1.
- **Steps:**
  - `src/paintings/starry-night/canvas-camera.ts` defines the painter's camera: its pose, a vertical FOV fitted so the canvas aspect of 92.1 × 73.7 cm fills the view, and its horizon line.
  - `projectToCanvas(worldPoint) → {uv, inFrustum}` maps a world point onto the canvas.
  - Extrapolation rule: a surface outside the canvas frustum takes the palette and flow statistics of the nearest region of the same layer. Sample them from a per-layer histogram, so that colours outside the frame stay plausible.
- **Verify:** Unit tests check that:
  - the canvas corners project to UV (0,0) and (1,1) within 1e-3;
  - a point behind the camera is `inFrustum: false`;
  - extrapolated samples are drawn from the correct layer's histogram (fixed-seed test).

### P2.2: Terrain heightfield and ground query
- **Depends on:** P0.2.
- **Steps:**
  - `src/world/terrain.ts` builds a seeded fBm heightfield, shaped so that the hilltop sits at the spot and the slope runs down into the valley. Use a 128² grid over 120 m.
  - Add a low-poly distant ridge.
  - `heightAt(x, z)` and `normalAt(x, z)` are used for ground-follow (P3) and stroke scattering.
- **Verify:** Unit tests check that the geometry is deterministic per seed, that `heightAt` matches mesh vertices within 1 cm, and that the spot is the local maximum within 8 m.

### P2.3: Village and church generator
- **Depends on:** P2.2.
- **Steps:**
  - `src/world/village.ts` places about 20 seeded houses: extruded boxes with pitched roofs, sitting on the terrain and arranged to match the canvas village silhouette from the spot.
  - Windows are emissive quads in warm yellow.
  - The church has a nave and a tall, thin steeple.
  - Expose the layer tags: `building`, `window`, `roof`.
- **Verify:** Unit tests check that the output is deterministic, that no house intersects another, and that every house base sits within 5 cm of the terrain.

### P2.4: Cypress generator
- **Depends on:** P2.2.
- **Steps:**
  - `src/world/cypress.ts` sweeps a spline with a flame-like silhouette (several twisting lobes) and a low-poly hull.
  - Write per-vertex height and lobe ids, which the P4.4 flame motion reads.
- **Verify:** Unit tests check that the output is deterministic, that the silhouette's height-to-width ratio is between 4 and 6, and that the lobe ids are present.

### P2.5: Sky dome and boundary haze
- **Depends on:** P0.2.
- **Steps:**
  - The sky dome is an inward-facing low-poly sphere.
  - Compute the star and moon anchor positions by projecting their canvas UVs (taken from `regions.json`) through the painter's camera onto the dome.
  - The boundary haze is a shell of strokes between 45 and 55 m whose density rises with distance.
  - Expose `boundaryFactor(position)` (0 inside, 1 at the edge) for P3.5.
- **Verify:** Unit tests check that the star anchors reproject to their canvas UVs within 0.5%, and that `boundaryFactor` is monotonic.

### P2.6: Surface stroke scattering
- **Depends on:** P2.1, P1.4.
- **Steps:**
  - `src/render/strokes/scatter.ts` scatters strokes over meshes with stratified area-weighted sampling, using per-layer density and size.
  - For each stroke:
    - colour comes from `projectToCanvas`, with extrapolation outside the frustum;
    - the tangent comes from the flow field, projected onto the surface plane;
    - the brush is chosen by region.
  - Sky strokes follow the canvas swirl flow on the dome.
  - The output is chunked `StrokeBatch` data. Bake it at load, and cache the result in IndexedDB keyed by build id and seed.
- **Verify:** Unit tests check that:
  - the stroke count per m² per layer is within ±5% of the target;
  - tangents lie in the surface plane;
  - a fixed seed gives an identical batch hash;
  - scatter time on the desktop is recorded in `docs/perf.md`.

### P2.7: Starry Night world module
- **Depends on:** P2.3, P2.4, P2.5, P2.6.
- **Steps:**
  - `src/paintings/starry-night/index.ts` implements `WorldModule` (`build`, `update`, `dispose`, `spawnPose`, `painterSpot`).
  - Add a minimal entry to the registry so that `?painting=starry-night` boots directly into the world. The full gallery comes in P5.
  - Set the stroke budget per band from P0.8.
- **Verify:**
  - An e2e coverage sweep visits 24 sample poses inside the boundary using `?iwer&noanim&seed=1`. At each pose it counts pixels that match the clear colour or a bare-mesh debug colour, and fails if more than 0.5% match.
  - The e2e suite reports no errors.

### P2.8: Painter's spot fidelity metric
- **Depends on:** P2.7.
- **Steps:**
  - `scripts/fidelity.ts` takes a `?painting=starry-night&noanim&seed=1&shot` capture from the painter's spot. It downsamples both the capture and the scan to 256 px and computes:
    - SSIM on luminance;
    - mean ΔE2000 on a 16×12 grid of block-mean colours.
  - Set the thresholds from the first accepted render and record them (OQ6).
  - The e2e test asserts that both metrics stay within their thresholds.
- **Verify:** The thresholds and the reference capture are recorded in `docs/verification.md`, and the e2e fidelity test passes.

### P2.9: Headset check P2 (owner)
- **Depends on:** P2.8, and an owner-approved deploy.
- **Steps:** Paul stands at the painter's spot, then walks the hill and looks at the village, cypress and sky. Record his verdict and the OVR frame times.
- **Verify:**
  - `docs/verification.md` records P2-A4.
  - **The card stays open until Paul signs off.**

## Phase exit
- `make checkall-ci` and `make e2e` are green.
- P2-A1 through P2-A4 have evidence.
- One owner-approved push and deploy has happened.
