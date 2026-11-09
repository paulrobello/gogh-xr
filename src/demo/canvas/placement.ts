/**
 * The P1 test canvas: the painting re-painted in strokes on an upright plane. Pure and
 * deterministic per seed, over the decoded images, so it runs unchanged in unit tests.
 *
 * Placement is a jittered stratified grid that is square in metres. Detail regions (stars, moon,
 * village, church) split each cell into 2 × 2 smaller strokes. Every stroke takes its colour from
 * the painting under it, its orientation from the flow field, and its length from the flow's
 * coherence: long strokes in coherent swirls, short dabs in flat or noisy areas. Its region picks
 * the brush kinds, the stroke layer and a depth offset along the normal, so coplanar strokes never
 * z-fight and overlaps read like layered paint.
 */
import { BRUSHES, type BrushKind } from '../../render/strokes/brush-atlas-data';
import { surfaceBasis, type Vec3 } from '../../render/strokes/frame';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  type StrokeBuffers,
  type StrokeLayer,
  unpackInstance,
} from '../../render/strokes/instance';
import { MOON_DIRECTION } from '../../render/strokes/material';
import { mulberry32 } from '../../util/prng';
import {
  type FlowField,
  type Raster,
  REGION,
  type RegionId,
  regionAt,
  sampleColor,
  sampleFlow,
} from './field';

export interface CanvasLayout {
  /** Centre of the painted surface, metres. */
  readonly center: Vec3;
  /** Unit vector along the painting's +u (left to right). */
  readonly right: Vec3;
  /** Unit vector along the painting's +v (bottom to top). The canvas faces `right × up`. */
  readonly up: Vec3;
  readonly width: number;
  readonly height: number;
}

/**
 * The painting's 92 × 73 cm aspect at 4 m wide, centred at the 1.6 m eye height and 2.55 m in
 * front of the XR origin, facing it. At the desktop camera's 70° vertical field of view the canvas
 * fills about 90% of the view height from there. The plane sits off a 0.5 m cell edge, so its
 * millimetre depth offsets stay in one chunk layer.
 */
export const CANVAS_LAYOUT: CanvasLayout = Object.freeze({
  center: [0, 1.6, -2.55] as Vec3,
  right: [1, 0, 0] as Vec3,
  up: [0, 1, 0] as Vec3,
  width: 4,
  height: 3.17,
});

/** About 200k strokes: inside the 150k–325k per-frame budget at near density 1. */
export const CANVAS_STROKE_TARGET = 200_000;
/** Chunk grid cell for the canvas, metres: small enough that culling and density prefixes work. */
export const CANVAS_CELL_SIZE = 0.5;
export const DEFAULT_CANVAS_SEED = 1;

export interface RegionStyle {
  readonly layer: StrokeLayer;
  /** Brush indices, drawn uniformly. */
  readonly brushes: readonly number[];
  /** Strokes per grid cell: 1, or 4 on a 2 × 2 sub-grid for detail regions. */
  readonly split: 1 | 4;
  /** Depth offset along the normal, metres: later layers paint over earlier ones. */
  readonly depth: number;
  /**
   * Stroke length in units of the local stroke spacing, before the coherence factor (0.9 flat to
   * 1.4 coherent). The brush masks fill only 25-50% of their quads, so about 4x overdraw at the
   * flat end is what leaves no gaps.
   */
  readonly length: number;
  /** 0..1 pull of the orientation towards vertical (the cypress flames). */
  readonly vertical: number;
}

function brushesOf(...kinds: BrushKind[]): number[] {
  return BRUSHES.flatMap((brush, index) => (kinds.includes(brush.kind) ? [index] : []));
}

/** Layer spacing along the normal; a layer's own size and jitter offsets stay below it. */
const LAYER_STEP = 0.0005;

export const REGION_STYLES: Readonly<Record<RegionId, RegionStyle>> = Object.freeze({
  [REGION.sky]: {
    layer: STROKE_LAYER.sky,
    brushes: brushesOf('comma', 'crescent', 'ridge'),
    split: 1,
    depth: 0,
    length: 5.2,
    vertical: 0,
  },
  [REGION.hills]: {
    layer: STROKE_LAYER.ground,
    brushes: brushesOf('ridge'),
    split: 1,
    depth: LAYER_STEP,
    length: 5.2,
    vertical: 0,
  },
  [REGION.village]: {
    layer: STROKE_LAYER.building,
    brushes: brushesOf('dab', 'ridge'),
    split: 4,
    depth: 2 * LAYER_STEP,
    length: 4.6,
    vertical: 0,
  },
  [REGION.church]: {
    layer: STROKE_LAYER.building,
    brushes: brushesOf('bristle'),
    split: 4,
    depth: 3 * LAYER_STEP,
    length: 4.6,
    vertical: 0,
  },
  [REGION.cypress]: {
    layer: STROKE_LAYER.cypress,
    brushes: brushesOf('bristle', 'ridge'),
    split: 1,
    depth: 4 * LAYER_STEP,
    length: 5.4,
    vertical: 0.35,
  },
  [REGION.stars]: {
    layer: STROKE_LAYER.star,
    brushes: brushesOf('dab', 'crescent', 'comma'),
    split: 4,
    depth: 5 * LAYER_STEP,
    length: 5,
    vertical: 0,
  },
  [REGION.moon]: {
    layer: STROKE_LAYER.moon,
    brushes: brushesOf('crescent', 'dab', 'comma'),
    split: 4,
    depth: 6 * LAYER_STEP,
    length: 5,
    vertical: 0,
  },
});

