/**
 * The café's paint. Every surface carries a local colour baked from the scan in world space: the
 * paint the painter saw there, averaged over a patch of the surface that is as wide as it is deep,
 * so a wall or a pavement seen at a grazing angle never streaks. A swatch of the scan tiled over
 * the surface puts Van Gogh's marks back on top at a steady size. The scan itself shows only where
 * the painter saw a surface squarely, where its marks keep their shape from any side.
 */
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  FrontSide,
  type Matrix4,
  ShaderMaterial,
  type Side,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import type { Raster } from '../../demo/canvas/field';
import type { Vec3 } from '../../render/strokes/frame';
import type { Steps } from '../../util/slicer';
import {
  CAMERA_FORWARD,
  CAMERA_RIGHT,
  CAMERA_UP,
  CANVAS_LENS,
  PAINTER_EYE,
  toCanvas,
} from './canvas';

/** A patch of the scan whose marks are tiled over a surface. */
export interface Swatch {
  /** Canvas rectangle: u, v, width, height. */
  readonly rect: readonly [number, number, number, number];
  /** The patch's size on the surface, metres. */
  readonly metres: readonly [number, number];
}

export interface Paint {
  /** The painter's id map names the nearest surface under each canvas point by this. */
  readonly id: number;
  readonly swatch: Swatch;
  /** sRGB hex: the colour where the painting shows nothing of this surface. */
  readonly tint: number;
  /** False keeps the tint everywhere, for what the painter never painted. Default true. */
  readonly painted?: boolean;
  /**
   * True shows the scan itself where the painter saw the surface squarely. Only for what has no
   * depth to betray it, the sky: on anything else the scan carries pictures of other things.
   */
  readonly exact?: boolean;
  /** A prop: its far side takes the colour of its painted side. */
  readonly round?: boolean;
  /** A lit pane or a lamp: the tint is not shaded by its facing. */
  readonly lit?: boolean;
  /** The swatch itself is the paint off the canvas, not marks over a colour: the starry sky. */
  readonly raw?: boolean;
}

/** Swatches a material can tile, the shader's array size. */
const PATCHES = 16;
/** Canvas pixels the narrow side of a gathered patch must span. */
const GATHER_PIXELS = 4;
/** Rows of the scan, for sizing a gather. */
const SCAN_ROWS = 1596;
const GATHER_MAX = 0.9;
const GATHER_POINTS: readonly (readonly [number, number])[] = (() => {
  const points: [number, number][] = [[0, 0]];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    points.push([0.5 * Math.cos(a), 0.5 * Math.sin(a)]);
    points.push([Math.cos(a + 0.52), Math.sin(a + 0.52)]);
  }
  return points;
})();
/** A grid point with at least this share of its gather on its own paint keeps it. */
const KNOWN = 0.3;
/** Metres over which a surface's paint carries on past what the painter saw, into its tint. */
const CARRY = 7;

