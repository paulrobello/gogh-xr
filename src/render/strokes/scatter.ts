/**
 * Surface stroke scattering (P2.6): covers layer-tagged world geometry with strokes whose colour
 * and direction come from the painting through the painter's camera, extrapolated outside the
 * frame. Pure and deterministic per seed, so it runs in unit tests without WebGL. The output feeds
 * `createStrokeBatch`, which does the chunking.
 *
 * Sampling is stratified and area weighted, per triangle: a triangle of area a at density d (taken
 * at its centroid's distance from PAINTER_EYE) gets floor(a·d) strokes plus one more with
 * probability frac(a·d), each at a uniform barycentric point. Stroke size grows with distance and
 * density falls as 1 / size², so coverage per unit solid angle seen from the painter's spot stays
 * roughly constant.
 */

import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute } from 'three';
import { Color, LinearSRGBColorSpace, SRGBColorSpace } from 'three';
import {
  canvasTangent,
  decodedNormal,
  REGION_STYLES,
  strokeShade,
} from '../../demo/canvas/placement';
import {
  CANVAS_PITCH,
  LAYER_REGION,
  PAINTER_EYE,
  type WorldLayer,
} from '../../paintings/starry-night/canvas-camera';
import { type CanvasSource, sampleCanvas } from '../../paintings/starry-night/canvas-histogram';
import { mulberry32 } from '../../util/prng';
import { DEPTH_BACKDROP_FLAG } from './backdrop-depth';
import { BRUSHES, type BrushKind } from './brush-atlas-data';
import { DEPTH_RANKED_FLAG, DEPTH_TIE_BREAK_FRONT_FLAG, sizeShare } from './depth-tie-break';
import {
  BRUSH_FOOTPRINT,
  encodeFitScale,
  FACE_CLAMP_MARGIN,
  type FacePolygon,
  type FaceSet,
  facePolygons,
  fitStrokeToFace,
} from './face-clamp';
import { strokeAxes, surfaceBasis, type Vec3 } from './frame';
import { createStrokeBuffers, packInstance, type StrokeBuffers } from './instance';

/** Bump when the scatter's output changes for the same inputs; part of the cache key. */
export const SCATTER_VERSION: number = 6;

/** The fixed processing order of the layers. */
export const WORLD_LAYERS: readonly WorldLayer[] = Object.freeze([
  'terrain',
  'building',
  'roof',
  'window',
  'church',
  'cypress',
  'sky',
  'haze',
] as const);

/**
 * Distance-graded stroke length: `slope × distance from PAINTER_EYE`, clamped to [near, far]
 * metres. `slope` is about the stroke's angular length in radians, so unclamped strokes keep a
 * constant arc seen from the painter's spot.
 */
export interface GradedSize {
  readonly near: number;
  readonly far: number;
  readonly slope: number;
}

/**
 * Mean stroke length per layer; the width is the length times the brush aspect. The near ground
 * gets about 2.5° strokes, and the village, cypress and sky about 1°. The far clamp keeps the
 * ridge (83-105 m) to 3 m strokes, which makes it sparse. The Starry Night world scatters at
 * these sizes times `WORLD_SIZE_SCALE` (src/paintings/starry-night/world.ts), about 4.5° strokes on
 * the near ground, with face normals and the ridge's own `RIDGE_SCATTER`.
 */
export const LAYER_SIZE: Readonly<Record<WorldLayer, GradedSize>> = Object.freeze({
  terrain: Object.freeze({ near: 0.07, far: 3, slope: 0.0437 }),
  building: Object.freeze({ near: 0.2, far: 0.8, slope: 0.0175 }),
  roof: Object.freeze({ near: 0.2, far: 0.8, slope: 0.0175 }),
  window: Object.freeze({ near: 0.12, far: 0.45, slope: 0.0105 }),
  church: Object.freeze({ near: 0.2, far: 0.8, slope: 0.0122 }),
  cypress: Object.freeze({ near: 0.1, far: 0.5, slope: 0.0175 }),
  sky: Object.freeze({ near: 1, far: 4, slope: 0.0184 }),
  haze: Object.freeze({ near: 3, far: 3, slope: 0 }),
});

