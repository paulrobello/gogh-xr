/**
 * `?zdiag=<mode>`: stroke depth and filtering diagnostics for the headset shimmer
 * (docs/verification.md, headset shimmer). Each mode changes one thing through three's materials,
 * textures and render order, never through raw GL state. It is honoured in production builds on
 * purpose, like `?slow` and `?nogov`: it is URL-only and affects only the page that asks for it.
 *
 * - `nowrite`: stroke materials drop depthWrite, and the chunks draw after the base meshes, back to
 *   front, so the base meshes stay underneath and nearer chunks paint over farther ones.
 * - `strokeorder`: stroke materials test depth ALWAYS with depthWrite on, drawn before the base
 *   meshes as usual, so draw order alone decides between strokes and the base meshes still test
 *   against the strokes' depth. This is the headset A/B that removed the shimmer. The chunks draw
 *   front to back, so the sky dome's chunks draw last and leave the far-plane depth almost
 *   everywhere, and the base meshes then cover every world stroke.
 * - `paintorder`: `strokeorder` with the chunks drawn back to front, so the nearest chunk's strokes
 *   draw last and the world strokes stay visible, ordered by draw order instead of depth.
 * - `nosort`: each chunk keeps the render order of the first frame it was drawn in.
 * - `noa2c`: stroke materials drop alphaToCoverage and cut the shape out at alpha 0.5 instead.
 * - `sharp`: alphaToCoverage stays on, and the coverage sharpening (ruling R3, already Golus's
 *   sharpened alpha-to-coverage) runs at twice its gain, so each edge's rim is half a pixel wide.
 * - `sharp4`: `sharp` at four times the R3 gain, a quarter-pixel rim.
 * - `nomip`: the brush atlas samples mip 0 only, with linear filtering.
 * - `mip`: the brush atlas keeps its trilinear mips and adds the GPU's largest anisotropy.
 * - `freeze`: in XR, every frame renders with the first presenting frame's camera poses and
 *   projections, both eyes, rotation included. The compositor still reprojects to the live head.
 *   Locomotion reads three's XR camera, which then holds the frozen pose too, so the rig sees a
 *   still head. On the desktop it does nothing. Run under IWER in tests/e2e/ab.spec.ts, not yet in a headset.
 *
 * The mode can change at runtime (`setMode`, the A/B button's `shimmer` and `zdiag-all` groups in
 * src/diag/ab.ts). Each switch puts the batch back on the state it was bound with, then applies
 * the new mode, so base restores the exact default materials, atlas and order.
 */
