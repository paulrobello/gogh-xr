# Phase 5: Gallery, Portal and Settings

PRD: [P5](../PRD.md#p5--gallery-portal-and-settings). Phase 5 adds the entry gallery, the portal into Starry Night and back out, the grabbable settings panel, and persistent settings. The UI follows `~/.claude/guides/webxr.md`: the controller contract, laser contact and hover, grabbable roots with bounded scale (0.5–1.8), the both-stick recenter, Troika SDF text, and hover help at about 700 ms.

## Gallery content

There are seven frames, in this order: Starry Night (live), Chestnut Trees in Blossom, Les Alyscamps, Café Terrace at Night, The Bedroom, Wheatfield with Crows, and Starry Night Over the Rhône. The last six are coming soon. Each frame shows its 1024 px scan from P0.4b, or a painted placeholder when that scan failed vetting. Each frame also has a plaque giving title, year and museum, plus "Coming soon" when it applies. The room is painted in the same stroke engine, with a muted interior palette sampled from the frames.

## Tasks

### P5.1: Painting registry
- **Depends on:** P2.7.
- **Steps:**
  - Formalise `src/paintings/registry.ts` per PRD D14: `id`, `title`, `year`, `museum`, `scanProvenance` (a key into `assets/PROVENANCE.md`), `frameImage`, `status`, and an optional lazy `world` import.
  - Validate the registry at boot and in tests:
    - ids are unique;
    - every live entry has a world;
    - every frame image exists;
    - every provenance key resolves.
- **Verify:** Unit tests check that validation rejects each kind of malformed entry, giving the reason by name.

### P5.2: Settings schema and storage
- **Depends on:** P0.2.
- **Steps:**
  - `src/settings/schema.ts` defines a versioned settings object with defaults:
    - locomotion speed;
    - turn mode and turn step;
    - vignette strength;
    - seated mode and its height;
    - calm motion;
    - quality mode (90 Hz adaptive or 72 Hz max beauty);
    - HUD on or off;
    - music volume and SFX volume (P6).
  - Store it under one `localStorage` key, `gogh-xr.settings.v1`.
  - Migrate between versions, clamp out-of-range values, and fall back to defaults when the stored data is corrupt. Show a toast when that fallback happens.
  - Do not store the last position (PRD D12).
- **Verify:** Unit tests cover migration from v1 to a v2 fixture, clamping, corrupt-JSON fallback, and a round trip.

### P5.3: Grabbable settings panel
- **Depends on:** P5.2, P3.1.
- **Steps:**
  - Build the panel in `src/ui/settings-panel.ts` as Troika SDF labels on low-glare dark backing with stroke-painted borders. It holds:
    - toggles;
    - sliders;
    - segmented selectors;
    - a "Return to gallery" button;
    - a "Recenter" button.
  - The left menu button opens and closes it, spawning it in front of the head.
  - Grip grabs, moves, rotates and scales the panel. Two-hand scaling also works.
  - Trigger operates the controls.
  - The laser stops at the nearest hit and shows a contact marker.
  - Save the panel pose relative to head yaw, on release and on XR exit.
  - The desktop preview uses a DOM panel mirroring the same actions.
- **Verify:** Unit tests cover ray-hit ordering, the grip-versus-trigger contract (grip never activates a control), the bounded scale, and pose save and restore.

### P5.4: Gallery room
- **Depends on:** P5.1, P0.4b, P1.4.
- **Steps:**
  - Generate the room procedurally in `src/paintings/gallery/`: about 10 × 6 m, with walls, floor and benches.
  - Hang the seven frames at true relative scale, with Starry Night at 92.1 × 73.7 cm on the facing wall. Add the plaques.
  - Paint all surfaces with strokes.
  - The gallery is the default boot scene. `?painting=` still deep-links into a world.
- **Verify:** Unit tests check that the frame layout has no overlaps and that each frame matches its painting's aspect ratio. In e2e, the gallery renders with no errors and every frame texture loads.

### P5.5: Portal and return
- **Depends on:** P5.4, P4.1, P3.4.
- **Steps:**
  - A live frame's plane is a portal. Walking through it, or teleporting into its 0.6 m threshold volume, triggers entry.
  - The transition runs over about 2 s:
    - the canvas strokes lift off the frame and fly out to their world positions while the world builds behind them;
    - the gallery dissolves.
  - When calm motion is below 0.3, a 0.6 s fade is used instead.
  - Dispose the old world fully, then build the new one, while input is suppressed.
  - "Return to gallery" reverses the transition.
  - The world build runs behind the transition so no frame stalls. Split the scatter across frames if needed.
- **Verify:**
  - Unit tests check plane-crossing detection, including on teleport, and that no trigger is consumed during the transition.
  - A disposal test confirms that GPU resource counts return to their baseline after a round trip (`renderer.info.memory`).

### P5.6: HUD notices
- **Depends on:** P5.3.
- **Steps:**
  - Build a compact notice system on the HUD with dismiss buttons and SDF text. It shows:
    - the governor's 72 Hz fallback;
    - corrupt-settings recovery;
    - an XR entry error;
    - a pending update reload (P7.1).
  - One owner panel per preference, with no duplicated controls.
- **Verify:** Unit tests check the notice queue, dismissal, and that a notice never steals the trigger from the panel.

### P5.7: Gallery and portal e2e
- **Depends on:** P5.3, P5.5, P5.6.
- **Steps:**
  - The IWER e2e test:
    1. Boots into the gallery.
    2. Walks into the Starry Night frame.
    3. Asserts that `diag().painting === 'starry-night'`.
    4. Opens the panel with the left menu button.
    5. Changes the vignette strength.
    6. Returns to the gallery.
    7. Reloads, and asserts that the setting persisted.
  - The desktop preview runs the same path.
- **Verify:** `make e2e` is green.

### P5.8: Headset check P5 (owner)
- **Depends on:** P5.7, and an owner-approved deploy.
- **Steps:** Paul judges the gallery, the frames, how readable the plaques are at normal distance and at an oblique angle, the portal transition both ways, panel manipulation, and recenter.
- **Verify:**
  - `docs/verification.md` records P5-A3 (SC4).
  - **The card stays open until Paul signs off.**

## Phase exit
- `make checkall-ci` and `make e2e` are green.
- P5-A1 through P5-A3 have evidence.
- One owner-approved push and deploy has happened.
