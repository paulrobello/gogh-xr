/**
 * What moves while the next world builds under the portal's veil (P5.5), pure so the unit tests
 * check it without WebGL.
 *
 * The fly style's swirl. Each stroke turns about the axis of a vortex through the eye, as the sky's
 * strokes do (src/motion/sky-swirl.ts), so it keeps its distance from the eye and never looms. A
 * vortex turns its strokes at the sky's Rankine-style rate: solid-body inside a core of
 * `SWIRL_CORE_SHARE` of its radius, falling as the inverse square of the angle outside, so the
 * inner strokes circle fast and the outer ones trail.
 *
 * The vortices are irregular, as the painting's are: `SWIRL_GROUPS` groups, each with its own
 * random tilt, centre, radius and rate. Each group is four vortices mirrored about the strokes'
 * mean view direction f in its tilted frame (a, b): at (a, b) and (−a, −b) turning one way, and
 * at (−a, b) and (a, −b) turning the other. The strokes hover in slots of eights to match:
 * `planSwirl` takes every eighth stroke's place, the place opposite it on its circle about its
 * vortex, and the images of those two under the same group, each orbiting the image vortex. Each
 * stroke then takes the free slot nearest its own view direction, so the cloud keeps the
 * painting's colours roughly where they were. Strokes left over hover still on their own lines.
 *
 * A turn by π about f and the two mirrors through f, with the mirrors' spins flipped, carry each
 * four onto itself. A mirror image of a motion has angular velocity −Mω about the eye, so each
 * four's net angular velocity is (I + R − M₁ − M₂) ω = 0 at every instant: the field never turns
 * or rolls as a whole, exactly, whatever the layout. Two strokes opposite on one circle move in
 * opposite directions, so the eight's mean velocity is 0 too: the field never slides either.
 *
 * A small cloud of anchors (a frame seen from 4 m) is spread to at least `SWIRL_MIN_HALF` of view
 * angle about f, so the swirl fills the middle of the view. The offset is 0 at time 0, and the
 * switcher weighs it in with each stroke's own flight progress, so it starts from rest at liftoff
 * and hands off into the `in` leg.
 *
 * The fade style's pulse: a dim, fixed field of night-coloured strokes around the viewer's
 * heading, which breathes slowly in brightness and never moves.
 */
import type { Vec3 } from '../render/strokes/frame';

/** Vortex groups of four. */
export const SWIRL_GROUPS = 4;
/** The anchors' least half-extent about the mean direction, radians of view angle (about 17°). */
export const SWIRL_MIN_HALF = 0.3;
/** A vortex's radius, as a share of the anchors' half-extent: from this to twice it. */
export const SWIRL_RADIUS_SHARE = 0.35;
/** A vortex's solid-body core radius, as a share of its radius. */
export const SWIRL_CORE_SHARE = 0.4;
/** A core turns once in this many seconds at the base rate, for the least half-extent. */
export const SWIRL_PERIOD_S = 2.5;
/** A group's rate is the base rate times 1 ± this. */
export const SWIRL_RATE_SPREAD = 0.3;
/** A stroke this far off the mean direction (cosine) or nearer the eye than 5 cm does not swirl. */
const MIN_FORWARD = 0.1;
const MIN_DISTANCE = 0.05;

/** Every stroke's turn about its vortex's axis: `offset(φ) = b (cos φ − 1) + c sin φ`. */
export interface Swirl {
  readonly count: number;
  /** The part of each stroke's eye offset off its axis, xyz per stroke. */
  readonly b: Float32Array;
  /** The axis crossed with the eye offset, xyz per stroke. */
  readonly c: Float32Array;
  /** Signed turn rate per stroke, rad/s: positive is anticlockwise about the axis. */
  readonly rate: Float32Array;
  /** The anchors' half-extent about the mean direction, tangent units (about radians). */
  readonly half: number;
}

/** A vortex's rate at `rho` radians from its centre, for core `core` and core rate `omega`. */
export function swirlRate(rho: number, core: number, omega: number): number {
  return omega * Math.min(1, (core * core) / Math.max(1e-12, rho * rho));
}

