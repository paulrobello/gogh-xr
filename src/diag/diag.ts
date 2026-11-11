import type { SkyWrap } from '../motion/variants';
import type { XrState } from '../xr/session';
import type { RingShift } from './swirl-probe';

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
      wrap?: SkyWrap,
      turns?: number,
      river?: { omega: [number, number, number]; phase: number },
    ) => [number, number] | null;
    /** e2e builds only: `riverHeading` (src/diag/swirl-probe.ts). */
    __goghRiverHeading?: (
      u: number,
      vDown: number,
      width: number,
      height: number,
    ) => { heading: [number, number]; member: boolean } | null;
    /** e2e builds only: `predictRingShift` (src/diag/swirl-probe.ts). */
    __goghRingShift?: (k: number, u: number, vDown: number, time: number) => RingShift | null;
    /** e2e builds only: `predictHaloGlow` (src/diag/swirl-probe.ts). */
    __goghHaloGlow?: (k: number, u: number, vDown: number, time: number) => number | null;
    /** e2e builds only: `moonDiscRim` (src/diag/swirl-probe.ts). */
    __goghMoonDisc?: (points: number) => [number, number][] | null;
    /** e2e builds only, with `?motiont`: moves the pinned motion time to `t` seconds (main.ts). */
    __goghMotionT?: (t: number) => void;
    /** Starts a portal transition to world `id` (P5.5); false while one runs. `?diag` only. */
    __goghPortal?: (id: string) => boolean;
    /** e2e builds only, with `?diag`: the portal veil at `alpha` while no transition runs. */
    __goghVeil?: (alpha: number) => void;
    __goghSkyControl?: (mode: 'sky' | 'hidden' | 'black') => void;
  }
}

const BUILTIN_KEYS: ReadonlySet<string> = new Set(['build', 'renderer', 'xr', 'camera']);
/** One registration of a key, as `registerDiag` returns it, for `unregisterDiag` to name. */
export interface DiagToken {
  readonly provider: DiagProvider;
}

/** Each key's registrations, oldest first: the newest one answers. */
const providers = new Map<string, DiagToken[]>();

/** Registers `provider` under `key`, over any earlier registration, until it is unregistered. */
export function registerDiag(key: string, provider: DiagProvider): DiagToken {
  if (BUILTIN_KEYS.has(key)) throw new Error(`diag key "${key}" is reserved`);
  const token: DiagToken = { provider };
  const stack = providers.get(key);
  if (stack) stack.push(token);
  else providers.set(key, [token]);
  return token;
}

/**
 * With `token`, removes only that registration, so the one under it answers again: a world built
 * late and disposed at once cannot take the live world's key with it. Without, removes the key.
 */
export function unregisterDiag(key: string, token?: DiagToken): void {
  if (!token) {
    providers.delete(key);
    return;
  }
  const stack = providers.get(key);
  const at = stack ? stack.indexOf(token) : -1;
  if (!stack || at < 0) return;
  stack.splice(at, 1);
  if (stack.length === 0) providers.delete(key);
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
  for (const [key, stack] of providers) {
    const provider = stack[stack.length - 1].provider;
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
