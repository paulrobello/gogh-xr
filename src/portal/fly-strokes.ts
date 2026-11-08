/**
 * The portal's flying strokes (P5.5): one transitional instanced mesh of `FLY_COUNT` stroke quads
 * on the stroke engine's own material and the shared brush atlas. They lift off the painting's
 * frame, coloured from its scan, and fly out to sampled strokes of the new world, taking those
 * strokes' colours and sizes, then hide as the world shows; a return runs the other way.
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

export interface FlyStrokes {
  readonly mesh: Mesh<InstancedBufferGeometry, StrokeMaterial>;
  /**
   * Writes every stroke at `t` (0-1) along `leg`, each starting a little after the last and eased,
   * its quad facing `eye` (rig-local), and shrunk away by `fade` (0 keeps its size). Shows it.
   */
  draw(leg: FlightLeg, t: number, eye: readonly [number, number, number], fade: number): void;
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

export function createFlyStrokes(parent: Object3D, atlas: Texture): FlyStrokes {
  const buffers = createStrokeBuffers(FLY_COUNT);
  for (let i = 0; i < FLY_COUNT; i++) {
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
  const attributes: InstancedBufferAttribute[] = [];
  for (const spec of STROKE_ATTRIBUTES) {
    const attribute = new InstancedBufferAttribute(
      buffers[spec.key],
      spec.itemSize,
      spec.normalized,
    );
    if (spec.integer) attribute.gpuType = IntType;
    attribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute(spec.name, attribute);
    attributes.push(attribute);
  }
  // Written once, not with each draw: with depth test and write off, the key only nudges clip z
  // inside the tie-break range, so it cannot change a pixel.
  geometry.setAttribute('iTie', createTieKeyAttribute(buffers));
  geometry.instanceCount = FLY_COUNT;
  const material = createStrokeMaterial(atlas);
  material.name = 'portal-fly';
  // Its own motion gate, always closed, as the teleport arc's: no layer motion or reactive push.
  material.uniforms.uMotionLayers = { value: 0 };
  material.depthTest = false;
  material.depthWrite = false;
  const mesh = new Mesh(geometry, material);
  mesh.name = 'portal-fly';
  mesh.frustumCulled = false;
  mesh.renderOrder = FLY_RENDER_ORDER;
  mesh.visible = false;
  parent.add(mesh);

  const positions = buffers.position;
  const colors = new Uint8Array(FLY_COUNT * 3);
  const sizes = buffers.size;

  return {
    mesh,
    positions,
    colors,
    sizes,
    draw(leg, t, eye, fade) {
      // The alpha byte carries the cypress flame data (CYPRESS_FLAME_NONE is 255), not opacity, so
      // a stroke fades by shrinking.
      const grow = 1 - Math.min(1, Math.max(0, fade));
      for (let i = 0; i < FLY_COUNT; i++) {
        const delay = (STAGGER * ((i * 2654435761) % 1000)) / 1000;
        const k = ease((t - delay) / (1 - STAGGER));
        const lift = Math.sin(Math.PI * k) * leg.arc[i];
        const i3 = i * 3;
        const x = leg.from[i3] + (leg.to[i3] - leg.from[i3]) * k;
        const y = leg.from[i3 + 1] + (leg.to[i3 + 1] - leg.from[i3 + 1]) * k + lift;
        const z = leg.from[i3 + 2] + (leg.to[i3 + 2] - leg.from[i3 + 2]) * k;
        positions[i3] = x;
        positions[i3 + 1] = y;
        positions[i3 + 2] = z;
        let nx = eye[0] - x;
        let ny = eye[1] - y;
        let nz = eye[2] - z;
        if (nx * nx + ny * ny + nz * nz < 1e-8) nz = 1;
        [nx, ny] = octEncode(nx, ny, nz);
        buffers.normal[i * 2] = Math.round(nx * 32767);
        buffers.normal[i * 2 + 1] = Math.round(ny * 32767);
        for (let c = 0; c < 3; c++) {
          const v = leg.fromColor[i3 + c] + (leg.toColor[i3 + c] - leg.fromColor[i3 + c]) * k;
          colors[i3 + c] = v;
          buffers.color[i * 4 + c] = v;
        }
        buffers.color[i * 4 + 3] = 255;
        const i2 = i * 2;
        sizes[i2] = grow * (leg.fromSize[i2] + (leg.toSize[i2] - leg.fromSize[i2]) * k);
        sizes[i2 + 1] =
          grow * (leg.fromSize[i2 + 1] + (leg.toSize[i2 + 1] - leg.fromSize[i2 + 1]) * k);
      }
      for (const attribute of attributes) attribute.needsUpdate = true;
      mesh.visible = grow > 0;
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
