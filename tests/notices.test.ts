import { Matrix4, Quaternion, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RATE_NOTICE } from '../src/render/governor';
import { createHudToggle } from '../src/ui/hud-toggle';
import { clearNotices, syncNotices } from '../src/ui/notice';
import {
  appliedElevation,
  BASE_ELEVATION,
  ELEVATION_TAU,
  easeElevation,
  LIFT_MARGIN,
  MAX_ELEVATION,
  MIN_ELEVATION,
  NOTICE_DISTANCE,
  NOTICE_W,
  type NoticePlacementState,
  noticeAnchor,
  noticeElevation,
  noticeHalfAzimuth,
  PLACEMENT_BAND,
  rayRectDistance,
} from '../src/ui/notice-geometry';
import type { NoticeHudFrame } from '../src/ui/notice-hud';
import type { NoticeHit, NoticeKind } from '../src/ui/notice-queue';
import { createNotices, type NoticeView, raiseRateFallback } from '../src/ui/notices';
import { createPanelPose } from '../src/ui/panel-core';
import { PANEL_H, PANEL_W } from '../src/ui/panel-layout';
import { DEFAULT_OFFSET, defaultStored, facing, fromStored } from '../src/ui/panel-pose';
import type { PanelHold } from '../src/ui/panel-toggle';
import type { Actions, Hand } from '../src/xr/input';

const DEG = Math.PI / 180;

/** The panel's corners, camera space, for a camera at the rig origin looking down -Z. */
function cornersOf(position: Vector3, quaternion: Quaternion, scale = 1): Vector3[] {
  const m = new Matrix4().compose(position, quaternion, new Vector3(scale, scale, scale));
  const hw = PANEL_W / 2;
  const hh = PANEL_H / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => new Vector3(x, y, 0).applyMatrix4(m));
}

/** A stack this tall above its bottom edge, metres, about two notices. */
const STACK_H = 0.09;
const STACK_ANGLE = Math.atan2(STACK_H, NOTICE_DISTANCE);

/**
 * True when no eye ray through the stack's bottom or top edge, at its centre or either end, meets
 * the panel at `position` (camera space, eye at the origin), facing the eye at `scale`.
 */
function stackClearsPanel(elevation: number, position: Vector3, scale = 1): boolean {
  const q = facing(position, new Vector3());
  const inverse = new Matrix4().compose(position, q, new Vector3(scale, scale, scale)).invert();
  const anchor = noticeAnchor(elevation);
  const up = new Vector3(0, Math.cos(elevation), Math.sin(elevation)).multiplyScalar(STACK_H);
  const eye = new Vector3();
  for (const v of [0, 1]) {
    for (const x of [-NOTICE_W / 2, 0, NOTICE_W / 2]) {
      const point = anchor
        .clone()
        .add(new Vector3(x, 0, 0))
        .addScaledVector(up, v);
      const dir = point.clone().normalize();
      if (rayRectDistance(eye, dir, inverse, PANEL_W, PANEL_H) !== null) return false;
    }
  }
  return true;
}

function facingCorners(position: Vector3, scale = 1): Vector3[] {
  return cornersOf(position, facing(position, new Vector3()), scale);
}

