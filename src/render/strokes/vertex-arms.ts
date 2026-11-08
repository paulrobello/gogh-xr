/**
 * The `vtx` A/B group (src/diag/ab.ts, `?ab=vtx`): live arms that separate the stroke batch's
 * vertex cost from its fill on the headset, switched with no reload and no program link.
 *
 * - `base`: the batch as shipped.
 * - `fewer`: each chunk draws `VTX_FEWER_KEEP` of its unpinned instances, the head of its
 *   importance order (the density prefix, `applyDensity` in batch.ts), and the survivors do not
 *   grow. Instances, vertex invocations and primitives all fall by about 30%, and so does the
 *   painted area, so gaps open: fewer cuts the vertex work and the fill together. A per-vertex hash
 *   test would not do this: every vertex of a dropped instance would still run, the binning pass
 *   included, and kept and dropped instances share each shader wave, so neither the invocations
 *   nor the wave's ALU would fall.
 * - `smaller`: every instance draws, each stroke scaled by `VTX_SMALLER_SCALE` on both axes through
 *   `uVtxSize`, which every other arm and material holds at 1.0 (a multiply by 1.0 is exact). The
 *   painted area falls by about 30% and the vertex work holds. Each quad also touches fewer bins.
 * - `sparse`: `fewer`'s instances, with the survivors grown by `VTX_SPARSE_SCALE` through the band
 *   size uniform (the `area` density law at 0.7 on every band, fit caps included), so the vertex
 *   work falls by 30% and the painted area about holds. The total stroke edge falls to about 0.84,
 *   so the partly covered pixel quads along the edges, and the overlap, fall with it.
 * - `hoist`: the same strokes on the `VTX_HOIST` program variant, which the group compiles before
 *   any switch (`prepare`): the projection applied as projection × (view × p), the model matrix
 *   (identity for chunk meshes) and the three varying renormalisations skipped, and the sky's rest
 *   field and wave phase read from CPU-built attributes (`skyStatic`) instead of computed per vertex.
 *   It changes pixels by float rounding, plus a sub-percent axis length under the motion turn.
 *
 * The default program carries no arm code apart from the exact multiply by `uVtxSize`. `fewer` and
 * `sparse` are CPU-side: the registered batches re-apply their draw counts and band sizes.
 */
import {
  Group,
  InstancedBufferAttribute,
  type InstancedBufferGeometry,
  Mesh,
  type Object3D,
} from 'three';
import { registerDiag } from '../../diag/diag';
import { skyOmega, skyWaveFade, skyWaveProductPhase } from '../../motion/sky-swirl';
import { motionVariants } from '../../motion/variant-uniforms';
import { PAINTER_EYE } from '../../paintings/starry-night/canvas-camera';
import type { StrokeBand } from './bands';
import { octDecode, STROKE_LAYER } from './instance';
import type { StrokeMaterial } from './material';

/** The `vtx` arms, base first. */
export const VTX_ARMS = ['base', 'fewer', 'smaller', 'sparse', 'hoist'] as const;
export type VtxArm = (typeof VTX_ARMS)[number];

/** The cut both measuring arms aim at: 30% of their target quantity. */
export const VTX_CUT = 0.3;
/** `fewer` and `sparse`: the share of each chunk's unpinned instances drawn. */
export const VTX_FEWER_KEEP = 1 - VTX_CUT;
/** `smaller`: the linear stroke scale, so the quad area falls by VTX_CUT. */
export const VTX_SMALLER_SCALE = Math.sqrt(1 - VTX_CUT);
/** `sparse`: the band size factor that keeps the painted area of `VTX_FEWER_KEEP` of the strokes. */
export const VTX_SPARSE_SCALE = 1 / Math.sqrt(VTX_FEWER_KEEP);
/** The `hoist` program variant's define on the band materials. */
export const VTX_HOIST_DEFINE = 'VTX_HOIST';
/** How long the footprint walk is reused between reads in one arm, ms: it walks every drawn stroke. */
const FOOTPRINT_TTL_MS = 1000;
/** Vertices each instanced quad submits: 4 corners, indexed as two triangles (batch.ts). */
export const VERTICES_PER_INSTANCE = 4;
/** Bytes `skyStatic` adds per instance: iSkyField (4 floats) and iSkyWave (2 floats). */
export const SKY_STATIC_BYTES = 24;

