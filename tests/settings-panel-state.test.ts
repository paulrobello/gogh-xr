import { Group, Object3D, Quaternion, Vector3 } from 'three';
import { expect, test } from 'vitest';
import { createLocomotion } from '../src/locomotion/locomotion.ts';
import { DEFAULT_LOCOMOTION_SETTINGS } from '../src/locomotion/settings.ts';
import { createMotionClock } from '../src/motion/clock.ts';
import { applySettingsChange } from '../src/settings/apply.ts';
import { DEFAULT_SETTINGS, type Settings, toLocomotionSettings } from '../src/settings/schema.ts';
import { createSettingsStore, SAVE_DELAY_MS } from '../src/settings/store.ts';
import { createPanelPose } from '../src/ui/panel-core.ts';
import {
  controlLayout,
  controlRect,
  hitControl,
  setControlHidden,
  sliderValue,
} from '../src/ui/panel-layout.ts';
import {
  clearPanelPose,
  DEFAULT_OFFSET,
  defaultStored,
  fromStored,
  type HeadYaw,
  loadPanelPose,
  PANEL_POSE_KEY,
  type PanelPoseStorage,
  parsePanelPose,
  savePanelPose,
  toStored,
} from '../src/ui/panel-pose.ts';
import { createInput, type KeyboardState } from '../src/xr/input.ts';

const noFlags = { beauty: false, hz: null, seated: null, turn: null, hud: null, calm: null };

function memoryStorage(): PanelPoseStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** A fake timer: `run()` fires the pending callback. */
function fakeTimer() {
  let pending: (() => void) | null = null;
  let scheduled = 0;
  return {
    schedule: (callback: () => void, ms: number) => {
      expect(ms).toBe(SAVE_DELAY_MS);
      pending = callback;
      scheduled += 1;
      return scheduled;
    },
    cancel: () => {
      pending = null;
    },
    run: () => {
      const c = pending;
      pending = null;
      c?.();
    },
    get pending() {
      return pending !== null;
    },
  };
}

test('the store debounces saves: none per change, one after the quiet period or on commit', () => {
  const saved: Settings[] = [];
  const timer = fakeTimer();
  const store = createSettingsStore({
    stored: DEFAULT_SETTINGS,
    flags: noFlags,
    save: (s) => saved.push(s) > 0,
    schedule: timer.schedule,
    cancel: timer.cancel,
  });
  // A slider drag: a change every frame, no save yet.
  for (let i = 0; i < 30; i += 1) store.set('vignette', 0.3 + i * 0.01);
  expect(saved).toEqual([]);
  expect(store.pending).toBe(true);
  timer.run();
  expect(saved.map((s) => s.vignette)).toEqual([0.59]);
  // Release commits at once, and only once.
  store.set('moveSpeed', 2.5);
  store.commit();
  store.commit();
  expect(saved.map((s) => s.moveSpeed)).toEqual([2, 2.5]);
  expect(timer.pending).toBe(false);
  // An unchanged value is no change.
  expect(store.set('moveSpeed', 2.5)).toBe(false);
  expect(store.pending).toBe(false);
});

test('a flag-locked field refuses edits and its flag value is never written back', () => {
  const saved: Settings[] = [];
  const store = createSettingsStore({
    stored: { ...DEFAULT_SETTINGS, turnMode: 'snap' },
    flags: { ...noFlags, turn: 'smooth' },
    save: (s) => saved.push(s) > 0,
    schedule: () => 0,
    cancel: () => undefined,
  });
  expect(store.effective.turnMode).toBe('smooth');
  expect(store.locks).toEqual({ turnMode: '?turn=smooth' });
  expect(store.isLocked('turnMode')).toBe(true);
  expect(store.set('turnMode', 'snap')).toBe(false);
  expect(store.set('vignette', 0.25)).toBe(true);
  store.commit();
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ turnMode: 'snap', vignette: 0.25 });
  expect(store.effective).toMatchObject({ turnMode: 'smooth', vignette: 0.25 });
});

