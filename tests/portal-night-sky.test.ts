/**
 * The portal's painted night sky (night-sky.ts): its size over a transition's veil, its calm
 * scaling, its field and its comfort bounds, and its one mesh.
 */
import { DataTexture, Group, type InstancedBufferAttribute, NoBlending, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { FLY_RENDER_ORDER } from '../src/portal/fly-strokes.ts';
import {
  createNightSky,
  createSkyField,
  SKY_COUNT,
  SKY_FULL_AT_VEIL,
  SKY_RADIUS,
  SKY_RENDER_ORDER,
  SKY_STAR_DABS,
  SKY_STARS,
  SKY_VEIL_COLOR,
  skyFrame,
  skyGrow,
  skyMotionRate,
} from '../src/portal/night-sky.ts';
import {
  createTransition,
  type TransitionFrame,
  type TransitionStyle,
  veilAt,
} from '../src/portal/transition.ts';
import { VIGNETTE_RENDER_ORDER } from '../src/ui/vignette.ts';

/** Every frame of a transition of `style` at 60 Hz with a 1 s wait: veil and sky size. */
function sweep(style: TransitionStyle): { frame: TransitionFrame; veil: number; grow: number }[] {
  const t = createTransition();
  t.request('entering', 'starry-night', style);
  const out: { frame: TransitionFrame; veil: number; grow: number }[] = [];
  for (let i = 0; i < 1000; i++) {
    if (i === 120) t.ready();
    const frame = t.advance(1 / 60);
    if (!frame) break;
    const veil = veilAt(frame, style);
    out.push({ frame, veil, grow: frame.phase === 'done' ? 0 : skyGrow(veil) });
    if (frame.phase === 'done') break;
  }
  return out;
}

/** Each stroke's angular velocity about the eye between `time` and `time + dt`, rad/s, xyz. */
function angularVelocities(time: number, dt = 1e-3): Float32Array {
  const field = createSkyField();
  const a = new Float32Array(field.count * 3);
  const b = new Float32Array(field.count * 3);
  const axes = new Float32Array(field.count * 3);
  const sizes = new Float32Array(field.count * 2);
  skyFrame(field, time, 1, a, axes, sizes);
  skyFrame(field, time + dt, 1, b, axes, sizes);
  const w = new Float32Array(field.count * 3);
  const p = new Vector3();
  const v = new Vector3();
  for (let i = 0; i < field.count; i++) {
    p.fromArray(a, i * 3);
    v.fromArray(b, i * 3)
      .sub(p)
      .divideScalar(dt);
    p.cross(v).divideScalar(SKY_RADIUS * SKY_RADIUS);
    p.toArray(w, i * 3);
  }
  return w;
}

describe('the sky over a transition', () => {
  test('grows in ahead of the veil, whole from SKY_FULL_AT_VEIL, and gone at 0', () => {
    expect(skyGrow(0)).toBe(0);
    expect(skyGrow(-1)).toBe(0);
    expect(skyGrow(SKY_FULL_AT_VEIL)).toBe(1);
    expect(skyGrow(1)).toBe(1);
    let last = 0;
    for (let v = 0; v <= 1.0001; v += 0.01) {
      const g = skyGrow(v);
      expect(g).toBeGreaterThanOrEqual(last);
      // Ahead of the veil: the brushwork covers the old world as it fades.
      expect(g).toBeGreaterThanOrEqual(Math.min(1, v) - 1e-9);
      last = g;
    }
  });

  for (const style of ['fly', 'fade'] as const) {
    test(`${style}: whole through the wait, rising through out, falling through in, 0 when done`, () => {
      const frames = sweep(style);
      const by = (phase: string) => frames.filter((f) => f.frame.phase === phase);
      expect(by('wait').length).toBeGreaterThan(30);
      for (const f of by('wait')) {
        expect(f.veil).toBe(1);
        expect(f.grow).toBe(1);
      }
      const out = by('out');
      for (let i = 1; i < out.length; i++)
        expect(out[i].grow).toBeGreaterThanOrEqual(out[i - 1].grow);
      expect(out.at(-1)?.grow).toBe(1);
      const into = by('in');
      for (let i = 1; i < into.length; i++) {
        expect(into[i].grow).toBeLessThanOrEqual(into[i - 1].grow);
      }
      // The fade's last `in` frame leaves a sliver of veil; the `done` frame hides it.
      expect(into.at(-1)?.grow ?? 1).toBeLessThan(0.05);
      expect(frames.at(-1)?.frame.phase).toBe('done');
      expect(frames.at(-1)?.grow).toBe(0);
      // Never a fully veiled frame without the sky over it.
      for (const f of frames) if (f.veil >= SKY_FULL_AT_VEIL) expect(f.grow).toBe(1);
    });
  }
});

describe('the sky’s calm scaling', () => {
  test('calm 0 holds it still, 1 is full speed, and the rate clamps', () => {
    expect(skyMotionRate(0)).toBe(0);
    expect(skyMotionRate(0.2)).toBeCloseTo(0.2, 9);
    expect(skyMotionRate(1)).toBe(1);
    expect(skyMotionRate(2)).toBe(1);
    expect(skyMotionRate(-1)).toBe(0);
    expect(skyMotionRate(Number.NaN)).toBe(0);
  });

  test('at calm 0 no stroke moves however long the wait; at calm 1 the swirls do', () => {
    const field = createSkyField();
    const rest = new Float32Array(field.count * 3);
    const later = new Float32Array(field.count * 3);
    const axes = new Float32Array(field.count * 3);
    const sizes = new Float32Array(field.count * 2);
    const restSizes = new Float32Array(field.count * 2);
    skyFrame(field, 0, 1, rest, axes, restSizes);
    // The caller's clock advances by dt × skyMotionRate(calm).
    let time = 0;
    for (let i = 0; i < 600; i++) time += (1 / 60) * skyMotionRate(0);
    skyFrame(field, time, 1, later, axes, sizes);
    expect(later).toEqual(rest);
    expect(sizes).toEqual(restSizes);
    skyFrame(field, 3, 1, later, axes, sizes);
    let moving = 0;
    for (let i = 0; i < field.count; i++) {
      const d = Math.hypot(
        later[i * 3] - rest[i * 3],
        later[i * 3 + 1] - rest[i * 3 + 1],
        later[i * 3 + 2] - rest[i * 3 + 2],
      );
      if (d > 1e-3) moving++;
    }
    expect(moving).toBeGreaterThan(1000);
  });
});

describe('the sky’s field', () => {
  test('a few thousand strokes on the sphere about the eye, the same for the same seed', () => {
    const field = createSkyField();
    expect(field.count).toBe(SKY_COUNT);
    expect(SKY_COUNT).toBeLessThanOrEqual(3000);
    expect(createSkyField().base).toEqual(field.base);
    const positions = new Float32Array(field.count * 3);
    const axes = new Float32Array(field.count * 3);
    const sizes = new Float32Array(field.count * 2);
    for (const time of [0, 7.3, 60]) {
      skyFrame(field, time, 1, positions, axes, sizes);
      for (let i = 0; i < field.count; i++) {
        const p = new Vector3().fromArray(positions, i * 3);
        expect(p.length()).toBeCloseTo(SKY_RADIUS, 2);
        // Each long axis lies in the sphere's tangent plane, so the stroke lies flat on it.
        const a = new Vector3().fromArray(axes, i * 3);
        expect(a.length()).toBeGreaterThan(0);
        expect(Math.abs(a.normalize().dot(p.normalize()))).toBeLessThan(1e-3);
      }
    }
  });

  test('deep blues and ultramarine, with a few warm yellow star dabs', () => {
    const { colors, count } = createSkyField();
    let yellow = 0;
    for (let i = 0; i < count; i++) {
      const [r, g, b] = [colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]];
      if (r > b) {
        yellow++;
        expect(g).toBeGreaterThan(b);
      } else {
        expect(b).toBeGreaterThan(r);
        expect(b).toBeGreaterThanOrEqual(g);
      }
    }
    expect(yellow).toBe(SKY_STARS * SKY_STAR_DABS);
    // The veil under it is its deepest blue.
    const [r, g, b] = SKY_VEIL_COLOR;
    expect(b).toBeGreaterThan(Math.max(r, g));
  });

  test('comfort: slow swirls, and the field never turns as a whole', () => {
    for (const time of [0, 5, 20]) {
      const w = angularVelocities(time);
      let fastest = 0;
      const mean = new Vector3();
      const one = new Vector3();
      for (let i = 0; i < w.length / 3; i++) {
        one.fromArray(w, i * 3);
        fastest = Math.max(fastest, one.length());
        mean.add(one);
      }
      mean.divideScalar(w.length / 3);
      // No stroke crosses the view faster than 3°/s at calm 1.
      expect((fastest * 180) / Math.PI).toBeLessThan(3);
      // The whole field's turn is a small share of its fastest stroke's.
      expect(mean.length()).toBeLessThan(0.1 * fastest);
    }
  });
});

