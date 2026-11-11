import { MeshBasicMaterial, ShaderChunk, ShaderLib, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';
import { MOTION_LAYER_MASK, REACTIVE_MOTION_BIT } from '../src/motion/layers';
import { HAND_RADIUS } from '../src/motion/reactive';
import { coverCrop, HANGINGS, type Hanging } from '../src/paintings/gallery/layout';
import {
  type ContactTarget,
  contactAt,
  contactStrength,
  createGalleryRipple,
  easeStrength,
  RIPPLE_BEHIND,
  RIPPLE_FALL_S,
  RIPPLE_MARGIN,
  RIPPLE_PROGRAM_KEY,
  RIPPLE_RADIUS,
  RIPPLE_REACH,
  RIPPLE_RETARGET_M,
  RIPPLE_RING_PERIOD_S,
  RIPPLE_RISE_S,
  RIPPLE_SWIRL_PERIOD_S,
  RIPPLE_TIME_WRAP_S,
  type RippleUniforms,
  rippleMapFragment,
  rippleRadius,
  rippleWarp,
  scanFrame,
  shapeStrength,
  spliceRipple,
  type WarpContact,
} from '../src/paintings/gallery/ripple';
import type { HandRippleFrame } from '../src/paintings/hand-ripple';
import { rippleAmplitude } from '../src/paintings/hand-ripple';

const starry = HANGINGS.find((h) => h.painting.id === 'starry-night') as Hanging;
const chestnut = HANGINGS.find((h) => h.painting.id === 'chestnut-trees-in-blossom') as Hanging;
/** The Starry Night scan is 1024 × 811, cropped to the painting's aspect. */
const CROP = coverCrop(1024, 811, starry.width, starry.height);
const METRES: [number, number] = [
  starry.width / (CROP.u1 - CROP.u0),
  starry.height / (CROP.v1 - CROP.v0),
];

/** The world point at canvas uv (u, v), `out` metres in front of the scan of `h`. */
function pointOn(h: Hanging, u: number, v: number, out: number): [number, number, number] {
  const f = scanFrame(h);
  const x = (u - 0.5) * f.width;
  const y = (v - 0.5) * f.height;
  return [
    f.centre[0] + f.right[0] * x + f.normal[0] * out,
    f.centre[1] + y,
    f.centre[2] + f.right[2] * x + f.normal[2] * out,
  ];
}

const touch = (h: Hanging, p: [number, number, number]): ContactTarget | null => {
  const out: ContactTarget = { u: 0, v: 0, strength: 0 };
  return contactAt(scanFrame(h), p[0], p[1], p[2], out) ? out : null;
};

describe('the ripple contact', () => {
  it('is the hand orbs reach in front and a little behind the plane', () => {
    expect(RIPPLE_REACH).toBe(HAND_RADIUS);
    expect(touch(starry, pointOn(starry, 0.5, 0.5, 0.02))).not.toBeNull();
    expect(touch(starry, pointOn(starry, 0.5, 0.5, RIPPLE_REACH - 1e-4))).not.toBeNull();
    expect(touch(starry, pointOn(starry, 0.5, 0.5, RIPPLE_REACH + 1e-4))).toBeNull();
    expect(touch(starry, pointOn(starry, 0.5, 0.5, -RIPPLE_BEHIND + 1e-4))).not.toBeNull();
    expect(touch(starry, pointOn(starry, 0.5, 0.5, -RIPPLE_BEHIND - 1e-4))).toBeNull();
  });

  it('falls inside the scan plus its margin, and maps to canvas uv with v up', () => {
    const c = touch(starry, pointOn(starry, 0.25, 0.8, 0.01)) as ContactTarget;
    expect(c.u).toBeCloseTo(0.25, 9);
    expect(c.v).toBeCloseTo(0.8, 9);
    const marginU = RIPPLE_MARGIN / starry.width;
    expect(touch(starry, pointOn(starry, 1 + marginU * 0.9, 0.5, 0.01))).not.toBeNull();
    expect(touch(starry, pointOn(starry, 1 + marginU * 1.1, 0.5, 0.01))).toBeNull();
    const marginV = RIPPLE_MARGIN / starry.height;
    expect(touch(starry, pointOn(starry, 0.5, -marginV * 1.1, 0.01))).toBeNull();
    // In the margin the uv clamps onto the edge.
    expect((touch(starry, pointOn(starry, -marginU * 0.5, 0.5, 0.01)) as ContactTarget).u).toBe(0);
  });

  it('works on a side wall, whose right axis is not +X', () => {
    const c = touch(chestnut, pointOn(chestnut, 0.7, 0.3, 0.05)) as ContactTarget;
    expect(c.u).toBeCloseTo(0.7, 9);
    expect(c.v).toBeCloseTo(0.3, 9);
    // The Starry Night plane says nothing about a hand at the chestnut.
    expect(touch(starry, pointOn(chestnut, 0.5, 0.5, 0))).toBeNull();
  });

  it('has strength 1 at and behind the surface, falling smoothly to 0 at the reach', () => {
    expect(contactStrength(0)).toBe(1);
    expect(contactStrength(-0.03)).toBe(1);
    expect(contactStrength(RIPPLE_REACH)).toBe(0);
    let last = 1;
    for (let d = 0.005; d < RIPPLE_REACH; d += 0.005) {
      const s = contactStrength(d);
      expect(s).toBeLessThan(last);
      expect(s).toBeGreaterThan(0);
      last = s;
    }
    // Flat at both ends: a millimetre off the surface or the reach barely changes it.
    expect(1 - contactStrength(0.001)).toBeLessThan(1e-3);
    expect(contactStrength(RIPPLE_REACH - 0.001)).toBeLessThan(1e-3);
  });
});

describe('the ease', () => {
  it('rises in RIPPLE_RISE_S and falls to exactly 0 in RIPPLE_FALL_S', () => {
    const dt = 1 / 72;
    let e = 0;
    let t = 0;
    while (e < 1) {
      e = easeStrength(e, 1, dt);
      t += dt;
    }
    expect(t).toBeLessThanOrEqual(RIPPLE_RISE_S + dt);
    t = 0;
    while (e > 0) {
      e = easeStrength(e, 0, dt);
      t += dt;
    }
    expect(e).toBe(0);
    expect(t).toBeLessThanOrEqual(RIPPLE_FALL_S + dt);
    expect(t).toBeGreaterThan(RIPPLE_FALL_S - dt);
  });

  it('never overshoots its target, and the shape is a smoothstep from exactly 0 to 1', () => {
    expect(easeStrength(0.5, 0.52, 0.1)).toBe(0.52);
    expect(easeStrength(0.5, 0.48, 0.1)).toBe(0.48);
    expect(easeStrength(0.3, 0.3, 0.1)).toBe(0.3);
    expect(shapeStrength(0)).toBe(0);
    expect(shapeStrength(1)).toBe(1);
    expect(shapeStrength(0.5)).toBe(0.5);
  });
});

describe('the gate', () => {
  it('follows the reactive gate: ?noanim, calm 0 or a mask without the reactive bit shut it', () => {
    expect(rippleAmplitude(false, 1, MOTION_LAYER_MASK)).toBe(1);
    expect(rippleAmplitude(false, 0.4, MOTION_LAYER_MASK)).toBe(0.4);
    expect(rippleAmplitude(false, 2, MOTION_LAYER_MASK)).toBe(1);
    expect(rippleAmplitude(true, 1, MOTION_LAYER_MASK)).toBe(0);
    expect(rippleAmplitude(false, 0, MOTION_LAYER_MASK)).toBe(0);
    expect(rippleAmplitude(false, 1, MOTION_LAYER_MASK & ~REACTIVE_MOTION_BIT)).toBe(0);
    expect(rippleAmplitude(false, 1, REACTIVE_MOTION_BIT)).toBe(1);
  });
});

describe('the warp mirror', () => {
  const centre = { u: (CROP.u0 + CROP.u1) / 2, v: 0.5 };
  const full: WarpContact = { ...centre, strength: 1, radius: RIPPLE_RADIUS };
  const out: [number, number] = [0, 0];

  it('returns the uv itself at zero strength, outside the radius and with no contact', () => {
    for (let i = 0; i < 200; i++) {
      const u = CROP.u0 + ((i * 0.618) % 1) * (CROP.u1 - CROP.u0);
      const v = (i * 0.414) % 1;
      for (const contacts of [[], [{ ...full, strength: 0 }], [{ ...full, strength: -0 }]]) {
        expect(rippleWarp(u, v, contacts, CROP, METRES, 1.3, out)).toBe(0);
        expect(out[0]).toBe(u);
        expect(out[1]).toBe(v);
      }
    }
    // Just outside the radius of a full contact.
    const u = centre.u + (RIPPLE_RADIUS * 1.0001) / METRES[0];
    rippleWarp(u, centre.v, [full], CROP, METRES, 0.7, out);
    expect(out).toEqual([u, centre.v]);
  });

  it('moves the paint inside the radius by a few centimetres at most, inside the crop', () => {
    let largest = 0;
    let moved = 0;
    for (let iy = -40; iy <= 40; iy++) {
      for (let ix = -40; ix <= 40; ix++) {
        const u = centre.u + (ix / 40) * (RIPPLE_RADIUS / METRES[0]);
        const v = centre.v + (iy / 40) * (RIPPLE_RADIUS / METRES[1]);
        for (const time of [0, 0.37, 1.1, 2.0]) {
          rippleWarp(u, v, [full], CROP, METRES, time, out);
          const shift = Math.hypot((out[0] - u) * METRES[0], (out[1] - v) * METRES[1]);
          largest = Math.max(largest, shift);
          if (shift > 1e-4) moved++;
          expect(out[0]).toBeGreaterThanOrEqual(CROP.u0);
          expect(out[0]).toBeLessThanOrEqual(CROP.u1);
          expect(Number.isFinite(out[1])).toBe(true);
        }
      }
    }
    expect(moved).toBeGreaterThan(1000);
    expect(largest).toBeGreaterThan(0.01);
    expect(largest).toBeLessThan(0.05);
  });

  it('is continuous at the centre and holds the scan edge still', () => {
    rippleWarp(full.u, full.v, [full], CROP, METRES, 0.5, out);
    expect(Math.hypot(out[0] - full.u, out[1] - full.v)).toBeLessThan(1e-9);
    // A contact on the left edge: the edge texels sample themselves.
    const edge: WarpContact = { u: CROP.u0, v: 0.5, strength: 1, radius: RIPPLE_RADIUS };
    for (const v of [0.4, 0.45, 0.5, 0.55, 0.6]) {
      rippleWarp(CROP.u0, v, [edge], CROP, METRES, 0.9, out);
      expect(out[0]).toBe(CROP.u0);
      expect(out[1]).toBeCloseTo(v, 12);
    }
  });

  it('wraps its time on a whole number of both periods', () => {
    const rings = RIPPLE_TIME_WRAP_S / RIPPLE_RING_PERIOD_S;
    const swirls = RIPPLE_TIME_WRAP_S / RIPPLE_SWIRL_PERIOD_S;
    expect(Math.abs(rings - Math.round(rings))).toBeLessThan(1e-9);
    expect(Math.abs(swirls - Math.round(swirls))).toBeLessThan(1e-9);
    const a: [number, number] = [0, 0];
    const b: [number, number] = [0, 0];
    const u = full.u + 0.1 / METRES[0];
    rippleWarp(u, 0.5, [full], CROP, METRES, 0.2, a);
    rippleWarp(u, 0.5, [full], CROP, METRES, 0.2 + RIPPLE_TIME_WRAP_S, b);
    expect(a[0]).toBeCloseTo(b[0], 9);
    expect(a[1]).toBeCloseTo(b[1], 9);
  });

  it('opens its radius as the strength grows', () => {
    expect(rippleRadius(1)).toBe(RIPPLE_RADIUS);
    expect(rippleRadius(0)).toBeLessThan(RIPPLE_RADIUS);
    expect(rippleRadius(0)).toBeGreaterThan(0);
  });
});

describe('the scan material', () => {
  it("keeps three's own map_fragment chunk, with only its sample coordinate warped", () => {
    // Fails when three's chunk no longer samples the map once at vMapUv.
    expect(ShaderChunk.map_fragment.split('texture2D( map, vMapUv )')).toHaveLength(2);
    const spliced = rippleMapFragment(ShaderChunk.map_fragment);
    expect(spliced).toContain(
      ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', 'texture2D( map, rippleUv )'),
    );
    expect(spliced).toContain('DECODE_VIDEO_TEXTURE');
    expect(spliced).not.toContain('texture2D( map, vMapUv )');
    expect(spliced.indexOf('galleryRipple( vMapUv')).toBeLessThan(spliced.indexOf('rippleUv )'));
    expect(() => rippleMapFragment('vec4 c = texture2D( map, uv );')).toThrow(/vMapUv/);
  });

  it('splices the warp into map_fragment, behind one fixed program key', () => {
    const source = spliceRipple(ShaderLib.basic.fragmentShader);
    expect(source).not.toContain('#include <map_fragment>');
    expect(source).toContain('vec2 galleryRipple(vec2 uv, inout float glow)');
    expect(source).toContain('texture2D( map, rippleUv )');
    expect(source).toContain('#define RIPPLE_SWIRL ');
    expect(source.indexOf('galleryRipple(vec2')).toBeLessThan(source.indexOf('void main()'));
    expect(() => spliceRipple('void main() {}')).toThrow(/map_fragment/);
  });

  it('patches only the material it is given, with uniforms the runtime owns', () => {
    const material = new MeshBasicMaterial();
    const plain = new MeshBasicMaterial();
    const ripple = createGalleryRipple(starry, CROP, material);
    expect(material.customProgramCacheKey()).toBe(RIPPLE_PROGRAM_KEY);
    expect(plain.customProgramCacheKey()).not.toBe(RIPPLE_PROGRAM_KEY);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      fragmentShader: ShaderLib.basic.fragmentShader,
      vertexShader: ShaderLib.basic.vertexShader,
    };
    material.onBeforeCompile(shader as never, undefined as never);
    expect(shader.uniforms.uRipple).toBe(ripple.uniforms.uRipple);
    expect(shader.uniforms.uRippleTime).toBe(ripple.uniforms.uRippleTime);
  });
});