test('main.ts applySettingsChange applies live to LocomotionSettings, the calm uniform and the HUD', () => {
  const store = createSettingsStore({
    stored: DEFAULT_SETTINGS,
    flags: noFlags,
    save: () => true,
    schedule: () => 0,
    cancel: () => undefined,
  });
  const scene = new Group();
  const camera = new Object3D();
  const locomotion = createLocomotion({
    scene,
    camera,
    look: { setLook: () => undefined, update: () => undefined },
    settings: toLocomotionSettings(store.effective),
  });
  const clock = createMotionClock();
  let hudVisible = false;
  const hudCalls: boolean[] = [];
  store.subscribe((effective, key) =>
    applySettingsChange(effective, key, {
      setLocomotion: (next) => locomotion.setSettings(next),
      setCalm: (calm) => clock.setCalm(calm),
      hud: {
        visible: () => hudVisible,
        setVisible: (visible) => {
          hudVisible = visible;
          hudCalls.push(visible);
        },
      },
    }),
  );
  store.set('turnMode', 'smooth');
  store.set('calm', 0.25);
  store.set('vignette', 0.4);
  expect(locomotion.diag().turnMode).toBe('smooth');
  expect(clock.uniforms.uCalm.value).toBe(0.25);
  expect(hudCalls).toEqual([]);
  store.set('hud', true);
  expect(hudCalls).toEqual([true]);
  // Already hidden (left X or H): the setting changes and the HUD is left alone.
  hudVisible = false;
  store.set('hud', false);
  expect(hudCalls).toEqual([true]);
  // The vignette follows the new strength at full stick in XR: 0.4, not the default 0.6.
  const frame = {
    dt: 0.1,
    move: { x: 0, y: 1 },
    sprint: false,
    turn: { x: 0, snap: 0 as const },
    teleportAim: false,
    teleportCommit: false,
    flightToggle: false,
    vertical: 0,
  };
  camera.position.set(0, 1.6, 0);
  for (let i = 0; i < 40; i += 1) locomotion.frame(frame, true);
  expect(locomotion.diag().vignette).toBeCloseTo(0.4, 3);
});

test('faceYaw turns the rig about the head so the view faces the spawn yaw', () => {
  const scene = new Group();
  const camera = new Object3D();
  const locomotion = createLocomotion({
    scene,
    camera,
    look: { setLook: () => undefined, update: () => undefined },
    settings: DEFAULT_LOCOMOTION_SETTINGS,
  });
  // The head stands 0.5 m to the right of the rig origin, looking 40 degrees left.
  camera.position.set(0.5, 1.6, 0);
  camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), (40 * Math.PI) / 180);
  const head = new Vector3();
  camera.getWorldPosition(head);
  const before = locomotion.discontinuities();
  locomotion.faceYaw(0.3);
  const after = new Vector3();
  camera.updateWorldMatrix(true, false);
  camera.getWorldPosition(after);
  expect(after.distanceTo(head)).toBeLessThan(1e-9);
  const view = new Quaternion();
  camera.getWorldQuaternion(view);
  const forward = new Vector3(0, 0, -1).applyQuaternion(view);
  expect(Math.atan2(-forward.x, -forward.z)).toBeCloseTo(0.3, 9);
  expect(locomotion.discontinuities()).toBe(before + 1);
});

const head: HeadYaw = { position: new Vector3(0.3, 1.55, -0.2), yaw: 0.8 };

test('the pose round-trips relative to the head yaw, and restores in front of a moved head', () => {
  const pose = createPanelPose();
  pose.position.set(0.1, 1.3, -0.9);
  pose.quaternion.setFromAxisAngle(new Vector3(0.2, 1, 0).normalize(), 0.6);
  pose.scale = 1.3;
  const stored = toStored(pose, head);
  const back = fromStored(stored, head, createPanelPose());
  expect(back.position.distanceTo(pose.position)).toBeLessThan(1e-9);
  expect(back.quaternion.angleTo(pose.quaternion)).toBeLessThan(1e-6);
  expect(back.scale).toBe(1.3);
  // A head turned and moved: the panel keeps its place in front of it.
  const turned: HeadYaw = { position: new Vector3(4, 1.6, 2), yaw: 0.8 + Math.PI / 2 };
  const moved = fromStored(stored, turned, createPanelPose());
  const rel = moved.position.clone().sub(turned.position);
  const orig = pose.position.clone().sub(head.position);
  expect(rel.length()).toBeCloseTo(orig.length(), 9);
  expect(rel.y).toBeCloseTo(orig.y, 9);
});

