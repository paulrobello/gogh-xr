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
 * shrinks to nothing and grows back (`gain`), so the jump back is never a pop: alpha cannot fade a
 * stroke under alpha-to-coverage.
 *
 * motion.glsl's `skyMotion` is the GLSL; `skySwirlGlslDefines` hands it these tables as defines, so
 * the two read one source. Change them together.
 */
import regionsJson from '../../assets/bake/starry-night/regions.json';
import { canvasRay, PAINTER_EYE } from '../paintings/starry-night/canvas-camera';
import type { Vec3 } from '../render/strokes/frame';
import { SKY_DOME_RADIUS } from '../world/sky';
import { SKY_WRAP_HALF_FLOOR, SKY_WRAP_HALF_PERIOD, type SkyWrap } from './variants';

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

export interface SkySwirl {
  /** Displacement of the stroke centre, metres. */
  readonly offset: Vec3;
  /** Turn about the stroke normal, radians, from the long axis towards the short axis. */
  readonly turn: number;
  /** Size delta: the stroke draws at 1 + gain of its size, gain in [-1, 0]. */
  readonly gain: number;
  /** The `fade` wrap's colour weight toward the sky base under the stroke, in [0, 1]; else 0. */
  readonly fade: number;
}

/**
 * The loop of a stroke with phase fraction `phase` at motion time `time` under wrap variant `wrap`
 * (src/motion/variants.ts): `tau`, seconds from mid-loop scaled to base's 8 s arc, the size gain
 * and the fade weight. Matches skyMotion and skyWrapMotion in motion.glsl.
 */
export function skyWrapLoop(
  wrap: SkyWrap,
  phase: number,
  time: number,
): { readonly tau: number; readonly gain: number; readonly fade: number } {
  const period = wrap === 'half' ? SKY_WRAP_HALF_PERIOD : SKY_SWIRL_PERIOD;
  const f = fract(time / period + phase);
  const edge = smoothstep(0, SKY_SWIRL_FADE, Math.min(f, 1 - f));
  return {
    tau: (f - 0.5) * SKY_SWIRL_PERIOD,
    gain: wrap === 'base' ? edge - 1 : wrap === 'half' ? (1 - SKY_WRAP_HALF_FLOOR) * (edge - 1) : 0,
    fade: wrap === 'fade' ? 1 - edge : 0,
  };
}

/**
 * The sky motion of a stroke centred at `position` with unit normal `normal` and phase fraction
 * `phase`, at motion time `time`, before calm, under wrap variant `wrap`. Matches skyMotion in
 * motion.glsl.
 */
export function skySwirl(
  position: Vec3,
  normal: Vec3,
  phase: number,
  time: number,
  vortices: readonly SkyVortex[] = SKY_VORTICES,
  wrap: SkyWrap = 'base',
): SkySwirl {
  const d: Vec3 = [
    position[0] - PAINTER_EYE[0],
    position[1] - PAINTER_EYE[1],
    position[2] - PAINTER_EYE[2],
  ];
  const inv = 1 / Math.hypot(d[0], d[1], d[2]);
  const omega = skyOmega([d[0] * inv, d[1] * inv, d[2] * inv], vortices);
  const { tau, gain, fade } = skyWrapLoop(wrap, phase, time);
  const v = cross(omega, d);
  return {
    offset: [tau * v[0], tau * v[1], tau * v[2]],
    turn: tau * (omega[0] * normal[0] + omega[1] * normal[1] + omega[2] * normal[2]),
    gain,
    fade,
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
  return {
    SKY_VORTEX_COUNT: n,
    SKY_VORTEX_AXES: `vec4[${n}](${axes.join(', ')})`,
    SKY_VORTEX_CORES: `float[${n}](${cores.join(', ')})`,
    SKY_EYE: `vec3(${PAINTER_EYE.map(glslFloat).join(', ')})`,
    SKY_DRIFT: glslFloat(DRIFT[1]),
    SKY_SWIRL_PERIOD: glslFloat(SKY_SWIRL_PERIOD),
    SKY_SWIRL_INV_PERIOD: glslFloat(1 / SKY_SWIRL_PERIOD),
    SKY_SWIRL_FADE: glslFloat(SKY_SWIRL_FADE),
    SKY_SWIRL_MAX_ANGLE: glslFloat(SKY_SWIRL_MAX_ANGLE),
  };
}
