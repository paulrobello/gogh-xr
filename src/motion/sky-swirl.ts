/**
 * Sky swirl and wind (P4.2): the sky layer's motion. The velocity field lives on the sphere of view
 * directions from PAINTER_EYE, the dome's centre, so the dome and the boundary haze move by the same
 * angle and the painter's view stays one painting. It is a sum of Rankine-style vortices, authored
 * on the canvas in regions.json (`vortices`) and projected onto the dome through the painter camera,
 * plus a horizontal drift: a slow turn of the whole sky about the vertical, left to right in front
 * of the painter.
 *
 * Each term is a rotation rate about an axis through the eye, so the field is one rotation vector
 * `omega(d̂) = Σ ωᵢ(d̂) cᵢ + drift`, and a stroke at d moves with velocity `omega × d`. Vortex i turns
 * at `ωᵢ = Γᵢ / max(s², Rᵢ²)` about its centre direction cᵢ, where s² = 2 − 2 cᵢ·d̂ is the squared
 * chord to the centre: solid-body inside the core radius Rᵢ, angular speed falling as 1/s outside,
 * continuous at the edge, with no square root or inverse trigonometry and no antipodal twin.
 *
 * A stroke travels along its local flow for one period and wraps: `τ = PERIOD (f − ½)` with
 * `f = fract(t / PERIOD + phase)`, offset `τ (omega × d)`, so every stroke sweeps one short arc around
 * its rest position and never drifts off its region. The same rotation turns the stroke about its
 * own normal by `τ (omega · n)`, so its orientation follows the flow. Near the wrap the stroke
 * shrinks to nothing and grows back (`gain`), so the jump back is never a pop. That is the `base`
 * wrap. The app ships `wave` as the default (src/motion/variants.ts, Paul's 2026-11-08 choice), which
 * replaces the shrink with a travel ahead and back in bands. `wheel`, `stream`, `base` and
 * `pingpong` are the A/B alternatives (`?wrap`, `?ab=wrap`). Two of them have no loop along the
 * arc at all (2026-11-09, after Paul rejected lift's reset): `wheel` turns each vortex's core
 * rigidly and forever about its centre direction (skyWheels) and holds every other sky stroke
 * still, and `stream` holds every sky stroke still and scrolls its brush tone along its length in
 * the fragment shader (skyStreamTone).
 *
 * motion.glsl's `skyMotion` is the GLSL; `skySwirlGlslDefines` hands it these tables as defines, so
 * the two read one source. Change them together.
 */
import regionsJson from '../../assets/bake/starry-night/regions.json';
import { canvasRay, PAINTER_EYE } from '../paintings/starry-night/canvas-camera';
import type { Vec3 } from '../render/strokes/frame';
import { SKY_DOME_RADIUS } from '../world/sky';
import { MOTION_TIME_WRAP_S } from './clock';
import { SKY_WAVE_TURNS, type SkyWaveTurns, type SkyWrap } from './variants';

/** Seconds per loop: 3600 / 450, so it divides the 3600 s wrap of uTime (ruling R-P4d). */
export const SKY_SWIRL_PERIOD: number = 8;
/** The drift's rate about the vertical, rad/s. Positive drifts left to right in front of -Z. */
export const SKY_DRIFT_RATE: number = 0.0015;
/**
 * The share of each loop, at either end, over which the stroke grows from nothing or shrinks to it.
 * 0.06 keeps 88% of the loop at full size, so the average stroke keeps about 92.5% of its area
 * (the fades lose 1 − E[smoothstep²] = 0.63 of their share). Ruling R-P4m halved it from 0.12 for
 * the pinned coverage margin; the stroke regrows over 0.48 s of its 8 s loop.
 */
export const SKY_SWIRL_FADE: number = 0.06;
/**
 * Bound on the field's angular speed `|omega × d̂|` over the whole sphere, rad/s. The unit tests
 * check it against a dense sampling of the sphere with the vortex peaks included.
 */
export const SKY_SWIRL_MAX_SPEED: number = 0.0085;
/** Bound on a stroke's angular displacement from rest: half a loop at the maximum speed, radians. */
export const SKY_SWIRL_MAX_ANGLE: number = 0.5 * SKY_SWIRL_PERIOD * SKY_SWIRL_MAX_SPEED;
/**
 * Bound on a sky stroke's displacement, metres: SKY_SWIRL_MAX_ANGLE at the dome. Every sky-layer
 * stroke lies within SKY_DOME_RADIUS of PAINTER_EYE (the dome's triangles are chords and the haze
 * is nearer), so the stroke batch grows a sky chunk's cull sphere by it (ruling R-P4a).
 */
export const SKY_SWIRL_REACH: number = SKY_SWIRL_MAX_ANGLE * SKY_DOME_RADIUS;
/**
 * Bound on the field's rate of turn about any direction, `|omega · d̂|`, rad/s: fastest at the right
 * swirl's centre, about 0.089. The unit tests check it like SKY_SWIRL_MAX_SPEED.
 */
export const SKY_SWIRL_MAX_TURN_RATE: number = 0.1;
/**
 * Bound on a stroke's turn about its normal, radians: half a loop at SKY_SWIRL_MAX_TURN_RATE. Small
 * enough for stroke.vert.glsl's polynomial cosine and sine: at 0.4 the cosine errs by 1.06e-3 and
 * the sine by 8.5e-5, and c² + s² ≤ 1 holds up to √3, so a turn never grows the stroke.
 */
export const SKY_SWIRL_MAX_TURN: number = 0.5 * SKY_SWIRL_PERIOD * SKY_SWIRL_MAX_TURN_RATE;

export type Spin = 'clockwise' | 'counterclockwise';

/** A vortex as authored in regions.json: canvas uv with v down, radius in painting widths. */
export interface VortexShape {
  readonly note: string;
  readonly center: readonly [number, number];
  readonly radius: number;
  /** Angular speed at the core edge, rad/s. */
  readonly speed: number;
  /** The sense as displayed, seen from the eye. */
  readonly spin: Spin;
}

/** A vortex on the dome. */
export interface SkyVortex {
  readonly note: string;
  /** Canvas uv, v bottom to top. */
  readonly uv: readonly [number, number];
  /** Unit direction from PAINTER_EYE through the centre. */
  readonly axis: Vec3;
  /** Core radius as a chord of the unit sphere. */
  readonly core: number;
  /**
   * Γ: the rate about `axis` is Γ / max(s², core²), so the core edge moves at about Γ / core.
   * Positive is clockwise as displayed, the right-hand sense about the outward axis.
   */
  readonly gamma: number;
  readonly speed: number;
  readonly spin: Spin;
}

interface RegionsWithVortices {
  readonly vortices: { readonly shapes: readonly VortexShape[] };
}

