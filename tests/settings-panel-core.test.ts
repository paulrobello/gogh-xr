import { Quaternion, Vector3 } from 'three';
import { expect, test } from 'vitest';
import {
  CONTROL_Z,
  clampPanelScale,
  createPanelInteraction,
  createPanelPose,
  type HandInput,
  MAX_PANEL_SCALE,
  MAX_PUSH_DEPTH,
  MIN_PANEL_SCALE,
  MIN_PUSH_DEPTH,
  nearestHit,
  type PanelCallbacks,
  type PanelPose,
  rayHits,
  STICK_TURN_RATE,
  TOOLTIP_DELAY_MS,
} from '../src/ui/panel-core.ts';
import { controlLayout, PANEL_W } from '../src/ui/panel-layout.ts';
import type { ButtonAction } from '../src/xr/input.ts';

/** A panel 1 m ahead of the rig origin at eye height, facing back at it (+Z toward the viewer). */
function pose(): PanelPose {
  const p = createPanelPose();
  p.position.set(0, 1.4, -1);
  return p;
}

/** A unit ray from `origin` toward `target`. */
function ray(origin: Vector3, target: Vector3): { origin: Vector3; direction: Vector3 } {
  return { origin, direction: target.clone().sub(origin).normalize() };
}

/** A panel-local point on the default pose, in rig space. */
function onPanel(x: number, y: number, z = 0): Vector3 {
  return new Vector3(x, 1.4 + y, -1 + z);
}

function button(down: boolean, fired = down): ButtonAction {
  return { down, fired };
}

function hand(
  origin: Vector3,
  target: Vector3,
  trigger: ButtonAction = button(false),
  grip: ButtonAction = button(false),
): HandInput {
  const r = ray(origin, target);
  const quaternion = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), r.direction);
  return { ...r, position: origin.clone(), quaternion, trigger, grip };
}

function recorder(): PanelCallbacks & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    press: (hit, h) => log.push(`press ${hit.id} ${h}`),
    drag: (id, _x, h) => log.push(`drag ${id} ${h}`),
    release: (id, h) => log.push(`release ${id} ${h}`),
    grabEnd: () => log.push('grabEnd'),
  };
}

const vignette = controlLayout('vignette');
if (!vignette) throw new Error('no vignette control');
const vignetteAt = onPanel(vignette.rect.x, vignette.rect.y, CONTROL_Z);

test('the nearest hit wins: a control proud of the backing beats the backing behind it', () => {
  const r = ray(new Vector3(0, 1.4, 0), vignetteAt);
  const hits = rayHits(r.origin, r.direction, pose());
  expect(hits.map((h) => h.control?.id ?? 'backing')).toEqual(['vignette', 'backing']);
  expect(hits[0]?.distance).toBeLessThan(hits[1]?.distance ?? 0);
  const nearest = nearestHit(r.origin, r.direction, pose());
  expect(nearest?.control?.id).toBe('vignette');
  // The contact marker sits at the hit: on the ray, at its distance, on the control plane.
  const point = nearest?.point as Vector3;
  expect(point.distanceTo(vignetteAt)).toBeLessThan(1e-9);
  expect(point.distanceTo(r.origin)).toBeCloseTo(nearest?.distance ?? 0, 9);
});

test('hits behind the ray origin, beside the panel or on the back of a control never count', () => {
  const p = pose();
  // Pointing away from the panel.
  const away = ray(new Vector3(0, 1.4, 0), new Vector3(0, 1.4, 1));
  expect(rayHits(away.origin, away.direction, p)).toEqual([]);
  // Past the panel's edge.
  const beside = ray(new Vector3(0, 1.4, 0), onPanel(PANEL_W, 0));
  expect(rayHits(beside.origin, beside.direction, p)).toEqual([]);
  // From behind: the backing is a grab surface, the controls are not.
  const behind = ray(new Vector3(vignette.rect.x, 1.4 + vignette.rect.y, -2), vignetteAt);
  expect(rayHits(behind.origin, behind.direction, p).map((h) => h.control)).toEqual([null]);
});

test('grip on a control grabs the panel and never activates the control', () => {
  const calls = recorder();
  const ui = createPanelInteraction(calls);
  const p = pose();
  const origin = new Vector3(0.1, 1.3, -0.3);
  const f = ui.frame({ right: hand(origin, vignetteAt, button(false), button(true)) }, p, 0);
  expect(f.hands.right.grabbing).toBe(true);
  expect(f.claimed.right).toBe(true);
  // A trigger press while the grip holds still operates nothing.
  ui.frame({ right: hand(origin, vignetteAt, button(true), button(true, false)) }, p, 16);
  ui.frame({ right: hand(origin, vignetteAt, button(false), button(false)) }, p, 32);
  expect(calls.log).toEqual(['grabEnd']);
});