test('the default spawn sits ahead and below the eye and faces it', () => {
  const pose = fromStored(
    defaultStored(),
    { position: new Vector3(0, 1.6, 0), yaw: 0 },
    createPanelPose(),
  );
  expect(pose.position.toArray()).toEqual([0, 1.6 + DEFAULT_OFFSET[1], DEFAULT_OFFSET[2]]);
  const face = new Vector3(0, 0, 1).applyQuaternion(pose.quaternion);
  const toEye = new Vector3(0, 1.6, 0).sub(pose.position).normalize();
  expect(face.distanceTo(toEye)).toBeLessThan(1e-9);
  expect(pose.scale).toBe(1);
});

test('save, load and clear use gogh-xr.panel.v1, and a bad stored pose is rejected', () => {
  const storage = memoryStorage();
  const stored = toStored(fromStored(defaultStored(), head, createPanelPose()), head);
  expect(savePanelPose(stored, storage)).toBe(true);
  expect([...storage.data.keys()]).toEqual([PANEL_POSE_KEY]);
  expect(loadPanelPose(storage)?.offset).toEqual(stored.offset);
  clearPanelPose(storage);
  expect(loadPanelPose(storage)).toBeNull();
  const ok = { version: 1, offset: [0, 0, -0.7], quaternion: [0, 0, 0, 1], scale: 3 };
  expect(parsePanelPose(JSON.stringify(ok))?.scale).toBe(1.8);
  for (const bad of [
    '{nope',
    JSON.stringify({ ...ok, version: 2 }),
    JSON.stringify({ ...ok, offset: [0, 0, -9] }),
    JSON.stringify({ ...ok, offset: [0, 0, -0.1] }),
    JSON.stringify({ ...ok, quaternion: [0, 0, 0, 0] }),
    JSON.stringify({ ...ok, offset: [0, null, -0.7] }),
    JSON.stringify({ ...ok, scale: 'big' }),
  ]) {
    expect(parsePanelPose(bad)).toBeNull();
  }
});

test('slider values sit on their step, and hits map to the control and segment', () => {
  const v = controlLayout('vignette');
  const speed = controlLayout('moveSpeed');
  if (!v || !speed) throw new Error('missing controls');
  expect(sliderValue(v.def, 0.5)).toBe(0.5);
  expect(sliderValue(v.def, 0.52)).toBe(0.5);
  expect(sliderValue(speed.def, 0.75)).toBe(2.5);
  expect(hitControl(v.rect.x, v.rect.y)).toMatchObject({ id: 'vignette', fraction: 0.5 });
  const turn = controlLayout('turnMode');
  const s1 = turn?.segments[1];
  if (!s1) throw new Error('no segment');
  expect(hitControl(s1.x, s1.y)).toMatchObject({ id: 'turnMode', segment: 1 });
});

test('a hidden Return to gallery takes no hits and Recenter moves to the row centre (P5.5)', () => {
  const gallery = controlLayout('gallery');
  const recenter = controlLayout('recenter');
  if (!gallery || !recenter) throw new Error('missing buttons');
  expect(hitControl(gallery.rect.x, gallery.rect.y)).toMatchObject({ id: 'gallery' });
  expect(controlRect(recenter)).toEqual(recenter.rect);
  setControlHidden('gallery', true);
  try {
    // No hover and so no tooltip over the empty slot, and the lone button sits centred.
    const centred = controlRect(recenter);
    expect(centred.x).toBe(0);
    expect(hitControl(gallery.rect.x, gallery.rect.y)?.id ?? null).not.toBe('gallery');
    expect(hitControl(centred.x, centred.y)).toMatchObject({ id: 'recenter' });
  } finally {
    setControlHidden('gallery', false);
  }
  expect(controlRect(recenter)).toEqual(recenter.rect);
});

const keys: KeyboardState = { keys: new Set(), mouseButtons: new Set() };