/** The vortices of regions.json projected onto the dome through the painter's camera. */
export function skyVortices(
  doc: RegionsWithVortices = regionsJson as unknown as RegionsWithVortices,
): readonly SkyVortex[] {
  return Object.freeze(
    doc.vortices.shapes.map((shape) => {
      const u = shape.center[0];
      const v = 1 - shape.center[1];
      const axis = canvasRay(u, v);
      const edge = canvasRay(u + shape.radius, v);
      const core = Math.hypot(axis[0] - edge[0], axis[1] - edge[1], axis[2] - edge[2]);
      const sign = shape.spin === 'clockwise' ? 1 : -1;
      return Object.freeze({
        note: shape.note,
        uv: Object.freeze([u, v]) as readonly [number, number],
        axis: Object.freeze(axis) as Vec3,
        core,
        gamma: sign * shape.speed * core,
        speed: shape.speed,
        spin: shape.spin,
      });
    }),
  );
}

export const SKY_VORTICES: readonly SkyVortex[] = skyVortices();

/** The drift as a rotation vector: about -Y, so positive rates move the view's front rightwards. */
const DRIFT: Vec3 = [0, -SKY_DRIFT_RATE, 0];

/** The field's rotation vector at unit direction `dir`, rad/s. Matches the loop in skyMotion. */
export function skyOmega(dir: Vec3, vortices: readonly SkyVortex[] = SKY_VORTICES): Vec3 {
  const omega: [number, number, number] = [DRIFT[0], DRIFT[1], DRIFT[2]];
  for (const vortex of vortices) {
    const c = vortex.axis;
    const cosine = c[0] * dir[0] + c[1] * dir[1] + c[2] * dir[2];
    const rate = (0.5 * vortex.gamma) / Math.max(1 - cosine, 0.5 * vortex.core * vortex.core);
    omega[0] += rate * c[0];
    omega[1] += rate * c[1];
    omega[2] += rate * c[2];
  }
  return omega;
}

const cross = (a: Vec3, b: Vec3): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * The farthest the swirl moves a stroke centred at (x, y, z) from rest at calm 1, metres: half a
 * loop at its own speed, `PERIOD / 2 × |omega(d̂) × d|`. omega depends only on the rest position, so
 * this is the stroke's exact maximum, not a bound over the field. Allocation-free: the stroke batch
 * calls it for every sky stroke at build (R-P4a).
 */
export function skySwirlReach(
  x: number,
  y: number,
  z: number,
  vortices: readonly SkyVortex[] = SKY_VORTICES,
): number {
  const dx = x - PAINTER_EYE[0];
  const dy = y - PAINTER_EYE[1];
  const dz = z - PAINTER_EYE[2];
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length === 0) return 0;
  let ox = DRIFT[0];
  let oy = DRIFT[1];
  let oz = DRIFT[2];
  for (let i = 0; i < vortices.length; i++) {
    const { axis: c, gamma, core } = vortices[i];
    const cosine = (c[0] * dx + c[1] * dy + c[2] * dz) / length;
    const rate = (0.5 * gamma) / Math.max(1 - cosine, 0.5 * core * core);
    ox += rate * c[0];
    oy += rate * c[1];
    oz += rate * c[2];
  }
  const vx = oy * dz - oz * dy;
  const vy = oz * dx - ox * dz;
  const vz = ox * dy - oy * dx;
  return 0.5 * SKY_SWIRL_PERIOD * Math.sqrt(vx * vx + vy * vy + vz * vz);
}

/** The field's angular velocity at unit direction `dir`: `omega × dir`, rad/s, tangent to the sphere. */
export function skyVelocity(dir: Vec3, vortices: readonly SkyVortex[] = SKY_VORTICES): Vec3 {
  return cross(skyOmega(dir, vortices), dir);
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const fract = (x: number): number => x - Math.floor(x);

export { SKY_WAVE_TURNS, type SkyWaveTurns };

/**
 * The `wave` wrap's default wavelength, the `uWaveTurns` uniform that `?waveturns` overrides: whole
 * waves (a forward band and a returning band each) per turn round the central swirl, the strongest
 * vortex. 2 makes each band a 90° sector of the swirl. Each other vortex with a velocity zero in
 * its core winds round(turns × its circulation's share of the central swirl's), at least once, so
 * every swirl turns at about the same band rate per unit of its own flow (`skyWavePoles`). More
 * waves per turn stretch and squeeze the stroke spacing along the flow more (over the painter's
 * view, each point's worst along-flow strain has a median of 0.10, 0.14 and 0.19 at 1, 2 and 3
 * waves per turn, against base's 0.015) and raise the share of nearby strokes moving apart (within
 * 3° of the big swirl's painted centre 7%, 11% and 16%; over the dome 2.8%, 3.4% and 4.2%). Fewer
 * make each band a larger share of the swirl, half of it at 1, so the swirl sways in halves instead
 * of carrying waves along. 2 is the middle; Paul picks in the headset (`?waveturns`).
 * docs/verification.md (Sky wrap variants: wave) has the measurements.
 */
export const SKY_WAVE_PER_TURN: SkyWaveTurns = 2;
/**
 * The `wave` wrap's random offset to each stroke's loop phase, from its phase byte, as a share of
 * the loop: a spread of 1/32 (±1/64), a sixteenth of a band. It breaks the exact band edge into a
 * ragged one, so the band fronts do not read as drawn lines. A pair the jitter splits sits within
 * 1/64 of a loop of its turn, where pingpong's eased speed is at most 12% of its peak.
 */
export const SKY_WAVE_JITTER: number = 1 / 32;

/** A winding of the `wave` phase: a point on the sphere of directions it turns round. */
export interface SkyWavePole {
  readonly note: string;
  /** Unit direction from PAINTER_EYE. */
  readonly direction: Vec3;
  /** The direction's stereographic point from the nadir, `(x, z) / (1 + y)`. */
  readonly point: readonly [number, number];
  /** Whole turns of the loop phase per turn round the pole, positive clockwise as displayed. */
  readonly winding: number;
}

/** A unit direction's stereographic point from the nadir: conformal, finite above the nadir. */
const stereographic = (dir: Vec3): [number, number] => {
  const k = 1 / Math.max(1 + dir[1], 1e-6);
  return [dir[0] * k, dir[2] * k];
};

/**
 * The field's stagnation point above the painter, where the drift's turn about the vertical and the
 * vortices' far field cancel: the fixed point of `d = −omega(d) / |omega(d)|`, iterated from the
 * zenith. On the authored field it sits 57° up behind the painter.
 */
export function skyStagnation(vortices: readonly SkyVortex[] = SKY_VORTICES): Vec3 {
  let d: Vec3 = [0, 1, 0];
  for (let i = 0; i < 64; i++) {
    const w = skyOmega(d, vortices);
    const l = Math.hypot(w[0], w[1], w[2]);
    d = [-w[0] / l, -w[1] / l, -w[2] / l];
  }
  return d;
}

/** The largest velocity, rad/s, at which skyVortexCentre accepts a point as the field's zero. */
const CENTRE_RESIDUAL = 1e-12;

/**
 * The velocity zero of the whole field inside `vortex`'s core, or null when the core holds none.
 * Inside a core the vortex turns as a solid body about its axis, so its zero sits off the axis,
 * where its own turn cancels the flow the drift and the other vortices carry across it. Newton's
 * method on the velocity's two components in the axis's tangent plane, from the axis. It is a zero
 * only if it lands inside the core with |velocity| under CENTRE_RESIDUAL. A small eddy that the
 * background outruns has none: its slowest point still moves.
 */
export function skyVortexCentre(
  vortex: SkyVortex,
  vortices: readonly SkyVortex[] = SKY_VORTICES,
): Vec3 | null {
  const c = vortex.axis;
  const side = Math.abs(c[1]) < 0.9 ? [-c[2], 0, c[0]] : [1, 0, 0];
  const sl = Math.hypot(side[0], side[1], side[2]);
  const e1: Vec3 = [side[0] / sl, side[1] / sl, side[2] / sl];
  const e2 = cross(c, e1);
  const at = (a: number, b: number): Vec3 => {
    const p = [
      c[0] + a * e1[0] + b * e2[0],
      c[1] + a * e1[1] + b * e2[1],
      c[2] + a * e1[2] + b * e2[2],
    ];
    const l = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / l, p[1] / l, p[2] / l];
  };
  const residual = (a: number, b: number): [number, number] => {
    const v = skyVelocity(at(a, b), vortices);
    return [v[0] * e1[0] + v[1] * e1[1] + v[2] * e1[2], v[0] * e2[0] + v[1] * e2[1] + v[2] * e2[2]];
  };
  const h = 1e-7;
  let a = 0;
  let b = 0;
  for (let i = 0; i < 50; i++) {
    const [f1, f2] = residual(a, b);
    const [pa1, pa2] = residual(a + h, b);
    const [ma1, ma2] = residual(a - h, b);
    const [pb1, pb2] = residual(a, b + h);
    const [mb1, mb2] = residual(a, b - h);
    const j11 = (pa1 - ma1) / (2 * h);
    const j21 = (pa2 - ma2) / (2 * h);
    const j12 = (pb1 - mb1) / (2 * h);
    const j22 = (pb2 - mb2) / (2 * h);
    const det = j11 * j22 - j12 * j21;
    if (!Number.isFinite(det) || det === 0) return null;
    a -= (j22 * f1 - j12 * f2) / det;
    b -= (j11 * f2 - j21 * f1) / det;
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.hypot(a, b) > 1) return null;
  }
  const d = at(a, b);
  const chord = Math.hypot(d[0] - c[0], d[1] - c[1], d[2] - c[2]);
  if (chord >= vortex.core) return null;
  return Math.hypot(...skyVelocity(d, vortices)) < CENTRE_RESIDUAL ? d : null;
}

