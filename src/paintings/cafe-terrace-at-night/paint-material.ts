/**
 * The café's one material. It projects the scan through the painter's camera onto whatever the
 * painter sees (the id map decides), so the painter's view is the painting itself, and paints the
 * rest from a patch of the scan tiled over the surface, so every other view keeps Van Gogh's own
 * marks and palette.
 */
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  type Matrix4,
  ShaderMaterial,
  type Texture,
  Vector2,
  Vector3,
} from 'three';
import type { Vec3 } from '../../render/strokes/frame';
import { CAMERA_FORWARD, CAMERA_RIGHT, CAMERA_UP, CANVAS_LENS, PAINTER_EYE } from './canvas';
import type { SetSurface, Swatch } from './layout';

const VERTEX = /* glsl */ `
attribute vec3 aTint;
attribute float aId;
attribute vec4 aSwatch;
attribute vec2 aSwatchUv;
varying vec3 vRest;
varying vec3 vFlat;
varying vec3 vTint;
varying float vId;
varying vec4 vSwatch;
varying vec2 vSwatchUv;

void main() {
  // The rest position carries the paint, so a swaying branch keeps its own.
  vRest = position;
  vFlat = normal;
  vTint = aTint;
  vId = aId;
  vSwatch = aSwatch;
  vSwatchUv = aSwatchUv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uScan;
uniform sampler2D uIds;
uniform vec2 uIdTexel;
uniform vec3 uEye;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec2 uLens;
uniform float uGain;
varying vec3 vRest;
varying vec3 vFlat;
varying vec3 vTint;
varying float vId;
varying vec4 vSwatch;
varying vec2 vSwatchUv;

// How far past a canvas edge the paint carries on, mirrored, before the swatch takes over.
const float REACH = 0.06;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float mirrored(float x) {
  return 1.0 - abs(1.0 - mod(x, 2.0));
}

float named(vec2 uv) {
  return step(abs(texture2D(uIds, uv).r * 255.0 - vId), 0.5);
}

vec3 patchAt(vec2 uv) {
  return texture2D(uScan, vSwatch.xy + vec2(mirrored(uv.x), mirrored(uv.y)) * vSwatch.zw).rgb;
}

// Two tilings of the patch at different scales, traded off across the surface, so the mirror
// seams of one never line up into a pattern.
vec3 patchMarks() {
  vec2 uv = vSwatchUv;
  float trade = sin(uv.x * 2.1 + 1.7 * sin(uv.y * 1.3)) * cos(uv.y * 1.9 + 0.6 * sin(uv.x * 2.7));
  return mix(patchAt(uv), patchAt(uv * 0.83 + vec2(0.37, 1.13)), smoothstep(-0.25, 0.25, trade));
}

void main() {
  vec3 q = vRest - uEye;
  float depth = dot(q, uForward);
  vec2 uv = vec2(0.5 + dot(q, uRight) / depth * uLens.x, 0.5 - dot(q, uUp) / depth * uLens.y);
  vec2 over = max(max(-uv, uv - 1.0), 0.0);
  vec2 at = vec2(mirrored(uv.x), mirrored(uv.y));
  float inside = step(0.05, depth) * (1.0 - smoothstep(0.5 * REACH, REACH, max(over.x, over.y)));
  vec3 projected = texture2D(uScan, at).rgb;
  vec3 color;
  if (vSwatch.z > 0.0) {
    vec3 n = normalize(gl_FrontFacing ? vFlat : -vFlat);
    vec3 ray = normalize(q);
    float lit = inside * step(0.0, dot(n, -ray));
    // A texel either side counts, so a silhouette's rim keeps its paint from the painter's spot.
    float seen = lit * max(
      max(named(at), named(at + vec2(uIdTexel.x, 0.0))),
      max(max(named(at - vec2(uIdTexel.x, 0.0)), named(at + vec2(0.0, uIdTexel.y))),
        named(at - vec2(0.0, uIdTexel.y))));
    vec3 marks = patchMarks() * vTint;
    // The patch's marks as light and dark only, so they shade any local colour without tinting it.
    vec3 mean = texture2D(uScan, vSwatch.xy + 0.5 * vSwatch.zw, 6.0).rgb;
    float relief = clamp(dot(marks, LUMA) / max(dot(mean * vTint, LUMA), 0.01), 0.7, 1.35);
    // The painter saw this surface edge-on, so each texel is a long streak across it. Away from
    // the painter's spot the streaks give way to the paint's local colour under the patch's marks.
    float stretch = 1.0 / max(abs(dot(n, ray)), 0.02);
    float away = smoothstep(0.02, 0.2, 1.0 - dot(normalize(vRest - cameraPosition), ray));
    float smear = away * smoothstep(1.6, 4.5, stretch);
    if (smear > 0.0) {
      projected = mix(projected, texture2D(uScan, at, clamp(log2(stretch), 0.0, 6.0)).rgb * relief, smear);
    }
    if (seen < 1.0 && lit > 0.0) {
      // Hidden from the painter behind something: the same, from further off.
      marks = mix(marks, texture2D(uScan, at, 5.0).rgb * relief, lit);
    }
    color = mix(marks, projected, seen);
  } else {
    // A prop wears the paint that lies along its ray on every side, and its own tint off the canvas.
    color = mix(vTint, projected, inside);
  }
  gl_FragColor = vec4(color * uGain, 1.0);
  #include <colorspace_fragment>
}
`;

