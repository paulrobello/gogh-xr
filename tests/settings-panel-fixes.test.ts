import { Quaternion, Vector3 } from 'three';
import { expect, test } from 'vitest';
import {
  CONTROL_Z,
  createHitScratch,
  createPanelInteraction,
  createPanelPose,
  nearestHit,
  rayHits,
} from '../src/ui/panel-core.ts';
import { controlLayout, LAYOUT, MIN_TARGET, ROW_PITCH } from '../src/ui/panel-layout.ts';
import {
  fromStored,
  MAX_DISTANCE,
  MIN_DISTANCE,
  parsePanelPose,
  toStored,
} from '../src/ui/panel-pose.ts';
import { createTextThrottle } from '../src/ui/text-throttle.ts';
import { createInput, type KeyboardState } from '../src/xr/input.ts';

const keys: KeyboardState = { keys: new Set(), mouseButtons: new Set() };

function rightTrigger(down: boolean) {
  return [
    {
      handedness: 'right',
      gamepad: {
        mapping: 'xr-standard',
        axes: [0, 0, 0, 0],
        buttons: [{ pressed: down }, { pressed: false }],
      },
    },
  ];
}

test('a trigger held across a Recenter press never reaches select', () => {
  const pose = createPanelPose();
  pose.position.set(0, 1.4, -1);
  const button = controlLayout('recenter');
  if (!button) throw new Error('no recenter');
  const target = new Vector3(button.rect.x, 1.4 + button.rect.y, -1 + CONTROL_Z);
  const origin = new Vector3(0, 1.3, -0.3);
  const direction = target.clone().sub(origin).normalize();
  const quaternion = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), direction);
  const input = createInput();
  // main.ts's recenter: suppress held buttons, then the panel resets its hands.
  const ui = createPanelInteraction({
    press: (hit) => {
      if (hit.id === 'recenter') {
        input.suppressHeld();
        ui.reset();
      }
    },
    drag: () => undefined,
    release: () => undefined,
    grabEnd: () => undefined,
  });
  const seen: boolean[] = [];
  for (let i = 0; i < 5; i += 1) {
    const a = input.read(rightTrigger(true), keys, 0.016);
    const h = a.hands.right;
    const f = ui.frame(
      {
        right: {
          origin,
          direction,
          position: origin,
          quaternion,
          trigger: h.trigger,
          grip: h.grip,
          stick: h.stick,
        },
      },
      pose,
      i * 16,
    );
    input.claim(f.claimed.left, f.claimed.right);
    seen.push(a.select.down, a.select.fired);
  }
  expect(seen.every((v) => v === false)).toBe(true);
  // Released and pressed again off the panel, the trigger selects as usual.
  input.read(rightTrigger(false), keys, 0.016);
  expect(input.read(rightTrigger(true), keys, 0.016).select).toEqual({ down: true, fired: true });
});

test('the text throttle assigns at most once per 100 ms, and a forced flush lands the last value', () => {
  const assigned: number[] = [];
  let now = 0;
  let value = '';
  const target = {
    get text() {
      return value;
    },
    set text(next: string) {
      value = next;
      assigned.push(now);
    },
  };
  const texts = createTextThrottle(100);
  // A drag that changes the text every 11 ms for half a second.
  for (let i = 0; i <= 45; i += 1) {
    now = i * 11;
    texts.set(target, `v${i}`);
    texts.flush(now, false);
  }
  for (let i = 1; i < assigned.length; i += 1) {
    expect((assigned[i] ?? 0) - (assigned[i - 1] ?? 0)).toBeGreaterThanOrEqual(100);
  }
  expect(assigned.length).toBeLessThanOrEqual(5);
  // The release forces the last value through at once.
  texts.flush(now, true);
  expect(value).toBe('v45');
  // An unchanged value queues nothing.
  texts.set(target, 'v45');
  expect(texts.pending).toBe(false);
});

