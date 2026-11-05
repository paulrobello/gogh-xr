# Phase 3: Locomotion and Comfort

PRD: [P3](../PRD.md#p3--locomotion-and-comfort-parallel-with-p4). This phase runs in parallel with P4, and it touches none of P4's files. It owns the `src/xr/input*`, `src/locomotion/` and `src/ui/vignette*` paths.

## Controller map (accepted 2026-11-05, Q5)

| Input | Action |
| --- | --- |
| Physical walking | Room-scale movement. The rig follows the terrain height. |
| Left stick | Smooth movement relative to head yaw. |
| Right stick X | Snap turn of 30° by default. Smooth turn is optional. |
| Right stick forward, then release | Aim a teleport arc, then jump to the landing point. |
| Right B | Toggle flight. While flying, right stick Y moves you up or down, and teleport is disabled. |
| Left menu | Opens the settings panel (P5). |
| Trigger | Selects UI and frames only. |
| Grip | Grabs UI only. |
| Both stick-clicks held for 1 s | Recenter the UI. |

Every stick axis uses a 0.15 deadzone and elapsed-time scaling. Desktop preview: WASD moves, the mouse looks, Q and E snap-turn, T aims and releases a teleport at the cursor, F toggles flight, and Space and Ctrl move up and down.

## Tasks

### P3.1: Input action layer
- **Depends on:** P0.3.
- **Steps:**
  - `src/xr/input.ts` maps XR gamepads (from `inputSource.gamepad`, using the `xr-standard` mapping) and keyboard/mouse into one `Actions` frame: `move`, `turn`, `teleportAim`, `teleportCommit`, `flightToggle`, `vertical`, `menu`, `select`, `grip` and `recenter`.
  - Edge-detect button presses.
  - Suppress actions from a button that is already held during a mode switch until it is released.
  - Use the `Group.lookAt` +Z versus ray −Z convention from vault `Patterns/mux-xr-quest-interaction-patterns.md`.
- **Verify:** Unit tests cover the deadzone, elapsed-time scaling, edge detection, held-button suppression, and keyboard parity with each XR action.

### P3.2: Walk, smooth movement, ground follow and seated mode
- **Depends on:** P3.1, P2.2.
- **Steps:**
  - Smooth movement runs at 2.0 m/s and can be set from 1.0 to 3.0 m/s. The direction is the head yaw projected onto the ground plane.
  - Ground follow sets the rig Y to `heightAt` of the head's XZ position, smoothed by 80 ms.
  - Seated mode adds a height offset that raises the eye to standing height. The height is calibrated by the user, defaulting to 1.6 m.
- **Verify:** Unit tests check that ground follow matches `heightAt` on a slope, that the seated offset is applied without affecting physical movement deltas, and that the speed is bounded.

### P3.3: Turn and tunnel vignette
- **Depends on:** P3.1.
- **Steps:**
  - Snap turn uses a selectable 30° or 45° step with a 250 ms cooldown. Smooth turn runs at 90°/s and can be set. Both rotate around the head position.
  - The vignette is a head-locked mesh with a radial alpha shader. It is not post-processing, so foveation stays intact.
  - The vignette's strength scales with the speed of smooth movement, smooth turn and flight. Its strength can be set from 0 to 1, with 0.6 as the default.
- **Verify:** Unit tests check that the snap increment is exact, that the head position is unchanged by a turn, and that the vignette alpha is 0 at rest and rises with speed.

### P3.4: Teleport arc
- **Depends on:** P3.1, P2.2.
- **Steps:**
  - Draw a parabolic arc from the right controller as a line of strokes, so the arc matches the painted style.
  - A landing is valid on terrain with a slope under 35°, inside the boundary, and not inside a building's footprint.
  - A short fade or a stroke-swirl blink plays on the jump.
- **Verify:** Unit tests check that arc intersection with the heightfield is correct, and that landings are rejected on steep slopes, outside the boundary and inside footprints.

### P3.5: Flight, altitude cap and boundary push-back
- **Depends on:** P3.2, P2.5.
- **Steps:**
  - Flight disables ground follow. Left stick moves in 3D along the head direction, and right stick Y moves vertically.
  - Altitude is soft-capped at 40 m, and you cannot sink below the terrain.
  - `boundaryFactor` above 0.8 applies a gentle inward velocity, and the haze thickens.
  - Leaving flight drops you smoothly over 0.5 s to the ground.
- **Verify:** Unit tests check that altitude never exceeds 40 m + ε, that position never leaves the 55 m boundary, and that the descent on exit is smooth.

### P3.6: Locomotion e2e suite
- **Depends on:** P3.2, P3.3, P3.4, P3.5, P2.7.
- **Steps:** Write IWER e2e tests that drive each mode in `?painting=starry-night&iwer&diag` through controller sticks and buttons and assert the rig pose from `diag()`:
  - smooth movement;
  - snap and smooth turn;
  - teleport, both valid and rejected;
  - flight toggle, climb and cap;
  - boundary push-back;
  - seated offset.

  Run the same checks in the desktop preview with the keyboard.
- **Verify:** `make e2e` is green.

### P3.7: Headset check P3 (owner)
- **Depends on:** P3.6, and an owner-approved deploy.
- **Steps:**
  - Paul tries every mode and comfort option for 15 minutes. He judges comfort, speeds, vignette strength, arc readability and the flight cap.
  - Record any requested default changes.
- **Verify:**
  - `docs/verification.md` records P3-A3 (SC3).
  - **The card stays open until Paul signs off.**

## Phase exit
- `make checkall-ci` and `make e2e` are green.
- P3-A1 through P3-A3 have evidence.
- P3 and P4 share one owner-approved push and deploy, made after both pass their checks.