/** What the drawn strokes cover, summed over the views (batch.ts `drawnFootprint`). */
export interface Footprint {
  /** Quad area drawn, m², each stroke at its band size after its fit cap, times `uVtxSize`². */
  readonly areaM2: number;
  /** The drawn strokes' solid angle inside each view's frustum from that view's eye, sr. */
  readonly sr: number;
  /** `sr` per view, in the camera's view order: one entry on the desktop, two in XR. */
  readonly srViews: readonly number[];
}

/** What the arms read from a stroke batch (batch.ts registers each batch it builds). */
export interface VtxBatch {
  /** Re-applies every banded chunk's draw count and band size, after the keep or size changes. */
  reapplyDensity(): void;
  visibleCount(): number;
  /** Views the last cull covered: 2 for the XR ArrayCamera, 1 on the desktop. */
  views(): number;
  drawnFootprint(): Footprint;
  setDensity(band: StrokeBand, d: number): void;
  setSizeMultiplier(band: StrokeBand, m: number): void;
  readonly materials: Readonly<Record<StrokeBand, StrokeMaterial>>;
  /** Chunk geometries, which `skyStatic` attributes are added to. */
  geometries(): readonly InstancedBufferGeometry[];
}

export interface VtxDiag {
  arm: VtxArm;
  /** `fewer`'s and `sparse`'s share of unpinned instances drawn; 1 in every other arm. */
  keep: number;
  /** The arm's linear stroke scale: `smaller`'s and `sparse`'s, 1 in every other arm. */
  scale: number;
  /** True once every registered batch has its hoist program and sky attributes (`prepare`). */
  prepared: boolean;
  /** The batch materials' program variant: 'hoist' under `VTX_HOIST`, else 'base'. */
  program: 'base' | 'hoist';
  verticesPerInstance: number;
  views: number;
  /** Instances drawn after the last cull, over every registered batch. */
  instances: number;
  /** instances × verticesPerInstance × views: vertex shader invocations per frame, nominal. */
  vertexInvocations: number;
  /** Quad area drawn, m², fit caps and the arm's scale included, counted once (not per view). */
  drawnAreaM2: number;
  /**
   * The fill proxy, summed over the views like `vertexInvocations`: the drawn strokes' solid angle
   * inside each view's frustum from that view's eye, fit caps and the arm's scale included. Face-on
   * and unoccluded, without haze growth, the sky-light thin or motion: an upper bound on the
   * fragments shaded. A read within 1 s of the last one in the same arm reuses it.
   */
  drawnSr: number;
  /** `drawnSr` per view, in the camera's view order. */
  drawnSrViews: number[];
}

export interface VertexArms {
  readonly uniforms: { uVtxSize: { value: number } };
  arm(): VtxArm;
  set(arm: VtxArm): void;
  /** True once the group activated: batches then keep per-view cull matrices and prepare. */
  active(): boolean;
  /** The keep share, 1 outside `fewer` and `sparse`: batch.ts multiplies band densities by it. */
  keep(): number;
  /** `sparse`'s band size factor, 1 in every other arm: batch.ts multiplies band sizes by it. */
  sizeScale(): number;
  register(batch: VtxBatch): void;
  unregister(batch: VtxBatch): void;
  /** True while `batch` still needs `prepare`: the group is active and it has not run. */
  needsPrepare(batch: VtxBatch): boolean;
  /**
   * Builds `batch`'s sky attributes and compiles its band materials' hoist variant through
   * `compile` (renderer.compile), so no later switch links a program.
   */
  prepare(batch: VtxBatch, compile: (object: Object3D) => void): void;
  /** Registers the `vtx` diag key, once the group activates. */
  activate(): void;
  diag(): VtxDiag;
  /** Sets every registered batch's band densities and size multipliers (`__goghBands`). */
  setBands(levels: BandLevels): void;
}

/** Per-band densities and size multipliers, as the governor's levels hold them. */
export interface BandLevels {
  readonly density: Readonly<Record<StrokeBand, number>>;
  readonly size: Readonly<Record<StrokeBand, number>>;
}