/** A vortex: its group, its Klein element (bit 1 flips a, bit 0 flips b) and its centre. */
interface Vortex {
  readonly group: number;
  readonly element: number;
  /** Centre on the tangent plane, in the base frame. */
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/**
 * Plans the swirl of the strokes leaving `from` (xyz per stroke, rig-local) seen from `eye`, and
 * writes where each hovers into `anchors`: `near` to `far` metres from the eye, as the out leg's
 * ends. An eight hovers no farther than its first stroke's `from`, and a stroke left still no
 * farther than its own. `random` draws in [0, 1).
 */
export function planSwirl(
  from: Float32Array,
  eye: Vec3,
  near: number,
  far: number,
  random: () => number,
  anchors: Float32Array,
): Swirl {
  const count = Math.floor(from.length / 3);
  const b = new Float32Array(count * 3);
  const c = new Float32Array(count * 3);
  const rate = new Float32Array(count);
  // The mean view direction f, then right r (f × up) and up u (r × f).
  let fx = 0;
  let fy = 0;
  let fz = 0;
  for (let i = 0; i < count; i++) {
    const px = from[i * 3] - eye[0];
    const py = from[i * 3 + 1] - eye[1];
    const pz = from[i * 3 + 2] - eye[2];
    const d = Math.hypot(px, py, pz);
    if (d < MIN_DISTANCE) continue;
    fx += px / d;
    fy += py / d;
    fz += pz / d;
  }
  let fl = Math.hypot(fx, fy, fz);
  if (fl < 1e-6 * Math.max(1, count)) {
    fx = 0;
    fy = 0;
    fz = -1;
    fl = 1;
  }
  fx /= fl;
  fy /= fl;
  fz /= fl;
  let rx = -fz;
  let rz = fx;
  let rl = Math.hypot(rx, rz);
  if (rl < 1e-3) {
    rx = 1;
    rz = 0;
    rl = 1;
  }
  rx /= rl;
  rz /= rl;
  const ux = -rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy;
  // Each stroke's place on the plane one unit ahead, and the cloud's spread there.
  const sx = new Float32Array(count);
  const sy = new Float32Array(count);
  const ok = new Uint8Array(count);
  let spread = 0;
  let spreadCount = 0;
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const px = from[i3] - eye[0];
    const py = from[i3 + 1] - eye[1];
    const pz = from[i3 + 2] - eye[2];
    const d = Math.hypot(px, py, pz);
    const ahead = px * fx + py * fy + pz * fz;
    if (d < MIN_DISTANCE || ahead < MIN_FORWARD * d) continue;
    sx[i] = (px * rx + pz * rz) / ahead;
    sy[i] = (px * ux + py * uy + pz * uz) / ahead;
    ok[i] = 1;
    spread += sx[i] * sx[i] + sy[i] * sy[i];
    spreadCount++;
  }
  // A uniform square of half-width h has a 2D RMS radius of h √(2/3).
  const measured = Math.sqrt((1.5 * spread) / Math.max(1, spreadCount));
  const half = Math.max(SWIRL_MIN_HALF, measured);
  const stretch = measured > 0 ? half / measured : 1;

  // The groups: a tilt, a base vortex in the tilted frame's first quadrant, a radius and a rate.
  const omega = (2 * Math.PI) / SWIRL_PERIOD_S;
  const tilts: number[] = [];
  const rates: number[] = [];
  const vortices: Vortex[] = [];
  for (let g = 0; g < SWIRL_GROUPS; g++) {
    const tilt = (Math.PI / 2) * random();
    const a = half * (0.2 + 0.7 * random());
    const bb = half * (0.2 + 0.7 * random());
    const radius = half * SWIRL_RADIUS_SHARE * (1 + random());
    tilts.push(tilt);
    // Wider vortices turn slower, so a stroke's speed across the view does not grow with them.
    const scale = SWIRL_MIN_HALF / half;
    rates.push(scale * omega * (1 - SWIRL_RATE_SPREAD + 2 * SWIRL_RATE_SPREAD * random()));
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    for (let element = 0; element < 4; element++) {
      const ea = element & 2 ? -a : a;
      const eb = element & 1 ? -bb : bb;
      vortices.push({
        group: g,
        element,
        x: ea * cos - eb * sin,
        y: ea * sin + eb * cos,
        radius,
      });
    }
  }
  const vortexOf = (group: number, element: number): Vortex => vortices[group * 4 + element];