/**
 * The `wave` phase's windings. A vortex whose core holds a velocity zero (skyVortexCentre) winds
 * round(SKY_WAVE_PER_TURN × Γᵢ / Γ_max), at least once, in its own sense, at that zero, where the
 * strokes stand still; one without winds 0. Every phase meets at a winding, so one where the
 * strokes move would set neighbours there moving apart. The stagnation point above the painter
 * winds against their sum, so the windings cancel and the phase is single-valued over the whole
 * sphere, the nadir included. It is the drift's own centre of turn, so behind and above the
 * painter, where the drift carries the flow, the bands travel with it.
 */
export function skyWavePoles(
  vortices: readonly SkyVortex[] = SKY_VORTICES,
  perTurn: number = SKY_WAVE_PER_TURN,
): readonly SkyWavePole[] {
  const strongest = Math.max(...vortices.map((v) => Math.abs(v.gamma)));
  const poles: SkyWavePole[] = vortices.map((v) => {
    const centre = skyVortexCentre(v, vortices);
    if (!centre) {
      return {
        note: `${v.note} (no velocity zero in its core)`,
        direction: v.axis,
        point: stereographic(v.axis),
        winding: 0,
      };
    }
    const turns = Math.max(1, Math.round((perTurn * Math.abs(v.gamma)) / strongest));
    return {
      note: v.note,
      direction: centre,
      point: stereographic(centre),
      winding: Math.sign(v.gamma) * turns,
    };
  });
  const stagnation = skyStagnation(vortices);
  poles.push({
    note: 'stagnation point of the drift',
    direction: stagnation,
    point: stereographic(stagnation),
    winding: -poles.reduce((sum, p) => sum + p.winding, 0),
  });
  return Object.freeze(poles.map((p) => Object.freeze(p)));
}

/** The authored field's poles at each SKY_WAVE_TURNS wavelength. */
const POLES_BY_TURNS: ReadonlyMap<number, readonly SkyWavePole[]> = new Map(
  SKY_WAVE_TURNS.map((turns) => [turns, skyWavePoles(SKY_VORTICES, turns)]),
);

/** The poles at `turns` waves per turn, cached for the authored field. */
export function skyWavePolesFor(
  turns: number = SKY_WAVE_PER_TURN,
  vortices: readonly SkyVortex[] = SKY_VORTICES,
): readonly SkyWavePole[] {
  return (vortices === SKY_VORTICES && POLES_BY_TURNS.get(turns)) || skyWavePoles(vortices, turns);
}

/** The poles at the default SKY_WAVE_PER_TURN. */
export const SKY_WAVE_POLES: readonly SkyWavePole[] = skyWavePolesFor();

/**
 * The `wave` wrap's still radius round each non-zero winding, radians from the eye: its travel
 * amplitude ramps from 0 at the pole to full here (skyWaveFade). Every loop phase meets at a
 * winding, so without it the strokes there move apart from every phase. 3° is the widest whole
 * degree that leaves both painted centres at full amplitude: the right vortex's sits 3.7° from its
 * zero (4° would dim it) and the big swirl's 6.5° from its own. It is under the smallest core with
 * a zero (the right vortex's, 4.6°) and half the 6.5° between the two zeros, so the ramps do not
 * meet. At 2 waves per turn it cuts the speed-weighted counter-flow within 1.5° of the big swirl's
 * zero from 3.7% to 0.2% of the view's (2° to 0.9%, 4° to 0.1%). docs/verification.md (wave, fix
 * round 2) has the measurements.
 */
export const SKY_WAVE_FADE_RADIUS: number = (3 * Math.PI) / 180;