describe('notice placement', () => {
  it('sits above the default panel spawn and the perf HUD, so it blocks neither', () => {
    const pose = fromStored(
      defaultStored(),
      { position: new Vector3(), yaw: 0 },
      createPanelPose(),
    );
    const corners = cornersOf(pose.position, pose.quaternion, pose.scale);
    const panelTop = Math.max(...corners.map((c) => Math.atan2(c.y, -c.z)));
    expect(panelTop).toBeLessThan(BASE_ELEVATION);
    expect(DEFAULT_OFFSET[1]).toBeLessThan(0);
    // The default panel never lifts the stack, however tall it grows.
    expect(noticeElevation(corners, 20 * DEG)).toBe(BASE_ELEVATION);
    // The perf HUD's top edge sits at (0, -0.12, -0.6), below the eye line.
    expect(Math.atan2(-0.12, 0.6)).toBeLessThan(0);
    expect(noticeElevation(null, 20 * DEG)).toBe(BASE_ELEVATION);
  });

  it('lifts above an open panel held where the stack would cover it', () => {
    const position = new Vector3(0, 0.15, -0.7);
    const corners = cornersOf(position, new Quaternion());
    const top = Math.atan2(0.15 + PANEL_H / 2, 0.7);
    expect(noticeElevation(corners, 5 * DEG)).toBeCloseTo(top + LIFT_MARGIN, 9);
  });

  it('stays put for a panel off to the side, above the stack or behind the eye', () => {
    const side = cornersOf(new Vector3(1.2, 0.15, -0.7), new Quaternion());
    expect(noticeElevation(side, 5 * DEG)).toBe(BASE_ELEVATION);
    const above = cornersOf(new Vector3(0, 1.2, -0.7), new Quaternion());
    expect(noticeElevation(above, 5 * DEG)).toBe(BASE_ELEVATION);
    const behind = cornersOf(new Vector3(0, 0.15, 0.7), new Quaternion());
    expect(noticeElevation(behind, 5 * DEG)).toBe(BASE_ELEVATION);
  });

  it('a lifted stack clears a centred panel held close, top-middle included', () => {
    const position = new Vector3(0, 0.1, -0.6);
    // The precondition: at its base the stack would cover this panel.
    expect(stackClearsPanel(BASE_ELEVATION, position)).toBe(false);
    const elevation = noticeElevation(facingCorners(position), STACK_ANGLE);
    expect(elevation).toBeGreaterThan(BASE_ELEVATION);
    expect(elevation).toBeLessThanOrEqual(MAX_ELEVATION);
    expect(stackClearsPanel(elevation, position)).toBe(true);
  });

  it('drops below a panel held too high to lift over, still above the perf HUD', () => {
    const position = new Vector3(0, 0.45, -0.6);
    expect(stackClearsPanel(BASE_ELEVATION, position)).toBe(false);
    const elevation = noticeElevation(facingCorners(position), STACK_ANGLE);
    expect(elevation).toBeLessThan(BASE_ELEVATION);
    expect(elevation).toBeGreaterThanOrEqual(MIN_ELEVATION);
    expect(stackClearsPanel(elevation, position)).toBe(true);
  });

  it('a panel too tall to clear either way leaves the stack at the cap', () => {
    const tall = facingCorners(new Vector3(0, 0.1, -0.5), 1.8);
    expect(noticeElevation(tall, STACK_ANGLE)).toBe(MAX_ELEVATION);
  });

  it('judges azimuth by the stack’s real width once lifted', () => {
    // Just beside the stack's base half width (14.0°) but inside its width at a lifted top.
    const half = Math.atan2(NOTICE_W / 2, NOTICE_DISTANCE);
    const az = half + 0.5 * DEG;
    const x = 0.7 * Math.tan(az) + PANEL_W / 2;
    const tallAngle = 25 * DEG;
    const corners = cornersOf(new Vector3(x, 0.2, -0.7), new Quaternion());
    expect(noticeElevation(corners, tallAngle)).toBeGreaterThan(BASE_ELEVATION);
  });

  it('anchors the stack at its distance along the elevation', () => {
    const a = noticeAnchor(BASE_ELEVATION);
    expect(a.length()).toBeCloseTo(NOTICE_DISTANCE, 9);
    expect(Math.atan2(a.y, -a.z)).toBeCloseTo(BASE_ELEVATION, 9);
  });
});

