import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three';
import type { BenchMode, BenchOrder } from '../diag/flags';

export const HUD_INTERVAL_MS = 250;
const CANVAS_W = 640;
/** Room for the six live lines, a heading and six recorded results. */
const CANVAS_H = 340;
const LINE_H = 25;
const PLANE_W = 0.42;

export interface BenchSnapshot {
  readonly n: number;
  readonly mode: BenchMode;
  readonly order: BenchOrder;
  readonly sizePx: number;
  /** Eye viewport in device pixels, for converting size to degrees. */
  readonly viewport: { readonly width: number; readonly height: number } | null;
  readonly chunks: number;
  readonly instances: number;
  readonly fps: number;
  readonly meanMs: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  /** True while the frame window refills after start or an N change. */
  readonly settling: boolean;
  readonly gpuTimer: 'available' | 'unavailable';
  readonly gpuMs: number | null;
}

export interface HudRates {
  readonly target: number;
  readonly current: number | null;
  readonly supported: readonly number[] | null;
}

function ms(value: number | null): string {
  return value === null ? '--' : value.toFixed(2);
}

export function formatHudLines(snap: BenchSnapshot, rates: HudRates): string[] {
  const gpu =
    snap.gpuTimer === 'unavailable'
      ? 'GPU timer: unavailable'
      : `GPU ${snap.gpuMs === null ? 'pending' : `${snap.gpuMs.toFixed(2)} ms`}`;
  const supported = rates.supported?.length ? rates.supported.join('/') : 'n/a';
  const eye = snap.viewport ? `${snap.viewport.width}x${snap.viewport.height}` : 'n/a';
  return [
    `N ${snap.n.toLocaleString('en-US')}  mode ${snap.mode}  order ${snap.order}  size ${snap.sizePx}px`,
    `chunks ${snap.chunks}  instances ${snap.instances.toLocaleString('en-US')}  eye ${eye}`,
    `FPS ${snap.fps}  mean ${ms(snap.meanMs)}  p95 ${ms(snap.p95Ms)}  p99 ${ms(snap.p99Ms)} ms${snap.settling ? '  settling' : ''}`,
    `target ${rates.target} Hz  current ${rates.current ?? 'n/a'}  supported ${supported}`,
    gpu,
    'stick: N +/- 25k  X: mode  Y: target Hz',
  ];
}

export interface BenchHud {
  readonly mesh: Mesh;
  draw(lines: readonly string[]): void;
  dispose(): void;
}

/** Head-locked text panel: a CanvasTexture on a plane parented to the camera. */
export function createHud(parent: Object3D): BenchHud {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const geometry = new PlaneGeometry(PLANE_W, (PLANE_W * CANVAS_H) / CANVAS_W);
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'bench-hud';
  // Below the eye line, tilted up to face the eye, so the strokes ahead stay unobstructed.
  mesh.position.set(-0.08, -0.15, -0.6);
  mesh.rotation.x = Math.atan2(0.15, 0.6);
  mesh.renderOrder = 1_000_000;
  mesh.frustumCulled = false;
  parent.add(mesh);

  function draw(lines: readonly string[]): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = 'rgba(8, 12, 24, 0.78)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#e6e6e6';
    ctx.font = '18px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.fillText(line, 12, 8 + i * LINE_H);
    });
    texture.needsUpdate = true;
  }

  return {
    mesh,
    draw,
    dispose: () => {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