/** The poles skyWaveFade stills: the ones with a non-zero winding at any SKY_WAVE_TURNS value. */
export function skyWaveFadePoles(vortices: readonly SkyVortex[] = SKY_VORTICES): readonly Vec3[] {
  const all = SKY_WAVE_TURNS.map((turns) => skyWavePolesFor(turns, vortices));
  return all[0]
    .filter((_, i) => all.some((poles) => poles[i].winding !== 0))
    .map((p) => p.direction);
}

const FADE_POLES: readonly Vec3[] = skyWaveFadePoles();

/**
 * The `wave` wrap's amplitude at unit direction `dir`: the product over the fade poles of
 * smoothstep(0, R², chord²), R the chord of `radius`. 0 at a pole and 1 from `radius` out. Matches
 * skyWaveFade in motion.glsl.
 */
export function skyWaveFade(
  dir: Vec3,
  poles: readonly Vec3[] = FADE_POLES,
  radius: number = SKY_WAVE_FADE_RADIUS,
): number {
  const chord = 2 * Math.sin(radius / 2);
  let fade = 1;
  for (const p of poles) {
    const c2 = (dir[0] - p[0]) ** 2 + (dir[1] - p[1]) ** 2 + (dir[2] - p[2]) ** 2;
    fade *= smoothstep(0, chord * chord, c2);
  }
  return fade;
}

/**
 * The `wave` loop phase at unit direction `dir`, before the jitter, in loops: Σ windingᵢ × argᵢ / 2π,
 * argᵢ the angle round pole i in the stereographic plane. The plane keeps the view's handedness
 * (x right, z' up in front of the painter), so a clockwise swirl's arg falls along its flow and the
 * phase falls with it: a band of equal loop fraction moves downstream. Matches skyWavePhase in
 * motion.glsl.
 */
export function skyWavePhase(dir: Vec3, poles: readonly SkyWavePole[] = SKY_WAVE_POLES): number {
  const z = stereographic(dir);
  let phase = 0;
  for (const pole of poles) {
    phase += pole.winding * Math.atan2(z[1] - pole.point[1], z[0] - pole.point[0]);
  }
  return phase / (2 * Math.PI);
}

/** The floor skyWaveProductPhase and motion.glsl put under each factor's squared length. */
const WAVE_FACTOR_FLOOR = 1e-30;

/** A pole's winding as `fixed + turns × perTurn`, exact at every SKY_WAVE_TURNS value. */
interface WindingSplit {
  readonly point: readonly [number, number];
  readonly fixed: number;
  readonly perTurn: number;
}

/**
 * Each pole's winding split into a part fixed across SKY_WAVE_TURNS and a part per wave per turn,
 * so the shader can raise the per-turn product to the `uWaveTurns` uniform. Throws if a winding is
 * not linear in the turns over SKY_WAVE_TURNS.
 */
function windingSplits(vortices: readonly SkyVortex[] = SKY_VORTICES): readonly WindingSplit[] {
  const all = SKY_WAVE_TURNS.map((turns) => skyWavePolesFor(turns, vortices));
  return all[0].map((pole, i) => {
    const perTurn = all[1][i].winding - pole.winding;
    const fixed = pole.winding - SKY_WAVE_TURNS[0] * perTurn;
    SKY_WAVE_TURNS.forEach((turns, k) => {
      if (all[k][i].winding !== fixed + turns * perTurn) {
        throw new Error(`wave winding of ${pole.note} is not linear in the turns`);
      }
    });
    return { point: pole.point, fixed, perTurn };
  });
}

/**
 * skyWavePhase as motion.glsl runs it at `turns` waves per turn, with one atan: arg(F · Aᵗᵘʳⁿˢ) / 2π,
 * F = Π eᵢ^fixedᵢ and A = Π eᵢ^perTurnᵢ (windingSplits), eᵢ the unit vector from pole i to the
 * stereographic point, conjugated for a negative power. Every winding is an integer, so this equals
 * skyWavePhase up to whole loops, which the loop's fract removes. Each factor is unit length, so the
 * product neither overflows near the nadir nor underflows near a pole.
 */
export function skyWaveProductPhase(
  dir: Vec3,
  turns: number = SKY_WAVE_PER_TURN,
  vortices: readonly SkyVortex[] = SKY_VORTICES,
): number {
  const z = stereographic(dir);
  const mul = (a: number[], b: number[]): number[] => [
    a[0] * b[0] - a[1] * b[1],
    a[0] * b[1] + a[1] * b[0],
  ];
  let f = [1, 0];
  let a = [1, 0];
  for (const split of windingSplits(vortices)) {
    if (split.fixed === 0 && split.perTurn === 0) continue;
    const ex = z[0] - split.point[0];
    const ey = z[1] - split.point[1];
    const k = 1 / Math.sqrt(Math.max(ex * ex + ey * ey, WAVE_FACTOR_FLOOR));
    const e = [ex * k, ey * k];
    const c = [e[0], -e[1]];
    for (let i = 0; i < Math.abs(split.fixed); i++) f = mul(f, split.fixed > 0 ? e : c);
    for (let i = 0; i < Math.abs(split.perTurn); i++) a = mul(a, split.perTurn > 0 ? e : c);
  }
  let q = f;
  for (let i = 0; i < turns; i++) q = mul(q, a);
  return Math.atan2(q[1], q[0]) / (2 * Math.PI);
}

/**
 * The GLSL statements of skyWaveProductPhase for motion.glsl's skyWavePhase: from the stereographic
 * point `z` they declare `vec2 q`, the fixed product F, and `vec2 a`, the per-turn product A, each
 * power by repeated squaring. motion.glsl then multiplies q by a uWaveTurns times.
 */
function skyWaveProductGlsl(splits: readonly WindingSplit[]): string {
  const lines: string[] = [];
  const products: Record<'q' | 'a', string | null> = { q: null, a: null };
  const multiply = (target: 'q' | 'a', factor: string): void => {
    if (products[target] === null) lines.push(`vec2 ${target} = ${factor};`);
    else lines.push(`${target} = skyCmul(${target}, ${factor});`);
    products[target] = target;
  };
  const power = (name: string, base: string, n: number): string => {
    let square = base;
    let result: string | null = null;
    let step = 0;
    for (let m = n; m > 0; m >>= 1) {
      if (m & 1) {
        if (result === null) result = square;
        else {
          const next = `${name}p${step++}`;
          lines.push(`vec2 ${next} = skyCmul(${result}, ${square});`);
          result = next;
        }
      }
      if (m > 1) {
        const next = `${name}s${step++}`;
        lines.push(`vec2 ${next} = skyCmul(${square}, ${square});`);
        square = next;
      }
    }
    return result as string;
  };
  splits
    .filter((s) => s.fixed !== 0 || s.perTurn !== 0)
    .forEach((s, i) => {
      const e = `e${i}`;
      lines.push(
        `vec2 ${e} = z - vec2(${glslFloat(s.point[0])}, ${glslFloat(s.point[1])});`,
        `${e} *= inversesqrt(max(dot(${e}, ${e}), ${glslFloat(WAVE_FACTOR_FLOOR)}));`,
      );
      if (s.fixed < 0 || s.perTurn < 0) lines.push(`vec2 c${i} = vec2(${e}.x, -${e}.y);`);
      for (const [target, n] of [
        ['q', s.fixed],
        ['a', s.perTurn],
      ] as const) {
        if (n !== 0) multiply(target, power(`${target}${i}`, n > 0 ? e : `c${i}`, Math.abs(n)));
      }
    });
  for (const target of ['q', 'a'] as const) {
    if (products[target] === null) lines.push(`vec2 ${target} = vec2(1.0, 0.0);`);
  }
  return lines.join(' ');
}

