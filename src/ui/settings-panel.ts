/**
 * The grabbable XR settings panel (P5.3). `panel-toggle.ts` imports this lazily on the first open,
 * so troika, the font, the meshes and the stroke program cost nothing in a session that never
 * opens it. Hidden, the root is invisible and draws nothing.
 *
 * Shown, it is five draws per view: the low-glare backing, one instanced stroke mesh on the shared
 * stroke program for every border, fill and highlight, one troika `BatchedText` for every label,
 * the two lasers as one line mesh, and the contact markers as one instanced mesh. A tooltip adds
 * its backing. The interaction is `panel-core.ts`; this module only draws it and maps it onto the
 * settings store.
 *
 * The root, the lasers and the controller target-ray spaces are rig children, so everything here
 * is rig-local.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  IntType,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  type Texture,
  Vector3,
} from 'three';
import { BatchedText, Text } from 'troika-three-text';
import { strokeShade } from '../demo/canvas/placement';
import type { GovernorMode } from '../render/governor';
import { BRUSHES } from '../render/strokes/brush-atlas-data';
import { surfaceBasis, type Vec3 } from '../render/strokes/frame';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_ATTRIBUTES,
  STROKE_LAYER,
  type StrokeLayer,
  unpackInstance,
} from '../render/strokes/instance';
import { createStrokeMaterial } from '../render/strokes/material';
import { createTieKeyAttribute, writeTieKeys } from '../render/strokes/tie-key';
import type { HudLive } from '../settings/apply';
import type { QualityMode, Settings } from '../settings/schema';
import type { SettingsStore } from '../settings/store';
import type { Actions, Hand } from '../xr/input';
import {
  CONTROL_Z,
  createPanelInteraction,
  createPanelPose,
  type HandInput,
  LASER_RANGE,
  type PanelFrame,
} from './panel-core';
import {
  activeSegment,
  type ControlLayout,
  controlHidden,
  controlRect,
  formatValue,
  GALLERY_HELP_DISABLED,
  HEADER_Y,
  LAYOUT,
  ladderMode,
  liveSliderDef,
  lockedHelp,
  PANEL_H,
  PANEL_W,
  qualityNote,
  setControlHidden,
  settingFromSlider,
  sliderFraction,
  sliderPosition,
  sliderSetting,
  sliderValue,
  TITLE_Y,
} from './panel-layout';
import {
  clearPanelPose,
  defaultStored,
  fromStored,
  type HeadYaw,
  headYawOf,
  loadPanelPose,
  savePanelPose,
  toStored,
} from './panel-pose';
import type { PanelHold } from './panel-toggle';
import { PANEL_COLORS, PANEL_TYPE } from './settings-panel-colors';
import { createTextThrottle, type TextTarget } from './text-throttle';
import { TEXT_FONT_URL } from './troika-config';
import { createTypesetTracker } from './typeset-tracker';

const STROKE_CAPACITY = 900;
const FILL_Z = 0.002;
const LINE_Z = 0.003;
const TEXT_Z = CONTROL_Z + 0.001;
const TOOLTIP_Z = 0.012;
/** Tooltip text width and its gap from the panel edge, metres at scale 1. */
const TOOLTIP_W = 0.2;
const TOOLTIP_GAP = 0.012;
/**
 * While a slider drags, the panel's texts change at most this often, ms: troika re-typesets on the
 * render after a change, on the main thread.
 */
const TEXT_THROTTLE_MS = 100;
const BORDER_W = 0.0055;
const DAB = 0.05;

type Rgb = readonly [number, number, number];

export interface SettingsPanelDeps {
  /** The rig: the panel root and the lasers are its children. */
  rig: Object3D;
  /** The camera: in XR three writes the head pose into its local transform, rig-relative. */
  camera: Object3D;
  /** The target-ray spaces of each hand, or null while untracked. */
  controller(hand: Hand): Object3D | null;
  store: SettingsStore;
  atlas: Texture;
  recenter(): void;
  /** The registered return-to-gallery callback, or null (P5.5 registers it). */
  gallery(): (() => void) | null;
  /** The quality mode the current or last XR session started with. */
  sessionQuality(): QualityMode;
  /** The running governor's mode, or null with none: the quality level row shows its ladder. */
  governorMode?(): GovernorMode | null;
  /** The perf HUD's live visibility: the HUD toggle shows it and sets it with the setting. */
  hud: HudLive;
}

