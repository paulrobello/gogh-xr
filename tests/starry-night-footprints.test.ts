import { describe, expect, it } from 'vitest';
import { createFootprintTest, FOOTPRINT_MARGIN } from '../src/paintings/starry-night/footprints';
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

const CHURCH_RECT: readonly Vec2[] = [
  [-4, -30],
  [2, -30],
  [2, -20],
  [-4, -20],
];

describe('createFootprintTest on a hand-built village', () => {
  const h = house(10, -5, 0.4, 4, 3);
  const blocked = createFootprintTest({ houses: [h], church: { footprint: CHURCH_RECT } });

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

  it('blocks the church footprint plus the margin', () => {
    expect(blocked(-1, -25)).toBe(true);
    expect(blocked(2 + 0.29, -25)).toBe(true);
    expect(blocked(2 + 0.31, -25)).toBe(false);
    expect(blocked(-1, -30 - 0.29)).toBe(true);
    expect(blocked(-1, -30 - 0.31)).toBe(false);
  });

  it('leaves open ground open', () => {
    expect(blocked(0, 0)).toBe(false);
    expect(blocked(10, 5)).toBe(false);
  });

  it('takes the polygons in either winding', () => {
    const reversed = createFootprintTest({
      houses: [],
      church: { footprint: [...CHURCH_RECT].reverse() },
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

  it('blocks the church: its centre and every footprint corner', () => {
    const { church } = village;
    expect(blocked(church.center[0], church.center[2])).toBe(true);
    for (const [x, z] of church.footprint) expect(blocked(x, z)).toBe(true);
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
