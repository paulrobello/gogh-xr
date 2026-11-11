/**
 * The sky river (2026-11-10, Paul's drawn flow, docs/shots/sky-river-paul.webp): the field the
 * `wheelrun` and `wheelflow` wraps move the sky strokes outside the kept wheels along. Paul drew
 * one river left to right: down-right from the upper left, along the band over the big swirl,
 * through the big swirl as an S with two lobes, and out along its bottom into the small right
 * swirl. His seven polylines are authored data in assets/bake/starry-night/sky-river.json.
 *
 * Each sky stroke slides along its own painted brush direction. Its path is a small circle on the
 * sphere of directions from PAINTER_EYE that follows its painted arc: the circle through the
 * stroke tangent to its direction t̂ with the geodesic curvature κ of the painted stream line there
 * (flow.png, smoothed at the river's scale). A rotation about an axis through the eye carries the
 * stroke along it, the structure skyOmega already gives every other wrap, with one rotation vector
 * per stroke instead of the vortex field's:
 *
 *   ω = σ A v (κ d̂ + d̂ × t̂),  so  ω × d̂ = σ A v t̂  and  ω · d̂ = σ A v κ,
 *
 * which moves the stroke at σ A v along t̂ and turns it at the path's own curvature rate, so it
 * keeps its angle to the flow. v is the river's speed, σ the sign set by Paul's arrows (which way
 * along the unsigned brush axis), and A an amplitude in [0, 1]: it fades where the axis lies
 * across the guide (so the sign never flickers), and where the painted orientation is ambiguous
 * (the S lobes' cores). The axis lies at angle ρ from d̂ with cot ρ = κ, and the angular rate is
 * v / sin ρ, as the brief asked; κ is capped so no stroke curls tighter than the painting's
 * tightest arcs.
 *
 * Outside the canvas (Paul can turn round in the headset) there is no painted flow and the
 * extrapolated strokes' axes are random draws, so the river follows the guide's heading instead:
 * over the last SKY_RIVER_EDGE_IN inside the frame edge the painted direction eases onto the
 * guide's, and over SKY_RIVER_EDGE_BAND past the edge the rotation eases into one slow, coherent
 * drift of the whole dome about the vertical, left to right in front of the painter, which has no
 * sign anywhere to flip.
 *
 * Everything here runs on the CPU at world build, in float64 (skyRiverBake); the shader reads the
 * baked rotation vector and stream phase.
 */
import riverJson from '../../assets/bake/starry-night/sky-river.json';
import { boxBlurSteps, type FlowField } from '../demo/canvas/field';
import {
  CANVAS_ASPECT,
  CANVAS_FOV_Y_DEG,
  CANVAS_PITCH,
  canvasRay,
  PAINTER_EYE,
  projectToCanvas,
} from '../paintings/starry-night/canvas-camera';
import { strokeAxes, type Vec3 } from '../render/strokes/frame';
import { octDecode, STROKE_LAYER } from '../render/strokes/instance';
import { drain, type Steps } from '../util/slicer';
import {
  SKY_RIVER_SPEED,
  SKY_RIVER_WHEELS,
  SKY_SWIRL_PERIOD,
  type SkyWheel,
  skyWheelAt,
} from './sky-swirl';

const DEG = Math.PI / 180;

// The kept wheels (the big swirl's is dropped, so its strokes follow the S), the river's speed
// (the small right swirl's rim speed, 0.469°/s) and the jitter live in sky-swirl.ts, which the
// stroke batch and the shader defines read without this module.
export { SKY_RIVER_JITTER, SKY_RIVER_SPEED, SKY_RIVER_WHEELS } from './sky-swirl';

/**
 * The loop period, seconds: SKY_SWIRL_PERIOD (8 s, dividing the 3600 s wrap). The one-way arm's
 * stroke travels v × 8 = 3.75° per loop, 1.24 far-band dome stroke lengths (3.04°), so the sweep
 * stays on the painted arc it started on.
 */
export const SKY_RIVER_PERIOD: number = SKY_SWIRL_PERIOD;
/**
 * The forward-and-back arm's band wavelength along the stream coordinate, radians: 30°, 2π / 12,
 * so the background coordinate's wrap behind the painter (2π) is a whole number of bands and the
 * phase has no seam there. The bands travel downstream at λ / PERIOD = 3.75°/s. At 10° the
 * painter view's counter-flow read 0.21 even with the phasor blend (SkyRiverGuide.phase); 30°
 * reads 0.077-0.088, under the wave-like 0.1 bar (docs/verification.md, Sky river field, fix
 * round 1).
 */
export const SKY_RIVER_WAVELENGTH: number = (2 * Math.PI) / 12;

/**
 * The guide blend's Gaussian width, radians of angle from a polyline: 3°. 4° let the outer S lobe's
 * descent (path 3) outvote the inner lobe's hook (path 4) above the hook, where they are 1.5° and
 * 5° away: path 4's agreement fell to 0.87.
 */