  /** Stroke `i` hovering at tangent point (x, y), `d` from the eye, about vortex `v`. */
  const place = (i: number, x: number, y: number, d: number, v: Vortex | null): void => {
    const i3 = i * 3;
    let dx = fx + x * rx + y * ux;
    let dy = fy + y * uy;
    let dz = fz + x * rz + y * uz;
    const dl = Math.hypot(dx, dy, dz);
    dx /= dl;
    dy /= dl;
    dz /= dl;
    anchors[i3] = eye[0] + dx * d;
    anchors[i3 + 1] = eye[1] + dy * d;
    anchors[i3 + 2] = eye[2] + dz * d;
    if (!v) return;
    let kx = fx + v.x * rx + v.y * ux;
    let ky = fy + v.y * uy;
    let kz = fz + v.x * rz + v.y * uz;
    const kl = Math.hypot(kx, ky, kz);
    kx /= kl;
    ky /= kl;
    kz /= kl;
    const px = dx * d;
    const py = dy * d;
    const pz = dz * d;
    const along = px * kx + py * ky + pz * kz;
    b[i3] = px - kx * along;
    b[i3 + 1] = py - ky * along;
    b[i3 + 2] = pz - kz * along;
    c[i3] = ky * pz - kz * py;
    c[i3 + 1] = kz * px - kx * pz;
    c[i3 + 2] = kx * py - ky * px;
    const rho = Math.acos(Math.min(1, Math.max(-1, along / d)));
    // Rotations about f keep the spin, the mirrors flip it.
    const spin = v.element === 0 || v.element === 3 ? 1 : -1;
    rate[i] = spin * swirlRate(rho, SWIRL_CORE_SHARE * v.radius, rates[v.group]);
  };

  /** Where stroke `i` hovers when it does not swirl: on its own line toward the eye. */
  const still = (i: number, d: number): void => {
    const i3 = i * 3;
    const px = from[i3] - eye[0];
    const py = from[i3 + 1] - eye[1];
    const pz = from[i3 + 2] - eye[2];
    const length = Math.hypot(px, py, pz) || 1;
    const at = Math.min(length, d);
    anchors[i3] = eye[0] + (px / length) * at;
    anchors[i3 + 1] = eye[1] + (py / length) * at;
    anchors[i3 + 2] = eye[2] + (pz / length) * at;
  };

  /** The point opposite tangent point (x, y) on its circle about vortex `v`, or null. */
  const opposite = (x: number, y: number, v: Vortex): [number, number] | null => {
    // In the frame (r, u, f): the stroke's direction D, the axis K, then D turned by π about K.
    const dl = Math.hypot(x, y, 1);
    const kl = Math.hypot(v.x, v.y, 1);
    const dot = (x * v.x + y * v.y + 1) / (dl * kl);
    const ox = (2 * dot * v.x) / kl - x / dl;
    const oy = (2 * dot * v.y) / kl - y / dl;
    const of = (2 * dot) / kl - 1 / dl;
    if (of < MIN_FORWARD) return null;
    return [ox / of, oy / of];
  };

