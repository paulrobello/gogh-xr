import type { XrState } from '../xr/session';

export type DiagProvider = () => unknown;

export interface DiagRenderer {
  info: {
    render: { calls: number; triangles: number; points: number; lines: number; frame: number };
    memory: { geometries: number; textures: number };
    programs?: readonly unknown[] | null;
  };
  getContext(): {
    getExtension(name: string): unknown;
    getParameter(pname: number): unknown;
  };
  xr: { isPresenting: boolean; getFoveation?: () => number | undefined };
}

export interface DiagCamera {
  position: { toArray(): number[] };
  quaternion: { toArray(): number[] };
}

export interface DiagDeps {
  build: string;
  renderer: DiagRenderer;
  camera: DiagCamera;
  getXrState: () => XrState;
  /** The frame rate the app requests of an XR session (`?hz`, `?beauty`); null when unknown. */
  targetFrameRate?: number;
}

declare global {
  interface Window {
    __goghDiag?: () => Record<string, unknown>;
    __goghShot?: () => string;
    __goghPose?: (x: number, y: number, z: number, yaw: number, pitch: number) => void;
    /** e2e builds only: `predictSkyShift` (src/diag/swirl-probe.ts). */
    __goghSkyShift?: (
      u: number,
      vDown: number,
      calm: number,
      time: number,
      phase: number,
    ) => [number, number] | null;
  }
}

const BUILTIN_KEYS: ReadonlySet<string> = new Set(['build', 'renderer', 'xr', 'camera']);
const providers = new Map<string, DiagProvider>();

export function registerDiag(key: string, provider: DiagProvider): void {
  if (BUILTIN_KEYS.has(key)) throw new Error(`diag key "${key}" is reserved`);
  providers.set(key, provider);
}

export function unregisterDiag(key: string): void {
  providers.delete(key);
}

function unmaskedRenderer(renderer: DiagRenderer): string | null {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info') as {
    UNMASKED_RENDERER_WEBGL: number;
  } | null;
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
}

function collectRegistered(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, provider] of providers) {
    try {
      out[key] = provider();
    } catch (error) {
      out[key] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return out;
}

export function buildDiagPayload(deps: DiagDeps): Record<string, unknown> {
  const { renderer, camera } = deps;
  const { render, memory, programs } = renderer.info;
  const xr = deps.getXrState();
  return {
    build: deps.build,
    renderer: {
      calls: render.calls,
      triangles: render.triangles,
      points: render.points,
      lines: render.lines,
      frame: render.frame,
      geometries: memory.geometries,
      textures: memory.textures,
      programs: programs ? programs.length : 0,
      unmaskedRenderer: unmaskedRenderer(renderer),
    },
    xr: {
      supported: xr.supported,
      presenting: renderer.xr.isPresenting,
      sessionMode: xr.sessionMode,
      frameRate: xr.frameRate,
      targetFrameRate: deps.targetFrameRate ?? null,
      supportedFrameRates: xr.supportedFrameRates,
      foveation: renderer.xr.getFoveation?.() ?? null,
    },
    camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() },
    ...collectRegistered(),
  };
}

export function installDiag(deps: DiagDeps): void {
  window.__goghDiag = () => buildDiagPayload(deps);
}

export function installShot(canvas: HTMLCanvasElement, renderNow: () => void): void {
  window.__goghShot = () => {
    renderNow();
    return canvas.toDataURL('image/png');
  };
}

/** `window.__goghPose(x, y, z, yaw, pitch)`: puts the desktop eye there, for the coverage sweep. */
export function installPose(
  setPose: (x: number, y: number, z: number, yaw: number, pitch: number) => void,
): void {
  window.__goghPose = setPose;
}
