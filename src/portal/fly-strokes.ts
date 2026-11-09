/**
 * The portal's flying strokes (P5.5): one transitional instanced mesh of `FLY_COUNT` stroke quads
 * on the stroke engine's own material and the shared brush atlas. They lift off the painting's
 * frame, coloured from its scan, and fly out to sampled strokes of the new world, taking those
 * strokes' colours and sizes, then hide as the world shows; a return runs the other way.
 *
 * While the next world builds the strokes swirl about where they hover (wait-motion.ts). The
 * swirl's offset is weighed in with each stroke's own progress: in by its progress on the way out,
 * so it starts from rest at liftoff, whole while waiting, and out by its progress on the way in, so
 * the `in` leg starts exactly where the stroke is, however long the wait was.
 *
 * The fade style's pulse field uses the same mesh with its own count and name (`portal-cue`).
 *
 * The mesh is parented to the rig, so its instances are rig-local and ride along when the rig jumps
 * into the new world. It draws over everything (no depth test), above the vignette's veil and
 * below the perf HUD. Hidden, it costs no draw call; it is built on the first transition only.
 */
import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  IntType,
  Mesh,
  NoBlending,
  type Object3D,
  type Texture,
} from 'three';
import { BRUSHES } from '../render/strokes/brush-atlas-data';
import {
  createStrokeBuffers,
  octEncode,
  STROKE_ATTRIBUTES,
  STROKE_LAYER,
} from '../render/strokes/instance';
import { createStrokeMaterial, type StrokeMaterial } from '../render/strokes/material';
import { createTieKeyAttribute } from '../render/strokes/tie-key';
import { ease } from './transition';

/** Strokes in flight: a few thousand, one draw per view. */
export const FLY_COUNT = 3000;
/** Above the vignette (999,000) and below the perf HUD. */
export const FLY_RENDER_ORDER = 999_500;
/** How far apart in time the strokes start: a share of the phase. */
const STAGGER = 0.35;

/** One phase's flight, all arrays rig-local and `FLY_COUNT` long. */
export interface FlightLeg {
  /** xyz per stroke. */
  readonly from: Float32Array;
  readonly to: Float32Array;
  /** sRGB bytes, rgb per stroke. */
  readonly fromColor: Uint8Array;
  readonly toColor: Uint8Array;
  /** Quad length and width per stroke, metres. */
  readonly fromSize: Float32Array;
  readonly toSize: Float32Array;
  /** Height of the flight's arc above the straight line, metres per stroke. */
  readonly arc: Float32Array;
}

export function createLeg(): FlightLeg {
  return {
    from: new Float32Array(FLY_COUNT * 3),
    to: new Float32Array(FLY_COUNT * 3),
    fromColor: new Uint8Array(FLY_COUNT * 3),
    toColor: new Uint8Array(FLY_COUNT * 3),
    fromSize: new Float32Array(FLY_COUNT * 2),
    toSize: new Float32Array(FLY_COUNT * 2),
    arc: new Float32Array(FLY_COUNT),
  };
}

/** How a leg weighs the swirl's offsets: in by its progress (`arrive`) or out by it (`leave`). */
export type DriftWeight = 'arrive' | 'leave';

/** Stroke `i`'s eased progress at `t` (0-1) along a leg: each starts a little after the last. */
export function legProgress(i: number, t: number): number {
  const delay = (STAGGER * ((i * 2654435761) % 1000)) / 1000;
  return ease((t - delay) / (1 - STAGGER));
}

/**
 * Every stroke at `t` along `leg` into `positions`, `colors` (rgb bytes) and `sizes`, shrunk away
 * by `fade` (0 keeps its size). With `drift`, each stroke also moves by its offset there, xyz per
 * stroke, weighed by its progress `k` (`arrive`) or by `1 − k` (`leave`).
 */
export function flightFrame(
  leg: FlightLeg,
  t: number,
  fade: number,
  drift: Float32Array | null,
  weight: DriftWeight,
  positions: Float32Array,
  colors: Uint8Array,
  sizes: Float32Array,
): void {
  const grow = 1 - Math.min(1, Math.max(0, fade));
  for (let i = 0; i < FLY_COUNT; i++) {
    const k = legProgress(i, t);
    const lift = Math.sin(Math.PI * k) * leg.arc[i];
    const i3 = i * 3;
    let x = leg.from[i3] + (leg.to[i3] - leg.from[i3]) * k;
    let y = leg.from[i3 + 1] + (leg.to[i3 + 1] - leg.from[i3 + 1]) * k + lift;
    let z = leg.from[i3 + 2] + (leg.to[i3 + 2] - leg.from[i3 + 2]) * k;
    if (drift) {
      const w = weight === 'arrive' ? k : 1 - k;
      x += drift[i3] * w;
      y += drift[i3 + 1] * w;
      z += drift[i3 + 2] * w;
    }
    positions[i3] = x;
    positions[i3 + 1] = y;
    positions[i3 + 2] = z;
    for (let c = 0; c < 3; c++) {
      colors[i3 + c] = leg.fromColor[i3 + c] + (leg.toColor[i3 + c] - leg.fromColor[i3 + c]) * k;
    }
    const i2 = i * 2;
    sizes[i2] = grow * (leg.fromSize[i2] + (leg.toSize[i2] - leg.fromSize[i2]) * k);
    sizes[i2 + 1] = grow * (leg.fromSize[i2 + 1] + (leg.toSize[i2 + 1] - leg.fromSize[i2 + 1]) * k);
  }
}

