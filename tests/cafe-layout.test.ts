import { describe, expect, test } from 'vitest';
import { PAINTER_EYE, toCanvas } from '../src/paintings/cafe-terrace-at-night/canvas';
import { rasterizeIds } from '../src/paintings/cafe-terrace-at-night/id-map';
import {
  AWNING,
  CHAIRS,
  DECK_HEIGHT,
  DOORWAY,
  FACADE_DIRECTION,
  facadeX,
  groundHeight,
  ID,
  NEAR_Z,
  PEOPLE,
  REAR_Z,
  SWATCH,
  setSolids,
  TABLE_HEIGHT,
  TABLES,
  TRUNK,
  WALK_BOUNDS,
} from '../src/paintings/cafe-terrace-at-night/layout';
import { paintBuilder } from '../src/paintings/cafe-terrace-at-night/paint';
import { buildSet } from '../src/paintings/cafe-terrace-at-night/set';
import { mulberry32 } from '../src/util/prng';
import { drain } from '../src/util/slicer';

/** The set's triangles and ids as the scene hands them to the id map. */
function setTriangles(): { positions: readonly number[]; ids: readonly number[] } {
  const set = paintBuilder([]);
  drain(buildSet(set, mulberry32(8)));
  return { positions: set.positions, ids: set.ids };
}

/** Whether a point lies inside one of the set's solid boxes. */
function solid(x: number, y: number, z: number): boolean {
  return setSolids().some(
    ({ center, size }) =>
      Math.abs(x - center[0]) <= size[0] / 2 &&
      Math.abs(y - center[1]) <= size[1] / 2 &&
      Math.abs(z - center[2]) <= size[2] / 2,
  );
}

describe('café layout', () => {
  test('the measured landmarks land where the scan paints them', () => {
    // The awning's near corners and far outer corner.
    expect(toCanvas(AWNING[0])).toMatchObject({
      u: expect.closeTo(0.165, 6),
      v: expect.closeTo(0.152, 6),
    });
    expect(toCanvas(AWNING[1])).toMatchObject({
      u: expect.closeTo(0.55, 6),
      v: expect.closeTo(0.335, 6),
    });
    expect(toCanvas(AWNING[2])).toMatchObject({
      u: expect.closeTo(0.535, 6),
      v: expect.closeTo(0.505, 6),
    });
    // The awning falls from the wall to its outer edge and stays above head height.
    expect(AWNING[0][1]).toBeGreaterThan(AWNING[1][1]);
    expect(AWNING[2][1]).toBeGreaterThan(2.2);
    // The big foreground table and the tree.
    const { u, v } = toCanvas(TABLES[1].center);
    expect(u).toBeCloseTo(0.41, 6);
    expect(v).toBeCloseTo(0.728, 6);
    expect(TABLES[1].center[1]).toBe(TABLE_HEIGHT);
    expect(toCanvas(TRUNK).u).toBeCloseTo(0.985, 6);
  });

  test('the terrace is a plausible size and the façade runs left of the painter', () => {
    expect(REAR_Z).toBeLessThan(-18);
    expect(REAR_Z).toBeGreaterThan(-26);
    expect(facadeX(0)).toBeLessThan(-1);
    expect(facadeX(0)).toBeGreaterThan(-1.8);
    // It swings away from the street's axis with distance.
    expect(facadeX(REAR_Z)).toBeLessThan(facadeX(NEAR_Z) - 2);
    for (const { radius } of TABLES) {
      expect(radius).toBeGreaterThan(0.1);
      expect(radius).toBeLessThan(0.45);
    }
    for (const { height } of PEOPLE) {
      expect(height).toBeGreaterThanOrEqual(1.25);
      expect(height).toBeLessThanOrEqual(1.8);
    }
  });

  test('the painter stands in the open, inside the walk bounds', () => {
    const [x, , z] = PAINTER_EYE;
    expect(x).toBeGreaterThan(WALK_BOUNDS.minX);
    expect(x).toBeLessThan(WALK_BOUNDS.maxX);
    expect(z).toBeGreaterThan(WALK_BOUNDS.minZ);
    expect(z).toBeLessThan(WALK_BOUNDS.maxZ);
    for (const { center, size } of setSolids()) {
      const inside =
        Math.abs(x - center[0]) <= size[0] / 2 + 0.3 &&
        Math.abs(z - center[2]) <= size[2] / 2 + 0.3;
      expect(inside).toBe(false);
    }
  });

  test('every table, chair and figure the walk can reach stands on the street side of the façade', () => {
    const spots = [
      ...TABLES.map(({ center }) => center),
      ...CHAIRS.map(({ seat }) => seat),
      ...PEOPLE.map(({ at }) => at),
    ];
    for (const [x, , z] of spots) {
      if (z < REAR_Z) continue;
      expect(x).toBeGreaterThan(facadeX(z));
    }
  });

  test('the doorway is open to the walk as far as the counter, and the wall beside it is not', () => {
    const along = (DOORWAY[0] + DOORWAY[1]) / 2;
    const z = NEAR_Z + FACADE_DIRECTION[2] * along;
    const face = facadeX(z);
    // On the deck, through the doorway, and a metre into the room.
    for (const x of [face + 1, face - 0.2, face - 1.5]) {
      expect(solid(x, 1, z)).toBe(false);
      expect(x).toBeGreaterThan(WALK_BOUNDS.minX);
      expect(groundHeight(x, z)).toBe(DECK_HEIGHT);
    }
    // The counter's side of the room, the wall over the doorway's head, and the wall beside it.
    expect(solid(face - 3.2, 1, z)).toBe(true);
    expect(solid(face - 0.2, 3.5, z)).toBe(true);
    const beside = NEAR_Z + FACADE_DIRECTION[2] * (DOORWAY[1] + 1.5);
    expect(solid(facadeX(beside) - 0.5, 1, beside)).toBe(true);
    // The cobbles off the deck lie at 0.
    expect(groundHeight(3, -8)).toBe(0);
    expect(groundHeight(0, 0)).toBe(0);
  });

  test('every swatch lies inside the canvas', () => {
    for (const { rect, metres } of Object.values(SWATCH)) {
      expect(rect[0]).toBeGreaterThanOrEqual(0);
      expect(rect[1]).toBeGreaterThanOrEqual(0);
      expect(rect[0] + rect[2]).toBeLessThanOrEqual(1);
      expect(rect[1] + rect[3]).toBeLessThanOrEqual(1);
      expect(Math.min(...metres)).toBeGreaterThan(0);
    }
  });
});