describe('notice placement hysteresis and easing', () => {
  /** Placements and elevations for a panel facing the eye at height y, swept over `ys`. */
  function sweep(ys: readonly number[], state: NoticePlacementState): string[] {
    return ys.map((y) => {
      noticeElevation(facingCorners(new Vector3(0, y, -0.6)), STACK_ANGLE, state);
      return state.placement;
    });
  }
  const range = (from: number, to: number, step: number): number[] => {
    const out: number[] = [];
    const n = Math.round(Math.abs(to - from) / step);
    for (let i = 0; i <= n; i += 1) out.push(from + ((to - from) * i) / n);
    return out;
  };
  const changes = (names: readonly string[]): number =>
    names.reduce((n, p, i) => (i > 0 && p !== names[i - 1] ? n + 1 : n), 0);

  it('a panel swept up across the lift boundary switches once, and back at a different height', () => {
    const state: NoticePlacementState = { placement: 'base' };
    const up = sweep(range(0.05, 0.6, 0.002), state);
    const down = sweep(range(0.6, 0.05, 0.002), state);
    // base, lift, drop, base on the way up, and the reverse on the way down, with no chatter.
    expect(up).toContain('lift');
    expect(up).toContain('drop');
    expect(changes(up)).toBe(3);
    expect(changes(down)).toBe(3);
    // Hysteresis: the upward lift->drop switch and the downward drop->lift switch differ in height.
    const upSwitch = range(0.05, 0.6, 0.002)[up.indexOf('drop')];
    const downSwitch = range(0.6, 0.05, 0.002)[down.indexOf('lift')];
    expect(upSwitch).toBeGreaterThan(downSwitch);
  });

  /** A vertical panel 0.4 m wide at 1 m ahead whose edges sit at these elevations, degrees. */
  const rect = (bottomDeg: number, topDeg: number): Vector3[] => [
    new Vector3(-0.2, Math.tan(bottomDeg * DEG), -1),
    new Vector3(0.2, Math.tan(bottomDeg * DEG), -1),
    new Vector3(0.2, Math.tan(topDeg * DEG), -1),
    new Vector3(-0.2, Math.tan(topDeg * DEG), -1),
  ];
  const STACK_DEG = STACK_ANGLE / DEG;

  it('a held lift stays lifted at the cap through 1 degree of jitter past it', () => {
    const state: NoticePlacementState = { placement: 'lift' };
    // Lift 40.5 to 41.5 degrees: past the cap, inside the band.
    for (const lift of [40.5, 41.5, 40.5, 41.5, 40.6]) {
      const e = noticeElevation(rect(10, lift - 2), STACK_ANGLE, state);
      expect(state.placement).toBe('lift');
      expect(e).toBe(MAX_ELEVATION);
    }
    // Past the band it leaves the lift.
    noticeElevation(rect(10, 42.5 - 2), STACK_ANGLE, state);
    expect(state.placement).not.toBe('lift');
  });

  it('a held drop stays dropped at the floor through 1 degree of jitter past it', () => {
    const state: NoticePlacementState = { placement: 'drop' };
    // The lift stays past the cap band (top 60), the drop's bottom edge sits -9.5 to -8.5 degrees.
    for (const below of [-9.5, -8.5, -9.5, -8.5, -9.4]) {
      const e = noticeElevation(rect(below + 2 + STACK_DEG, 60), STACK_ANGLE, state);
      expect(state.placement).toBe('drop');
      expect(e).toBe(MIN_ELEVATION);
    }
    noticeElevation(rect(-10.5 + 2 + STACK_DEG, 60), STACK_ANGLE, state);
    expect(state.placement).toBe('cap');
  });

  it('a stack at the cap leaves it for a lift or a drop as soon as one fits', () => {
    const state: NoticePlacementState = { placement: 'cap' };
    noticeElevation(rect(10, 39.9 - 2), STACK_ANGLE, state);
    expect(state.placement).toBe('lift');
    state.placement = 'cap';
    noticeElevation(rect(-8 + 2 + STACK_DEG + 0.1, 60), STACK_ANGLE, state);
    expect(state.placement).toBe('drop');
  });

  it('a dropped stack returns to a lift only once the lift is within the cap by the band', () => {
    const state: NoticePlacementState = { placement: 'drop' };
    noticeElevation(rect(10, 39 - 2), STACK_ANGLE, state);
    expect(state.placement).toBe('drop');
    noticeElevation(rect(10, 37.9 - 2), STACK_ANGLE, state);
    expect(state.placement).toBe('lift');
  });

  it('a moved stack stays moved until the overlap clears by the band', () => {
    const state: NoticePlacementState = { placement: 'base' };
    const half = noticeHalfAzimuth(BASE_ELEVATION + STACK_ANGLE);
    // A flat panel at 0.7 m whose near side edge sits `az` radians past the stack's half width.
    const beside = (az: number) =>
      cornersOf(new Vector3(0.7 * Math.tan(half + az) + PANEL_W / 2, 0.15, -0.7), new Quaternion());
    // Right-hand side only: the near edge's azimuth is atan2(x - PANEL_W / 2, 0.7) up to depth.
    noticeElevation(beside(-1 * DEG), STACK_ANGLE, state);
    expect(state.placement).toBe('lift');
    noticeElevation(beside(0.5 * DEG), STACK_ANGLE, state);
    expect(state.placement).toBe('lift');
    noticeElevation(beside(PLACEMENT_BAND + 0.5 * DEG), STACK_ANGLE, state);
    expect(state.placement).toBe('base');
    // And entering again needs a real overlap, not just reaching within the band.
    noticeElevation(beside(0.5 * DEG), STACK_ANGLE, state);
    expect(state.placement).toBe('base');
  });

  it('without a state the result has no memory', () => {
    const corners = facingCorners(new Vector3(0, 0.1, -0.6));
    expect(noticeElevation(corners, STACK_ANGLE)).toBe(noticeElevation(corners, STACK_ANGLE));
  });

  it('eases toward its target by an exponential of dt, independent of the frame rate', () => {
    const target = 40 * DEG;
    const start = 13 * DEG;
    const run = (hz: number, seconds: number): number => {
      let e = start;
      for (let i = 0; i < Math.round(hz * seconds); i += 1) e = easeElevation(e, target, 1 / hz);
      return e;
    };
    const oneTau = start + (target - start) * (1 - Math.exp(-1));
    expect(easeElevation(start, target, ELEVATION_TAU)).toBeCloseTo(oneTau, 9);
    expect(ELEVATION_TAU).toBeCloseTo(0.15, 9);
    // 90 Hz, 72 Hz and 30 Hz land on the same elevation after the same time.
    expect(run(90, 0.5)).toBeCloseTo(run(30, 0.5), 9);
    expect(run(72, 0.5)).toBeCloseTo(run(30, 0.5), 9);
    // Never overshoots, and moves in the right direction each frame.
    let e = start;
    for (let i = 0; i < 20; i += 1) {
      const next = easeElevation(e, target, 1 / 90);
      expect(next).toBeGreaterThan(e);
      expect(next).toBeLessThanOrEqual(target);
      e = next;
    }
    expect(easeElevation(start, target, 0)).toBe(start);
    expect(easeElevation(start, target, Number.NaN)).toBe(target);
  });
});