/**
 * The loop phase, in loops, that a sky stroke centred at `position` with phase fraction `phase`
 * runs under wrap `wrap`: its phase fraction, except under `wave`, where it is skyWavePhase of its
 * direction from PAINTER_EYE plus SKY_WAVE_JITTER × (phase − ½). Matches the phase skyMotion in
 * motion.glsl passes to skyWrapMotion.
 */
export function skyWrapPhase(
  wrap: SkyWrap,
  position: Vec3,
  phase: number,
  poles: readonly SkyWavePole[] = SKY_WAVE_POLES,
): number {
  if (wrap !== 'wave') return phase;
  const d: Vec3 = [
    position[0] - PAINTER_EYE[0],
    position[1] - PAINTER_EYE[1],
    position[2] - PAINTER_EYE[2],
  ];
  const inv = 1 / Math.hypot(d[0], d[1], d[2]);
  return (
    skyWavePhase([d[0] * inv, d[1] * inv, d[2] * inv], poles) + SKY_WAVE_JITTER * (phase - 0.5)
  );
}

export interface SkySwirl {
  /** Displacement of the stroke centre, metres. */
  readonly offset: Vec3;
  /** Turn about the stroke normal, radians, from the long axis towards the short axis. */
  readonly turn: number;
  /** Size delta: the stroke draws at 1 + gain of its size, gain in [-1, 0]. */
  readonly gain: number;
  /**
   * The `wheel` wrap's rigid turn of the stroke, centre and axes, about its wheel's axis, or null.
   * The offset is then the turned centre's, and the turn 0. Unlike every other motion it does not
   * scale with calm: calm slows the wheel through uTime instead.
   */
  readonly spin: SkySpin | null;
}

/** A stroke's place in its loop under a wrap variant (`skyWrapLoop`). */
export interface SkyWrapLoop {
  /** Seconds from mid-loop, within ±SKY_SWIRL_PERIOD / 2: the offset is tau × (omega × d). */
  readonly tau: number;
  /** Size delta, in [-1, 0]. */
  readonly gain: number;
  /** Whether tau is falling: the way back along the arc under `pingpong` and `wave`. */
  readonly returning: boolean;
}

/**
 * The loop of a stroke with loop phase `phase` (skyWrapPhase) at motion time `time` under wrap
 * variant `wrap` (src/motion/variants.ts). Matches skyMotion and skyWrapMotion in motion.glsl:
 * - `base` sweeps forward and shrinks to nothing over the wrap window.
 * - `pingpong` and `wave` sweep forward over the first half of the loop and ease back over the
 *   second, at full size, with no jump.
 * - `wheel` and `stream` have no loop along the arc: tau is 0 (skyWheelSpin, skyStreamTone).
 */
export function skyWrapLoop(wrap: SkyWrap, phase: number, time: number): SkyWrapLoop {
  if (wrap === 'wheel' || wrap === 'stream') return { tau: 0, gain: 0, returning: false };
  const f = fract(time / SKY_SWIRL_PERIOD + phase);
  if (wrap === 'wave' || wrap === 'pingpong') {
    return {
      tau: (smoothstep(0, 1, 1 - Math.abs(2 * f - 1)) - 0.5) * SKY_SWIRL_PERIOD,
      gain: 0,
      returning: f > 0.5,
    };
  }
  return {
    tau: (f - 0.5) * SKY_SWIRL_PERIOD,
    gain: smoothstep(0, SKY_SWIRL_FADE, Math.min(f, 1 - f)) - 1,
    returning: false,
  };
}

/**
 * The share of each vortex core that the `wheel` wrap's strokes may reach, as a chord. Under 1
 * because the two central cores nearly touch (0.27° apart, regions.json), and two clockwise wheels
 * that touch move in opposite directions at the contact, which tears. At 0.95 the reach of every
 * pair of wheels stays at least 1° apart (the unit tests check the gap).
 */
export const SKY_WHEEL_CORE_SCALE: number = 0.95;
/**
 * Half a dome stroke's length, radians from the eye: half of `WORLD_DOME_SIZE.slope`, the sky's
 * angular length, at the far band's size multiplier (`DEFAULT_BAND_SIZE.far`, 1.6), the largest a
 * dome stroke draws (a unit test pins both). A stroke is in a wheel when its centre lies this far
 * inside SKY_WHEEL_CORE_SCALE of the core, so a turning stroke's long axis never reaches past that.
 * Its corners can reach about 0.2° further on an oblique stroke (half its diagonal, not its length),
 * which still leaves about 0.7° of the still ring clear between the central wheels' members.
 */
export const SKY_WHEEL_STROKE_HALF: number = 0.5 * 0.03312 * 1.6;
/**
 * The `wheel` rim's target speed as a multiple of the field's own speed round the rim (mean
 * |omega × d̂| over it, at calm 1): 2, the wave's mean speed, which covers the arc twice per loop.
 * Each wheel then rounds its rate to a whole number of turns per MOTION_TIME_WRAP_S, so a turn
 * divides the wrap of uTime and the motion has no seam there.
 */
export const SKY_WHEEL_RIM_GAIN: number = 2;
/**
 * The ramp, radians of clear gap, over which a haze stroke thins back in from a wheel it would
 * cross under `wheel` (skyWheelHazeThin): 0.5°.
 */
export const SKY_WHEEL_HAZE_FEATHER: number = (0.5 * Math.PI) / 180;

/** A `wheel` disc: a vortex core turning rigidly about its centre direction. */
export interface SkyWheel {
  readonly note: string;
  /** Unit direction from PAINTER_EYE through the centre: the vortex's axis. */
  readonly axis: Vec3;
  /**
   * The wheel's radius as a chord of the unit sphere: SKY_WHEEL_STROKE_HALF inside
   * SKY_WHEEL_CORE_SCALE of the core's. A stroke whose centre is inside it turns.
   */
  readonly radius: number;
  /** Whole turns per MOTION_TIME_WRAP_S, signed: positive turns right-handed about `axis`. */
  readonly turns: number;
  /** Turns per second, signed: `turns / MOTION_TIME_WRAP_S`. */
  readonly rate: number;
  /** Seconds per turn. */
  readonly period: number;
  /** The rim's speed, rad/s of view angle, and the field's mean speed round it at calm 1. */
  readonly rimSpeed: number;
  readonly fieldRimSpeed: number;
}