export const SKY_RIVER_GUIDE_SIGMA: number = 3 * DEG;
/**
 * The background drift's weight in the guide blend, against a polyline's weight of 1 on it: 0.1,
 * so a polyline rules within about 2.1 σ (6.4° at the default width) and the drift past that, and
 * the sky away from the drawing still flows left to right.
 */
export const SKY_RIVER_GUIDE_BACKGROUND: number = 0.1;
/**
 * The signed speed's saturation (fix round 2): a stroke's signed share of the river's speed is
 * clamp((t̂ · ḡ) / SKY_RIVER_SIGN_SLOPE, −1, 1), with ḡ the guide blend Σ w t / Σ w (not its unit
 * heading), so it is odd and continuous in both: a stroke lying across the guide, or between two
 * guides that oppose and cancel, slows through zero instead of flipping. 0.5: full speed within
 * 60° of a fully agreeing guide. At 0.3 a stroke turning off the guide stepped its half-loop
 * offset by up to 0.13° per 0.02° (seed 1, the river seam test), over the 0.1° bar.
 */
export const SKY_RIVER_SIGN_SLOPE: number = 0.5;
/**
 * The soft blend of a polyline's segments (fix round 2): each segment's weight is a Gaussian of
 * its distance less the nearest segment's, this wide, radians (1°), so the path's tangent and
 * stream coordinate turn smoothly where its nearest segment changes instead of jumping.
 */
export const SKY_RIVER_SEGMENT_SIGMA: number = 1 * DEG;
/**
 * The winding fade (fix round 2): wheelflow's travel is scaled by smoothstep(0,
 * SKY_RIVER_PHASE_FADE, |Σ w e^{iφ}| / Σ w), the guide's phasor blend's own magnitude, so it goes
 * to zero at a winding where the phasors cancel, as the wave wrap's skyWaveFade does.
 */
export const SKY_RIVER_PHASE_FADE: number = 0.5;

/** Half-width, flow.png texels, of the box that smooths the orientation at the river's scale. */
export const SKY_RIVER_SMOOTH_RADIUS: number = 24;
/**
 * The S-core fade: the amplitude is smoothstep(SKY_RIVER_CORE) of the river-scale orientation
 * coherence (the mean of the doubled-angle unit vectors in the box, 1 where every texel agrees),
 * so where the painted orientation is ambiguous, the very centre of a lobe, the stroke holds still.
 * [0.05, 0.6] (fix round 2): the narrower stage-1 ramp, [0.15, 0.4], stepped the half-loop offset
 * by up to 0.17° per 0.02° where the coherence falls fast (top left, uv 0.10, 0.93), over the river
 * seam test's 0.1° bar. At [0.25, 0.55] the fade stilled 23 of the 275 strokes along the inner
 * lobe's hook.
 */
export const SKY_RIVER_CORE: readonly [number, number] = [0.05, 0.6];
/** The stream line's step either side of the stroke for its curvature, radians: 1.5°. */
export const SKY_RIVER_STEP: number = 1.5 * DEG;
/**
 * The tightest path radius, radians: 3°, about the small right swirl's members' edge (2.86°), the
 * tightest arc the painting holds. The curvature is capped at cot 3° = 19.1.
 */
export const SKY_RIVER_MIN_RADIUS: number = 3 * DEG;
export const SKY_RIVER_MAX_CURVATURE: number = 1 / Math.tan(SKY_RIVER_MIN_RADIUS);
/**
 * Bound on a river stroke's turn about the view direction, radians: half a loop at
 * SKY_RIVER_SPEED times SKY_RIVER_MAX_CURVATURE, 0.625, since |ω · d̂| = A v κ with A ≤ 1. Above
 * SKY_SWIRL_MAX_TURN (0.4): stroke.vert.glsl's polynomial pair then errs by 6.3e-3 (cosine) and
 * 7.9e-4 (sine), a turn 0.18° short and a quad 0.994 of its size; with REACTIVE_MAX_TURN on top
 * (1.125) the turn is 3.1° short and the quad 0.961, and c² + s² ≤ 1 still holds (up to √3).
 */
export const SKY_RIVER_MAX_TURN: number =
  0.5 * SKY_SWIRL_PERIOD * SKY_RIVER_SPEED * SKY_RIVER_MAX_CURVATURE;
/**
 * How far a stroke's own long axis may lie off the smoothed painted orientation and still be its
 * direction: fully its own within 15°, the smoothed field's past 40°, blended between (cosines).
 * In frame the scatter lays a stroke along flow.png at its own uv, so almost every stroke uses its
 * own axis; the extrapolated ones (out-of-palette colour) carry random axes and take the field's.
 */
