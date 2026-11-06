/**
 * The flame-shaped cypress in the left foreground, fitted so that through the painter's camera it
 * fills the painted cypress and its tip lands on the painted apex. Pure: geometry and data only, no
 * materials, no scene objects.
 *
 * Two flame masses share one geometry: the main tree, and a smaller lower mass that fills the
 * painted foliage flaring right below v 0.4 (u 0.3–0.46). Each is built the same way, by fit
 * rather than by tuning:
 * - Its tip is the point on the `canvasRay` through its canvas tip at `CYPRESS_DISTANCE`
 *   horizontal metres from the spot.
 * - Its axis is a spline through the middle of its canvas span (see below) at a ladder of canvas v
 *   values, each lifted along its own `canvasRay` to that same horizontal distance. Below the frame
 *   the axis drops straight to the ground. The axis sets each ring's depth and canvas v.
 * - Its canvas span at v is a slice of the painted outline: the main mass takes the outline's left
 *   edge to `min(right edge, MAIN_RIGHT_U)`, the lower mass `LOWER_LEFT_U` to the right edge.
 * - Each horizontal ring is the lobed cross-section, scaled and shifted along world x (the camera's
 *   right) so its leftmost and rightmost points project onto the span's two ends: the reach is
 *   asymmetric about the axis. Below the frame the span holds its frame-bottom ends and widens by
 *   `BASE_FLARE` per metre of drop, capped by a flame profile whose peak sets the main mass's
 *   height over widest ring chord to `CYPRESS_RATIO`.
 * - Lobes twist around the axis; each vertex carries its lobe id and normalised height for the
 *   P4.4 flame motion.
 */
import { BufferAttribute, BufferGeometry, Uint8BufferAttribute } from 'three';
import {
  CANVAS_ASPECT,
  CANVAS_FOV_Y_DEG,
  CANVAS_PITCH,
  canvasRay,
  PAINTER_EYE,
  projectToCanvas,
  type Vec2,
  type WorldLayer,
} from '../paintings/starry-night/canvas-camera';
import type { Vec3 } from '../render/strokes/frame';
import { mulberry32 } from '../util/prng';
import { TERRAIN_CELL, type Terrain } from './terrain';

/**
 * The regions.json `cypress` polygon, (u, v) with v up (v = 1 − v_json), in file order. A unit
 * test keeps the two in step.
 */
export const CYPRESS_OUTLINE: readonly Vec2[] = Object.freeze(
  (
    [
      [0.197, 0.058],
      [0.207, 0.1],
      [0.212, 0.168],
      [0.218, 0.242],
      [0.229, 0.316],
      [0.243, 0.389],
      [0.25, 0.463],
      [0.26, 0.547],
      [0.275, 0.6],
      [0.293, 0.584],
      [0.3, 0.642],
      [0.333, 0.705],
      [0.379, 0.742],
      [0.417, 0.774],
      [0.435, 0.768],
      [0.446, 0.842],
      [0.463, 0.916],
      [0.457, 1],
      [0.125, 1],
      [0.121, 0.905],
      [0.125, 0.8],
      [0.138, 0.695],
      [0.146, 0.589],
      [0.148, 0.474],
      [0.148, 0.347],
      [0.157, 0.316],
      [0.167, 0.253],
      [0.177, 0.168],
      [0.183, 0.105],
    ] as const
  ).map(([u, vDown]) => Object.freeze([u, 1 - vDown]) as Vec2),
);

/** The painted cypress apex, the polygon's topmost vertex, v up. The main tip projects exactly here. */
export const CYPRESS_APEX_UV: Vec2 = Object.freeze([0.197, 1 - 0.058]) as Vec2;
/** Canvas tip of the lower mass, v up: under the outline's notch at (0.293, 0.416). */
export const CYPRESS_LOWER_TIP_UV: Vec2 = Object.freeze([0.288, 0.405]) as Vec2;

/**
 * Horizontal distance of both tips from the spot, metres. Canvas framing sets it: along the apex
 * ray, 10 m out puts the tip about 9.4 m above the spot and 14 m above the ground below it, the
 * painting's "about 14 m". The plan's 4–6 m would give a tree of about 8 m.
 */
export const CYPRESS_DISTANCE: number = 10;

