/**
 * Hand orbs: a small glowing ball at each tracked hand in XR, so the hand reads in the painting and
 * touching the reactive strokes is intuitive.
 *
 * Place. Each orb sits on its hand's disturber in the reactive tracker (src/motion/reactive.ts),
 * read from the tracker's uniforms after it ran this frame, so it is exactly where the stroke
 * shader pushes from. A hand's push reaches `HAND_RADIUS` (0.13 m), the glow's rest edge plus
 * 0.05 m, so the paint reacts only where the orb is.
 *
 * Look. A bright soft core of about `ORB_CORE_RADIUS` and a halo that falls to 0 at
 * `ORB_GLOW_RADIUS`, additive, warm white in the core and Starry Night's moon yellow outside. The
 * fragment shader shades by how close each eye ray passes to the centre, so there is no facet or
 * hard edge. Within a hand's paint reach of a stroke it brightens and its glow grows a little, so
 * it lights up exactly where the paint moves: the world's stroke reach field
 * (src/render/strokes/reach-field.ts) gives the distance q from the hand to the nearest stroke's
 * quad, as the reactive shader measures it, and the boost is 1 - (q / HAND_RADIUS)² times calm,
 * eased. It reads 0 where the strokes do not react (the gallery, `?noanim`, calm 0). The hand's
 * speed plays no part: a still hand at the paint pushes it too.
 *
 * Cost. One mesh per hand, one draw per view each while shown, covering only the glow's disc. It
 * depth-tests against the scene and writes no depth, so it never cuts holes in the strokes. What
 * writes depth hides it: the base meshes (walls, ground), the panel, and the strokes that write
 * depth, the cypress and the moon and stars, so a hand inside the cypress glows through gaps in
 * its foliage. The strokes are in the opaque list, so a transparent orb draws after them. Hidden
 * (`visible = false`, no draw) when the setting is off, outside XR and for an untracked hand.
 *
 * Near the eye. It draws front faces, so the glow sits on the near side of the hand. With the
 * hand closer than the mesh radius plus the near plane plus `ORB_NEAR_MARGIN`, the near plane would
 * clip the front cap and cut a hole through the core, so it draws back faces instead. The shading
 * depends only on each ray's closest approach to the centre, so either side looks the same, and
 * `side` is render state, not part of the program.
 */
import {
  AdditiveBlending,
  BackSide,
  Color,
  FrontSide,
  GLSL3,
  Mesh,
  type Object3D,
  RawShaderMaterial,
  SphereGeometry,
  type Vector4,
} from 'three';
import { HAND_RADIUS } from '../motion/reactive';
import fragmentShader from './hand-orbs.frag.glsl?raw';
import vertexShader from './hand-orbs.vert.glsl?raw';
import type { StrokeReach } from './strokes/reach-field';

/**
 * Metres: the bright core's radius (its glow is 1/e there). Paul's 2026-11-09 headset check asked
 * for smaller, dimmer orbs: 0.05 m and 0.14 m before, scaled by about 0.6 to these.
 */
export const ORB_CORE_RADIUS: number = 0.03;
/** Metres: the halo reaches 0 here, at rest. HAND_RADIUS (reactive.ts) is this plus 0.05 m. */
export const ORB_GLOW_RADIUS: number = 0.08;
/**
 * The drawn sphere's radius over the glow's. A 24 × 16 sphere's silhouette stays within 2% of its
 * radius, so the glow's edge lies inside the drawn disc at every scale (the mesh scales with it).
 */
export const ORB_MESH_MARGIN: number = 1.03;
/** Starry Night's moon and star yellow: the halo. */
export const ORB_COLOR: number = 0xf6d36b;
/** A warm white: the core. */
export const ORB_CORE_COLOR: number = 0xfff3d6;
/**
 * The glow's gain at rest. The peak alpha is 1.15 × the gain. At 1 the core saturated at rest and
 * at speed; at 0.45 the rest peak is 0.52 and the mean alpha over the disc 0.087, against 1.0 and
 * 0.182 before, about half.
 */
export const ORB_GAIN: number = 0.45;
/** The core's and the halo's weights. */
export const ORB_CORE_SHARE: number = 0.85;
export const ORB_HALO_SHARE: number = 0.3;
/**
 * The extra gain share at full boost, the hand at the paint (the gain reaches ORB_GAIN × (1 +
 * ORB_BOOST)): a peak of 0.72 and a mean over the grown disc of 0.122, against a saturated 1.0 and
 * 0.258 before.
 */
export const ORB_BOOST: number = 0.4;
/** The glow's extra size at full boost (its radius reaches ORB_GLOW_RADIUS × (1 + ORB_GROW)). */
export const ORB_GROW: number = 0.2;
/** The camera's near plane, metres (main.ts). */
export const ORB_NEAR: number = 0.1;
/** Metres past the near plane at which the orb switches to back faces. */
export const ORB_NEAR_MARGIN: number = 0.03;
/** Seconds: the time constant the boost eases with. */
export const ORB_BOOST_TAU_S: number = 0.15;
/**
 * Transparent: after every opaque object (the strokes), and before transparent UI of order 0 and
 * up (the panel's text, notices, the perf HUD, the vignette), so those draw over the glow.
 */
export const ORB_RENDER_ORDER: number = -1000;

export type Hand = 'left' | 'right';
export const HANDS: readonly Hand[] = ['left', 'right'];

