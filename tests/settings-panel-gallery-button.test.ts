/** Return to gallery in the XR panel: hidden in the gallery, shown in a world, never overlapping. */

import { Group, Object3D, Texture } from 'three';
import { BatchedText, type Text } from 'troika-three-text';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/schema.ts';
import { createSettingsStore } from '../src/settings/store.ts';
import { CONTROLS, controlLayout, controlRect, setControlHidden } from '../src/ui/panel-layout.ts';
import { createSettingsPanel } from '../src/ui/settings-panel.ts';
import { createInput, type KeyboardState } from '../src/xr/input.ts';

const noFlags = { beauty: false, hz: null, seated: null, turn: null, hud: null, calm: null };
const keys: KeyboardState = { keys: new Set(), mouseButtons: new Set() };

afterEach(() => {
  vi.restoreAllMocks();
  setControlHidden('gallery', false);
});

test('no two buttons overlap, with Return to gallery hidden or shown', () => {
  const buttons = CONTROLS.filter((c) => c.kind === 'button').map((c) => {
    const layout = controlLayout(c.id);
    if (!layout) throw new Error(`no layout for ${c.id}`);
    return layout;
  });
  expect(buttons.map((b) => b.def.id)).toEqual(['recenter', 'gallery']);
  for (const hidden of [false, true]) {
    setControlHidden('gallery', hidden);
    const shown = buttons.filter((b) => !(hidden && b.def.id === 'gallery'));
    expect(shown).toHaveLength(hidden ? 1 : 2);
    for (let i = 0; i < shown.length; i += 1) {
      for (let j = i + 1; j < shown.length; j += 1) {
        const a = controlRect(shown[i] as (typeof buttons)[number]);
        const b = controlRect(shown[j] as (typeof buttons)[number]);
        const apart =
          Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2;
        expect(apart, `buttons overlap with gallery hidden = ${hidden}`).toBe(true);
      }
    }
  }
});

test('the panel empties the hidden Return to gallery label, and restores it in a world', () => {
  const members: Text[] = [];
  const addText = BatchedText.prototype.addText;
  vi.spyOn(BatchedText.prototype, 'addText').mockImplementation(function (this: BatchedText, t) {
    members.push(t);
    addText.call(this, t);
  });
  vi.spyOn(BatchedText.prototype, 'sync').mockImplementation(() => undefined);
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
  let inWorld = false;
  const panel = createSettingsPanel({
    rig,
    camera,
    controller: () => null,
    store,
    atlas: new Texture(),
    recenter: () => undefined,
    gallery: () => (inWorld ? () => undefined : null),
    sessionQuality: () => 'adaptive-72',
    governorMode: () => 'default',
    hud: { visible: () => false, setVisible: () => undefined },
  });
  const labelOf = (label: string): Text => {
    const found = members.find((t) => t.text === label);
    if (!found) throw new Error(`no label ${label}`);
    return found;
  };
  const input = createInput();
  let clock = performance.now();
  const run = (): void => {
    for (let i = 0; i < 20; i += 1) {
      clock += 11;
      panel.frame(input.read([], keys, 0.011), clock);
    }
  };
  const gallery = controlLayout('gallery');
  const recenter = controlLayout('recenter');
  if (!gallery || !recenter) throw new Error('missing buttons');
  const galleryLabel = labelOf('Return to gallery');
  const recenterLabel = labelOf('Recenter');

  panel.open();
  run();
  expect(galleryLabel.text).toBe('');
  expect(recenterLabel.position.x).toBe(0);

  inWorld = true;
  run();
  expect(galleryLabel.text).toBe('Return to gallery');
  expect(galleryLabel.position.x).toBe(gallery.rect.x);
  expect(recenterLabel.position.x).toBe(recenter.rect.x);

  inWorld = false;
  run();
  expect(galleryLabel.text).toBe('');
  expect(recenterLabel.position.x).toBe(0);
  panel.dispose();
});