/**
 * Target total height over maximum horizontal diameter (the longest chord of any horizontal
 * ring), both in world space, for the main mass. Must stay within the plan's 4–6. The lower mass
 * is not bound by it.
 */
export const CYPRESS_RATIO: number = 5;

/** Main mass: horizontal rings from the base up, below its single tip vertex. */
export const CYPRESS_RINGS: number = 36;
/** Main mass: vertices per ring. Divisible by 3 and 5, the lobe counts' extremes. */
export const CYPRESS_SEGMENTS: number = 30;
/** Main mass lobe count range, inclusive. */
export const CYPRESS_LOBES: Readonly<{ min: number; max: number }> = Object.freeze({
  min: 3,
  max: 5,
});
/** Lower mass: rings below its tip vertex. */
export const CYPRESS_LOWER_RINGS: number = 16;
/** Lower mass: vertices per ring. Divisible by 2 and 3, its lobe counts. */
export const CYPRESS_LOWER_SEGMENTS: number = 18;
/** Lower mass lobe count range, inclusive. */
export const CYPRESS_LOWER_LOBES: Readonly<{ min: number; max: number }> = Object.freeze({
  min: 2,
  max: 3,
});

/** Layer tag in `geometry.userData.layer`, read by the stroke scatter. Both masses carry it. */
export const CYPRESS_LAYER: WorldLayer = 'cypress';
/**
 * Float32 per-vertex attribute: height normalised per mass, exactly 0 on that mass's base ring and
 * 1 at its tip, linear in world y between them.
 */
export const CYPRESS_HEIGHT_ATTRIBUTE: string = 'cypressHeight';
/**
 * Uint8 non-normalised per-vertex attribute: the lobe id, an integer in 0..lobeCount − 1 over the
 * whole geometry. The main mass uses 0..main.lobeCount − 1 and the lower mass continues from
 * main.lobeCount. Each ring vertex takes its mass's lobe whose twisted centre angle is nearest; a
 * tip vertex carries its mass's first lobe. A per-vertex integer: never interpolate it.
 */
export const CYPRESS_LOBE_ATTRIBUTE: string = 'cypressLobe';

/**
 * Below-frame profile scale of the lower mass, height over widest ring chord. Broader than the
 * main tree's: it is a low mound of foliage, and a narrower profile would pinch it under the frame.
 */
const LOWER_RATIO = 3;
/** The main mass's span stops here in u; the lower mass takes the outline right of it. */
const MAIN_RIGHT_U = 0.3;
/** The lower mass's span starts here in u, overlapping the main mass so no gap opens. */
const LOWER_LEFT_U = 0.28;
/** Canvas v ladders for the axis anchors, bottom to top, inside the frame and below each tip. */
const MAIN_AXIS_V: readonly number[] = Object.freeze([
  0.02, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84,
]);
const LOWER_AXIS_V: readonly number[] = Object.freeze([0.02, 0.12, 0.22, 0.32]);
/** Flame profile below the frame: base radius over peak, the peak's t, and the taper exponent. */
const PROFILE = Object.freeze({ baseFrac: 0.75, peakT: 0.18, taperMin: 0.95, taperMax: 1.25 });
/** Lobe depth: radii swing between ring·(1 − amp) and ring·(1 + amp). */
const LOBE_AMP: Readonly<{ min: number; max: number }> = Object.freeze({ min: 0.16, max: 0.26 });
/** Lobe shape exponent; above 1 sharpens the lobes into tongues. */
const LOBE_SHARP = 1.6;
/** Total twist of the lobes from base to tip, turns. */
const TWIST_TURNS: Readonly<{ min: number; max: number }> = Object.freeze({ min: 0.6, max: 1.2 });
/** Extra reach on each side below the frame's bottom edge, metres per metre of drop. */
const BASE_FLARE = 0.5;
/** Smallest ring radius, metres, so no ring collapses to a point below the tip. */
const MIN_RADIUS = 0.02;
/** Refinement passes fitting a ring's projected extremes to its span. */
const FIT_PASSES = 4;
/** Ground samples along each base-ring edge per terrain cell. */
const BASE_SAMPLES_PER_CELL = 8;

const TAN_HALF_Y = Math.tan((CANVAS_FOV_Y_DEG * Math.PI) / 360);
const TAN_HALF_X = CANVAS_ASPECT * TAN_HALF_Y;
const SIN_P = Math.sin(CANVAS_PITCH);
const COS_P = Math.cos(CANVAS_PITCH);

