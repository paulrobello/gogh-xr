/**
 * The XR notice stack (P5.6): troika SDF text on small plates parented to the camera, so the
 * notices follow the head the way the perf HUD does. `notices.ts` imports this lazily, on the first
 * presenting frame with a notice queued, so a session that never shows one loads none of it beyond
 * what the HUD already loads.
 *
 * Each shown notice is a plate with its text and a Dismiss button; the newest sits at the bottom,
 * nearest the eye line. While notices show and the settings panel is closed, a laser from each
 * tracked controller shows where it points (the open panel draws its own). Hidden, nothing draws.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  Vector3,
} from 'three';
import { Text } from 'troika-three-text';
import type { Hand } from '../xr/input';
import {
  NOTICE_DISTANCE,
  NOTICE_W,
  noticeAnchor,
  noticeElevation,
  rayRectDistance,
} from './notice-geometry';
import type { Notice, NoticeKind } from './notice-queue';
import { MAX_SHOWN } from './notice-queue';
import type { PanelPose } from './panel-core';
import { PANEL_H, PANEL_W } from './panel-layout';
import { TEXT_FONT_URL } from './troika-config';

const PAD = 0.008;
const GAP = 0.006;
const FONT_SIZE = 0.0105;
const BUTTON_W = 0.06;
const BUTTON_H = 0.026;
const LABEL_SIZE = 0.0095;
/** A laser that meets no dismiss button stops here, metres. */
const LASER_LENGTH = 1.5;
/** Above the perf HUD's 1,000,000 and 1,000,001. */
const RENDER_ORDER = 1_000_100;
const PLATE_COLOR = 0x3a1d1d;
const BUTTON_COLOR = 0x6a3030;
const BUTTON_HOVER = 0xa04848;
const TEXT_COLOR = 0xf5dede;
const LASER_COLOR = 0xf2c84b;

export interface NoticeHudDeps {
  camera: Object3D;
  scene: Object3D;
  /** The rig: the panel pose is rig-local. */
  rig: Object3D;
  /** A hand's target-ray space, or null when it is not tracked. */
  controller(hand: Hand): Object3D | null;
}

export interface NoticeHudFrame {
  /** True while an XR session presents: the stack shows only then. */
  presenting: boolean;
  shown: readonly Notice[];
  /** The open settings panel's rig-local pose, or null while closed. */
  panelPose: Readonly<PanelPose> | null;
}

export interface NoticeTargetDiag {
  kind: NoticeKind;
  /** The dismiss button's centre, world space. */
  center: [number, number, number];
  hovered: boolean;
}

export interface NoticeHudDiag {
  visible: boolean;
  /** The stack's bottom-edge elevation above the eye line, degrees. */
  elevationDeg: number;
  typeset: boolean;
  targets: NoticeTargetDiag[];
}

export interface NoticeHud {
  /**
   * One frame, before the controllers' targets are read: shows or hides the stack, lays out the
   * shown notices and places the stack. Returns the dismiss button each hand's ray meets.
   */
  frame(input: NoticeHudFrame): Record<Hand, NoticeKind | null>;
  /** After arbitration: the buttons a hand may press highlight, and the lasers update. */
  setHover(hover: Record<Hand, NoticeKind | null>): void;
  diag(): NoticeHudDiag;
  dispose(): void;
}

interface Slot {
  readonly group: Group;
  readonly plate: Mesh;
  readonly button: Mesh;
  readonly buttonMaterial: MeshBasicMaterial;
  readonly text: Text;
  readonly label: Text;
  kind: NoticeKind | null;
  /** The plate's height once typeset, metres. */
  height: number;
}

const HANDS: readonly Hand[] = ['left', 'right'];