test('every hit target is at least 2.5 cm in both directions, and rows leave 6 mm under a control', () => {
  for (const { def, rect, segments } of LAYOUT) {
    expect([def.id, rect.w >= MIN_TARGET, rect.h >= MIN_TARGET]).toEqual([def.id, true, true]);
    for (const s of segments) {
      expect([def.id, s.w >= MIN_TARGET, s.h >= MIN_TARGET]).toEqual([def.id, true, true]);
    }
  }
  // A row's control spans its top - 0.024 to its top - 0.056, plus about 2 mm of painted border.
  expect(ROW_PITCH - 0.056 - 0.002).toBeGreaterThanOrEqual(0.004);
});

test('quality shows three segments, adaptive-72 first, each label inside its segment', () => {
  const quality = controlLayout('quality');
  expect(quality?.def.options?.map((o) => o.value)).toEqual([
    'adaptive-72',
    'adaptive-90',
    'beauty-72',
  ]);
  for (const [i, s] of (quality?.segments ?? []).entries()) {
    expect(s.w).toBeGreaterThanOrEqual(MIN_TARGET);
    // Noto Sans averages about 0.6 em a character: a 0.016 m label must leave a margin.
    const label = quality?.def.options?.[i]?.label ?? '';
    expect(label.length * 0.6 * 0.016).toBeLessThan(s.w - 0.01);
  }
});

test('a pose pushed past the load bounds saves inside them, along the same direction', () => {
  const head = { position: new Vector3(0, 1.6, 0), yaw: 0 };
  const far = createPanelPose();
  far.position.set(0, 1.6, -3.2);
  const stored = toStored(far, head);
  expect(Math.hypot(...stored.offset)).toBeCloseTo(MAX_DISTANCE, 6);
  expect(stored.offset[2]).toBeLessThan(0);
  const near = createPanelPose();
  near.position.set(0, 1.6, -0.1);
  expect(Math.hypot(...toStored(near, head).offset)).toBeCloseTo(MIN_DISTANCE, 6);
  const restored = fromStored(stored, head, createPanelPose());
  expect(restored.position.distanceTo(new Vector3(0, 1.6, -MAX_DISTANCE))).toBeLessThan(1e-6);
});

test('a clamped pose survives the real save and load path in any direction', () => {
  let seed = 7;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pose = createPanelPose();
  let failures = 0;
  for (let i = 0; i < 2000; i += 1) {
    const head = {
      position: new Vector3(rand() * 4 - 2, 1 + rand(), rand() * 4 - 2),
      yaw: rand() * 2 * Math.PI - Math.PI,
    };
    const direction = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    const far = i % 2 === 0;
    const distance = far ? MAX_DISTANCE + rand() * 3 : rand() * MIN_DISTANCE * 0.99 + 0.001;
    pose.position.copy(head.position).addScaledVector(direction, distance);
    const loaded = parsePanelPose(JSON.stringify(toStored(pose, head)));
    if (!loaded) {
      failures += 1;
      continue;
    }
    expect(Math.hypot(...loaded.offset)).toBeCloseTo(far ? MAX_DISTANCE : MIN_DISTANCE, 6);
  }
  expect(failures).toBe(0);
});

test('nearestHit writes into a reused scratch and agrees with rayHits', () => {
  const pose = createPanelPose();
  pose.position.set(0, 1.4, -1);
  const v = controlLayout('vignette');
  if (!v) throw new Error('no vignette');
  const origin = new Vector3(0.1, 1.3, -0.2);
  const scratch = createHitScratch();
  for (const target of [
    new Vector3(v.rect.x, 1.4 + v.rect.y, -1 + CONTROL_Z),
    new Vector3(0, 1.4 + 0.27, -1),
  ]) {
    const direction = target.clone().sub(origin).normalize();
    const hit = nearestHit(origin, direction, pose, scratch);
    const first = rayHits(origin, direction, pose)[0];
    expect(hit).toBe(scratch);
    expect(hit?.distance).toBeCloseTo(first?.distance ?? Number.NaN, 12);
    expect(hit?.control?.id ?? null).toBe(first?.control?.id ?? null);
    expect(hit?.point.distanceTo(first?.point ?? new Vector3())).toBeLessThan(1e-12);
  }
  const away = new Vector3(0, 0, 1);
  expect(nearestHit(origin, away, pose, scratch)).toBeNull();
});