/** `T` with its readonly fields writable, for a reused per-frame state object. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface HandOrbsFrame {
  /** The setting. */
  readonly enabled: boolean;
  readonly presenting: boolean;
  /**
   * The reactive tracker's `uDisturbers`: xyz world, w strength (0 when untracked). Index 0 is the
   * head, whose position is the eye the near-plane check below reads.
   */
  readonly disturbers: readonly Vector4[];
  /** Per hand (left, right), its disturber index, or -1 when no slot holds that hand. */
  readonly slots: readonly [number, number];
  /** The bound world's stroke reach field, or null for a world without one. */
  readonly strokeReach: Pick<StrokeReach, 'distance'> | null;
  /** The reactive motion's gate is open (`uMotionLayers`): strokes move for a hand at all. */
  readonly reactive: boolean;
  /** Motion calm, 0-1: the reactive push scales with it, so the boost does too. */
  readonly calm: number;
  /** Seconds since the last frame. */
  readonly dt: number;
}

export interface HandOrbsDiag {
  enabled: boolean;
  /** Left, right. */
  visible: [boolean, boolean];
  /** Left, right: metres to the nearest stroke the hand pushes, or null past its reach. */
  reach: [number | null, number | null];
  /** Left, right: the eased boost, 0-1. */
  boost: [number, number];
}

export interface HandOrbs {
  /** Left, right. */
  readonly meshes: readonly [Mesh, Mesh];
  frame(state: HandOrbsFrame): void;
  diag(): HandOrbsDiag;
  dispose(): void;
}

/** A GLSL float literal: always carries a decimal point or an exponent. */
const glslFloat = (value: number): string => value.toExponential(8);

export function createHandOrbs(parent: Object3D): HandOrbs {
  const geometry = new SphereGeometry(ORB_GLOW_RADIUS * ORB_MESH_MARGIN, 24, 16);
  const boost: [number, number] = [0, 0];
  const nearest: [number, number] = [Infinity, Infinity];
  let enabled = false;
  const make = (hand: Hand): Mesh => {
    const material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uColor: { value: new Color(ORB_COLOR) },
        uCoreColor: { value: new Color(ORB_CORE_COLOR) },
        uGain: { value: ORB_GAIN },
        uScale: { value: 1 },
      },
      defines: {
        ORB_CORE: glslFloat(ORB_CORE_RADIUS),
        ORB_GLOW: glslFloat(ORB_GLOW_RADIUS),
        CORE_SHARE: glslFloat(ORB_CORE_SHARE),
        HALO_SHARE: glslFloat(ORB_HALO_SHARE),
      },
      transparent: true,
      blending: AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: FrontSide,
    });
    material.name = `hand-orb-${hand}`;
    const mesh = new Mesh(geometry, material);
    mesh.name = `hand-orb-${hand}`;
    mesh.renderOrder = ORB_RENDER_ORDER;
    mesh.visible = false;
    parent.add(mesh);
    return mesh;
  };
  const meshes: [Mesh, Mesh] = [make('left'), make('right')];

  return {
    meshes,
    frame(state) {
      enabled = state.enabled;
      const ease = state.dt > 0 ? 1 - Math.exp(-state.dt / ORB_BOOST_TAU_S) : 0;
      for (let h = 0; h < 2; h += 1) {
        const mesh = meshes[h] as Mesh;
        const slot = state.slots[h] ?? -1;
        const d = slot >= 0 ? state.disturbers[slot] : undefined;
        const show = state.enabled && state.presenting && d !== undefined && d.w > 0;
        mesh.visible = show;
        if (!show || !d) {
          boost[h] = 0;
          nearest[h] = Infinity;
          continue;
        }
        mesh.position.set(d.x, d.y, d.z);
        const q =
          state.reactive && state.strokeReach
            ? state.strokeReach.distance(d.x, d.y, d.z)
            : Infinity;
        nearest[h] = q;
        const x = q / HAND_RADIUS;
        const target = x < 1 ? (1 - x * x) * Math.min(Math.max(state.calm, 0), 1) : 0;
        boost[h] = (boost[h] ?? 0) + (target - (boost[h] ?? 0)) * ease;
        const b = boost[h] ?? 0;
        const uniforms = (mesh.material as RawShaderMaterial).uniforms;
        (uniforms.uGain as { value: number }).value = ORB_GAIN * (1 + ORB_BOOST * b);
        (uniforms.uScale as { value: number }).value = 1 + ORB_GROW * b;
        mesh.scale.setScalar(1 + ORB_GROW * b);
        const eye = state.disturbers[0];
        const reach = ORB_GLOW_RADIUS * ORB_MESH_MARGIN * (1 + ORB_GROW * b) + ORB_NEAR;
        const near =
          eye !== undefined &&
          Math.hypot(d.x - eye.x, d.y - eye.y, d.z - eye.z) < reach + ORB_NEAR_MARGIN;
        (mesh.material as RawShaderMaterial).side = near ? BackSide : FrontSide;
      }
    },
    diag() {
      const near = (q: number): number | null => (Number.isFinite(q) ? q : null);
      return {
        enabled,
        visible: [meshes[0].visible, meshes[1].visible],
        reach: [near(nearest[0]), near(nearest[1])],
        boost: [boost[0], boost[1]],
      };
    },
    dispose() {
      for (const mesh of meshes) {
        mesh.removeFromParent();
        (mesh.material as RawShaderMaterial).dispose();
      }
      geometry.dispose();
    },
  };
}