export const SKY_RIVER_OWN_AXIS: readonly [number, number] = [
  Math.cos(40 * DEG),
  Math.cos(15 * DEG),
];
/** Inside the frame edge, the band over which the painted direction eases onto the guide's: 2°. */
export const SKY_RIVER_EDGE_IN: number = 2 * DEG;
/** Past the frame edge, the band over which the river eases into the background drift: 10°. */
export const SKY_RIVER_EDGE_BAND: number = 10 * DEG;
/**
 * The background drift's rate about the vertical, as a share of SKY_RIVER_SPEED: 0.5, so the
 * dome outside the canvas drifts at 0.23°/s at the horizon, slower towards the zenith.
 */
export const SKY_RIVER_DRIFT_SHARE: number = 0.5;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec3): Vec3 => scale(a, 1 / norm(a));
const angleBetween = (a: Vec3, b: Vec3): number => Math.atan2(norm(cross(a, b)), dot(a, b));
/** `v` less its part along unit `d`: its projection onto the tangent plane at d. */
const tangential = (v: Vec3, d: Vec3): Vec3 => {
  const k = dot(v, d);
  return [v[0] - k * d[0], v[1] - k * d[1], v[2] - k * d[2]];
};
/** The point h radians from unit d along the great circle in unit tangent direction t. */
const step = (d: Vec3, t: Vec3, h: number): Vec3 => {
  const c = Math.cos(h);
  const s = Math.sin(h);
  return [c * d[0] + s * t[0], c * d[1] + s * t[1], c * d[2] + s * t[2]];
};

/** The drift's unit direction at d: about −Y, so rightwards in front of −Z. Zero at the poles. */
function driftVelocity(d: Vec3): Vec3 {
  return [-d[2], 0, d[0]];
}

/** The drift's stream coordinate: the azimuth from −Z towards +X, radians. */
function driftCoordinate(d: Vec3): number {
  return Math.atan2(d[0], -d[2]);
}

// ---------------------------------------------------------------------------------------------
// The frame.

const TAN_HALF_Y = Math.tan((CANVAS_FOV_Y_DEG * Math.PI) / 360);
const TAN_HALF_X = CANVAS_ASPECT * TAN_HALF_Y;
const RIGHT: Vec3 = [1, 0, 0];
const UP: Vec3 = [0, Math.cos(CANVAS_PITCH), Math.sin(CANVAS_PITCH)];
const FORWARD: Vec3 = [0, Math.sin(CANVAS_PITCH), -Math.cos(CANVAS_PITCH)];
/** The four side planes' inward unit normals: a direction is in frame where each dot is ≥ 0. */
const SIDES: readonly Vec3[] = [
  unit([FORWARD[0] * TAN_HALF_X - RIGHT[0], FORWARD[1] * TAN_HALF_X, FORWARD[2] * TAN_HALF_X]),
  unit([FORWARD[0] * TAN_HALF_X + RIGHT[0], FORWARD[1] * TAN_HALF_X, FORWARD[2] * TAN_HALF_X]),
  unit([
    FORWARD[0] * TAN_HALF_Y - UP[0],
    FORWARD[1] * TAN_HALF_Y - UP[1],
    FORWARD[2] * TAN_HALF_Y - UP[2],
  ]),
  unit([
    FORWARD[0] * TAN_HALF_Y + UP[0],
    FORWARD[1] * TAN_HALF_Y + UP[1],
    FORWARD[2] * TAN_HALF_Y + UP[2],
  ]),
];
const HALF_DIAGONAL = Math.atan(Math.hypot(TAN_HALF_X, TAN_HALF_Y));

/**
 * The signed angle, radians, from unit direction `d` to the canvas frame's edge: negative inside
 * the frame (minus the angle to the nearest side), positive outside. Past one side it is the
 * angle out of that side's plane; behind the eye, where the side planes cross, the angle from the
 * optical axis less the frame's half diagonal takes over, so it grows to about 138° straight
 * behind.
 */
export function skyRiverFrameDistance(d: Vec3): number {
  let out = -Infinity;
  for (const n of SIDES) out = Math.max(out, Math.asin(Math.max(-1, Math.min(1, -dot(n, d)))));
  return Math.max(out, angleBetween(d, FORWARD) - HALF_DIAGONAL);
}

// ---------------------------------------------------------------------------------------------
// The guide: Paul's polylines on the sphere.

interface RiverDoc {
  readonly paths: readonly {
    readonly note: string;
    readonly uv: readonly (readonly number[])[];
    readonly sigmaDeg?: number;
  }[];
}

/** One of Paul's polylines on the sphere, with its stream coordinate at each point. */
export interface SkyRiverPath {
  readonly note: string;
  /** Canvas uv, v up, in flow order. */
  readonly uv: readonly (readonly [number, number])[];
  /** Unit directions from PAINTER_EYE. */
  readonly points: readonly Vec3[];
  /** The stream coordinate at each point, radians: chained along the river from path 1. */
  readonly s: readonly number[];
  /** Its Gaussian width in the guide blend, radians. */
  readonly sigma: number;
}