  // The slots, in eights: every eighth stroke's place, the place opposite it on its circle, and
  // the four images of each. The symmetry needs only the slots, so any stroke can fill one.
  const order: number[] = [];
  for (let i = 0; i < count; i++) if (ok[i]) order.push(i);
  const slotX: number[] = [];
  const slotY: number[] = [];
  const slotD: number[] = [];
  const slotV: Vortex[] = [];
  for (let q = 0; q + 8 <= order.length; q += 8) {
    const lead = order[q];
    const i3 = lead * 3;
    const length = Math.hypot(from[i3] - eye[0], from[i3 + 1] - eye[1], from[i3 + 2] - eye[2]);
    const d = Math.min(length, near + (far - near) * random());
    if (d < MIN_DISTANCE) continue;
    const x = sx[lead] * stretch;
    const y = sy[lead] * stretch;
    // The vortex nearest in units of its own radius.
    let best = vortices[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const v of vortices) {
      const score = Math.hypot(x - v.x, y - v.y) / v.radius;
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
    const across = opposite(x, y, best);
    if (!across) continue;
    // Each point's place in its group's tilted frame, and its three images there.
    const tilt = tilts[best.group];
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    const points: readonly [number, number][] = [[x, y], across];
    for (const [px, py] of points) {
      const a = px * cos + py * sin;
      const bb = -px * sin + py * cos;
      for (let element = 0; element < 4; element++) {
        const ea = element & 2 ? -a : a;
        const eb = element & 1 ? -bb : bb;
        slotX.push(ea * cos - eb * sin);
        slotY.push(ea * sin + eb * cos);
        slotD.push(d);
        slotV.push(vortexOf(best.group, best.element ^ element));
      }
    }
  }

  // Each stroke takes the nearest free slot to its own place, so it flies a short way and the
  // cloud keeps the painting's colours where they were. Slots are bucketed on a grid.
  const slots = slotX.length;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < slots; k++) {
    minX = Math.min(minX, slotX[k]);
    maxX = Math.max(maxX, slotX[k]);
    minY = Math.min(minY, slotY[k]);
    maxY = Math.max(maxY, slotY[k]);
  }
  const side = Math.max(1, Math.round(Math.sqrt(slots / 4)));
  const cellW = Math.max(1e-6, (maxX - minX) / side);
  const cellH = Math.max(1e-6, (maxY - minY) / side);
  const cellOf = (v: number, lo: number, size: number): number =>
    Math.min(side - 1, Math.max(0, Math.floor((v - lo) / size)));
  const buckets: number[][] = Array.from({ length: side * side }, () => []);
  for (let k = 0; k < slots; k++) {
    buckets[cellOf(slotY[k], minY, cellH) * side + cellOf(slotX[k], minX, cellW)].push(k);
  }
  const taken = new Uint8Array(count);
  let free = slots;
  for (const i of order) {
    if (free === 0) break;
    const x = sx[i] * stretch;
    const y = sy[i] * stretch;
    const cx = cellOf(x, minX, cellW);
    const cy = cellOf(y, minY, cellH);
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestBucket: number[] | null = null;
    let bestAt = -1;
    for (let ring = 0; ring < side; ring++) {
      // A ring this far out holds nothing nearer than its inner edge.
      if (best >= 0 && (ring - 1) * Math.min(cellW, cellH) > bestDistance) break;
      for (let gy = cy - ring; gy <= cy + ring; gy++) {
        if (gy < 0 || gy >= side) continue;
        for (let gx = cx - ring; gx <= cx + ring; gx++) {
          if (gx < 0 || gx >= side) continue;
          if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== ring) continue;
          const bucket = buckets[gy * side + gx];
          for (let at = 0; at < bucket.length; at++) {
            const k = bucket[at];
            const distance = Math.hypot(slotX[k] - x, slotY[k] - y);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = k;
              bestBucket = bucket;
              bestAt = at;
            }
          }
        }
      }
    }
    if (best < 0 || !bestBucket) break;
    bestBucket[bestAt] = bestBucket[bestBucket.length - 1];
    bestBucket.pop();
    free -= 1;
    taken[i] = 1;
    place(i, slotX[best], slotY[best], slotD[best], slotV[best]);
  }
  for (let i = 0; i < count; i++) if (!taken[i]) still(i, near + (far - near) * random());
  return { count, b, c, rate, half };
}

/**
 * Every stroke's offset from its anchor `time` seconds into the swirl, xyz per stroke into `out`.
 */
export function swirlOffsets(swirl: Swirl, time: number, out: Float32Array): void {
  const { b, c, rate } = swirl;
  for (let i = 0; i < swirl.count; i++) {
    const phi = rate[i] * time;
    const cosm = Math.cos(phi) - 1;
    const sin = Math.sin(phi);
    const i3 = i * 3;
    out[i3] = b[i3] * cosm + c[i3] * sin;
    out[i3 + 1] = b[i3 + 1] * cosm + c[i3 + 1] * sin;
    out[i3 + 2] = b[i3 + 2] * cosm + c[i3 + 2] * sin;
  }
}

/** Strokes in the fade style's pulse field. */
export const CUE_COUNT = 1800;
/** The field's half-angle about the heading, radians (65°). */
export const CUE_HALF_ANGLE = (65 * Math.PI) / 180;
/** Its strokes lie this far from the eye, metres. */
export const CUE_NEAR = 2.6;
export const CUE_FAR = 4;
/** A cue stroke's quad, metres: about 1.6° by 0.6° at 3 m. */
export const CUE_STROKE: readonly [number, number] = [0.085, 0.032];
/** One slow breath of the field's brightness, seconds. */
export const CUE_BREATH_S = 5;
/** The field's brightness over its palette, at the breath's low and high. */
export const CUE_DIM_LOW = 0.4;
export const CUE_DIM_HIGH = 0.7;

