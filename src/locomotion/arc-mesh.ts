/**
 * The teleport arc as painted strokes (P3.4, ruling Q5): one small instanced mesh of stroke quads
 * on the stroke engine's own material and brush atlas, rewritten each frame while aiming and
 * hidden otherwise, so a hidden arc costs no draw call. src/render/strokes is only imported.
 *
 * The mesh sits at the identity in world space and its instances carry world positions. Each arc
 * stroke runs along its segment of the arc and turns about it to face the eye, so it reads as a
 * ribbon from any side; the landing ring lies on the ground.
 *
 * A rewrite allocates: each stroke goes through packInstance, unpackInstance, surfaceBasis and
 * strokeShade, about a dozen short-lived objects per stroke, so about 600 per aiming frame at the
 * 49-stroke cap. The decode stays on unpackInstance so the tangent matches the GPU's basis.
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
import { strokeShade } from '../demo/canvas/placement';
import { BRUSHES } from '../render/strokes/brush-atlas-data';
import { DEPTH_TIE_BREAK_FRONT_FLAG } from '../render/strokes/depth-tie-break';
import { surfaceBasis, type Vec3 } from '../render/strokes/frame';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_ATTRIBUTES,
  STROKE_LAYER,
  type StrokeLayer,
  unpackInstance,
} from '../render/strokes/instance';
import { createStrokeMaterial, type StrokeMaterial } from '../render/strokes/material';
import { createTieKeyAttribute, writeTieKeys } from '../render/strokes/tie-key';
import type { ArcTarget } from './locomotion';
import { type ArcResult, MAX_SAMPLES } from './teleport';

/** sRGB bytes of a landing the jump accepts: a warm yellow. */
export const ARC_VALID_COLOR: readonly [number, number, number] = Object.freeze([0xf2, 0xc8, 0x4b]);
/** sRGB bytes of an aim with no valid landing: a desaturated red-grey. */
export const ARC_INVALID_COLOR: readonly [number, number, number] = Object.freeze([
  0x8c, 0x70, 0x6c,
]);
/**
 * Arc length left undrawn at the origin, metres. The origin is the controller in XR and the eye on
 * the desktop, and the camera's near plane is 0.1 m, so the first stroke starts well past it.
 */
export const ARC_START = 0.25;
/** Stroke width at the arc's start, and from `ARC_WIDTH_RAMP` metres along it on. */
export const ARC_WIDTH_NEAR = 0.04;
export const ARC_WIDTH_FAR = 0.12;
export const ARC_WIDTH_RAMP = 8;
/** A stroke's length over its segment's: neighbouring strokes overlap, as painted dabs do. */
export const ARC_OVERLAP = 1.35;
/** The landing ring: strokes, radius about the hit, width, and lift off the ground, metres. */
export const RING_STROKES = 10;
export const RING_RADIUS = 0.35;
export const RING_WIDTH = 0.08;
export const RING_LIFT = 0.04;
/**
 * The ring is pulled towards the eye along the line from the hit, so it stays on top of the ground
 * strokes, with its centre on the same eye ray (a rigid translation scales it up by about
 * d / (d - pull)). A lift along the ground normal cannot do it: seen along a
 * grazing ray, 4 cm of height is millimetres of depth, less than the ground strokes' own lift and
 * tilt, the terrain's triangle mismatch and the shader's per-stroke tie-break (up to 0.25 m of view
 * depth, which the ring's front flag only matches). The pull is a share of the eye distance, within
 * these bounds in metres, and never more than a quarter of the distance, so it stays far from the
 * eye. A house or a hill crest nearer the eye than the pull still hides the ring.
 */
export const RING_PULL_MIN = 0.3;
export const RING_PULL_MAX = 0.6;
export const RING_PULL_SHARE = 0.1;
export const RING_PULL_CAP_SHARE = 0.25;

/** The ring's pull towards the eye, metres, for a hit `distance` metres from the eye. */
export function ringPull(distance: number): number {
  const pull = Math.min(RING_PULL_MAX, Math.max(RING_PULL_MIN, RING_PULL_SHARE * distance));
  return Math.min(pull, RING_PULL_CAP_SHARE * distance);
}
/** One stroke per arc segment, plus the ring. */
export const ARC_CAPACITY = MAX_SAMPLES - 1 + RING_STROKES;

