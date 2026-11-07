import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCOMOTION_SETTINGS } from '../src/locomotion/settings';
import { createLocomotionState } from '../src/locomotion/step';
import {
  BLINK_DOWN,
  BLINK_UP,
  createArcResult,
  createBlink,
  FLAT_WORLD,
  GRAVITY,
  LAUNCH_SPEED,
  type LandingWorld,
  MAX_RANGE,
  MAX_SAMPLES,
  MAX_SLOPE_DEG,
  startBlink,
  stepBlink,
  teleportRig,
  traceArc,
} from '../src/locomotion/teleport';
import type { Vec3 } from '../src/render/strokes/frame';

const UP: Vec3 = [0, 1, 0];
const ORIGIN: Vec3 = [0, 1.5, 0];
const FORWARD: Vec3 = [0, 0, -1];
const DEG = Math.PI / 180;

/** A plane rising `k` metres per metre of +x, with its exact unit normal. */
function rampX(k: number): LandingWorld {
  const n: Vec3 = [-k / Math.hypot(k, 1), 1 / Math.hypot(k, 1), 0];
  return { ground: { heightAt: (x) => k * x, normalAt: () => n } };
}

/** Flat ground at y = 0 with extra limits. */
function flatWith(limits: Omit<LandingWorld, 'ground'>): LandingWorld {
  return { ground: FLAT_WORLD.ground, ...limits };
}

function trace(origin: Vec3, direction: Vec3, world: LandingWorld = FLAT_WORLD) {
  const out = createArcResult();
  traceArc(out, origin, direction, world);
  return out;
}

function point(out: ReturnType<typeof createArcResult>, i: number): Vec3 {
  return [out.points[i * 3], out.points[i * 3 + 1], out.points[i * 3 + 2]];
}

/**
 * Closed-form landing time of a shot from height `y0` with vertical speed `vy` onto ground that
 * rises `k` m per metre of horizontal travel at horizontal speed `vh`: the larger root of
 * y0 + vy·t − g·t²/2 = k·vh·t.
 */
function landingTime(y0: number, vy: number, vh: number, k: number): number {
  const a = GRAVITY / 2;
  const b = k * vh - vy;
  return (-b + Math.sqrt(b * b + 4 * a * y0)) / (2 * a);
}

describe('traceArc on flat ground', () => {
  it('a level shot from 1.5 m lands where the closed-form parabola meets y = 0', () => {
    const out = trace(ORIGIN, FORWARD);
    const t = Math.sqrt((2 * 1.5) / GRAVITY);
    expect(out.hit).not.toBeNull();
    const hit = out.hit as Vec3;
    expect(hit[0]).toBeCloseTo(0, 9);
    expect(hit[1]).toBe(0);
    expect(hit[2]).toBeCloseTo(-LAUNCH_SPEED * t, 6);
    expect(out.valid).toBe(true);
    expect(out.reason).toBe('ok');
  });

  it('a 45° shot lands on the closed-form root, further out', () => {
    const s = Math.SQRT1_2;
    const out = trace(ORIGIN, [0, s, -s]);
    const v = LAUNCH_SPEED * s;
    const t = landingTime(1.5, v, v, 0);
    expect((out.hit as Vec3)[2]).toBeCloseTo(-v * t, 6);
    expect(out.reason).toBe('ok');
  });

  it('samples lie on the parabola, start at the origin, end on the hit and stay above ground', () => {
    const s = Math.sin(20 * DEG);
    const c = Math.cos(20 * DEG);
    const out = trace(ORIGIN, [c, s, 0]);
    expect(out.count).toBeGreaterThan(2);
    expect(out.count).toBeLessThanOrEqual(MAX_SAMPLES);
    expect(point(out, 0)).toEqual(ORIGIN);
    expect(point(out, out.count - 1)).toEqual(out.hit);
    const vh = LAUNCH_SPEED * c;
    const vy = LAUNCH_SPEED * s;
    for (let i = 0; i < out.count; i += 1) {
      const [x, y, z] = point(out, i);
      const t = x / vh;
      expect(z).toBe(0);
      expect(y).toBeCloseTo(1.5 + vy * t - (GRAVITY / 2) * t * t, 6);
      if (i < out.count - 1) expect(y).toBeGreaterThan(0);
    }
  });

  it('a short, steep-down arc still gets every sample, evenly in time up to the hit', () => {
    // 45° down from 1.5 m: lands about 1 m out, a sliver of the 15 m range-capped flight.
    const s = Math.SQRT1_2;
    const out = trace(ORIGIN, [0, -s, -s]);
    const hit = out.hit as Vec3;
    expect(-hit[2]).toBeLessThan(1.5);
    expect(out.count).toBe(MAX_SAMPLES);
    expect(point(out, out.count - 1)).toEqual(hit);
    // Constant horizontal speed: even time steps are even steps in z.
    const step = hit[2] / (MAX_SAMPLES - 1);
    for (let i = 0; i < out.count; i += 1) expect(point(out, i)[2]).toBeCloseTo(i * step, 9);
  });

  it('ignores the direction length: only its heading matters', () => {
    expect(trace(ORIGIN, [0, 0, -5]).hit).toEqual(trace(ORIGIN, FORWARD).hit);
  });
});