/** `scan` is sRGB with its top row first; `ids` is the painter's id map, one byte a texel. */
export function createPaintMaterial(
  scan: Texture,
  ids: Texture,
  idWidth: number,
  idHeight: number,
): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: DoubleSide,
    toneMapped: false,
    uniforms: {
      uScan: { value: scan },
      uIds: { value: ids },
      uIdTexel: { value: new Vector2(1 / idWidth, 1 / idHeight) },
      uEye: { value: new Vector3(...PAINTER_EYE) },
      uRight: { value: new Vector3(...CAMERA_RIGHT) },
      uUp: { value: new Vector3(...CAMERA_UP) },
      uForward: { value: new Vector3(...CAMERA_FORWARD) },
      uLens: { value: new Vector2(...CANVAS_LENS) },
      uGain: { value: 1 },
    },
  });
}

export interface PaintBuilder {
  /** A set surface: a convex outline, wound to face the painter. */
  surface(surface: SetSurface): void;
  /**
   * A mesh's triangles under `matrix`. `tint` null takes the mesh's own `color` attribute. With a
   * swatch the tint multiplies the scan patch; without one it is the paint. The patch lies flat on
   * each triangle unless `uvScale` is given, which lays it over the mesh's own `uv` instead, for a
   * curved surface.
   */
  mesh(
    source: BufferGeometry,
    matrix: Matrix4 | null,
    id: number,
    tint: number | null,
    swatch?: Swatch,
    uvScale?: readonly [number, number],
  ): void;
  /** Triangles so far, nine numbers each, and one id per vertex. */
  readonly positions: readonly number[];
  readonly ids: readonly number[];
  build(): BufferGeometry;
}

export function paintBuilder(): PaintBuilder {
  const positions: number[] = [];
  const normals: number[] = [];
  const tints: number[] = [];
  const ids: number[] = [];
  const swatches: number[] = [];
  const swatchUvs: number[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const normal = new Vector3();
  const across = new Vector3();
  const along = new Vector3();
  const color = new Color();
  const UP = new Vector3(0, 1, 0);

  function triangle(
    p0: Vector3,
    p1: Vector3,
    p2: Vector3,
    id: number,
    tint: readonly [Vec3, Vec3, Vec3],
    swatch: Swatch | undefined,
    uv?: readonly [number, number][],
  ): void {
    normal.subVectors(p1, p0).cross(c.subVectors(p2, p0));
    if (normal.lengthSq() < 1e-14) return;
    normal.normalize();
    // The patch lies flat on the surface: across is level, along runs up it.
    if (Math.abs(normal.y) > 0.9) across.set(1, 0, 0);
    else across.crossVectors(UP, normal).normalize();
    along.crossVectors(normal, across);
    for (const [i, p] of [p0, p1, p2].entries()) {
      positions.push(p.x, p.y, p.z);
      normals.push(normal.x, normal.y, normal.z);
      tints.push(...tint[i]);
      ids.push(id);
      if (swatch) {
        swatches.push(...swatch.rect);
        if (uv) swatchUvs.push(...uv[i]);
        else swatchUvs.push(p.dot(across) / swatch.metres[0], p.dot(along) / swatch.metres[1]);
      } else {
        swatches.push(0, 0, 0, 0);
        swatchUvs.push(0, 0);
      }
    }
  }

  const WHITE: Vec3 = [1, 1, 1];
  return {
    positions,
    ids,
    surface({ corners, id, swatch }) {
      const center = corners.reduce((sum, p) => sum.add(c.set(...p)), new Vector3());
      center.multiplyScalar(1 / corners.length);
      a.set(...corners[0]);
      normal.subVectors(b.set(...corners[1]), a).cross(c.set(...corners[2]).sub(a));
      const flip = normal.dot(center.negate().add(c.set(...PAINTER_EYE))) < 0;
      const p0 = new Vector3(...corners[0]);
      for (let i = 1; i + 1 < corners.length; i++) {
        const p1 = new Vector3(...corners[flip ? i + 1 : i]);
        const p2 = new Vector3(...corners[flip ? i : i + 1]);
        triangle(p0, p1, p2, id, [WHITE, WHITE, WHITE], swatch);
      }
    },
    mesh(source, matrix, id, tint, swatch, uvScale) {
      const flat = source.index ? source.toNonIndexed() : source;
      const position = flat.getAttribute('position');
      const own = flat.getAttribute('color');
      const laid = uvScale ? flat.getAttribute('uv') : null;
      const patch = (i: number): [number, number] =>
        laid && uvScale ? [laid.getX(i) * uvScale[0], laid.getY(i) * uvScale[1]] : [0, 0];
      const fixed: Vec3 | null =
        tint === null ? null : (color.setHex(tint).toArray() as unknown as Vec3);
      const at = (i: number): Vec3 =>
        fixed ?? (own ? [own.getX(i), own.getY(i), own.getZ(i)] : WHITE);
      const corner = [new Vector3(), new Vector3(), new Vector3()];
      for (let i = 0; i < position.count; i += 3) {
        for (let k = 0; k < 3; k++) {
          corner[k].fromBufferAttribute(position, i + k);
          if (matrix) corner[k].applyMatrix4(matrix);
        }
        triangle(
          corner[0],
          corner[1],
          corner[2],
          id,
          [at(i), at(i + 1), at(i + 2)],
          swatch,
          laid ? [patch(i), patch(i + 1), patch(i + 2)] : undefined,
        );
      }
      if (flat !== source) flat.dispose();
    },
    build() {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
      geometry.setAttribute('aTint', new Float32BufferAttribute(tints, 3));
      geometry.setAttribute('aId', new Float32BufferAttribute(ids, 1));
      geometry.setAttribute('aSwatch', new Float32BufferAttribute(swatches, 4));
      geometry.setAttribute('aSwatchUv', new Float32BufferAttribute(swatchUvs, 2));
      geometry.computeBoundingSphere();
      return geometry;
    },
  };
}