describe('appliedElevation', () => {
  const T = 0.15;
  it('snaps when asked, and on a switch between lift and drop either way', () => {
    expect(appliedElevation(0.2, 0.7, 'base', 'base', true, 0.01)).toBe(0.7);
    expect(appliedElevation(0.7, -0.1, 'drop', 'lift', false, 0.01)).toBe(-0.1);
    expect(appliedElevation(-0.1, 0.7, 'lift', 'drop', false, 0.01)).toBe(0.7);
  });

  it('snaps base to lift, eases lift to base and drop to base', () => {
    const toLift = appliedElevation(0.23, 0.5, 'lift', 'base', false, T);
    // A lifted stack never trails its target (it would overlap the panel), so this snaps to it.
    expect(toLift).toBe(0.5);
    const toBase = appliedElevation(0.5, 0.23, 'base', 'lift', false, T);
    expect(toBase).toBeGreaterThan(0.23);
    expect(toBase).toBeLessThan(0.5);
    const fromDrop = appliedElevation(-0.1, 0.23, 'base', 'drop', false, T);
    expect(fromDrop).toBeGreaterThan(-0.1);
    expect(fromDrop).toBeLessThan(0.23);
  });

  it('snaps into the cap from a drop or the base, never sliding up across the panel', () => {
    expect(appliedElevation(-0.1, 0.7, 'cap', 'drop', false, 1 / 90)).toBe(0.7);
    expect(appliedElevation(0.23, 0.7, 'cap', 'base', false, 1 / 90)).toBe(0.7);
    // From a lift it is already at the cap's side and eases.
    const fromLift = appliedElevation(0.75, 0.7, 'cap', 'lift', false, 1 / 90);
    expect(fromLift).toBeGreaterThan(0.7);
    expect(fromLift).toBeLessThan(0.75);
  });

  it('a held lift never sits below its target, a held drop never above', () => {
    // Head pitch moved the panel up: the lift target rose, the eased value would lag below it.
    expect(appliedElevation(0.3, 0.5, 'lift', 'lift', false, 1 / 90)).toBe(0.5);
    // The target fell: it eases down toward it, from above.
    const down = appliedElevation(0.5, 0.3, 'lift', 'lift', false, 1 / 90);
    expect(down).toBeGreaterThan(0.3);
    expect(down).toBeLessThan(0.5);
    expect(appliedElevation(-0.05, -0.2, 'drop', 'drop', false, 1 / 90)).toBe(-0.2);
    const up = appliedElevation(-0.25, -0.2, 'drop', 'drop', false, 1 / 90);
    expect(up).toBeGreaterThan(-0.25);
    expect(up).toBeLessThan(-0.2);
  });
});