describe('traceArc on a slope', () => {
  it('meets a gentle rising ramp at the closed-form root and accepts it', () => {
    const k = 0.3;
    const out = trace(ORIGIN, [1, 0, 0], rampX(k));
    const t = landingTime(1.5, 0, LAUNCH_SPEED, k);
    const hit = out.hit as Vec3;
    expect(hit[0]).toBeCloseTo(LAUNCH_SPEED * t, 6);
    expect(hit[1]).toBeCloseTo(k * LAUNCH_SPEED * t, 6);
    expect(Math.atan(k) / DEG).toBeLessThan(MAX_SLOPE_DEG);
    expect(out.reason).toBe('ok');
    expect(out.valid).toBe(true);
  });

  it('meets a falling ramp further out than flat ground', () => {
    const k = -0.25;
    const out = trace(ORIGIN, [1, 0, 0], rampX(k));
    const t = landingTime(1.5, 0, LAUNCH_SPEED, k);
    expect((out.hit as Vec3)[0]).toBeCloseTo(LAUNCH_SPEED * t, 6);
    expect((out.hit as Vec3)[0]).toBeGreaterThan(LAUNCH_SPEED * Math.sqrt(3 / GRAVITY));
  });
});

describe('landing validity', () => {
  it('rejects ground steeper than 35°, still reporting the hit', () => {
    const steep = trace(ORIGIN, [1, 0, 0], rampX(Math.tan(40 * DEG)));
    expect(steep.hit).not.toBeNull();
    expect(steep.valid).toBe(false);
    expect(steep.reason).toBe('slope');
    expect(trace(ORIGIN, [1, 0, 0], rampX(Math.tan(30 * DEG))).reason).toBe('ok');
  });

  it('measures the slope from the normal at the hit, not from the height field', () => {
    // Level heights, but a normal tilted 50° off +Y: the normal decides.
    const tilted: Vec3 = [Math.sin(50 * DEG), Math.cos(50 * DEG), 0];
    const world: LandingWorld = { ground: { heightAt: () => 0, normalAt: () => tilted } };
    expect(trace(ORIGIN, FORWARD, world).reason).toBe('slope');
  });

  it('rejects a landing where the boundary factor is above 0 and accepts it at exactly 0', () => {
    const edge = 3;
    const boundaryFactor = (p: Vec3): number => (Math.hypot(p[0], p[2]) > edge ? 0.01 : 0);
    const out = trace(ORIGIN, FORWARD, flatWith({ boundaryFactor }));
    expect(out.reason).toBe('boundary');
    expect(out.valid).toBe(false);
    expect(trace(ORIGIN, FORWARD, flatWith({ boundaryFactor: () => 0 })).reason).toBe('ok');
  });

  it('passes the hit itself to the boundary factor', () => {
    const seen: Vec3[] = [];
    const out = trace(
      ORIGIN,
      FORWARD,
      flatWith({
        boundaryFactor: (p) => {
          seen.push([p[0], p[1], p[2]]);
          return 0;
        },
      }),
    );
    expect(seen).toEqual([out.hit]);
  });

  it('rejects a landing inside a footprint and accepts one outside it', () => {
    const blocked = (_x: number, z: number): boolean => z < -4;
    expect(trace(ORIGIN, FORWARD, flatWith({ blocked })).reason).toBe('footprint');
    expect(trace(ORIGIN, FORWARD, flatWith({ blocked: (_x, z) => z > 0 })).reason).toBe('ok');
  });

  it('the flat world has level ground at y = 0 and neither a boundary nor footprints', () => {
    expect(FLAT_WORLD.ground.heightAt(123, -45)).toBe(0);
    expect(FLAT_WORLD.ground.normalAt(123, -45)).toEqual(UP);
    expect(FLAT_WORLD.boundaryFactor).toBeUndefined();
    expect(FLAT_WORLD.blocked).toBeUndefined();
    const far = trace([60, 1.5, 0], FORWARD);
    expect(far.reason).toBe('ok');
  });
});