test('the trigger operates the control and is claimed until release; a grip cancels a drag', () => {
  const calls = recorder();
  const ui = createPanelInteraction(calls);
  const p = pose();
  const origin = new Vector3(0.1, 1.3, -0.3);
  const f = ui.frame({ right: hand(origin, vignetteAt, button(true)) }, p, 0);
  expect(f.claimed.right).toBe(true);
  ui.frame({ right: hand(origin, vignetteAt, button(true, false)) }, p, 16);
  // The laser leaves the panel: the press stays captured until release.
  const off = ui.frame(
    { right: hand(origin, new Vector3(5, 1.3, -0.3), button(true, false)) },
    p,
    32,
  );
  expect(off.claimed.right).toBe(true);
  ui.frame({ right: hand(origin, vignetteAt, button(false)) }, p, 48);
  expect(calls.log.slice(0, 2)).toEqual(['press vignette right', 'drag vignette right']);
  expect(calls.log.at(-1)).toBe('release vignette right');
  const done = ui.frame({ right: hand(origin, vignetteAt, button(false)) }, p, 64);
  expect(done.claimed.right).toBe(false);

  calls.log.length = 0;
  ui.frame({ right: hand(origin, vignetteAt, button(true)) }, p, 80);
  ui.frame({ right: hand(origin, vignetteAt, button(true, false), button(true)) }, p, 96);
  expect(calls.log).toEqual(['press vignette right', 'release vignette right']);
});

test('a trigger off the panel is not claimed, so the action frame keeps it', () => {
  const ui = createPanelInteraction(recorder());
  const f = ui.frame(
    { left: hand(new Vector3(0, 1.3, 0), new Vector3(3, 1.3, 0), button(true)) },
    pose(),
    0,
  );
  expect(f.claimed.left).toBe(false);
});

test('one-hand grab carries the panel rigidly with the controller, scale untouched', () => {
  const ui = createPanelInteraction(recorder());
  const p = pose();
  const origin = new Vector3(0.1, 1.3, -0.3);
  ui.frame({ right: hand(origin, vignetteAt, button(false), button(true)) }, p, 0);
  const moved = origin.clone().add(new Vector3(0.2, 0.1, 0));
  const h = hand(
    moved,
    vignetteAt.clone().add(new Vector3(0.2, 0.1, 0)),
    button(false),
    button(true, false),
  );
  // Same orientation as before: aim the moved controller parallel to the first ray.
  h.quaternion.copy(hand(origin, vignetteAt).quaternion);
  ui.frame({ right: h }, p, 16);
  expect(p.position.distanceTo(new Vector3(0.2, 1.5, -1))).toBeLessThan(1e-9);
  expect(p.scale).toBe(1);
});

test('two-hand scaling follows the hand spread and is bounded to 0.5-1.8', () => {
  const ui = createPanelInteraction(recorder());
  const p = pose();
  const target = onPanel(0, 0);
  const at = (lx: number, rx: number, fired: boolean) => ({
    left: hand(new Vector3(lx, 1.3, -0.3), target, button(false), button(true, fired)),
    right: hand(new Vector3(rx, 1.3, -0.3), target, button(false), button(true, fired)),
  });
  ui.frame(at(-0.1, 0.1, true), p, 0);
  ui.frame(at(-0.15, 0.15, false), p, 16);
  expect(p.scale).toBeCloseTo(1.5, 9);
  ui.frame(at(-1, 1, false), p, 32);
  expect(p.scale).toBe(MAX_PANEL_SCALE);
  ui.frame(at(-0.01, 0.01, false), p, 48);
  expect(p.scale).toBe(MIN_PANEL_SCALE);
  // Releasing one grip continues with the other, without a jump.
  const before = p.position.clone();
  const one = at(-0.01, 0.01, false);
  ui.frame({ left: one.left, right: { ...one.right, grip: button(false) } }, p, 64);
  expect(p.position.distanceTo(before)).toBeLessThan(1e-9);
  expect(p.scale).toBe(MIN_PANEL_SCALE);
});

