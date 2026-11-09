/**
 * The portal's painted night sky (P5.5): what a transition goes to in place of black. Deep blue and
 * ultramarine brushstrokes over the whole sphere, laid along slow swirls with a few warm yellow
 * stars, over the veil's own deep blue (`SKY_VEIL_COLOR`), which fills the gaps between them.
 *
 * World-fixed around the eye, not head-locked: a textured field that turns with the head while the
 * vestibular sense says the head turns is a vection source, which the black veil could only get
 * away with because it carries no texture. The sky is parented to the rig, centred on the eye, and
 * keeps its own heading as the head turns, as a skybox does. Its radius is far beyond the fly
 * strokes' hover distance, so stereo never puts it in front of the chips drawn over it.
 *
 * Comfort: only the swirl strokes move, each about its own vortex's axis through the eye at the
 * sky's Rankine-style rate (wait-motion.ts `swirlRate`), at most a few degrees a second at calm 1.
 * Neighbouring vortices turn opposite ways, so the field never turns as a whole; the background
 * strokes and the stars never move, and the stars only breathe slowly in size. Everything moves on
 * `time`, which the caller advances by its frame time scaled by calm (`skyMotionRate`), so calm 0
 * holds the sky still.
 *
 * The field is pure and deterministic; `createNightSky` puts it on one stroke mesh (fly-strokes.ts)
 * on the stroke engine's material and brush atlas, built once and reused by every transition. The
 * switcher builds it when it adopts the first world and draws it once shrunk to nothing (`warm`),
 * so its buffers upload and its program binds at boot, not on a trip's first frame. It lives for
 * the session and goes with the switcher's `dispose`. After a context loss three uploads its
 * buffers and links its program again on the next draw, since its material is never disposed.
 */
import type { Object3D, Texture } from 'three';
import type { Vec3 } from '../render/strokes/frame';
import { createFlyStrokes, type FlyStrokes } from './fly-strokes';
import { swirlRate } from './wait-motion';

/** Background strokes, laid along the swirls' flow and never moving. */
export const SKY_FIELD_STROKES = 1300;
/** Swirls, and the strokes each turns. */
export const SKY_VORTICES = 10;
export const SKY_VORTEX_STROKES = 150;
/** Stars, and the yellow dabs of each. */
export const SKY_STARS = 11;
export const SKY_STAR_DABS = 12;
export const SKY_COUNT =
  SKY_FIELD_STROKES + SKY_VORTICES * SKY_VORTEX_STROKES + SKY_STARS * SKY_STAR_DABS;
/** Metres from the eye: far beyond the fly strokes' 0.9-1.6 m hover. */
export const SKY_RADIUS = 20;
/** Above the veil (the vignette's 999,000) and below the fly strokes. */
export const SKY_RENDER_ORDER = 999_250;
/** The veil's colour under the sky, sRGB bytes: the sky's deepest blue. */
export const SKY_VEIL_COLOR: readonly [number, number, number] = [14, 22, 54];
/** A swirl's core turns once in this many seconds at calm 1. */
export const SKY_PERIOD_S = 24;
/** A swirl's solid-body core radius, as a share of its radius. */
export const SKY_CORE_SHARE = 0.4;
/** One slow breath of the stars' size, seconds at calm 1, and its depth. */
export const SKY_STAR_BREATH_S = 6;
export const SKY_STAR_BREATH = 0.12;
/** The sky is whole once the veil is this far up, and starts going as it falls below it. */
export const SKY_FULL_AT_VEIL = 0.75;

const DEG = Math.PI / 180;

/** sRGB palettes: the deep field, the swirls' outer and inner rings, the stars' halo and core. */
const FIELD_BLUES: readonly Vec3[] = [
  [16, 28, 72],
  [22, 38, 96],
  [28, 50, 120],
  [36, 62, 138],
  [24, 44, 88],
  [38, 66, 118],
];
const SWIRL_OUTER: readonly Vec3[] = [
  [44, 74, 146],
  [56, 90, 160],
  [66, 104, 168],
  [50, 84, 140],
];
const SWIRL_INNER: readonly Vec3[] = [
  [84, 122, 182],
  [104, 140, 192],
  [122, 156, 198],
  [92, 132, 176],
];
const STAR_HALO: readonly Vec3[] = [
  [214, 184, 84],
  [232, 206, 112],
];
const STAR_CORE: readonly Vec3[] = [
  [246, 230, 150],
  [250, 240, 190],
];