const VERTEX = /* glsl */ `
attribute vec3 aLocal;
attribute vec2 aSeen;
attribute vec3 aPatch;
varying vec3 vRest;
varying vec3 vFlat;
varying vec3 vLocal;
varying vec2 vSeen;
varying vec3 vPatch;

void main() {
  // The rest position carries the paint, so a swaying branch keeps its own.
  vRest = position;
  vFlat = normal;
  vLocal = aLocal;
  vSeen = aSeen;
  vPatch = aPatch;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uScan;
uniform sampler2D uIds;
uniform vec2 uScanSize;
uniform vec2 uIdTexel;
uniform vec3 uEye;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec2 uLens;
uniform float uGain;
uniform vec4 uPatchRect[${PATCHES}];
uniform vec3 uPatchMean[${PATCHES}];
varying vec3 vRest;
varying vec3 vFlat;
varying vec3 vLocal;
varying vec2 vSeen;
varying vec3 vPatch;

// How far past a canvas edge the scan carries on, mirrored.
const float REACH = 0.06;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float mirrored(float x) {
  return 1.0 - abs(1.0 - mod(x, 2.0));
}

float named(vec2 uv) {
  return step(abs(texture2D(uIds, uv).r * 255.0 - vSeen.x), 0.5);
}

// One copy of the patch, repeated. Its weight falls to nothing at its own seams, so a blend of
// copies at different scales never shows one.
vec4 tileAt(vec4 rect, vec2 uv, vec2 gx, vec2 gy) {
  vec2 f = fract(uv);
  vec2 edge = min(f, 1.0 - f);
  float weight = min(edge.x, edge.y) * 2.0 + 0.002;
  return vec4(textureGrad(uScan, rect.xy + f * rect.zw, gx, gy).rgb, 1.0) * weight * weight;
}

void main() {
  int tile = int(vPatch.x + 0.5);
  vec4 rect = uPatchRect[tile];
  vec3 mean = uPatchMean[tile];
  vec2 uv = vPatch.yz;
  // The patch's footprint on screen in its own texels. Its gradients are held short of the mip
  // that would reach past the patch, and the anisotropic filter keeps a grazing floor sharp.
  vec2 texels = rect.zw * uScanSize;
  vec2 gx = dFdx(uv) * rect.zw;
  vec2 gy = dFdy(uv) * rect.zw;
  float fx = length(dFdx(uv) * texels);
  float fy = length(dFdy(uv) * texels);
  float major = max(max(fx, fy), 1e-6);
  float deepest = log2(min(texels.x, texels.y)) - 3.0;
  float hold = min(1.0, exp2(deepest) / major);
  gx *= hold;
  gy *= hold;
  vec4 sum = tileAt(rect, uv, gx, gy)
    + tileAt(rect, uv * 0.83 + vec2(0.37, 1.13), gx * 0.83, gy * 0.83)
    + tileAt(rect, uv * 1.21 + vec2(0.71, 0.29), gx * 1.21, gy * 1.21);
  vec3 marks = sum.rgb / sum.a;
  // The marks as a ratio to the patch's own mean: mostly light and dark, with some of their hue.
  float light = dot(marks, LUMA) / max(dot(mean, LUMA), 0.004);
  vec3 detail = clamp(mix(vec3(light), marks / max(mean, vec3(0.004)), 0.4), 0.5, 1.7);
  // Too far for the marks to resolve: the local colour alone.
  float blur = log2(max(min(fx, fy), major / 8.0) + 1e-6);
  detail = mix(vec3(1.0), detail, 0.8 * (1.0 - smoothstep(deepest - 1.0, deepest + 1.0, blur)));
  vec3 color = vSeen.y > 1.5 ? marks : vLocal * detail;

  vec3 q = vRest - uEye;
  float depth = dot(q, uForward);
  vec2 at = vec2(0.5 + dot(q, uRight) / depth * uLens.x, 0.5 - dot(q, uUp) / depth * uLens.y);
  vec2 over = max(max(-at, at - 1.0), 0.0);
  at = vec2(mirrored(at.x), mirrored(at.y));
  vec3 scan = texture2D(uScan, at).rgb;
  if (vSeen.y > 0.5 && depth > 0.05) {
    vec3 n = normalize(gl_FrontFacing ? vFlat : -vFlat);
    // 1 where the painter looked straight at the surface. Past about 50 degrees off, a mark of the
    // scan is a streak on it, so the scan gives way to the local colour.
    float square = -dot(n, normalize(q));
    float exact = (1.0 - smoothstep(0.5 * REACH, REACH, max(over.x, over.y)))
      * smoothstep(0.42, 0.62, square);
    if (exact > 0.0) {
      // A texel either side counts, so a silhouette's rim keeps its paint.
      exact *= max(
        max(named(at), named(at + vec2(uIdTexel.x, 0.0))),
        max(max(named(at - vec2(uIdTexel.x, 0.0)), named(at + vec2(0.0, uIdTexel.y))),
          named(at - vec2(0.0, uIdTexel.y))));
      color = mix(color, scan, exact);
    }
  }
  gl_FragColor = vec4(color * uGain, 1.0);
  #include <colorspace_fragment>
}
`;

/** The mean of a swatch in linear light, for the shader's mark ratio. */
function swatchMean(swatch: Swatch, view: PainterView): Vec3 {
  const [u, v, w, h] = swatch.rect;
  const sum: [number, number, number] = [0, 0, 0];
  const out: [number, number, number] = [0, 0, 0];
  const steps = 24;
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      view.colourAt(u + ((i + 0.5) / steps) * w, v + ((j + 0.5) / steps) * h, out);
      sum[0] += out[0];
      sum[1] += out[1];
      sum[2] += out[2];
    }
  }
  return [sum[0] / steps ** 2, sum[1] / steps ** 2, sum[2] / steps ** 2];
}

