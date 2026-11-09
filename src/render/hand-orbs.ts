/**
 * Hand orbs: a small glowing ball at each tracked hand in XR, so the hand reads in the painting and
 * touching the reactive strokes is intuitive.
 *
 * Place. Each orb sits on its hand's disturber in the reactive tracker (src/motion/reactive.ts),
 * read from the tracker's uniforms after it ran this frame, so it is exactly where the stroke
 * shader pushes from. The push itself reaches `REACTIVE_RADIUS` (0.6 m); the orb does not draw
 * that region, which would put the eye inside it and cost a full-viewport pass per eye.
 *
 * Look. A bright soft core of about `ORB_CORE_RADIUS` and a halo that falls to 0 at
 * `ORB_GLOW_RADIUS`, additive, warm white in the core and Starry Night's moon yellow outside. The
 * fragment shader shades by how close each eye ray passes to the centre, so there is no facet or
 * hard edge. While the hand moves it brightens and its glow grows a little: the hand's speed over
 * `WAKE_REF_SPEED`, times calm, stands in for "moving strokes" (a moving hand drags and swirls
 * them). It does not check that any stroke is in reach: measured at 46 hand positions, the stroke
 * batch's chunk boxes (4 m cells) contain the hand at all but one, strokes or not, and the ground
 * height alone misses the cypress and the walls. No cheap per-hand nearest-stroke query exists.
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
import { WAKE_REF_SPEED } from '../motion/reactive';
import fragmentShader from './hand-orbs.frag.glsl?raw';
import vertexShader from './hand-orbs.vert.glsl?raw';

/** Metres: the bright core's radius (its glow is 1/e there). */
export const ORB_CORE_RADIUS: number = 0.05;
/** Metres: the halo reaches 0 here, at rest. */
export const ORB_GLOW_RADIUS: number = 0.14;
/**
 * The drawn sphere's radius over the glow's. A 24 × 16 sphere's silhouette stays within 2% of its
 * radius, so the glow's edge lies inside the drawn disc at every scale (the mesh scales with it).
 */
export const ORB_MESH_MARGIN: number = 1.03;
/** Starry Night's moon and star yellow: the halo. */
export const ORB_COLOR: number = 0xf6d36b;
/** A warm white: the core. */
export const ORB_CORE_COLOR: number = 0xfff3d6;
/** The glow's gain at rest. */
export const ORB_GAIN: number = 1;
/** The core's and the halo's weights. */
export const ORB_CORE_SHARE: number = 0.85;
export const ORB_HALO_SHARE: number = 0.3;
/** The extra gain share at full speed (the gain reaches ORB_GAIN × (1 + ORB_BOOST)). */
export const ORB_BOOST: number = 0.6;
/** The glow's extra size at full speed (its radius reaches ORB_GLOW_RADIUS × (1 + ORB_GROW)). */
export const ORB_GROW: number = 0.2;
/** The camera's near plane, metres (main.ts). */
export const ORB_NEAR: number = 0.1;
/** Metres past the near plane at which the orb switches to back faces. */
export const ORB_NEAR_MARGIN: number = 0.03;
/** Seconds: the time constant the speed boost eases with. */
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
  /** The reactive tracker's `uDisturberVelocities`: xyz m/s. */
  readonly velocities: readonly Vector4[];
  /** Per hand (left, right), its disturber index, or -1 when no slot holds that hand. */
  readonly slots: readonly [number, number];
  /** Motion calm, 0-1: the reactive push scales with it, so the boost does too. */
  readonly calm: number;
  /** Seconds since the last frame. */
  readonly dt: number;
}

export interface HandOrbsDiag {
  enabled: boolean;
  /** Left, right. */
  visible: [boolean, boolean];
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
          continue;
        }
        mesh.position.set(d.x, d.y, d.z);
        const v = state.velocities[slot];
        const speed = v ? Math.hypot(v.x, v.y, v.z) : 0;
        const target = Math.min(speed / WAKE_REF_SPEED, 1) * Math.min(Math.max(state.calm, 0), 1);
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
      return { enabled, visible: [meshes[0].visible, meshes[1].visible] };
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
