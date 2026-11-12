/**
 * The `fill` A/B group (src/diag/ab.ts, `?ab=fill`): live arms that aim at the stroke batch's
 * fragment cost on the headset with the same look, switched with no reload and no program link.
 * docs/verification.md (fill arms) has the per-path op counts.
 *
 * - `base`: the batch as shipped.
 * - `domenowrite`: the `dome` draw class stops writing depth while it draws (render state, no
 *   program), the dome as it shipped before 2026-11-12. The batch's dome writes depth
 *   (DOME_DEPTH_WRITE, batch.ts) since the `domewrite` arm of this group measured about 5 ms a
 *   frame on the headset and Paul saw no change in the look, so this arm is the old default.
 * - `nostream`: `FILL_NOSTREAM` compiles the stream wrap's tone out. At every wrap but `stream`
 *   no stroke streams, so it draws byte for byte as base, and it shows whether the compiler
 *   flattened the branch into a select that pays the stream's two taps on every fragment.
 *   Under `?wrap=stream` the paint stops streaming.
 * - `shade3`: `FILL_SHADE3` moves the moonlight dots into the vertex shader: three flat floats,
 *   N·m, L·m and S·m, replace the nine of vNormal, vLong and vShort, and the fragment's normalize
 *   becomes one inversesqrt (`moonPacked`). The frame is orthonormal, so it changes pixels by
 *   float rounding only.
 * - `mediump`: `FILL_MEDIUMP` makes the fragment shader's locals mediump; every declaration
 *   (the uv, the rect, the uniforms) stays highp, so the tap coordinates keep their precision.
 *   Desktop GPUs run mediump as highp, so a desktop capture cannot see its look.
 * - `lean`: `nostream`, `shade3` and `mediump` together.
 *
 * The default program carries no arm code: every arm is an `#ifdef` block in the shaders, and the
 * defines are absent outside the arms.
 */
import { Group, type InstancedBufferGeometry, Mesh, type Object3D } from 'three';
import { registerDiag } from '../../diag/diag';
import type { StrokeBand } from './bands';
import type { StrokeMaterial } from './material';

/** The `fill` arms, base first. */
export const FILL_ARMS = ['base', 'domenowrite', 'nostream', 'shade3', 'mediump', 'lean'] as const;
export type FillArm = (typeof FILL_ARMS)[number];

export const FILL_NOSTREAM = 'FILL_NOSTREAM';
export const FILL_SHADE3 = 'FILL_SHADE3';
export const FILL_MEDIUMP = 'FILL_MEDIUMP';
/** Every define the arms set, in a fixed order. */
export const FILL_DEFINES = [FILL_NOSTREAM, FILL_SHADE3, FILL_MEDIUMP] as const;

/** Each arm's program defines. */
export const FILL_ARM_DEFINES: Readonly<Record<FillArm, readonly string[]>> = {
  base: [],
  domenowrite: [],
  nostream: [FILL_NOSTREAM],
  shade3: [FILL_SHADE3],
  mediump: [FILL_MEDIUMP],
  lean: [...FILL_DEFINES],
};

/** The distinct define sets, base's empty set first: one program each. */
export const FILL_PROGRAMS: readonly (readonly string[])[] = (() => {
  const seen = new Set<string>();
  const sets: (readonly string[])[] = [];
  for (const arm of FILL_ARMS) {
    const key = FILL_ARM_DEFINES[arm].join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    sets.push(FILL_ARM_DEFINES[arm]);
  }
  return sets;
})();

/** What the arms read from a stroke batch (batch.ts registers each batch it builds). */
export interface FillBatch {
  readonly materials: Readonly<Record<StrokeBand, StrokeMaterial>>;
  /** Chunk geometries; the first is the proxy geometry `prepare` compiles with. */
  geometries(): readonly InstancedBufferGeometry[];
  /** Turns depth writes on (true) or back off for the dome chunks' own draws. */
  setDomeDepthWrite(on: boolean): void;
}

export interface FillDiag {
  arm: FillArm;
  /** The FILL_* defines on the batch materials. */
  defines: string[];
  domeWrite: boolean;
  /** True once every registered batch has compiled every arm's program. */
  prepared: boolean;
}

export interface FillArms {
  arm(): FillArm;
  set(arm: FillArm): void;
  active(): boolean;
  register(batch: FillBatch): void;
  unregister(batch: FillBatch): void;
  /** True while `batch` still needs `prepare`: the group is active and it has not run. */
  needsPrepare(batch: FillBatch): boolean;
  /** Compiles every arm's program on `batch`'s band materials, so no later switch links one. */
  prepare(batch: FillBatch, compile: (object: Object3D) => void): void;
  /** Registers the `fill` diag key, once the group activates. */
  activate(): void;
  diag(): FillDiag;
}