/** snorm16 as WebGL normalises it. */
const snorm = (v: number): number => Math.max(-1, v / 32767);

/**
 * The `hoist` arm's per-instance sky rest field for `count` strokes (stroke.vert.glsl iSkyField,
 * iSkyWave): omega × d and omega · n, the swirl's sweep and turn per unit of tau (skyMotion in
 * motion.glsl), and the wave wrap's loop phase at `turns` waves per turn and its amplitude. Zero
 * off the sky layer. Built in float64, so it differs from the shader's float32 field by rounding.
 */
export function skyStatic(
  position: ArrayLike<number>,
  normal: ArrayLike<number>,
  meta: ArrayLike<number>,
  count: number,
  turns: number,
): { field: Float32Array; wave: Float32Array } {
  const field = new Float32Array(count * 4);
  const wave = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    if (meta[i * 4 + 1] !== STROKE_LAYER.sky) continue;
    const d: [number, number, number] = [
      position[i * 3] - PAINTER_EYE[0],
      position[i * 3 + 1] - PAINTER_EYE[1],
      position[i * 3 + 2] - PAINTER_EYE[2],
    ];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len === 0) continue;
    const dir: [number, number, number] = [d[0] / len, d[1] / len, d[2] / len];
    const w = skyOmega(dir);
    const n = octDecode(snorm(normal[i * 2]), snorm(normal[i * 2 + 1]));
    field[i * 4] = w[1] * d[2] - w[2] * d[1];
    field[i * 4 + 1] = w[2] * d[0] - w[0] * d[2];
    field[i * 4 + 2] = w[0] * d[1] - w[1] * d[0];
    field[i * 4 + 3] = w[0] * n[0] + w[1] * n[1] + w[2] * n[2];
    const phase = skyWaveProductPhase(dir, turns);
    wave[i * 2] = phase - Math.floor(phase);
    wave[i * 2 + 1] = skyWaveFade(dir);
  }
  return { field, wave };
}

/** Adds `skyStatic`'s attributes to a chunk geometry, unless it already has them. */
function addSkyStatic(geometry: InstancedBufferGeometry, turns: number): void {
  if (geometry.getAttribute('iSkyField')) return;
  const attribute = (name: string): InstancedBufferAttribute =>
    geometry.getAttribute(name) as InstancedBufferAttribute;
  // Every instance, not the draw count: a density shed draws a prefix of them.
  const { field, wave } = skyStatic(
    attribute('iPosition').array,
    attribute('iNormal').array,
    attribute('iMeta').array,
    attribute('iPosition').count,
    turns,
  );
  geometry.setAttribute('iSkyField', new InstancedBufferAttribute(field, 4));
  geometry.setAttribute('iSkyWave', new InstancedBufferAttribute(wave, 2));
}

/** Sets or clears the hoist define on `material`; true when it changed. */
function setHoist(material: StrokeMaterial, on: boolean): boolean {
  if (on === VTX_HOIST_DEFINE in material.defines) return false;
  // `undefined` would still emit `#define VTX_HOIST undefined`, so the key is deleted.
  if (on) material.defines[VTX_HOIST_DEFINE] = '';
  else delete material.defines[VTX_HOIST_DEFINE];
  material.needsUpdate = true;
  return true;
}

