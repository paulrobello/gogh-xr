import {
  AdditiveBlending,
  BackSide,
  FrontSide,
  Object3D,
  type RawShaderMaterial,
  Scene,
} from 'three';
import { describe, expect, test } from 'vitest';
import { createReactiveTracker, HAND_RADIUS, WAKE_REF_SPEED } from '../src/motion/reactive';
import {
  createHandOrbs,
  type HandOrbsFrame,
  type Mutable,
  ORB_BOOST,
  ORB_CORE_RADIUS,
  ORB_CORE_SHARE,
  ORB_GAIN,
  ORB_GLOW_RADIUS,
  ORB_GROW,
  ORB_HALO_SHARE,
  ORB_MESH_MARGIN,
  ORB_NEAR,
  ORB_NEAR_MARGIN,
  ORB_RENDER_ORDER,
} from '../src/render/hand-orbs';
import { createStrokeBuffers, packInstance, STROKE_LAYER } from '../src/render/strokes/instance';
import { buildStrokeReach } from '../src/render/strokes/reach-field';
import { DEFAULT_SETTINGS } from '../src/settings/schema';
import { createSettingsStore } from '../src/settings/store';
import {
  CONTROLS,
  controlLayout,
  controlRect,
  hitControl,
  LAYOUT,
  PANEL_H,
  PANEL_W,
} from '../src/ui/panel-layout';

type Vec3 = [number, number, number];
const HEAD: Vec3 = [0, 1.6, 0];
const LEFT: Vec3 = [-0.3, 1.2, -0.4];
const RIGHT: Vec3 = [0.35, 1.3, -0.5];

function setup() {
  const tracker = createReactiveTracker();
  const scene = new Scene();
  const orbs = createHandOrbs(scene);
  const frame = (over: Partial<HandOrbsFrame> = {}): void =>
    orbs.frame({
      enabled: true,
      presenting: true,
      disturbers: tracker.uniforms.uDisturbers.value,
      // Controller slot 0 holds the right hand, slot 1 the left: disturbers 2 and 1.
      slots: [2, 1],
      strokeReach: null,
      reactive: true,
      calm: 1,
      dt: 1 / 72,
      ...over,
    });
  return { tracker, scene, orbs, frame };
}

/** One painted floor stroke, 4 m square (half-size capped at 0.4 m), centred under the right hand. */
function floorAt(y: number) {
  const buffers = createStrokeBuffers(1);
  packInstance(buffers, 0, {
    position: [RIGHT[0], y, RIGHT[2]],
    normal: [0, 1, 0],
    tangent: 0,
    color: [128, 128, 128, 255],
    size: [4, 4],
    brush: 0,
    layer: STROKE_LAYER.ground,
    phase: 0,
  });
  return buildStrokeReach([buffers]);
}

const gain = (orbs: ReturnType<typeof createHandOrbs>, hand: 0 | 1): number =>
  ((orbs.meshes[hand].material as RawShaderMaterial).uniforms.uGain as { value: number }).value;