/** `v` turned by `angle` radians right-handed about unit `axis` (Rodrigues). */
export function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, v);
  const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  return [
    v[0] * c + k[0] * s + axis[0] * d * (1 - c),
    v[1] * c + k[1] * s + axis[1] * d * (1 - c),
    v[2] * c + k[2] * s + axis[2] * d * (1 - c),
  ];
}

/** A unit vector perpendicular to unit `c`. */
export function perpendicular(c: Vec3): Vec3 {
  const side: Vec3 = Math.abs(c[1]) < 0.9 ? [-c[2], 0, c[0]] : [1, 0, 0];
  const l = Math.hypot(side[0], side[1], side[2]);
  return [side[0] / l, side[1] / l, side[2] / l];
}

/** The vortices' `wheel` discs, in vortex order (skyWheelMotion in motion.glsl reads them). */
export function skyWheels(vortices: readonly SkyVortex[] = SKY_VORTICES): readonly SkyWheel[] {
  return Object.freeze(
    vortices.map((v) => {
      // The rim's angle from the axis, and the field's mean speed at 64 points round it.
      const alpha = 2 * Math.asin((SKY_WHEEL_CORE_SCALE * v.core) / 2) - SKY_WHEEL_STROKE_HALF;
      const radius = 2 * Math.sin(alpha / 2);
      const e1 = perpendicular(v.axis);
      let sum = 0;
      for (let k = 0; k < 64; k++) {
        const rim = rotateAbout(rotateAbout(v.axis, e1, alpha), v.axis, (k / 64) * 2 * Math.PI);
        sum += Math.hypot(...skyVelocity(rim, vortices));
      }
      const fieldRimSpeed = sum / 64;
      const omega = (SKY_WHEEL_RIM_GAIN * fieldRimSpeed) / Math.sin(alpha);
      const turns =
        Math.sign(v.gamma) * Math.max(1, Math.round((omega * MOTION_TIME_WRAP_S) / (2 * Math.PI)));
      const rate = turns / MOTION_TIME_WRAP_S;
      return Object.freeze({
        note: v.note,
        axis: v.axis,
        radius,
        turns,
        rate,
        period: 1 / Math.abs(rate),
        rimSpeed: 2 * Math.PI * Math.abs(rate) * Math.sin(alpha),
        fieldRimSpeed,
      });
    }),
  );
}

export const SKY_WHEELS: readonly SkyWheel[] = skyWheels();

/**
 * The index in `wheels` of the wheel holding unit direction `dir`, or -1: the first whose chord
 * to `dir` is under its radius, as `1 − c·d̂ < radius² / 2` (motion.glsl). The wheels are
 * disjoint (unit tests), so the order never matters.
 */
export function skyWheelAt(dir: Vec3, wheels: readonly SkyWheel[] = SKY_WHEELS): number {
  for (let i = 0; i < wheels.length; i++) {
    const c = wheels[i].axis;
    const w = wheels[i].radius;
    if (1 - (c[0] * dir[0] + c[1] * dir[1] + c[2] * dir[2]) < 0.5 * w * w) return i;
  }
  return -1;
}

/** Wheel `wheel`'s angle at motion time `time`, radians in [0, 2π): `2π fract(time × rate)`. */
export function skyWheelAngle(wheel: SkyWheel, time: number): number {
  return 2 * Math.PI * fract(time * wheel.rate);
}

/** A rigid turn of a stroke about an axis through PAINTER_EYE (the `wheel` wrap). */
export interface SkySpin {
  readonly axis: Vec3;
  /** Radians, right-handed about `axis`, in [0, 2π). */
  readonly angle: number;
  /** The wheel's index in SKY_WHEELS. */
  readonly wheel: number;
}

/**
 * The `wheel` wrap's turn of a sky stroke whose direction from PAINTER_EYE is `dir`, at motion
 * time `time`: its wheel's axis and angle, or null outside every wheel. The boundary haze turns
 * with its wheel too, chosen by the same direction. Matches skyWheelMotion in motion.glsl.
 */
export function skyWheelSpin(
  dir: Vec3,
  time: number,
  wheels: readonly SkyWheel[] = SKY_WHEELS,
): SkySpin | null {
  const i = skyWheelAt(dir, wheels);
  return i < 0 ? null : { axis: wheels[i].axis, angle: skyWheelAngle(wheels[i], time), wheel: i };
}

/** A wheel's edge: the angle, radians from its axis, of its members' rim. */
export function skyWheelEdge(w: SkyWheel): number {
  return 2 * Math.asin(w.radius / 2);
}

/**
 * A wheel's cap: the angle, radians from its axis, of SKY_WHEEL_CORE_SCALE of its core, which no
 * turning dome stroke reaches past: the edge plus SKY_WHEEL_STROKE_HALF.
 */
export function skyWheelCap(w: SkyWheel): number {
  return skyWheelEdge(w) + SKY_WHEEL_STROKE_HALF;
}

/**
 * The `wheel` wrap's thin of a boundary haze stroke centred at `position` with half diagonal
 * `halfExtent` metres, at motion time `time`. Matches skyHazeWheel in motion.glsl. The stroke's
 * angular half extent is halfExtent over its distance from PAINTER_EYE. A stroke in a wheel turns
 * with it, and from where the turn has carried it, its extent must clear every other wheel's cap. A
 * still stroke's extent must clear every wheel's edge. Each thins to 0 at no gap and back to 1 over
 * SKY_WHEEL_HAZE_FEATHER, so a drawn haze quad never crosses into a wheel it does not turn with,
 * and a turning one never reaches another wheel's turning paint.
 */
export function skyWheelHazeThin(
  position: Vec3,
  halfExtent: number,
  time: number,
  wheels: readonly SkyWheel[] = SKY_WHEELS,
): number {
  const d: Vec3 = [
    position[0] - PAINTER_EYE[0],
    position[1] - PAINTER_EYE[1],
    position[2] - PAINTER_EYE[2],
  ];
  const length = Math.hypot(d[0], d[1], d[2]);
  const dir: Vec3 = [d[0] / length, d[1] / length, d[2] / length];
  const member = skyWheelAt(dir, wheels);
  const seen =
    member < 0 ? dir : rotateAbout(dir, wheels[member].axis, skyWheelAngle(wheels[member], time));
  const h = halfExtent / length;
  let thin = 1;
  wheels.forEach((w, j) => {
    if (j === member) return;
    const edge = member < 0 ? skyWheelEdge(w) : skyWheelCap(w);
    const c = w.axis[0] * seen[0] + w.axis[1] * seen[1] + w.axis[2] * seen[2];
    const theta = Math.acos(Math.min(1, Math.max(-1, c)));
    thin *= smoothstep(0, SKY_WHEEL_HAZE_FEATHER, theta - h - edge);
  });
  return thin;
}

