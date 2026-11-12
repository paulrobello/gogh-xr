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

/** libm's atan2 and friends differ in the last bit between macOS and Linux, so numbers match to 1e-9. */
function expectClose(actual: unknown, expected: unknown, path = '$'): void {
  if (typeof expected === 'number') {
    expect(typeof actual, path).toBe('number');
    expect(Math.abs((actual as number) - expected), path).toBeLessThanOrEqual(
      1e-9 * Math.max(1, Math.abs(expected)),
    );
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((value, i) => {
      expectClose((actual as unknown[])[i], value, `${path}[${i}]`);
    });
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    expect(actual !== null && typeof actual === 'object', path).toBe(true);
    const record = actual as Record<string, unknown>;
    expect(Object.keys(record).sort(), path).toEqual(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected))
      expectClose(record[key], value, `${path}.${key}`);
    return;
  }
  expect(actual, path).toEqual(expected);
}

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
    expectClose(JSON.parse(readFileSync(FILE, 'utf8')), fixture);
    expect(fixture.panes).toHaveLength(15);
  }, 120_000);
});