/** One flame mass of the cypress. */
export interface CypressMass {
  /** Axis point of the base ring at its seat: the lowest ground under that ring, so nothing floats. */
  readonly base: Vec3;
  /** The tip, on its canvas tip's ray at `CYPRESS_DISTANCE` horizontal metres from the spot. */
  readonly tip: Vec3;
  /** Tip y minus base y, metres. */
  readonly height: number;
  /** Longest chord of any horizontal ring, metres. */
  readonly maxDiameter: number;
  /** First lobe id of this mass in `cypressLobe`. */
  readonly firstLobe: number;
  /** Number of lobes; this mass's ids are firstLobe..firstLobe + lobeCount − 1. */
  readonly lobeCount: number;
  /** Lobe rotation from base to tip about +Y, radians, signed. */
  readonly twist: number;
  /** Ring centres from the base up, then the tip. */
  readonly axis: readonly Vec3[];
  /** This mass's vertices are firstVertex..firstVertex + vertexCount − 1: rings, then the tip. */
  readonly firstVertex: number;
  readonly vertexCount: number;
}

export interface Cypress {
  readonly seed: number;
  /**
   * Indexed hull of both masses with position, normal, `cypressHeight` and `cypressLobe`
   * attributes, wound counter-clockwise from outside. Each mass is open at its base, which sits at
   * or under the ground. `userData.layer` is `'cypress'`.
   */
  readonly geometry: BufferGeometry;
  /** Total lobe ids over both masses: `cypressLobe` ranges over 0..lobeCount − 1. */
  readonly lobeCount: number;
  /** The main tree, whose tip is the painted apex. */
  readonly main: CypressMass;
  /** The smaller mass at the lower right. */
  readonly lower: CypressMass;
}

