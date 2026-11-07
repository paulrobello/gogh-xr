import { describe, expect, it } from 'vitest';
import {
  ALTITUDE_SOFT_BAND,
  BOUNDARY_PUSH_START,
  boundaryExcess,
  enterFlight,
  exitFlight,
  type FlightBoundary,
  type FlightInput,
  fly,
  MAX_ALTITUDE,
  MAX_FLIGHT_RADIUS,
  radialBoundary,
  VERTICAL_SPEED,
} from '../src/locomotion/flight';
import { DEFAULT_LOCOMOTION_SETTINGS, type LocomotionSettings } from '../src/locomotion/settings';
import {
  calibrateSeated,
  createLocomotionState,
  EXIT_DROP_DURATION,
  FLAT_GROUND,
  type Ground,
  type HeadPose,
  type LocomotionState,
  placeRig,
  smoothstep01,
  spawnAt,
  step,
} from '../src/locomotion/step';
import { boundaryFactor } from '../src/world/boundary';

const STANDING: HeadPose = { x: 0, y: 1.6, z: 0, yaw: 0 };
const IDLE: FlightInput = { move: { x: 0, y: 0 }, sprint: false, vertical: 0 };
const FORWARD: FlightInput = { ...IDLE, move: { x: 0, y: 1 } };
const UP: FlightInput = { ...IDLE, vertical: 1 };
const DOWN: FlightInput = { ...IDLE, vertical: -1 };
const SETTINGS: LocomotionSettings = DEFAULT_LOCOMOTION_SETTINGS;
const SEATED: LocomotionSettings = { ...SETTINGS, seated: true };
/** Rises 0.5 m per metre of +x. */
const SLOPE: Ground = { heightAt: (x) => 0.5 * x };
/** Hills and a 10 m cliff at x = 3, so the cap and floor see sudden ground changes. */
const ROUGH: Ground = {
  heightAt: (x, z) => 4 * Math.sin(0.3 * x) * Math.cos(0.2 * z) + (x > 3 ? 10 : 0),
};
const NO_BOUNDARY: FlightBoundary = {};
const WORLD: FlightBoundary = { boundaryFactor };
/** A boundary that never pushes, so only the 55 m hard clamp holds the flight in. */
const NO_PUSH: FlightBoundary = { boundaryFactor: () => 0 };
const EPSILON = 1e-9;

function flying(x: number, y: number, z: number, yaw = 0): LocomotionState {
  const state = createLocomotionState();
  spawnAt(state, x, y, z, yaw);
  enterFlight(state);
  return state;
}

/** The head's world XZ, as step.ts computes it. */
function headXZ(state: LocomotionState, head: HeadPose): [number, number] {
  const sin = Math.sin(state.yaw);
  const cos = Math.cos(state.yaw);
  return [
    state.position[0] + cos * head.x + sin * head.z,
    state.position[2] - sin * head.x + cos * head.z,
  ];
}

function altitude(state: LocomotionState, ground: Ground, head: HeadPose): number {
  const [hx, hz] = headXZ(state, head);
  return state.position[1] + head.y - ground.heightAt(hx, hz);
}

