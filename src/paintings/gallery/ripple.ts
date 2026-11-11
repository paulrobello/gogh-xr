/**
 * The gallery ripple: a hand orb touching the live painting ripples its scan like a portal surface,
 * and the scan settles back when the hand leaves.
 *
 * Contact. A plane test per tracked hand against the scan rectangle (`contactAt`): the hand's
 * signed distance from the scan plane within `RIPPLE_REACH` in front or `RIPPLE_BEHIND` behind,
 * and its projection inside the scan plus `RIPPLE_MARGIN`. Strength is 1 at and behind the surface
 * and falls smoothly to 0 at the reach (`contactStrength`). Each hand has one slot, which keeps its
 * last contact while it eases: up in `RIPPLE_RISE_S`, down in `RIPPLE_FALL_S`, rate-limited so it
 * lands on exactly 0, then shaped by a smoothstep (`easeStrength`, `shapeStrength`). A drag moves
 * the centre with the hand. A touch after a gap more than `RIPPLE_RETARGET_M` from the old centre
 * first settles the old ripple at the rise rate, so it never jumps. A portal transition takes no
 * new contact and eases every slot out.
 *
 * Look. A uniform-only UV warp in the scan's own fragment shader (ripple.frag.glsl, mirrored by
 * `rippleWarp`): a swirl turning the paint about each contact, decaying with radius, and rings
 * travelling outward, with a faint brightening at the centre. It fades to 0 at the scan's edge and
 * is clamped into the crop window, so the moulding, the wall strokes and the plaques never move.
 *
 * Cost. No draw call or mesh: the live scan's MeshBasicMaterial is patched once, before its first
 * draw, so its program links with the gallery and the first touch links nothing. Coming-soon scans
 * keep the plain material. The warp is spliced into three's own `map_fragment` chunk, whose sample
 * coordinate becomes the warped uv. A contact strength of 0 skips the warp and samples `vMapUv`
 * itself, so a scan at rest draws byte for byte as before. Nothing allocates per frame.
 */
import { type MeshBasicMaterial, ShaderChunk, Vector2, Vector4 } from 'three';
import { HAND_RADIUS } from '../../motion/reactive';
import type { Vec3 } from '../../render/strokes/frame';
import type {
  HandRipple,
  HandRippleContact,
  HandRippleDiag,
  HandRippleFrame,
} from '../hand-ripple';
import { type Hanging, SCAN_DEPTH, type UvCrop, wallPoint } from './layout';
import warpGlsl from './ripple.frag.glsl?raw';

/** Metres in front of the scan plane a hand still touches it: the orbs' paint reach. */
export const RIPPLE_REACH: number = HAND_RADIUS;
/** Metres behind the scan plane a hand still counts, pushed into the wall. */
export const RIPPLE_BEHIND: number = 0.06;
/** Metres past the scan's edge a hand's projection may fall and still touch it. */
export const RIPPLE_MARGIN: number = 0.03;
/** The warp's radius on the canvas at full strength, metres. */
export const RIPPLE_RADIUS: number = 0.25;
/** The radius at a faint touch, as a share of `RIPPLE_RADIUS`: it opens as the hand presses. */
export const RIPPLE_RADIUS_MIN_SHARE: number = 0.6;
/** Radians the paint turns at the centre at full strength. */
export const RIPPLE_SWIRL: number = 0.5;
/** The share the twist breathes by as its spiral wave runs out. */
export const RIPPLE_SWIRL_WOBBLE: number = 0.3;
/** Seconds per breath of the twist. */
export const RIPPLE_SWIRL_PERIOD_S: number = 2.4;
/** Metres between the spiral wave's crests. */
export const RIPPLE_SWIRL_WAVELENGTH: number = 0.3;
/** Metres of radial shift at a ring's crest at full strength. */
export const RIPPLE_RING_AMPLITUDE: number = 0.008;
/** Metres between rings. */
export const RIPPLE_RING_WAVELENGTH: number = 0.07;
/** Seconds per ring: the rings travel out at wavelength / period, about 0.12 m/s. */
export const RIPPLE_RING_PERIOD_S: number = 0.6;
/** Metres from the centre over which the rings fade in. */
export const RIPPLE_RING_INNER: number = 0.03;
/** Metres inside the scan's edge over which the warp fades to 0. */
export const RIPPLE_EDGE: number = 0.04;
/** The brightening at the centre at full strength, a share of the paint's colour. */
export const RIPPLE_GLOW: number = 0.08;
/** Seconds from rest to full strength. */
export const RIPPLE_RISE_S: number = 0.15;
/** Seconds from full strength back to rest. */
export const RIPPLE_FALL_S: number = 0.8;
/**
 * Metres a hand's new contact must lie from its slot's last centre, after a gap, to move the
 * ripple there: the old ripple first settles at the rise rate, then the new one rises. A drag,
 * which never loses contact, moves the centre with the hand.
 */
