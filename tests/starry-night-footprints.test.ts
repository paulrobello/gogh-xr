import { describe, expect, it } from 'vitest';
import {
  CROWN_EYE_HEIGHT,
  createCrownTest,
  createFootprintTest,
  createVolumeTest,
  FOOTPRINT_MARGIN,
} from '../src/paintings/starry-night/footprints';
import { CYPRESS_LOWER_SEGMENTS, CYPRESS_SEGMENTS, createCypress } from '../src/world/cypress';
import { toWorld } from '../src/world/house-geometry';
import { createTerrain } from '../src/world/terrain';
import { createVillage, type HouseRecord } from '../src/world/village';

type Vec2 = readonly [number, number];

/** A house record with only the fields a footprint reads; the rest are unused filler. */
function house(cx: number, cz: number, yaw: number, width: number, depth: number): HouseRecord {
  return {
    center: [cx, -3, cz],
    yaw,
    width,
    depth,
    eaveHeight: 3,
    ridgeHeight: 5,
    outline: [],
    roofTop: [cx, 2, cz],
  };
}

/** A world xz point in a house's local frame, through village.ts's own transform. */
function local(h: HouseRecord, lx: number, lz: number): Vec2 {
  const p = toWorld({ cx: h.center[0], cz: h.center[2], base: 0, yaw: h.yaw }, lx, 0, lz);
  return [p[0], p[2]];
}

/** A nave 6 m wide and 8 m long, with a 2 m wide tower in front of its middle. */
const NAVE: readonly Vec2[] = [
  [-4, -30],
  [2, -30],
  [2, -22],
  [-4, -22],
];
const TOWER: readonly Vec2[] = [
  [-1, -22],
  [1, -22],
  [1, -20],
  [-1, -20],
];
const CHURCH_WALLS = [TOWER, NAVE] as const;

describe('createFootprintTest on a hand-built village', () => {
  const h = house(10, -5, 0.4, 4, 3);
  const blocked = createFootprintTest({ houses: [h], church: { walls: CHURCH_WALLS } });

  it('blocks a house’s walls plus the 0.3 m margin, on its rotated axes', () => {
    expect(FOOTPRINT_MARGIN).toBe(0.3);
    const inside = FOOTPRINT_MARGIN - 0.01;
    const outside = FOOTPRINT_MARGIN + 0.01;
    for (const sign of [-1, 1]) {
      expect(blocked(...local(h, sign * (2 + inside), 0))).toBe(true);
      expect(blocked(...local(h, sign * (2 + outside), 0))).toBe(false);
      expect(blocked(...local(h, 0, sign * (1.5 + inside)))).toBe(true);
      expect(blocked(...local(h, 0, sign * (1.5 + outside)))).toBe(false);
    }
    expect(blocked(10, -5)).toBe(true);
    // The wall corner grown by the margin on both axes.
    expect(blocked(...local(h, 2 + inside, 1.5 + inside))).toBe(true);
  });

  it('blocks the church nave and tower plus the margin', () => {
    expect(blocked(-1, -25)).toBe(true);
    expect(blocked(2 + 0.29, -25)).toBe(true);
    expect(blocked(2 + 0.31, -25)).toBe(false);
    expect(blocked(-1, -30 - 0.29)).toBe(true);
    expect(blocked(-1, -30 - 0.31)).toBe(false);
    expect(blocked(0, -20 + 0.29)).toBe(true);
    expect(blocked(0, -20 + 0.31)).toBe(false);
  });

  it('leaves the open ground beside the tower open, which its bounding box blocked', () => {
    // Beside the tower (x 1..2, z -22..-20) is inside the church's bounding rectangle.
    for (const z of [-21, -20.5, -21.7]) {
      expect(blocked(1.5, z), `1.5, ${z}`).toBe(false);
      expect(blocked(-1.5, z), `-1.5, ${z}`).toBe(false);
    }
    expect(blocked(1 + 0.29, -21)).toBe(true);
    expect(blocked(1 + 0.31, -21)).toBe(false);
  });

  it('leaves open ground open', () => {
    expect(blocked(0, 0)).toBe(false);
    expect(blocked(10, 5)).toBe(false);
  });

  it('takes the polygons in either winding', () => {
    const reversed = createFootprintTest({
      houses: [],
      church: { walls: [[...TOWER].reverse(), [...NAVE].reverse()] },
    });
    expect(reversed(-1, -25)).toBe(true);
    expect(reversed(2 + 0.31, -25)).toBe(false);
  });
});