/** Within a layer, the shortest strokes sit up to this much in front of the longest. */
const SIZE_DEPTH = 0.0003;
/** Random depth within a layer, so equal-size neighbours never tie. */
const DEPTH_JITTER = 0.0001;
/** Stroke length at which the size depth reaches zero, metres. */
const SIZE_DEPTH_LENGTH = 0.08;
/** Orientation jitter, radians: a little everywhere, more where the flow is unreliable. */
const ANGLE_JITTER = 0.08;
const FLAT_ANGLE_JITTER = 0.6;
/** Per-stroke brightness jitter, ±. */
const VALUE_JITTER = 0.06;
/**
 * frame.webp has a pale mat about 12 texels wide at the sides (4 at top and bottom); colour uv is
 * inset past it: painting uv u reads the image at COLOR_INSET[0] + u·(1 − 2·COLOR_INSET[0]).
 * These fractions define canvas uv [0, 1]² for every source: the bake crops the scan by them
 * before it writes flow.png and regions.png (scripts/bake/bake.ts canvasRect), regions.json is
 * authored in that uv, and CANVAS_ASPECT is the cropped scan's aspect, so those three read at raw
 * uv.
 */
export const COLOR_INSET: readonly [number, number] = Object.freeze([
  12 / 1024,
  4 / 811,
]) as readonly [number, number];

export interface CanvasSources {
  /** The painting (frame.webp), display-referred sRGB. */
  readonly color: Raster;
  readonly flow: FlowField;
  readonly regions: Raster;
}

export interface CanvasStrokeOptions {
  /** `?seed`; null or absent means `DEFAULT_CANVAS_SEED`. */
  readonly seed?: number | null;
  readonly target?: number;
  readonly layout?: CanvasLayout;
}

/** One reused instance: packInstance overwrites every field, so no state carries between calls. */
const NORMAL_PROBE = createStrokeBuffers(1);