describe('hand orbs', () => {
  test('sit on the reactive disturbers, mapped by handedness, at the reaction radius', () => {
    const { tracker, orbs, frame } = setup();
    tracker.frame(0, [HEAD, RIGHT, LEFT]);
    frame();
    const d = tracker.uniforms.uDisturbers.value;
    expect(orbs.meshes[0].position.toArray()).toEqual([d[2].x, d[2].y, d[2].z]);
    expect(orbs.meshes[1].position.toArray()).toEqual([d[1].x, d[1].y, d[1].z]);
    expect(orbs.meshes[0].position.toArray()).toEqual(LEFT);
    expect(orbs.meshes[1].position.toArray()).toEqual(RIGHT);
    expect(orbs.diag()).toMatchObject({ enabled: true, visible: [true, true] });
    // A small ball (Paul's 2026-11-09 headset check: smaller and dimmer): a core of 3 cm and a
    // glow to 8 cm, so at a normal reach the eye is well outside it. Closer in, the near plane test
    // below takes over. A hand's push reaches just past the glow: its edge plus 5 cm.
    expect(ORB_CORE_RADIUS).toBe(0.03);
    expect(ORB_GLOW_RADIUS).toBe(0.08);
    expect(ORB_GLOW_RADIUS * (1 + ORB_GROW) * ORB_MESH_MARGIN).toBeLessThan(0.1);
    expect(HAND_RADIUS).toBeCloseTo(ORB_GLOW_RADIUS + 0.05, 12);
    expect(ORB_GLOW_RADIUS * (1 + ORB_GROW)).toBeLessThan(HAND_RADIUS);
    // About half the old brightness: the peak alpha, 1.15 × the gain, was 1.15 (saturated).
    expect(ORB_GAIN * (ORB_CORE_SHARE + ORB_HALO_SHARE)).toBeCloseTo(0.5175, 9);
    expect(ORB_GAIN * (1 + ORB_BOOST) * (ORB_CORE_SHARE + ORB_HALO_SHARE)).toBeLessThan(0.75);
    const geometry = orbs.meshes[0].geometry as unknown as { parameters: { radius: number } };
    expect(geometry.parameters.radius).toBeCloseTo(ORB_GLOW_RADIUS * ORB_MESH_MARGIN, 9);
    // The drawn silhouette (facets included) holds the glow's whole disc.
    const sag = 1 - Math.cos(Math.PI / 24) * Math.cos(Math.PI / 16);
    expect(geometry.parameters.radius * (1 - sag)).toBeGreaterThan(ORB_GLOW_RADIUS);
    // Both orbs share one geometry, and each draws once: one mesh, no children.
    expect(orbs.meshes[1].geometry).toBe(orbs.meshes[0].geometry);
    expect(orbs.meshes[0].children).toHaveLength(0);
    // They follow the hands frame to frame.
    tracker.frame(14, [HEAD, [0.4, 1.3, -0.5], LEFT]);
    frame();
    expect(orbs.meshes[1].position.toArray()).toEqual([0.4, 1.3, -0.5]);
  });

  test('depth-test, never write depth, draw front faces, blend additively, sort after the strokes', () => {
    const { orbs } = setup();
    for (const mesh of orbs.meshes) {
      const m = mesh.material as RawShaderMaterial;
      expect(m.depthWrite).toBe(false);
      expect(m.depthTest).toBe(true);
      expect(m.side).toBe(FrontSide);
      expect(m.blending).toBe(AdditiveBlending);
      expect(m.transparent).toBe(true);
      expect(mesh.renderOrder).toBe(ORB_RENDER_ORDER);
    }
  });

  test('hide when the setting is off, outside XR, or for an untracked hand', () => {
    const { tracker, orbs, frame } = setup();
    tracker.frame(0, [HEAD, RIGHT, LEFT]);
    frame({ enabled: false });
    expect(orbs.diag()).toMatchObject({ enabled: false, visible: [false, false] });
    frame({ presenting: false });
    expect(orbs.diag()).toMatchObject({ enabled: true, visible: [false, false] });
    // The right controller loses tracking: its disturber's strength drops to 0.
    tracker.frame(14, [HEAD, null, LEFT]);
    frame();
    expect(orbs.diag().visible).toEqual([true, false]);
    // No slot holds the left hand.
    frame({ slots: [-1, 1] });
    expect(orbs.diag().visible).toEqual([false, false]);
    tracker.frame(28, [HEAD, RIGHT, LEFT]);
    frame();
    expect(orbs.diag().visible).toEqual([true, true]);
  });

  test('a hidden orb is not drawn: three skips an invisible object', () => {
    const { tracker, scene, orbs, frame } = setup();
    tracker.frame(0, [HEAD, RIGHT, LEFT]);
    frame({ enabled: false });
    const drawn: string[] = [];
    // The renderer's projectObject returns at `visible === false` before it queues a draw.
    scene.traverseVisible((o) => {
      if ((o as { isMesh?: boolean }).isMesh) drawn.push(o.name);
    });
    expect(drawn).toEqual([]);
    frame();
    scene.traverseVisible((o) => {
      if ((o as { isMesh?: boolean }).isMesh) drawn.push(o.name);
    });
    expect(drawn.sort()).toEqual(['hand-orb-left', 'hand-orb-right']);
    expect(orbs.meshes.every((m) => m.parent === scene)).toBe(true);
  });

  test('brighten within the paint reach, eased, scaled by calm, and settle back away from it', () => {
    const { tracker, orbs, frame } = setup();
    // The right hand at the painted floor, the left one 0.1 m over it and 0.2 m off to the side
    // of the capped quad's edge, so beside the paint.
    const strokeReach = floorAt(RIGHT[1]);
    const left: Vec3 = [RIGHT[0] - 0.4 - 0.05, RIGHT[1] + 0.1, RIGHT[2]];
    tracker.frame(0, [HEAD, RIGHT, left]);
    frame();
    expect(gain(orbs, 1)).toBeCloseTo(ORB_GAIN, 9);
    for (let i = 0; i < 36; i += 1) frame({ strokeReach });
    // Half a second is 3.3 time constants: 96% of the way.
    expect(gain(orbs, 1)).toBeGreaterThan(ORB_GAIN * (1 + 0.95 * ORB_BOOST));
    expect(gain(orbs, 1)).toBeLessThanOrEqual(ORB_GAIN * (1 + ORB_BOOST) + 1e-9);
    expect(orbs.meshes[1].scale.x).toBeGreaterThan(1 + 0.95 * ORB_GROW);
    // The left hand is 0.05 m past the quad's edge and 0.1 m over its plane: q = 0.112 m, so a
    // boost of 1 - (q / R)².
    const q = Math.hypot(0.05, 0.1);
    const diag = orbs.diag();
    expect(diag.reach[1]).toBeCloseTo(0, 6);
    expect(diag.reach[0]).toBeCloseTo(q, 6);
    expect(diag.boost[0]).toBeCloseTo(
      (1 - (q / HAND_RADIUS) ** 2) * (1 - Math.exp(-0.5 / 0.15)),
      3,
    );
    // At calm 0, or with the reactive gate shut, the strokes do not move, so the orb settles back.
    for (let i = 0; i < 72; i += 1) frame({ strokeReach, calm: 0 });
    expect(gain(orbs, 1)).toBeLessThan(ORB_GAIN * 1.01);
    for (let i = 0; i < 36; i += 1) frame({ strokeReach });
    for (let i = 0; i < 72; i += 1) frame({ strokeReach, reactive: false });
    expect(gain(orbs, 1)).toBeLessThan(ORB_GAIN * 1.01);
    expect(orbs.diag().reach).toEqual([null, null]);
  });

  test('a hand moving fast away from the paint stays at its rest glow', () => {
    const { tracker, orbs, frame } = setup();
    const strokeReach = floorAt(RIGHT[1] - HAND_RADIUS - 0.02);
    let t = 0;
    for (let i = 0; i <= 36; i += 1) {
      t = i * (1000 / 72);
      const x = RIGHT[0] + (2 * WAKE_REF_SPEED * t) / 1000;
      tracker.frame(t, [HEAD, [x, RIGHT[1], RIGHT[2]], LEFT]);
      frame({ strokeReach });
    }
    expect(gain(orbs, 1)).toBeCloseTo(ORB_GAIN, 9);
    expect(orbs.meshes[1].scale.x).toBe(1);
    expect(orbs.diag()).toMatchObject({ reach: [null, null], boost: [0, 0] });
  });

  test('a frame allocates no new position or uniform objects', () => {
    const { tracker, orbs, frame } = setup();
    tracker.frame(0, [HEAD, RIGHT, LEFT]);
    const position = orbs.meshes[0].position;
    const uniform = (orbs.meshes[0].material as RawShaderMaterial).uniforms.uGain;
    frame();
    tracker.frame(14, [HEAD, RIGHT, [0, 1, -0.3]]);
    frame();
    expect(orbs.meshes[0].position).toBe(position);
    expect((orbs.meshes[0].material as RawShaderMaterial).uniforms.uGain).toBe(uniform);
  });

  test('draws back faces only while the hand is close enough for the near plane to cut the cap', () => {
    const { tracker, orbs, frame } = setup();
    const program = (m: RawShaderMaterial): string => `${m.vertexShader}|${m.fragmentShader}`;
    const before = program(orbs.meshes[1].material as RawShaderMaterial);
    // The right hand 0.5 m from the head, then 0.2 m, then just past the edge. With no stroke
    // reach the boost stays 0, so the mesh keeps its rest radius.
    const at = (z: number): Vec3 => [HEAD[0], HEAD[1], HEAD[2] - z];
    tracker.frame(0, [HEAD, at(0.5), LEFT]);
    frame({ calm: 0 });
    expect((orbs.meshes[1].material as RawShaderMaterial).side).toBe(FrontSide);
    tracker.frame(14, [HEAD, at(0.2), LEFT]);
    frame({ calm: 0 });
    expect((orbs.meshes[1].material as RawShaderMaterial).side).toBe(BackSide);
    // The switch is per orb: the left hand, 0.5 m out, keeps front faces.
    expect((orbs.meshes[0].material as RawShaderMaterial).side).toBe(FrontSide);
    // The threshold: mesh radius at the current scale, plus the near plane, plus the margin.
    const edge = ORB_GLOW_RADIUS * ORB_MESH_MARGIN + ORB_NEAR + ORB_NEAR_MARGIN;
    expect(edge).toBeLessThan(0.3);
    tracker.frame(28, [HEAD, at(edge + 0.01), LEFT]);
    frame({ calm: 0 });
    expect((orbs.meshes[1].material as RawShaderMaterial).side).toBe(FrontSide);
    // Same shaders, so the same program: `side` is render state only.
    expect(program(orbs.meshes[1].material as RawShaderMaterial)).toBe(before);
  });

  test('one reused state object drives every frame: the orbs keep no reference to a frame', () => {
    const { tracker, orbs } = setup();
    tracker.frame(0, [HEAD, RIGHT, LEFT]);
    const state: Mutable<HandOrbsFrame> = {
      enabled: true,
      presenting: true,
      disturbers: tracker.uniforms.uDisturbers.value,
      slots: [2, 1],
      strokeReach: null,
      reactive: true,
      calm: 1,
      dt: 1 / 72,
    };
    orbs.frame(state);
    expect(orbs.diag().visible).toEqual([true, true]);
    state.enabled = false;
    orbs.frame(state);
    expect(orbs.diag()).toMatchObject({ enabled: false, visible: [false, false] });
    state.enabled = true;
    state.presenting = false;
    orbs.frame(state);
    expect(orbs.diag()).toMatchObject({ enabled: true, visible: [false, false] });
  });

  test('dispose removes both meshes', () => {
    const parent = new Object3D();
    const orbs = createHandOrbs(parent);
    expect(parent.children).toHaveLength(2);
    orbs.dispose();
    expect(parent.children).toHaveLength(0);
  });
});