/**
 * Strokes per m² where a layer's strokes are at their near size. Elsewhere the density falls as
 * (near / size)², so density × quad area stays about 5 per m², the overdraw the 25-50% brush masks
 * need (placement.ts). The default world stores well under the 900k ceiling (P0.8 budget, P2.6
 * ruling). Haze is not a surface: `createBoundaryHaze` emits it. The P2.7 coverage sweep kept
 * these densities and scaled the sizes instead (`WORLD_SIZE_SCALE` in
 * src/paintings/starry-night/world.ts).
 */
export const LAYER_DENSITY: Readonly<Record<WorldLayer, number>> = Object.freeze({
  terrain: 2000,
  building: 200,
  roof: 200,
  window: 560,
  church: 250,
  cypress: 1000,
  sky: 7.6,
  haze: 0,
});

/**
 * Layers whose strokes are clamped into their host face (face-clamp.ts): the flat-faced village and
 * church, where a stroke overhanging a face edge breaks the silhouette. Terrain, cypress and sky
 * strokes may overhang: their surfaces continue past each triangle.
 */
export const FACE_CLAMPED_LAYERS: readonly WorldLayer[] = Object.freeze([
  'building',
  'roof',
  'window',
  'church',
] as const);

/**
 * Layers whose face sides get a row of outline strokes: the walls, roofs and church, not the window
 * panes. A clamped stroke's rounded ends keep its paint off the edges, and the base mesh showed
 * through along them; Van Gogh draws the village in dark contours, which also cover that rim.
 */
export const OUTLINED_LAYERS: readonly WorldLayer[] = Object.freeze([
  'building',
  'roof',
  'church',
] as const);

/** Outline strokes come to at most this share of the FACE_CLAMPED_LAYERS strokes. */
export const OUTLINE_SHARE: number = 0.05;

/** An outline stroke's colour is the canvas colour sampled at the edge times this. */
export const OUTLINE_DARKEN: number = 0.75;

/** Outline strokes sit this share of their graded length apart along a side, within the budget. */
const OUTLINE_SPACING = 0.8;

/** Brush kinds an outline stroke may use: the long, straight-sided ones, where the style has them. */
const OUTLINE_KINDS: readonly BrushKind[] = ['ridge', 'bristle'];

/** Stroke length varies uniformly by ± this share of the graded size. */
export const SCATTER_SIZE_JITTER: number = 0.15;
/** Strokes lift off the surface along the normal by up to this share of their length. */
export const SCATTER_DEPTH_JITTER: number = 0.02;

/** Mean stroke length at `distance` metres from PAINTER_EYE. */
export function strokeSizeAt(size: GradedSize, distance: number): number {
  return Math.min(size.far, Math.max(size.near, size.slope * distance));
}

/** Strokes per m² at `distance`, for `density` at the near size. */
export function scatterDensityAt(density: number, size: GradedSize, distance: number): number {
  const ratio = size.near / strokeSizeAt(size, distance);
  return density * ratio * ratio;
}

/**
 * Per-mesh override in `geometry.userData.scatter`, applied over the layer's values: for example a
 * sparser ridge with larger strokes. `scatterOverrides` lists them for the cache key.
 */
export interface ScatterOverride {
  /** Strokes per m² at the near size. */
  readonly density?: number;
  readonly size?: Partial<GradedSize>;
}

export interface ScatterOptions {
  readonly seed: number;
  /** Overrides of `LAYER_DENSITY`, strokes per m² at the near size. */
  readonly density?: Readonly<Partial<Record<WorldLayer, number>>>;
  /** Overrides of `LAYER_SIZE`, merged field by field. */
  readonly size?: Readonly<Partial<Record<WorldLayer, Partial<GradedSize>>>>;
}

