/**
 * The pane probe's poses as a committed fixture (tests/fixtures/pane-poses.json), which
 * tests/e2e/panes.spec.ts reads. Playwright cannot load the world modules (their GLSL imports), so
 * the poses are computed here, in vitest, and checked against the file on every run. After a change
 * to the village, the bands or the pose search, regenerate with
 * `UPDATE_PANE_POSES=1 bunx vitest run tests/pane-poses-fixture.test.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createWorldGeometry, worldSeeds } from '../src/paintings/starry-night/world.ts';
import {
  farPose,
  MIN_PANE_PX,
  nearPose,
  PROBE_VIEW,
  panes,
  polygonArea,
  project,
  sightTest,
} from './pane-poses';

const FILE = 'tests/fixtures/pane-poses.json';

function computeFixture() {
  const world = createWorldGeometry(worldSeeds(1));
  const sight = sightTest(world);
  return {
    probeView: PROBE_VIEW,
    minPanePx: MIN_PANE_PX,
    panes: panes(world).map((pane) => {
      const far = farPose(world, pane, sight);
      const quad = far ? project(far, pane.corners) : null;
      return {
        house: pane.house,
        near: nearPose(pane),
        far,
        farQuad: quad,
        farAreaPx: quad ? polygonArea(quad) : 0,
      };
    }),
  };
}

describe('pane probe fixture', () => {
  test('tests/fixtures/pane-poses.json matches the seed-1 poses', () => {
    const fixture = JSON.parse(JSON.stringify(computeFixture()));
    if (process.env.UPDATE_PANE_POSES === '1') {
      writeFileSync(FILE, `${JSON.stringify(fixture, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(fixture);
    expect(fixture.panes).toHaveLength(15);
  }, 120_000);
});
