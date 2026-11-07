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
 * - `nomip`: the brush atlas samples mip 0 only, with linear filtering.
 * - `mip`: the brush atlas keeps its trilinear mips and adds the GPU's largest anisotropy.
 * - `freeze`: in XR, every frame renders with the first presenting frame's camera poses and
 *   projections, both eyes, rotation included. The compositor still reprojects to the live head.
 *   Locomotion reads three's XR camera, which then holds the frozen pose too, so the rig sees a
 *   still head. On the desktop it does nothing. Not yet run in a headset or IWER.
 */
import { AlwaysDepth, LinearFilter, type PerspectiveCamera, type WebGLRenderer } from 'three';
import type { ZdiagMode } from '../diag/flags';
import type { StrokeBatch } from './strokes/batch';

/** Render order base of the strokes under `nowrite`: above BASE_MESH_RENDER_ORDER (1e6). */
export const ZDIAG_STROKES_AFTER_BASE = 2_000_000;

export interface ZdiagDiag {
  readonly mode: ZdiagMode | null;
  /** True once the mode is applied to a stroke batch (every mode but `freeze`). */
  readonly applied: boolean;
  /** `freeze` only: true once an XR frame's poses are locked. */
  readonly frozen: boolean;
}

export interface Zdiag {
  /** Applies the mode to `batch`'s materials, atlas and render order. */
  applyToBatch(batch: StrokeBatch): void;
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

export function createZdiag(mode: ZdiagMode | null, renderer: WebGLRenderer): Zdiag {
  let applied = false;
  let frozen: FrozenPose[] | null = null;
  // three then leaves the XR camera alone inside render, and beforeRender updates it instead.
  if (mode === 'freeze') renderer.xr.cameraAutoUpdate = false;

  return {
    applyToBatch(batch) {
      if (mode === null || mode === 'freeze') return;
      for (const material of Object.values(batch.materials)) {
        if (mode === 'nowrite') material.depthWrite = false;
        if (mode === 'strokeorder' || mode === 'paintorder') material.depthFunc = AlwaysDepth;
        if (mode === 'noa2c') {
          material.alphaToCoverage = false;
          material.defines.ZDIAG_ALPHA_TEST = 1;
          material.needsUpdate = true;
        }
      }
      if (mode === 'nowrite') {
        batch.setOrderPolicy({ base: ZDIAG_STROKES_AFTER_BASE, reverse: true, freeze: false });
      }
      if (mode === 'paintorder') batch.setOrderPolicy({ base: 0, reverse: true, freeze: false });
      if (mode === 'nosort') batch.setOrderPolicy({ base: 0, reverse: false, freeze: true });
      if (mode === 'nomip') {
        batch.atlas.minFilter = LinearFilter;
        batch.atlas.generateMipmaps = false;
        batch.atlas.needsUpdate = true;
      }
      if (mode === 'mip') {
        batch.atlas.anisotropy = renderer.capabilities.getMaxAnisotropy();
        batch.atlas.needsUpdate = true;
      }
      applied = true;
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
      return { mode, applied, frozen: frozen !== null };
    },
  };
}