describe('flight', () => {
  it('turns ground follow off: an idle flight holds its height', () => {
    const state = flying(0, 10, 0);
    for (let i = 0; i < 100; i += 1)
      fly(state, IDLE, FLAT_GROUND, NO_BOUNDARY, SETTINGS, 0.05, STANDING, 0);
    expect(state.mode).toBe('fly');
    expect(state.position).toEqual([0, 10, 0]);
    expect(state.grounded).toBe(false);
    expect(state.altitude).toBeCloseTo(11.6, 12);
  });

  it('moves the left stick along the full 3D head forward, pitch included', () => {
    const pitch = Math.PI / 6;
    const state = flying(0, 10, 0);
    fly(state, FORWARD, FLAT_GROUND, NO_BOUNDARY, SETTINGS, 0.1, STANDING, pitch);
    expect(state.position[0]).toBeCloseTo(0, 12);
    expect(state.position[1]).toBeCloseTo(10 + 0.2 * Math.sin(pitch), 12);
    expect(state.position[2]).toBeCloseTo(-0.2 * Math.cos(pitch), 12);
    expect(state.speed).toBeCloseTo(2, 12);
  });

  it('follows the rig yaw plus the head yaw, and Shift sprints to 3 m/s', () => {
    // Rig yaw 30° plus head yaw 60°: facing -X. Pitched 45° down.
    const head = { ...STANDING, yaw: Math.PI / 3 };
    const state = flying(0, 20, 0, Math.PI / 6);
    fly(
      state,
      { ...FORWARD, sprint: true },
      FLAT_GROUND,
      NO_BOUNDARY,
      SETTINGS,
      0.1,
      head,
      -Math.PI / 4,
    );
    expect(state.position[0]).toBeCloseTo(-0.3 * Math.SQRT1_2, 12);
    expect(state.position[1]).toBeCloseTo(20 - 0.3 * Math.SQRT1_2, 12);
    expect(state.position[2]).toBeCloseTo(0, 12);
  });

  it('keeps strafing level whatever the pitch', () => {
    const state = flying(0, 10, 0);
    fly(
      state,
      { ...IDLE, move: { x: 1, y: 0 } },
      FLAT_GROUND,
      NO_BOUNDARY,
      SETTINGS,
      0.1,
      STANDING,
      1.2,
    );
    expect(state.position[0]).toBeCloseTo(0.2, 12);
    expect(state.position[1]).toBe(10);
    expect(state.position[2]).toBeCloseTo(0, 12);
  });

  it('moves vertically at 2 m/s times the right stick Y', () => {
    const state = flying(0, 10, 0);
    fly(state, UP, FLAT_GROUND, NO_BOUNDARY, SETTINGS, 0.1, STANDING, 0);
    expect(state.position[1]).toBeCloseTo(10 + VERTICAL_SPEED * 0.1, 12);
    fly(state, { ...IDLE, vertical: -0.5 }, FLAT_GROUND, NO_BOUNDARY, SETTINGS, 0.1, STANDING, 0);
    expect(state.position[1]).toBeCloseTo(10 + 0.1, 12);
  });

  it('soft-caps the altitude at 40 m: upward speed scales by the remaining share of the last 5 m', () => {
    const state = flying(0, 34.8, 0);
    // Head at 36.4 m: 3.6 m of the 5 m band remain, so 72% of 2 m/s.
    fly(state, UP, FLAT_GROUND, NO_BOUNDARY, SETTINGS, 0.01, STANDING, 0);
    expect(state.position[1]).toBeCloseTo(34.8 + 0.02 * (3.6 / ALTITUDE_SOFT_BAND), 12);
    // Below the band the speed is full.
    const low = flying(0, 10, 0);
    fly(low, UP, FLAT_GROUND, NO_BOUNDARY, SETTINGS, 0.01, STANDING, 0);
    expect(low.position[1]).toBeCloseTo(10.02, 12);
    // Downward speed is never scaled.
    const top = flying(0, MAX_ALTITUDE - 1.6, 0);
    fly(top, DOWN, FLAT_GROUND, NO_BOUNDARY, SETTINGS, 0.1, STANDING, 0);
    expect(top.position[1]).toBeCloseTo(MAX_ALTITUDE - 1.6 - 0.2, 12);
  });

  it('never takes the head above 40 m + ε, whatever the input, dt, ground or head', () => {
    const heads: HeadPose[] = [
      STANDING,
      { x: 0.8, y: 1.95, z: -0.4, yaw: 0.7 },
      { x: 0, y: 0, z: 0, yaw: 0 },
    ];
    const dts = [1 / 120, 1 / 72, 0.05, 0.1, 0.5];
    for (const ground of [FLAT_GROUND, SLOPE, ROUGH]) {
      for (const head of heads) {
        for (const dt of dts) {
          const state = flying(0, ground.heightAt(0, 0), 0);
          let top = 0;
          for (let i = 0; i < 4000; i += 1) {
            // Climb at full stick, looking 60° up, sprinting, while drifting over the cliff and back.
            const input: FlightInput = {
              move: { x: Math.sin(i * 0.01), y: 1 },
              sprint: true,
              vertical: 1,
            };
            fly(state, input, ground, NO_BOUNDARY, SETTINGS, dt, head, Math.PI / 3);
            const a = altitude(state, ground, head);
            expect(a).toBeLessThanOrEqual(MAX_ALTITUDE + EPSILON);
            expect(state.altitude).toBeCloseTo(a, 9);
            top = Math.max(top, a);
          }
          // A head below the 1.6 m standing eye caps as if at it, so it tops out that much lower.
          expect(top).toBeGreaterThan(MAX_ALTITUDE - Math.max(0, 1.6 - head.y) - 0.5);
        }
      }
    }
  });

  it('clamps at once when the ground under a capped flight falls away', () => {
    const state = flying(0, MAX_ALTITUDE - 1.6 + 10, 0);
    // Over the cliff top at x = 3.5 the head is at the cap; step back off the cliff.
    state.position[0] = 3.5;
    fly(state, IDLE, ROUGH, NO_BOUNDARY, SETTINGS, 0.01, STANDING, 0);
    expect(altitude(state, ROUGH, STANDING)).toBeLessThanOrEqual(MAX_ALTITUDE + EPSILON);
    state.position[0] = 2.9;
    fly(state, IDLE, ROUGH, NO_BOUNDARY, SETTINGS, 0.01, STANDING, 0);
    expect(altitude(state, ROUGH, STANDING)).toBeLessThanOrEqual(MAX_ALTITUDE + EPSILON);
  });

  it('never sinks below the terrain: a standing eye stays at least 1.6 m above it', () => {
    for (const ground of [FLAT_GROUND, SLOPE, ROUGH]) {
      const state = flying(0, ground.heightAt(0, 0) + 5, 0);
      for (let i = 0; i < 600; i += 1) {
        const input: FlightInput = { move: { x: 0.3, y: 1 }, sprint: false, vertical: -1 };
        fly(state, input, ground, NO_BOUNDARY, SETTINGS, 0.05, STANDING, -Math.PI / 3);
        const [hx, hz] = headXZ(state, STANDING);
        expect(state.position[1]).toBeGreaterThanOrEqual(ground.heightAt(hx, hz) - EPSILON);
        expect(altitude(state, ground, STANDING)).toBeGreaterThanOrEqual(1.6 - EPSILON);
      }
    }
  });

  it('keeps the seated offset on the floor', () => {
    const seatedHead = { ...STANDING, y: 1.1 };
    const state = flying(0, 10, 0);
    calibrateSeated(state, SEATED, seatedHead.y);
    for (let i = 0; i < 400; i += 1)
      fly(state, DOWN, SLOPE, NO_BOUNDARY, SEATED, 0.05, seatedHead, 0);
    expect(state.position[1]).toBeCloseTo(0.5, 12);
    expect(state.altitude).toBeCloseTo(1.6, 12);
  });
});

