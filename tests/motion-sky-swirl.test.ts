import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { DataTexture, RGBAFormat, Texture } from 'three';
import { describe, expect, test } from 'vitest';
import { decodeFlowAngle } from '../src/demo/canvas/field.ts';
import { MOTION_TIME_WRAP_S } from '../src/motion/clock.ts';
import { motionReach } from '../src/motion/motion.ts';
import {
  SKY_DRIFT_RATE,
  SKY_SWIRL_FADE,
  SKY_SWIRL_MAX_ANGLE,
  SKY_SWIRL_MAX_SPEED,
  SKY_SWIRL_MAX_TURN,
  SKY_SWIRL_MAX_TURN_RATE,
  SKY_SWIRL_PERIOD,
  SKY_SWIRL_REACH,
  SKY_VORTICES,
  skyOmega,
  skySwirl,
  skySwirlGlslDefines,
  skySwirlReach,
  skyVelocity,
} from '../src/motion/sky-swirl.ts';
import {
  CANVAS_ASPECT,
  canvasRay,
  PAINTER_EYE,
  projectToCanvas,
} from '../src/paintings/starry-night/canvas-camera.ts';
import { createStrokeBatch, motionReachOf } from '../src/render/strokes/batch.ts';
import type { Vec3 } from '../src/render/strokes/frame.ts';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  selectStrokes,
} from '../src/render/strokes/instance.ts';
import { createStrokeMaterial } from '../src/render/strokes/material.ts';
import { mulberry32 } from '../src/util/prng.ts';
import { SKY_DOME_RADIUS } from '../src/world/sky.ts';

const motionGlsl = readFileSync('src/motion/motion.glsl', 'utf8');

