/**
 * The perf HUD (P1.7). A troika SDF text panel parented to the camera, so it follows the head in
 * XR and the viewer on desktop. While shown, every frame records the frame stats; the text
 * recomputes at 4 Hz and troika re-typesets only when the string changes (`perf-hud-text.ts`).
 * `hud-toggle.ts` builds it on its first show and drives `frame` and `setVisible`.
 *
 * `diag()` is the panel's visibility, the text on the troika mesh, the frame time it was recomputed at and whether troika
 * has typeset it; `main.ts` serves it under the `hud` diag key. This module registers `frame`: the
 * live frame stats the HUD reads, with the time of the last recorded frame.
 */
import { Group, Mesh, MeshBasicMaterial, type Object3D, PlaneGeometry } from 'three';
import { configureTextBuilder, Text } from 'troika-three-text';
import { FrameStats } from '../bench/stats';
import { registerDiag, unregisterDiag } from '../diag/diag';
import type { GovernorDiag } from '../render/governor-runtime';
import type { ToggleableHud } from './hud-toggle';
import { createHudUpdater, type PerfHudValues } from './perf-hud-text';

export const HUD_FONT_URL = `${import.meta.env.BASE_URL}fonts/NotoSans-Regular.ttf`;

// Typesetting on the main thread keeps troika off blob workers; the local font keeps it off its CDN.
configureTextBuilder({ defaultFontURL: HUD_FONT_URL, useWorker: false });

const PANEL_W = 0.3;
const PAD = 0.01;
const FONT_SIZE = 0.0115;
/** Below the eye line and tilted up to face the eye, so the painting ahead stays clear. */
const PANEL_Y = -0.12;
const PANEL_Z = -0.6;
const RENDER_ORDER = 1_000_000;

export interface PerfHudXr {
  addEventListener(type: 'sessionstart' | 'sessionend', listener: () => void): void;
  removeEventListener(type: 'sessionstart' | 'sessionend', listener: () => void): void;
}

export interface PerfHudDeps {
  /** The HUD's parent. Camera children only render when the camera is in the scene graph. */
  camera: Object3D;
  scene: Object3D;
  xr: PerfHudXr;
  /** The requested target, shown when no governor runs. */
  targetHz: number;
  getGovernor(): GovernorDiag | null;
  getVisible(): number | null;
}

export interface PerfHud extends ToggleableHud {
  /** Call once per animation frame while shown, after rendering, with the frame timestamp. */
  frame(time: number): void;
  /** Starts hidden. Showing restarts the frame stats, which record nothing while hidden. */
  setVisible(visible: boolean): void;
  /** `visible` is the panel's own visibility. */
  diag(): { visible: boolean; text: string; updatedAt: number | null; typeset: boolean };
  dispose(): void;
}

export function startPerfHud(deps: PerfHudDeps): PerfHud {
  const { camera, scene, xr } = deps;
  const stats = new FrameStats();
  let lastFrame: number | null = null;
  let disposed = false;

  const panel = new Group();
  panel.name = 'perf-hud';
  panel.visible = false;
  panel.position.set(0, PANEL_Y, PANEL_Z);
  panel.rotation.x = Math.atan2(-PANEL_Y, -PANEL_Z);

  const plateGeometry = new PlaneGeometry(1, 1);
  const plateMaterial = new MeshBasicMaterial({
    color: 0x080c18,
    transparent: true,
    opacity: 0.78,
    depthTest: false,
    depthWrite: false,
  });
  const plate = new Mesh(plateGeometry, plateMaterial);
  plate.scale.set(PANEL_W, FONT_SIZE * 2 + PAD * 2, 1);
  plate.position.y = -plate.scale.y / 2;
  plate.renderOrder = RENDER_ORDER;
  plate.frustumCulled = false;

  const text = new Text();
  text.font = HUD_FONT_URL;
  text.fontSize = FONT_SIZE;
  text.lineHeight = 1.3;
  text.maxWidth = PANEL_W - PAD * 2;
  text.whiteSpace = 'nowrap';
  text.anchorX = 'left';
  text.anchorY = 'top';
  text.color = 0xe6e6e6;
  text.position.set(-PANEL_W / 2 + PAD, -PAD, 0.0005);
  const textMaterial = new MeshBasicMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  text.material = textMaterial;
  text.renderOrder = RENDER_ORDER + 1;
  text.frustumCulled = false;

  panel.add(plate, text);
  const addedCamera = camera.parent === null;
  if (addedCamera) scene.add(camera);
  camera.add(panel);

  /** The plate grows down from its top edge to fit the typeset block. */
  function fitPlate(): void {
    // A sync started before dispose() can still complete after it.
    if (disposed) return;
    const bounds = text.textRenderInfo?.blockBounds;
    if (!bounds) return;
    plate.scale.y = bounds[3] - bounds[1] + PAD * 2;
    plate.position.y = -plate.scale.y / 2;
  }

  const updater = createHudUpdater((next) => {
    text.text = next;
    text.sync(fitPlate);
  });

  function sample(): PerfHudValues {
    const gov = deps.getGovernor();
    return {
      fps: stats.fps(),
      meanMs: stats.meanMs(),
      p99Ms: stats.p99Ms(),
      gpuMs: gov?.gpuMs ?? null,
      targetHz: deps.targetHz,
      visible: deps.getVisible(),
      governor: gov && {
        level: gov.level,
        targetHz: gov.targetHz,
        densities: gov.densities,
        foveation: gov.foveation,
        fbScale: gov.fbScale,
        fbScaleApplied: gov.fbScaleApplied,
        notice: gov.notice,
      },
    };
  }

  // XR and window frames run on separate clocks, so a session change restarts the window.
  const restartStats = (): void => {
    stats.reset();
    lastFrame = null;
  };
  xr.addEventListener('sessionstart', restartStats);
  xr.addEventListener('sessionend', restartStats);

  registerDiag('frame', () => ({
    t: lastFrame,
    fps: stats.fps(),
    meanMs: stats.meanMs(),
    p99Ms: stats.p99Ms(),
  }));

  return {
    frame(time: number) {
      stats.record(time);
      lastFrame = time;
      updater.tick(time, sample);
    },
    setVisible(visible: boolean) {
      if (visible && !panel.visible) restartStats();
      panel.visible = visible;
    },
    diag: () => ({
      visible: panel.visible,
      text: text.text,
      updatedAt: updater.updatedAt,
      typeset: text.textRenderInfo !== null,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      xr.removeEventListener('sessionstart', restartStats);
      xr.removeEventListener('sessionend', restartStats);
      unregisterDiag('frame');
      panel.removeFromParent();
      if (addedCamera && camera.parent === scene) scene.remove(camera);
      textMaterial.dispose();
      text.dispose();
      plateGeometry.dispose();
      plateMaterial.dispose();
    },
  };
}