export interface ScatterTables {
  readonly density: Readonly<Record<WorldLayer, number>>;
  readonly size: Readonly<Record<WorldLayer, GradedSize>>;
}

/**
 * The per-layer density and size every mesh of a layer starts from: `LAYER_DENSITY` and
 * `LAYER_SIZE` with the options' overrides merged in, before any per-mesh `userData.scatter`.
 * `scatterSurfaces` reads these, so a cache key built from them hashes what is scattered.
 */
export function resolveScatterTables(
  options: Pick<ScatterOptions, 'density' | 'size'>,
): ScatterTables {
  const density = {} as Record<WorldLayer, number>;
  const size = {} as Record<WorldLayer, GradedSize>;
  for (const layer of WORLD_LAYERS) {
    density[layer] = options.density?.[layer] ?? LAYER_DENSITY[layer];
    size[layer] = { ...LAYER_SIZE[layer], ...options.size?.[layer] };
  }
  return { density, size };
}

type Attribute = BufferAttribute | InterleavedBufferAttribute;

/** Below this share of |ray| the in-frame mapping is degenerate (surface seen edge-on). */
const EDGE_ON = 0.02;
const COS_P = Math.cos(CANVAS_PITCH);
const SIN_P = Math.sin(CANVAS_PITCH);

function layerOf(geometry: BufferGeometry): WorldLayer {
  const layer = geometry.userData.layer;
  if (typeof layer !== 'string' || !(WORLD_LAYERS as readonly string[]).includes(layer)) {
    throw new TypeError(`geometry userData.layer ${String(layer)} is not a world layer`);
  }
  return layer as WorldLayer;
}

function triangleCount(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  return Math.floor((index ? index.count : geometry.getAttribute('position').count) / 3);
}

function vertexIndex(geometry: BufferGeometry, triangle: number, corner: number): number {
  const index = geometry.getIndex();
  return index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner;
}

function read(attribute: Attribute, i: number): Vec3 {
  return [attribute.getX(i), attribute.getY(i), attribute.getZ(i)];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const eyeDistance = (p: Vec3): number =>
  Math.hypot(p[0] - PAINTER_EYE[0], p[1] - PAINTER_EYE[1], p[2] - PAINTER_EYE[2]);

/** Area of every triangle in m², and its centroid's distance from PAINTER_EYE. */
function triangleTable(geometry: BufferGeometry): { areas: Float64Array; distances: Float64Array } {
  const position = geometry.getAttribute('position');
  const n = triangleCount(geometry);
  const areas = new Float64Array(n);
  const distances = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const a = read(position, vertexIndex(geometry, t, 0));
    const b = read(position, vertexIndex(geometry, t, 1));
    const c = read(position, vertexIndex(geometry, t, 2));
    areas[t] = length(cross(sub(b, a), sub(c, a))) / 2;
    distances[t] = eyeDistance([
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ]);
  }
  return { areas, distances };
}

/** Total triangle area of an indexed or non-indexed geometry, m². */
export function surfaceArea(geometry: BufferGeometry): number {
  return triangleTable(geometry).areas.reduce((sum, a) => sum + a, 0);
}

/**
 * A stream seed per layer, mesh index within the layer and purpose, so retuning one layer leaves
 * the others unchanged and two meshes on one layer never replay each other.
 */