describe('dismiss button ray test', () => {
  const button = new Matrix4().compose(
    new Vector3(0.1, 1.7, -0.6),
    new Quaternion(),
    new Vector3(0.06, 0.026, 1),
  );
  const inverse = button.clone().invert();

  it('hits the front of a scaled unit plane at the world distance', () => {
    const origin = new Vector3(0.1, 1.7, 0);
    const t = rayRectDistance(origin, new Vector3(0, 0, -1), inverse, 1, 1);
    expect(t).toBeCloseTo(0.6, 9);
  });

  it('misses beside the button, from behind and pointing away', () => {
    const dir = new Vector3(0, 0, -1);
    expect(rayRectDistance(new Vector3(0.14, 1.7, 0), dir, inverse, 1, 1)).toBeNull();
    expect(
      rayRectDistance(new Vector3(0.1, 1.7, -1), new Vector3(0, 0, 1), inverse, 1, 1),
    ).toBeNull();
    expect(
      rayRectDistance(new Vector3(0.1, 1.7, 0), new Vector3(0, 0, 1), inverse, 1, 1),
    ).toBeNull();
  });
});

describe('DOM notices mirror the queue', () => {
  afterEach(() => clearNotices());

  it('an empty queue adds no container to a page that has none', () => {
    const doc = document.implementation.createHTMLDocument();
    syncNotices([], () => {}, doc);
    expect(doc.getElementById('gogh-notices')).toBeNull();
    syncNotices([{ kind: 'xr-error', text: 'x' }], () => {}, doc);
    expect(doc.getElementById('gogh-notices')?.children).toHaveLength(1);
    syncNotices([], () => {}, doc);
    expect(doc.getElementById('gogh-notices')?.children).toHaveLength(0);
  });

  it('keeps one element per kind, newest first, and its button dismisses that kind', () => {
    const onDismiss = vi.fn();
    syncNotices(
      [
        { kind: 'xr-error', text: 'Could not start VR: denied' },
        { kind: 'settings-recovered', text: 'defaults' },
      ],
      onDismiss,
    );
    const kinds = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-notice-kind]')).map(
        (el) => el.dataset.noticeKind,
      );
    expect(kinds()).toEqual(['xr-error', 'settings-recovered']);
    syncNotices(
      [
        { kind: 'rate-fallback', text: '72 Hz' },
        { kind: 'xr-error', text: 'Could not start VR: denied' },
      ],
      onDismiss,
    );
    expect(kinds()).toEqual(['rate-fallback', 'xr-error']);
    document.querySelector<HTMLElement>('[data-notice-kind="xr-error"] button')?.click();
    expect(onDismiss).toHaveBeenCalledWith('xr-error');
    syncNotices([{ kind: 'xr-error', text: 'Could not start VR: again' }], onDismiss);
    expect(document.querySelector('[data-notice-kind="xr-error"]')?.textContent).toContain('again');
    expect(kinds()).toEqual(['xr-error']);
  });

  it('a newer text of the front notice replaces it in place', () => {
    const onDismiss = vi.fn();
    syncNotices(
      [
        { kind: 'xr-error', text: 'first' },
        { kind: 'rate-fallback', text: '72 Hz' },
      ],
      onDismiss,
    );
    syncNotices(
      [
        { kind: 'xr-error', text: 'second' },
        { kind: 'rate-fallback', text: '72 Hz' },
      ],
      onDismiss,
    );
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-notice-kind]'));
    expect(els.map((el) => [el.dataset.noticeKind, el.firstElementChild?.textContent])).toEqual([
      ['xr-error', 'second'],
      ['rate-fallback', '72 Hz'],
    ]);
    els[0]?.querySelector('button')?.click();
    expect(onDismiss).toHaveBeenCalledWith('xr-error');
  });
});

