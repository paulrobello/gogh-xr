import { expect, test } from 'vitest';
import { HANGINGS } from '../src/paintings/gallery/layout.ts';
import {
  createPortalDetector,
  insidePortal,
  livePortals,
  PORTAL_DEPTH,
  portalOf,
  returnPose,
  segmentMeetsPortal,
} from '../src/portal/portal.ts';
import {
  CALM_FADE_BELOW,
  createTransition,
  FADE_IN_S,
  FADE_OUT_S,
  FLY_IN_S,
  FLY_OUT_S,
  transitionStyle,
} from '../src/portal/transition.ts';
import { createSlicer, drain, type Steps } from '../src/util/slicer.ts';

const starry = livePortals()[0];
const plane = starry.centre[2];
/** A head 1.6 m up at x, `d` metres in front of the Starry Night frame plane. */
const head = (x: number, d: number): [number, number, number] => [x, 1.6, plane + d];
const still = { teleportTo: null, jumped: false };

test('only live frames with a world are portals: Starry Night alone', () => {
  expect(livePortals().map((p) => p.id)).toEqual(['starry-night']);
  const soon = HANGINGS.filter((h) => h.painting.status === 'coming-soon');
  expect(soon.length).toBe(6);
  for (const h of soon) expect(livePortals().some((p) => p.id === h.painting.id)).toBe(false);
});

test('the threshold volume is the 0.6 m slab in front of the frame, the frame wide', () => {
  expect(PORTAL_DEPTH).toBe(0.6);
  expect(insidePortal(starry, head(0, 0.59))).toBe(true);
  expect(insidePortal(starry, head(0, 0.61))).toBe(false);
  expect(insidePortal(starry, head(starry.halfWidth + 0.01, 0.3))).toBe(false);
  expect(insidePortal(starry, [0, 3.4, plane + 0.3])).toBe(false);
  expect(insidePortal(starry, [0, 0, plane + 0.3], true)).toBe(true);
});

test('a segment through the frame plane within the frame meets it; one beside it does not', () => {
  expect(segmentMeetsPortal(starry, head(0, 0.2), head(0, -0.2))).toBe(true);
  expect(segmentMeetsPortal(starry, head(0, 1), head(0, 0.5))).toBe(true);
  expect(segmentMeetsPortal(starry, head(0, 1), head(0, 0.7))).toBe(false);
  expect(segmentMeetsPortal(starry, head(2, 0.5), head(2, -0.5))).toBe(false);
  // Diagonal past the corner, never inside.
  expect(segmentMeetsPortal(starry, head(1.2, 0.3), head(0.8, 0.9))).toBe(false);
});

test('walking into the threshold triggers once; staying in it does not re-trigger', () => {
  const d = createPortalDetector(livePortals());
  expect(d.frame({ head: head(0, 1.5), ...still })).toBeNull();
  expect(d.frame({ head: head(0, 0.9), ...still })).toBeNull();
  expect(d.frame({ head: head(0, 0.4), ...still })?.id).toBe('starry-night');
  expect(d.frame({ head: head(0, 0.35), ...still })).toBeNull();
  expect(d.armed()['starry-night']).toBe(false);
  // Out again re-arms; back in triggers again.
  expect(d.frame({ head: head(0, 1), ...still })).toBeNull();
  expect(d.armed()['starry-night']).toBe(true);
  expect(d.frame({ head: head(0, 0.3), ...still })?.id).toBe('starry-night');
});

test('a step that skips the whole slab in one frame still crosses the plane', () => {
  const d = createPortalDetector(livePortals());
  d.frame({ head: head(0, 0.8), ...still });
  expect(d.frame({ head: head(0, -0.1), ...still })?.id).toBe('starry-night');
});

test('walking along the wall beside the frame never triggers', () => {
  const d = createPortalDetector(livePortals());
  d.frame({ head: head(-2, 0.4), ...still });
  expect(d.frame({ head: head(-1.2, 0.4), ...still })).toBeNull();
  expect(d.frame({ head: head(-0.6, 1.0), ...still })).toBeNull();
});

test('a teleport landing in the threshold triggers; one landing outside does not', () => {
  const d = createPortalDetector(livePortals());
  d.frame({ head: head(0, 3), ...still });
  // The landing is on the floor; the head arrives at eye height above it.
  const miss = d.frame({ head: head(0.2, 0.8), teleportTo: [0.2, 0, plane + 0.8], jumped: true });
  expect(miss).toBeNull();
  const hit = d.frame({ head: head(0.2, 0.4), teleportTo: [0.2, 0, plane + 0.4], jumped: true });
  expect(hit?.id).toBe('starry-night');
});

test('a teleport along the wall past the frame, landing beside it, does not trigger', () => {
  const d = createPortalDetector(livePortals());
  d.frame({ head: head(-1.2, 0.4), ...still });
  const r = d.frame({ head: head(1.2, 0.4), teleportTo: [1.2, 0, plane + 0.4], jumped: true });
  expect(r).toBeNull();
});