export function startNoticeHud(deps: NoticeHudDeps): NoticeHud {
  const { camera, scene, rig } = deps;
  const root = new Group();
  root.name = 'notice-hud';
  root.visible = false;
  const plateGeometry = new PlaneGeometry(1, 1);
  const plateMaterial = new MeshBasicMaterial({
    color: PLATE_COLOR,
    transparent: true,
    opacity: 0.88,
    depthTest: false,
    depthWrite: false,
  });
  const textMaterial = new MeshBasicMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

  function makeText(size: number, color: number, order: number): Text {
    const t = new Text();
    t.font = TEXT_FONT_URL;
    t.fontSize = size;
    t.lineHeight = 1.25;
    t.color = color;
    t.material = textMaterial;
    t.renderOrder = order;
    t.frustumCulled = false;
    return t;
  }

  const slots: Slot[] = [];
  for (let i = 0; i < MAX_SHOWN; i += 1) {
    const group = new Group();
    group.visible = false;
    const plate = new Mesh(plateGeometry, plateMaterial);
    plate.renderOrder = RENDER_ORDER;
    plate.frustumCulled = false;
    const buttonMaterial = new MeshBasicMaterial({
      color: BUTTON_COLOR,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    const button = new Mesh(plateGeometry, buttonMaterial);
    button.scale.set(BUTTON_W, BUTTON_H, 1);
    button.position.set(NOTICE_W / 2 - PAD - BUTTON_W / 2, 0, 0.0005);
    button.renderOrder = RENDER_ORDER + 1;
    button.frustumCulled = false;
    const text = makeText(FONT_SIZE, TEXT_COLOR, RENDER_ORDER + 2);
    text.maxWidth = NOTICE_W - BUTTON_W - PAD * 3;
    text.anchorX = 'left';
    text.anchorY = 'middle';
    text.position.set(-NOTICE_W / 2 + PAD, 0, 0.001);
    const label = makeText(LABEL_SIZE, TEXT_COLOR, RENDER_ORDER + 2);
    label.text = 'Dismiss';
    label.anchorX = 'center';
    label.anchorY = 'middle';
    label.position.set(button.position.x, 0, 0.001);
    group.add(plate, button, text, label);
    root.add(group);
    slots.push({
      group,
      plate,
      button,
      buttonMaterial,
      text,
      label,
      kind: null,
      height: BUTTON_H + PAD * 2,
    });
  }
  let typeset = false;

  const addedCamera = camera.parent === null;
  if (addedCamera) scene.add(camera);
  camera.add(root);

  // Lasers, world space: both hands in one line mesh.
  const laserPositions = new Float32Array(12);
  const laserGeometry = new BufferGeometry();
  const laserPosition = new BufferAttribute(laserPositions, 3);
  laserPosition.setUsage(DynamicDrawUsage);
  laserGeometry.setAttribute('position', laserPosition);
  const laserMaterial = new LineBasicMaterial({
    color: LASER_COLOR,
    transparent: true,
    opacity: 0.75,
  });
  const lasers = new LineSegments(laserGeometry, laserMaterial);
  lasers.name = 'notice-lasers';
  lasers.frustumCulled = false;
  lasers.visible = false;
  scene.add(lasers);

  let lastShown: readonly Notice[] | null = null;
  let elevation = noticeElevation(null, 0);
  let lasersWanted = false;
  const hover: Record<Hand, NoticeKind | null> = { left: null, right: null };
  const hits: Record<Hand, number | null> = { left: null, right: null };
  const rays: Record<Hand, { origin: Vector3; direction: Vector3; tracked: boolean }> = {
    left: { origin: new Vector3(), direction: new Vector3(), tracked: false },
    right: { origin: new Vector3(), direction: new Vector3(), tracked: false },
  };
  const inverse = new Matrix4();
  const cameraInverse = new Matrix4();
  const panelMatrix = new Matrix4();
  const panelScale = new Vector3();
  const corners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  const center = new Vector3();

  /** Stacks the shown slots upward from the root, newest at the bottom. */
  function stack(): void {
    let y = 0;
    for (const slot of slots) {
      if (!slot.group.visible) continue;
      slot.plate.scale.set(NOTICE_W, slot.height, 1);
      slot.group.position.y = y + slot.height / 2;
      y += slot.height + GAP;
    }
  }

  function stackHeight(): number {
    let y = 0;
    for (const slot of slots) if (slot.group.visible) y += slot.height + GAP;
    return Math.max(0, y - GAP);
  }

  function layout(shown: readonly Notice[]): void {
    slots.forEach((slot, i) => {
      const notice = shown[i];
      slot.kind = notice?.kind ?? null;
      slot.group.visible = notice !== undefined;
      if (!notice || slot.text.text === notice.text) return;
      slot.text.text = notice.text;
      slot.text.sync(() => {
        const bounds = slot.text.textRenderInfo?.blockBounds;
        if (!bounds) return;
        slot.height = Math.max(bounds[3] - bounds[1], BUTTON_H) + PAD * 2;
        typeset = true;
        stack();
      });
    });
    stack();
  }

  /** The open panel's corners in camera space, or null. */
  function panelCorners(pose: Readonly<PanelPose> | null): Vector3[] | null {
    if (!pose) return null;
    panelScale.setScalar(pose.scale);
    panelMatrix.compose(pose.position, pose.quaternion, panelScale);
    rig.updateWorldMatrix(true, false);
    panelMatrix.premultiply(rig.matrixWorld);
    cameraInverse.copy(camera.matrixWorld).invert();
    panelMatrix.premultiply(cameraInverse);
    const hw = PANEL_W / 2;
    const hh = PANEL_H / 2;
    corners[0].set(-hw, -hh, 0).applyMatrix4(panelMatrix);
    corners[1].set(hw, -hh, 0).applyMatrix4(panelMatrix);
    corners[2].set(hw, hh, 0).applyMatrix4(panelMatrix);
    corners[3].set(-hw, hh, 0).applyMatrix4(panelMatrix);
    return corners;
  }

  function writeLasers(): void {
    let any = false;
    HANDS.forEach((hand, i) => {
      const ray = rays[hand];
      const o = i * 6;
      if (!lasersWanted || !ray.tracked) {
        laserPositions.fill(0, o, o + 6);
        return;
      }
      any = true;
      const length = hover[hand] !== null ? (hits[hand] ?? LASER_LENGTH) : LASER_LENGTH;
      laserPositions[o] = ray.origin.x;
      laserPositions[o + 1] = ray.origin.y;
      laserPositions[o + 2] = ray.origin.z;
      laserPositions[o + 3] = ray.origin.x + ray.direction.x * length;
      laserPositions[o + 4] = ray.origin.y + ray.direction.y * length;
      laserPositions[o + 5] = ray.origin.z + ray.direction.z * length;
    });
    laserPosition.needsUpdate = true;
    lasers.visible = any;
  }

  return {
    frame({ presenting, shown, panelPose }) {
      const targets: Record<Hand, NoticeKind | null> = { left: null, right: null };
      const visible = presenting && shown.length > 0;
      root.visible = visible;
      lasersWanted = visible && panelPose === null;
      if (!visible) {
        for (const hand of HANDS) rays[hand].tracked = false;
        return targets;
      }
      if (shown !== lastShown) {
        layout(shown);
        lastShown = shown;
      }
      camera.updateWorldMatrix(true, false);
      const angle = Math.atan2(stackHeight(), NOTICE_DISTANCE);
      elevation = noticeElevation(panelCorners(panelPose), angle);
      noticeAnchor(elevation, root.position);
      root.rotation.set(elevation, 0, 0);
      root.updateWorldMatrix(false, true);
      for (const hand of HANDS) {
        const ray = rays[hand];
        const space = deps.controller(hand);
        hits[hand] = null;
        ray.tracked = Boolean(space?.visible);
        if (!space || !ray.tracked) continue;
        space.updateWorldMatrix(true, false);
        ray.origin.setFromMatrixPosition(space.matrixWorld);
        ray.direction.set(0, 0, -1).transformDirection(space.matrixWorld);
        let nearest = Number.POSITIVE_INFINITY;
        for (const slot of slots) {
          if (!slot.group.visible || slot.kind === null) continue;
          inverse.copy(slot.button.matrixWorld).invert();
          const t = rayRectDistance(ray.origin, ray.direction, inverse, 1, 1);
          if (t !== null && t < nearest) {
            nearest = t;
            targets[hand] = slot.kind;
            hits[hand] = t;
          }
        }
      }
      return targets;
    },
    setHover(next) {
      hover.left = next.left;
      hover.right = next.right;
      for (const slot of slots) {
        const on = slot.kind !== null && (next.left === slot.kind || next.right === slot.kind);
        slot.buttonMaterial.color.setHex(on ? BUTTON_HOVER : BUTTON_COLOR);
      }
      writeLasers();
    },
    diag: () => ({
      visible: root.visible,
      elevationDeg: (elevation * 180) / Math.PI,
      typeset,
      targets: slots
        .filter((slot) => slot.group.visible && slot.kind !== null)
        .map((slot) => {
          slot.button.updateWorldMatrix(true, false);
          center.setFromMatrixPosition(slot.button.matrixWorld);
          const kind = slot.kind as NoticeKind;
          return {
            kind,
            center: [center.x, center.y, center.z] as [number, number, number],
            hovered: hover.left === kind || hover.right === kind,
          };
        }),
    }),
    dispose() {
      root.removeFromParent();
      lasers.removeFromParent();
      if (addedCamera && camera.parent === scene) scene.remove(camera);
      for (const slot of slots) {
        slot.text.dispose();
        slot.label.dispose();
        slot.buttonMaterial.dispose();
      }
      plateGeometry.dispose();
      plateMaterial.dispose();
      textMaterial.dispose();
      laserGeometry.dispose();
      laserMaterial.dispose();
    },
  };
}