test('one hand: grip + stick yaws and pitches the panel about its own axes, in place, scale untouched', () => {
  const ui = createPanelInteraction(recorder());
  const p = pose();
  const origin = new Vector3(0.1, 1.3, -0.3);
  const held = (x: number, y: number, now: number) =>
    ui.frame(
      {
        right: { ...hand(origin, vignetteAt, button(false), button(true, false)), stick: { x, y } },
      },
      p,
      now,
    );
  ui.frame({ right: hand(origin, vignetteAt, button(false), button(true)) }, p, 0);
  const start = p.position.clone();
  // Stick right yaws positive about the panel's own Y.
  held(1, 0, 100);
  const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), STICK_TURN_RATE * 0.1);
  expect(p.quaternion.angleTo(yaw)).toBeLessThan(1e-6);
  // Stick back (raw gamepad +Y) pitches positive about the panel's own X.
  held(0, -1, 200);
  const pitch = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), STICK_TURN_RATE * 0.1);
  expect(p.quaternion.angleTo(yaw.clone().multiply(pitch))).toBeLessThan(1e-6);
  expect(p.position.distanceTo(start)).toBeLessThan(1e-9);
  // A long frame integrates at most 0.1 s.
  held(1, 0, 5000);
  const capped = yaw.clone().multiply(pitch).multiply(yaw);
  expect(p.quaternion.angleTo(capped)).toBeLessThan(1e-6);
  expect(p.scale).toBe(1);
});

test('one hand: grip + trigger + stick pushes along the laser within 0.15-2.5 m and rolls about it', () => {
  const calls = recorder();
  const ui = createPanelInteraction(calls);
  const p = pose();
  // Straight at the panel's centre, so the laser is -Z and the centre sits on it.
  const origin = new Vector3(0, 1.4, 0);
  const target = onPanel(0, 0);
  const held = (x: number, y: number, now: number) =>
    ui.frame(
      {
        right: {
          ...hand(origin, target, button(true, false), button(true, false)),
          stick: { x, y },
        },
      },
      p,
      now,
    );
  ui.frame({ right: hand(origin, target, button(false), button(true)) }, p, 0);
  held(0, 1, 100);
  expect(p.position.distanceTo(new Vector3(0, 1.4, -1.1))).toBeLessThan(1e-9);
  // 0.1 s frames from t = 0.2 s.
  for (let i = 0; i < 40; i += 1) held(0, -1, 200 + i * 100);
  expect(p.position.distanceTo(origin)).toBeCloseTo(MIN_PUSH_DEPTH, 9);
  for (let i = 0; i < 40; i += 1) held(0, 1, 4200 + i * 100);
  expect(p.position.distanceTo(origin)).toBeCloseTo(MAX_PUSH_DEPTH, 9);
  // Stick right rolls positive about the forward laser axis, through the controller.
  const before = p.quaternion.clone();
  const at = p.position.clone();
  held(1, 0, 8200);
  const roll = new Quaternion().setFromAxisAngle(new Vector3(0, 0, -1), STICK_TURN_RATE * 0.1);
  expect(p.quaternion.angleTo(roll.multiply(before))).toBeLessThan(1e-6);
  expect(p.position.distanceTo(at)).toBeLessThan(1e-9);
  expect(p.scale).toBe(1);
  // The trigger held with the grip pressed nothing.
  expect(calls.log).toEqual([]);
});

test('the scale clamp holds 0.5-1.8 and maps junk to 1', () => {
  expect([clampPanelScale(0.1), clampPanelScale(1.2), clampPanelScale(9)]).toEqual([0.5, 1.2, 1.8]);
  expect([clampPanelScale(Number.NaN), clampPanelScale(Number.POSITIVE_INFINITY)]).toEqual([1, 1]);
});

test('hover help shows after a stable 700 ms and hides during manipulation', () => {
  const ui = createPanelInteraction(recorder());
  const p = pose();
  const origin = new Vector3(0.1, 1.3, -0.3);
  expect(ui.frame({ right: hand(origin, vignetteAt) }, p, 0).tooltip).toBeNull();
  expect(ui.frame({ right: hand(origin, vignetteAt) }, p, TOOLTIP_DELAY_MS - 1).tooltip).toBeNull();
  expect(ui.frame({ right: hand(origin, vignetteAt) }, p, TOOLTIP_DELAY_MS).tooltip).toBe(
    'vignette',
  );
  const grab = ui.frame({ right: hand(origin, vignetteAt, button(false), button(true)) }, p, 800);
  expect(grab.tooltip).toBeNull();
  expect(grab.hands.right.hover).toBeNull();
});