/**
 * The guide polylines on the sphere. The stream coordinate runs along each in arc length, and
 * each path starts where the last ended plus the gap between them, so it rises monotonically
 * along the river. Path 1 starts at the background drift's coordinate there, so the two agree
 * where the river enters.
 */
export function skyRiverPaths(
  doc: RiverDoc = riverJson as unknown as RiverDoc,
): readonly SkyRiverPath[] {
  const out: SkyRiverPath[] = [];
  let last: Vec3 | null = null;
  let sLast = 0;
  for (const path of doc.paths) {
    const uv = path.uv.map((p) => [p[0], p[1]] as [number, number]);
    const points = uv.map(([u, v]) => canvasRay(u, v));
    const s: number[] = [];
    let acc = last === null ? driftCoordinate(points[0]) : sLast + angleBetween(last, points[0]);
    points.forEach((p, i) => {
      if (i > 0) acc += angleBetween(points[i - 1], p);
      s.push(acc);
    });
    last = points[points.length - 1];
    sLast = acc;
    const sigma = path.sigmaDeg === undefined ? SKY_RIVER_GUIDE_SIGMA : path.sigmaDeg * DEG;
    out.push(Object.freeze({ note: path.note, uv, points, s, sigma }));
  }
  return Object.freeze(out);
}

export const SKY_RIVER_PATHS: readonly SkyRiverPath[] = skyRiverPaths();

/** The nearest point of a polyline to a direction. */
export interface SkyRiverNearest {
  /** Angle from the direction to the nearest point, radians. */
  readonly distance: number;
  /** The polyline's unit flow direction there (its segment's chord), in world space. */
  readonly tangent: Vec3;
  /** The stream coordinate there. */
  readonly s: number;
}

/**
 * The nearest point on `path` to unit direction `d`, over its segments' chords. The search ranks
 * segments by the cosine to d of their nearest chord point, with no allocation, and builds the
 * result for the winner alone (the bake runs it for every sky stroke at world build).
 */
export function skyRiverNearest(path: SkyRiverPath, d: Vec3): SkyRiverNearest {
  const pts = path.points;
  let bestI = -1;
  let bestT = 0;
  let bestCos = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const ab2 = abx * abx + aby * aby + abz * abz;
    const ad = (d[0] - a[0]) * abx + (d[1] - a[1]) * aby + (d[2] - a[2]) * abz;
    const t = Math.min(1, Math.max(0, ad / ab2));
    const px = a[0] + t * abx;
    const py = a[1] + t * aby;
    const pz = a[2] + t * abz;
    const c = (px * d[0] + py * d[1] + pz * d[2]) / Math.sqrt(px * px + py * py + pz * pz);
    if (c > bestCos) {
      bestCos = c;
      bestI = i;
      bestT = t;
    }
  }
  if (bestI < 0) throw new Error('a guide path needs two points');
  const a = pts[bestI - 1];
  const b = pts[bestI];
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const p = unit([a[0] + bestT * ab[0], a[1] + bestT * ab[1], a[2] + bestT * ab[2]]);
  return {
    distance: angleBetween(p, d),
    tangent: unit(ab),
    s: path.s[bestI - 1] + bestT * (path.s[bestI] - path.s[bestI - 1]),
  };
}

/** A polyline's segments blended softly round a direction (skyRiverSoft). */
export interface SkyRiverSoft {
  /** Angle from the direction to the nearest point of the polyline, radians. */
  readonly distance: number;
  /** Σ k t / Σ k of the segments' unit chords: length 1 where one segment rules. */
  readonly tangent: Vec3;
  /** Σ k s / Σ k of the stream coordinate at each segment's nearest point. */
  readonly s: number;
  /** Σ k (cos, sin)(2π s / SKY_RIVER_WAVELENGTH) / Σ k. */
  readonly phasor: readonly [number, number];
}

/**
 * The polyline's segments round unit direction `d`, each weighted by exp(−(c_i − c_min) /
 * (2 σ²)) of its nearest point's chord² c_i = 2 (1 − cos) to d (SKY_RIVER_SEGMENT_SIGMA), so
 * every output is a continuous function of d: no hard argmin.
 */
let softChord = new Float64Array(64);
let softT = new Float64Array(64);