const smoothstep = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Leftmost and rightmost crossings of the outline at canvas v, or null above its apex. */
function outlineSpan(v: number): Vec2 | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  const n = CYPRESS_OUTLINE.length;
  for (let i = 0; i < n; i++) {
    const a = CYPRESS_OUTLINE[i] as Vec2;
    const b = CYPRESS_OUTLINE[(i + 1) % n] as Vec2;
    if (a[1] === b[1] || (a[1] - v) * (b[1] - v) > 0) continue;
    const u = a[0] + ((v - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
    lo = Math.min(lo, u);
    hi = Math.max(hi, u);
  }
  return lo < hi ? [lo, hi] : null;
}

/** The main mass's canvas span at v. */
const mainSpan = (v: number): Vec2 | null => {
  const s = outlineSpan(v);
  if (s === null) return null;
  const right = Math.min(s[1], MAIN_RIGHT_U);
  return right > s[0] ? [s[0], right] : null;
};
/** The lower mass's canvas span at v: null where the outline does not reach past its left end. */
const lowerSpan = (v: number): Vec2 | null => {
  const s = outlineSpan(v);
  if (s === null) return null;
  const left = Math.max(s[0], LOWER_LEFT_U);
  return s[1] > left ? [left, s[1]] : null;
};

/** The point on the canvas ray through (u, v) at `dist` horizontal metres from the eye. */
function rayAtDistance(u: number, v: number, dist: number): Vec3 {
  const r = canvasRay(u, v);
  const s = dist / Math.hypot(r[0], r[2]);
  return [PAINTER_EYE[0] + r[0] * s, PAINTER_EYE[1] + r[1] * s, PAINTER_EYE[2] + r[2] * s];
}

/** Distance of a point in front of the eye along the camera's optical axis. */
function cameraDepth(p: Vec3): number {
  return (p[1] - PAINTER_EYE[1]) * SIN_P - (p[2] - PAINTER_EYE[2]) * COS_P;
}

/** World x at which canvas u falls at camera depth `depth` (u does not depend on y or z there). */
const worldX = (u: number, depth: number): number =>
  PAINTER_EYE[0] + (2 * u - 1) * TAN_HALF_X * depth;

/** Uniform Catmull-Rom between p1 and p2 at s in [0, 1]. */
const catmullRom = (p0: number, p1: number, p2: number, p3: number, s: number): number =>
  0.5 *
  (2 * p1 +
    (p2 - p0) * s +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s +
    (3 * p1 - p0 - 3 * p2 + p3) * s * s * s);

/**
 * The axis as a function of world y, through anchors sorted by rising y. Below the first anchor it
 * holds that anchor's xz (a vertical trunk); above the last it holds the last's.
 */
function axisSpline(anchors: readonly Vec3[]): (y: number) => Vec2 {
  const n = anchors.length;
  const at = (i: number): Vec3 => anchors[Math.min(n - 1, Math.max(0, i))] as Vec3;
  return (y) => {
    const first = at(0);
    const last = at(n - 1);
    if (y <= first[1]) return [first[0], first[2]];
    if (y >= last[1]) return [last[0], last[2]];
    let i = 0;
    while (i < n - 2 && y > at(i + 1)[1]) i++;
    const s = (y - at(i)[1]) / (at(i + 1)[1] - at(i)[1]);
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    return [catmullRom(p0[0], p1[0], p2[0], p3[0], s), catmullRom(p0[2], p1[2], p2[2], p3[2], s)];
  };
}

/** Longest chord between any two points of a ring, metres. */
function ringChord(ring: readonly Vec2[]): number {
  let best = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Vec2;
    for (let j = i + 1; j < ring.length; j++) {
      const b = ring[j] as Vec2;
      best = Math.max(best, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
  }
  return best;
}

interface MassSpec {
  readonly tipUV: Vec2;
  readonly axisV: readonly number[];
  readonly span: (v: number) => Vec2 | null;
  readonly rings: number;
  readonly segs: number;
  readonly lobes: Readonly<{ min: number; max: number }>;
  readonly firstLobe: number;
  readonly firstVertex: number;
  /** Height over widest ring chord that the below-frame profile is scaled to. */
  readonly ratio: number;
}

interface MassBuild {
  readonly record: CypressMass;
  readonly positions: readonly number[];
  readonly heights: readonly number[];
  readonly lobes: readonly number[];
  /** Indices into the whole geometry. */
  readonly indices: readonly number[];
}

/** Builds one seeded flame mass fitted to its canvas span and seated on the ground. */
function buildMass(spec: MassSpec, rand: () => number, heightAt: Terrain['heightAt']): MassBuild {
  const lobeCount = spec.lobes.min + Math.floor(rand() * (spec.lobes.max - spec.lobes.min + 1));
  const amp = LOBE_AMP.min + rand() * (LOBE_AMP.max - LOBE_AMP.min);
  const twist =
    (rand() < 0.5 ? -1 : 1) *
    2 *
    Math.PI *
    (TWIST_TURNS.min + rand() * (TWIST_TURNS.max - TWIST_TURNS.min));
  const phase0 = rand() * 2 * Math.PI;
  const taper = PROFILE.taperMin + rand() * (PROFILE.taperMax - PROFILE.taperMin);
  /** Per lobe: how many bulges climb it and where they start, for flame-tongue variation. */
  const tongues = Array.from({ length: lobeCount }, () => ({
    freq: 1.5 + rand() * 1.5,
    phase: rand(),
  }));

  const tip = rayAtDistance(spec.tipUV[0], spec.tipUV[1], CYPRESS_DISTANCE);
  const anchors: Vec3[] = spec.axisV.map((v) => {
    const s = spec.span(v) as Vec2;
    return rayAtDistance((s[0] + s[1]) / 2, v, CYPRESS_DISTANCE);
  });
  anchors.push(tip);
  const axisAt = axisSpline(anchors);

  /** Flame profile in [baseFrac, 1]: swells to the peak, then tapers to 0 at the tip. */
  const profile = (t: number): number =>
    t <= PROFILE.peakT
      ? PROFILE.baseFrac + (1 - PROFILE.baseFrac) * smoothstep(t / PROFILE.peakT)
      : ((1 - t) / (1 - PROFILE.peakT)) ** taper;

  const { rings, segs } = spec;
  const angle = (k: number): number => (2 * Math.PI * k) / segs;
  /** Radial factor in [1 − amp, 1 + amp] and local lobe of a ring vertex at height t, angle theta. */
  const lobeAt = (t: number, theta: number): { factor: number; lobe: number } => {
    const sector = (2 * Math.PI) / lobeCount;
    const local = theta - phase0 - twist * t;
    const k = Math.round(local / sector);
    const lobe = ((k % lobeCount) + lobeCount) % lobeCount;
    const shape = ((1 + Math.cos(lobeCount * local)) / 2) ** LOBE_SHARP;
    const tongue = tongues[lobe] as { freq: number; phase: number };
    const swell = 0.65 + 0.35 * Math.sin(2 * Math.PI * (tongue.freq * t + tongue.phase));
    // Lobes fade into the tip, so the spire closes cleanly.
    const fade = 1 - smoothstep((t - 0.85) / 0.15);
    return { factor: 1 - amp + 2 * amp * fade * swell * shape, lobe };
  };
  /** Unit-radius ring offsets at height t. */
  const unitRing = (t: number): Vec2[] =>
    Array.from({ length: segs }, (_, k): Vec2 => {
      const f = lobeAt(t, angle(k)).factor;
      return [f * Math.cos(angle(k)), f * Math.sin(angle(k))];
    });

  /** Uncapped profile rings' longest chord at unit peak: scales the profile to the ratio. */
  let unitChord = 0;
  for (let i = 0; i < rings; i++) {
    const t = i / rings;
    unitChord = Math.max(
      unitChord,
      ringChord(unitRing(t).map(([x, z]): Vec2 => [x * profile(t), z * profile(t)])),
    );
  }
  const baseAxis = axisAt(Number.NEGATIVE_INFINITY);
  const groundY = heightAt(baseAxis[0], baseAxis[1]);
  const peak = (tip[1] - groundY) / (spec.ratio * unitChord);

  /**
   * The ring at height t, centred on the axis at world y: scaled and shifted along x so its
   * extreme points project onto the span's ends. Below the frame the span widens by the flare and
   * the radius is capped by the profile.
   */
  const ringAt = (t: number, y: number): { center: Vec3; points: Vec2[] } => {
    const [ax, az] = axisAt(y);
    const unit = unitRing(t);
    const centre: Vec3 = [ax, y, az];
    const { uv } = projectToCanvas(centre);
    const depth = cameraDepth(centre);
    const span = uv === null ? null : spec.span(Math.min(1, Math.max(0, uv[1])));
    if (uv === null || span === null) {
      return {
        center: centre,
        points: unit.map(([x, z]): Vec2 => [ax + x * MIN_RADIUS, az + z * MIN_RADIUS]),
      };
    }
    const drop = 2 * TAN_HALF_Y * depth * Math.max(0, -uv[1]);
    const xl = worldX(span[0], depth) - BASE_FLARE * drop;
    const xr = worldX(span[1], depth) + BASE_FLARE * drop;
    const lo = Math.min(...unit.map(([x]) => x));
    const hi = Math.max(...unit.map(([x]) => x));
    let r = (xr - xl) / (hi - lo);
    let cx = xl - r * lo;
    // The x fit above holds at the centre's depth only; a ring's near side projects wider. Refine
    // the scale and shift against the points' projected u until its extremes land on the span.
    const ul = span[0] - (BASE_FLARE * drop) / (2 * TAN_HALF_X * depth);
    const ur = span[1] + (BASE_FLARE * drop) / (2 * TAN_HALF_X * depth);
    const extremes = (): Vec2 => {
      const us = unit.map(([x, z]) => projectToCanvas([cx + r * x, y, az + r * z]).uv?.[0] ?? 0.5);
      return [Math.min(...us), Math.max(...us)];
    };
    for (let pass = 0; pass < FIT_PASSES; pass++) {
      const [u0, u1] = extremes();
      r *= (ur - ul) / (u1 - u0);
      const [w0, w1] = extremes();
      cx += (ul - w0 + (ur - w1)) * TAN_HALF_X * depth;
    }
    if (uv[1] < 0 && r > peak * profile(t)) {
      r = peak * profile(t);
      cx = (xl + xr) / 2 - (r * (lo + hi)) / 2;
    }
    if (r < MIN_RADIUS) {
      r = MIN_RADIUS;
      cx = (xl + xr) / 2 - (r * (lo + hi)) / 2;
    }
    return {
      center: [cx, y, az],
      points: unit.map(([x, z]): Vec2 => [cx + r * x, az + r * z]),
    };
  };

  // The base ring's footprint is laid out at the ground under the axis, then sunk to the lowest
  // ground along its edges, so its footprint does not depend on the depth it is sunk to.
  const base0 = ringAt(0, groundY);
  let baseY = groundY;
  const ring0 = base0.points;
  for (let k = 0; k < segs; k++) {
    const a = ring0[k] as Vec2;
    const b = ring0[(k + 1) % segs] as Vec2;
    const steps = Math.max(
      1,
      Math.ceil((Math.hypot(b[0] - a[0], b[1] - a[1]) * BASE_SAMPLES_PER_CELL) / TERRAIN_CELL),
    );
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      baseY = Math.min(baseY, heightAt(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f));
    }
  }
  const height = tip[1] - baseY;

  const positions: number[] = [];
  const heights: number[] = [];
  const lobes: number[] = [];
  const axis: Vec3[] = [];
  let maxDiameter = 0;
  for (let i = 0; i < rings; i++) {
    const t = i / rings;
    const y = baseY + t * height;
    const ring =
      i === 0
        ? { center: [base0.center[0], baseY, base0.center[2]] as Vec3, points: ring0 }
        : ringAt(t, y);
    axis.push(ring.center);
    ring.points.forEach(([x, z], k) => {
      positions.push(x, y, z);
      heights.push(t);
      lobes.push(spec.firstLobe + lobeAt(t, angle(k)).lobe);
    });
    maxDiameter = Math.max(maxDiameter, ringChord(ring.points));
  }
  axis.push(tip);
  positions.push(tip[0], tip[1], tip[2]);
  heights.push(1);
  lobes.push(spec.firstLobe);

  const o = spec.firstVertex;
  const tipIndex = o + rings * segs;
  const indices: number[] = [];
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < segs; k++) {
      const a = o + i * segs + k;
      const c = o + i * segs + ((k + 1) % segs);
      if (i === rings - 1) {
        indices.push(a, tipIndex, c);
      } else {
        indices.push(a, a + segs, c, c, a + segs, c + segs);
      }
    }
  }

  return {
    record: {
      base: axis[0] as Vec3,
      tip,
      height,
      maxDiameter,
      firstLobe: spec.firstLobe,
      lobeCount,
      twist,
      axis,
      firstVertex: o,
      vertexCount: rings * segs + 1,
    },
    positions,
    heights,
    lobes,
    indices,
  };
}