test('a placed pose (a jump that is not a teleport) into the volume does not trigger', () => {
  const d = createPortalDetector(livePortals());
  d.frame({ head: head(0, 3), ...still });
  expect(d.frame({ head: head(0, 0.3), teleportTo: null, jumped: true })).toBeNull();
  // And standing there after it does not either: the portal is disarmed while inside.
  expect(d.frame({ head: head(0, 0.3), ...still })).toBeNull();
});

test('the return pose stands outside the threshold, facing the frame', () => {
  const pose = returnPose(starry);
  expect(insidePortal(starry, [pose.position[0], 1.6, pose.position[2]])).toBe(false);
  expect(pose.position[2]).toBeGreaterThan(plane + PORTAL_DEPTH);
  // Yaw 0 faces -Z, toward the north wall.
  expect(pose.yaw).toBeCloseTo(0);
  // A frame on the east wall (normal -X) is faced at yaw -π/2.
  const east = portalOf(HANGINGS.find((h) => h.wall.name === 'east') ?? HANGINGS[1]);
  expect(returnPose(east).yaw).toBeCloseTo(-Math.PI / 2);
});

test('the transition runs about 2 s, or a 0.6 s fade below calm 0.3', () => {
  expect(transitionStyle(CALM_FADE_BELOW - 0.01)).toBe('fade');
  expect(transitionStyle(CALM_FADE_BELOW)).toBe('fly');
  expect(FLY_OUT_S + FLY_IN_S).toBeCloseTo(2);
  expect(FADE_OUT_S + FADE_IN_S).toBeCloseTo(0.6);
});

test('a transition goes out, waits for the build, comes in, then idles', () => {
  const t = createTransition();
  expect(t.request('entering', 'starry-night', 'fly')).toBe(true);
  expect(t.state).toBe('entering');
  let ended = 0;
  for (let i = 0; i < 40; i++) if (t.advance(1 / 60)?.outEnded) ended++;
  expect(ended).toBe(1);
  expect(t.phase).toBe('wait');
  for (let i = 0; i < 100; i++) expect(t.advance(1 / 60)?.phase).toBe('wait');
  t.ready();
  let done = false;
  for (let i = 0; i < 100 && !done; i++) done = t.advance(1 / 60)?.phase === 'done';
  expect(done).toBe(true);
  expect(t.state).toBe('idle');
});

test('no trigger is consumed during a transition: requests are refused, nothing queues', () => {
  const t = createTransition();
  expect(t.request('entering', 'starry-night', 'fade')).toBe(true);
  t.advance(0.1);
  expect(t.request('entering', 'starry-night', 'fade')).toBe(false);
  expect(t.request('returning', 'gallery', 'fade')).toBe(false);
  expect(t.target).toBe('starry-night');
  for (let i = 0; i < 10; i++) t.advance(0.1);
  t.ready();
  for (let i = 0; i < 10; i++) t.advance(0.1);
  expect(t.state).toBe('idle');
  // The refused requests left nothing behind: idle stays idle.
  expect(t.advance(0.1)).toBeNull();
  expect(t.request('returning', 'gallery', 'fade')).toBe(true);
});

function* counted(n: number, log: number[]): Steps<number> {
  for (let i = 0; i < n; i++) {
    log.push(i);
    yield;
  }
  return n;
}

test('drain runs steps at once with the same result', () => {
  const log: number[] = [];
  expect(drain(counted(5, log))).toBe(5);
  expect(log).toEqual([0, 1, 2, 3, 4]);
});

test('the slicer spends at most its budget per frame, in queue order', async () => {
  let clock = 0;
  const slicer = createSlicer(3, () => clock);
  const log: number[] = [];
  function* slow(): Steps<string> {
    for (let i = 0; i < 6; i++) {
      clock += 1;
      log.push(i);
      yield;
    }
    return 'done';
  }
  const result = slicer.run(slow());
  const after = slicer.step(() => 'next');
  slicer.frame();
  expect(log).toEqual([0, 1, 2]);
  slicer.frame();
  expect(log).toEqual([0, 1, 2, 3, 4, 5]);
  slicer.frame();
  await expect(result).resolves.toBe('done');
  await expect(after).resolves.toBe('next');
  expect(slicer.pending).toBe(0);
  expect(slicer.stats.longestStepMs).toBe(1);
  expect(slicer.stats.longestStepByLabel).toEqual({ '-': 1 });
  slicer.resetStats();
  expect(slicer.stats.longestStepByLabel).toEqual({});
});

test("a frame's own budget replaces the slicer's for that frame only", () => {
  let clock = 0;
  const slicer = createSlicer(3, () => clock);
  const log: number[] = [];
  function* slow(): Steps<void> {
    for (let i = 0; i < 9; i++) {
      clock += 1;
      log.push(i);
      yield;
    }
  }
  void slicer.run(slow());
  slicer.frame(1);
  expect(log).toEqual([0]);
  slicer.frame();
  expect(log).toEqual([0, 1, 2, 3]);
  slicer.frame(5);
  expect(log).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('nextFrame resolves at the next frame call', async () => {
  const slicer = createSlicer(5);
  let woke = false;
  const wait = slicer.nextFrame().then(() => {
    woke = true;
  });
  await Promise.resolve();
  expect(woke).toBe(false);
  slicer.frame();
  await wait;
  expect(woke).toBe(true);
});
