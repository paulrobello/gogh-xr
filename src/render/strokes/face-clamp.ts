/**
 * Face clamping for strokes scattered on flat-faced geometry (the village and church): a stroke
 * keeps inside its host face plus a small margin instead of overhanging the face's edge into the
 * air, which broke the house silhouettes. Pure geometry, so it runs in unit tests without WebGL.
 *
 * A face is a set of coplanar triangles joined by shared edges, so a quad's internal diagonal and a
 * gable end's eave line (wall rectangle plus gable triangle) never clip a stroke. Every face of the
 * village is convex, so it is held as its convex hull: half-planes `nx·x + ny·y ≤ d` in an in-plane
 * frame. Each hull vertex adds a bevel half-plane across its bisector, grown by less than the sides,
 * so a quad corner can never sit further than the margin from the face even beside a sharp vertex.
 *
 * What is clamped is the stroke's painted footprint, not its quad: a brush's opaque mask spans only
 * part of its quad (BRUSH_FOOTPRINT), and the transparent border around it may overhang freely.
 * Clamping the whole quad held the paint a quarter of a stroke inside every edge and left a band
 * of bare base mesh along each one.
 *
 * The rule, per stroke, with the face grown by the margin, 10% of the clamped footprint's own width
 * (`clampToFaceByWidth`):
 * 1. Across: if the stroke's width overhangs a side, it moves across by the overhang. Where the face
 *    is narrower than the stroke there, the stroke narrows to the face and centres in it.
 * 2. Along: on the line through the stroke along its axis, if the face has room for the full length,
 *    the stroke slides inward along its axis just enough to fit. Otherwise it shrinks to the room
 *    and centres in it, and it is never left wider than it is long.
 * 3. Fit scale: the largest factor about the new centre at which the stroke still fits. The shader
 *    multiplies stroke sizes by a distance-band factor (bands.ts), so the scatter stores this limit
 *    in the stroke's flag bits (`encodeFitScale`) and the shader caps the factor at it.
 */
import type { BufferGeometry } from 'three';
import type { BrushKind } from './brush-atlas-data';
import type { Vec3 } from './frame';

type Vec2 = readonly [number, number];

/** Margin a clamped stroke may reach past its face, as a share of the stroke's painted width. */
export const FACE_CLAMP_MARGIN: number = 0.1;

/**
 * The painted footprint of each brush kind, centred in its quad: the share of the quad's length
 * and width that the opaque coverage mask spans (brush-atlas-data.ts). Each is the largest
 * symmetric bounding box measured over atlas seeds 1–12, rounded up, so the footprint holds the
 * paint of every variant and seed.
 */
export const BRUSH_FOOTPRINT: Readonly<
  Record<BrushKind, { readonly length: number; readonly width: number }>
> = Object.freeze({
  ridge: Object.freeze({ length: 0.92, width: 0.73 }),
  bristle: Object.freeze({ length: 0.94, width: 0.81 }),
  dab: Object.freeze({ length: 0.69, width: 0.75 }),
  comma: Object.freeze({ length: 0.8, width: 0.53 }),
  crescent: Object.freeze({ length: 0.86, width: 0.55 }),
});

/** First bit of the fit scale field in a stroke's spare meta byte (`iMeta.w`), above the depth flags. */
export const FIT_SCALE_SHIFT: number = 2;
/** The fit scale field holds 4 bits: 0 is no limit, level k ≥ 1 caps the size factor. */
export const FIT_SCALE_MASK: number = 15;
/** Size-factor step between fit levels: level k caps the factor at 1 + (k − 1) × step. */
export const FIT_SCALE_STEP: number = 1 / 16;
/** The highest cap a level encodes. A stroke with more room than this is capped here too. */
export const FIT_SCALE_MAX: number = 1 + (FIT_SCALE_MASK - 1) * FIT_SCALE_STEP;