describe('café id map', () => {
  const WIDTH = 80;
  const HEIGHT = 100;
  const { positions, ids } = setTriangles();
  const map = drain(rasterizeIds(positions, ids, WIDTH, HEIGHT, ID.sky));
  const at = (u: number, v: number): number =>
    map[Math.floor(v * HEIGHT) * WIDTH + Math.floor(u * WIDTH)];

  test('names the surface the painter sees at each landmark', () => {
    expect(at(0.6, 0.92)).toBe(ID.ground);
    expect(at(0.35, 0.7)).toBe(ID.deck);
    expect(at(0.2, 0.6)).toBe(ID.facade);
    expect(at(0.12, 0.6)).toBe(ID.shopfront);
    expect(at(0.4, 0.38)).toBe(ID.awning);
    expect(at(0.42, 0.15)).toBe(ID.rearWing);
    expect(at(0.42, 0.56)).toBe(ID.rearWing);
    expect(at(0.6, 0.1)).toBe(ID.sky);
    expect(at(0.58, 0.45)).toBe(ID.farStreet);
    expect(at(0.695, 0.45)).toBe(ID.rightBlock);
    expect(at(0.9, 0.3)).toBe(ID.shop);
    expect(at(0.9, 0.52)).toBe(ID.shop);
  });

  test('the nearer surface wins, and a triangle behind the painter is clipped away', () => {
    // The awning hides the façade behind it; the ground runs under the painter's feet.
    expect(at(0.3, 0.33)).toBe(ID.awning);
    expect(at(0.5, 0.99)).toBe(ID.ground);
    const behind = [0, 1, 5, 1, 1, 5, 0, 2, 5];
    const empty = drain(rasterizeIds(behind, [7, 7, 7], 8, 8, 0));
    expect(empty.every((id) => id === 0)).toBe(true);
    const front = [-50, -50, -5, 50, -50, -5, 0, 80, -5];
    const full = drain(rasterizeIds(front, [7, 7, 7], 8, 8, 0));
    expect(full.every((id) => id === 7)).toBe(true);
    // Order does not matter: depth decides.
    const far = [-50, -50, -9, 50, -50, -9, 0, 80, -9];
    const both = drain(rasterizeIds([...front, ...far], [7, 7, 7, 3, 3, 3], 8, 8, 0));
    const flipped = drain(rasterizeIds([...far, ...front], [3, 3, 3, 7, 7, 7], 8, 8, 0));
    expect(both.every((id) => id === 7)).toBe(true);
    expect(flipped.every((id) => id === 7)).toBe(true);
  });

  test('a set that lies mostly off the canvas still builds in short steps', () => {
    // Triangles off to the left: none covers a pixel, and each still counts toward a yield.
    const off: number[] = [];
    for (let i = 0; i < 4000; i++) off.push(-40, 0, -5 - i * 0.01, -39, 0, -5, -40, 1, -5);
    const steps = rasterizeIds(off, new Array(off.length / 3).fill(4), WIDTH, HEIGHT, 0);
    let count = 0;
    while (!steps.next().done) count++;
    expect(count).toBeGreaterThanOrEqual(3);
  });
});