describe('the sky’s mesh', () => {
  test('one transparent stroke mesh under the rig, between the veil and the fly strokes', () => {
    const rig = new Group();
    const sky = createNightSky(rig, new DataTexture(new Uint8Array(4), 1, 1));
    expect(sky.mesh.parent).toBe(rig);
    expect(sky.mesh.name).toBe('portal-sky');
    expect(sky.mesh.visible).toBe(false);
    expect(sky.mesh.geometry.instanceCount).toBe(SKY_COUNT);
    expect(VIGNETTE_RENDER_ORDER).toBeLessThan(SKY_RENDER_ORDER);
    expect(SKY_RENDER_ORDER).toBeLessThan(FLY_RENDER_ORDER);
    expect(sky.mesh.renderOrder).toBe(SKY_RENDER_ORDER);
    const material = sky.mesh.material;
    expect(material.transparent).toBe(true);
    expect(material.blending).toBe(NoBlending);
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
  });

  test('draws centred on the eye, hides at 0 and uploads nothing when nothing changed', () => {
    const rig = new Group();
    const sky = createNightSky(rig, new DataTexture(new Uint8Array(4), 1, 1));
    const position = sky.mesh.geometry.getAttribute('iPosition') as InstancedBufferAttribute;
    const tangent = sky.mesh.geometry.getAttribute('iTangent') as InstancedBufferAttribute;
    sky.draw(1, 2, [0.1, 1.6, -0.2]);
    expect(sky.mesh.visible).toBe(true);
    expect(sky.mesh.position.toArray()).toEqual([0.1, 1.6, -0.2]);
    const versions = [position.version, tangent.version];
    sky.draw(1, 2, [0.1, 1.6, -0.2]);
    expect([position.version, tangent.version]).toEqual(versions);
    sky.draw(1, 2.5, [0.1, 1.6, -0.2]);
    expect(position.version).toBeGreaterThan(versions[0]);
    expect(tangent.version).toBeGreaterThan(versions[1]);
    sky.draw(0, 3, [0, 1.6, 0]);
    expect(sky.mesh.visible).toBe(false);
    sky.draw(0.5, 3, [0, 1.6, 0]);
    expect(sky.mesh.visible).toBe(true);
    sky.mesh.quaternion.set(0, 1, 0, 0);
    sky.reset();
    expect(sky.mesh.visible).toBe(false);
    expect(sky.mesh.quaternion.w).toBe(1);
    // Warm: shown, every quad far under a pixel at 20 m.
    sky.warm([0, 1.6, 0]);
    expect(sky.mesh.visible).toBe(true);
    const size = sky.mesh.geometry.getAttribute('iSize').array as Float32Array;
    expect(Math.max(...size)).toBeLessThan(1e-3);
    sky.dispose();
    expect(sky.mesh.parent).toBeNull();
  });
});