describe('the range cap', () => {
  /** Flat at 0 up to z = −1, then a drop to `depth`. */
  const cliff = (depth: number): LandingWorld => ({
    ground: { heightAt: (_x, z) => (z < -1 ? depth : 0), normalAt: () => UP },
  });

  it('lands below a cliff when the landing is inside 15 m', () => {
    const out = trace(ORIGIN, FORWARD, cliff(-10));
    const reach = LAUNCH_SPEED * Math.sqrt((2 * 11.5) / GRAVITY);
    expect(reach).toBeLessThan(MAX_RANGE);
    expect((out.hit as Vec3)[2]).toBeCloseTo(-reach, 6);
    expect(out.reason).toBe('ok');
  });

  it('finds no landing past 15 m: the arc stops at the cap with no hit', () => {
    const out = trace(ORIGIN, FORWARD, cliff(-20));
    expect(LAUNCH_SPEED * Math.sqrt((2 * 21.5) / GRAVITY)).toBeGreaterThan(MAX_RANGE);
    expect(out.hit).toBeNull();
    expect(out.valid).toBe(false);
    expect(out.reason).toBe('none');
    expect(out.count).toBe(MAX_SAMPLES);
    const last = point(out, out.count - 1);
    expect(Math.hypot(last[0] - ORIGIN[0], last[2] - ORIGIN[2])).toBeCloseTo(MAX_RANGE, 9);
  });

  it('never holds more than 40 samples, even straight up', () => {
    const out = trace(ORIGIN, [0, 1, 0], cliff(-1000));
    expect(out.count).toBeLessThanOrEqual(MAX_SAMPLES);
    expect(out.hit).not.toBeNull();
  });

  it('an origin under the ground, or no direction, has no landing', () => {
    expect(trace([0, -0.1, 0], FORWARD).reason).toBe('none');
    expect(trace([0, -0.1, 0], FORWARD).hit).toBeNull();
    expect(trace(ORIGIN, [0, 0, 0]).reason).toBe('none');
  });

  it('a result is reused: a later miss clears the earlier hit', () => {
    const out = createArcResult();
    traceArc(out, ORIGIN, FORWARD, FLAT_WORLD);
    expect(out.valid).toBe(true);
    traceArc(out, ORIGIN, FORWARD, cliff(-20));
    expect(out.hit).toBeNull();
    expect(out.valid).toBe(false);
  });
});

describe('teleportRig', () => {
  const head = { x: 0.5, y: 1.6, z: -0.4, yaw: 0.3 };
  /** The head's world XZ, as step.ts computes it. */
  const headWorld = (state: ReturnType<typeof createLocomotionState>): [number, number] => {
    const s = Math.sin(state.yaw);
    const c = Math.cos(state.yaw);
    return [
      state.position[0] + c * head.x + s * head.z,
      state.position[2] - s * head.x + c * head.z,
    ];
  };

  it('puts the head, not the rig origin, on the hit, and the rig straight on its ground', () => {
    const state = createLocomotionState();
    state.yaw = 0.7;
    state.groundY = 5;
    const hit: Vec3 = [3, -2, -7];
    teleportRig(state, head, hit, DEFAULT_LOCOMOTION_SETTINGS);
    const [hx, hz] = headWorld(state);
    expect(hx).toBeCloseTo(3, 12);
    expect(hz).toBeCloseTo(-7, 12);
    expect(state.yaw).toBe(0.7);
    expect(state.position[1]).toBe(-2);
    // No ease from the old ground: ground follow starts from the landing.
    expect(state.groundY).toBe(-2);
    expect(state.grounded).toBe(true);
  });

  it('keeps the seated offset and releases a held rig', () => {
    const state = createLocomotionState();
    state.seatedOffset = 0.5;
    state.held = true;
    state.grounded = false;
    teleportRig(state, head, [1, 2, 3], { ...DEFAULT_LOCOMOTION_SETTINGS, seated: true });
    expect(state.position[1]).toBe(2.5);
    expect(state.groundY).toBe(2);
    expect(state.held).toBe(false);
    expect(state.grounded).toBe(true);
  });
});

describe('the blink', () => {
  const DT = 1 / 72;

  it('fades down over 90 ms, jumps once at full black, then fades up over 90 ms', () => {
    const blink = createBlink();
    expect(blink.fade).toBe(0);
    expect(stepBlink(blink, DT)).toBe(false);
    startBlink(blink);
    const fades: number[] = [];
    const jumps: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      if (stepBlink(blink, DT)) jumps.push(frame);
      fades.push(blink.fade);
    }
    expect(jumps).toHaveLength(1);
    const peak = jumps[0] as number;
    // The jump frame renders fully black, and is the first frame at or past 90 ms.
    expect(fades[peak]).toBe(1);
    expect((peak + 1) * DT).toBeGreaterThanOrEqual(BLINK_DOWN - 1e-9);
    expect(peak * DT).toBeLessThan(BLINK_DOWN);
    for (let i = 1; i < peak; i += 1) expect(fades[i]).toBeGreaterThan(fades[i - 1] as number);
    for (let i = 0; i < peak; i += 1) expect(fades[i]).toBeCloseTo(((i + 1) * DT) / BLINK_DOWN, 9);
    // Back up: strictly falling to exactly 0 within 90 ms of the jump, then idle.
    const up = Math.ceil(BLINK_UP / DT - 1e-9);
    for (let i = peak + 1; i <= peak + up; i += 1) {
      expect(fades[i]).toBeLessThan(fades[i - 1] as number);
    }
    expect(fades[peak + up]).toBe(0);
    expect(fades.slice(peak + up)).toEqual(new Array(30 - peak - up).fill(0));
    expect(blink.active).toBe(false);
  });

  it('a long frame reaches black at once rather than skipping the jump', () => {
    const blink = createBlink();
    startBlink(blink);
    expect(stepBlink(blink, 0.1)).toBe(true);
    expect(blink.fade).toBe(1);
  });
});