export type PanelDiag = {
  pose: { position: number[]; quaternion: number[] };
  scale: number;
  hover: Record<Hand, string | null>;
  tooltip: string | null;
  grabbing: boolean;
  /** Text typeset since the last change. */
  typeset: boolean;
};

export interface SettingsPanel {
  readonly isOpen: boolean;
  /** Places the panel at its saved head-yaw pose (or the default spawn) and shows it. */
  open(): void;
  close(): void;
  /** One frame while presenting: returns which hands the panel holds. */
  frame(actions: Actions, now: number): PanelHold;
  /** Respawns in front of the current head at scale 1 and forgets the saved pose. */
  recenter(): void;
  /** Saves the pose relative to the last XR head pose (XR exit). */
  savePose(): void;
  diag(): PanelDiag;
  dispose(): void;
}

interface MutableStroke {
  position: [number, number, number];
  normal: [number, number, number];
  tangent: number;
  color: [number, number, number, number];
  size: [number, number];
  brush: number;
  layer: StrokeLayer;
  phase: number;
  flags: number;
}

const BRISTLE = BRUSHES.flatMap((b, i) => (b.kind === 'bristle' ? [i] : []));

/** A small deterministic jitter so the painted edges are not ruled. */
function jitter(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

export function createSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const { rig, camera, store } = deps;
  const root = new Group();
  root.name = 'settings-panel';
  root.visible = false;
  rig.add(root);
  const pose = createPanelPose();

  // The backing: one opaque plane, both sides, so a grab from behind still reads as the panel.
  const backingGeometry = new PlaneGeometry(PANEL_W, PANEL_H);
  const backingMaterial = new MeshBasicMaterial({
    color: PANEL_COLORS.backing,
    side: DoubleSide,
  });
  const backing = new Mesh(backingGeometry, backingMaterial);
  backing.name = 'settings-panel-backing';
  root.add(backing);

  // Strokes: one instanced mesh on the stroke engine's material and atlas, as the teleport arc.
  const buffers = createStrokeBuffers(STROKE_CAPACITY);
  const strokeGeometry = new InstancedBufferGeometry();
  strokeGeometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3,
    ),
  );
  strokeGeometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  const attributes: InstancedBufferAttribute[] = [];
  for (const spec of STROKE_ATTRIBUTES) {
    const attribute = new InstancedBufferAttribute(
      buffers[spec.key],
      spec.itemSize,
      spec.normalized,
    );
    if (spec.integer) attribute.gpuType = IntType;
    attribute.setUsage(DynamicDrawUsage);
    strokeGeometry.setAttribute(spec.name, attribute);
    attributes.push(attribute);
  }
  const tie = createTieKeyAttribute(buffers);
  strokeGeometry.setAttribute('iTie', tie);
  attributes.push(tie);
  strokeGeometry.instanceCount = 0;
  const strokeMaterial = createStrokeMaterial(deps.atlas);
  strokeMaterial.name = 'settings-panel-strokes';
  // The motion gate stays closed: the reactive wake would push the borders off the panel.
  strokeMaterial.uniforms.uMotionLayers = { value: 0 };
  const strokeMesh = new Mesh(strokeGeometry, strokeMaterial);
  strokeMesh.name = 'settings-panel-strokes';
  strokeMesh.frustumCulled = false;
  root.add(strokeMesh);

  const stroke: MutableStroke = {
    position: [0, 0, 0],
    normal: [0, 0, 1],
    tangent: 0,
    color: [0, 0, 0, 255],
    size: [0, 0],
    brush: 0,
    layer: STROKE_LAYER.ground,
    phase: 0,
    flags: 0,
  };
  const shade = strokeShade([0, 0, 1]);
  let count = 0;
  let seed = 0;

  /** One stroke along x (angle 0) at (x, y, z), length by width, coloured `rgb`. */
  function push(
    x: number,
    y: number,
    z: number,
    angle: number,
    len: number,
    width: number,
    rgb: Rgb,
    brushes: readonly number[],
  ): void {
    if (count >= STROKE_CAPACITY) return;
    seed += 1;
    stroke.position[0] = x;
    stroke.position[1] = y;
    stroke.position[2] = z;
    stroke.size[0] = len;
    stroke.size[1] = width;
    stroke.brush = brushes[seed % brushes.length] as number;
    stroke.tangent = 0;
    packInstance(buffers, count, stroke);
    const { b1, b2 } = surfaceBasis(unpackInstance(buffers, count).normal);
    const a = angle + jitter(seed) * 0.05;
    const along: Vec3 = [Math.cos(a), Math.sin(a), 0];
    stroke.tangent = Math.atan2(
      along[0] * b2[0] + along[1] * b2[1] + along[2] * b2[2],
      along[0] * b1[0] + along[1] * b1[1] + along[2] * b1[2],
    );
    stroke.color[0] = Math.min(255, rgb[0] / shade);
    stroke.color[1] = Math.min(255, rgb[1] / shade);
    stroke.color[2] = Math.min(255, rgb[2] / shade);
    packInstance(buffers, count, stroke);
    count += 1;
  }

  /** A painted line from (x0, y0) to (x1, y1): overlapping bristle dabs. */
  function line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    rgb: Rgb,
    z = LINE_Z,
  ): void {
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (length <= 0) return;
    const n = Math.max(1, Math.ceil(length / DAB));
    const step = length / n;
    const angle = Math.atan2(y1 - y0, x1 - x0);
    for (let i = 0; i < n; i += 1) {
      const t = (i + 0.5) / n;
      const wobble = jitter(seed + 7) * width * 0.25;
      push(
        x0 + (x1 - x0) * t - Math.sin(angle) * wobble,
        y0 + (y1 - y0) * t + Math.cos(angle) * wobble,
        z,
        angle,
        step * 1.3,
        width,
        rgb,
        BRISTLE,
      );
    }
  }

  function outline(x: number, y: number, w: number, h: number, width: number, rgb: Rgb): void {
    const l = x - w / 2;
    const r = x + w / 2;
    const b = y - h / 2;
    const t = y + h / 2;
    line(l, t, r, t, width, rgb);
    line(r, t, r, b, width, rgb);
    line(r, b, l, b, width, rgb);
    line(l, b, l, t, width, rgb);
  }

  /** Fills a rect with rows of overlapping bristle strokes, dense enough to read as solid paint. */
  function fill(x: number, y: number, w: number, h: number, rgb: Rgb): void {
    if (w <= 0) return;
    const rows = Math.max(2, Math.round(h / 0.009));
    const rowH = h / rows;
    for (let j = 0; j < rows; j += 1) {
      const cy = y - h / 2 + rowH * (j + 0.5);
      const n = Math.max(1, Math.ceil(w / DAB));
      const step = w / n;
      for (let i = 0; i < n; i += 1) {
        // Inset by the overhang, so the overlapping strokes stay inside the rect.
        const len = Math.min(step * 1.5, w);
        const cx = Math.min(
          x + w / 2 - len / 2,
          Math.max(x - w / 2 + len / 2, x - w / 2 + step * (i + 0.5)),
        );
        push(cx, cy, FILL_Z, 0, len, rowH * 2, rgb, BRISTLE);
      }
    }
  }

  // Text: every label in one BatchedText.
  const batch = new BatchedText();
  batch.font = TEXT_FONT_URL;
  batch.position.z = TEXT_Z;
  root.add(batch);
  const typesetTracker = createTypesetTracker();

  function text(
    value: string,
    size: number,
    color: number,
    x: number,
    y: number,
    anchorX: string,
    anchorY: string,
  ): Text {
    const t = new Text();
    t.font = TEXT_FONT_URL;
    t.text = value;
    t.fontSize = size;
    t.color = color;
    t.anchorX = anchorX;
    t.anchorY = anchorY;
    t.position.set(x, y, 0);
    batch.addText(t);
    return t;
  }

  text(
    'Settings',
    PANEL_TYPE.title,
    PANEL_COLORS.title,
    -PANEL_W / 2 + 0.024,
    TITLE_Y,
    'left',
    'middle',
  );
  const leftEdge = LAYOUT.find((c) => c.def.column === 0)?.rect;
  const rightEdge = LAYOUT.find((c) => c.def.column === 1)?.rect;
  if (leftEdge)
    text(
      'Comfort',
      PANEL_TYPE.header,
      PANEL_COLORS.header,
      leftEdge.x - leftEdge.w / 2,
      HEADER_Y,
      'left',
      'middle',
    );
  if (rightEdge)
    text(
      'World',
      PANEL_TYPE.header,
      PANEL_COLORS.header,
      rightEdge.x - rightEdge.w / 2,
      HEADER_Y,
      'left',
      'middle',
    );

  interface ControlText {
    layout: ControlLayout;
    label: Text;
    value: Text | null;
    segments: Text[];
  }
  const controlTexts: ControlText[] = LAYOUT.map((layout) => {
    const { def } = layout;
    if (def.kind === 'button') {
      return {
        layout,
        label: text(
          def.label,
          PANEL_TYPE.button,
          PANEL_COLORS.label,
          layout.rect.x,
          layout.rect.y,
          'center',
          'middle',
        ),
        value: null,
        segments: [],
      };
    }
    const label = text(
      def.label,
      PANEL_TYPE.label,
      PANEL_COLORS.label,
      layout.labelAt[0],
      layout.labelAt[1],
      'left',
      'top',
    );
    const value = text(
      '',
      PANEL_TYPE.value,
      PANEL_COLORS.value,
      layout.valueAt[0],
      layout.valueAt[1],
      'right',
      'top',
    );
    const segments = layout.segments.map((s, i) =>
      text(
        def.options?.[i]?.label ?? '',
        PANEL_TYPE.segment,
        PANEL_COLORS.label,
        s.x,
        s.y,
        'center',
        'middle',
      ),
    );
    if (def.kind === 'toggle')
      segments.push(
        text(
          '',
          PANEL_TYPE.segment,
          PANEL_COLORS.label,
          layout.rect.x,
          layout.rect.y,
          'center',
          'middle',
        ),
      );
    return { layout, label, value, segments };
  });

  // Tooltip: a backing plane and a batch member, empty when hidden.
  const tooltipGeometry = new PlaneGeometry(1, 1);
  const tooltipMaterial = new MeshBasicMaterial({ color: PANEL_COLORS.tooltip });
  const tooltipBacking = new Mesh(tooltipGeometry, tooltipMaterial);
  tooltipBacking.visible = false;
  root.add(tooltipBacking);
  const tooltipText = text('', PANEL_TYPE.tooltip, PANEL_COLORS.title, 0, 0, 'center', 'middle');
  tooltipText.maxWidth = TOOLTIP_W;
  tooltipText.textAlign = 'center';
  let tooltipShown: string | null = null;
  /** False until the tooltip state is first applied after an open. */
  let tooltipApplied = false;

  // Lasers: both hands in one line mesh, rig-local.
  const laserPositions = new Float32Array(12);
  const laserColors = new Float32Array(12);
  const laserGeometry = new BufferGeometry();
  const laserPosition = new BufferAttribute(laserPositions, 3);
  laserPosition.setUsage(DynamicDrawUsage);
  const laserColor = new BufferAttribute(laserColors, 3);
  laserColor.setUsage(DynamicDrawUsage);
  laserGeometry.setAttribute('position', laserPosition);
  laserGeometry.setAttribute('color', laserColor);
  const laserMaterial = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
  });
  const lasers = new LineSegments(laserGeometry, laserMaterial);
  lasers.name = 'settings-panel-lasers';
  lasers.frustumCulled = false;
  lasers.visible = false;
  rig.add(lasers);

  // Contact markers: a small ring per hand, on the panel at the hit.
  const markerGeometry = new RingGeometry(0.0045, 0.0075, 24);
  const markerMaterial = new MeshBasicMaterial({
    color: new Color().setRGB(
      ...(PANEL_COLORS.active.map((c) => c / 255) as [number, number, number]),
    ),
  });
  const markers = new InstancedMesh(markerGeometry, markerMaterial, 2);
  markers.name = 'settings-panel-markers';
  markers.frustumCulled = false;
  markers.visible = false;
  markers.count = 0;
  root.add(markers);
  const markerMatrix = new Matrix4();

  // Interaction.
  const dragging = new Map<string, Hand>();
  const interaction = createPanelInteraction({
    press(hit, hand) {
      const layout = LAYOUT.find((c) => c.def.id === hit.id);
      if (!layout) return;
      const { def } = layout;
      if (def.kind === 'button') {
        if (def.action === 'recenter') deps.recenter();
        else if (def.action === 'gallery') deps.gallery()?.();
        return;
      }
      if (!def.field || def.disabled || store.isLocked(def.field)) return;
      if (def.field === 'hud') {
        // The HUD toggle flips what is showing now, then stores it as the starting visibility.
        const next = !deps.hud.visible();
        store.set('hud', next);
        store.commit();
        deps.hud.setVisible(next);
      } else if (def.kind === 'toggle') {
        store.set(def.field, !store.stored[def.field] as never);
        store.commit();
      } else if (def.kind === 'segmented') {
        const option = def.options?.[hit.segment];
        if (option) {
          store.set(def.field, option.value as never);
          store.commit();
        }
      } else {
        dragging.set(def.id, hand);
        const mode = levelMode();
        const value = sliderValue(liveSliderDef(def, mode), hit.fraction);
        store.set(def.field, settingFromSlider(def, value, store.effective, mode) as never);
      }
    },
    drag(id, x) {
      const layout = LAYOUT.find((c) => c.def.id === id);
      if (!layout?.def.field || !dragging.has(id)) return;
      const mode = levelMode();
      const value = sliderValue(liveSliderDef(layout.def, mode), sliderFraction(layout, x));
      store.set(
        layout.def.field,
        settingFromSlider(layout.def, value, store.effective, mode) as never,
      );
    },
    release(id) {
      if (!dragging.delete(id)) return;
      store.commit();
      // The last value of a throttled drag still typesets.
      syncText(performance.now(), true);
    },
    grabEnd() {
      saveRelative();
    },
  });

  function levelMode(): GovernorMode {
    return ladderMode(deps.governorMode?.() ?? null, store.effective.quality);
  }

  /** The last XR head pose, rig-local: the pose saves against it on XR exit. */
  const head = { position: new Vector3(0, 1.6, 0), yaw: 0 };
  function readHead(): HeadYaw {
    head.position.copy(camera.position);
    head.yaw = headYawOf(camera.quaternion);
    return head;
  }

  function applyPose(): void {
    root.position.copy(pose.position);
    root.quaternion.copy(pose.quaternion);
    root.scale.setScalar(pose.scale);
  }

  function saveRelative(): void {
    savePanelPose(toStored(pose, head));
  }

  // What the last paint showed, so an unchanged frame repaints nothing and allocates nothing.
  let settingsChanged = true;
  const painted = {
    left: null as string | null,
    right: null as string | null,
    quality: '' as QualityMode | '',
    mode: '' as GovernorMode | '',
    gallery: false,
    hud: false,
  };
  const texts = createTextThrottle(TEXT_THROTTLE_MS);
  function setText(target: TextTarget, value: string): void {
    texts.set(target, value);
  }

  /** Repaints the strokes and texts for the settings and the hover; only when they changed. */
  function paint(settings: Settings, hover: Record<Hand, string | null>, force = false): void {
    const locks = store.locks;
    const quality = deps.sessionQuality();
    const mode = levelMode();
    const gallery = deps.gallery() !== null;
    const hudOn = deps.hud.visible();
    if (
      !force &&
      !settingsChanged &&
      hover.left === painted.left &&
      hover.right === painted.right &&
      quality === painted.quality &&
      mode === painted.mode &&
      gallery === painted.gallery &&
      hudOn === painted.hud
    ) {
      return;
    }
    settingsChanged = false;
    painted.left = hover.left;
    painted.right = hover.right;
    painted.quality = quality;
    painted.mode = mode;
    painted.gallery = gallery;
    painted.hud = hudOn;
    count = 0;
    seed = 0;
    // The frame: a double painted border.
    outline(0, 0, PANEL_W - 0.008, PANEL_H - 0.008, BORDER_W * 1.4, PANEL_COLORS.frame);
    outline(0, 0, PANEL_W - 0.022, PANEL_H - 0.022, BORDER_W * 0.6, PANEL_COLORS.track);
    line(
      -PANEL_W / 2 + 0.024,
      TITLE_Y - 0.024,
      PANEL_W / 2 - 0.024,
      TITLE_Y - 0.024,
      BORDER_W * 0.7,
      PANEL_COLORS.track,
    );
    // Return to gallery shows only inside a painting's world (P5.5); hidden, it takes no hits.
    setControlHidden('gallery', !gallery);
    for (const ct of controlTexts) {
      const { def, segments } = ct.layout;
      const hidden = controlHidden(def.id);
      ct.label.visible = !hidden;
      // BatchedText draws a member whatever its `visible` says, so a hidden label is emptied.
      if (def.kind === 'button') setText(ct.label, hidden ? '' : def.label);
      if (hidden) continue;
      const rect = controlRect(ct.layout);
      if (def.kind === 'button') ct.label.position.x = rect.x;
      const locked = def.field ? locks[def.field] : undefined;
      const disabled =
        Boolean(def.disabled) || (def.action === 'gallery' && !gallery) || Boolean(locked);
      const hovered = !disabled && (hover.left === def.id || hover.right === def.id);
      const edge: Rgb =
        def.disabled || (def.action === 'gallery' && !gallery)
          ? PANEL_COLORS.disabled
          : locked
            ? PANEL_COLORS.locked
            : hovered
              ? PANEL_COLORS.hover
              : PANEL_COLORS.idle;
      ct.label.color = disabled ? PANEL_COLORS.muted : PANEL_COLORS.label;
      if (def.kind === 'button') {
        outline(rect.x, rect.y, rect.w, rect.h, BORDER_W, edge);
        if (hovered) fill(rect.x, rect.y, rect.w - 0.012, rect.h - 0.012, PANEL_COLORS.track);
        continue;
      }
      const value = ct.value as Text;
      value.color = PANEL_COLORS.value;
      setText(value, formatValue(def, settings, mode));
      if (def.kind === 'slider') {
        const f = sliderPosition(liveSliderDef(def, mode), sliderSetting(def, settings, mode));
        const left = rect.x - rect.w / 2;
        line(
          left,
          rect.y,
          left + rect.w,
          rect.y,
          BORDER_W * 1.1,
          def.disabled ? PANEL_COLORS.disabled : PANEL_COLORS.track,
        );
        const fillRgb: Rgb = disabled ? edge : PANEL_COLORS.active;
        if (f > 0)
          line(left, rect.y, left + rect.w * f, rect.y, BORDER_W * 1.6, fillRgb, FILL_Z + 0.0005);
        // The knob: a short upright dab pair at the value.
        const kx = left + rect.w * f;
        line(
          kx,
          rect.y - rect.h * 0.36,
          kx,
          rect.y + rect.h * 0.36,
          BORDER_W * 2.2,
          hovered ? PANEL_COLORS.hover : fillRgb,
        );
      } else if (def.kind === 'segmented') {
        const active = activeSegment(def, settings);
        segments.forEach((s, i) => {
          if (i === active)
            fill(s.x, s.y, s.w - 0.008, s.h - 0.006, disabled ? edge : PANEL_COLORS.active);
          outline(s.x, s.y, s.w - 0.004, s.h, BORDER_W * 0.8, edge);
          const label = ct.segments[i];
          if (label)
            label.color =
              i === active && !disabled
                ? PANEL_COLORS.onActive
                : disabled
                  ? PANEL_COLORS.muted
                  : PANEL_COLORS.label;
        });
        if (def.field === 'quality') {
          const note = qualityNote(settings.quality, quality);
          if (note && !locked) {
            setText(value, note);
            value.color = PANEL_COLORS.note;
          }
        }
      } else {
        // The HUD toggle shows the HUD as it is now, which left X and H change for the session.
        const on = def.field === 'hud' ? hudOn : settings[def.field as keyof Settings] === true;
        if (on)
          fill(
            rect.x,
            rect.y,
            rect.w - 0.008,
            rect.h - 0.006,
            disabled ? edge : PANEL_COLORS.active,
          );
        outline(rect.x, rect.y, rect.w, rect.h, BORDER_W * 0.8, edge);
        const label = ct.segments[0];
        if (label) {
          setText(label, on ? 'On' : 'Off');
          label.color =
            on && !disabled
              ? PANEL_COLORS.onActive
              : disabled
                ? PANEL_COLORS.muted
                : PANEL_COLORS.label;
        }
      }
      if (locked) {
        setText(value, `set by ${locked.split('=')[0]}`);
        value.color = PANEL_COLORS.muted;
      } else if (def.disabled) {
        setText(value, 'later');
        value.color = PANEL_COLORS.muted;
      }
    }
    strokeGeometry.instanceCount = count;
    writeTieKeys(buffers, tie.array as Float32Array, count);
    for (const attribute of attributes) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  /** Assigns the queued texts (throttled only while a slider drags) and typesets them. */
  function syncText(now: number, force: boolean): void {
    const flushed = texts.flush(now, force || dragging.size === 0);
    if (!flushed && !force) return;
    if (flushed) typesetTracker.markDirty();
    typesetTracker.sync((done) => batch.sync(done));
  }

  function helpFor(id: string): string {
    const layout = LAYOUT.find((c) => c.def.id === id);
    if (!layout) return '';
    const { def } = layout;
    const flag = def.field ? store.locks[def.field] : undefined;
    if (flag) return lockedHelp(flag);
    if (def.action === 'gallery' && deps.gallery() === null) return GALLERY_HELP_DISABLED;
    return def.disabled ?? def.help;
  }

  function setTooltipText(value: string): void {
    if (tooltipText.text === value) return;
    tooltipText.text = value;
    typesetTracker.markDirty();
  }

  function showTooltip(id: string | null): boolean {
    if (tooltipApplied && id === tooltipShown) return false;
    tooltipApplied = true;
    tooltipShown = id;
    const layout = id ? LAYOUT.find((c) => c.def.id === id) : undefined;
    if (!id || !layout) {
      setTooltipText('');
      tooltipBacking.visible = false;
      return true;
    }
    const help = helpFor(id);
    // Beside the panel, on the hovered column's outer side and level with the control, so it
    // never covers another control or label.
    const lineChars = TOOLTIP_W / (PANEL_TYPE.tooltip * 0.52);
    const lines = Math.max(1, Math.ceil(help.length / lineChars));
    const width = lines > 1 ? TOOLTIP_W + 0.02 : help.length * PANEL_TYPE.tooltip * 0.52 + 0.02;
    const height = lines * PANEL_TYPE.tooltip * 1.3 + 0.016;
    const side = layout.def.column === 0 ? -1 : 1;
    const x = side * (PANEL_W / 2 + TOOLTIP_GAP + width / 2);
    const y = layout.rect.y;
    setTooltipText(help);
    tooltipText.position.set(x, y, TOOLTIP_Z - TEXT_Z + 0.001);
    tooltipBacking.scale.set(width, height, 1);
    tooltipBacking.position.set(x, y, TOOLTIP_Z);
    tooltipBacking.visible = true;
    return true;
  }

  const noHover: Record<Hand, string | null> = { left: null, right: null };
  let open = false;
  let lastFrame: PanelFrame | null = null;
  const unsubscribe = store.subscribe(() => {
    settingsChanged = true;
    if (!open) return;
    paint(
      store.effective,
      lastFrame?.hands
        ? { left: lastFrame.hands.left.hover, right: lastFrame.hands.right.hover }
        : noHover,
    );
    syncText(performance.now(), false);
  });

  const hands: Partial<Record<Hand, HandInput>> = {};
  /** One reused input per hand, so a frame allocates nothing. */
  type ScratchHand = { -readonly [K in keyof HandInput]-?: HandInput[K] };
  const scratchHand = (): ScratchHand => ({
    origin: new Vector3(),
    direction: new Vector3(),
    position: new Vector3(),
    quaternion: new Quaternion(),
    trigger: { down: false, fired: false },
    grip: { down: false, fired: false },
    stick: { x: 0, y: 0 },
  });
  const handScratch: Record<Hand, ScratchHand> = { left: scratchHand(), right: scratchHand() };
  const hover: Record<Hand, string | null> = { left: null, right: null };
  const none: PanelHold = {
    left: false,
    right: false,
    sticks: { left: false, right: false },
    hits: { left: false, right: false },
    pose: null,
  };
  const hold = {
    left: false,
    right: false,
    sticks: { left: false, right: false },
    hits: { left: false, right: false },
    pose,
  };

  function gather(actions: Actions): void {
    for (const hand of ['left', 'right'] as const) {
      const space = deps.controller(hand);
      if (!space?.visible) {
        delete hands[hand];
        continue;
      }
      const s = handScratch[hand];
      s.position.copy(space.position);
      s.quaternion.copy(space.quaternion);
      s.origin.copy(space.position);
      s.direction.set(0, 0, -1).applyQuaternion(space.quaternion);
      const own = actions.hands[hand];
      s.trigger = own.trigger;
      s.grip = own.grip;
      s.stick = own.stick;
      hands[hand] = s;
    }
  }

  function writeLasers(frame: PanelFrame): void {
    let any = false;
    (['left', 'right'] as const).forEach((hand, i) => {
      const input = hands[hand];
      const o = i * 6;
      if (!input) {
        laserPositions.fill(0, o, o + 6);
        return;
      }
      any = true;
      const hit = frame.hands[hand].hit;
      const length = hit ? hit.distance : LASER_RANGE;
      laserPositions[o] = input.origin.x;
      laserPositions[o + 1] = input.origin.y;
      laserPositions[o + 2] = input.origin.z;
      laserPositions[o + 3] = input.origin.x + input.direction.x * length;
      laserPositions[o + 4] = input.origin.y + input.direction.y * length;
      laserPositions[o + 5] = input.origin.z + input.direction.z * length;
      const rgb = hit?.control ? PANEL_COLORS.active : PANEL_COLORS.hover;
      for (let k = 0; k < 2; k += 1) {
        laserColors[o + k * 3] = rgb[0] / 255;
        laserColors[o + k * 3 + 1] = rgb[1] / 255;
        laserColors[o + k * 3 + 2] = rgb[2] / 255;
      }
    });
    laserPosition.needsUpdate = true;
    laserColor.needsUpdate = true;
    lasers.visible = any;
    let n = 0;
    for (const hand of ['left', 'right'] as const) {
      const hit = frame.hands[hand].hit;
      if (!hit || !hands[hand]) continue;
      markerMatrix.makeTranslation(hit.x, hit.y, (hit.control ? CONTROL_Z : 0) + 0.002);
      markers.setMatrixAt(n, markerMatrix);
      n += 1;
    }
    markers.count = n;
    markers.instanceMatrix.needsUpdate = true;
    markers.visible = n > 0;
  }

  function placeDefault(): void {
    fromStored(defaultStored(), readHead(), pose);
    applyPose();
  }

  return {
    get isOpen() {
      return open;
    },
    open() {
      const saved = loadPanelPose();
      fromStored(saved ?? defaultStored(), readHead(), pose);
      applyPose();
      interaction.reset();
      dragging.clear();
      open = true;
      root.visible = true;
      tooltipApplied = false;
      showTooltip(null);
      paint(store.effective, noHover, true);
      syncText(performance.now(), true);
    },
    close() {
      if (!open) return;
      // A close mid-grab ends the grab without its release, so it saves the pose here.
      if (lastFrame?.grabbing) saveRelative();
      if (dragging.size > 0) store.commit();
      dragging.clear();
      interaction.reset();
      open = false;
      root.visible = false;
      lasers.visible = false;
      markers.visible = false;
      lastFrame = null;
    },
    frame(actions, now) {
      readHead();
      if (!open) return none;
      gather(actions);
      const frame = interaction.frame(hands, pose, now);
      lastFrame = frame;
      if (frame.grabbing) applyPose();
      writeLasers(frame);
      hover.left = frame.hands.left.hover;
      hover.right = frame.hands.right.hover;
      paint(store.effective, hover);
      const tooltipChanged = showTooltip(frame.tooltip);
      if (tooltipChanged) syncText(now, true);
      // Texts a paint queued outside a press or drag, such as the HUD toggle after left X or H.
      else if (texts.pending) syncText(now, false);
      hold.left = frame.claimed.left;
      hold.right = frame.claimed.right;
      hold.sticks.left = frame.hands.left.grabbing;
      hold.sticks.right = frame.hands.right.grabbing;
      hold.hits.left = frame.hands.left.hit !== null;
      hold.hits.right = frame.hands.right.hit !== null;
      return hold;
    },
    recenter() {
      clearPanelPose();
      placeDefault();
      interaction.reset();
    },
    savePose() {
      if (open) saveRelative();
    },
    diag: () => ({
      pose: { position: pose.position.toArray(), quaternion: pose.quaternion.toArray() },
      scale: pose.scale,
      hover: lastFrame
        ? { left: lastFrame.hands.left.hover, right: lastFrame.hands.right.hover }
        : { ...noHover },
      tooltip: tooltipShown,
      grabbing: lastFrame?.grabbing ?? false,
      typeset: typesetTracker.typeset,
    }),
    dispose() {
      unsubscribe();
      root.removeFromParent();
      lasers.removeFromParent();
      backingGeometry.dispose();
      backingMaterial.dispose();
      strokeGeometry.dispose();
      strokeMaterial.dispose();
      batch.dispose();
      tooltipGeometry.dispose();
      tooltipMaterial.dispose();
      laserGeometry.dispose();
      laserMaterial.dispose();
      markerGeometry.dispose();
      markerMaterial.dispose();
    },
  };
}