export function skyRiverSoft(path: SkyRiverPath, d: Vec3): SkyRiverSoft {
  const pts = path.points;
  const n = pts.length - 1;
  if (n < 1) throw new Error('a guide path needs two points');
  if (softChord.length < n) {
    softChord = new Float64Array(n);
    softT = new Float64Array(n);
  }
  const chord = softChord;
  const ts = softT;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const ab2 = abx * abx + aby * aby + abz * abz;
    const ad = (d[0] - a[0]) * abx + (d[1] - a[1]) * aby + (d[2] - a[2]) * abz;
    const u = Math.min(1, Math.max(0, ad / ab2));
    const px = a[0] + u * abx;
    const py = a[1] + u * aby;
    const pz = a[2] + u * abz;
    const c = (px * d[0] + py * d[1] + pz * d[2]) / Math.sqrt(px * px + py * py + pz * pz);
    chord[i] = 2 * (1 - Math.min(1, c));
    ts[i] = u;
    if (chord[i] < min) min = chord[i];
  }
  const inv = 1 / (2 * SKY_RIVER_SEGMENT_SIGMA ** 2);
  const k = (2 * Math.PI) / SKY_RIVER_WAVELENGTH;
  let wsum = 0;
  let tx = 0;
  let ty = 0;
  let tz = 0;
  let s = 0;
  let pc = 0;
  let ps = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.exp(-(chord[i] - min) * inv);
    if (w < 1e-9) continue;
    const a = pts[i];
    const b = pts[i + 1];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const l = Math.sqrt(abx * abx + aby * aby + abz * abz);
    const si = path.s[i] + ts[i] * (path.s[i + 1] - path.s[i]);
    wsum += w;
    tx += (w * abx) / l;
    ty += (w * aby) / l;
    tz += (w * abz) / l;
    s += w * si;
    pc += w * Math.cos(k * si);
    ps += w * Math.sin(k * si);
  }
  return {
    distance: 2 * Math.asin(Math.min(1, 0.5 * Math.sqrt(min))),
    tangent: [tx / wsum, ty / wsum, tz / wsum],
    s: s / wsum,
    phasor: [pc / wsum, ps / wsum],
  };
}

/** The blended guide at a direction. */
export interface SkyRiverGuide {
  /** Unit heading in the tangent plane at the direction, or zero where the blend cancels. */
  readonly heading: Vec3;
  /** The blend itself, Σ w t / Σ w in the tangent plane: agreement times heading, continuous. */
  readonly blend: Vec3;
  /** |Σ w e^{iφ}| / Σ w of the phase blend, in [0, 1]: 0 at a winding. */
  readonly phaseStrength: number;
  /** |Σ w t| / Σ w, in [0, 1]: how much the blended tangents agree. */
  readonly agreement: number;
  /** The blended stream coordinate, radians. */
  readonly s: number;
  /**
   * The forward-and-back arm's loop phase before the jitter, in [0, 1): −arg / 2π of the
   * same weights' blend of unit phasors exp(i 2π s / SKY_RIVER_WAVELENGTH), one per path, so
   * where two paths' coordinates disagree the phase turns by at most half a loop across the
   * crossover instead of by their whole difference in wavelengths. Where the phasors cancel the
   * phase is a winding, as the wave wrap's are.
   */
  readonly phase: number;
}

/**
 * The guide at unit direction `d`: each polyline's tangent at its nearest point, weighted by a
 * Gaussian of the angle to it (its `sigma`, SKY_RIVER_GUIDE_SIGMA unless the data narrows it), plus
 * the background drift's direction at SKY_RIVER_GUIDE_BACKGROUND, summed as vectors in the tangent
 * plane at d. The stream coordinate is blended with the same weights.
 */
export function skyRiverGuide(
  d: Vec3,
  paths: readonly SkyRiverPath[] = SKY_RIVER_PATHS,
): SkyRiverGuide {
  const drift = driftVelocity(d);
  const driftLength = norm(drift);
  const w0 = SKY_RIVER_GUIDE_BACKGROUND;
  let g: Vec3 = driftLength > 1e-9 ? scale(drift, w0 / driftLength) : [0, 0, 0];
  let total = w0;
  const k = (2 * Math.PI) / SKY_RIVER_WAVELENGTH;
  const s0 = driftCoordinate(d);
  let s = w0 * s0;
  let pc = w0 * Math.cos(k * s0);
  let ps = w0 * Math.sin(k * s0);
  for (const path of paths) {
    const near = skyRiverSoft(path, d);
    const w = Math.exp(-(near.distance * near.distance) / (2 * path.sigma ** 2));
    if (w < 1e-12) continue;
    const t = tangential(near.tangent, d);
    g = [g[0] + w * t[0], g[1] + w * t[1], g[2] + w * t[2]];
    total += w;
    s += w * near.s;
    pc += w * near.phasor[0];
    ps += w * near.phasor[1];
  }
  g = tangential(g, d);
  const length = norm(g);
  return {
    heading: length > 1e-9 ? scale(g, 1 / length) : [0, 0, 0],
    blend: scale(g, 1 / total),
    phaseStrength: Math.hypot(pc, ps) / total,
    agreement: length / total,
    s: s / total,
    phase: (((-Math.atan2(ps, pc) / (2 * Math.PI)) % 1) + 1) % 1,
  };
}