describe('the flight boundary', () => {
  it('reads the radial factor at ground level, so a high flight over the origin is not pushed', () => {
    expect(boundaryFactor([0, 39, 0])).toBeGreaterThan(BOUNDARY_PUSH_START);
    expect(radialBoundary(WORLD, 0, 0)).toBe(0);
    expect(radialBoundary(WORLD, 48, 0)).toBeCloseTo(boundaryFactor([48, 0, 0]), 12);
    expect(radialBoundary(NO_BOUNDARY, 60, 0)).toBe(0);
    const state = flying(5, 37, 0);
    for (let i = 0; i < 100; i += 1)
      fly(state, IDLE, FLAT_GROUND, WORLD, SETTINGS, 0.05, STANDING, 0);
    expect(state.position[0]).toBe(5);
    expect(state.position[2]).toBe(0);
  });

  it('pushes inward above factor 0.8, harder toward the edge, and not at all below it', () => {
    expect(boundaryExcess(0.5)).toBe(0);
    expect(boundaryExcess(BOUNDARY_PUSH_START)).toBe(0);
    expect(boundaryExcess(0.9)).toBeCloseTo(0.5, 12);
    expect(boundaryExcess(1)).toBe(1);
    // Factor at 46 m is under 0.8: no push.
    expect(boundaryFactor([46, 0, 0])).toBeLessThan(BOUNDARY_PUSH_START);
    const inside = flying(46, 5, 0);
    fly(inside, IDLE, FLAT_GROUND, WORLD, SETTINGS, 0.1, STANDING, 0);
    expect(inside.position[0]).toBe(46);
    // Factor about 0.9 at 49 m, 1 at 50 m.
    const near = flying(49, 5, 0);
    fly(near, IDLE, FLAT_GROUND, WORLD, SETTINGS, 0.1, STANDING, 0);
    const far = flying(0, 5, -50);
    fly(far, IDLE, FLAT_GROUND, WORLD, SETTINGS, 0.1, STANDING, 0);
    const nearPush = 49 - near.position[0];
    const farPush = far.position[2] + 50;
    expect(nearPush).toBeGreaterThan(0);
    expect(farPush).toBeGreaterThan(nearPush);
    expect(far.position[0]).toBeCloseTo(0, 12);
  });

  it('drifts an idle flight back inside the push band', () => {
    const state = flying(0, 5, -52);
    for (let i = 0; i < 2000; i += 1)
      fly(state, IDLE, FLAT_GROUND, WORLD, SETTINGS, 0.05, STANDING, 0);
    expect(radialBoundary(WORLD, state.position[0], state.position[2])).toBeLessThanOrEqual(
      BOUNDARY_PUSH_START + 1e-3,
    );
  });

  it('never lets the head leave 55 m, with or without the push, from any heading', () => {
    const heads: HeadPose[] = [STANDING, { x: 1.2, y: 1.6, z: 0.9, yaw: -0.4 }];
    for (const world of [WORLD, NO_PUSH]) {
      for (const head of heads) {
        for (let k = 0; k < 8; k += 1) {
          const yaw = (k * Math.PI) / 4;
          const state = flying(0, 5, 0, yaw);
          let reach = 0;
          for (let i = 0; i < 1500; i += 1) {
            const input: FlightInput = { move: { x: 0.2, y: 1 }, sprint: true, vertical: 0 };
            fly(state, input, FLAT_GROUND, world, SETTINGS, 0.1, head, 0);
            const [hx, hz] = headXZ(state, head);
            reach = Math.max(reach, Math.hypot(hx, hz));
            expect(Math.hypot(hx, hz)).toBeLessThanOrEqual(MAX_FLIGHT_RADIUS + EPSILON);
          }
          // Without the push, the clamp itself is what holds the flight.
          if (world === NO_PUSH) expect(reach).toBeCloseTo(MAX_FLIGHT_RADIUS, 9);
        }
      }
    }
  });

  it('has no radius clamp without a world boundary', () => {
    const state = flying(0, 5, 0);
    for (let i = 0; i < 400; i += 1)
      fly(
        state,
        { ...FORWARD, sprint: true },
        FLAT_GROUND,
        NO_BOUNDARY,
        SETTINGS,
        0.1,
        STANDING,
        0,
      );
    expect(-state.position[2]).toBeCloseTo(120, 9);
  });
});