/**
 * `scan` is sRGB with its top row first; `ids` is the painter's id map, one byte a texel. Every
 * part of one set shares `patches`, the list its builders filled.
 */
export function createPaintMaterial(
  scan: Texture,
  ids: Texture,
  idWidth: number,
  idHeight: number,
  patches: readonly Swatch[],
  view: PainterView,
  side: Side = FrontSide,
): ShaderMaterial {
  if (patches.length > PATCHES) throw new Error(`The paint tiles at most ${PATCHES} swatches`);
  const rects: Vector4[] = [];
  const means: Vector3[] = [];
  for (let i = 0; i < PATCHES; i++) {
    const swatch = patches[Math.min(i, patches.length - 1)];
    rects.push(new Vector4(...swatch.rect));
    means.push(new Vector3(...swatchMean(swatch, view)));
  }
  const image = scan.image as { width: number; height: number };
  return new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side,
    toneMapped: false,
    uniforms: {
      uScan: { value: scan },
      uIds: { value: ids },
      uScanSize: { value: new Vector2(image.width, image.height) },
      uIdTexel: { value: new Vector2(1 / idWidth, 1 / idHeight) },
      uEye: { value: new Vector3(...PAINTER_EYE) },
      uRight: { value: new Vector3(...CAMERA_RIGHT) },
      uUp: { value: new Vector3(...CAMERA_UP) },
      uForward: { value: new Vector3(...CAMERA_FORWARD) },
      uLens: { value: new Vector2(...CANVAS_LENS) },
      uGain: { value: 1 },
      uPatchRect: { value: rects },
      uPatchMean: { value: means },
    },
  });
}

/** What the painter saw: the scan's colour and the id map, by canvas point. */
export interface PainterView {
  /** The id at canvas (u, v), or -1 off the canvas. */
  idAt(u: number, v: number): number;
  /**
   * The same for the set's own surfaces: -1 too wherever a prop stands, a little past its outline,
   * and wherever the painting shows something the set builds as geometry instead. A wall then
   * never takes the paint of the figure, lantern or bracket in front of it.
   */
  setIdAt(u: number, v: number): number;
  /** The scan's colour at canvas (u, v) in linear light, into `out`. */
  colourAt(u: number, v: number, out: [number, number, number]): void;
}

const LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** What the set's surfaces must not take their paint from. */
export interface PaintMask {
  /** Ids of props: tables, chairs, figures, the tree, the lantern. */
  covers(id: number): boolean;
  /** Canvas rectangles (u, v, width, height) of painted things the set builds as geometry. */
  readonly ignore: readonly (readonly [number, number, number, number])[];
  /** Id-map texels the props' outlines grow by. */
  readonly grow: number;
}

export function painterView(
  raster: Raster,
  ids: Uint8Array,
  idWidth: number,
  idHeight: number,
  mask?: PaintMask,
): PainterView {
  const { width, height, data } = raster;
  const masked = new Uint8Array(idWidth * idHeight);
  if (mask) {
    // The props' texels, grown along rows and then columns.
    const rows = new Uint8Array(idWidth * idHeight);
    for (let y = 0; y < idHeight; y++) {
      let reach = -1;
      for (let x = 0; x < idWidth; x++) {
        if (mask.covers(ids[y * idWidth + x])) reach = x + mask.grow;
        if (x <= reach) rows[y * idWidth + x] = 1;
      }
      reach = idWidth;
      for (let x = idWidth - 1; x >= 0; x--) {
        if (mask.covers(ids[y * idWidth + x])) reach = x - mask.grow;
        if (x >= reach) rows[y * idWidth + x] = 1;
      }
    }
    for (let x = 0; x < idWidth; x++) {
      let reach = -1;
      for (let y = 0; y < idHeight; y++) {
        if (rows[y * idWidth + x]) reach = y + mask.grow;
        if (y <= reach) masked[y * idWidth + x] = 1;
      }
      reach = idHeight;
      for (let y = idHeight - 1; y >= 0; y--) {
        if (rows[y * idWidth + x]) reach = y - mask.grow;
        if (y >= reach) masked[y * idWidth + x] = 1;
      }
    }
    for (const [u, v, w, h] of mask.ignore) {
      const x1 = Math.min(idWidth, Math.ceil((u + w) * idWidth));
      const y1 = Math.min(idHeight, Math.ceil((v + h) * idHeight));
      for (let y = Math.max(0, Math.floor(v * idHeight)); y < y1; y++) {
        masked.fill(1, y * idWidth + Math.max(0, Math.floor(u * idWidth)), y * idWidth + x1);
      }
    }
  }
  return {
    idAt(u, v) {
      if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return -1;
      return ids[Math.floor(v * idHeight) * idWidth + Math.floor(u * idWidth)];
    },
    setIdAt(u, v) {
      if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return -1;
      const index = Math.floor(v * idHeight) * idWidth + Math.floor(u * idWidth);
      return masked[index] ? -1 : ids[index];
    },
    colourAt(u, v, out) {
      const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
      const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
      const i = (y * width + x) * 4;
      out[0] = LINEAR[data[i]];
      out[1] = LINEAR[data[i + 1]];
      out[2] = LINEAR[data[i + 2]];
    },
  };
}