/**
 * The farthest the `wheel` wrap moves a sky stroke centred at (x, y, z), metres: 2ρ, ρ its
 * distance from its wheel's axis line through PAINTER_EYE, the chord of a half turn, and 0
 * outside every wheel. A rigid turn keeps ρ, so this is exact. The stroke batch calls it for every
 * sky stroke at build, the boundary haze included.
 */
export function skyWheelReach(
  x: number,
  y: number,
  z: number,
  wheels: readonly SkyWheel[] = SKY_WHEELS,
): number {
  const dx = x - PAINTER_EYE[0];
  const dy = y - PAINTER_EYE[1];
  const dz = z - PAINTER_EYE[2];
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length === 0) return 0;
  const i = skyWheelAt([dx / length, dy / length, dz / length], wheels);
  if (i < 0) return 0;
  const c = wheels[i].axis;
  const along = c[0] * dx + c[1] * dy + c[2] * dz;
  return 2 * Math.sqrt(Math.max(0, length * length - along * along));
}

/**
 * The `stream` wrap's loop, seconds: 3600 / 1800, so it divides the wrap of uTime. Each of its two
 * tone layers slides SKY_STREAM_SHIFT along the stroke per loop and resets while its weight is 0.
 */
export const SKY_STREAM_PERIOD: number = 2;
/**
 * How far each `stream` tone layer slides along the stroke per loop, in stroke lengths: the paint
 * streams at SKY_STREAM_SHIFT / SKY_STREAM_PERIOD = 0.25 lengths per second, about the wave's
 * mean speed (2 × 0.004 rad/s × 120 m, about 1 m/s) for a 4 m far-sky stroke. The two layers sit
 * half a loop, SKY_STREAM_SHIFT / 2, apart along the stroke.
 */
export const SKY_STREAM_SHIFT: number = 0.5;
/**
 * The brush tone's mean inside the shapes, the pivot skyStreamTone compensates the contrast
 * about: the coverage-weighted mean over every brush of the default atlas, 0.4872 (unit tests).
 */
export const SKY_STREAM_TONE_MEAN: number = 0.487;
/**
 * Per brush (brush-atlas-data.ts BRUSHES), its tone's correlation with itself SKY_STREAM_SHIFT / 2
 * (120 texels) along the stroke, over its coverage-weighted texels in the default atlas (unit
 * tests, within 0.05). The ridges and bristles run along the stroke, so they correlate most. The
 * 50/50 blend of two layers with correlation ρ keeps (1 + ρ) / 2 of one layer's variance, so
 * skyStreamWeights divides by the square root of the blend's share, per brush.
 */
export const SKY_STREAM_RHOS: readonly number[] = Object.freeze([
  0.57, 0.68, 0.49, 0.72, 0.62, 0.64, 0.18, 0.31, 0.39, 0.15, 0.32, 0.23, 0.15, -0.08, 0.03, 0.03,
]);

/** The `stream` wrap's two tone layers at loop fraction `f` (stroke.frag.glsl). */
export interface SkyStreamWeights {
  /** Layer A's loop fraction, `f`, and layer B's, `fract(f + ½)`. */
  readonly fA: number;
  readonly fB: number;
  /** Their weights: `wA = 1 − |2 fA − 1|`, 0 where layer A resets, and `wB = 1 − wA`. */
  readonly wA: number;
  readonly wB: number;
  /**
   * The contrast gain, `1 / √(wA² + wB² + 2 ρ wA wB)`, ρ the brush's SKY_STREAM_RHOS entry: the
   * tone's deviation from its mean scales by it, so the blend keeps one layer's contrast at every
   * weight and the stream does not breathe.
   */
  readonly gain: number;
  /** Each layer's slide along the stroke, in stroke lengths, before the stroke's direction. */
  readonly shiftA: number;
  readonly shiftB: number;
}

/** The `stream` layers at loop fraction `f`. Matches stroke.frag.glsl. */
export function skyStreamWeights(f: number, rho = 0): SkyStreamWeights {
  const fA = fract(f);
  const fB = fract(fA + 0.5);
  const wA = 1 - Math.abs(2 * fA - 1);
  const wB = 1 - wA;
  return {
    fA,
    fB,
    wA,
    wB,
    gain: 1 / Math.sqrt(wA * wA + wB * wB + 2 * rho * wA * wB),
    shiftA: (fA - 0.5) * SKY_STREAM_SHIFT,
    shiftB: (fB - 0.5) * SKY_STREAM_SHIFT,
  };
}

/**
 * The `stream` loop fraction of a stroke with phase fraction `phase` at motion time `time`:
 * `fract(time / SKY_STREAM_PERIOD + phase)`, so neighbours with other phase bytes never cross-fade
 * together. Matches skyMotion's stream branch in motion.glsl.
 */
export function skyStreamPhase(phase: number, time: number): number {
  return fract(time / SKY_STREAM_PERIOD + phase);
}

/**
 * The `stream` wrap's packed varying, `sign × (1 + brush + f)` (motion.glsl skyStream, vStream):
 * `sign` ±1 the way the paint streams, `brush` the brush index and `f` the loop fraction.
 */
export function skyStreamPack(sign: number, brush: number, f: number): number {
  return Math.fround((sign < 0 ? -1 : 1) * Math.fround(1 + brush + Math.fround(f)));
}

/** Decodes skyStreamPack as stroke.frag.glsl does, in float32: the brush, `f` and the sign. */
export function skyStreamUnpack(packed: number): { brush: number; f: number; sign: number } {
  const a = Math.fround(Math.abs(packed) - 1);
  return { brush: Math.trunc(a), f: Math.fround(a - Math.floor(a)), sign: Math.sign(packed) };
}

/** One layer tap of the `stream` tone: the atlas tone and coverage, each 0-1. */
export interface StreamTap {
  readonly tone: number;
  readonly coverage: number;
}

/**
 * The streamed tone at loop fraction `f` from the rest tap's tone and the two layer taps: a layer
 * tap that leaves the shape falls back to the rest tone by its coverage, then the weighted
 * deviations from SKY_STREAM_TONE_MEAN scale by the contrast gain, faded to 1 by the product of
 * the two taps' coverages (a tap that fell back to the rest tone is fully correlated with it, so
 * the brush's rho would over-compensate it), clamped to [0, 1]. Matches stroke.frag.glsl.
 */