describe('the exit drop', () => {
  /** Steps walk frames of `dts` after leaving flight, recording y after each. */
  function drop(
    state: LocomotionState,
    dts: readonly number[],
    ground: Ground,
    settings: LocomotionSettings,
    head: HeadPose = STANDING,
  ): number[] {
    exitFlight(state);
    const ys: number[] = [];
    for (const dt of dts) {
      step(state, IDLE, ground, settings, dt, head);
      ys.push(state.position[1]);
    }
    return ys;
  }

  it('eases onto the ground along a smoothstep over exactly 0.5 s', () => {
    const dt = 1 / 72;
    const frames = Math.round(EXIT_DROP_DURATION / dt);
    const state = flying(2, 20, 0);
    const from = state.position[1];
    const target = SLOPE.heightAt(2, 0);
    const ys = drop(state, Array(frames + 10).fill(dt), SLOPE, SETTINGS);
    const span = from - target;
    let previous = from;
    for (let i = 0; i < frames; i += 1) {
      const fall = previous - ys[i];
      // Continuous: each frame moves exactly the smoothstep's share of the drop for that frame.
      const expected =
        span *
        (smoothstep01(((i + 1) * dt) / EXIT_DROP_DURATION) -
          smoothstep01((i * dt) / EXIT_DROP_DURATION));
      expect(fall).toBeCloseTo(expected, 9);
      // Never more than the smoothstep's peak slope (1.5) times the frame's linear share.
      expect(fall).toBeLessThanOrEqual(1.5 * span * (dt / EXIT_DROP_DURATION) + EPSILON);
      expect(fall).toBeGreaterThanOrEqual(0);
      previous = ys[i];
    }
    // Lands exactly on the ground at 0.5 s, then ground follow holds it there.
    expect(ys[frames - 1]).toBe(target);
    expect(state.dropping).toBe(false);
    expect(state.grounded).toBe(true);
    for (const y of ys.slice(frames)) expect(y).toBe(target);
  });

  it('lands on the ground plus the seated offset, with uneven frame times', () => {
    const seatedHead = { ...STANDING, y: 1.2 };
    const state = flying(-1, 15, 0);
    calibrateSeated(state, SEATED, seatedHead.y);
    const dts = [0.013, 0.021, 0.008, 0.1, 0.017, 0.05, 0.033, 0.011, 0.1, 0.09, 0.05, 0.02];
    let elapsed = 0;
    let index = -1;
    for (let i = 0; i < dts.length; i += 1) {
      elapsed += dts[i];
      if (index < 0 && elapsed >= EXIT_DROP_DURATION - EPSILON) index = i;
    }
    const ys = drop(state, dts, SLOPE, SEATED, seatedHead);
    const target = SLOPE.heightAt(-1, 0) + state.seatedOffset;
    expect(index).toBeGreaterThan(0);
    for (let i = 0; i < index; i += 1) expect(ys[i]).toBeGreaterThan(target);
    expect(ys[index]).toBe(target);
    expect(state.position[1]).toBe(target);
  });

  it('tracks a moving ground target: walking during the drop still lands exactly', () => {
    const state = flying(0, 12, 0);
    exitFlight(state);
    const right = { move: { x: 1, y: 0 }, sprint: false };
    for (let i = 0; i < 25; i += 1) step(state, right, SLOPE, SETTINGS, 0.02, STANDING);
    expect(state.dropping).toBe(false);
    expect(state.position[1]).toBeCloseTo(SLOPE.heightAt(state.position[0], 0), 12);
  });

  it('holds the drop while the ground is unbound, then resumes it', () => {
    const state = flying(0, 8, 0);
    exitFlight(state);
    step(state, IDLE, null, SETTINGS, 0.1, STANDING);
    expect(state.position[1]).toBe(8);
    expect(state.dropping).toBe(true);
    for (let i = 0; i < 5; i += 1) step(state, IDLE, FLAT_GROUND, SETTINGS, 0.1, STANDING);
    expect(state.position[1]).toBe(0);
  });

  it('is cancelled by re-entering flight, which keeps the current height', () => {
    const state = flying(0, 10, 0);
    exitFlight(state);
    step(state, IDLE, FLAT_GROUND, SETTINGS, 0.1, STANDING);
    const y = state.position[1];
    enterFlight(state);
    expect(state.dropping).toBe(false);
    fly(state, IDLE, FLAT_GROUND, NO_BOUNDARY, SETTINGS, 0.1, STANDING, 0);
    expect(state.position[1]).toBe(y);
  });

  it('is cleared by a spawn', () => {
    const state = flying(0, 10, 0);
    exitFlight(state);
    spawnAt(state, 1, 2, 3, 0);
    expect(state.mode).toBe('walk');
    expect(state.dropping).toBe(false);
  });
});