/** The normal as the GPU decodes it from the packed instance, quantisation included. */
export function decodedNormal(normal: Vec3): Vec3 {
  const probe = NORMAL_PROBE;
  packInstance(probe, 0, {
    position: [0, 0, 0],
    normal,
    tangent: 0,
    color: [0, 0, 0, 0],
    size: [1, 1],
    brush: 0,
    layer: 0,
    phase: 0,
  });
  return unpackInstance(probe, 0).normal;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The instance tangent for a stroke at painting-space `angle` (from `right` towards `up`),
 * measured in the surface basis of `normal`. Pass the decoded normal: Duff's basis turns by π
 * across n.z = 0, so the source normal's basis can point the stroke the wrong way.
 */
export function canvasTangent(normal: Vec3, right: Vec3, up: Vec3, angle: number): number {
  const { b1, b2 } = surfaceBasis(normal);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dir: Vec3 = [c * right[0] + s * up[0], c * right[1] + s * up[1], c * right[2] + s * up[2]];
  return Math.atan2(dot(dir, b2), dot(dir, b1));
}

/**
 * The light factor the stroke shader multiplies a stroke's colour by, for the decoded `normal`.
 * Dividing a sampled colour by it keeps the scan's values on screen. Must match `shade` in
 * stroke.frag.glsl.
 */
export function strokeShade(normal: Vec3): number {
  return 0.85 + 0.3 * (dot(normal, MOON_DIRECTION.toArray() as Vec3) * 0.5 + 0.5);
}

/** Share of the painting's area per region, from the regions raster. */
function regionShares(regions: Raster): Float64Array {
  const counts = new Float64Array(7);
  const n = regions.width * regions.height;
  for (let i = 0; i < n; i++) {
    const id = regions.data[i * 4];
    counts[id < 7 ? id : REGION.sky]++;
  }
  return counts.map((c) => c / n);
}

/** Orientation `angle` pulled towards vertical by `pull`, blended as doubled angles. */
function pullVertical(angle: number, pull: number): number {
  if (pull === 0) return angle;
  // Vertical is θ = π/2, doubled angle π: the vector (-1, 0).
  const x = (1 - pull) * Math.cos(2 * angle) - pull;
  const y = (1 - pull) * Math.sin(2 * angle);
  return 0.5 * Math.atan2(y, x);
}

/**
 * Builds the canvas strokes. Same sources, layout, target and seed give identical buffers. The
 * count is within a few percent of `target`: the grid is sized from the regions' area shares, and
 * each cell's split is decided by the region at its centre.
 */
export function buildCanvasStrokes(
  sources: CanvasSources,
  options: CanvasStrokeOptions = {},
): StrokeBuffers {
  const layout = options.layout ?? CANVAS_LAYOUT;
  const target = options.target ?? CANVAS_STROKE_TARGET;
  const rand = mulberry32(options.seed ?? DEFAULT_CANVAS_SEED);
  const { width: w, height: h, right, up, center } = layout;
  const normal: Vec3 = [
    right[1] * up[2] - right[2] * up[1],
    right[2] * up[0] - right[0] * up[2],
    right[0] * up[1] - right[1] * up[0],
  ];
  const decoded = decodedNormal(normal);
  const shade = strokeShade(decoded);

  const shares = regionShares(sources.regions);
  let strokesPerCell = 0;
  shares.forEach((share, id) => {
    strokesPerCell += share * REGION_STYLES[id as RegionId].split;
  });
  const spacing = Math.sqrt((w * h * strokesPerCell) / target);
  const cols = Math.max(1, Math.round(w / spacing));
  const rows = Math.max(1, Math.round(h / spacing));
  const cw = w / cols;
  const ch = h / rows;

  const splits = new Uint8Array(cols * rows);
  let count = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const region = regionAt(sources.regions, (col + 0.5) / cols, (row + 0.5) / rows);
      const split = REGION_STYLES[region].split;
      splits[row * cols + col] = split;
      count += split;
    }
  }

  const buffers = createStrokeBuffers(count);
  let index = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const split = splits[row * cols + col];
      const side = split === 4 ? 2 : 1;
      const sw = cw / side;
      const sh = ch / side;
      const local = Math.sqrt(sw * sh);
      for (let k = 0; k < split; k++) {
        const x = col * cw + ((k % side) + rand()) * sw;
        const y = row * ch + (Math.floor(k / side) + rand()) * sh;
        const u = x / w;
        const v = y / h;
        const region = regionAt(sources.regions, u, v);
        const style = REGION_STYLES[region];
        const flow = sampleFlow(sources.flow, u, v);
        const c = flow.coherence;
        let angle = pullVertical(flow.angle, style.vertical);
        angle += (rand() - 0.5) * 2 * (ANGLE_JITTER + (1 - c) * FLAT_ANGLE_JITTER);
        if (rand() < 0.5) angle += Math.PI;

        const brush = style.brushes[Math.floor(rand() * style.brushes.length)];
        const length = local * style.length * (0.9 + 0.5 * c) * (0.85 + 0.3 * rand());
        const strokeWidth = length * BRUSHES[brush].aspect;

        // Average three taps along the stroke, so its colour is the paint it covers.
        const du = ((Math.cos(angle) * length) / 3 / w) * (1 - 2 * COLOR_INSET[0]);
        const dv = ((Math.sin(angle) * length) / 3 / h) * (1 - 2 * COLOR_INSET[1]);
        const cu = COLOR_INSET[0] + u * (1 - 2 * COLOR_INSET[0]);
        const cv = COLOR_INSET[1] + v * (1 - 2 * COLOR_INSET[1]);
        const a = sampleColor(sources.color, cu - du, cv - dv);
        const b = sampleColor(sources.color, cu, cv);
        const d = sampleColor(sources.color, cu + du, cv + dv);
        const value = (1 + (rand() - 0.5) * 2 * VALUE_JITTER) / shade;

        const offset =
          style.depth +
          SIZE_DEPTH * Math.max(0, 1 - length / SIZE_DEPTH_LENGTH) +
          DEPTH_JITTER * rand();
        const px = x - w / 2;
        const py = y - h / 2;
        packInstance(buffers, index++, {
          position: [
            center[0] + px * right[0] + py * up[0] + offset * normal[0],
            center[1] + px * right[1] + py * up[1] + offset * normal[1],
            center[2] + px * right[2] + py * up[2] + offset * normal[2],
          ],
          normal,
          tangent: canvasTangent(decoded, right, up, angle),
          color: [
            ((a[0] + b[0] + d[0]) / 3) * value,
            ((a[1] + b[1] + d[1]) / 3) * value,
            ((a[2] + b[2] + d[2]) / 3) * value,
            255,
          ],
          size: [length, strokeWidth],
          brush,
          layer: style.layer,
          phase: Math.floor(rand() * 256),
        });
      }
    }
  }
  return buffers;
}
