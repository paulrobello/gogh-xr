import { Group, Object3D, Texture } from 'three';
import { BatchedText, type Text } from 'troika-three-text';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/schema.ts';
import { createSettingsStore } from '../src/settings/store.ts';
import { controlLayout } from '../src/ui/panel-layout.ts';
import { createSettingsPanel } from '../src/ui/settings-panel.ts';
import { createInput, type KeyboardState } from '../src/xr/input.ts';

const noFlags = { beauty: false, hz: null, seated: null, turn: null, hud: null, calm: null };
const keys: KeyboardState = { keys: new Set(), mouseButtons: new Set() };

afterEach(() => {
  vi.restoreAllMocks();
});

test('the HUD toggle label follows left X or H while the panel is open, within 100 ms', () => {
  const members: Text[] = [];
  const addText = BatchedText.prototype.addText;
  vi.spyOn(BatchedText.prototype, 'addText').mockImplementation(function (this: BatchedText, t) {
    members.push(t);
    addText.call(this, t);
  });
  // The label's `text` is assigned before the batch syncs; typesetting would fetch the font.
  vi.spyOn(BatchedText.prototype, 'sync').mockImplementation(() => undefined);
  let hudVisible = false;
  const rig = new Group();
  const camera = new Object3D();
  rig.add(camera);
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
    controller: () => null,
    store,
    atlas: new Texture(),
    recenter: () => undefined,
    gallery: () => null,
    sessionQuality: () => 'adaptive-90',
    hud: {
      visible: () => hudVisible,
      setVisible: (visible) => {
        hudVisible = visible;
      },
    },
  });
  const hud = controlLayout('hud');
  if (!hud) throw new Error('no hud control');
  const label = members.find(
    (t) => Math.abs(t.position.x - hud.rect.x) < 1e-9 && Math.abs(t.position.y - hud.rect.y) < 1e-9,
  );
  if (!label) throw new Error('no hud toggle label');

  panel.open();
  expect(label.text).toBe('Off');

  // Left X or H shows the HUD for the session; the panel stays open and nothing is pressed.
  hudVisible = true;
  const input = createInput();
  const start = performance.now();
  let shownAt: number | null = null;
  for (let now = start; now <= start + 200; now += 11) {
    panel.frame(input.read([], keys, 0.011), now);
    if (shownAt === null && label.text === 'On') shownAt = now;
  }
  expect(shownAt).not.toBeNull();
  expect((shownAt ?? Number.POSITIVE_INFINITY) - start).toBeLessThanOrEqual(100);
  // The stored setting is the panel toggle's alone: X and H write nothing.
  expect(store.stored.hud).toBe(false);
  panel.dispose();
});