describe('fix round 1', () => {
  it('caps a pose-less head (y 0) at the standing eye, so the first real pose stays under 40 m', () => {
    const noPose: HeadPose = { x: 0, y: 0, z: 0, yaw: 0 };
    const state = flying(0, 10, 0);
    for (let i = 0; i < 2000; i += 1)
      fly(state, UP, FLAT_GROUND, NO_BOUNDARY, SETTINGS, 0.1, noPose, 0);
    expect(state.position[1]).toBeLessThanOrEqual(MAX_ALTITUDE - 1.6 + EPSILON);
    // The first real standing pose renders at or below the cap before any step runs.
    expect(altitude(state, FLAT_GROUND, STANDING)).toBeLessThanOrEqual(MAX_ALTITUDE + EPSILON);
    // A seated head caps at its own height: the seated eye still reaches the cap.
    const seatedHead = { ...STANDING, y: 1.1 };
    const seated = flying(0, 10, 0);
    calibrateSeated(seated, SEATED, seatedHead.y);
    for (let i = 0; i < 2000; i += 1)
      fly(seated, UP, FLAT_GROUND, NO_BOUNDARY, SEATED, 0.1, seatedHead, 0);
    expect(altitude(seated, FLAT_GROUND, seatedHead)).toBeLessThanOrEqual(MAX_ALTITUDE + EPSILON);
    expect(altitude(seated, FLAT_GROUND, seatedHead)).toBeGreaterThan(MAX_ALTITUDE - 0.01);
  });

  it('records the boundary push speed for the vignette, and 0 without a push', () => {
    const far = flying(0, 5, -50);
    fly(far, IDLE, FLAT_GROUND, WORLD, SETTINGS, 0.05, STANDING, 0);
    expect(far.speed).toBe(0);
    expect(far.pushSpeed).toBeCloseTo(3, 12);
    const inside = flying(0, 5, -10);
    fly(inside, IDLE, FLAT_GROUND, WORLD, SETTINGS, 0.05, STANDING, 0);
    expect(inside.pushSpeed).toBe(0);
    exitFlight(far);
    expect(far.pushSpeed).toBe(0);
  });

  it('keeps the altitude current while a placed pose holds the rig', () => {
    const state = createLocomotionState();
    placeRig(state, 2, 7, 0, 0);
    step(state, IDLE, SLOPE, SETTINGS, 0.05, STANDING);
    expect(state.held).toBe(true);
    expect(state.altitude).toBeCloseTo(7 + 1.6 - SLOPE.heightAt(2, 0), 12);
    // Unbound ground: nothing to measure against, so it keeps the last value.
    step(state, IDLE, null, SETTINGS, 0.05, STANDING);
    expect(state.altitude).toBeCloseTo(7.6, 12);
  });
});