describe('createFootprintTest on the seed-1 village', () => {
  const village = createVillage(1, createTerrain(1));
  const blocked = createFootprintTest(village);

  it('blocks every house centre and every corner of its roof outline (walls plus overhang)', () => {
    expect(village.houses.length).toBeGreaterThan(10);
    for (const record of village.houses) {
      expect(blocked(record.center[0], record.center[2])).toBe(true);
      for (const [x, z] of record.outline) expect(blocked(x, z), `${x}, ${z}`).toBe(true);
    }
  });

  it('blocks the church: the centre of its tower and nave, and every wall corner', () => {
    const { church } = village;
    for (const wall of church.walls) {
      const cx = wall.reduce((sum, p) => sum + p[0], 0) / wall.length;
      const cz = wall.reduce((sum, p) => sum + p[1], 0) / wall.length;
      expect(blocked(cx, cz)).toBe(true);
      for (const [x, z] of wall) expect(blocked(x, z)).toBe(true);
    }
  });

  it('keeps the whole nave roof overhang inside the 0.3 m margin', () => {
    const { church } = village;
    const nave = church.walls[1] as readonly Vec2[];
    const xs = nave.map((p) => p[0]);
    const zs = nave.map((p) => p[1]);
    // The generator's own overhang: its roof outline is the wall bounds grown by it.
    const overhang = Math.abs((church.footprint[0] as Vec2)[0] - (church.outline[0] as Vec2)[0]);
    expect(overhang).toBeGreaterThan(0);
    expect(overhang).toBeLessThan(FOOTPRINT_MARGIN);
    // The roof's outline: the nave walls grown by the overhang, walked at 0.1 m.
    const x0 = Math.min(...xs) - overhang;
    const x1 = Math.max(...xs) + overhang;
    const z0 = Math.min(...zs) - overhang;
    const z1 = Math.max(...zs) + overhang;
    for (let x = x0; x <= x1 + 1e-9; x += 0.1) {
      for (const z of [z0, z1]) expect(blocked(x, z), `${x}, ${z}`).toBe(true);
    }
    for (let z = z0; z <= z1 + 1e-9; z += 0.1) {
      for (const x of [x0, x1]) expect(blocked(x, z), `${x}, ${z}`).toBe(true);
    }
  });

  it('leaves the ground beside the tower open, inside the church bounding box', () => {
    const { church } = village;
    const tower = church.walls[0] as readonly Vec2[];
    const tx = tower.map((p) => p[0]);
    const tz = tower.map((p) => p[1]);
    const z = (Math.min(...tz) + Math.max(...tz)) / 2;
    const box = church.footprint;
    const boxX = box.map((p) => p[0]);
    const boxZ = box.map((p) => p[1]);
    // The nave is wider than the tower, so the box holds ground beside the tower, 1 m clear of its
    // wall, at the tower's z, where the nave is not.
    const side = Math.min(...tx) - 1;
    expect(side).toBeGreaterThan(Math.min(...boxX));
    expect(z).toBeGreaterThan(Math.min(...boxZ));
    expect(z).toBeLessThan(Math.max(...boxZ));
    expect(blocked(side, z)).toBe(false);
  });

  it('leaves the ground around the painter’s spot open', () => {
    for (let r = 0; r <= 10; r += 1) {
      for (let a = 0; a < 16; a += 1) {
        const angle = (a / 16) * 2 * Math.PI;
        expect(blocked(r * Math.cos(angle), r * Math.sin(angle))).toBe(false);
      }
    }
  });
});