export function createVertexArms(): VertexArms {
  const uniforms = { uVtxSize: { value: 1 } };
  const batches = new Set<VtxBatch>();
  const prepared = new WeakSet<VtxBatch>();
  let current: VtxArm = 'base';
  let isActive = false;
  let footprint: { arm: VtxArm; views: number; t: number; value: Footprint } | null = null;
  const keep = (): number => (current === 'fewer' || current === 'sparse' ? VTX_FEWER_KEEP : 1);
  const sizeScale = (): number => (current === 'sparse' ? VTX_SPARSE_SCALE : 1);
  // A batch takes the define only once prepared: before that its chunks lack the sky attributes,
  // and the hoist program is not compiled.
  const applyHoist = (batch: VtxBatch): void => {
    const on = current === 'hoist' && prepared.has(batch);
    for (const material of Object.values(batch.materials)) setHoist(material, on);
  };
  const arms: VertexArms = {
    uniforms,
    arm: () => current,
    set(arm) {
      const before = [keep(), sizeScale()];
      current = arm;
      uniforms.uVtxSize.value = arm === 'smaller' ? VTX_SMALLER_SCALE : 1;
      for (const batch of batches) {
        applyHoist(batch);
        if (keep() !== before[0] || sizeScale() !== before[1]) batch.reapplyDensity();
      }
    },
    active: () => isActive,
    keep,
    sizeScale,
    register(batch) {
      batches.add(batch);
      applyHoist(batch);
      footprint = null;
    },
    unregister(batch) {
      batches.delete(batch);
      footprint = null;
    },
    needsPrepare: (batch) => isActive && !prepared.has(batch),
    prepare(batch, compile) {
      if (!batches.has(batch) || prepared.has(batch)) return;
      prepared.add(batch);
      const turns = motionVariants.uniforms.uWaveTurns.value;
      for (const geometry of batch.geometries()) addSkyStatic(geometry, turns);
      const [first] = batch.geometries();
      if (first) {
        const proxy = new Group();
        const materials = Object.values(batch.materials);
        for (const material of materials) proxy.add(new Mesh(first, material));
        for (const on of [true, false]) {
          for (const material of materials) setHoist(material, on);
          compile(proxy);
        }
      }
      applyHoist(batch);
    },
    activate() {
      isActive = true;
      registerDiag('vtx', () => arms.diag());
    },
    diag() {
      let instances = 0;
      let views = 1;
      let ready = true;
      let program: 'base' | 'hoist' = 'base';
      for (const batch of batches) {
        instances += batch.visibleCount();
        views = Math.max(views, batch.views());
        if (!prepared.has(batch)) ready = false;
        if (VTX_HOIST_DEFINE in batch.materials.near.defines) program = 'hoist';
      }
      const now = performance.now();
      // A view change (entering or leaving XR) invalidates it at once, like an arm switch.
      if (
        !footprint ||
        footprint.arm !== current ||
        footprint.views !== views ||
        now - footprint.t > FOOTPRINT_TTL_MS
      ) {
        let areaM2 = 0;
        let sr = 0;
        const srViews: number[] = [];
        for (const batch of batches) {
          const f = batch.drawnFootprint();
          areaM2 += f.areaM2;
          sr += f.sr;
          f.srViews.forEach((value, v) => {
            srViews[v] = (srViews[v] ?? 0) + value;
          });
        }
        footprint = { arm: current, views, t: now, value: { areaM2, sr, srViews } };
      }
      return {
        arm: current,
        keep: keep(),
        scale: uniforms.uVtxSize.value * sizeScale(),
        prepared: ready,
        program,
        verticesPerInstance: VERTICES_PER_INSTANCE,
        views,
        instances,
        vertexInvocations: instances * VERTICES_PER_INSTANCE * views,
        drawnAreaM2: footprint.value.areaM2,
        drawnSr: footprint.value.sr,
        drawnSrViews: [...footprint.value.srViews],
      };
    },
    setBands({ density, size }) {
      for (const batch of batches) {
        for (const band of Object.keys(density) as StrokeBand[]) {
          batch.setDensity(band, density[band]);
          batch.setSizeMultiplier(band, size[band]);
        }
      }
    },
  };
  return arms;
}

/** The app's arms, shared by every stroke batch (batch.ts) and the `vtx` A/B group. */
export const vertexArms: VertexArms = createVertexArms();

declare global {
  interface Window {
    /**
     * e2e builds only: sets every registered batch's band densities and size multipliers, so a
     * spec can draw a governor level on the desktop (with `?nogov`).
     */
    __goghBands?: (levels: BandLevels) => void;
    /**
     * e2e builds only: overrides `uVtxSize` until the next arm switch, so the vtx spec can show
     * its `smaller` check fails with the size factor forced to 1 (its negative control).
     */
    __goghVtxSize?: (value: number) => void;
  }
}

// The e2e build's hooks. A production build drops them: MODE is replaced at build time.
if (import.meta.env.MODE === 'e2e' && typeof window !== 'undefined') {
  window.__goghBands = (levels) => vertexArms.setBands(levels);
  window.__goghVtxSize = (value) => {
    vertexArms.uniforms.uVtxSize.value = value;
  };
}