// ---------------------------------------------------------------------------------------------
// The painted orientation at the river's scale.

/** flow.png's orientation smoothed at the river's scale, as mean doubled-angle unit vectors. */
export interface SkyRiverField {
  readonly width: number;
  readonly height: number;
  /** Mean cos 2θ and sin 2θ over the box; their length is the coherence. */
  readonly x: Float32Array;
  readonly y: Float32Array;
}

/** Smooths `flow`'s orientation over a (2r + 1)² box, SKY_RIVER_SMOOTH_RADIUS by default. */
export function buildSkyRiverField(
  flow: FlowField,
  radius: number = SKY_RIVER_SMOOTH_RADIUS,
): SkyRiverField {
  return drain(buildSkyRiverFieldSteps(flow, radius));
}

/** Pixels whose doubled angle is taken between two yields of `buildSkyRiverFieldSteps`. */
const FIELD_SLICE = 65_536;

/** `buildSkyRiverField` as steps for the world build's slicer. */
export function* buildSkyRiverFieldSteps(
  flow: FlowField,
  radius: number = SKY_RIVER_SMOOTH_RADIUS,
): Steps<SkyRiverField> {
  const { width, height, angle } = flow;
  const n = width * height;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % FIELD_SLICE === 0) yield;
    x[i] = Math.cos(2 * angle[i]);
    y[i] = Math.sin(2 * angle[i]);
  }
  const scratch = new Float32Array(n);
  yield* boxBlurSteps(x, width, height, radius, scratch);
  yield* boxBlurSteps(y, width, height, radius, scratch);
  return { width, height, x, y };
}