export function skyStreamTone(
  rest: number,
  a: StreamTap,
  b: StreamTap,
  f: number,
  rho = 0,
): number {
  const w = skyStreamWeights(f, rho);
  const ta = rest + (a.tone - rest) * a.coverage;
  const tb = rest + (b.tone - rest) * b.coverage;
  const m = SKY_STREAM_TONE_MEAN;
  const gain = 1 + (w.gain - 1) * a.coverage * b.coverage;
  return Math.min(1, Math.max(0, m + (w.wA * (ta - m) + w.wB * (tb - m)) * gain));
}

/**
 * The sky motion of a stroke centred at `position` with unit normal `normal` and phase fraction
 * `phase`, at motion time `time`, before calm, under wrap variant `wrap`, and under `wave` at
 * `turns` waves per turn, its tau scaled by skyWaveFade. Matches skyMotion in motion.glsl. `wrap`
 * defaults to `base` here, while the shader defaults to `wave` (DEFAULT_SKY_WRAP), so a caller
 * mirroring the app passes the wrap explicitly. `stream` moves no stroke (skyStreamTone).
 */
export function skySwirl(
  position: Vec3,
  normal: Vec3,
  phase: number,
  time: number,
  vortices: readonly SkyVortex[] = SKY_VORTICES,
  wrap: SkyWrap = 'base',
  turns: number = SKY_WAVE_PER_TURN,
): SkySwirl {
  const d: Vec3 = [
    position[0] - PAINTER_EYE[0],
    position[1] - PAINTER_EYE[1],
    position[2] - PAINTER_EYE[2],
  ];
  const inv = 1 / Math.hypot(d[0], d[1], d[2]);
  const dir: Vec3 = [d[0] * inv, d[1] * inv, d[2] * inv];
  if (wrap === 'wheel' || wrap === 'stream') {
    const wheels = vortices === SKY_VORTICES ? SKY_WHEELS : skyWheels(vortices);
    const spin = wrap === 'wheel' ? skyWheelSpin(dir, time, wheels) : null;
    if (!spin) return { offset: [0, 0, 0], turn: 0, gain: 0, spin: null };
    const moved = rotateAbout(d, spin.axis, spin.angle);
    return { offset: [moved[0] - d[0], moved[1] - d[1], moved[2] - d[2]], turn: 0, gain: 0, spin };
  }
  const omega = skyOmega(dir, vortices);
  const poles = skyWavePolesFor(turns, vortices);
  const loop = skyWrapLoop(wrap, skyWrapPhase(wrap, position, phase, poles), time);
  const fade =
    wrap === 'wave'
      ? skyWaveFade(dir, vortices === SKY_VORTICES ? FADE_POLES : skyWaveFadePoles(vortices))
      : 1;
  const tau = loop.tau * fade;
  const gain = loop.gain;
  const v = cross(omega, d);
  return {
    offset: [tau * v[0], tau * v[1], tau * v[2]],
    turn: tau * (omega[0] * normal[0] + omega[1] * normal[1] + omega[2] * normal[2]),
    gain,
    spin: null,
  };
}

/** A GLSL float literal: always carries a decimal point or an exponent. */
const glslFloat = (value: number): string => value.toExponential(8);

/** The material defines skyMotion in motion.glsl reads: the vortex tables and the loop constants. */
export function skySwirlGlslDefines(
  vortices: readonly SkyVortex[] = SKY_VORTICES,
): Record<string, string | number> {
  const n = vortices.length;
  const axes = vortices.map(
    (v) => `vec4(${v.axis.map(glslFloat).join(', ')}, ${glslFloat(0.5 * v.gamma)})`,
  );
  const cores = vortices.map((v) => glslFloat(0.5 * v.core * v.core));
  const fadePoles = vortices === SKY_VORTICES ? FADE_POLES : skyWaveFadePoles(vortices);
  const fadeChord = 2 * Math.sin(SKY_WAVE_FADE_RADIUS / 2);
  const wheels = vortices === SKY_VORTICES ? SKY_WHEELS : skyWheels(vortices);
  return {
    SKY_VORTEX_COUNT: n,
    SKY_VORTEX_AXES: `vec4[${n}](${axes.join(', ')})`,
    SKY_VORTEX_CORES: `float[${n}](${cores.join(', ')})`,
    SKY_WAVE_PRODUCT: skyWaveProductGlsl(windingSplits(vortices)),
    SKY_WAVE_MAX_TURNS: SKY_WAVE_TURNS[SKY_WAVE_TURNS.length - 1],
    SKY_WAVE_INV_TAU: glslFloat(1 / (2 * Math.PI)),
    SKY_WAVE_FADE_COUNT: fadePoles.length,
    SKY_WAVE_FADE_POLES: `vec3[${fadePoles.length}](${fadePoles.map((p) => `vec3(${p.map(glslFloat).join(', ')})`).join(', ')})`,
    SKY_WAVE_FADE_CHORD2: glslFloat(fadeChord * fadeChord),
    SKY_WAVE_JITTER: glslFloat(SKY_WAVE_JITTER),
    SKY_EYE: `vec3(${PAINTER_EYE.map(glslFloat).join(', ')})`,
    SKY_DRIFT: glslFloat(DRIFT[1]),
    SKY_SWIRL_PERIOD: glslFloat(SKY_SWIRL_PERIOD),
    SKY_SWIRL_INV_PERIOD: glslFloat(1 / SKY_SWIRL_PERIOD),
    SKY_SWIRL_FADE: glslFloat(SKY_SWIRL_FADE),
    SKY_WHEEL_CORES: `float[${n}](${wheels.map((w) => glslFloat(0.5 * w.radius * w.radius)).join(', ')})`,
    SKY_WHEEL_RATES: `float[${n}](${wheels.map((w) => glslFloat(w.rate)).join(', ')})`,
    SKY_WHEEL_EDGES: `float[${n}](${wheels.map((w) => glslFloat(skyWheelEdge(w))).join(', ')})`,
    SKY_WHEEL_CAPS: `float[${n}](${wheels.map((w) => glslFloat(skyWheelCap(w))).join(', ')})`,
    SKY_WHEEL_HAZE_FEATHER: glslFloat(SKY_WHEEL_HAZE_FEATHER),
    SKY_HALF_TURN: glslFloat(Math.PI),
    SKY_STREAM_INV_PERIOD: glslFloat(1 / SKY_STREAM_PERIOD),
    SKY_STREAM_SHIFT: glslFloat(SKY_STREAM_SHIFT),
    SKY_STREAM_TONE_MEAN: glslFloat(SKY_STREAM_TONE_MEAN),
    SKY_STREAM_RHO2: `float[${SKY_STREAM_RHOS.length}](${SKY_STREAM_RHOS.map((r) => glslFloat(2 * r)).join(', ')})`,
    SKY_SWIRL_MAX_ANGLE: glslFloat(SKY_SWIRL_MAX_ANGLE),
  };
}