/** Sets `material`'s FILL_* defines to exactly `defines`; true when that changed them. */
export function setFillDefines(material: StrokeMaterial, defines: readonly string[]): boolean {
  let changed = false;
  for (const name of FILL_DEFINES) {
    const on = defines.includes(name);
    if (on === name in material.defines) continue;
    // `undefined` would still emit `#define NAME undefined`, so the key is deleted.
    if (on) material.defines[name] = '';
    else delete material.defines[name];
    changed = true;
  }
  if (changed) material.needsUpdate = true;
  return changed;
}

/**
 * Whether the dome writes depth under `arm`: every arm but `domenowrite` keeps the batch's dome
 * depth writes on. This assumes DOME_DEPTH_WRITE (batch.ts, which imports this module) is true,
 * which tests/strokes-fill-arms.test.ts pins.
 */
export function domeWriteFor(arm: FillArm): boolean {
  return arm !== 'domenowrite';
}

export function createFillArms(): FillArms {
  const batches = new Set<FillBatch>();
  const prepared = new WeakSet<FillBatch>();
  let current: FillArm = 'base';
  let isActive = false;
  // A batch takes an arm's defines only once prepared, so a switch never links a program.
  const apply = (batch: FillBatch): void => {
    const defines = prepared.has(batch) ? FILL_ARM_DEFINES[current] : [];
    for (const material of Object.values(batch.materials)) setFillDefines(material, defines);
    batch.setDomeDepthWrite(domeWriteFor(current));
  };
  const arms: FillArms = {
    arm: () => current,
    set(arm) {
      current = arm;
      for (const batch of batches) apply(batch);
    },
    active: () => isActive,
    register(batch) {
      batches.add(batch);
      if (isActive) apply(batch);
    },
    unregister(batch) {
      batches.delete(batch);
    },
    needsPrepare: (batch) => isActive && !prepared.has(batch),
    prepare(batch, compile) {
      if (!batches.has(batch) || prepared.has(batch)) return;
      prepared.add(batch);
      const [first] = batch.geometries();
      if (first) {
        const proxy = new Group();
        const materials = Object.values(batch.materials);
        for (const material of materials) proxy.add(new Mesh(first, material));
        // Base last, so the materials end where `apply` expects to find them.
        for (const defines of [...FILL_PROGRAMS.slice(1), FILL_PROGRAMS[0]]) {
          for (const material of materials) setFillDefines(material, defines);
          compile(proxy);
        }
      }
      apply(batch);
    },
    activate() {
      isActive = true;
      for (const batch of batches) apply(batch);
      registerDiag('fill', () => arms.diag());
    },
    diag() {
      let ready = true;
      let defines: string[] = [];
      for (const batch of batches) {
        if (!prepared.has(batch)) ready = false;
        defines = FILL_DEFINES.filter((name) => name in batch.materials.near.defines);
      }
      return { arm: current, defines, domeWrite: domeWriteFor(current), prepared: ready };
    },
  };
  return arms;
}

/** The app's arms, shared by every stroke batch (batch.ts) and the `fill` A/B group. */
export const fillArms: FillArms = createFillArms();

type Vec3 = readonly [number, number, number];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * stroke.frag.glsl's moonlight term `dot(n, m)` as base computes it: n the normalized normal
 * tilted by the relief slope along the stroke's long and short axes.
 */
export function moonNormalized(
  normal: Vec3,
  long: Vec3,
  short: Vec3,
  moon: Vec3,
  relief: number,
  slope: readonly [number, number],
): number {
  const v: Vec3 = [0, 1, 2].map(
    (k) => normal[k] - relief * (slope[0] * long[k] + slope[1] * short[k]),
  ) as unknown as Vec3;
  return dot(v, moon) / Math.sqrt(dot(v, v));
}

/**
 * `FILL_SHADE3`'s closed form of `moonNormalized` from the three flat dots N·m, L·m and S·m: for
 * an orthonormal frame |N − r(sx L + sy S)|² = 1 + r²(sx² + sy²).
 */
export function moonPacked(dots: Vec3, relief: number, slope: readonly [number, number]): number {
  const [nm, lm, sm] = dots;
  const tilt = relief * (slope[0] * lm + slope[1] * sm);
  return (nm - tilt) / Math.sqrt(1 + relief * relief * (slope[0] ** 2 + slope[1] ** 2));
}