describe('the Hand orbs toggle', () => {
  test('is a toggle in column 0 under Standing height, clear of the buttons', () => {
    const def = CONTROLS.find((c) => c.id === 'handOrbs');
    expect(def).toMatchObject({ kind: 'toggle', field: 'handOrbs', label: 'Hand orbs', column: 0 });
    const layout = controlLayout('handOrbs');
    if (!layout) throw new Error('no layout');
    expect(hitControl(layout.rect.x, layout.rect.y)?.id).toBe('handOrbs');
    const bottom = layout.rect.y - layout.rect.h / 2;
    for (const button of LAYOUT.filter((l) => l.def.kind === 'button')) {
      const r = controlRect(button);
      expect(bottom - (r.y + r.h / 2)).toBeGreaterThanOrEqual(0.006);
    }
    for (const l of LAYOUT) {
      const r = controlRect(l);
      expect(Math.abs(r.x) + r.w / 2).toBeLessThanOrEqual(PANEL_W / 2);
      expect(Math.abs(r.y) + r.h / 2).toBeLessThanOrEqual(PANEL_H / 2);
    }
  });

  test('flips the stored setting and saves it', () => {
    const saved: boolean[] = [];
    const store = createSettingsStore({
      stored: DEFAULT_SETTINGS,
      flags: { beauty: false, hz: null, seated: null, turn: null, hud: null, calm: null },
      save: (s) => {
        saved.push(s.handOrbs);
        return true;
      },
      schedule: () => 0,
      cancel: () => {},
    });
    expect(store.effective.handOrbs).toBe(true);
    expect(store.set('handOrbs', false)).toBe(true);
    expect(store.effective.handOrbs).toBe(false);
    store.commit();
    expect(saved).toEqual([false]);
  });
});