export const RIPPLE_RETARGET_M: number = 0.03;
/** The ripple's time wraps here: a whole number of both periods, so the wrap never jumps. */
export const RIPPLE_TIME_WRAP_S: number = 2.4;

/** The plane a scan lies in: its centre, its right and up axes, the room-facing normal, its size. */
export interface ScanFrame {
  readonly centre: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly normal: Vec3;
  readonly width: number;
  readonly height: number;
}

/** The scan plane of `h`, where index.ts puts its mesh: the plane's +X is the wall's right. */
export function scanFrame(h: Hanging): ScanFrame {
  return {
    centre: wallPoint(h.wall, h.s, h.y, SCAN_DEPTH),
    right: h.wall.right,
    up: [0, 1, 0],
    normal: h.wall.normal,
    width: h.width,
    height: h.height,
  };
}

/** A hand's contact: canvas uv (v up) and the strength it asks for. */
export interface ContactTarget {
  u: number;
  v: number;
  strength: number;
}

/** 1 at and behind the surface, falling smoothly to 0 at `RIPPLE_REACH` in front. */
export function contactStrength(distance: number): number {
  if (distance <= 0) return 1;
  if (distance >= RIPPLE_REACH) return 0;
  const t = distance / RIPPLE_REACH;
  const q = 1 - t * t;
  return q * q;
}

/** Writes the contact of a hand at (x, y, z) into `out`; false when it does not touch the scan. */
export function contactAt(
  frame: ScanFrame,
  x: number,
  y: number,
  z: number,
  out: ContactTarget,
): boolean {
  const dx = x - frame.centre[0];
  const dy = y - frame.centre[1];
  const dz = z - frame.centre[2];
  const n = frame.normal;
  const distance = dx * n[0] + dy * n[1] + dz * n[2];
  if (distance < -RIPPLE_BEHIND || distance >= RIPPLE_REACH) return false;
  const r = frame.right;
  const up = frame.up;
  const px = dx * r[0] + dy * r[1] + dz * r[2];
  const py = dx * up[0] + dy * up[1] + dz * up[2];
  if (Math.abs(px) > frame.width / 2 + RIPPLE_MARGIN) return false;
  if (Math.abs(py) > frame.height / 2 + RIPPLE_MARGIN) return false;
  out.u = Math.min(Math.max(px / frame.width + 0.5, 0), 1);
  out.v = Math.min(Math.max(py / frame.height + 0.5, 0), 1);
  out.strength = contactStrength(distance);
  return true;
}

/** One frame of the ease: rate-limited, so a fall from 1 reaches exactly 0 in `RIPPLE_FALL_S`. */
export function easeStrength(current: number, target: number, dt: number): number {
  if (target > current) return Math.min(target, current + dt / RIPPLE_RISE_S);
  return Math.max(target, current - dt / RIPPLE_FALL_S);
}

/** The applied strength of an eased one: a smoothstep, so it starts and settles gently. */
export function shapeStrength(eased: number): number {
  const e = Math.min(Math.max(eased, 0), 1);
  return e * e * (3 - 2 * e);
}

/** The warp radius of a contact at shaped strength `s`. */
export function rippleRadius(s: number): number {
  return RIPPLE_RADIUS * (RIPPLE_RADIUS_MIN_SHARE + (1 - RIPPLE_RADIUS_MIN_SHARE) * s);
}

const TAU = Math.PI * 2;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** One contact as the shader reads it: texture uv, strength times amplitude, radius in metres. */
export interface WarpContact {
  u: number;
  v: number;
  strength: number;
  radius: number;
}

/**
 * The TS mirror of `galleryRipple` (ripple.frag.glsl): the texture uv sampled for texture uv
 * (u, v), written into `out`, with the glow it adds as the return value. `out` gets (u, v) itself
 * when nothing moves it.
 */