/** The field's night palette, sRGB: Starry Night's blues, with a few of its yellows. */
const CUE_BLUES: readonly (readonly [number, number, number])[] = [
  [27, 42, 90],
  [36, 62, 120],
  [52, 88, 152],
  [74, 112, 170],
  [96, 136, 190],
];
const CUE_YELLOWS: readonly (readonly [number, number, number])[] = [
  [214, 184, 84],
  [232, 206, 112],
];
/** The share of the field's strokes that are yellow. */
const CUE_YELLOW_SHARE = 0.08;

export interface CueField {
  readonly count: number;
  /** xyz per stroke, rig-local. Never written after the field is made. */
  readonly positions: Float32Array;
  /** sRGB bytes, rgb per stroke, at full brightness. */
  readonly palette: Uint8Array;
  /** Quad length and width per stroke, metres, at full size. */
  readonly sizes: Float32Array;
}

/**
 * The pulse field around `forward` (a horizontal heading is enough) from `eye`, rig-local, the
 * same for the same inputs.
 */
export function createCueField(eye: Vec3, forward: Vec3, count = CUE_COUNT): CueField {
  let seed = 0x2545f491;
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let fx = forward[0];
  let fy = forward[1];
  let fz = forward[2];
  let fl = Math.hypot(fx, fy, fz);
  if (fl < 1e-6) {
    fx = 0;
    fy = 0;
    fz = -1;
    fl = 1;
  }
  fx /= fl;
  fy /= fl;
  fz /= fl;
  let rx = -fz;
  let rz = fx;
  let rl = Math.hypot(rx, rz);
  if (rl < 1e-3) {
    rx = 1;
    rz = 0;
    rl = 1;
  }
  rx /= rl;
  rz /= rl;
  const ux = -rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy;
  const positions = new Float32Array(count * 3);
  const palette = new Uint8Array(count * 3);
  const sizes = new Float32Array(count * 2);
  const cosMax = Math.cos(CUE_HALF_ANGLE);
  for (let i = 0; i < count; i++) {
    // Uniform over the spherical cap: cos θ uniform in [cos max, 1].
    const cosT = 1 - random() * (1 - cosMax);
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = 2 * Math.PI * random();
    const a = sinT * Math.cos(phi);
    const b = sinT * Math.sin(phi);
    const dx = fx * cosT + rx * a + ux * b;
    const dy = fy * cosT + uy * b;
    const dz = fz * cosT + rz * a + uz * b;
    const d = CUE_NEAR + (CUE_FAR - CUE_NEAR) * random();
    positions[i * 3] = eye[0] + dx * d;
    positions[i * 3 + 1] = eye[1] + dy * d;
    positions[i * 3 + 2] = eye[2] + dz * d;
    const yellow = random() < CUE_YELLOW_SHARE;
    const set = yellow ? CUE_YELLOWS : CUE_BLUES;
    const colour = set[Math.min(set.length - 1, Math.floor(random() * set.length))];
    palette[i * 3] = colour[0];
    palette[i * 3 + 1] = colour[1];
    palette[i * 3 + 2] = colour[2];
    const scale = 0.75 + 0.5 * random();
    sizes[i * 2] = CUE_STROKE[0] * scale;
    sizes[i * 2 + 1] = CUE_STROKE[1] * scale;
  }
  return { count, positions, palette, sizes };
}

/** The field's brightness `waitTime` seconds into the wait: one slow breath from its low. */
export function cueBrightness(waitTime: number): number {
  const breath = 0.5 * (1 - Math.cos((2 * Math.PI * Math.max(0, waitTime)) / CUE_BREATH_S));
  return CUE_DIM_LOW + (CUE_DIM_HIGH - CUE_DIM_LOW) * breath;
}

/**
 * The field's colours and sizes for one frame into `colors` (rgb bytes) and `sizes`: brightness
 * `brightness`, and every quad scaled by `grow` (0-1). Positions are the field's own.
 */
export function cueFrame(
  field: CueField,
  brightness: number,
  grow: number,
  colors: Uint8Array,
  sizes: Float32Array,
): void {
  const g = Math.min(1, Math.max(0, grow));
  for (let i = 0; i < field.count * 3; i++) {
    colors[i] = Math.round(field.palette[i] * brightness);
  }
  for (let i = 0; i < field.count * 2; i++) sizes[i] = field.sizes[i] * g;
}