const BUTTON = { down: false, fired: false };

function actions(trigger: Partial<Record<Hand, { down: boolean; fired: boolean }>> = {}): Actions {
  const hand = (h: Hand) => ({
    trigger: trigger[h] ?? BUTTON,
    grip: BUTTON,
    stick: { x: 0, y: 0 },
  });
  return { hands: { left: hand('left'), right: hand('right') } } as unknown as Actions;
}

function hold(overrides: Partial<PanelHold> = {}): PanelHold {
  return {
    left: false,
    right: false,
    sticks: { left: false, right: false },
    hits: { left: false, right: false },
    pose: null,
    ...overrides,
  };
}

const hit = (kind: NoticeKind, button: NoticeHit['button'] = 'dismiss'): NoticeHit => ({
  kind,
  button,
});

function fakeView(targets: Record<Hand, NoticeHit | null> = { left: null, right: null }) {
  const frames: NoticeHudFrame[] = [];
  const hovers: Record<Hand, NoticeHit | null>[] = [];
  const view: NoticeView = {
    frame: (input) => {
      frames.push(input);
      return targets;
    },
    setHover: (h) => {
      hovers.push({ ...h });
    },
    diag: () => ({ visible: true, elevationDeg: 13, typeset: true, targets: [], actions: [] }),
  };
  return { view, frames, hovers, targets };
}