export function rippleWarp(
  u: number,
  v: number,
  contacts: readonly WarpContact[],
  crop: UvCrop,
  metres: readonly [number, number],
  time: number,
  out: [number, number],
): number {
  let sx = 0;
  let sy = 0;
  let glow = 0;
  let moved = false;
  for (const c of contacts) {
    if (!(c.strength > 0)) continue;
    const dx = (u - c.u) * metres[0];
    const dy = (v - c.v) * metres[1];
    const r2 = dx * dx + dy * dy;
    if (!(r2 < c.radius * c.radius)) continue;
    const r = Math.sqrt(r2);
    const x = r / c.radius;
    const f = (1 - x * x) * (1 - x * x);
    const breath = Math.sin(TAU * (time / RIPPLE_SWIRL_PERIOD_S - r / RIPPLE_SWIRL_WAVELENGTH));
    const turn = c.strength * RIPPLE_SWIRL * f * (1 + RIPPLE_SWIRL_WOBBLE * breath);
    const cs = Math.cos(turn);
    const sn = Math.sin(turn);
    sx += cs * dx - sn * dy - dx;
    sy += sn * dx + cs * dy - dy;
    const wave = Math.sin(TAU * (r / RIPPLE_RING_WAVELENGTH - time / RIPPLE_RING_PERIOD_S));
    const ring =
      c.strength * RIPPLE_RING_AMPLITUDE * wave * f * smoothstep(0, RIPPLE_RING_INNER, r);
    const k = ring / Math.max(r, 1e-6);
    sx += dx * k;
    sy += dy * k;
    glow += c.strength * RIPPLE_GLOW * f * f;
    moved = true;
  }
  if (!moved) {
    out[0] = u;
    out[1] = v;
    return 0;
  }
  const lo = Math.min((u - crop.u0) * metres[0], (v - crop.v0) * metres[1]);
  const hi = Math.min((crop.u1 - u) * metres[0], (crop.v1 - v) * metres[1]);
  const edge = smoothstep(0, RIPPLE_EDGE, Math.min(lo, hi));
  out[0] = Math.min(Math.max(u + (sx * edge) / metres[0], crop.u0), crop.u1);
  out[1] = Math.min(Math.max(v + (sy * edge) / metres[1], crop.v0), crop.v1);
  return glow * edge;
}

/** A GLSL float literal: always carries a decimal point or an exponent. */
const glslFloat = (value: number): string => value.toExponential(8);

/** The RIPPLE_* defines ripple.frag.glsl reads, from the constants above. */
export const RIPPLE_DEFINES: string = [
  ['RIPPLE_TAU', TAU],
  ['RIPPLE_SWIRL', RIPPLE_SWIRL],
  ['RIPPLE_SWIRL_WOBBLE', RIPPLE_SWIRL_WOBBLE],
  ['RIPPLE_SWIRL_PERIOD', RIPPLE_SWIRL_PERIOD_S],
  ['RIPPLE_SWIRL_WAVELENGTH', RIPPLE_SWIRL_WAVELENGTH],
  ['RIPPLE_RING_AMPLITUDE', RIPPLE_RING_AMPLITUDE],
  ['RIPPLE_RING_WAVELENGTH', RIPPLE_RING_WAVELENGTH],
  ['RIPPLE_RING_PERIOD', RIPPLE_RING_PERIOD_S],
  ['RIPPLE_RING_INNER', RIPPLE_RING_INNER],
  ['RIPPLE_EDGE', RIPPLE_EDGE],
  ['RIPPLE_GLOW', RIPPLE_GLOW],
]
  .map(([name, value]) => `#define ${name} ${glslFloat(value as number)}`)
  .join('\n');

/** The map sample in three's `map_fragment` chunk, whose coordinate the ripple replaces. */
const MAP_SAMPLE = 'texture2D( map, vMapUv )';

/**
 * Three's own `map_fragment` chunk with its sample taken at the warped uv, the warp computed before
 * it and the glow applied after it. Throws when the chunk no longer samples `vMapUv` as above, so
 * a three upgrade that changes the chunk fails here instead of drifting from the plain scans.
 */
export function rippleMapFragment(chunk: string): string {
  if (chunk.split(MAP_SAMPLE).length !== 2) {
    throw new Error(`gallery ripple: three's map_fragment has no single "${MAP_SAMPLE}"`);
  }
  return `#ifdef USE_MAP
  float rippleGlow = 0.0;
  vec2 rippleUv = galleryRipple( vMapUv, rippleGlow );
#endif
${chunk.replace(MAP_SAMPLE, 'texture2D( map, rippleUv )')}
#ifdef USE_MAP
  if ( rippleGlow > 0.0 ) diffuseColor.rgb *= 1.0 + rippleGlow;
#endif`;
}

export const RIPPLE_PROGRAM_KEY = 'gallery-ripple';

/** The ripple's uniforms, shared by the material's program and the runtime that writes them. */
export interface RippleUniforms {
  readonly uRipple: { value: [Vector4, Vector4] };
  readonly uRippleCrop: { value: Vector4 };
  readonly uRippleMetres: { value: Vector2 };
  readonly uRippleTime: { value: number };
}

/** Splices the warp into `source`, a MeshBasicMaterial fragment shader; throws if it cannot. */
export function spliceRipple(source: string): string {
  const common = '#include <common>';
  const map = '#include <map_fragment>';
  if (!source.includes(common) || !source.includes(map)) {
    throw new Error('gallery ripple: the scan shader has no common or map_fragment chunk');
  }
  return source
    .replace(common, `${common}\n${RIPPLE_DEFINES}\n${warpGlsl}`)
    .replace(map, rippleMapFragment(ShaderChunk.map_fragment));
}