/** The painted sky's strokes at rest, mesh-local with the eye at the origin. */
export interface SkyField {
  readonly count: number;
  /** xyz per stroke at time 0, on the sphere of `SKY_RADIUS`. */
  readonly base: Float32Array;
  /** A swirl stroke's turn about its vortex's axis: `offset(φ) = b (cos φ − 1) + c sin φ`. */
  readonly b: Float32Array;
  readonly c: Float32Array;
  /** Signed turn rate per stroke at calm 1, rad/s; 0 for a stroke that never moves. */
  readonly rate: Float32Array;
  /** A still stroke's long axis, xyz per stroke. */
  readonly axis: Float32Array;
  /** sRGB bytes, rgb per stroke. */
  readonly colors: Uint8Array;
  /** Quad length and width per stroke, metres. */
  readonly sizes: Float32Array;
  /** A star dab's breath phase, radians; NaN for every other stroke. */
  readonly breath: Float32Array;
}

/** The direction at azimuth `az` (0 is -Z, positive turns toward +X) and elevation `el`. */
function direction(az: number, el: number): [number, number, number] {
  return [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
}

/** Two unit vectors square to unit `k` and to each other. */
function across(k: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(k[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ax = helper[1] * k[2] - helper[2] * k[1];
  let ay = helper[2] * k[0] - helper[0] * k[2];
  let az = helper[0] * k[1] - helper[1] * k[0];
  const l = Math.hypot(ax, ay, az);
  ax /= l;
  ay /= l;
  az /= l;
  return [
    [ax, ay, az],
    [k[1] * az - k[2] * ay, k[2] * ax - k[0] * az, k[0] * ay - k[1] * ax],
  ];
}

/** The unit direction `rho` off `k` at bearing `theta` in the frame (a, b). */
function offAxis(k: Vec3, a: Vec3, b: Vec3, rho: number, theta: number): Vec3 {
  const s = Math.sin(rho);
  const ca = Math.cos(theta) * s;
  const cb = Math.sin(theta) * s;
  const ck = Math.cos(rho);
  return [
    k[0] * ck + a[0] * ca + b[0] * cb,
    k[1] * ck + a[1] * ca + b[1] * cb,
    k[2] * ck + a[2] * ca + b[2] * cb,
  ];
}

interface Vortex {
  readonly k: Vec3;
  readonly a: Vec3;
  readonly b: Vec3;
  /** Radians of view angle. */
  readonly radius: number;
  readonly spin: 1 | -1;
}

/** The painted sky, the same for the same seed. */
export function createSkyField(seed = 1): SkyField {
  let state = (0x6a09e667 ^ seed) >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (set: readonly Vec3[]): Vec3 => set[Math.floor(random() * set.length)];
  const count = SKY_COUNT;
  const base = new Float32Array(count * 3);
  const b = new Float32Array(count * 3);
  const c = new Float32Array(count * 3);
  const rate = new Float32Array(count);
  const axis = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const sizes = new Float32Array(count * 2);
  const breath = new Float32Array(count).fill(Number.NaN);
  const R = SKY_RADIUS;

  // The swirls go round the horizon, neighbours turning opposite ways.
  const vortices: Vortex[] = [];
  for (let v = 0; v < SKY_VORTICES; v++) {
    const az = (2 * Math.PI * (v + 0.5 + 0.6 * (random() - 0.5))) / SKY_VORTICES;
    const el = (-20 + 70 * random()) * DEG;
    const k = direction(az, el);
    const [a, bAxis] = across(k);
    vortices.push({ k, a, b: bAxis, radius: (13 + 9 * random()) * DEG, spin: v % 2 ? -1 : 1 });
  }

  let i = 0;
  const put = (d: Vec3, color: Vec3, length: number, width: number): number => {
    const i3 = i * 3;
    base[i3] = d[0] * R;
    base[i3 + 1] = d[1] * R;
    base[i3 + 2] = d[2] * R;
    colors[i3] = color[0];
    colors[i3 + 1] = color[1];
    colors[i3 + 2] = color[2];
    sizes[i * 2] = length * R;
    sizes[i * 2 + 1] = width * R;
    return i++;
  };
  /** Stroke `at`'s long axis: (x, y, z) laid flat on the sphere at its place. */
  const setAxis = (at: number, x: number, y: number, z: number): void => {
    const i3 = at * 3;
    const along = (x * base[i3] + y * base[i3 + 1] + z * base[i3 + 2]) / (R * R);
    axis[i3] = x - along * base[i3];
    axis[i3 + 1] = y - along * base[i3 + 1];
    axis[i3 + 2] = z - along * base[i3 + 2];
  };

  // The deep field, uniform over the sphere, each stroke along the swirls' flow and a slow wind.
  for (let n = 0; n < SKY_FIELD_STROKES; n++) {
    const y = 2 * random() - 1;
    const phi = 2 * Math.PI * random();
    const r = Math.sqrt(1 - y * y);
    const d: Vec3 = [r * Math.cos(phi), y, r * Math.sin(phi)];
    const scale = 0.8 + 0.45 * random();
    const at = put(d, pick(FIELD_BLUES), 9 * DEG * scale, 3.2 * DEG * scale);
    // The wind: up × d, along the line of latitude.
    let fx = 0.6 * -d[2];
    let fy = 0;
    let fz = 0.6 * d[0];
    for (const v of vortices) {
      const cos = v.k[0] * d[0] + v.k[1] * d[1] + v.k[2] * d[2];
      const rho = Math.acos(Math.min(1, Math.max(-1, cos)));
      const w = v.spin * Math.exp(-((rho / (1.6 * v.radius)) ** 2));
      fx += w * (v.k[1] * d[2] - v.k[2] * d[1]);
      fy += w * (v.k[2] * d[0] - v.k[0] * d[2]);
      fz += w * (v.k[0] * d[1] - v.k[1] * d[0]);
    }
    setAxis(at, fx, fy, fz);
  }

  // The swirls: rings about each vortex, pale at the core, every stroke along its ring.
  const omega = (2 * Math.PI) / SKY_PERIOD_S;
  for (const v of vortices) {
    for (let n = 0; n < SKY_VORTEX_STROKES; n++) {
      const share = 0.12 + 0.88 * Math.sqrt(random());
      const rho = v.radius * share;
      const d = offAxis(v.k, v.a, v.b, rho, 2 * Math.PI * random());
      const scale = 0.8 + 0.4 * random();
      const length = (3.5 + 3 * share) * DEG * scale;
      const palette = share < 0.45 ? SWIRL_INNER : SWIRL_OUTER;
      const at = put(d, pick(palette), length, 1.9 * DEG * scale);
      const i3 = at * 3;
      const along = base[i3] * v.k[0] + base[i3 + 1] * v.k[1] + base[i3 + 2] * v.k[2];
      b[i3] = base[i3] - v.k[0] * along;
      b[i3 + 1] = base[i3 + 1] - v.k[1] * along;
      b[i3 + 2] = base[i3 + 2] - v.k[2] * along;
      c[i3] = v.k[1] * base[i3 + 2] - v.k[2] * base[i3 + 1];
      c[i3 + 1] = v.k[2] * base[i3] - v.k[0] * base[i3 + 2];
      c[i3 + 2] = v.k[0] * base[i3 + 1] - v.k[1] * base[i3];
      rate[at] = v.spin * swirlRate(rho, SKY_CORE_SHARE * v.radius, omega);
      setAxis(at, c[i3], c[i3 + 1], c[i3 + 2]);
    }
  }

  // The stars: a ring of halo dabs along the ring, and a few at the core across it.
  for (let s = 0; s < SKY_STARS; s++) {
    const k = direction(2 * Math.PI * random(), (8 + 52 * random()) * DEG);
    const [a, bAxis] = across(k);
    const phase = 2 * Math.PI * random();
    const halo = SKY_STAR_DABS - 4;
    for (let n = 0; n < SKY_STAR_DABS; n++) {
      const ring = n < halo;
      const theta = ring ? (2 * Math.PI * (n + 0.3 * random())) / halo : 2 * Math.PI * random();
      const rho = (ring ? 2.8 : 0.8 * random()) * DEG;
      const d = offAxis(k, a, bAxis, rho, theta);
      const at = ring
        ? put(d, pick(STAR_HALO), 3.2 * DEG, 1.2 * DEG)
        : put(d, pick(STAR_CORE), 2 * DEG, 1.2 * DEG);
      if (ring) {
        // Along the ring: k × d.
        setAxis(
          at,
          k[1] * d[2] - k[2] * d[1],
          k[2] * d[0] - k[0] * d[2],
          k[0] * d[1] - k[1] * d[0],
        );
      } else {
        // Out from the core.
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        setAxis(
          at,
          a[0] * cos + bAxis[0] * sin,
          a[1] * cos + bAxis[1] * sin,
          a[2] * cos + bAxis[2] * sin,
        );
      }
      breath[at] = phase;
    }
  }
  return { count, base, b, c, rate, axis, colors, sizes, breath };
}

/**
 * The sky `time` seconds into its motion (calm-scaled, `skyMotionRate`), shrunk to `grow` (0-1):
 * positions and long axes, xyz per stroke, and sizes into the outputs.
 */
export function skyFrame(
  field: SkyField,
  time: number,
  grow: number,
  positions: Float32Array,
  axes: Float32Array,
  sizes: Float32Array,
): void {
  const g = Math.min(1, Math.max(0, grow));
  const { base, b, c, rate, axis, breath } = field;
  for (let i = 0; i < field.count; i++) {
    const i3 = i * 3;
    const r = rate[i];
    if (r !== 0) {
      const phi = r * time;
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      for (let k = 0; k < 3; k++) {
        positions[i3 + k] = base[i3 + k] + b[i3 + k] * (cos - 1) + c[i3 + k] * sin;
        // The derivative of the offset: along the ring.
        axes[i3 + k] = c[i3 + k] * cos - b[i3 + k] * sin;
      }
    } else {
      for (let k = 0; k < 3; k++) {
        positions[i3 + k] = base[i3 + k];
        axes[i3 + k] = axis[i3 + k];
      }
    }
    const phase = breath[i];
    const pulse = Number.isNaN(phase)
      ? 1
      : 1 + SKY_STAR_BREATH * Math.sin((2 * Math.PI * time) / SKY_STAR_BREATH_S + phase);
    sizes[i * 2] = field.sizes[i * 2] * g * pulse;
    sizes[i * 2 + 1] = field.sizes[i * 2 + 1] * g * pulse;
  }
}

/** How fast the sky's time runs at `calm`: 0 holds it still, 1 is full speed. */
export function skyMotionRate(calm: number): number {
  return Number.isFinite(calm) ? Math.min(1, Math.max(0, calm)) : 0;
}

/**
 * The sky's size (0-1) at veil alpha `veil`: it grows in ahead of the veil, whole from
 * `SKY_FULL_AT_VEIL`, and shrinks away as the veil lifts, so the old world dissolves into
 * brushwork and the new one shows through it. Linear in the veil, which is already eased.
 */
export function skyGrow(veil: number): number {
  return Math.min(1, Math.max(0, veil) / SKY_FULL_AT_VEIL);
}

export interface NightSky {
  /** The stroke mesh, parented to the rig; hidden (no draw) between transitions. */
  readonly mesh: FlyStrokes['mesh'];
  /**
   * Draws the sky at size `grow`, `time` seconds into its motion, centred on `eye` (rig-local).
   * Hidden at `grow` 0. Writes nothing when neither has changed since the last draw.
   */
  draw(grow: number, time: number, eye: Vec3): void;
  /**
   * Shows the sky shrunk to nothing, centred on `eye`, so the next render uploads its buffers and
   * binds its program, and a trip's first frame pays for neither. Hide it after that render.
   */
  warm(eye: Vec3): void;
  /** Starts a transition: the sky at rest, facing the rig's own heading. */
  reset(): void;
  hide(): void;
  /** Detaches it and releases its geometry and material; the atlas belongs to the caller. */
  dispose(): void;
}

/** The size `warm` draws at: every quad well under a pixel. */
export const SKY_WARM_GROW = 1e-4;

/**
 * Builds the sky's mesh under `rig`, on `atlas`. Every transition reuses it: its owner keeps it for
 * the session and disposes it with the rig.
 */
export function createNightSky(rig: Object3D, atlas: Texture): NightSky {
  const field = createSkyField();
  const strokes = createFlyStrokes(rig, atlas, field.count, 'portal-sky');
  const { mesh } = strokes;
  mesh.renderOrder = SKY_RENDER_ORDER;
  const positions = new Float32Array(field.count * 3);
  const axes = new Float32Array(field.count * 3);
  const sizes = new Float32Array(field.count * 2);
  const origin: Vec3 = [0, 0, 0];
  let lastGrow = -1;
  let lastTime = Number.NaN;
  const sky: NightSky = {
    mesh,
    draw(grow, time, eye) {
      mesh.position.set(eye[0], eye[1], eye[2]);
      if (grow <= 0) {
        strokes.hide();
        lastGrow = 0;
        return;
      }
      if (grow === lastGrow && time === lastTime && mesh.visible) return;
      lastGrow = grow;
      lastTime = time;
      skyFrame(field, time, grow, positions, axes, sizes);
      strokes.place(positions, field.colors, sizes, origin, axes);
    },
    warm(eye) {
      sky.draw(SKY_WARM_GROW, 0, eye);
    },
    reset() {
      mesh.quaternion.identity();
      lastGrow = -1;
      lastTime = Number.NaN;
      strokes.hide();
    },
    hide() {
      strokes.hide();
    },
    dispose() {
      strokes.dispose();
    },
  };
  return sky;
}
