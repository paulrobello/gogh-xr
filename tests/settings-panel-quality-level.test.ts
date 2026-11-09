/** The XR panel's quality level row (2026-11-08): its value text and the stroke budget. */

import { Group, type InstancedBufferGeometry, type Mesh, Object3D, Texture } from 'three';
import { BatchedText, type Text } from 'troika-three-text';
import { afterEach, expect, test, vi } from 'vitest';
import type { GovernorMode } from '../src/render/governor.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings/schema.ts';
import { createSettingsStore } from '../src/settings/store.ts';
import { controlLayout } from '../src/ui/panel-layout.ts';
import { createSettingsPanel } from '../src/ui/settings-panel.ts';
import { createInput, type KeyboardState } from '../src/xr/input.ts';

const noFlags = { beauty: false, hz: null, seated: null, turn: null, hud: null, calm: null };
const keys: KeyboardState = { keys: new Set(), mouseButtons: new Set() };
/** `STROKE_CAPACITY` in settings-panel.ts: strokes past it are dropped silently. */
const STROKE_CAPACITY = 900;

afterEach(() => {
  vi.restoreAllMocks();
});

test('the quality level shows its label, and a full paint stays inside the stroke capacity', () => {
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
  // Every slider at its max fills the longest tracks.
  const stored: Settings = {
    ...DEFAULT_SETTINGS,
    moveSpeed: 3,
    vignette: 1,
    standingHeight: 2.2,
    calm: 1,
    seated: true,
    qualityLevel: 18,
  };
  const store = createSettingsStore({
    stored,
    flags: noFlags,
    save: () => true,
    schedule: () => 0,
    cancel: () => undefined,
  });
  let mode: GovernorMode = 'beauty';
  const panel = createSettingsPanel({
    rig,
    camera,
    controller: () => null,
    store,
    atlas: new Texture(),
    recenter: () => undefined,
    gallery: () => () => undefined,
    sessionQuality: () => 'beauty-72',
    governorMode: () => mode,
    hud: { visible: () => true, setVisible: () => undefined },
  });
  const layout = controlLayout('qualityLevel');
  if (!layout) throw new Error('no qualityLevel control');
  const value = members.find(
    (t) =>
      Math.abs(t.position.x - layout.valueAt[0]) < 1e-9 &&
      Math.abs(t.position.y - layout.valueAt[1]) < 1e-9,
  );
  if (!value) throw new Error('no quality level value text');
  panel.open();
  const input = createInput();
  const start = performance.now();
  for (let now = start; now <= start + 200; now += 11)
    panel.frame(input.read([], keys, 0.011), now);
  expect(value.text).toBe('18 · near 0.25');
  const strokes = rig.getObjectByName('settings-panel-strokes') as Mesh | undefined;
  const count = (strokes?.geometry as InstancedBufferGeometry | undefined)?.instanceCount ?? 0;
  console.log(`[test] settings panel strokes at a full paint: ${count} of ${STROKE_CAPACITY}`);
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(STROKE_CAPACITY * 0.8);

  // A rebind starts a governor in another mode with no settings change: the row repaints for it.
  mode = 'default';
  for (let now = start + 210; now <= start + 400; now += 11)
    panel.frame(input.read([], keys, 0.011), now);
  expect(value.text).toBe('16 · near 0.25');

  store.set('qualityLevel', 'auto');
  for (let now = start + 450; now <= start + 650; now += 11)
    panel.frame(input.read([], keys, 0.011), now);
  expect(value.text).toBe('Auto');
  panel.dispose();
});