/** Flag bits that cap a stroke's size factor at `fit` rounded down to a level, at least 1. */
export function encodeFitScale(fit: number): number {
  const level = Math.min(FIT_SCALE_MASK, Math.max(1, Math.floor((fit - 1) / FIT_SCALE_STEP) + 1));
  return level << FIT_SCALE_SHIFT;
}

/** The size-factor cap that `flags` encodes; infinite when its fit field is 0. */
export function fitScaleLimit(flags: number): number {
  const level = (flags >> FIT_SCALE_SHIFT) & FIT_SCALE_MASK;
  return level === 0 ? Number.POSITIVE_INFINITY : 1 + (level - 1) * FIT_SCALE_STEP;
}

export interface FaceEdge {
  /** Outward unit normal in the face frame. */
  readonly nx: number;
  readonly ny: number;
  /** `nx·x + ny·y ≤ d` inside. */
  readonly d: number;
  /**
   * The share of the margin this half-plane grows by: 1 for a side, cos(half the turn) for a vertex
   * bevel, which puts the grown bevel through the two grown sides' feet on the vertex, within the
   * margin of it.
   */
  readonly marginScale: number;
}

export interface FacePolygon {
  /** Frame origin, a vertex of the face, world metres. */
  readonly origin: Vec3;
  /** Unit outward normal of the face. */
  readonly normal: Vec3;
  /** In-plane unit axes, `e2 = normal × e1`. */
  readonly e1: Vec3;
  readonly e2: Vec3;
  /** Convex hull, counter-clockwise in (e1, e2). */
  readonly vertices: readonly Vec2[];
  /** One half-plane per hull side, in vertex order, then one bevel per hull vertex. */
  readonly edges: readonly FaceEdge[];
  /** Summed area of the face's triangles, m². */
  readonly area: number;
  /** Area of the hull, m². Equal to `area` when the face is convex. */
  readonly hullArea: number;
}