export interface FlyStrokes {
  readonly mesh: Mesh<InstancedBufferGeometry, StrokeMaterial>;
  /** Strokes in the mesh. */
  readonly count: number;
  /**
   * Writes every stroke at `t` (0-1) along `leg` (`flightFrame`, `drift` weighed by `weight`),
   * its quad facing `eye` (rig-local), and shrunk away by `fade` (0 keeps its size). Shows it.
   * A `FLY_COUNT` mesh only.
   */
  draw(
    leg: FlightLeg,
    t: number,
    eye: readonly [number, number, number],
    fade: number,
    drift?: Float32Array | null,
    weight?: DriftWeight,
  ): void;
  /**
   * Writes every stroke as given (xyz, rgb bytes, length and width per stroke), its quad facing
   * `eye`. Shows it while any quad has a size.
   */
  place(
    positions: Float32Array,
    colors: Uint8Array,
    sizes: Float32Array,
    eye: readonly [number, number, number],
  ): void;
  /** The positions of the last `draw`, xyz per stroke, rig-local. */
  readonly positions: Float32Array;
  /** The colours and sizes of the last `draw`. */
  readonly colors: Uint8Array;
  readonly sizes: Float32Array;
  hide(): void;
  /** Releases the geometry and material; the atlas belongs to the caller. */
  dispose(): void;
}

/** Ridge and bristle brushes, as the painting's own strokes. */
const FLY_BRUSHES = BRUSHES.flatMap((b, i) =>
  b.kind === 'ridge' || b.kind === 'bristle' ? [i] : [],
);

export function createFlyStrokes(
  parent: Object3D,
  atlas: Texture,
  count = FLY_COUNT,
  name = 'portal-fly',
): FlyStrokes {
  const buffers = createStrokeBuffers(count);
  for (let i = 0; i < count; i++) {
    buffers.meta[i * 4] = FLY_BRUSHES[i % FLY_BRUSHES.length];
    buffers.meta[i * 4 + 1] = STROKE_LAYER.ground;
    buffers.meta[i * 4 + 2] = (i * 37) & 255;
    buffers.tangent[i] = (i * 7919) & 0xffff;
  }
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3,
    ),
  );
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  // The meta and tangent never change, so only the first render uploads them.
  const live: InstancedBufferAttribute[] = [];
  let position: InstancedBufferAttribute | null = null;
  for (const spec of STROKE_ATTRIBUTES) {
    const attribute = new InstancedBufferAttribute(
      buffers[spec.key],
      spec.itemSize,
      spec.normalized,
    );
    if (spec.integer) attribute.gpuType = IntType;
    attribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute(spec.name, attribute);
    if (spec.key === 'position') position = attribute;
    else if (spec.key !== 'meta' && spec.key !== 'tangent') live.push(attribute);
  }
  // Written once, not with each draw: with depth test and write off, the key only nudges clip z
  // inside the tie-break range, so it cannot change a pixel.
  geometry.setAttribute('iTie', createTieKeyAttribute(buffers));
  geometry.instanceCount = count;
  const material = createStrokeMaterial(atlas);
  material.name = name;
  // Its own motion gate, always closed, as the teleport arc's: no layer motion or reactive push.
  material.uniforms.uMotionLayers = { value: 0 };
  material.depthTest = false;
  material.depthWrite = false;
  // The veil is transparent, and three draws every opaque object before the transparent list
  // whatever its render order, so an opaque mesh here would sit under the veil. Transparent with
  // no blending keeps the alpha-to-coverage pixels exactly and sorts it after the veil. The
  // program does not change: alpha to coverage already keeps it off three's opaque path.
  material.transparent = true;
  material.blending = NoBlending;
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = FLY_RENDER_ORDER;
  mesh.visible = false;
  parent.add(mesh);

  const positions = buffers.position;
  const colors = new Uint8Array(count * 3);
  const sizes = buffers.size;

  /**
   * Faces every quad to `eye`, copies `colors` in and uploads what can change, the positions only
   * when `moved`; shown while any quad has a size.
   */
  function commit(eye: readonly [number, number, number], moved: boolean): void {
    let shown = false;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      let nx = eye[0] - positions[i3];
      let ny = eye[1] - positions[i3 + 1];
      let nz = eye[2] - positions[i3 + 2];
      if (nx * nx + ny * ny + nz * nz < 1e-8) nz = 1;
      [nx, ny] = octEncode(nx, ny, nz);
      buffers.normal[i * 2] = Math.round(nx * 32767);
      buffers.normal[i * 2 + 1] = Math.round(ny * 32767);
      // The alpha byte carries the cypress flame data (CYPRESS_FLAME_NONE is 255), not opacity,
      // so a stroke fades by shrinking.
      buffers.color[i * 4] = colors[i3];
      buffers.color[i * 4 + 1] = colors[i3 + 1];
      buffers.color[i * 4 + 2] = colors[i3 + 2];
      buffers.color[i * 4 + 3] = 255;
      if (sizes[i * 2] > 0) shown = true;
    }
    for (const attribute of live) attribute.needsUpdate = true;
    if (moved && position) position.needsUpdate = true;
    mesh.visible = shown;
  }

  return {
    mesh,
    count,
    positions,
    colors,
    sizes,
    draw(leg, t, eye, fade, drift = null, weight = 'arrive') {
      flightFrame(leg, t, fade, drift, weight, positions, colors, sizes);
      commit(eye, true);
    },
    place(at, rgb, size, eye) {
      let moved = false;
      for (let i = 0; i < count * 3; i++) {
        if (positions[i] !== at[i]) {
          moved = true;
          break;
        }
      }
      if (moved) positions.set(at.subarray(0, count * 3));
      colors.set(rgb.subarray(0, count * 3));
      sizes.set(size.subarray(0, count * 2));
      commit(eye, moved);
    },
    hide() {
      mesh.visible = false;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
