import { Object3D } from 'three';
import { expect, test } from 'vitest';
import { parseFlags } from '../src/diag/flags';
import type { LandingWorld } from '../src/locomotion/teleport';
import { createPainterSpotRound, findPainterStart } from '../src/paintings/find-painter-spot';

const view = { eye: [0, 1.6, 0], yaw: 0, pitch: 0.25, fovYDeg: 60, aspect: 1.25 } as const;
const spot = { position: [0, 0, 0], yaw: 0 } as const;

test('random starts use ground height and skip unsafe positions', () => {
  const world: LandingWorld = {
    ground: { heightAt: (x) => x / 5, normalAt: () => [0, 1, 0] },
    blocked: (x) => x > 7,
  };
  const draws = [0.25, 0, 0.75, 0];
  const first = findPainterStart(spot, world, () => draws.shift() ?? 0);
  expect(first?.position[0]).toBeCloseTo(-8);
  expect(first?.position[1]).toBeCloseTo(-1.6);
  expect(findPainterStart(spot, world, () => 0)?.position).toEqual([0, 0, 8]);
  expect(findPainterStart(spot, world, () => 0.25)).toBeNull();
});

test('the match uses world position and orientation, and completion is latched', () => {
  const rig = new Object3D();
  const camera = new Object3D();
  rig.add(camera);
  camera.position.y = 1.6;
  const round = createPainterSpotRound(view, 90);
  const frame = (time: number) => {
    rig.updateMatrixWorld(true);
    return round.frame(camera, time);
  };
  rig.position.x = -8;
  expect(frame(0)).toBeNull();
  round.toggleHint();
  expect(frame(1)).toMatchObject({
    reference: true,
    text: expect.stringContaining('to your right'),
  });
  round.toggleHint();
  expect(frame(2)).toBeNull();

  rig.position.x = 0;
  expect(frame(3)).toBeNull();
  expect(round.match).toBeCloseTo(84.08);
  expect(round.found).toBe(false);
  camera.rotation.x = view.pitch;
  expect(frame(4)).toMatchObject({ reference: false, text: 'You found the painter’s spot' });
  expect(round.match).toBeCloseTo(100);
  expect(round.found).toBe(true);

  rig.position.x = 12;
  round.toggleHint();
  expect(round.hint).toBe(false);
  expect(frame(4004)).toBeNull();
  expect(round.found).toBe(true);
});

test('the debug threshold takes a valid percentage', () => {
  expect(parseFlags('?findthreshold=97.5').findthreshold).toBe(97.5);
  for (const invalid of ['', '0', '101', 'NaN', '90%']) {
    expect(parseFlags(`?findthreshold=${invalid}`).findthreshold).toBeNull();
  }
});

test('a 100% threshold accepts the exact painter pose', () => {
  const camera = new Object3D();
  camera.position.set(...view.eye);
  camera.rotation.x = view.pitch;
  camera.updateMatrixWorld(true);
  const round = createPainterSpotRound(view, 100);
  round.frame(camera, 0);
  expect(round.match).toBe(100);
  expect(round.found).toBe(true);
});