describe('the ripple runtime', () => {
  const disturbers = [new Vector4(0, 1.6, 0, 1), new Vector4(), new Vector4()];
  const base = (): HandRippleFrame & { -readonly [K in keyof HandRippleFrame]: unknown } => ({
    presenting: true,
    enabled: true,
    busy: false,
    amplitude: 1,
    disturbers,
    slots: [1, 2],
    dt: 1 / 72,
  });
  const place = (slot: 1 | 2, p: [number, number, number] | null): void => {
    const d = disturbers[slot] as Vector4;
    if (p) d.set(p[0], p[1], p[2], 1);
    else d.set(0, -60, 0, 0);
  };
  const run = (
    ripple: ReturnType<typeof createGalleryRipple>,
    state: HandRippleFrame,
    seconds: number,
  ): void => {
    for (let t = 0; t < seconds; t += state.dt) ripple.frame(state);
  };
  const uniformsOf = (u: RippleUniforms): Vector4[] => u.uRipple.value;

  it('ripples under the right hand at the surface, then settles to exactly 0', () => {
    const ripple = createGalleryRipple(starry, CROP, new MeshBasicMaterial());
    const state = base();
    place(1, null);
    place(2, pointOn(starry, 0.3, 0.6, 0.02));
    run(ripple, state, 0.3);
    const d = ripple.diag();
    expect(d.contacts[0]).toBeNull();
    expect(d.contacts[1]?.uv[0]).toBeCloseTo(0.3, 9);
    expect(d.contacts[1]?.uv[1]).toBeCloseTo(0.6, 9);
    expect(d.contacts[1]?.strength).toBeGreaterThan(0.9);
    expect(d.amplitude).toBe(1);
    const u = uniformsOf(ripple.uniforms)[1] as Vector4;
    expect(u.x).toBeCloseTo(CROP.u0 + 0.3 * (CROP.u1 - CROP.u0), 9);
    expect(u.y).toBeCloseTo(0.6, 9);
    expect(u.z).toBeGreaterThan(0.9);
    // Away from the painting the strength falls, and the slot keeps its uv while it eases.
    place(2, pointOn(starry, 0.3, 0.6, 0.5));
    run(ripple, state, 0.3);
    expect(ripple.diag().contacts[1]?.uv[0]).toBeCloseTo(0.3, 9);
    run(ripple, state, RIPPLE_FALL_S);
    expect(ripple.diag().contacts).toEqual([null, null]);
    expect((uniformsOf(ripple.uniforms)[1] as Vector4).z).toBe(0);
  });

  it('is off with the orbs off, outside XR and with the gate shut, and eases out in a transition', () => {
    const ripple = createGalleryRipple(starry, CROP, new MeshBasicMaterial());
    place(2, pointOn(starry, 0.5, 0.5, 0));
    for (const off of [{ enabled: false }, { presenting: false }, { amplitude: 0 }]) {
      const state = { ...base(), ...off };
      run(ripple, state, 0.5);
      expect(ripple.diag().contacts).toEqual([null, null]);
    }
    const state = base();
    run(ripple, state, 0.5);
    const held = ripple.diag().contacts[1];
    expect(held?.strength).toBe(1);
    // A transition takes no new contact though the hand stays at the paint: the ripple eases out
    // where it was, at the amplitude it had, and reaches exactly 0 within RIPPLE_FALL_S.
    const busy = { ...state, busy: true };
    ripple.frame(busy);
    const first = ripple.diag();
    expect(first.amplitude).toBe(1);
    expect(first.contacts[1]?.uv).toEqual(held?.uv);
    expect(first.contacts[1]?.strength).toBeGreaterThan(0.99);
    expect(first.contacts[1]?.strength).toBeLessThan(1);
    run(ripple, busy, RIPPLE_FALL_S + 0.05);
    expect(ripple.diag().contacts).toEqual([null, null]);
    expect((uniformsOf(ripple.uniforms)[1] as Vector4).z).toBe(0);
  });

  it('settles the old ripple first when a hand touches elsewhere after a gap', () => {
    const ripple = createGalleryRipple(starry, CROP, new MeshBasicMaterial());
    const state = base();
    const dt = state.dt;
    place(1, null);
    place(2, pointOn(starry, 0.3, 0.5, 0));
    run(ripple, state, 0.5);
    // Released for 0.3 s, so the strength at A falls, then the hand pokes B, 0.2 m away.
    place(2, pointOn(starry, 0.3, 0.5, 0.5));
    run(ripple, state, 0.3);
    const fading = ripple.diag().contacts[1];
    expect(fading?.uv[0]).toBeCloseTo(0.3, 9);
    expect(fading?.strength ?? 0).toBeGreaterThan(0.3);
    const b = 0.3 + 0.2 / starry.width;
    place(2, pointOn(starry, b, 0.5, 0));
    let last = fading?.strength ?? 0;
    let frames = 0;
    for (;;) {
      ripple.frame(state);
      frames++;
      const c = ripple.diag().contacts[1];
      if (!c) break;
      // Centred on A until it is gone, falling no faster than the rise rate: the eased strength
      // drops by at most dt / RIPPLE_RISE_S a frame, and the smoothstep's slope is at most 1.5.
      expect(c.uv[0]).toBeCloseTo(0.3, 9);
      expect(last - c.strength).toBeLessThanOrEqual((1.5 * dt) / RIPPLE_RISE_S + 1e-9);
      last = c.strength;
      expect(frames).toBeLessThan(Math.ceil(RIPPLE_RISE_S / dt) + 2);
    }
    // Then the ripple at B rises from 0.
    ripple.frame(state);
    expect(ripple.diag().contacts[1]?.uv[0]).toBeCloseTo(b, 9);
    expect(ripple.diag().contacts[1]?.strength).toBeLessThan(0.1);
    run(ripple, state, 0.5);
    expect(ripple.diag().contacts[1]?.uv[0]).toBeCloseTo(b, 9);
    expect(ripple.diag().contacts[1]?.strength).toBe(1);
  });

  it('follows a drag, and re-centres at once on a touch near the old centre', () => {
    const ripple = createGalleryRipple(starry, CROP, new MeshBasicMaterial());
    const state = base();
    place(1, null);
    place(2, pointOn(starry, 0.3, 0.5, 0));
    run(ripple, state, 0.5);
    // A 0.3 m swipe in 0.25 s that never leaves the paint: the centre stays on the hand.
    for (let i = 1; i <= 18; i++) {
      const u = 0.3 + (0.3 * i) / 18 / starry.width;
      place(2, pointOn(starry, u, 0.5, 0));
      ripple.frame(state);
      expect(ripple.diag().contacts[1]?.uv[0]).toBeCloseTo(u, 9);
      expect(ripple.diag().contacts[1]?.strength).toBe(1);
    }
    // A gap, then a touch within RIPPLE_RETARGET_M of the centre: no settle first.
    const u0 = ripple.diag().contacts[1]?.uv[0] ?? 0;
    place(2, pointOn(starry, u0, 0.5, 0.5));
    run(ripple, state, 0.2);
    const near = u0 + (0.5 * RIPPLE_RETARGET_M) / starry.width;
    place(2, pointOn(starry, near, 0.5, 0));
    const before = ripple.diag().contacts[1]?.strength ?? 0;
    expect(before).toBeGreaterThan(0);
    ripple.frame(state);
    expect(ripple.diag().contacts[1]?.uv[0]).toBeCloseTo(near, 9);
    expect(ripple.diag().contacts[1]?.strength).toBeGreaterThan(before);
  });

  it('ignores an untracked hand, and a hand at a coming-soon frame', () => {
    const ripple = createGalleryRipple(starry, CROP, new MeshBasicMaterial());
    const state = base();
    place(1, pointOn(chestnut, 0.5, 0.5, 0));
    place(2, pointOn(starry, 0.5, 0.5, 0));
    (disturbers[2] as Vector4).w = 0;
    run(ripple, state, 0.5);
    expect(ripple.diag().contacts).toEqual([null, null]);
  });

  it('scales its amplitude and its clock by calm', () => {
    const ripple = createGalleryRipple(starry, CROP, new MeshBasicMaterial());
    const state = { ...base(), amplitude: 0.5 };
    place(1, null);
    place(2, pointOn(starry, 0.5, 0.5, 0));
    const t0 = ripple.uniforms.uRippleTime.value;
    run(ripple, state, 0.5);
    expect((uniformsOf(ripple.uniforms)[1] as Vector4).z).toBeCloseTo(0.5, 9);
    expect(ripple.diag().amplitude).toBe(0.5);
    const advanced =
      (ripple.uniforms.uRippleTime.value - t0 + RIPPLE_TIME_WRAP_S) % RIPPLE_TIME_WRAP_S;
    expect(advanced).toBeGreaterThan(0.2);
    expect(advanced).toBeLessThan(0.3);
  });

  it('takes a forced contact at once on the desktop, and drops it at once', () => {
    const ripple = createGalleryRipple(starry, CROP, new MeshBasicMaterial());
    const state = { ...base(), presenting: false };
    ripple.force(0.4, 0.55, 1);
    ripple.frame(state);
    expect(ripple.diag().contacts[0]).toEqual({ uv: [0.4, 0.55], strength: 1 });
    // A transition eases it out, and it is back at once after.
    ripple.frame({ ...state, busy: true });
    expect(ripple.diag().contacts[0]?.strength).toBeLessThan(1);
    run(ripple, { ...state, busy: true }, RIPPLE_FALL_S + 0.05);
    expect(ripple.diag().contacts[0]).toBeNull();
    ripple.frame(state);
    expect(ripple.diag().contacts[0]?.strength).toBe(1);
    ripple.force(0, 0, null);
    ripple.frame(state);
    expect(ripple.diag().contacts[0]).toBeNull();
    expect((uniformsOf(ripple.uniforms)[0] as Vector4).z).toBe(0);
  });

  it('writes the same uniform objects every frame', () => {
    const ripple = createGalleryRipple(starry, CROP, new MeshBasicMaterial());
    const before = [...uniformsOf(ripple.uniforms)];
    run(ripple, base(), 0.2);
    expect(uniformsOf(ripple.uniforms)).toEqual(before);
    expect(uniformsOf(ripple.uniforms)[0]).toBe(before[0]);
  });
});