/** Builds the seeded cypress, main tree and lower mass, seated on `terrain`. */
export function createCypress(seed: number, terrain: Pick<Terrain, 'heightAt'>): Cypress {
  const rand = mulberry32(seed ^ 0xc1b7e55);
  const main = buildMass(
    {
      tipUV: CYPRESS_APEX_UV,
      axisV: MAIN_AXIS_V,
      span: mainSpan,
      rings: CYPRESS_RINGS,
      segs: CYPRESS_SEGMENTS,
      lobes: CYPRESS_LOBES,
      firstLobe: 0,
      firstVertex: 0,
      ratio: CYPRESS_RATIO,
    },
    rand,
    terrain.heightAt,
  );
  const lower = buildMass(
    {
      tipUV: CYPRESS_LOWER_TIP_UV,
      axisV: LOWER_AXIS_V,
      span: lowerSpan,
      rings: CYPRESS_LOWER_RINGS,
      segs: CYPRESS_LOWER_SEGMENTS,
      lobes: CYPRESS_LOWER_LOBES,
      firstLobe: main.record.lobeCount,
      firstVertex: main.record.vertexCount,
      ratio: LOWER_RATIO,
    },
    rand,
    terrain.heightAt,
  );

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([...main.positions, ...lower.positions]), 3),
  );
  geometry.setAttribute(
    CYPRESS_HEIGHT_ATTRIBUTE,
    new BufferAttribute(new Float32Array([...main.heights, ...lower.heights]), 1),
  );
  geometry.setAttribute(
    CYPRESS_LOBE_ATTRIBUTE,
    new Uint8BufferAttribute(new Uint8Array([...main.lobes, ...lower.lobes]), 1),
  );
  geometry.setIndex([...main.indices, ...lower.indices]);
  geometry.computeVertexNormals();
  geometry.userData.layer = CYPRESS_LAYER;

  return {
    seed,
    geometry,
    lobeCount: main.record.lobeCount + lower.record.lobeCount,
    main: main.record,
    lower: lower.record,
  };
}