export interface QuadOptions {
  /** Largest grid cell, metres. A quad wider than this is cut into a grid for its local colour. */
  readonly cell?: number;
  /** Wind the quad to face this point. */
  readonly toward?: Vec3;
  /** Wind the quad to face away from this point. */
  readonly away?: Vec3;
}

export interface MeshOptions {
  readonly own?: boolean;
  readonly uvScale?: readonly [number, number];
}

export interface PaintBuilder {
  /** A flat quad, its corners in order. Without `toward` or `away` it faces (b - a) × (d - a). */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, paint: Paint, options?: QuadOptions): void;
  triangle(a: Vec3, b: Vec3, c: Vec3, paint: Paint, options?: QuadOptions): void;
  /**
   * A mesh's triangles under `matrix`. With `own`, its `color` attribute replaces the tint. The
   * swatch lies flat on each triangle unless `uvScale` lays it over the mesh's own `uv`, for a
   * curved surface.
   */
  mesh(source: BufferGeometry, matrix: Matrix4 | null, paint: Paint, options?: MeshOptions): void;
  /** Triangles so far, nine numbers each, and one id per vertex. */
  readonly positions: readonly number[];
  readonly ids: readonly number[];
  /** Computes every point's local colour from what the painter saw. Run it before `build`. */
  bake(view: PainterView): Steps<void>;
  build(): Steps<BufferGeometry>;
}

interface Grid {
  readonly first: number;
  readonly across: number;
  readonly up: number;
  readonly cell: number;
}

/** How a face's tint darkens with its facing: soffits darkest, tops lightest. */
function shade(ny: number, nx: number, nz: number): number {
  return 0.84 + 0.16 * Math.max(ny, 0) - 0.26 * Math.max(-ny, 0) + 0.07 * (0.6 * nx + 0.8 * nz);
}