const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const unit = (v: Vec3): Vec3 => {
  const l = norm(v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Directions on a latitude-longitude grid over the whole sphere, the vortex centres included. */
function sphere(n: number): Vec3[] {
  const out: Vec3[] = SKY_VORTICES.map((v) => v.axis);
  for (let i = 0; i <= n; i++) {
    const y = -1 + (2 * i) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    for (let j = 0; j < 2 * n; j++) {
      const phi = (Math.PI * j) / n;
      out.push([r * Math.cos(phi), y, r * Math.sin(phi)]);
    }
  }
  return out;
}

/** The unit direction at chord `chord` from unit `axis`, on bearing `phi` about it. */
function chordFrom(axis: Vec3, chord: number, phi: number): Vec3 {
  const offAxis = unit([Math.cos(phi), Math.sin(phi), 0.3]);
  const side = unit([
    offAxis[1] * axis[2] - offAxis[2] * axis[1],
    offAxis[2] * axis[0] - offAxis[0] * axis[2],
    offAxis[0] * axis[1] - offAxis[1] * axis[0],
  ]);
  const angle = 2 * Math.asin(chord / 2);
  return unit([
    axis[0] * Math.cos(angle) + side[0] * Math.sin(angle),
    axis[1] * Math.cos(angle) + side[1] * Math.sin(angle),
    axis[2] * Math.cos(angle) + side[2] * Math.sin(angle),
  ]);
}

/** A point on the dome through canvas (u, v), v up. */
const domePoint = (u: number, v: number, radius = SKY_DOME_RADIUS): Vec3 => {
  const ray = canvasRay(u, v);
  return [
    PAINTER_EYE[0] + ray[0] * radius,
    PAINTER_EYE[1] + ray[1] * radius,
    PAINTER_EYE[2] + ray[2] * radius,
  ];
};

describe('sky swirl field', () => {
  test('the loop period divides the motion time wrap (R-P4d)', () => {
    const n = MOTION_TIME_WRAP_S / SKY_SWIRL_PERIOD;
    expect(Number.isInteger(n)).toBe(true);
    const p = domePoint(0.5, 0.65);
    const a = skySwirl(p, [0, 0, 1], 0.3, 17.25);
    const b = skySwirl(p, [0, 0, 1], 0.3, 17.25 + SKY_SWIRL_PERIOD);
    const c = skySwirl(p, [0, 0, 1], 0.3, 17.25 + MOTION_TIME_WRAP_S);
    for (const m of [b, c]) {
      m.offset.forEach((x, k) => {
        expect(x).toBeCloseTo(a.offset[k], 9);
      });
      expect(m.turn).toBeCloseTo(a.turn, 9);
      expect(m.gain).toBeCloseTo(a.gain, 9);
    }
  });

  test('speed and turn rate are bounded by the exported constants over the whole sphere', () => {
    let speed = 0;
    let turn = 0;
    for (const dir of sphere(300)) {
      speed = Math.max(speed, norm(skyVelocity(dir)));
      turn = Math.max(turn, Math.abs(dot(skyOmega(dir), dir)));
    }
    expect(speed).toBeLessThanOrEqual(SKY_SWIRL_MAX_SPEED);
    expect(turn).toBeLessThanOrEqual(SKY_SWIRL_MAX_TURN_RATE);
    // The bounds are not slack by more than a fifth, so the cull growth is not either.
    expect(speed).toBeGreaterThan(0.8 * SKY_SWIRL_MAX_SPEED);
    expect(turn).toBeGreaterThan(0.8 * SKY_SWIRL_MAX_TURN_RATE);
  });

  test('the field is continuous: Lipschitz between nearby directions, core edges included', () => {
    // |Δv| ≤ |ΔΩ| + |Ω| |Δd|. Each vortex's rate 0.5Γ / max(1 − c·d, 0.5R²) has slope at most
    // 2|Γ| / R⁴ in c·d and value at most |Γ| / R², and the drift is constant.
    const lipschitz =
      SKY_VORTICES.reduce(
        (sum, v) => sum + (2 * Math.abs(v.gamma)) / v.core ** 4 + Math.abs(v.gamma) / v.core ** 2,
        0,
      ) + SKY_DRIFT_RATE;
    const check = (a: Vec3, b: Vec3): void => {
      const va = skyVelocity(a);
      const vb = skyVelocity(b);
      const dv = norm([va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]]);
      const dd = norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
      expect(dv).toBeLessThanOrEqual(lipschitz * dd + 1e-12);
    };
    const rand = mulberry32(42);
    for (const dir of sphere(80)) {
      const step = 1e-4;
      check(
        dir,
        unit([
          dir[0] + step * (rand() - 0.5),
          dir[1] + step * (rand() - 0.5),
          dir[2] + step * (rand() - 0.5),
        ]),
      );
    }
    // Every core edge, straddled from 0.98 to 1.02 of its radius along 16 bearings, and once more
    // across it at ±1e-7: a step at the max(s², R²) switch would fail these pairs.
    const shares = [0.98, 0.985, 0.99, 0.995, 1 - 1e-7, 1, 1 + 1e-7, 1.005, 1.01, 1.015, 1.02];
    for (const vortex of SKY_VORTICES) {
      for (let k = 0; k < 16; k++) {
        const along = shares.map((share) => {
          const dir = chordFrom(vortex.axis, share * vortex.core, (2 * Math.PI * k) / 16);
          const chord = norm([
            dir[0] - vortex.axis[0],
            dir[1] - vortex.axis[1],
            dir[2] - vortex.axis[2],
          ]);
          expect(chord / vortex.core).toBeCloseTo(share, 9);
          return dir;
        });
        for (let i = 0; i + 1 < along.length; i++) check(along[i], along[i + 1]);
      }
    }
  });

  test('the central swirls circulate the way their arms wind inward in the scan', async () => {
    const { data, info } = await sharp('public/paintings/starry-night/flow.png')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const size = info.width;
    const angleAt = (u: number, vDown: number): { angle: number; weight: number } => {
      const x = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
      const y = Math.min(size - 1, Math.max(0, Math.floor(vDown * size)));
      const i = (y * size + x) * info.channels;
      return { angle: decodeFlowAngle(data[i], data[i + 1]), weight: data[i + 2] };
    };
    const central = SKY_VORTICES.slice(0, 2);
    expect(central.map((v) => v.note)).toEqual([
      'central double swirl, left (large)',
      'central double swirl, right',
    ]);
    for (const vortex of central) {
      const [u0, v0] = vortex.uv;
      // The ring's pitch: the stroke axis against the counter-clockwise tangent (painting space,
      // y up). Negative pitch means the arm, followed counter-clockwise, leaves the centre, so it
      // winds inward clockwise as displayed.
      const reach = vortex.note.includes('left') ? [0.03, 0.12] : [0.01, 0.06];
      let pitch = 0;
      let weights = 0;
      let circulation = 0;
      for (let ring = 0; ring < 8; ring++) {
        const r = reach[0] + ((reach[1] - reach[0]) * (ring + 0.5)) / 8;
        for (let k = 0; k < 64; k++) {
          const phi = (2 * Math.PI * k) / 64;
          const dx = r * Math.cos(phi);
          const dy = r * Math.sin(phi);
          const { angle, weight } = angleAt(u0 + dx, 1 - (v0 + dy * CANVAS_ASPECT));
          const a =
            ((((angle - phi - Math.PI / 2) % Math.PI) + 1.5 * Math.PI) % Math.PI) - Math.PI / 2;
          pitch += weight * Math.sin(2 * a);
          weights += weight;
          // The field's canvas-space motion at the same point, as the painter's camera sees it.
          const p = domePoint(u0 + dx, v0 + dy * CANVAS_ASPECT);
          const m = skySwirl(p, [0, 0, 1], 0.75, 0);
          const moved = projectToCanvas([
            p[0] + m.offset[0],
            p[1] + m.offset[1],
            p[2] + m.offset[2],
          ]).uv as readonly [number, number];
          const du = moved[0] - (u0 + dx);
          const dv = (moved[1] - (v0 + dy * CANVAS_ASPECT)) / CANVAS_ASPECT;
          circulation += dx * dv - dy * du;
        }
      }
      // Both arms wind inward clockwise (sin 2α about -0.4 and -0.5).
      expect(pitch / weights).toBeLessThan(-0.2);
      // A vortex turns the way its arms wind inward: clockwise, negative in y-up canvas space.
      expect(circulation).toBeLessThan(0);
      expect(vortex.spin).toBe('clockwise');
      expect(vortex.gamma).toBeGreaterThan(0);
    }
  });

  test('every vortex, the halo eddies included, circulates clockwise as displayed', () => {
    for (const vortex of SKY_VORTICES) {
      const [u0, v0] = vortex.uv;
      // The circulation round a small ring: the drift and the other vortices, near uniform across
      // it, cancel out of the sum.
      let circulation = 0;
      for (let k = 0; k < 32; k++) {
        const phi = (2 * Math.PI * k) / 32;
        const dx = 0.02 * Math.cos(phi);
        const dy = 0.02 * Math.sin(phi);
        const p = domePoint(u0 + dx, v0 + dy);
        const m = skySwirl(p, [0, 0, 1], 0.75, 0);
        const moved = projectToCanvas([p[0] + m.offset[0], p[1] + m.offset[1], p[2] + m.offset[2]])
          .uv as readonly [number, number];
        circulation += dx * (moved[1] - v0 - dy) - dy * (moved[0] - u0 - dx);
      }
      expect(circulation).toBeLessThan(0);
    }
  });
});

describe('sky swirl loop', () => {
  const rand = mulberry32(7);
  const strokes: { p: Vec3; n: Vec3 }[] = [];
  for (let i = 0; i < 400; i++) {
    const dir = unit([rand() - 0.5, rand() * 0.9 + 0.05, rand() - 0.5]);
    const radius = SKY_DOME_RADIUS * (0.4 + 0.6 * rand());
    strokes.push({
      p: [
        PAINTER_EYE[0] + dir[0] * radius,
        PAINTER_EYE[1] + dir[1] * radius,
        PAINTER_EYE[2] + dir[2] * radius,
      ],
      n: [-dir[0], -dir[1], -dir[2]],
    });
  }

  test('displacement, turn and gain stay inside their exported bounds at every phase', () => {
    for (const { p, n } of strokes) {
      const distance = norm([p[0] - PAINTER_EYE[0], p[1] - PAINTER_EYE[1], p[2] - PAINTER_EYE[2]]);
      const reach = skySwirlReach(p[0], p[1], p[2]);
      // Exact: half a loop at the stroke's own speed, reached at the end of the loop.
      expect(reach).toBeCloseTo(norm(skySwirl(p, n, 0, 0).offset), 9);
      expect(reach).toBeLessThanOrEqual(motionReach(STROKE_LAYER.sky, p, 1) + 1e-9);
      for (let k = 0; k < 32; k++) {
        const m = skySwirl(p, n, k / 32, 3.3);
        expect(norm(m.offset)).toBeLessThanOrEqual(SKY_SWIRL_MAX_ANGLE * distance + 1e-9);
        // R-P4a: the cull growth, the exact reach, bounds every sky stroke's displacement.
        expect(norm(m.offset)).toBeLessThanOrEqual(reach + 1e-9);
        expect(norm(m.offset)).toBeLessThanOrEqual(SKY_SWIRL_REACH);
        // R-P4b: the haze thin's reach bounds it too, at full calm and scaled with it.
        expect(norm(m.offset)).toBeLessThanOrEqual(motionReach(STROKE_LAYER.sky, p, 1) + 1e-9);
        expect(Math.abs(m.turn)).toBeLessThanOrEqual(SKY_SWIRL_MAX_TURN);
        expect(m.gain).toBeGreaterThanOrEqual(-1);
        expect(m.gain).toBeLessThanOrEqual(0);
      }
    }
    // The reach on the dome is SKY_SWIRL_REACH at most.
    expect(motionReach(STROKE_LAYER.sky, domePoint(0.5, 0.9), 1)).toBeLessThanOrEqual(
      SKY_SWIRL_REACH + 1e-9,
    );
    expect(motionReach(STROKE_LAYER.ground, strokes[0].p, 1)).toBe(0);
    // The haze holds still under wheel and stream, so its thin needs no motion reach there.
    expect(motionReach(STROKE_LAYER.sky, domePoint(0.5, 0.9), 1, 'wheel')).toBe(0);
    expect(motionReach(STROKE_LAYER.sky, domePoint(0.5, 0.9), 1, 'stream')).toBe(0);
    expect(motionReach(STROKE_LAYER.sky, domePoint(0.5, 0.9), 1, 'wave')).toBeGreaterThan(0);
  });

  test('the stroke vanishes at the wrap, so the jump back is never seen', () => {
    const { p, n } = strokes[0];
    // f = fract(t / period + phase): f near 0 and near 1 are the two sides of the wrap.
    const before = skySwirl(p, n, 1 - 1e-6, 0);
    const after = skySwirl(p, n, 0, 0);
    expect(before.gain).toBeCloseTo(-1, 6);
    expect(after.gain).toBe(-1);
    expect(skySwirl(p, n, 0.5, 0).gain).toBe(0);
    expect(skySwirl(p, n, SKY_SWIRL_FADE, 0).gain).toBeCloseTo(0, 12);
  });

  test('a stroke moves along the flow: its offset is parallel to the local velocity', () => {
    for (const { p, n } of strokes.slice(0, 50)) {
      const d: Vec3 = [p[0] - PAINTER_EYE[0], p[1] - PAINTER_EYE[1], p[2] - PAINTER_EYE[2]];
      const v = skyVelocity(unit(d));
      const m = skySwirl(p, n, 0.9, 0);
      const cosine = dot(unit(m.offset), unit(v));
      expect(cosine).toBeCloseTo(1, 9);
    }
  });

  test('wrapped strokes inside a vortex stay inside its radius', () => {
    for (const vortex of SKY_VORTICES) {
      const centre = vortex.axis;
      let worst = 0;
      for (let k = 0; k < 24; k++) {
        const phi = (2 * Math.PI * k) / 24;
        for (const share of [0.25, 0.5, 0.75, 0.95]) {
          // A dome point at chord share × core from the centre.
          const offAxis = unit([Math.cos(phi), Math.sin(phi), 0.3]);
          const side = unit([
            offAxis[1] * centre[2] - offAxis[2] * centre[1],
            offAxis[2] * centre[0] - offAxis[0] * centre[2],
            offAxis[0] * centre[1] - offAxis[1] * centre[0],
          ]);
          const angle = 2 * Math.asin((share * vortex.core) / 2);
          const dir = unit([
            centre[0] * Math.cos(angle) + side[0] * Math.sin(angle),
            centre[1] * Math.cos(angle) + side[1] * Math.sin(angle),
            centre[2] * Math.cos(angle) + side[2] * Math.sin(angle),
          ]);
          const p: Vec3 = [
            PAINTER_EYE[0] + dir[0] * SKY_DOME_RADIUS,
            PAINTER_EYE[1] + dir[1] * SKY_DOME_RADIUS,
            PAINTER_EYE[2] + dir[2] * SKY_DOME_RADIUS,
          ];
          for (let f = 0; f < 16; f++) {
            const m = skySwirl(p, [-dir[0], -dir[1], -dir[2]], f / 16, 0);
            const moved = unit([
              dir[0] + m.offset[0] / SKY_DOME_RADIUS,
              dir[1] + m.offset[1] / SKY_DOME_RADIUS,
              dir[2] + m.offset[2] / SKY_DOME_RADIUS,
            ]);
            const chord = norm([moved[0] - centre[0], moved[1] - centre[1], moved[2] - centre[2]]);
            worst = Math.max(worst, chord / vortex.core);
          }
        }
      }
      // The drift and the neighbouring swirl's tail cross every core edge, so a stroke at the edge
      // leaves by their share of the loop: up to 1.15 for the right swirl's small core. An exact
      // rotation instead of the tangent step still gives 1.12.
      expect(worst).toBeLessThan(1.2);
    }
  });
});

describe('sky swirl wiring', () => {
  test('the material carries the vortex table motion.glsl reads, from the one TS source', () => {
    const material = createStrokeMaterial(new Texture());
    const defines = skySwirlGlslDefines();
    expect(material.defines.SKY_VORTEX_COUNT).toBe(SKY_VORTICES.length);
    expect(SKY_VORTICES.length).toBe(4);
    for (const [name, value] of Object.entries(defines)) expect(material.defines[name]).toBe(value);
    expect(String(defines.SKY_VORTEX_AXES).match(/vec4\(/g)).toHaveLength(SKY_VORTICES.length + 0);
    for (const line of [
      'vec3 dir = d * inversesqrt(dot(d, d));',
      'omega += v.xyz * (v.w / max(1.0 - dot(v.xyz, dir), SKY_VORTEX_CORE[i]));',
      'float f = fract(t * SKY_SWIRL_INV_PERIOD + phase);',
      'float tau = (f - 0.5) * SKY_SWIRL_PERIOD;',
      'tau * cross(omega, d),',
      'tau * dot(omega, n),',
      'smoothstep(0.0, SKY_SWIRL_FADE, min(f, 1.0 - f)) - 1.0',
    ]) {
      expect(motionGlsl).toContain(line);
    }
    // R-P4h: the moving path has one inverse square root and no other special function.
    const sky = motionGlsl.slice(
      motionGlsl.indexOf('Motion skyMotion('),
      motionGlsl.indexOf('Motion ringMotion('),
    );
    expect(
      sky.match(/\b(sin|cos|tan|asin|acos|atan|exp|log|pow|sqrt|length|normalize)\(/g),
    ).toBeNull();
    // The default program's one, and the hoist arm's wheel branch's, which has no rest field to
    // read the direction from. The wheel's sine and cosine sit in skyWheelMotion, behind its branch.
    expect(sky.match(/inversesqrt\(/g)).toHaveLength(2);
    const base = sky.slice(sky.indexOf('#else'));
    expect(base.match(/inversesqrt\(/g)).toHaveLength(1);
  });

  test("a sky chunk's cull reach is its strokes' exact reach, and a still chunk has none", () => {
    const buffers = createStrokeBuffers(2);
    for (const [i, layer] of [STROKE_LAYER.sky, STROKE_LAYER.ground].entries()) {
      packInstance(buffers, i, {
        position: [i === 0 ? -30 : 30, 50, -60],
        normal: [0, 0, 1],
        tangent: 0,
        color: [255, 255, 255, 255],
        size: [2, 1],
        brush: 0,
        layer,
        phase: 0,
      });
    }
    expect(motionReachOf(buffers)).toBe(1.001 * skySwirlReach(-30, 50, -60));
    expect(motionReachOf(buffers)).toBeLessThanOrEqual(
      1.001 * motionReach(STROKE_LAYER.sky, [-30, 50, -60], 1),
    );
    expect(motionReachOf(selectStrokes(buffers, [1]))).toBe(0);
    // A sky stroke near the eye, as on the P1 canvas, barely grows its chunk.
    const near = createStrokeBuffers(1);
    packInstance(near, 0, {
      position: [0, 1.6, -2.55],
      normal: [0, 0, 1],
      tangent: 0,
      color: [255, 255, 255, 255],
      size: [0.02, 0.01],
      brush: 0,
      layer: STROKE_LAYER.sky,
      phase: 0,
    });
    expect(motionReachOf(near)).toBeLessThan(0.1);
    // The sphere radii themselves are pinned in strokes-batch.test.ts (the haze chunk test).
    const batch = createStrokeBatch(buffers, {
      cellSize: 24,
      createAtlas: () => new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat),
    });
    expect(batch.chunks).toHaveLength(2);
    batch.dispose();
  });
});
