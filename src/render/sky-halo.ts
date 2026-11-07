/**
 * The star and moon halos (P4.3, PRD "Living paint"): one instanced mesh of 12 soft additive glows, one per sky
 * anchor (src/motion/sky-rings.ts), the world's only blended pass. Each glow lies on the dome's
 * tangent plane at its anchor and draws over the dome and the anchor's own strokes and behind the
 * rest of the world (`SKY_HALO_NDC`), depth-tested and not depth-written. A star's glow is a disc
 * round its centre; the moon's is a band round its crescent, drawn as a ring whose hole covers the
 * crescent. Its size and the rings in its brightness follow the anchor's wave, from the motion
 * clock's own uniforms, so they pulse with the ring strokes. A closed gate (`?noanim`, calm 0) draws
 * the rest halo, which never vanishes. The diag's `halo` key reads the TS mirror on the CPU
 * (`state()`), not the GPU.
 *
 * One draw per view: frustum culling is off, so the draw count does not depend on the view, and XR
 * without multiview draws it twice.
 */
import {
  BufferAttribute,
  CustomBlending,
  DoubleSide,
  GLSL3,
  InstancedBufferGeometry,
  Mesh,
  OneFactor,
  RawShaderMaterial,
} from 'three';
import { type MotionUniforms, motionClock } from '../motion/clock';
import { motionGate } from '../motion/layers';
import {
  SKY_MOON_RING,
  SKY_RINGS,
  type SkyHaloState,
  skyHaloGlslDefines,
  skyHaloState,
} from '../motion/sky-rings';
import skyRingsShader from '../motion/sky-rings.glsl?raw';
import fragmentShader from './sky-halo.frag.glsl?raw';
import vertexShader from './sky-halo.vert.glsl?raw';
import { STROKE_LAYER } from './strokes/instance';
import { SKY_RINGS_INCLUDE, spliceGlsl } from './strokes/material';

/** Transparent, so three draws it after every opaque stroke, and before the vignette and HUD. */
export const SKY_HALO_RENDER_ORDER = 0;
/** Sides of each halo's polygons: an octagon round the unit disc fills 17% less than a square. */
export const SKY_HALO_SIDES = 8;
/** An outer corner's distance for a unit inscribed circle: 1 / cos(π / sides). */
export const SKY_HALO_CORNER = 1 / Math.cos(Math.PI / SKY_HALO_SIDES);

/**
 * The halo's ring of SKY_HALO_SIDES quads: the first SKY_HALO_SIDES vertices are the hole's corners,
 * unit directions with z 0, so the hole sits inside the radius the vertex shader scales them to;
 * the rest are the outer corners, with z 1, whose octagon has the unit inscribed circle. A star's
 * hole has radius 0, so its quads fold into a fan and their other halves cover nothing.
 */
export function skyHaloRing(): { position: Float32Array; index: Uint16Array } {
  const n = SKY_HALO_SIDES;
  const position = new Float32Array(2 * n * 3);
  for (let k = 0; k < n; k++) {
    const a = ((k + 0.5) * 2 * Math.PI) / n;
    position.set([Math.cos(a), Math.sin(a), 0], k * 3);
    position.set([SKY_HALO_CORNER * Math.cos(a), SKY_HALO_CORNER * Math.sin(a), 1], (n + k) * 3);
  }
  const index = new Uint16Array(n * 6);
  for (let k = 0; k < n; k++) {
    const next = (k + 1) % n;
    index.set([k, n + k, n + next, k, n + next, next], k * 6);
  }
  return { position, index };
}

export type SkyHaloMaterial = RawShaderMaterial & { uniforms: MotionUniforms };

export interface SkyHalo {
  readonly mesh: Mesh<InstancedBufferGeometry, SkyHaloMaterial>;
  /** The TS mirror's state of every halo for the clock's current uniforms, in SKY_RINGS order. */
  state(): SkyHaloState[];
  dispose(): void;
}

export function createSkyHaloMaterial(): SkyHaloMaterial {
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: spliceGlsl(vertexShader, SKY_RINGS_INCLUDE, skyRingsShader),
    fragmentShader: spliceGlsl(fragmentShader, SKY_RINGS_INCLUDE, skyRingsShader),
    uniforms: { ...motionClock.uniforms },
    defines: {
      ...skyHaloGlslDefines(),
      STROKE_LAYER_STAR: `${STROKE_LAYER.star}u`,
      STROKE_LAYER_MOON: `${STROKE_LAYER.moon}u`,
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: DoubleSide,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneFactor,
  });
  material.name = 'sky-halo';
  return material as SkyHaloMaterial;
}

export function createSkyHalo(): SkyHalo {
  const geometry = new InstancedBufferGeometry();
  const ring = skyHaloRing();
  geometry.setAttribute('position', new BufferAttribute(ring.position, 3));
  geometry.setIndex(new BufferAttribute(ring.index, 1));
  geometry.instanceCount = SKY_RINGS.length;
  const material = createSkyHaloMaterial();
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky-halo';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = SKY_HALO_RENDER_ORDER;
  const uniforms = motionClock.uniforms;
  return {
    mesh,
    state() {
      const mask = uniforms.uMotionLayers.value;
      const calm = uniforms.uCalm.value;
      return SKY_RINGS.map((ring, k) => {
        const layer = k === SKY_MOON_RING ? STROKE_LAYER.moon : STROKE_LAYER.star;
        return skyHaloState(ring, uniforms.uTime.value, motionGate(mask, layer) ? calm : 0);
      });
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
