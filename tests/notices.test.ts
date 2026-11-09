import { Matrix4, Quaternion, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearNotices, syncNotices } from '../src/ui/notice';
import {
  BASE_ELEVATION,
  LIFT_MARGIN,
  MAX_ELEVATION,
  MIN_ELEVATION,
  NOTICE_DISTANCE,
  NOTICE_W,
  noticeAnchor,
  noticeElevation,
  rayRectDistance,
} from '../src/ui/notice-geometry';
import type { NoticeHudFrame } from '../src/ui/notice-hud';
import type { NoticeHit, NoticeKind } from '../src/ui/notice-queue';
import { createNotices, type NoticeView } from '../src/ui/notices';
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