/** The smoothed orientation (painting angle in [0, π)) and its coherence at (u, v), bilinear. */
export function skyRiverOrientation(
  field: SkyRiverField,
  u: number,
  v: number,
): { angle: number; coherence: number } {
  const { width, height } = field;
  const fx = Math.min(width - 1, Math.max(0, u * width - 0.5));
  const fy = Math.min(height - 1, Math.max(0, (1 - v) * height - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (a: Float32Array): number =>
    (a[y0 * width + x0] * (1 - tx) + a[y0 * width + x1] * tx) * (1 - ty) +
    (a[y1 * width + x0] * (1 - tx) + a[y1 * width + x1] * tx) * ty;
  const mx = at(field.x);
  const my = at(field.y);
  const theta = 0.5 * Math.atan2(my, mx);
  return { angle: theta < 0 ? theta + Math.PI : theta, coherence: Math.hypot(mx, my) };
}

const COS_P = Math.cos(CANVAS_PITCH);
const SIN_P = Math.sin(CANVAS_PITCH);

/**
 * The smoothed painted orientation at unit direction `d` as an unsigned unit tangent on the
 * sphere, with its coherence: the image of painting angle θ at d's canvas uv, clamped to the
 * frame, exactly as cameraDirection lays a stroke (the tangent plane at d meets the plane through
 * the eye spanned by d and the screen direction). Null behind the eye.
 */
export function skyRiverTangent(
  field: SkyRiverField,
  d: Vec3,
): { tangent: Vec3; coherence: number } | null {
  const { uv } = projectToCanvas([
    PAINTER_EYE[0] + d[0],
    PAINTER_EYE[1] + d[1],
    PAINTER_EYE[2] + d[2],
  ]);
  if (uv === null) return null;
  const u = Math.min(1, Math.max(0, uv[0]));
  const v = Math.min(1, Math.max(0, uv[1]));
  const { angle, coherence } = skyRiverOrientation(field, u, v);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = tangential([c, s * COS_P, s * SIN_P], d);
  const length = norm(t);
  if (length < 1e-9) return null;
  return { tangent: scale(t, 1 / length), coherence };
}

/** `t` turned to agree in sign with `ref` (both unsigned axes). */
const aligned = (t: Vec3, ref: Vec3): Vec3 => (dot(t, ref) < 0 ? scale(t, -1) : t);

/**
 * The geodesic curvature, signed towards d̂ × t̂, of the smoothed painted stream line through unit
 * direction `d` with unit tangent `t`: the small circle through the stream line's points
 * SKY_RIVER_STEP either side of d (each reached by a midpoint step), as κ = cot ρ, capped at
 * SKY_RIVER_MAX_CURVATURE. 0 where a step leaves the field.
 */
export function skyRiverCurvature(field: SkyRiverField, d: Vec3, t: Vec3): number {
  const h = SKY_RIVER_STEP;
  const reach = (sign: number): Vec3 | null => {
    const dir = scale(t, sign);
    const half = step(d, dir, 0.5 * h);
    const mid = skyRiverTangent(field, half);
    if (mid === null) return null;
    const along = tangential(aligned(mid.tangent, dir), d);
    const l = norm(along);
    if (l < 1e-9) return null;
    return step(d, scale(along, 1 / l), h);
  };
  const ahead = reach(1);
  const behind = reach(-1);
  if (ahead === null || behind === null) return 0;
  const n = cross(
    [ahead[0] - d[0], ahead[1] - d[1], ahead[2] - d[2]],
    [behind[0] - d[0], behind[1] - d[1], behind[2] - d[2]],
  );
  const m = cross(d, t);
  const nd = dot(n, d);
  const nm = dot(n, m);
  const k = SKY_RIVER_MAX_CURVATURE;
  if (Math.abs(nm) * k <= Math.abs(nd)) return nd * nm >= 0 ? k : -k;
  return nd / nm;
}

// ---------------------------------------------------------------------------------------------
// The bake.

/** A sky stroke's baked river motion. */
export interface SkyRiverBake {
  /**
   * The rotation vector, rad/s at calm 1: the stroke's centre moves at omega × d̂ and turns at
   * omega · d̂. Zero for a kept wheel's member, which turns with its wheel.
   */
  readonly omega: Vec3;
  /** The kept wheel (index in SKY_RIVER_WHEELS) whose member the stroke is, or -1. */
  readonly member: number;
  /** |omega × d̂| / SKY_RIVER_SPEED: the stroke's travel share of the river's speed, in [0, 1]. */
  readonly amplitude: number;
  /** Which way along its axis Paul's arrows send it: ±1. */
  readonly sign: number;
  /** The capped geodesic curvature of its path, towards d̂ × t̂. */
  readonly curvature: number;
  /** The river-scale orientation coherence at it, 0 outside the frame. */
  readonly coherence: number;
  /** The signed angle to the frame edge, radians (skyRiverFrameDistance). */
  readonly frame: number;
  /** The blended stream coordinate, radians. */
  readonly s: number;
  /** The forward-and-back arm's loop phase before the jitter (SkyRiverGuide.phase). */
  readonly phase: number;
  /**
   * The winding fade, smoothstep(0, SKY_RIVER_PHASE_FADE, SkyRiverGuide.phaseStrength), rounded
   * to 1/255: wheelflow scales its travel by it.
   */
  readonly phaseFade: number;
  /** iRiver.w: round(255 phaseFade) + phase, so fract gives the phase and floor the fade. */
  readonly packed: number;
}

const ZERO: Vec3 = [0, 0, 0];

/**
 * The river motion of a sky stroke at unit direction `d` from PAINTER_EYE whose own long axis is
 * `axis` (any vector; omitted for a point of the field, which then takes the smoothed painted
 * orientation). See the module comment for the rotation; the steps:
 * 1. A kept wheel's member gets no river motion.
 * 2. Its direction t̂ is its own axis, eased onto the smoothed painted orientation as the two part
 *    (SKY_RIVER_OWN_AXIS), and κ the painted stream line's curvature.
 * 3. σ = sign(t̂ · ĝ) against the guide's heading ĝ, and A the sign ramp times the S-core fade.
 * 4. Over SKY_RIVER_EDGE_IN inside the frame edge the rotation eases onto the guide's own,
 *    v (d̂ × ĝ), and over SKY_RIVER_EDGE_BAND past it onto the background drift about the vertical.
 */
export function skyRiverBake(
  field: SkyRiverField,
  d: Vec3,
  axis?: Vec3,
  paths: readonly SkyRiverPath[] = SKY_RIVER_PATHS,
  wheels: readonly SkyWheel[] = SKY_RIVER_WHEELS,
): SkyRiverBake {
  const frame = skyRiverFrameDistance(d);
  const guide = skyRiverGuide(d, paths);
  const phase = guide.phase;
  const fadeLevel = Math.round(255 * smoothstep(0, SKY_RIVER_PHASE_FADE, guide.phaseStrength));
  const member = skyWheelAt(d, wheels);
  const base = {
    member,
    frame,
    s: guide.s,
    phase,
    phaseFade: fadeLevel / 255,
    packed: fadeLevel + Math.min(phase, 1 - 2 ** -12),
  };
  if (member >= 0) {
    return { ...base, omega: ZERO, amplitude: 0, sign: 1, curvature: 0, coherence: 0 };
  }
  const v = SKY_RIVER_SPEED;
  const painted = frame < SKY_RIVER_EDGE_BAND ? skyRiverTangent(field, d) : null;
  let omegaPaint: Vec3 = ZERO;
  let sign = 1;
  let curvature = 0;
  let coherence = 0;
  if (painted !== null) {
    let t = painted.tangent;
    curvature = skyRiverCurvature(field, d, t);
    coherence = painted.coherence;
    if (axis !== undefined) {
      const own = tangential(axis, d);
      const ol = norm(own);
      if (ol > 1e-9) {
        const a = aligned(scale(own, 1 / ol), t);
        const w = smoothstep(SKY_RIVER_OWN_AXIS[0], SKY_RIVER_OWN_AXIS[1], dot(a, t));
        // κ is towards d̂ × t̂ of the field's t̂; the blend keeps t̂'s sense, so it still applies.
        t = unit([t[0] + w * (a[0] - t[0]), t[1] + w * (a[1] - t[1]), t[2] + w * (a[2] - t[2])]);
      }
    }
    const along = dot(t, guide.blend);
    sign = along < 0 ? -1 : 1;
    const signed =
      Math.min(1, Math.max(-1, along / SKY_RIVER_SIGN_SLOPE)) *
      smoothstep(SKY_RIVER_CORE[0], SKY_RIVER_CORE[1], coherence);
    const m = cross(d, t);
    const k = signed * v;
    omegaPaint = [
      k * (curvature * d[0] + m[0]),
      k * (curvature * d[1] + m[1]),
      k * (curvature * d[2] + m[2]),
    ];
  }
  const omegaGuide = scale(cross(d, guide.blend), v);
  const toGuide = painted === null ? 1 : smoothstep(-SKY_RIVER_EDGE_IN, 0, frame);
  const river: Vec3 = [
    omegaPaint[0] + toGuide * (omegaGuide[0] - omegaPaint[0]),
    omegaPaint[1] + toGuide * (omegaGuide[1] - omegaPaint[1]),
    omegaPaint[2] + toGuide * (omegaGuide[2] - omegaPaint[2]),
  ];
  const toDrift = smoothstep(0, SKY_RIVER_EDGE_BAND, frame);
  const drift: Vec3 = [0, -SKY_RIVER_DRIFT_SHARE * v, 0];
  const omega: Vec3 = [
    river[0] + toDrift * (drift[0] - river[0]),
    river[1] + toDrift * (drift[1] - river[1]),
    river[2] + toDrift * (drift[2] - river[2]),
  ];
  const amplitude = norm(cross(omega, d)) / v;
  return { ...base, omega, amplitude, sign, curvature, coherence };
}

/** The velocity a baked rotation gives unit direction `d`: omega × d̂, rad/s. */
export function skyRiverVelocity(bake: SkyRiverBake, d: Vec3): Vec3 {
  return cross(bake.omega, d);
}

// ---------------------------------------------------------------------------------------------
// The per-instance attribute.

/** Bytes iRiver adds per instance to a chunk that holds sky strokes: four float32. */
export const SKY_RIVER_BYTES = 16;

/** A chunk's instance arrays, as the batch stores them (snorm16 normal, unorm16 tangent). */
export interface SkyRiverSource {
  readonly count: number;
  readonly position: ArrayLike<number>;
  readonly normal: ArrayLike<number>;
  readonly tangent: ArrayLike<number>;
  readonly meta: ArrayLike<number>;
}

/** Sky strokes baked between two yields of `skyRiverInstancesSteps`. */
const RIVER_SLICE = 256;

/**
 * A chunk's iRiver (stroke.vert.glsl): per instance its river rotation vector ω (rad/s) and the
 * forward-and-back arm's phase, skyRiverBake of its direction from PAINTER_EYE and its own long
 * axis as the GPU decodes it (octDecode, strokeAxes). Zero off the sky layer and for a kept
 * wheel's member, which turns with its wheel. Null when the chunk holds no sky stroke. It bakes
 * from the chunk's own arrays, since a merged dome chunk interleaves its cells' strokes.
 */
export function* skyRiverInstancesSteps(
  field: SkyRiverField,
  source: SkyRiverSource,
): Steps<Float32Array | null> {
  const { count, position, normal, tangent, meta } = source;
  let out: Float32Array | null = null;
  let baked = 0;
  for (let i = 0; i < count; i++) {
    if (meta[i * 4 + 1] !== STROKE_LAYER.sky) continue;
    if (++baked % RIVER_SLICE === 0) yield;
    out ??= new Float32Array(count * 4);
    const dx = position[3 * i] - PAINTER_EYE[0];
    const dy = position[3 * i + 1] - PAINTER_EYE[1];
    const dz = position[3 * i + 2] - PAINTER_EYE[2];
    const l = Math.hypot(dx, dy, dz);
    if (l === 0) continue;
    const n = octDecode(
      Math.max(-1, normal[2 * i] / 32767),
      Math.max(-1, normal[2 * i + 1] / 32767),
    );
    const axis = strokeAxes(n, (tangent[i] / 65535) * 2 * Math.PI).long as Vec3;
    const bake = skyRiverBake(field, [dx / l, dy / l, dz / l], axis);
    out[4 * i] = bake.omega[0];
    out[4 * i + 1] = bake.omega[1];
    out[4 * i + 2] = bake.omega[2];
    out[4 * i + 3] = bake.packed;
  }
  return out;
}