/** Bristle brushes paint the arc; ridge brushes the ring. */
const ARC_BRUSHES = BRUSHES.flatMap((b, i) => (b.kind === 'bristle' ? [i] : []));
const RING_BRUSHES = BRUSHES.flatMap((b, i) => (b.kind === 'ridge' ? [i] : []));
const RING_LENGTH = ((2 * Math.PI * RING_RADIUS) / RING_STROKES) * ARC_OVERLAP;
/** Below this the eye looks straight down a stroke's segment, and any normal about it will do. */
const DEGENERATE = 1e-6;

export interface ArcMesh extends ArcTarget {
  readonly mesh: Mesh<InstancedBufferGeometry, StrokeMaterial>;
  /** Releases the geometry and material. The atlas belongs to the caller. */
  dispose(): void;
}

interface MutableStroke {
  position: [number, number, number];
  normal: [number, number, number];
  tangent: number;
  color: [number, number, number, number];
  size: [number, number];
  brush: number;
  layer: StrokeLayer;
  phase: number;
  flags: number;
}

/** A stroke mesh drawing the arcs `show` is given, added to `parent` (the scene). */
export function createArcMesh(parent: Object3D, atlas: Texture): ArcMesh {
  const buffers = createStrokeBuffers(ARC_CAPACITY);
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
  const tie = createTieKeyAttribute(buffers);
  geometry.setAttribute('iTie', tie);
  attributes.push(tie);
  geometry.instanceCount = 0;
  const material = createStrokeMaterial(atlas);
  material.name = 'teleport-arc';
  // Its own motion gate, always closed: the reactive motion (P4.5) runs on every layer and would
  // push the arc away from the controller it starts at. The defines are the batch's, so the arc
  // still shares the batch's program.
  material.uniforms.uMotionLayers = { value: 0 };
  const mesh = new Mesh(geometry, material);
  mesh.name = 'teleport-arc';
  // The geometry's bounds are the unit quad, not the instances.
  mesh.frustumCulled = false;
  mesh.visible = false;
  parent.add(mesh);

  const stroke: MutableStroke = {
    position: [0, 0, 0],
    normal: [0, 0, 1],
    tangent: 0,
    color: [0, 0, 0, 255],
    size: [0, 0],
    brush: 0,
    layer: STROKE_LAYER.ground,
    phase: 0,
    flags: 0,
  };
  let count = 0;

  /**
   * Packs `stroke` with its long axis along the unit vector `along`, measured against the basis of
   * the normal as the GPU decodes it (instance.ts): the source normal's basis can turn by π.
   */
  function push(along: Vec3, rgb: readonly [number, number, number]): void {
    stroke.tangent = 0;
    packInstance(buffers, count, stroke);
    const decoded = unpackInstance(buffers, count).normal;
    const { b1, b2 } = surfaceBasis(decoded);
    stroke.tangent = Math.atan2(
      along[0] * b2[0] + along[1] * b2[1] + along[2] * b2[2],
      along[0] * b1[0] + along[1] * b1[1] + along[2] * b1[2],
    );
    const shade = strokeShade(decoded);
    stroke.color[0] = rgb[0] / shade;
    stroke.color[1] = rgb[1] / shade;
    stroke.color[2] = rgb[2] / shade;
    packInstance(buffers, count, stroke);
    count += 1;
  }

  function pushArc(aim: ArcResult, eye: Vec3, rgb: readonly [number, number, number]): void {
    const p = aim.points;
    stroke.flags = 0;
    let s0 = 0;
    for (let i = 0; i + 1 < aim.count; i += 1) {
      const dx = p[i * 3 + 3] - p[i * 3];
      const dy = p[i * 3 + 4] - p[i * 3 + 1];
      const dz = p[i * 3 + 5] - p[i * 3 + 2];
      const segment = Math.hypot(dx, dy, dz);
      const s1 = s0 + segment;
      const startS = Math.max(s0, ARC_START);
      if (segment > 0 && s1 > startS) {
        const f = (startS - s0) / segment;
        const ax = p[i * 3] + dx * f;
        const ay = p[i * 3 + 1] + dy * f;
        const az = p[i * 3 + 2] + dz * f;
        const length = s1 - startS;
        const tx = dx / segment;
        const ty = dy / segment;
        const tz = dz / segment;
        const cx = (ax + p[i * 3 + 3]) / 2;
        const cy = (ay + p[i * 3 + 4]) / 2;
        const cz = (az + p[i * 3 + 5]) / 2;
        // The eye direction with its component along the segment removed.
        const ex = eye[0] - cx;
        const ey = eye[1] - cy;
        const ez = eye[2] - cz;
        const along = ex * tx + ey * ty + ez * tz;
        let nx = ex - along * tx;
        let ny = ey - along * ty;
        let nz = ez - along * tz;
        let n = Math.hypot(nx, ny, nz);
        if (n < DEGENERATE) {
          // Any normal about the segment: t × (0, 1, 0), or t × (1, 0, 0) for a vertical one.
          nx = Math.abs(ty) < 0.9 ? -tz : 0;
          ny = Math.abs(ty) < 0.9 ? 0 : tz;
          nz = Math.abs(ty) < 0.9 ? tx : -ty;
          n = Math.hypot(nx, ny, nz);
        }
        const mid = (startS + s1) / 2;
        stroke.position[0] = cx;
        stroke.position[1] = cy;
        stroke.position[2] = cz;
        stroke.normal[0] = nx / n;
        stroke.normal[1] = ny / n;
        stroke.normal[2] = nz / n;
        stroke.size[0] = length * ARC_OVERLAP;
        stroke.size[1] =
          ARC_WIDTH_NEAR + (ARC_WIDTH_FAR - ARC_WIDTH_NEAR) * Math.min(1, mid / ARC_WIDTH_RAMP);
        stroke.brush = ARC_BRUSHES[i % ARC_BRUSHES.length] as number;
        push([tx, ty, tz], rgb);
      }
      s0 = s1;
    }
  }

  function pushRing(hit: Vec3, ground: Vec3, eye: Vec3): void {
    const { b1, b2 } = surfaceBasis(ground);
    const ex = eye[0] - hit[0];
    const ey = eye[1] - hit[1];
    const ez = eye[2] - hit[2];
    const distance = Math.hypot(ex, ey, ez);
    // The pull as a vector; none when the eye is on the hit.
    const pullScale =
      Number.isFinite(distance) && distance > DEGENERATE ? ringPull(distance) / distance : 0;
    const px = ex * pullScale;
    const py = ey * pullScale;
    const pz = ez * pullScale;
    stroke.flags = DEPTH_TIE_BREAK_FRONT_FLAG;
    stroke.normal[0] = ground[0];
    stroke.normal[1] = ground[1];
    stroke.normal[2] = ground[2];
    stroke.size[0] = RING_LENGTH;
    stroke.size[1] = RING_WIDTH;
    for (let k = 0; k < RING_STROKES; k += 1) {
      const a = (2 * Math.PI * k) / RING_STROKES;
      const c = Math.cos(a);
      const s = Math.sin(a);
      for (let j = 0; j < 3; j += 1) {
        stroke.position[j] =
          (hit[j] as number) +
          (j === 0 ? px : j === 1 ? py : pz) +
          (ground[j] as number) * RING_LIFT +
          ((b1[j] as number) * c + (b2[j] as number) * s) * RING_RADIUS;
      }
      stroke.brush = RING_BRUSHES[k % RING_BRUSHES.length] as number;
      push(
        [-b1[0] * s + b2[0] * c, -b1[1] * s + b2[1] * c, -b1[2] * s + b2[2] * c],
        ARC_VALID_COLOR,
      );
    }
  }

  return {
    mesh,
    show(aim, eye) {
      count = 0;
      // A non-finite eye would put NaN in every stroke normal, which packInstance rejects.
      if (!(Number.isFinite(eye[0]) && Number.isFinite(eye[1]) && Number.isFinite(eye[2]))) {
        geometry.instanceCount = 0;
        mesh.visible = false;
        return;
      }
      pushArc(aim, eye, aim.valid ? ARC_VALID_COLOR : ARC_INVALID_COLOR);
      if (aim.valid && aim.hit) pushRing(aim.hit, aim.normal, eye);
      geometry.instanceCount = count;
      writeTieKeys(buffers, tie.array as Float32Array, count);
      for (const attribute of attributes) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, count * attribute.itemSize);
        attribute.needsUpdate = true;
      }
      mesh.visible = count > 0;
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