describe('createVolumeTest', () => {
  const h = { ...house(10, -5, 0.4, 4, 3), eaveHeight: 3, ridgeHeight: 5 };
  const inside = createVolumeTest({
    houses: [h],
    church: {
      walls: CHURCH_WALLS,
      center: [0, -2, -25],
      naveRidge: 4.8,
      steepleTip: [0, 8, -21],
    },
  });

  it('blocks below the wall top and clears above the roof', () => {
    // House centre is the ridge: the roof is 5 m over the base at y -3, so up to y 2.
    expect(inside(10, 1.9, -5)).toBe(true);
    expect(inside(10, 2.1, -5)).toBe(false);
    expect(inside(10, -2.9, -5)).toBe(true);
  });

  it('follows the gable: the eave over the long walls, the ridge over the centre line', () => {
    const along = (lz: number, y: number): boolean => {
      const [x, z] = local(h, 0, lz);
      return inside(x, y, z);
    };
    // Near a long wall the roof is at the eave, y 0 (3 m over base -3); at the ridge y 2.
    expect(along(1.4, 0.2)).toBe(false);
    expect(along(1.4, -0.2)).toBe(true);
    expect(along(0, 1.9)).toBe(true);
    // The margin outside the wall is capped at the eave.
    expect(along(1.5 + 0.2, -0.2)).toBe(true);
    expect(along(1.5 + 0.2, 0.2)).toBe(false);
    expect(along(1.5 + 0.4, -2)).toBe(false);
  });

  it('blocks the church at its tower and nave but not beside the tower', () => {
    expect(inside(0, 3, -21)).toBe(true);
    expect(inside(0, 7, -21)).toBe(true);
    // The nave is a gable with its ridge along z at x -1: the ridge top is y 2.8, the eave 1.2.
    expect(inside(-1, 2.7, -26)).toBe(true);
    expect(inside(-1, 2.9, -26)).toBe(false);
    expect(inside(1.9, 1.1, -26)).toBe(true);
    expect(inside(1.9, 1.5, -26)).toBe(false);
    expect(inside(1.5, 1, -21)).toBe(false);
  });
});

describe('createCrownTest on the seed-1 cypress', () => {
  const terrain = createTerrain(1);
  const cypress = createCypress(1, terrain);
  const crown = createCrownTest(cypress, terrain.heightAt);
  const masses = [cypress.main, cypress.lower];

  it('blocks a landing under each mass’s base axis', () => {
    for (const mass of masses) expect(crown(mass.base[0], mass.base[2])).toBe(true);
  });

  it('blocks every vertex of the lowest ring and the margin just outside it', () => {
    const positions = cypress.geometry.getAttribute('position');
    for (const [mass, segs] of [
      [cypress.main, CYPRESS_SEGMENTS],
      [cypress.lower, CYPRESS_LOWER_SEGMENTS],
    ] as const) {
      // A foot at the mass's own base height tests the lowest rings wherever the point is.
      const atBase = createCrownTest(cypress, () => mass.base[1]);
      let cx = 0;
      let cz = 0;
      for (let k = 0; k < segs; k += 1) {
        cx += positions.getX(mass.firstVertex + k) / segs;
        cz += positions.getZ(mass.firstVertex + k) / segs;
      }
      for (let k = 0; k < segs; k += 1) {
        const v = mass.firstVertex + k;
        const x = positions.getX(v);
        const z = positions.getZ(v);
        expect(crown(x, z), `vertex ${v}`).toBe(true);
        // 0.25 m straight out from the vertex: inside the 0.3 m margin.
        const len = Math.hypot(x - cx, z - cz);
        expect(
          atBase(x + ((x - cx) / len) * 0.25, z + ((z - cz) / len) * 0.25),
          `margin ${v}`,
        ).toBe(true);
      }
    }
  });

  it('leaves ground clear of the crown open, a body width past the widest ring', () => {
    const main = cypress.main;
    for (const [dx, dz] of [
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const reach = main.maxDiameter / 2 + 1;
      expect(crown(main.base[0] + dx * reach, main.base[2] + dz * reach)).toBe(false);
    }
  });

  it('leaves the spawn and its surroundings open', () => {
    for (let r = 0; r <= 4; r += 1) {
      for (let a = 0; a < 16; a += 1) {
        const angle = (a / 16) * 2 * Math.PI;
        expect(crown(r * Math.cos(angle), r * Math.sin(angle))).toBe(false);
      }
    }
  });

  it('tests the crown at the eye: ground above the crown, or its eye above the tip, is open', () => {
    const [x, tipY, z] = cypress.main.tip;
    // The eye is 0.2 m above the tip: the foot, 1.4 m under it, is in the thin top.
    expect(createCrownTest(cypress, () => tipY - CROWN_EYE_HEIGHT + 0.2)(x, z)).toBe(true);
    // The foot is above the tip.
    expect(createCrownTest(cypress, () => tipY + 0.5)(x, z)).toBe(false);
  });
});
