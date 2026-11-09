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
  type VolumeQuery,
} from '../src/locomotion/teleport';
import {
  createCrownTest,
  createFootprintTest,
  createVolumes,
} from '../src/paintings/starry-night/footprints';
import type { Vec3 } from '../src/render/strokes/frame';
import { createCypress } from '../src/world/cypress';
import { createTerrain } from '../src/world/terrain';
import { createVillage } from '../src/world/village';

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
  it('rejects ground steeper than the 45° limit, still reporting the hit', () => {
    expect(MAX_SLOPE_DEG).toBe(45);
    const steep = trace(ORIGIN, [1, 0, 0], rampX(Math.tan(46 * DEG)));
    expect(steep.hit).not.toBeNull();
    expect(steep.valid).toBe(false);
    expect(steep.reason).toBe('slope');
    expect(trace(ORIGIN, [1, 0, 0], rampX(Math.tan(44 * DEG))).reason).toBe('ok');
  });

  it('keeps the footprint and boundary checks ahead of the slope on a steep ramp', () => {
    const steep = rampX(Math.tan(50 * DEG));
    const blocked = (): boolean => true;
    expect(trace(ORIGIN, [1, 0, 0], { ...steep, blocked }).reason).toBe('footprint');
    const boundaryFactor = (): number => 0.5;
    expect(trace(ORIGIN, [1, 0, 0], { ...steep, blocked, boundaryFactor }).reason).toBe('boundary');
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

  it('lands a seated eye lower than the seated head with a negative offset', () => {
    const state = createLocomotionState();
    state.seatedOffset = -0.5;
    const seated = { ...DEFAULT_LOCOMOTION_SETTINGS, seated: true };
    teleportRig(state, { ...head, y: 1.5 }, [1, 2, 3], seated);
    expect(state.position[1]).toBe(1.5);
  });

  it('keeps the landed eye 0.3 m above the hit when the head is low and the offset negative', () => {
    const state = createLocomotionState();
    state.seatedOffset = -0.5;
    const seated = { ...DEFAULT_LOCOMOTION_SETTINGS, seated: true };
    const low = { ...head, y: 0.1 };
    teleportRig(state, low, [1, 2, 3], seated);
    expect(state.position[1] + low.y).toBeGreaterThanOrEqual(2 + 0.3 - 1e-9);
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

describe("the painter's hill (real heightfield, seed 1)", () => {
  const terrain = createTerrain(1);
  const world: LandingWorld = {
    ground: { heightAt: terrain.heightAt, normalAt: terrain.normalAt },
    blocked: createFootprintTest(createVillage(1, terrain)),
  };

  it('accepts a teleport aimed up the hill from its foot, at every azimuth', () => {
    const rejected: string[] = [];
    let landedOnSteep = 0;
    for (let az = 0; az < 360; az += 5) {
      const a = az * DEG;
      const x = 13 * Math.sin(a);
      const z = -13 * Math.cos(a);
      const eye: Vec3 = [x, terrain.heightAt(x, z) + 1.4, z];
      for (const pitch of [0, 5, 10, 15, 20]) {
        const p = pitch * DEG;
        const out = trace(
          eye,
          [(-x / 13) * Math.cos(p), Math.sin(p), (-z / 13) * Math.cos(p)],
          world,
        );
        if (!out.hit) continue;
        const n = terrain.normalAt(out.hit[0], out.hit[2]);
        // Judge only landings on the flank, on ground above the old 35 degree limit.
        if (Math.acos(n[1]) / DEG >= 35) {
          landedOnSteep += 1;
          if (out.reason !== 'ok') rejected.push(`az ${az} pitch ${pitch}: ${out.reason}`);
        }
      }
    }
    expect(landedOnSteep).toBeGreaterThan(20);
    expect(rejected).toEqual([]);
  });
});

/** A building volume for fixtures: an upright box with a flat top. */
interface Box {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly top: number;
}

/** `VolumeQuery` over boxes: exact point and segment tests, as the real volumes promise. */
function boxVolumes(boxes: readonly Box[]): VolumeQuery {
  const ignored = boxes.map(() => false);
  const inside = (b: Box, x: number, y: number, z: number): boolean =>
    x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && y <= b.top;
  return {
    at: (x, y, z) => boxes.findIndex((b) => inside(b, x, y, z)),
    begin(x, y, z) {
      for (const [i, b] of boxes.entries()) ignored[i] = inside(b, x, y, z);
    },
    update(x, y, z) {
      for (const [i, b] of boxes.entries())
        if (ignored[i] && !inside(b, x, y, z)) ignored[i] = false;
    },
    crossing(ax, ay, az, bx, by, bz) {
      for (const [i, b] of boxes.entries()) {
        if (ignored[i]) continue;
        let t0 = 0;
        let t1 = 1;
        for (const [a, d, lo, hi] of [
          [ax, bx - ax, b.x0, b.x1],
          [az, bz - az, b.z0, b.z1],
        ] as const) {
          if (d === 0) {
            if (a < lo || a > hi) t1 = -1;
          } else {
            const u = (lo - a) / d;
            const v = (hi - a) / d;
            t0 = Math.max(t0, Math.min(u, v));
            t1 = Math.min(t1, Math.max(u, v));
          }
        }
        if (t0 > t1) continue;
        if (Math.min(ay + (by - ay) * t0, ay + (by - ay) * t1) <= b.top) return i;
      }
      return -1;
    },
  };
}

describe('arcs and building volumes', () => {
  /** x -1..1, z -4..-3, up to y 3, on flat ground. */
  const BOX: Box = { x0: -1, x1: 1, z0: -4, z1: -3, top: 3 };
  const box = boxVolumes([BOX]);
  const inBox = (x: number, y: number, z: number): boolean => box.at(x, y, z) >= 0;
  const lowWall = boxVolumes([{ ...BOX, top: 1 }]);

  it('cuts an arc at the wall it enters, reports `building` and draws up to the cut', () => {
    const out = trace(ORIGIN, FORWARD, flatWith({ volumes: box }));
    expect(out.reason).toBe('building');
    expect(out.valid).toBe(false);
    const hit = out.hit as Vec3;
    // The wall face the arc meets is z = -3, and the hit is just inside it.
    expect(hit[2]).toBeLessThan(-3);
    expect(hit[2]).toBeGreaterThan(-3.001);
    expect(inBox(hit[0], hit[1], hit[2])).toBe(true);
    expect(hit[1]).toBeGreaterThan(0);
    // The arc is the parabola up to there: every sample is clear of the box except the last.
    expect(out.count).toBe(MAX_SAMPLES);
    expect(point(out, out.count - 1)).toEqual(hit);
    for (let i = 0; i < out.count - 1; i += 1) {
      const [x, y, z] = point(out, i);
      expect(inBox(x, y, z), `sample ${i}`).toBe(false);
    }
    expect(point(out, 0)).toEqual(ORIGIN);
  });

  it('cuts an arc that crosses a wall thinner than a sample step, with both samples outside it', () => {
    // 0.1 m thick at z -3.05..-2.95. Samples fall every 0.385 m in z, at -2.695 and -3.08.
    const thin = boxVolumes([{ ...BOX, z0: -3.05, z1: -2.95 }]);
    const out = trace(ORIGIN, FORWARD, flatWith({ volumes: thin }));
    expect(out.reason).toBe('building');
    const hit = out.hit as Vec3;
    expect(hit[2]).toBeLessThan(-2.94);
    expect(hit[2]).toBeGreaterThan(-3.06);
    expect(trace(ORIGIN, FORWARD, flatWith({})).reason).toBe('ok');
  });

  it('passes an arc over a wall it clears and lands behind it', () => {
    const clear = trace(ORIGIN, [0, 0.6, -1], flatWith({ volumes: lowWall }));
    expect(clear.reason).toBe('ok');
    expect((clear.hit as Vec3)[2]).toBeLessThan(-4);
  });

  it('cuts an arc that would land behind the building, which the landing test alone accepts', () => {
    const blocked = (x: number, z: number): boolean => x >= -1 && x <= 1 && z >= -4 && z <= -3;
    const start: Vec3 = [0, 2.5, -1];
    const aim: Vec3 = [0, 0, -1];
    const lands = trace(start, aim, flatWith({ blocked }));
    expect(lands.reason).toBe('ok');
    expect((lands.hit as Vec3)[2]).toBeLessThan(-4);
    const cut = trace(start, aim, flatWith({ blocked, volumes: box }));
    expect(cut.reason).toBe('building');
    expect(cut.valid).toBe(false);
  });

  it('cuts at a landing that ends in the ground inside a low volume, at its entry', () => {
    // Top 0.2 m, z -5..-4.3: the arc lands at z -4.4 and its last sample above ground is at -4.2.
    const low = boxVolumes([{ x0: -1, x1: 1, z0: -5, z1: -4.3, top: 0.2 }]);
    const out = trace(ORIGIN, FORWARD, flatWith({ volumes: low }));
    expect(out.reason).toBe('building');
    const hit = out.hit as Vec3;
    expect(hit[2]).toBeLessThan(-4.3);
    expect(hit[2]).toBeGreaterThan(-4.31);
    expect(hit[1]).toBeGreaterThan(0);
    expect(hit[1]).toBeLessThanOrEqual(0.2);
  });

  it('cuts an arc that falls onto a roof from above, at the top', () => {
    const out = trace([0, 6, -3.2], [0, -1, -0.1], flatWith({ volumes: box }));
    expect(out.reason).toBe('building');
    expect((out.hit as Vec3)[1]).toBeCloseTo(3, 1);
  });

  it('stops at the first of two buildings and ignores a world with none', () => {
    const two = boxVolumes([BOX, { ...BOX, z0: -12, z1: -10 }]);
    const out = trace(ORIGIN, FORWARD, flatWith({ volumes: two }));
    expect((out.hit as Vec3)[2]).toBeGreaterThan(-3.01);
    expect(trace(ORIGIN, FORWARD, flatWith({ volumes: boxVolumes([]) })).reason).toBe('ok');
  });

  it('decides `building` before any landing reason', () => {
    const everything = {
      volumes: box,
      boundaryFactor: () => 1,
      blocked: () => true,
      treeBlocked: () => true,
    };
    expect(trace(ORIGIN, FORWARD, flatWith(everything)).reason).toBe('building');
  });

  it('orders the landing reasons: boundary, footprint, tree, then slope', () => {
    const all = { boundaryFactor: () => 1, blocked: () => true, treeBlocked: () => true };
    expect(trace(ORIGIN, FORWARD, flatWith(all)).reason).toBe('boundary');
    const noEdge = { ...all, boundaryFactor: () => 0 };
    expect(trace(ORIGIN, FORWARD, flatWith(noEdge)).reason).toBe('footprint');
    expect(trace(ORIGIN, FORWARD, flatWith({ ...noEdge, blocked: () => false })).reason).toBe(
      'tree',
    );
    expect(trace(ORIGIN, FORWARD, flatWith({ treeBlocked: () => false })).reason).toBe('ok');
  });

  it('rejects a landing inside a tree crown as a tree and still reports its hit', () => {
    const out = trace(ORIGIN, FORWARD, flatWith({ treeBlocked: (_x, z) => z < -4 }));
    expect(out.reason).toBe('tree');
    expect(out.valid).toBe(false);
    expect(out.hit).not.toBeNull();
  });

  it('does not cut an arc that flies through a crown: crowns reject landings only', () => {
    const out = trace(ORIGIN, FORWARD, flatWith({ treeBlocked: (_x, z) => z > -3 && z < -2 }));
    expect(out.reason).toBe('ok');
  });
});

describe('an aim that starts inside a building volume', () => {
  const house: Box = { x0: -1, x1: 1, z0: -4, z1: -3, top: 3 };
  const second: Box = { x0: -1, x1: 1, z0: 3, z1: 4, top: 3 };
  const inside: Vec3 = [0, 1, -3.5];

  it('can aim out of it and land past it', () => {
    const out = trace(inside, [0, 0.3, 1], flatWith({ volumes: boxVolumes([house]) }));
    expect(out.reason).toBe('ok');
    const hit = out.hit as Vec3;
    expect(hit[2]).toBeGreaterThan(-3);
    expect(out.count).toBe(MAX_SAMPLES);
    expect(Math.hypot(hit[0] - inside[0], hit[2] - inside[2])).toBeGreaterThan(1);
  });

  it('can aim out of two overlapping volumes and is cut at a third building', () => {
    const tower: Box = { x0: -1, x1: 1, z0: -4, z1: -3, top: 3 };
    const nave: Box = { x0: -3, x1: 3, z0: -3.5, z1: -1, top: 3 };
    const both = boxVolumes([tower, nave, second]);
    const strip: Vec3 = [0, 1, -3.2];
    expect(both.at(...strip)).toBeGreaterThanOrEqual(0);
    const out = trace(strip, [0, 0.6, 1], flatWith({ volumes: both }));
    expect(out.reason).toBe('building');
    const hit = out.hit as Vec3;
    expect(hit[2]).toBeGreaterThan(3);
    expect(hit[2]).toBeLessThan(3.01);
    const free = trace(strip, [0, 0.3, 1], flatWith({ volumes: boxVolumes([tower, nave]) }));
    expect(free.reason).toBe('ok');
    expect(
      Math.hypot((free.hit as Vec3)[0] - strip[0], (free.hit as Vec3)[2] - strip[2]),
    ).toBeGreaterThan(2);
  });

  it('is cut at a second building it crosses after leaving the first', () => {
    const out = trace(inside, [0, 0.6, 1], flatWith({ volumes: boxVolumes([house, second]) }));
    expect(out.reason).toBe('building');
    const hit = out.hit as Vec3;
    expect(hit[2]).toBeGreaterThan(3);
    expect(hit[2]).toBeLessThan(3.01);
  });
});

describe('arcs on the seed-1 village (real volumes)', () => {
  const terrain = createTerrain(1);
  const village = createVillage(1, terrain);
  const cypress = createCypress(1, terrain);
  const world: LandingWorld = {
    ground: { heightAt: terrain.heightAt, normalAt: terrain.normalAt },
    blocked: createFootprintTest(village),
    volumes: createVolumes(village),
    treeBlocked: createCrownTest(cypress, terrain.heightAt),
  };

  it('cuts a level shot at any house before it can land behind it', () => {
    let cut = 0;
    for (const house of village.houses) {
      const [hx, , hz] = house.center;
      const from = Math.hypot(hx, hz);
      // Stand 6 m short of the house on the line from the spot, aim level at its walls.
      const ux = hx / from;
      const uz = hz / from;
      const sx = hx - ux * 6;
      const sz = hz - uz * 6;
      const eye: Vec3 = [sx, terrain.heightAt(sx, sz) + 1.5, sz];
      const out = trace(eye, [ux, 0.05, uz], world);
      if (out.reason !== 'building') continue;
      cut += 1;
      const hit = out.hit as Vec3;
      expect(out.valid).toBe(false);
      expect(Math.hypot(hit[0] - hx, hit[2] - hz)).toBeLessThan(house.width + house.depth);
    }
    expect(cut).toBeGreaterThan(5);
  });

  it('lets no arc through a house volume between samples and still land `ok`', () => {
    const volumes = createVolumes(village);
    let cut = 0;
    let landed = 0;
    for (const house of village.houses) {
      const [hx, , hz] = house.center;
      const sin = Math.sin(house.yaw);
      const cos = Math.cos(house.yaw);
      for (const back of [3, 4, 5, 6, 7, 8, 9]) {
        // On the house's local -z axis (toWorld: x = cx + lz sin, z = cz + lz cos).
        const sx = hx - sin * back;
        const sz = hz - cos * back;
        const eye: Vec3 = [sx, terrain.heightAt(sx, sz) + 1.6, sz];
        if (volumes.at(eye[0], eye[1], eye[2]) >= 0) continue;
        for (let deg = -30; deg <= 75; deg += 0.25) {
          const p = deg * DEG;
          const dir: Vec3 = [sin * Math.cos(p), Math.sin(p), cos * Math.cos(p)];
          const out = trace(eye, dir, world);
          if (out.reason === 'building') cut += 1;
          if (out.reason !== 'ok' || !out.hit) continue;
          landed += 1;
          // Walk the real parabola finely: an accepted arc never touches a volume.
          const tEnd = Math.hypot(out.hit[0] - eye[0], out.hit[2] - eye[2]) / (8 * Math.cos(p));
          for (let k = 0; k <= 4000; k += 1) {
            const t = (k / 4000) * tEnd;
            const y = eye[1] + 8 * dir[1] * t - 4.9 * t * t;
            const x = eye[0] + 8 * dir[0] * t;
            const z = eye[2] + 8 * dir[2] * t;
            if (volumes.at(x, y, z) >= 0) {
              throw new Error(`house ${hx},${hz} back ${back} deg ${deg}: ok arc inside a volume`);
            }
          }
        }
      }
    }
    expect(cut).toBeGreaterThan(50);
    expect(landed).toBeGreaterThan(50);
  });

  describe('an eye in a wall margin, 0.15 m outside the wall of house 0', () => {
    const house = village.houses[0] as (typeof village.houses)[number];
    const [hx, , hz] = house.center;
    const sin = Math.sin(house.yaw);
    const cos = Math.cos(house.yaw);
    const lz = house.depth / 2 + 0.15;
    const ex = hx + lz * sin;
    const ez = hz + lz * cos;
    const eye: Vec3 = [ex, terrain.heightAt(ex, ez) + 1.5, ez];
    /** Local z across the ridge of a world point. */
    const across = (p: Vec3): number => (p[0] - hx) * sin + (p[2] - hz) * cos;
    const volumes = createVolumes(village);

    it('starts in the margin and outside the walls', () => {
      expect(volumes.at(eye[0], eye[1], eye[2])).toBeGreaterThanOrEqual(0);
      expect(Math.abs(across(eye))).toBeGreaterThan(house.depth / 2);
    });

    it('is cut at the wall when aimed through the house, not landed behind it', () => {
      for (const pitch of [0.05, 0.15, 0.3]) {
        const out = trace(eye, [-sin, pitch, -cos], world);
        expect(out.reason, `pitch ${pitch}`).toBe('building');
        const hit = out.hit as Vec3;
        expect(Math.abs(Math.abs(across(hit)) - house.depth / 2)).toBeLessThan(0.05);
        expect(Math.hypot(hit[0] - eye[0], hit[2] - eye[2])).toBeGreaterThan(0.1);
      }
    });

    it('is free when aimed away from the house', () => {
      for (const pitch of [0.05, 0.15, 0.3]) {
        const out = trace(eye, [sin, pitch, cos], world);
        // Another building further out may still cut it, but not this house, beside the eye.
        const hit = out.hit as Vec3;
        expect(Math.hypot(hit[0] - eye[0], hit[2] - eye[2]), `pitch ${pitch}`).toBeGreaterThan(1);
      }
    });
  });

  it('lets an eye inside a house aim out of it', () => {
    const volumes = createVolumes(village);
    const house = village.houses[0] as (typeof village.houses)[number];
    const [hx, , hz] = house.center;
    const eye: Vec3 = [hx, house.center[1] + 1.2, hz];
    expect(volumes.at(eye[0], eye[1], eye[2])).toBeGreaterThanOrEqual(0);
    let free = 0;
    for (let az = 0; az < 360; az += 15) {
      const a = az * DEG;
      const out = trace(eye, [Math.sin(a) * 0.9, 0.4, Math.cos(a) * 0.9], world);
      if (out.hit && Math.hypot(out.hit[0] - hx, out.hit[2] - hz) > 1) free += 1;
    }
    expect(free).toBeGreaterThan(12);
  });

  it('lets an eye in the church tower-nave overlap aim out, and cuts it at another building', () => {
    const volumes = createVolumes(village);
    const [tower, nave] = village.church.walls;
    const inTower = createFootprintTest({ houses: [], church: { walls: [tower, tower] } });
    const inNave = createFootprintTest({ houses: [], church: { walls: [nave, nave] } });
    // The overlap strip: inside both grown rectangles.
    let eye: Vec3 | null = null;
    for (let x = -60; x <= 60 && !eye; x += 0.05) {
      for (let z = -80; z <= 0 && !eye; z += 0.05) {
        if (!inTower(x, z) || !inNave(x, z)) continue;
        const y = terrain.heightAt(x, z) + 1.6;
        if (volumes.at(x, y, z) >= 0) eye = [x, y, z];
      }
    }
    expect(eye, 'a tower-nave overlap point').not.toBeNull();
    const origin = eye as Vec3;
    let aims = 0;
    let moved = 0;
    let cutAtWall = 0;
    for (let az = 0; az < 360; az += 15) {
      const a = az * DEG;
      for (const pitch of [0, 20, 45]) {
        const c = Math.cos(pitch * DEG);
        const out = trace(origin, [Math.sin(a) * c, Math.sin(pitch * DEG), Math.cos(a) * c], world);
        aims += 1;
        if (out.hit && Math.hypot(out.hit[0] - origin[0], out.hit[2] - origin[2]) > 0.5) moved += 1;
        if (out.reason === 'building') cutAtWall += 1;
      }
    }
    // Never collapsed onto the origin: at most the aims that run into the church's own far walls.
    expect(moved).toBeGreaterThan(aims * 0.9);
    // Aims into the church are cut at its wall, not let through.
    expect(cutAtWall).toBeGreaterThan(0);
  });

  it('rejects a landing in the cypress near the spawn as a tree', () => {
    const [bx, , bz] = cypress.main.base;
    const reasons = new Set<string>();
    for (let deg = 0; deg >= -60; deg -= 2) {
      const p = deg * DEG;
      const d = Math.hypot(bx, bz);
      const out = trace(
        [0, terrain.heightAt(0, 0) + 1.6, 0],
        [(bx / d) * Math.cos(p), Math.sin(p), (bz / d) * Math.cos(p)],
        world,
      );
      reasons.add(out.reason);
      if (out.reason === 'tree') {
        const hit = out.hit as Vec3;
        expect(world.treeBlocked?.(hit[0], hit[2])).toBe(true);
        expect(out.valid).toBe(false);
      }
    }
    expect(reasons.has('tree')).toBe(true);
  });
});
