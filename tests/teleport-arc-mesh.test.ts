import { DataTexture, type InstancedBufferAttribute, IntType, Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { strokeShade } from '../src/demo/canvas/placement';
import {
  ARC_CAPACITY,
  ARC_INVALID_COLOR,
  ARC_START,
  ARC_VALID_COLOR,
  createArcMesh,
  RING_LIFT,
  RING_RADIUS,
  RING_STROKES,
} from '../src/locomotion/arc-mesh';
import {
  createArcResult,
  FLAT_WORLD,
  type LandingWorld,
  MAX_SAMPLES,
  traceArc,
} from '../src/locomotion/teleport';
import { BRUSHES } from '../src/render/strokes/brush-atlas-data';
import { DEPTH_TIE_BREAK_FRONT_FLAG } from '../src/render/strokes/depth-tie-break';
import { strokeAxes, type Vec3 } from '../src/render/strokes/frame';
import {
  createStrokeBuffers,
  STROKE_ATTRIBUTES,
  type StrokeInstance,
  unpackInstance,
} from '../src/render/strokes/instance';

/** The camera's near plane in main.ts. */
const NEAR = 0.1;
const ORIGIN: Vec3 = [0.25, 1.4, -0.4];
const EYE: Vec3 = [0, 1.6, 0];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

function aimAt(direction: Vec3, world: LandingWorld = FLAT_WORLD) {
  const aim = createArcResult();
  traceArc(aim, ORIGIN, direction, world);
  return aim;
}

function setup() {
  const parent = new Object3D();
  const atlas = new DataTexture(new Uint8Array(4), 1, 1);
  const arc = createArcMesh(parent, atlas);
  /** The drawn instances, read back the way the GPU decodes them. */
  const instances = (): StrokeInstance[] => {
    const geometry = arc.mesh.geometry;
    const n = geometry.instanceCount;
    const buffers = createStrokeBuffers(n);
    for (const spec of STROKE_ATTRIBUTES) {
      const source = geometry.getAttribute(spec.name).array as ArrayLike<number>;
      const target = buffers[spec.key];
      for (let i = 0; i < n * spec.itemSize; i += 1) target[i] = source[i] as number;
    }
    return Array.from({ length: n }, (_, i) => unpackInstance(buffers, i));
  };
  return { parent, atlas, arc, instances };
}

/** The four quad corners of a stroke, as stroke.vert.glsl places them (size multiplier 1). */
function corners(s: StrokeInstance): Vec3[] {
  const { long, short } = strokeAxes(s.normal, s.tangent);
  return [-0.5, 0.5].flatMap((x) =>
    [-0.5, 0.5].map(
      (y) =>
        [0, 1, 2].map(
          (k) =>
            (s.position[k] as number) +
            (long[k] as number) * x * s.size[0] +
            (short[k] as number) * y * s.size[1],
        ) as unknown as Vec3,
    ),
  );
}

const isRing = (s: StrokeInstance): boolean => ((s.flags ?? 0) & DEPTH_TIE_BREAK_FRONT_FLAG) !== 0;

/**
 * The colour is pre-divided by the moon shade, so the shader's shading gives back the stated
 * colour, except where the division passes 255 and the byte clamps.
 */
function expectShadedColor(s: StrokeInstance, rgb: readonly [number, number, number]): void {
  const shade = strokeShade(s.normal);
  for (let k = 0; k < 3; k += 1) {
    const expected = Math.min(255, (rgb[k] as number) / shade);
    expect(Math.abs((s.color[k] as number) - expected)).toBeLessThanOrEqual(0.5 + 1e-9);
  }
}

describe('the arc mesh', () => {
  it('is one hidden mesh on the stroke material and the given atlas, never culled by three', () => {
    const { parent, atlas, arc } = setup();
    expect(arc.mesh.parent).toBe(parent);
    expect(arc.mesh.visible).toBe(false);
    expect(arc.mesh.geometry.instanceCount).toBe(0);
    expect(arc.mesh.frustumCulled).toBe(false);
    expect(arc.mesh.material.uniforms.uAtlas.value).toBe(atlas);
    expect(arc.mesh.material.alphaToCoverage).toBe(true);
    const meta = arc.mesh.geometry.getAttribute('iMeta') as unknown as { gpuType: number };
    expect(meta.gpuType).toBe(IntType);
    expect(ARC_CAPACITY).toBeGreaterThanOrEqual(MAX_SAMPLES - 1 + RING_STROKES);
  });

  it('draws a valid aim in warm yellow, with a ring of strokes on the ground round the hit', () => {
    const { arc, instances } = setup();
    const aim = aimAt([0, 0.3, -1]);
    expect(aim.valid).toBe(true);
    arc.show(aim, EYE);
    expect(arc.mesh.visible).toBe(true);
    const all = instances();
    const ring = all.filter(isRing);
    expect(ring).toHaveLength(RING_STROKES);
    const hit = aim.hit as Vec3;
    for (const s of ring) {
      const offset = sub(s.position, hit);
      expect(offset[1]).toBeCloseTo(RING_LIFT, 6);
      expect(Math.hypot(offset[0], offset[2])).toBeCloseTo(RING_RADIUS, 6);
      expect(s.normal[1]).toBeCloseTo(1, 4);
    }
    for (const s of all) {
      expectShadedColor(s, ARC_VALID_COLOR);
      expect(['ridge', 'bristle']).toContain(BRUSHES[s.brush]?.kind);
    }
  });

  it('draws an invalid aim in red-grey with no ring', () => {
    const { arc, instances } = setup();
    const aim = aimAt([0, 0.3, -1], { ground: FLAT_WORLD.ground, blocked: () => true });
    expect(aim.reason).toBe('footprint');
    arc.show(aim, EYE);
    const all = instances();
    expect(all.length).toBeGreaterThan(5);
    expect(all.some(isRing)).toBe(false);
    for (const s of all) expectShadedColor(s, ARC_INVALID_COLOR);
    // Desaturated and reddish: red leads, and the channels sit close together.
    const [r, g, b] = ARC_INVALID_COLOR;
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
    expect(r - Math.min(g, b)).toBeLessThan(0.3 * r);
  });

  it('runs its strokes along the arc, facing the eye, from past the near plane', () => {
    const { arc, instances } = setup();
    const aim = aimAt([0, 0.2, -1]);
    arc.show(aim, EYE);
    const strokes = instances().filter((s) => !isRing(s));
    expect(strokes.length).toBeGreaterThan(10);
    expect(strokes.length).toBeLessThanOrEqual(aim.count - 1);
    for (const s of strokes) {
      const toEye = sub(EYE, s.position);
      expect(dot(s.normal, toEye)).toBeGreaterThan(0);
      for (const corner of corners(s)) {
        expect(len(sub(corner, ORIGIN))).toBeGreaterThan(0.15);
        expect(len(sub(corner, EYE))).toBeGreaterThan(NEAR);
      }
    }
    // The first stroke starts ARC_START along: none centres inside it.
    const nearest = Math.min(...strokes.map((s) => len(sub(s.position, ORIGIN))));
    expect(nearest).toBeGreaterThan(ARC_START);
    // Each long axis follows the arc: it is parallel to the chord to the stroke's nearest sample.
    for (const s of strokes) {
      const { long } = strokeAxes(s.normal, s.tangent);
      let best = Number.POSITIVE_INFINITY;
      let alignment = 0;
      for (let i = 0; i + 1 < aim.count; i += 1) {
        const p0: Vec3 = [aim.points[i * 3], aim.points[i * 3 + 1], aim.points[i * 3 + 2]] as Vec3;
        const p1: Vec3 = [
          aim.points[i * 3 + 3],
          aim.points[i * 3 + 4],
          aim.points[i * 3 + 5],
        ] as Vec3;
        const mid: Vec3 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
        const d = len(sub(mid, s.position));
        if (d < best) {
          best = d;
          const chord = sub(p1, p0);
          alignment = Math.abs(dot(long, chord)) / len(chord);
        }
      }
      expect(alignment).toBeGreaterThan(0.999);
    }
  });

  it('draws an arc with no landing, and hides at once on hide()', () => {
    const { arc, instances } = setup();
    const pit: LandingWorld = { ground: { heightAt: () => -1000, normalAt: () => [0, 1, 0] } };
    const aim = aimAt([0, 0, -1], pit);
    expect(aim.hit).toBeNull();
    arc.show(aim, EYE);
    expect(instances().length).toBeGreaterThan(MAX_SAMPLES / 2);
    expect(instances().some(isRing)).toBe(false);
    expect(arc.mesh.geometry.instanceCount).toBeLessThanOrEqual(ARC_CAPACITY);
    arc.hide();
    expect(arc.mesh.visible).toBe(false);
  });

  it('a later show rewrites the strokes and asks for an upload', () => {
    const { arc } = setup();
    const position = arc.mesh.geometry.getAttribute('iPosition') as InstancedBufferAttribute;
    const version = position.version;
    arc.show(aimAt([0, 0.3, -1]), EYE);
    expect(position.version).toBeGreaterThan(version);
  });

  it('dispose detaches it', () => {
    const { parent, arc } = setup();
    arc.dispose();
    expect(arc.mesh.parent).toBeNull();
    expect(parent.children).toHaveLength(0);
  });
});