/** Patches the live scan's material once, before its first draw. */
export function applyRippleWarp(material: MeshBasicMaterial, uniforms: RippleUniforms): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = spliceRipple(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => RIPPLE_PROGRAM_KEY;
}

export interface GalleryRipple extends HandRipple {
  readonly uniforms: RippleUniforms;
}

/** The ripple of the scan of `h`, cropped by `crop`, drawn by `material`. */
export function createGalleryRipple(
  h: Hanging,
  crop: UvCrop,
  material: MeshBasicMaterial,
): GalleryRipple {
  const frame = scanFrame(h);
  const du = crop.u1 - crop.u0;
  const dv = crop.v1 - crop.v0;
  const uniforms: RippleUniforms = {
    uRipple: { value: [new Vector4(), new Vector4()] },
    uRippleCrop: { value: new Vector4(crop.u0, crop.v0, crop.u1, crop.v1) },
    uRippleMetres: { value: new Vector2(h.width / du, h.height / dv) },
    uRippleTime: { value: 0 },
  };
  applyRippleWarp(material, uniforms);
  /** Per slot: its last contact's canvas uv, its eased strength, and whether it touched last frame. */
  const uv: [[number, number], [number, number]] = [
    [0.5, 0.5],
    [0.5, 0.5],
  ];
  const eased: [number, number] = [0, 0];
  const touching: [boolean, boolean] = [false, false];
  const target: ContactTarget = { u: 0, v: 0, strength: 0 };
  let forced: ContactTarget | null = null;
  let amplitude = 0;
  let time = 0;

  const write = (slot: 0 | 1): void => {
    const s = shapeStrength(eased[slot]);
    const at = uv[slot];
    uniforms.uRipple.value[slot].set(
      crop.u0 + at[0] * du,
      crop.v0 + at[1] * dv,
      s * amplitude,
      rippleRadius(s),
    );
  };

  return {
    uniforms,
    frame(state: HandRippleFrame) {
      const gate = state.amplitude > 0;
      amplitude = gate ? state.amplitude : 0;
      const hands = gate && state.presenting && state.enabled;
      for (let hand = 0 as 0 | 1; hand < 2; hand = (hand + 1) as 0 | 1) {
        if (hand === 0 && forced) {
          uv[0][0] = forced.u;
          uv[0][1] = forced.v;
          // A portal transition eases a forced contact out as it does a hand's.
          if (!gate) eased[0] = 0;
          else if (state.busy) eased[0] = easeStrength(eased[0], 0, state.dt);
          else eased[0] = forced.strength;
          continue;
        }
        if (!hands) {
          eased[hand] = 0;
          touching[hand] = false;
          continue;
        }
        const slot = state.slots[hand] ?? -1;
        const d = slot >= 0 ? state.disturbers[slot] : undefined;
        let want = 0;
        // A portal transition takes no new contact: every slot eases out where it was.
        if (!state.busy && d !== undefined && d.w > 0 && contactAt(frame, d.x, d.y, d.z, target)) {
          const far =
            !touching[hand] &&
            eased[hand] > 0 &&
            Math.hypot(
              (target.u - uv[hand][0]) * frame.width,
              (target.v - uv[hand][1]) * frame.height,
            ) > RIPPLE_RETARGET_M;
          if (far) {
            // A touch elsewhere after a gap: the old ripple settles at the rise rate first.
            eased[hand] = Math.max(0, eased[hand] - state.dt / RIPPLE_RISE_S);
            continue;
          }
          touching[hand] = true;
          uv[hand][0] = target.u;
          uv[hand][1] = target.v;
          want = target.strength;
        } else {
          touching[hand] = false;
        }
        eased[hand] = easeStrength(eased[hand], want, state.dt);
      }
      time = (time + state.dt * amplitude) % RIPPLE_TIME_WRAP_S;
      uniforms.uRippleTime.value = time;
      write(0);
      write(1);
    },
    force(u, v, strength) {
      if (strength === null) {
        forced = null;
        eased[0] = 0;
      } else {
        forced = {
          u: Math.min(Math.max(u, 0), 1),
          v: Math.min(Math.max(v, 0), 1),
          strength: Math.min(Math.max(strength, 0), 1),
        };
      }
    },
    diag(): HandRippleDiag {
      const contact = (slot: 0 | 1): HandRippleContact | null => {
        const s = shapeStrength(eased[slot]);
        return s > 0 ? { uv: [uv[slot][0], uv[slot][1]], strength: s } : null;
      };
      return { contacts: [contact(0), contact(1)], amplitude };
    },
  };
}