/** Lets the build promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('notices host', () => {
  it('shows the 72 Hz notice on the XR stack while the perf HUD stays hidden and unbuilt (2026-11-08)', async () => {
    const fake = fakeView();
    const notices = createNotices({ build: async () => fake.view, syncDom: () => {} });
    const hudBuild = vi.fn(async () => ({ frame: vi.fn(), setVisible: vi.fn(), diag: () => ({}) }));
    const hud = createHudToggle({ visible: false, build: hudBuild });
    // The governor's notify in main.ts: it raises the notice and leaves the HUD alone.
    const dom = vi.fn();
    raiseRateFallback(notices, RATE_NOTICE, dom);
    expect(dom).not.toHaveBeenCalled();
    notices.frame(true, actions(), hold());
    await settle();
    notices.frame(true, actions(), hold());
    hud.frame(0, false);
    expect(fake.frames.at(-1)).toMatchObject({
      presenting: true,
      shown: [{ kind: 'rate-fallback', text: RATE_NOTICE }],
    });
    expect(notices.diag().view).toMatchObject({ visible: true });
    expect(hud.diag()).toEqual({ visible: false, built: false });
    expect(hudBuild).not.toHaveBeenCalled();
  });

  it('the 72 Hz notice falls back to a DOM notice before the notices host exists', () => {
    const dom = vi.fn();
    raiseRateFallback(null, RATE_NOTICE, dom);
    expect(dom).toHaveBeenCalledWith(RATE_NOTICE);
  });

  it('builds nothing until a presenting frame has a notice queued', async () => {
    const fake = fakeView();
    const build = vi.fn(async () => fake.view);
    const notices = createNotices({ build, syncDom: () => {} });
    notices.frame(true, actions(), hold());
    notices.raise('settings-recovered', 'defaults');
    notices.frame(false, actions(), hold());
    await settle();
    expect(build).not.toHaveBeenCalled();
    expect(notices.diag()).toMatchObject({ view: null });
    notices.frame(true, actions(), hold());
    notices.frame(true, actions(), hold());
    expect(build).toHaveBeenCalledTimes(1);
    await settle();
    notices.frame(true, actions(), hold());
    expect(fake.frames.at(-1)).toMatchObject({ presenting: true, panelPose: null });
    expect(notices.diag()).toMatchObject({
      queue: [{ kind: 'settings-recovered', text: 'defaults' }],
      shown: [{ kind: 'settings-recovered', text: 'defaults' }],
      view: { visible: true },
    });
  });

  it('a failed build is reported and retried on a later frame', async () => {
    const fake = fakeView();
    const build = vi
      .fn<() => Promise<NoticeView>>()
      .mockRejectedValueOnce(new Error('no font'))
      .mockResolvedValue(fake.view);
    const onError = vi.fn();
    const notices = createNotices({ build, onError, syncDom: () => {} });
    notices.raise('xr-error', 'x');
    notices.frame(true, actions(), hold());
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    notices.frame(true, actions(), hold());
    await settle();
    expect(build).toHaveBeenCalledTimes(2);
    expect(notices.diag().view).not.toBeNull();
  });

  it('a trigger on a dismiss button off the panel dismisses it and claims the hand', async () => {
    const fake = fakeView({ left: null, right: hit('xr-error') });
    const notices = createNotices({ build: async () => fake.view, syncDom: () => {} });
    notices.raise('rate-fallback', 'r');
    notices.raise('xr-error', 'x');
    notices.frame(true, actions(), hold());
    await settle();
    const took = notices.frame(true, actions({ right: { down: true, fired: true } }), hold());
    expect(took).toEqual({ left: false, right: true });
    expect(notices.queue.queue.map((n) => n.kind)).toEqual(['rate-fallback']);
    expect(fake.hovers.at(-1)).toEqual({ left: null, right: hit('xr-error') });
  });

  describe.each([
    ['left', 'right'],
    ['right', 'left'],
  ] as const)('the panel keeps the %s trigger', (hand, other) => {
    it.each([
      ['its ray meets the panel', 'hit'],
      ['the panel holds that hand', 'held'],
    ] as const)('when %s, and the other hand still takes its own notice', async (_, owns) => {
      // Each hand points at its own Dismiss button and both triggers fire in the same frame.
      const fake = fakeView({ [hand]: hit('xr-error'), [other]: hit('rate-fallback') } as Record<
        Hand,
        NoticeHit
      >);
      const notices = createNotices({ build: async () => fake.view, syncDom: () => {} });
      notices.raise('rate-fallback', 'r');
      notices.raise('xr-error', 'x');
      notices.frame(true, actions(), hold());
      await settle();
      const pose = createPanelPose();
      const panel =
        owns === 'hit'
          ? hold({ hits: { left: hand === 'left', right: hand === 'right' }, pose })
          : hold({ [hand]: true, pose });
      const took = notices.frame(
        true,
        actions({ left: { down: true, fired: true }, right: { down: true, fired: true } }),
        panel,
      );
      expect(took[hand]).toBe(false);
      expect(took[other]).toBe(true);
      expect(notices.queue.queue.map((n) => n.kind)).toEqual(['xr-error']);
      expect(fake.hovers.at(-1)?.[hand]).toBeNull();
      expect(fake.hovers.at(-1)?.[other]).toEqual(hit('rate-fallback'));
      expect(fake.frames.at(-1)?.panelPose).toBe(pose);
    });
  });

  it('dismissing on the page or in XR removes the notice from both surfaces', () => {
    const synced: string[][] = [];
    let pageDismiss: ((kind: NoticeKind) => void) | null = null;
    const notices = createNotices({
      build: async () => fakeView().view,
      syncDom: (shown, onDismiss) => {
        synced.push(shown.map((n) => n.kind));
        pageDismiss = onDismiss;
      },
    });
    notices.raise('xr-error', 'x');
    notices.raiseUpdate();
    expect(synced.at(-1)).toEqual(['update-ready', 'xr-error']);
    expect(notices.queue.queue[0]?.text).toMatch(/new version/);
    (pageDismiss as unknown as (kind: NoticeKind) => void)('update-ready');
    expect(notices.queue.queue.map((n) => n.kind)).toEqual(['xr-error']);
    notices.dismiss('xr-error');
    expect(synced.at(-1)).toEqual([]);
  });

  it('hides a built stack once the queue empties, then stops calling it', async () => {
    const fake = fakeView();
    const notices = createNotices({ build: async () => fake.view, syncDom: () => {} });
    notices.raise('xr-error', 'x');
    notices.frame(true, actions(), hold());
    await settle();
    notices.frame(true, actions(), hold());
    notices.dismiss('xr-error');
    const before = fake.frames.length;
    notices.frame(true, actions(), hold());
    expect(fake.frames.length).toBe(before + 1);
    expect(fake.frames.at(-1)?.shown).toEqual([]);
    notices.frame(true, actions(), hold());
    expect(fake.frames.length).toBe(before + 1);
  });
});

describe('notice actions (P7.1)', () => {
  afterEach(() => clearNotices());

  it('an action hit in XR runs the action, keeps the notice and claims the hand', async () => {
    const fake = fakeView({ left: null, right: hit('update-ready', 'action') });
    const run = vi.fn();
    const notices = createNotices({
      build: async () => fake.view,
      syncDom: () => {},
      actions: { 'update-ready': { label: 'Reload', run } },
    });
    notices.raiseUpdate();
    notices.frame(true, actions(), hold());
    await settle();
    const took = notices.frame(true, actions({ right: { down: true, fired: true } }), hold());
    expect(run).toHaveBeenCalledTimes(1);
    expect(took.right).toBe(true);
    expect(notices.queue.queue.map((n) => n.kind)).toEqual(['update-ready']);
    expect(fake.frames.at(-1)?.actions).toEqual({ 'update-ready': 'Reload' });
    expect(fake.hovers.at(-1)?.right).toEqual(hit('update-ready', 'action'));
  });

  it('the page shows the action button before Dismiss, only on its kind', () => {
    const run = vi.fn();
    const notices = createNotices({
      build: async () => fakeView().view,
      actions: { 'update-ready': { label: 'Reload', run } },
    });
    notices.raise('xr-error', 'x');
    notices.raiseUpdate();
    const update = document.querySelector<HTMLElement>('[data-notice-kind="update-ready"]');
    const buttons = Array.from(update?.querySelectorAll('button') ?? []).map((b) => b.textContent);
    expect(buttons).toEqual(['Reload', 'Dismiss']);
    expect(document.querySelector('[data-notice-kind="xr-error"] [data-notice-action]')).toBeNull();
    update?.querySelector<HTMLElement>('[data-notice-action="reload"]')?.click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(notices.queue.queue.map((n) => n.kind)).toEqual(['update-ready', 'xr-error']);
  });
});