function pads(
  left: { trigger?: boolean; grip?: boolean },
  right: { trigger?: boolean; grip?: boolean; a?: boolean },
) {
  const buttons = (b: { trigger?: boolean; grip?: boolean; a?: boolean }) =>
    [b.trigger, b.grip, false, false, b.a ?? false, false, false].map((pressed) => ({
      pressed: pressed ?? false,
    }));
  return [
    {
      handedness: 'left',
      gamepad: { mapping: 'xr-standard', axes: [0, 0, 0, 0], buttons: buttons(left) },
    },
    {
      handedness: 'right',
      gamepad: { mapping: 'xr-standard', axes: [0, 0, 0, 0], buttons: buttons(right) },
    },
  ];
}

test('a claimed hand leaves select and grip; the other hand still selects', () => {
  const input = createInput();
  let a = input.read(pads({}, { trigger: true }), keys, 0.016);
  expect(a.select).toEqual({ down: true, fired: true });
  expect(a.hands.right.trigger).toEqual({ down: true, fired: true });
  input.claim(false, true);
  expect(a.select).toEqual({ down: false, fired: false });
  a = input.read(pads({}, { trigger: true }), keys, 0.016);
  input.claim(false, true);
  expect(a.select).toEqual({ down: false, fired: false });
  // The left trigger, unclaimed, selects while the right is held by the panel.
  a = input.read(pads({ trigger: true }, { trigger: true }), keys, 0.016);
  input.claim(false, true);
  expect(a.select).toEqual({ down: true, fired: true });
});

test('right A fires menu once per press', () => {
  const input = createInput();
  expect(input.read(pads({}, { a: true }), keys, 0.016).menu).toBe(true);
  expect(input.read(pads({}, { a: true }), keys, 0.016).menu).toBe(false);
  expect(input.read(pads({}, {}), keys, 0.016).menu).toBe(false);
  expect(input.read(pads({}, { a: true }), keys, 0.016).menu).toBe(true);
});

test("a grabbing hand's stick leaves locomotion until centred, and a stick aim drops without a commit", () => {
  const input = createInput();
  // Raw xr-standard axes: [2] is X right, [3] is Y with forward negative.
  const sticks = (l: [number, number], r: [number, number]) => [
    { handedness: 'left', gamepad: { mapping: 'xr-standard', axes: [0, 0, ...l], buttons: [] } },
    { handedness: 'right', gamepad: { mapping: 'xr-standard', axes: [0, 0, ...r], buttons: [] } },
  ];
  let a = input.read(sticks([0, 0], [0, -1]), keys, 0.016);
  expect(a.teleportAim).toBe(true);
  // The panel grabs with the right hand: this frame's aim and vertical drop at once.
  input.holdSticks(false, true);
  expect(a.teleportAim).toBe(false);
  expect(a.vertical).toBe(0);
  a = input.read(sticks([0, -1], [0, -1]), keys, 0.016);
  input.holdSticks(false, true);
  expect([a.teleportAim, a.teleportCommit, a.vertical]).toEqual([false, false, 0]);
  // The panel still reads the held stick, and the left stick, not held, still moves.
  expect(a.hands.right.stick.y).toBeCloseTo(1, 9);
  expect(a.move.y).toBeCloseTo(1, 9);
  // Let go mid-push: the stick stays out until centred, so nothing turns or commits.
  a = input.read(sticks([0, 0], [1, 0]), keys, 0.016);
  expect([a.turn.x, a.turn.snap, a.teleportCommit]).toEqual([0, 0, false]);
  input.read(sticks([0, 0], [0, 0]), keys, 0.016);
  a = input.read(sticks([0, 0], [1, 0]), keys, 0.016);
  expect(a.turn.snap).toBe(1);
  // A left grab takes the move stick from the frame it starts.
  a = input.read(sticks([0, -1], [0, 0]), keys, 0.016);
  input.holdSticks(true, false);
  expect(a.move).toEqual({ x: 0, y: 0 });
  a = input.read(sticks([0, -1], [0, 0]), keys, 0.016);
  expect(a.move).toEqual({ x: 0, y: 0 });
});