import {
  AlwaysDepth,
  type DepthModes,
  Group,
  LinearFilter,
  Mesh,
  type Object3D,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { ZdiagMode } from '../diag/flags';
import { DEFAULT_ORDER_POLICY, type StrokeBatch, type StrokeOrderPolicy } from './strokes/batch';
import type { StrokeMaterial } from './strokes/material';

/** Render order base of the strokes under `nowrite`: above BASE_MESH_RENDER_ORDER (1e6). */
export const ZDIAG_STROKES_AFTER_BASE = 2_000_000;

/** The defines a mode adds; every other mode shares the default program. */
const ZDIAG_DEFINES = ['ZDIAG_ALPHA_TEST', 'ZDIAG_SHARP_GAIN'] as const;

/** The stroke state a mode sets, read back from the bound batch. */
export interface ZdiagState {
  readonly depthWrite: boolean;
  readonly depthFunc: number;
  readonly alphaToCoverage: boolean;
  /** `ZDIAG_ALPHA_TEST` is defined. */
  readonly alphaTest: boolean;
  /** `ZDIAG_SHARP_GAIN`, or null when undefined. */
  readonly sharpGain: number | null;
  readonly order: StrokeOrderPolicy;
  readonly atlas: { minFilter: number; generateMipmaps: boolean; anisotropy: number };
}

export interface ZdiagDiag {
  readonly mode: ZdiagMode | null;
  /** True while the mode is applied to a stroke batch (every mode but `freeze`). */
  readonly applied: boolean;
  /** `freeze` only: true once an XR frame's poses are locked. */
  readonly frozen: boolean;
  /** null until a batch binds. */
  readonly state: ZdiagState | null;
  /** Programs `prepare` compiled ahead of their first draw. */
  readonly precompiled: number;
  /** Milliseconds the last precompile took; null before one ran. */
  readonly precompileMs: number | null;
}

export interface Zdiag {
  /**
   * Binds `batch`, keeping its current state as the default, and applies the mode to it. One batch
   * is bound at a time: a rebind (a world switch) replaces the last one, which keeps its state.
   */
  applyToBatch(batch: StrokeBatch): void;
  /** Switches the mode, null being none, on the bound batch and on any bound later. */
  setMode(mode: ZdiagMode | null): void;
  /**
   * Compiles these modes' programs ahead of their first draw, on the bound batch and on any bound
   * later. Needs the `compile` callback.
   */
  prepare(modes: readonly (ZdiagMode | null)[]): void;
  /** Call right before `renderer.render` every frame; only `freeze` does anything. */
  beforeRender(camera: PerspectiveCamera): void;
  diag(): ZdiagDiag;
}

interface FrozenPose {
  readonly matrixWorld: number[];
  readonly matrixWorldInverse: number[];
  readonly projectionMatrix: number[];
  readonly projectionMatrixInverse: number[];
}

interface MaterialDefaults {
  readonly material: StrokeMaterial;
  readonly depthWrite: boolean;
  readonly depthFunc: DepthModes;
  readonly alphaToCoverage: boolean;
}

interface Bound {
  readonly batch: StrokeBatch;
  readonly materials: readonly MaterialDefaults[];
  readonly atlas: Texture;
  readonly minFilter: number;
  readonly generateMipmaps: boolean;
  readonly anisotropy: number;
  order: StrokeOrderPolicy;
}

function programDefines(
  mode: ZdiagMode | null,
): Partial<Record<(typeof ZDIAG_DEFINES)[number], number>> {
  if (mode === 'noa2c') return { ZDIAG_ALPHA_TEST: 1 };
  if (mode === 'sharp') return { ZDIAG_SHARP_GAIN: 2 };
  if (mode === 'sharp4') return { ZDIAG_SHARP_GAIN: 4 };
  return {};
}

/** A mode's program, as a key: modes with the same key share one. */
function programKey(mode: ZdiagMode | null): string {
  return JSON.stringify(programDefines(mode));
}

/** Sets the mode's defines on `material`, deleting the others, so base keeps base's cache key. */
function setDefines(material: StrokeMaterial, mode: ZdiagMode | null): void {
  const want = programDefines(mode);
  let changed = false;
  for (const name of ZDIAG_DEFINES) {
    const value = want[name];
    if (value !== undefined) {
      if (material.defines[name] !== value) {
        material.defines[name] = value;
        changed = true;
      }
    } else if (name in material.defines) {
      // `undefined` would still emit `#define NAME undefined`, and change the cache key.
      delete material.defines[name];
      changed = true;
    }
  }
  if (changed) material.needsUpdate = true;
}

function orderFor(mode: ZdiagMode | null): StrokeOrderPolicy {
  if (mode === 'nowrite') return { base: ZDIAG_STROKES_AFTER_BASE, reverse: true, freeze: false };
  if (mode === 'paintorder') return { base: 0, reverse: true, freeze: false };
  if (mode === 'nosort') return { base: 0, reverse: false, freeze: true };
  return DEFAULT_ORDER_POLICY;
}

function samePolicy(a: StrokeOrderPolicy, b: StrokeOrderPolicy): boolean {
  return a.base === b.base && a.reverse === b.reverse && a.freeze === b.freeze;
}

/**
 * `compile` precompiles an object's materials, as `renderer.compile(object, camera, scene)` does.
 * A raw shader's program depends only on its shaders and defines, so a desktop compile serves XR.
 */
export function createZdiag(
  initial: ZdiagMode | null,
  renderer: WebGLRenderer,
  compile?: (object: Object3D) => void,
): Zdiag {
  let mode = initial;
  let frozen: FrozenPose[] | null = null;
  let bound: Bound | null = null;
  let prepared: (ZdiagMode | null)[] = [];
  let precompiled = 0;
  let precompileMs: number | null = null;
  // three then leaves the XR camera alone inside render, and beforeRender updates it instead.
  if (mode === 'freeze') renderer.xr.cameraAutoUpdate = false;

  /** Writes only what differs from the target, so an unchanged mode touches nothing. */
  function apply(entry: Bound): void {
    for (const defaults of entry.materials) {
      const { material } = defaults;
      const depthWrite = mode === 'nowrite' ? false : defaults.depthWrite;
      const depthFunc =
        mode === 'strokeorder' || mode === 'paintorder' ? AlwaysDepth : defaults.depthFunc;
      const alphaToCoverage = mode === 'noa2c' ? false : defaults.alphaToCoverage;
      if (material.depthWrite !== depthWrite) material.depthWrite = depthWrite;
      if (material.depthFunc !== depthFunc) material.depthFunc = depthFunc;
      if (material.alphaToCoverage !== alphaToCoverage) {
        material.alphaToCoverage = alphaToCoverage;
        material.needsUpdate = true;
      }
      setDefines(material, mode);
    }
    const order = orderFor(mode);
    if (!samePolicy(order, entry.order)) {
      entry.batch.setOrderPolicy(order);
      entry.order = order;
    }
    const { atlas } = entry;
    const minFilter = mode === 'nomip' ? LinearFilter : entry.minFilter;
    const generateMipmaps = mode === 'nomip' ? false : entry.generateMipmaps;
    const anisotropy = mode === 'mip' ? renderer.capabilities.getMaxAnisotropy() : entry.anisotropy;
    if (
      atlas.minFilter !== minFilter ||
      atlas.generateMipmaps !== generateMipmaps ||
      atlas.anisotropy !== anisotropy
    ) {
      atlas.minFilter = minFilter as Texture['minFilter'];
      atlas.generateMipmaps = generateMipmaps;
      atlas.anisotropy = anisotropy;
      atlas.needsUpdate = true;
    }
  }

  /**
   * Compiles each distinct program among `prepared` on a stand-in group, one mesh per band
   * material on the first chunk's geometry, so every band has it whatever its chunks draw now.
   */
  function precompile(entry: Bound): void {
    if (!compile || prepared.length === 0) return;
    const geometry = entry.batch.chunks[0]?.geometry;
    if (!geometry) return;
    const start = performance.now();
    const proxy = new Group();
    for (const { material } of entry.materials) proxy.add(new Mesh(geometry, material));
    const seen = new Set<string>();
    for (const target of prepared) {
      const key = programKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const { material } of entry.materials) setDefines(material, target);
      compile(proxy);
      precompiled += 1;
    }
    for (const { material } of entry.materials) setDefines(material, mode);
    precompileMs = performance.now() - start;
  }

  return {
    applyToBatch(batch) {
      const { atlas } = batch;
      const entry: Bound = {
        batch,
        materials: Object.values(batch.materials).map((material) => ({
          material,
          depthWrite: material.depthWrite,
          depthFunc: material.depthFunc,
          alphaToCoverage: material.alphaToCoverage,
        })),
        atlas,
        minFilter: atlas.minFilter,
        generateMipmaps: atlas.generateMipmaps,
        anisotropy: atlas.anisotropy,
        order: DEFAULT_ORDER_POLICY,
      };
      bound = entry;
      apply(entry);
      precompile(entry);
    },
    setMode(next) {
      if (next === mode) return;
      if (mode === 'freeze') {
        renderer.xr.cameraAutoUpdate = true;
        frozen = null;
      }
      mode = next;
      if (mode === 'freeze') renderer.xr.cameraAutoUpdate = false;
      if (bound) apply(bound);
    },
    prepare(modes) {
      prepared = [...modes];
      if (bound) precompile(bound);
    },
    beforeRender(camera) {
      if (mode !== 'freeze') return;
      if (!renderer.xr.isPresenting) {
        // The session ended: the next one freezes its own first frame.
        frozen = null;
        return;
      }
      renderer.xr.updateCamera(camera);
      const xrCamera = renderer.xr.getCamera();
      const views = [xrCamera, ...xrCamera.cameras];
      if (frozen === null || frozen.length !== views.length) {
        frozen = views.map((view) => ({
          matrixWorld: view.matrixWorld.toArray(),
          matrixWorldInverse: view.matrixWorldInverse.toArray(),
          projectionMatrix: view.projectionMatrix.toArray(),
          projectionMatrixInverse: view.projectionMatrixInverse.toArray(),
        }));
        return;
      }
      const poses = frozen;
      views.forEach((view, i) => {
        view.matrixWorld.fromArray(poses[i].matrixWorld);
        view.matrixWorldInverse.fromArray(poses[i].matrixWorldInverse);
        view.projectionMatrix.fromArray(poses[i].projectionMatrix);
        view.projectionMatrixInverse.fromArray(poses[i].projectionMatrixInverse);
      });
    },
    diag() {
      const entry = bound;
      const material = entry?.materials[0]?.material;
      const state: ZdiagState | null =
        entry && material
          ? {
              depthWrite: material.depthWrite,
              depthFunc: material.depthFunc,
              alphaToCoverage: material.alphaToCoverage,
              alphaTest: 'ZDIAG_ALPHA_TEST' in material.defines,
              sharpGain: (material.defines.ZDIAG_SHARP_GAIN as number | undefined) ?? null,
              order: { ...entry.order },
              atlas: {
                minFilter: entry.atlas.minFilter,
                generateMipmaps: entry.atlas.generateMipmaps,
                anisotropy: entry.atlas.anisotropy,
              },
            }
          : null;
      return {
        mode,
        applied: bound !== null && mode !== null && mode !== 'freeze',
        frozen: frozen !== null,
        state,
        precompiled,
        precompileMs,
      };
    },
  };
}