function streamSeed(seed: number, layer: number, mesh: number, stream: number): number {
  let h = seed >>> 0;
  for (const v of [layer, mesh, stream]) {
    h = Math.imul(h ^ (v + 0x9e3779b9), 0x85ebca6b);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

interface Ordered {
  readonly geometry: BufferGeometry;
  readonly layer: WorldLayer;
  readonly layerIndex: number;
  /** Index of the mesh within its layer, in input order. */
  readonly meshIndex: number;
}

/** The meshes by layer in WORLD_LAYERS order, then in input order within a layer. */
function processingOrder(meshes: readonly BufferGeometry[]): Ordered[] {
  const tagged = meshes.map((geometry, order) => ({ geometry, order, layer: layerOf(geometry) }));
  tagged.sort(
    (a, b) => WORLD_LAYERS.indexOf(a.layer) - WORLD_LAYERS.indexOf(b.layer) || a.order - b.order,
  );
  const perLayer = new Map<WorldLayer, number>();
  return tagged.map(({ geometry, layer }) => {
    const meshIndex = perLayer.get(layer) ?? 0;
    perLayer.set(layer, meshIndex + 1);
    return { geometry, layer, layerIndex: WORLD_LAYERS.indexOf(layer), meshIndex };
  });
}

function overrideOf(geometry: BufferGeometry): ScatterOverride | null {
  const o = geometry.userData.scatter;
  return o !== null && typeof o === 'object' ? (o as ScatterOverride) : null;
}

/** Every `userData.scatter` override with its layer and mesh index, for the cache key. */
export function scatterOverrides(
  meshes: readonly BufferGeometry[],
): readonly { layer: WorldLayer; mesh: number; override: ScatterOverride }[] {
  return processingOrder(meshes).flatMap(({ geometry, layer, meshIndex }) => {
    const override = overrideOf(geometry);
    return override ? [{ layer, mesh: meshIndex, override }] : [];
  });
}

/** Display-referred 0-255 bytes of a linear [0, 1] colour. */
function linearToSrgbBytes(rgb: ArrayLike<number>): Vec3 {
  const c = new Color().setRGB(rgb[0], rgb[1], rgb[2], LinearSRGBColorSpace);
  const out = { r: 0, g: 0, b: 0 };
  c.getRGB(out, SRGBColorSpace);
  return [out.r * 255, out.g * 255, out.b * 255];
}

/** The emissive colour an emissive mesh keeps instead of the canvas colour, or null. */
function emissiveColor(geometry: BufferGeometry): Vec3 | null {
  const { emissive, color } = geometry.userData;
  if (emissive !== true || !color || typeof color[0] !== 'number') return null;
  return linearToSrgbBytes(color);
}

/**
 * A stable in-plane frame for extrapolated points: "right" horizontal (up × n), "up" = n × right,
 * so a wall facing +Z gets world +X and +Y as on the canvas. Near-horizontal surfaces, where up × n
 * vanishes, take world X projected into the plane as "right".
 */
function stableFrame(n: Vec3): { right: Vec3; up: Vec3 } {
  let right: Vec3 = [n[2], 0, -n[0]];
  let len = length(right);
  if (len < 0.1) {
    right = [1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]];
    len = length(right);
  }
  right = scale(right, 1 / len);
  return { right, up: cross(n, right) };
}

/**
 * The in-plane direction whose image through the painter's camera runs at painting angle `angle`
 * (from canvas right towards canvas up, aspect corrected, as in placement.ts). It is where the
 * tangent plane meets the plane through the eye spanned by the view ray and the screen direction,
 * which is exact under perspective. Null when the surface is seen nearly edge-on.
 */
function cameraDirection(point: Vec3, n: Vec3, angle: number): Vec3 | null {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Screen right is world +X, screen up is (0, cos p, sin p): canvas-camera.ts.
  const screen: Vec3 = [c, s * COS_P, s * SIN_P];
  const ray = sub(point, PAINTER_EYE);
  const dir = cross(n, cross(ray, screen));
  const len = length(dir);
  if (!(len > EDGE_ON * length(ray))) return null;
  return scale(dir, 1 / len);
}

function checkSize(size: GradedSize, label: string): void {
  if (!(size.near > 0) || !(size.far >= size.near) || !(size.slope >= 0)) {
    throw new RangeError(`bad graded size ${JSON.stringify(size)} for ${label}`);
  }
  if (!Number.isFinite(size.far) || !Number.isFinite(size.slope)) {
    throw new RangeError(`bad graded size ${JSON.stringify(size)} for ${label}`);
  }
}

interface Surface extends Ordered {
  readonly density: number;
  readonly size: GradedSize;
  readonly counts: Uint32Array;
  /** The mesh's faces, on FACE_CLAMPED_LAYERS. */
  readonly faces: FaceSet | null;
  /** Outline strokes per face side, in face then side order, on OUTLINED_LAYERS. */
  outline: Uint32Array | null;
}

/** The 3D position of a face-frame point. */
function facePoint(face: FacePolygon, p: readonly [number, number]): Vec3 {
  return [0, 1, 2].map(
    (k) => face.origin[k] + p[0] * face.e1[k] + p[1] * face.e2[k],
  ) as unknown as Vec3;
}

/**
 * Outline strokes per side: one per OUTLINE_SPACING of the graded stroke length at the side's
 * midpoint, at least one per side, all thinned evenly until they fit `budget`. None when the budget
 * cannot give every side one.
 */
function planOutlines(surfaces: readonly Surface[], budget: number): void {
  const raw: number[] = [];
  for (const { faces, size, outline } of surfaces) {
    if (!faces || !outline) continue;
    for (const face of faces.faces) {
      const n = face.vertices.length;
      for (let i = 0; i < n; i++) {
        const a = facePoint(face, face.vertices[i]);
        const b = facePoint(face, face.vertices[(i + 1) % n]);
        const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        raw.push(span / (OUTLINE_SPACING * strokeSizeAt(size, eyeDistance(mid))));
      }
    }
  }
  const counts = new Uint32Array(raw.length);
  if (raw.length > 0 && budget >= raw.length) {
    let scale = Math.max(1, raw.reduce((sum, r) => sum + r, 0) / budget);
    for (;;) {
      let total = 0;
      for (let i = 0; i < raw.length; i++) {
        counts[i] = Math.max(1, Math.round(raw[i] / scale));
        total += counts[i];
      }
      if (total <= budget) break;
      scale *= 1.05;
    }
  }
  let k = 0;
  for (const surface of surfaces) {
    if (!surface.faces || !surface.outline) continue;
    surface.outline = counts.subarray(k, k + surface.outline.length);
    k += surface.outline.length;
  }
}

/**
 * Scatters strokes over `meshes`, each a world-space geometry tagged with `userData.layer`, with
 * an optional `userData.scatter` override. Indexed and non-indexed geometry both work. Meshes are
 * processed by layer in WORLD_LAYERS order, then in input order within a layer; each mesh draws
 * from its own streams of (seed, layer, index within the layer). The output is therefore identical
 * for the same meshes, source and options whatever the layer order of the input, while reordering
 * meshes within a layer changes it.
 *
 * Per stroke: colour and flow from `sampleCanvas` (emissive meshes keep `userData.color`, linear
 * RGB, sRGB encoded), the colour divided by `strokeShade`; the flags (`DEPTH_TIE_BREAK_FRONT_FLAG` on
 * emissive meshes, `DEPTH_BACKDROP_FLAG` on meshes with `userData.backdrop`, the sky dome); the
 * interpolated vertex normal (the face normal without one); the tangent laid into the surface plane
 * through the painter's camera in frame, or against `stableFrame` where the sample was
 * extrapolated; brush and stroke layer from the region style of `LAYER_REGION[layer]`; length from
 * the graded size at the stroke's distance.
 *
 * On FACE_CLAMPED_LAYERS the quad's painted footprint (BRUSH_FOOTPRINT) is then fitted into its
 * host face (`fitStrokeToFace`): clamped, and turned to run along a side it reaches past. The quad
 * and tangent follow it, and the fit scale is stored in the flags. After its own strokes, each
 * OUTLINED_LAYERS mesh gets its outline strokes (`placeOutlines`), budgeted over all of them by
 * `planOutlines` to at most OUTLINE_SHARE of the FACE_CLAMPED_LAYERS strokes.
 */
export function scatterSurfaces(
  meshes: readonly BufferGeometry[],
  source: CanvasSource,
  options: ScatterOptions,
): StrokeBuffers {
  // Pass 1: stratified counts per triangle, from each mesh's count stream.
  const tables = resolveScatterTables(options);
  const surfaces: Surface[] = [];
  let total = 0;
  for (const ordered of processingOrder(meshes)) {
    const { geometry, layer, layerIndex, meshIndex } = ordered;
    const override = overrideOf(geometry);
    const density = override?.density ?? tables.density[layer];
    const size: GradedSize = { ...tables.size[layer], ...override?.size };
    if (!(density >= 0) || !Number.isFinite(density)) {
      throw new RangeError(`bad density ${density} for ${layer}`);
    }
    checkSize(size, layer);
    const rng = mulberry32(streamSeed(options.seed, layerIndex, meshIndex, 0));
    const { areas, distances } = triangleTable(geometry);
    const counts = new Uint32Array(areas.length);
    for (let t = 0; t < areas.length; t++) {
      const expected = areas[t] * scatterDensityAt(density, size, distances[t]);
      const whole = Math.floor(expected);
      counts[t] = whole + (rng() < expected - whole ? 1 : 0);
      total += counts[t];
    }
    const faces = FACE_CLAMPED_LAYERS.includes(layer) ? facePolygons(geometry) : null;
    const sides = faces?.faces.reduce((sum, f) => sum + f.vertices.length, 0) ?? 0;
    const outline = faces && OUTLINED_LAYERS.includes(layer) ? new Uint32Array(sides) : null;
    surfaces.push({ ...ordered, density, size, counts, faces, outline });
  }
  let clamped = 0;
  for (const { layer, counts } of surfaces) {
    if (FACE_CLAMPED_LAYERS.includes(layer)) clamped += counts.reduce((sum, c) => sum + c, 0);
  }
  planOutlines(surfaces, Math.floor(OUTLINE_SHARE * clamped));
  for (const { outline } of surfaces) total += outline?.reduce((sum, c) => sum + c, 0) ?? 0;

  // Pass 2: placement, from each mesh's placement stream.
  const buffers = createStrokeBuffers(total);
  let index = 0;
  for (const surface of surfaces) {
    const { geometry, layer, layerIndex, meshIndex, size, counts, faces } = surface;
    const rand = mulberry32(streamSeed(options.seed, layerIndex, meshIndex, 1));
    const style = REGION_STYLES[LAYER_REGION[layer]];
    const emissive = emissiveColor(geometry);
    const backdrop = geometry.userData.backdrop === true;
    const position = geometry.getAttribute('position');
    const normalAttr = geometry.getAttribute('normal') as Attribute | undefined;
    for (let t = 0; t < counts.length; t++) {
      if (counts[t] === 0) continue;
      const ia = vertexIndex(geometry, t, 0);
      const ib = vertexIndex(geometry, t, 1);
      const ic = vertexIndex(geometry, t, 2);
      const a = read(position, ia);
      const ab = sub(read(position, ib), a);
      const ac = sub(read(position, ic), a);
      const face = cross(ab, ac);
      const faceNormal = scale(face, 1 / length(face));
      const na = normalAttr ? read(normalAttr, ia) : null;
      const nb = normalAttr ? read(normalAttr, ib) : null;
      const nc = normalAttr ? read(normalAttr, ic) : null;
      for (let k = 0; k < counts[t]; k++) {
        let r1 = rand();
        let r2 = rand();
        if (r1 + r2 > 1) {
          r1 = 1 - r1;
          r2 = 1 - r2;
        }
        const r0 = 1 - r1 - r2;
        const point: Vec3 = [
          a[0] + r1 * ab[0] + r2 * ac[0],
          a[1] + r1 * ab[1] + r2 * ac[1],
          a[2] + r1 * ab[2] + r2 * ac[2],
        ];
        let normal = faceNormal;
        if (na && nb && nc) {
          const n: Vec3 = [
            r0 * na[0] + r1 * nb[0] + r2 * nc[0],
            r0 * na[1] + r1 * nb[1] + r2 * nc[1],
            r0 * na[2] + r1 * nb[2] + r2 * nc[2],
          ];
          const len = length(n);
          if (len > 1e-6) normal = scale(n, 1 / len);
        }

        const sample = sampleCanvas(source, point, layer, rand);
        const brush = style.brushes[Math.floor(rand() * style.brushes.length)];
        const graded = strokeSizeAt(size, eyeDistance(point));
        const strokeLength = graded * (1 + (2 * rand() - 1) * SCATTER_SIZE_JITTER);
        // The lift's former draw: the share now comes from the final quad size, and this keeps the
        // later draws where they were.
        rand();
        const flip = rand() < 0.5 ? Math.PI : 0;
        const phase = Math.floor(rand() * 256);
        // The tangent and the shade use the normal the GPU decodes (the quantised-basis caveat in
        // instance.ts).
        const decoded = decodedNormal(normal);
        const along = sample.extrapolated
          ? null
          : cameraDirection(point, decoded, sample.flowAngle);
        const frame = along ? { right: along, up: cross(decoded, along) } : stableFrame(decoded);
        const angle = (along ? 0 : sample.flowAngle) + flip;
        const shade = strokeShade(decoded);
        const rgb = emissive ?? sample.rgb;
        let tangent = canvasTangent(decoded, frame.right, frame.up, angle);
        let centre: Vec3 = point;
        let quad: [number, number] = [strokeLength, strokeLength * BRUSHES[brush].aspect];
        let fitBits = 0;
        if (faces) {
          // The painted footprint of the quad as the GPU draws it: the decoded normal's basis
          // turned by the tangent.
          const foot = BRUSH_FOOTPRINT[BRUSHES[brush].kind];
          const length = quad[0] * foot.length;
          const width = quad[1] * foot.width;
          const clamped = fitStrokeToFace(
            faces.faces[faces.faceOf[t]],
            { centre: point, long: strokeAxes(decoded, tangent).long, length, width },
            FACE_CLAMP_MARGIN,
          );
          if (clamped.aligned) {
            const { b1, b2 } = surfaceBasis(decoded);
            const [x, y, z] = clamped.long;
            tangent = Math.atan2(
              x * b2[0] + y * b2[1] + z * b2[2],
              x * b1[0] + y * b1[1] + z * b1[2],
            );
          }
          centre = clamped.centre;
          quad = [
            clamped.length === length ? quad[0] : clamped.length / foot.length,
            clamped.width === width ? quad[1] : clamped.width / foot.width,
          ];
          fitBits = encodeFitScale(clamped.fitScale);
        }
        // The lift follows the graded length, not the jittered one, so between two neighbours it
        // orders them by their share, as the tie-break does (depth-tie-break.ts).
        const lift =
          SCATTER_DEPTH_JITTER * graded * sizeShare(Math.fround(quad[0]), Math.fround(quad[1]));
        packInstance(buffers, index++, {
          position: [
            centre[0] + normal[0] * lift,
            centre[1] + normal[1] * lift,
            centre[2] + normal[2] * lift,
          ],
          normal,
          tangent,
          color: [rgb[0] / shade, rgb[1] / shade, rgb[2] / shade, 255],
          size: quad,
          brush,
          layer: style.layer,
          phase,
          flags:
            (emissive ? DEPTH_TIE_BREAK_FRONT_FLAG : 0) |
            (backdrop ? DEPTH_BACKDROP_FLAG : 0) |
            DEPTH_RANKED_FLAG |
            fitBits,
        });
      }
    }
    if (faces && surface.outline) {
      index = placeOutlines(buffers, index, surface, faces, source, options.seed);
    }
  }
  return buffers;
}

/**
 * Places a surface's outline strokes, from its outline stream: along each face side, evenly with
 * jitter, the long axis along the side, fitted flush inside it (`fitStrokeToFace`), coloured from
 * the canvas at the edge darkened by OUTLINE_DARKEN, and lifted by the share of its quad size
 * (`sizeShare`) like every other ranked stroke. Returns the next free index.
 */
function placeOutlines(
  buffers: StrokeBuffers,
  start: number,
  surface: Surface,
  faces: FaceSet,
  source: CanvasSource,
  seed: number,
): number {
  const { layer, layerIndex, meshIndex, size } = surface;
  const outline = surface.outline;
  if (!outline) return start;
  const rand = mulberry32(streamSeed(seed, layerIndex, meshIndex, 2));
  const style = REGION_STYLES[LAYER_REGION[layer]];
  const straight = style.brushes.filter((b) => OUTLINE_KINDS.includes(BRUSHES[b].kind));
  const brushes = straight.length > 0 ? straight : style.brushes;
  let index = start;
  let k = 0;
  for (const face of faces.faces) {
    const decoded = decodedNormal(face.normal);
    const { b1, b2 } = surfaceBasis(decoded);
    const shade = strokeShade(decoded);
    const n = face.vertices.length;
    for (let i = 0; i < n; i++, k++) {
      const a = facePoint(face, face.vertices[i]);
      const b = facePoint(face, face.vertices[(i + 1) % n]);
      const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const along: Vec3 = [(b[0] - a[0]) / span, (b[1] - a[1]) / span, (b[2] - a[2]) / span];
      for (let j = 0; j < outline[k]; j++) {
        const at = (j + 0.25 + 0.5 * rand()) / outline[k];
        const point: Vec3 = [
          a[0] + at * (b[0] - a[0]),
          a[1] + at * (b[1] - a[1]),
          a[2] + at * (b[2] - a[2]),
        ];
        const sample = sampleCanvas(source, point, layer, rand);
        const brush = brushes[Math.floor(rand() * brushes.length)];
        const graded = strokeSizeAt(size, eyeDistance(point));
        const strokeLength = graded * (1 + (2 * rand() - 1) * SCATTER_SIZE_JITTER);
        const sign = rand() < 0.5 ? -1 : 1;
        const phase = Math.floor(rand() * 256);
        const foot = BRUSH_FOOTPRINT[BRUSHES[brush].kind];
        const quad: [number, number] = [strokeLength, strokeLength * BRUSHES[brush].aspect];
        const length = quad[0] * foot.length;
        const width = quad[1] * foot.width;
        const long: Vec3 = [sign * along[0], sign * along[1], sign * along[2]];
        const fitted = fitStrokeToFace(
          face,
          { centre: point, long, length, width },
          FACE_CLAMP_MARGIN,
        );
        const [x, y, z] = fitted.long;
        const outlineSize: [number, number] = [
          fitted.length === length ? quad[0] : fitted.length / foot.length,
          fitted.width === width ? quad[1] : fitted.width / foot.width,
        ];
        const lift =
          SCATTER_DEPTH_JITTER *
          graded *
          sizeShare(Math.fround(outlineSize[0]), Math.fround(outlineSize[1]));
        const rgb = sample.rgb.map((c) => (c * OUTLINE_DARKEN) / shade);
        packInstance(buffers, index++, {
          position: [
            fitted.centre[0] + face.normal[0] * lift,
            fitted.centre[1] + face.normal[1] * lift,
            fitted.centre[2] + face.normal[2] * lift,
          ],
          normal: face.normal,
          tangent: Math.atan2(x * b2[0] + y * b2[1] + z * b2[2], x * b1[0] + y * b1[1] + z * b1[2]),
          color: [rgb[0], rgb[1], rgb[2], 255],
          size: outlineSize,
          brush,
          layer: style.layer,
          phase,
          flags: DEPTH_RANKED_FLAG | encodeFitScale(fitted.fitScale),
        });
      }
    }
  }
  return index;
}
