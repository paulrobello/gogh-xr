import { Object3D } from 'three';
import { expect, test } from 'vitest';
import { parseFlags } from '../src/diag/flags';
import { type LandingWorld, landingReason } from '../src/locomotion/teleport';
import { createPainterSpotRound, findPainterStart } from '../src/paintings/find-painter-spot';
import { createCrownTest, createFootprintTest } from '../src/paintings/starry-night/footprints';
import { mulberry32 } from '../src/util/prng';
import { boundaryFactor } from '../src/world/boundary';
import { createCypress } from '../src/world/cypress';
import { createTerrain } from '../src/world/terrain';
import { createVillage } from '../src/world/village';

const view = { eye: [0, 1.6, 0], yaw: 0, pitch: 0.25, fovYDeg: 60, aspect: 1.25 } as const;
const spot = { position: [0, 0, 0], yaw: 0 } as const;

test('random starts use ground height and skip unsafe positions', () => {
  const world: LandingWorld = {
    ground: { heightAt: (x) => x / 5, normalAt: () => [0, 1, 0] },
    blocked: (x) => x > 7,
  };
  const draws = [0.99, 0, 0, 0];
  const first = findPainterStart(spot, world, () => draws.shift() ?? 0);
  expect(first).toEqual({ position: [-8, -1.6, -43], yaw: Math.PI });
  expect(findPainterStart(spot, world, () => 0.5)?.position).toEqual([0, 0, -43.5]);
  expect(findPainterStart(spot, world, () => 0.99)).toBeNull();
});

test('the far-side strip has safe starts beyond the houses across representative world seeds', () => {
  for (const seed of [1, 2, 7, 20, 30, 69, 100]) {
    const ground = createTerrain(seed);
    const village = createVillage(seed, ground);
    const cypress = createCypress(seed, ground);
    const world = {
      ground,
      boundaryFactor,
      blocked: createFootprintTest(village),
      treeBlocked: createCrownTest(cypress, ground.heightAt),
    };
    const farHouseEdge = Math.min(
      ...village.houses.flatMap((house) => house.outline.map((p) => p[1])),
    );
    const random = mulberry32(seed);
    for (let round = 0; round < 10; round++) {
      const start = findPainterStart(spot, world, random);
      if (!start) throw new Error(`no safe start for seed ${seed}, round ${round}`);
      const [x, , z] = start.position;
      expect(z).toBeLessThan(farHouseEdge);
      expect(landingReason(world, start.position, ground.normalAt(x, z))).toBe('ok');
    }
    ground.geometry.dispose();
    ground.ridge.dispose();
    cypress.geometry.dispose();
    for (const geometry of Object.values(village.geometries)) geometry.dispose();
  }
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