/** Every builder of one set shares `patches`, which collects the swatches they use. */
export function paintBuilder(patches: Swatch[]): PaintBuilder {
  const positions: number[] = [];
  const normals: number[] = [];
  const ids: number[] = [];
  const seen: number[] = [];
  const patch: number[] = [];
  /** Each vertex's node: the point whose local colour it takes. */
  const owner: number[] = [];
  const nodeAt: number[] = [];
  const nodeNormal: number[] = [];
  const nodePaint: Paint[] = [];
  const nodeTint: (Vec3 | null)[] = [];
  const nodeReach: number[] = [];
  const grids: Grid[] = [];
  const loose = new Map<string, number>();
  let local: Float32Array | null = null;

  const p = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  const normal = new Vector3();
  const edge = new Vector3();
  const across = new Vector3();
  const along = new Vector3();
  const color = new Color();
  const UP = new Vector3(0, 1, 0);

  function patchOf(swatch: Swatch): number {
    let index = patches.indexOf(swatch);
    if (index < 0) index = patches.push(swatch) - 1;
    return index;
  }

  function node(at: Vector3, n: Vector3, paint: Paint, tint: Vec3 | null, reach: number): number {
    nodeAt.push(at.x, at.y, at.z);
    nodeNormal.push(n.x, n.y, n.z);
    nodePaint.push(paint);
    nodeTint.push(tint);
    nodeReach.push(reach);
    return nodePaint.length - 1;
  }

  function looseNode(at: Vector3, n: Vector3, paint: Paint, tint: Vec3 | null): number {
    const key = `${paint.id}|${Math.round(at.x * 500)}|${Math.round(at.y * 500)}|${Math.round(at.z * 500)}|${Math.round(n.x * 4)}|${Math.round(n.y * 4)}|${Math.round(n.z * 4)}|${tint ? tint.join() : ''}`;
    let index = loose.get(key);
    if (index === undefined) {
      index = node(at, n, paint, tint, 0);
      loose.set(key, index);
    }
    return index;
  }

  /** The patch lies flat on the surface: across is level, along runs up it. */
  function axes(n: Vector3): void {
    if (Math.abs(n.y) > 0.9) across.set(1, 0, 0);
    else across.crossVectors(UP, n).normalize();
    along.crossVectors(n, across);
  }

  function vertex(
    at: Vector3,
    n: Vector3,
    paint: Paint,
    index: number,
    owning: number,
    u = at.dot(across) / paint.swatch.metres[0],
    v = at.dot(along) / paint.swatch.metres[1],
  ): void {
    positions.push(at.x, at.y, at.z);
    normals.push(n.x, n.y, n.z);
    ids.push(paint.id);
    seen.push(paint.id, paint.raw ? 2 : paint.exact === true && paint.painted !== false ? 1 : 0);
    patch.push(index, u, v);
    owner.push(owning);
  }

  function facing(a: Vec3, b: Vec3, d: Vec3, options: QuadOptions | undefined): boolean {
    p[0].set(...a);
    normal.subVectors(p[1].set(...b), p[0]).cross(edge.set(...d).sub(p[0]));
    if (options?.toward) return normal.dot(edge.set(...options.toward).sub(p[0])) >= 0;
    if (options?.away) return normal.dot(edge.set(...options.away).sub(p[0])) <= 0;
    return true;
  }

  return {
    positions,
    ids,
    quad(a, b0, c, d0, paint, options) {
      const keep = facing(a, b0, d0, options);
      const b = keep ? b0 : d0;
      const d = keep ? d0 : b0;
      p[0].set(...a);
      p[1].set(...b);
      p[2].set(...c);
      p[3].set(...d);
      normal.subVectors(p[1], p[0]).cross(edge.subVectors(p[3], p[0]));
      if (normal.lengthSq() < 1e-14) return;
      normal.normalize();
      axes(normal);
      const cell = options?.cell ?? Number.POSITIVE_INFINITY;
      const wide = Math.max(p[0].distanceTo(p[1]), p[3].distanceTo(p[2]));
      const tall = Math.max(p[0].distanceTo(p[3]), p[1].distanceTo(p[2]));
      const nu = Math.min(400, Math.max(1, Math.ceil(wide / cell)));
      const nv = Math.min(400, Math.max(1, Math.ceil(tall / cell)));
      const first = nodePaint.length;
      const at = new Vector3();
      const low = new Vector3();
      const high = new Vector3();
      const reach = 0.6 * Math.max(wide / nu, tall / nv);
      for (let j = 0; j <= nv; j++) {
        low.lerpVectors(p[0], p[3], j / nv);
        high.lerpVectors(p[1], p[2], j / nv);
        for (let i = 0; i <= nu; i++) {
          node(at.lerpVectors(low, high, i / nu), normal, paint, null, reach);
        }
      }
      grids.push({ first, across: nu + 1, up: nv + 1, cell: Math.max(wide / nu, tall / nv) });
      const index = patchOf(paint.swatch);
      const corner = (i: number, j: number): void => {
        const n = first + j * (nu + 1) + i;
        vertex(
          at.set(nodeAt[n * 3], nodeAt[n * 3 + 1], nodeAt[n * 3 + 2]),
          normal,
          paint,
          index,
          n,
        );
      };
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          corner(i, j);
          corner(i + 1, j);
          corner(i + 1, j + 1);
          corner(i, j);
          corner(i + 1, j + 1);
          corner(i, j + 1);
        }
      }
    },
    triangle(a, b0, c0, paint, options) {
      const keep = facing(a, b0, c0, options);
      const corners = [a, keep ? b0 : c0, keep ? c0 : b0];
      p[0].set(...corners[0]);
      p[1].set(...corners[1]);
      p[2].set(...corners[2]);
      normal.subVectors(p[1], p[0]).cross(edge.subVectors(p[2], p[0]));
      if (normal.lengthSq() < 1e-14) return;
      normal.normalize();
      axes(normal);
      const index = patchOf(paint.swatch);
      for (let k = 0; k < 3; k++)
        vertex(p[k], normal, paint, index, looseNode(p[k], normal, paint, null));
    },
    mesh(source, matrix, paint, options) {
      const flat = source.index ? source.toNonIndexed() : source;
      const position = flat.getAttribute('position');
      const ink = options?.own ? flat.getAttribute('color') : null;
      const laid = options?.uvScale ? flat.getAttribute('uv') : null;
      const [su, sv] = options?.uvScale ?? [1, 1];
      const index = patchOf(paint.swatch);
      for (let i = 0; i < position.count; i += 3) {
        for (let k = 0; k < 3; k++) {
          p[k].fromBufferAttribute(position, i + k);
          if (matrix) p[k].applyMatrix4(matrix);
        }
        normal.subVectors(p[1], p[0]).cross(edge.subVectors(p[2], p[0]));
        if (normal.lengthSq() < 1e-14) continue;
        normal.normalize();
        axes(normal);
        for (let k = 0; k < 3; k++) {
          const tint: Vec3 | null = ink
            ? [ink.getX(i + k), ink.getY(i + k), ink.getZ(i + k)]
            : null;
          const owning = looseNode(p[k], normal, paint, tint);
          if (laid) {
            vertex(
              p[k],
              normal,
              paint,
              index,
              owning,
              laid.getX(i + k) * su,
              laid.getY(i + k) * sv,
            );
          } else vertex(p[k], normal, paint, index, owning);
        }
      }
      if (flat !== source) flat.dispose();
    },
    *bake(view) {
      const count = nodePaint.length;
      const colours = new Float32Array(count * 3);
      const known = new Float32Array(count);
      const tints = new Float32Array(count * 3);
      const out: [number, number, number] = [0, 0, 0];
      const tangent = new Vector3();
      const bitangent = new Vector3();
      const n = new Vector3();
      const tintOf = new Map<number, Vec3>();
      let gathered = 0;
      for (let i = 0; i < count; i++) {
        const paint = nodePaint[i];
        const x = nodeAt[i * 3];
        const y = nodeAt[i * 3 + 1];
        const z = nodeAt[i * 3 + 2];
        n.set(nodeNormal[i * 3], nodeNormal[i * 3 + 1], nodeNormal[i * 3 + 2]);
        let tint = nodeTint[i];
        if (!tint) {
          tint = tintOf.get(paint.tint) ?? null;
          if (!tint) {
            tint = color.setHex(paint.tint).toArray() as unknown as Vec3;
            tintOf.set(paint.tint, tint);
          }
        }
        const dim = paint.lit ? 1 : shade(n.y, n.x, n.z);
        tints[i * 3] = tint[0] * dim;
        tints[i * 3 + 1] = tint[1] * dim;
        tints[i * 3 + 2] = tint[2] * dim;
        if (paint.painted === false) continue;
        const hit = toCanvas([x, y, z]);
        if (!(hit.depth > 0.2)) continue;
        const dx = PAINTER_EYE[0] - x;
        const dy = PAINTER_EYE[1] - y;
        const dz = PAINTER_EYE[2] - z;
        const distance = Math.hypot(dx, dy, dz);
        const cosine = (n.x * dx + n.y * dy + n.z * dz) / distance;
        if (cosine <= 0.02 && !paint.round) continue;
        // Wide enough that its narrow side on the canvas still spans a few pixels of the scan.
        const stretch = 1 / Math.max(Math.abs(cosine), 0.04);
        const radius = Math.min(
          GATHER_MAX,
          Math.max(
            nodeReach[i],
            paint.round ? 0.03 : 0.05,
            (GATHER_PIXELS * distance * stretch) / (CANVAS_LENS[1] * SCAN_ROWS),
          ),
        );
        if (Math.abs(n.y) > 0.9) tangent.set(1, 0, 0);
        else tangent.crossVectors(UP, n).normalize();
        bitangent.crossVectors(n, tangent);
        let hits = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (const [s, t] of GATHER_POINTS) {
          const at = toCanvas([
            x + radius * (s * tangent.x + t * bitangent.x),
            y + radius * (s * tangent.y + t * bitangent.y),
            z + radius * (s * tangent.z + t * bitangent.z),
          ]);
          if (!(at.depth > 0.05)) continue;
          const named = paint.round ? view.idAt(at.u, at.v) : view.setIdAt(at.u, at.v);
          if (named !== paint.id) continue;
          view.colourAt(at.u, at.v, out);
          r += out[0];
          g += out[1];
          b += out[2];
          hits++;
        }
        if (hits > 0) {
          colours[i * 3] = r / hits;
          colours[i * 3 + 1] = g / hits;
          colours[i * 3 + 2] = b / hits;
          known[i] = hits / GATHER_POINTS.length;
        }
        if (++gathered % 1500 === 0) yield;
      }

      // A grid carries its paint on over what the painter could not see, fading into the tint.
      const reached = new Float32Array(count).fill(-1);
      let filled = 0;
      for (const { first, across: wide, up: tall, cell } of grids) {
        let frontier: number[] = [];
        for (let k = first; k < first + wide * tall; k++) {
          if (known[k] >= KNOWN) reached[k] = 0;
        }
        for (let k = first; k < first + wide * tall; k++) if (reached[k] === 0) frontier.push(k);
        const limit = Math.ceil(CARRY / cell);
        for (let step = 1; step <= limit && frontier.length > 0; step++) {
          const next: number[] = [];
          const sums = new Map<number, [number, number, number, number]>();
          for (const k of frontier) {
            const i = (k - first) % wide;
            const j = Math.floor((k - first) / wide);
            for (const [di, dj] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]) {
              const ni = i + di;
              const nj = j + dj;
              if (ni < 0 || nj < 0 || ni >= wide || nj >= tall) continue;
              const m = first + nj * wide + ni;
              if (reached[m] >= 0) continue;
              let sum = sums.get(m);
              if (!sum) {
                sum = [0, 0, 0, 0];
                sums.set(m, sum);
              }
              sum[0] += colours[k * 3];
              sum[1] += colours[k * 3 + 1];
              sum[2] += colours[k * 3 + 2];
              sum[3]++;
            }
          }
          for (const [m, [r, g, b, hits]] of sums) {
            colours[m * 3] = r / hits;
            colours[m * 3 + 1] = g / hits;
            colours[m * 3 + 2] = b / hits;
            reached[m] = step;
            next.push(m);
          }
          frontier = next;
        }
        for (let k = first; k < first + wide * tall; k++) {
          if (reached[k] < 0) known[k] = 0;
          else if (reached[k] > 0) {
            const t = Math.min(1, (reached[k] * cell) / CARRY);
            known[k] = 1 - t * t * (3 - 2 * t);
          } else known[k] = 1;
        }
        filled += wide * tall;
        if (filled >= 6000) {
          filled = 0;
          yield;
        }
      }

      yield;
      for (let i = 0; i < count; i++) {
        // A loose point with a thin gather leans on its tint.
        const weight =
          reached[i] >= 0 ? known[i] : Math.min(1, Math.max(0, (known[i] - 0.08) / 0.3));
        for (let k = 0; k < 3; k++) {
          colours[i * 3 + k] = tints[i * 3 + k] + (colours[i * 3 + k] - tints[i * 3 + k]) * weight;
        }
      }
      local = colours;
    },
    *build() {
      if (!local) throw new Error('Bake the paint before building it');
      const colours = new Float32Array(owner.length * 3);
      for (let i = 0; i < owner.length; i++) {
        colours[i * 3] = local[owner[i] * 3];
        colours[i * 3 + 1] = local[owner[i] * 3 + 1];
        colours[i * 3 + 2] = local[owner[i] * 3 + 2];
      }
      yield;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      yield;
      geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
      yield;
      geometry.setAttribute('aLocal', new Float32BufferAttribute(colours, 3));
      geometry.setAttribute('aSeen', new Float32BufferAttribute(seen, 2));
      yield;
      geometry.setAttribute('aPatch', new Float32BufferAttribute(patch, 3));
      geometry.computeBoundingSphere();
      return geometry;
    },
  };
}
