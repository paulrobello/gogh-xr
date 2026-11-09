import { Group, Object3D, Quaternion, Texture, Vector3 } from 'three';
import { BatchedText } from 'troika-three-text';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/schema.ts';
import { createSettingsStore } from '../src/settings/store.ts';
import { createSettingsPanel } from '../src/ui/settings-panel.ts';
import { createInput, type Hand, type KeyboardState } from '../src/xr/input.ts';

const noFlags = { beauty: false, hz: null, seated: null, turn: null, hud: null, calm: null };
const keys: KeyboardState = { keys: new Set(), mouseButtons: new Set() };

afterEach(() => {
  vi.restoreAllMocks();
});

/** Points a controller space from `from` at `target`, rig-local. */
function aim(space: Object3D, from: Vector3, target: Vector3): void {
  space.position.copy(from);
  space.quaternion.copy(
    new Quaternion().setFromUnitVectors(
      new Vector3(0, 0, -1),
      target.clone().sub(from).normalize(),
    ),
  );
}

test('the panel reports, per hand, whose ray meets it, and its pose while open (P5.6)', () => {
  // Typesetting would fetch the font.
  vi.spyOn(BatchedText.prototype, 'sync').mockImplementation(() => undefined);
  const rig = new Group();
  const camera = new Object3D();
  const spaces: Record<Hand, Object3D> = { left: new Object3D(), right: new Object3D() };
  rig.add(camera, spaces.left, spaces.right);
  const store = createSettingsStore({
    stored: DEFAULT_SETTINGS,
    flags: noFlags,
    save: () => true,
    schedule: () => 0,
    cancel: () => undefined,
  });
  const panel = createSettingsPanel({
    rig,
    camera,
    controller: (hand) => spaces[hand],
    store,
    atlas: new Texture(),
    recenter: () => undefined,
    gallery: () => null,
    sessionQuality: () => 'adaptive-72',
    hud: { visible: () => false, setVisible: () => undefined },
  });
  const input = createInput();
  let now = 1000;
  const frame = () => {
    now += 11;
    return panel.frame(input.read([], keys, 0.011), now);
  };

  panel.open();
  const { pose: opened, scale: openedScale } = panel.diag();
  const centre = new Vector3(...opened.position);
  const away = new Vector3(3, 0, 0);
  const below = (x: number) => new Vector3(x, -0.5, -0.2);

  for (const [on, off] of [
    ['left', 'right'],
    ['right', 'left'],
  ] as const) {
    aim(spaces[on], below(on === 'left' ? -0.1 : 0.1), centre);
    aim(spaces[off], below(0), away);
    const hold = frame();
    expect(hold.hits[on]).toBe(true);
    expect(hold.hits[off]).toBe(false);
    // Hovering is not holding: nothing is claimed.
    expect(hold.left || hold.right).toBe(false);
    expect(hold.pose?.position.toArray()).toEqual(opened.position);
    expect(hold.pose?.quaternion.toArray()).toEqual(opened.quaternion);
    expect(hold.pose?.scale).toBe(openedScale);
  }

  panel.close();
  const closed = frame();
  expect(closed.pose).toBeNull();
  expect(closed.hits).toEqual({ left: false, right: false });
  panel.dispose();
});