export interface FaceSet {
  /** Face index of every triangle, or -1 for a zero-area triangle, which belongs to no face. */
  readonly faceOf: Int32Array;
  readonly faces: readonly FacePolygon[];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Normals this close (1 − cos) are coplanar candidates. */
const NORMAL_TOLERANCE = 1e-6;
/** Plane offsets this close, metres, are the same plane. */
const PLANE_TOLERANCE = 1e-3;
/** Vertex positions are matched on this grid, metres. */
const WELD = 1e-4;

const vertexKey = (p: Vec3): string =>
  `${Math.round(p[0] / WELD)},${Math.round(p[1] / WELD)},${Math.round(p[2] / WELD)}`;

/** Andrew's monotone chain; counter-clockwise, no collinear points. */
function convexHull(points: readonly Vec2[]): Vec2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts: readonly Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of pts) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= 1e-12) {
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/**
 * The faces of a flat-faced triangle mesh, indexed or not: triangles joined by a shared edge and
 * lying in one plane with one facing form a face, held as its convex hull. A zero-area triangle has
 * no normal, so it joins no face and gets none.
 */
export function facePolygons(geometry: BufferGeometry): FaceSet {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = Math.floor((index ? index.count : position.count) / 3);
  const corner = (t: number, k: number): Vec3 => {
    const i = index ? index.getX(t * 3 + k) : t * 3 + k;
    return [position.getX(i), position.getY(i), position.getZ(i)];
  };
  const tris: Vec3[][] = [];
  const normals: Vec3[] = [];
  const offsets: number[] = [];
  const areas: number[] = [];
  const parent = new Int32Array(count);
  const hasArea: boolean[] = [];
  for (let t = 0; t < count; t++) {
    const p = [corner(t, 0), corner(t, 1), corner(t, 2)];
    const c = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    const len = Math.hypot(c[0], c[1], c[2]);
    const n: Vec3 = len > 0 ? [c[0] / len, c[1] / len, c[2] / len] : [0, 0, 0];
    tris.push(p);
    normals.push(n);
    offsets.push(dot(n, p[0]));
    areas.push(len / 2);
    hasArea.push(len > 0);
    parent[t] = t;
  }
  const find = (t: number): number => {
    let r = t;
    while (parent[r] !== r) r = parent[r];
    while (parent[t] !== r) {
      const next = parent[t];
      parent[t] = r;
      t = next;
    }
    return r;
  };
  const edges = new Map<string, number[]>();
  for (let t = 0; t < count; t++) {
    if (!hasArea[t]) continue;
    const keys = tris[t].map(vertexKey);
    for (let k = 0; k < 3; k++) {
      const a = keys[k];
      const b = keys[(k + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const list = edges.get(key);
      if (list) list.push(t);
      else edges.set(key, [t]);
    }
  }
  for (const list of edges.values()) {
    for (let i = 1; i < list.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = list[i];
        const b = list[j];
        const coplanar =
          1 - dot(normals[a], normals[b]) < NORMAL_TOLERANCE &&
          Math.abs(offsets[a] - offsets[b]) < PLANE_TOLERANCE;
        if (coplanar) parent[find(a)] = find(b);
      }
    }
  }

  const faceOf = new Int32Array(count);
  const groupFace = new Map<number, number>();
  const groups: number[][] = [];
  for (let t = 0; t < count; t++) {
    if (!hasArea[t]) {
      faceOf[t] = -1;
      continue;
    }
    const root = find(t);
    let f = groupFace.get(root);
    if (f === undefined) {
      f = groups.length;
      groupFace.set(root, f);
      groups.push([]);
    }
    groups[f].push(t);
    faceOf[t] = f;
  }

  const faces = groups.map((group): FacePolygon => {
    const first = group[0];
    const normal = normals[first];
    const origin = tris[first][0];
    const e1 = unit(sub(tris[first][1], origin));
    const e2 = cross(normal, e1);
    const points: Vec2[] = [];
    let area = 0;
    for (const t of group) {
      area += areas[t];
      for (const p of tris[t]) {
        const r = sub(p, origin);
        points.push([dot(r, e1), dot(r, e2)]);
      }
    }
    const vertices = convexHull(points);
    let hullArea = 0;
    const sides: FaceEdge[] = vertices.map((p, i) => {
      const q = vertices[(i + 1) % vertices.length];
      hullArea += (p[0] * q[1] - q[0] * p[1]) / 2;
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy);
      const nx = dy / len;
      const ny = -dx / len;
      return { nx, ny, d: nx * p[0] + ny * p[1], marginScale: 1 };
    });
    // Vertex i joins side i - 1 (arriving) and side i (leaving).
    const bevels: FaceEdge[] = vertices.map((p, i) => {
      const a = sides[(i + sides.length - 1) % sides.length];
      const b = sides[i];
      const bx = a.nx + b.nx;
      const by = a.ny + b.ny;
      const len = Math.hypot(bx, by);
      const nx = bx / len;
      const ny = by / len;
      return { nx, ny, d: nx * p[0] + ny * p[1], marginScale: a.nx * nx + a.ny * ny };
    });
    return { origin, normal, e1, e2, vertices, edges: [...sides, ...bevels], area, hullArea };
  });
  return { faceOf, faces };
}

export interface StrokeRect {
  /** Stroke centre on the face, world metres. */
  readonly centre: Vec3;
  /** Unit long axis, in the face plane. */
  readonly long: Vec3;
  /** Quad length along `long` and width across it, metres. */
  readonly length: number;
  readonly width: number;
}

export interface ClampedStroke {
  readonly centre: Vec3;
  readonly length: number;
  readonly width: number;
  /** Largest size factor about `centre` at which the quad stays inside the grown face. */
  readonly fitScale: number;
}

const PARALLEL = 1e-9;

/** The interval of s where `point + s·dir` meets every half-plane grown by `margin`. */
function lineInterval(
  face: FacePolygon,
  point: Vec2,
  dir: Vec2,
  margin: number,
): readonly [number, number] {
  let lo = Number.NEGATIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;
  for (const e of face.edges) {
    const k = e.nx * dir[0] + e.ny * dir[1];
    const room = e.d + margin * e.marginScale - (e.nx * point[0] + e.ny * point[1]);
    if (k > PARALLEL) hi = Math.min(hi, room / k);
    else if (k < -PARALLEL) lo = Math.max(lo, room / k);
  }
  return [lo, hi];
}

/** Clamps `stroke` into `face` grown by `margin` metres, by the rule in this module's header. */
export function clampToFace(face: FacePolygon, stroke: StrokeRect, margin: number): ClampedStroke {
  const r = sub(stroke.centre, face.origin);
  const c: Vec2 = [dot(r, face.e1), dot(r, face.e2)];
  const lift = dot(r, face.normal);
  const ux = dot(stroke.long, face.e1);
  const uy = dot(stroke.long, face.e2);
  const ul = Math.hypot(ux, uy);
  const u: Vec2 = [ux / ul, uy / ul];
  const v: Vec2 = [-u[1], u[0]];
  const a = stroke.length / 2;
  let b = stroke.width / 2;

  // 1. Across: the centreline point needs `b` of room on both sides along v. Each half-plane's
  // bound on the shift s moves by exactly b, so the room at width b is [lo + b, hi - b].
  const [lo0, hi0] = lineInterval(face, c, v, margin);
  let s: number;
  if (lo0 + b <= hi0 - b) s = Math.min(Math.max(0, lo0 + b), hi0 - b);
  else {
    b = Math.max(0, (hi0 - lo0) / 2);
    s = (lo0 + hi0) / 2;
  }
  const c1: Vec2 = [c[0] + s * v[0], c[1] + s * v[1]];

  // 2. Along: the room for the centreline, each half-plane tightened by the half-width's reach.
  let t0 = Number.NEGATIVE_INFINITY;
  let t1 = Number.POSITIVE_INFINITY;
  for (const e of face.edges) {
    const k = e.nx * u[0] + e.ny * u[1];
    const reach = b * Math.abs(e.nx * v[0] + e.ny * v[1]);
    const room = e.d + margin * e.marginScale - reach - (e.nx * c1[0] + e.ny * c1[1]);
    if (k > PARALLEL) t1 = Math.min(t1, room / k);
    else if (k < -PARALLEL) t0 = Math.max(t0, room / k);
  }
  let half = a;
  let t: number;
  if (t1 - t0 >= 2 * a) t = Math.min(Math.max(0, t0 + a), t1 - a);
  else {
    half = Math.max(0, (t1 - t0) / 2);
    t = (t0 + t1) / 2;
  }
  b = Math.min(b, half);
  const c2: Vec2 = [c1[0] + t * u[0], c1[1] + t * u[1]];

  // 3. Fit scale about the new centre.
  let fitScale = Number.POSITIVE_INFINITY;
  for (const e of face.edges) {
    const reach =
      half * Math.abs(e.nx * u[0] + e.ny * u[1]) + b * Math.abs(e.nx * v[0] + e.ny * v[1]);
    if (reach <= PARALLEL) continue;
    fitScale = Math.min(
      fitScale,
      (e.d + margin * e.marginScale - (e.nx * c2[0] + e.ny * c2[1])) / reach,
    );
  }

  const unchanged = s === 0 && t === 0;
  const centre: Vec3 = unchanged
    ? stroke.centre
    : ([0, 1, 2].map(
        (k) => face.origin[k] + c2[0] * face.e1[k] + c2[1] * face.e2[k] + lift * face.normal[k],
      ) as unknown as Vec3);
  return {
    centre,
    length: half === a ? stroke.length : 2 * half,
    width: b === stroke.width / 2 ? stroke.width : 2 * b,
    fitScale,
  };
}

/** Passes `clampToFaceByWidth` allows; each narrows the stroke less than the last. */
const WIDTH_PASSES = 8;

/**
 * Clamps `stroke` into `face` grown by `marginRatio` of the clamped stroke's own width. A stroke
 * that narrows is clamped again at the margin of its new width, until a pass leaves its width as it
 * was, so the margin is that share of the final width (within the pass limit).
 */
export function clampToFaceByWidth(
  face: FacePolygon,
  stroke: StrokeRect,
  marginRatio: number,
): ClampedStroke {
  let rect = stroke;
  let out = clampToFace(face, rect, marginRatio * rect.width);
  for (let pass = 1; pass < WIDTH_PASSES && out.width < rect.width; pass++) {
    rect = { centre: out.centre, long: stroke.long, length: out.length, width: out.width };
    out = clampToFace(face, rect, marginRatio * rect.width);
  }
  return out;
}

export interface FittedStroke extends ClampedStroke {
  /** Unit long axis after the fit, in the face plane. */
  readonly long: Vec3;
  /** True when the stroke was turned to run along a side of its face. */
  readonly aligned: boolean;
}

/** Protrusions this close, metres, are a tie. */
const TIE = 1e-9;

/**
 * The side that a rectangle reaches furthest past, or -1 when it stays inside every side. Of two
 * sides it reaches equally far past, as in a corner, the one it already runs most nearly along.
 */
function protrudingSide(face: FacePolygon, c: Vec2, u: Vec2, a: number, b: number): number {
  let side = -1;
  let most = 0;
  let turn = 0;
  for (let i = 0; i < face.vertices.length; i++) {
    const e = face.edges[i];
    const across = Math.abs(e.nx * u[0] + e.ny * u[1]);
    const out =
      e.nx * c[0] + e.ny * c[1] + a * across + b * Math.abs(e.nx * u[1] - e.ny * u[0]) - e.d;
    if (out <= 0) continue;
    if (side < 0 || out > most + TIE || (out > most - TIE && across < turn)) {
      side = i;
      most = Math.max(most, out);
      turn = across;
    }
  }
  return side;
}

/**
 * Fits `stroke` into `face` by `clampToFaceByWidth`, then turns a stroke whose fitted footprint
 * still reaches past a side to run along that side. A brush's rounded ends then fall along the
 * edge instead of across it, and its straighter long side covers the face up to the edge. The
 * turned stroke keeps the way it pointed, keeps its scattered place along the side, moves across
 * so its outer side lies on the side plus the margin, and is clamped again at its original size.
 */
export function fitStrokeToFace(
  face: FacePolygon,
  stroke: StrokeRect,
  marginRatio: number,
): FittedStroke {
  const first = clampToFaceByWidth(face, stroke, marginRatio);
  const r = sub(first.centre, face.origin);
  const c: Vec2 = [dot(r, face.e1), dot(r, face.e2)];
  const ux = dot(stroke.long, face.e1);
  const uy = dot(stroke.long, face.e2);
  const ul = Math.hypot(ux, uy);
  const u: Vec2 = [ux / ul, uy / ul];
  const side = protrudingSide(face, c, u, first.length / 2, first.width / 2);
  if (side < 0) return { ...first, long: stroke.long, aligned: false };

  const e = face.edges[side];
  let dx = -e.ny;
  let dy = e.nx;
  if (dx * u[0] + dy * u[1] < 0) {
    dx = -dx;
    dy = -dy;
  }
  const long = [0, 1, 2].map((k) => dx * face.e1[k] + dy * face.e2[k]) as unknown as Vec3;
  const r0 = sub(stroke.centre, face.origin);
  const c0: Vec2 = [dot(r0, face.e1), dot(r0, face.e2)];
  const inset = e.d + marginRatio * stroke.width - stroke.width / 2 - (e.nx * c0[0] + e.ny * c0[1]);
  const p: Vec2 = [c0[0] + inset * e.nx, c0[1] + inset * e.ny];
  const lift = dot(r0, face.normal);
  const centre = [0, 1, 2].map(
    (k) => face.origin[k] + p[0] * face.e1[k] + p[1] * face.e2[k] + lift * face.normal[k],
  ) as unknown as Vec3;
  const turned = clampToFaceByWidth(
    face,
    { centre, long, length: stroke.length, width: stroke.width },
    marginRatio,
  );
  return { ...turned, long, aligned: true };
}
