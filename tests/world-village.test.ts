import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { projectToCanvas } from '../src/paintings/starry-night/canvas-camera';
import type { Vec3 } from '../src/render/strokes/frame';
import { createTerrain, TERRAIN_CELL } from '../src/world/terrain';
import {
  CHURCH_APEX_UV,
  CHURCH_MAX_BURIAL,
  CHURCH_MAX_REACH,
  CHURCH_U_EXTENT,
  createVillage,
  HOUSE_COUNT,
  HOUSE_HEIGHT,
  type HouseRecord,
  outlinesTouch,
  rooflineV,
  VILLAGE_BAND,
  VILLAGE_ROOFLINE,
  WINDOW_COLOR,
  WINDOW_OFFSET,
} from '../src/world/village';

interface Shape {
  readonly type: string;
  readonly points: readonly (readonly [number, number])[];
}
interface Region {
  readonly name: string;
  readonly shapes: readonly Shape[];
}
const regions = (
  JSON.parse(
    readFileSync(resolve(__dirname, '../assets/bake/starry-night/regions.json'), 'utf8'),
  ) as { regions: readonly Region[] }
).regions;
const polygon = (name: string): readonly (readonly [number, number])[] =>
  regions.find((r) => r.name === name)?.shapes[0]?.points ?? [];

/** The village polygon's top edge, v up: every vertex that is not on the frame's bottom edge. */
const paintedEdge = polygon('village')
  .filter(([, vDown]) => vDown < 1)
  .map(([u, vDown]) => [u, 1 - vDown] as const);
const edgeAt = (u: number): number => {
  for (let i = 0; i < paintedEdge.length - 1; i++) {
    const [u0, v0] = paintedEdge[i] as readonly [number, number];
    const [u1, v1] = paintedEdge[i + 1] as readonly [number, number];
    if (u >= u0 && u <= u1) return u1 === u0 ? v0 : v0 + ((u - u0) / (u1 - u0)) * (v1 - v0);
  }
  throw new Error(`u ${u} is off the roofline`);
};
const churchPoly = polygon('church');
const apexVertices = [...churchPoly].sort((a, b) => a[1] - b[1]).slice(0, 2);
const paintedApex = [
  (apexVertices[0]?.[0] ?? 0) / 2 + (apexVertices[1]?.[0] ?? 0) / 2,
  1 - (apexVertices[0]?.[1] ?? 0),
] as const;

const SEEDS = [1, 7, 42] as const;

type Outline = readonly (readonly [number, number])[];

/** Point inside (or on) a convex polygon given in either winding. */
const insideConvex = (p: readonly [number, number], poly: Outline): boolean => {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as readonly [number, number];
    const b = poly[(i + 1) % poly.length] as readonly [number, number];
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(c) < 1e-12) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
};

const segmentsCross = (
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
): boolean => {
  const o = (
    p: readonly [number, number],
    q: readonly [number, number],
    r: readonly [number, number],
  ) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
};

/** Convex polygons overlap when a vertex of one lies in the other or two edges cross. */
const overlaps = (a: Outline, b: Outline): boolean => {
  if (a.some((p) => insideConvex(p, b)) || b.some((p) => insideConvex(p, a))) return true;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const a0 = a[i] as readonly [number, number];
      const a1 = a[(i + 1) % a.length] as readonly [number, number];
      const b0 = b[j] as readonly [number, number];
      const b1 = b[(j + 1) % b.length] as readonly [number, number];
      if (segmentsCross(a0, a1, b0, b1)) return true;
    }
  }
  return false;
};

/** Footprint corners of a house, world xz. */
const corners = (h: HouseRecord): [number, number][] => {
  const c = Math.cos(h.yaw);
  const s = Math.sin(h.yaw);
  const out: [number, number][] = [];
  for (const [a, b] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const lx = (a * h.width) / 2;
    const lz = (b * h.depth) / 2;
    out.push([h.center[0] + lx * c + lz * s, h.center[2] - lx * s + lz * c]);
  }
  return out;
};

/** Points along every edge of a closed polygon, at most `step` apart, corners included. */
const perimeter = (poly: Outline, step: number): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as readonly [number, number];
    const b = poly[(i + 1) % poly.length] as readonly [number, number];
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
    for (let k = 0; k < n; k++) {
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
  }
  return out;
};

/** A grid over a polygon's axis-aligned bounds, at most `step` apart, edges included. */
const grid = (poly: Outline, step: number): [number, number][] => {
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const nx = Math.ceil((x1 - x0) / step);
  const nz = Math.ceil((z1 - z0) / step);
  const out: [number, number][] = [];
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) out.push([x0 + ((x1 - x0) * i) / nx, z0 + ((z1 - z0) * j) / nz]);
  }
  return out;
};

const positions = (g: BufferGeometry): Float32Array =>
  g.getAttribute('position').array as Float32Array;

describe('village constants', () => {
  it('copies the painted roofline and church apex from regions.json', () => {
    expect(VILLAGE_ROOFLINE.length).toBe(paintedEdge.length);
    VILLAGE_ROOFLINE.forEach(([u, v], i) => {
      expect(u).toBeCloseTo(paintedEdge[i]?.[0] ?? Number.NaN, 9);
      expect(v).toBeCloseTo(paintedEdge[i]?.[1] ?? Number.NaN, 9);
    });
    expect(CHURCH_APEX_UV[0]).toBeCloseTo(paintedApex[0], 9);
    expect(CHURCH_APEX_UV[1]).toBeCloseTo(paintedApex[1], 9);
    expect(CHURCH_U_EXTENT[0]).toBe(Math.min(...churchPoly.map(([u]) => u)));
    expect(CHURCH_U_EXTENT[1]).toBe(Math.max(...churchPoly.map(([u]) => u)));
    for (const u of [0, 0.2, 0.5, 0.86, 1]) expect(rooflineV(u)).toBeCloseTo(edgeAt(u), 9);
  });
});

describe('footprint overlap helpers', () => {
  it('detects overlap the way the test helper does', () => {
    const square = (x: number, z: number, h: number): Outline => [
      [x - h, z - h],
      [x + h, z - h],
      [x + h, z + h],
      [x - h, z + h],
    ];
    expect(overlaps(square(0, 0, 1), square(1.5, 0, 1))).toBe(true);
    expect(overlaps(square(0, 0, 1), square(2.5, 0, 1))).toBe(false);
    expect(outlinesTouch(square(0, 0, 1), square(2.4, 0, 1), 0.5)).toBe(true);
    expect(outlinesTouch(square(0, 0, 1), square(2.6, 0, 1), 0.5)).toBe(false);
  });
});

describe.each(SEEDS)('village, seed %i', (seed) => {
  const terrain = createTerrain(seed);
  const village = createVillage(seed, terrain);

  it('is deterministic per seed and differs between seeds', () => {
    const again = createVillage(seed, terrain);
    expect(again.houses).toEqual(village.houses);
    expect(again.church).toEqual(village.church);
    expect(again.windows).toEqual(village.windows);
    for (const k of ['building', 'roof', 'window', 'church'] as const) {
      expect(Array.from(positions(again.geometries[k]))).toEqual(
        Array.from(positions(village.geometries[k])),
      );
    }
    const other = createVillage(seed + 1000, terrain);
    expect(other.houses).not.toEqual(village.houses);
  });

  it('places about 20 realistic houses 15-40 m out', () => {
    expect(village.houses.length).toBe(HOUSE_COUNT);
    for (const h of village.houses) {
      const dist = Math.hypot(h.center[0], h.center[2]);
      expect(dist).toBeGreaterThanOrEqual(VILLAGE_BAND.min);
      expect(dist).toBeLessThanOrEqual(VILLAGE_BAND.max);
      const height = h.roofTop[1] - h.center[1];
      expect(height).toBeGreaterThanOrEqual(HOUSE_HEIGHT.min);
      expect(height).toBeLessThanOrEqual(HOUSE_HEIGHT.max);
      expect(h.eaveHeight).toBeGreaterThan(2.4);
      expect(h.eaveHeight).toBeLessThan(height);
    }
  });

  it('has no two footprints overlapping, the church included', () => {
    const outlines = [...village.houses.map((h) => h.outline), village.church.outline];
    for (const h of village.houses) {
      // Every wall corner lies inside the house's own roof outline.
      for (const p of corners(h)) expect(insideConvex(p, h.outline)).toBe(true);
    }
    for (const p of village.church.footprint) {
      expect(insideConvex(p, village.church.outline)).toBe(true);
    }
    for (let i = 0; i < outlines.length; i++) {
      for (let j = i + 1; j < outlines.length; j++) {
        expect(overlaps(outlines[i] as Outline, outlines[j] as Outline)).toBe(false);
      }
    }
  });

  it('rests every base on the terrain: no corner floats more than 5 cm', () => {
    for (const h of village.houses) {
      const ground = corners(h).map(([x, z]) => terrain.heightAt(x, z));
      for (const g of ground) expect(h.center[1]).toBeLessThanOrEqual(g + 0.05);
    }
    const churchCorners = village.church.walls.flat();
    for (const [x, z] of churchCorners) {
      expect(village.church.center[1]).toBeLessThanOrEqual(terrain.heightAt(x, z) + 0.05);
    }
  });

  it('floats no wall bottom: the base is at most 5 cm above the ground along every wall', () => {
    const halfCell = TERRAIN_CELL / 2;
    for (const h of village.houses) {
      const ground = perimeter(corners(h), halfCell).map(([x, z]) => terrain.heightAt(x, z));
      for (const g of ground) expect(h.center[1]).toBeLessThanOrEqual(g + 0.05);
      // Sunk no deeper than the lowest wall-bottom ground: the base rests on it.
      expect(Math.min(...ground) - h.center[1]).toBeLessThanOrEqual(0.05);
    }
    const churchGround = village.church.walls
      .flatMap((w) => perimeter(w, halfCell))
      .map(([x, z]) => terrain.heightAt(x, z));
    for (const g of churchGround) expect(village.church.center[1]).toBeLessThanOrEqual(g + 0.05);
    expect(Math.min(...churchGround) - village.church.center[1]).toBeLessThanOrEqual(0.05);
  });

  it("extends each house's walls down to its own base", () => {
    const p = positions(village.geometries.building);
    for (const h of village.houses) {
      let lowest = Infinity;
      for (let k = 0; k < p.length; k += 3) {
        const q: [number, number] = [p[k] as number, p[k + 2] as number];
        if (insideConvex(q, h.outline)) lowest = Math.min(lowest, p[k + 1] as number);
      }
      expect(lowest).toBeCloseTo(h.center[1], 4);
    }
  });

  it('lands each roof on the painted roofline and the steeple on the apex', () => {
    expect(village.houses.length).toBeGreaterThan(0);
    for (const h of village.houses) {
      const p = projectToCanvas(h.roofTop);
      expect(p.inFrustum).toBe(true);
      const [u, v] = p.uv as readonly [number, number];
      const tol = u > 0.85 ? 0.05 : 0.03;
      const err = Math.abs(v - edgeAt(u));
      expect(err).toBeLessThanOrEqual(tol);
    }
    const tip = projectToCanvas(village.church.steepleTip);
    expect(tip.inFrustum).toBe(true);
    const [tu, tv] = tip.uv as readonly [number, number];
    expect(Math.abs(tu - paintedApex[0])).toBeLessThanOrEqual(0.03);
    expect(Math.abs(tv - paintedApex[1])).toBeLessThanOrEqual(0.03);
  });

  it('keeps every house silhouette clear of the church in the painter view', () => {
    const lo = Math.min(...churchPoly.map(([u]) => u));
    const hi = Math.max(...churchPoly.map(([u]) => u));
    for (const h of village.houses) {
      const us: number[] = [];
      for (const [x, z] of h.outline) {
        for (const y of [h.center[1], h.roofTop[1]]) {
          const uv = projectToCanvas([x, y, z]).uv;
          expect(uv).not.toBeNull();
          us.push((uv as readonly [number, number])[0]);
        }
      }
      expect(Math.max(...us) < lo || Math.min(...us) > hi).toBe(true);
    }
  });

  it('gives the church a nave and a tall, thin steeple', () => {
    const c = village.church;
    const steeple = c.steepleTip[1] - c.center[1];
    expect(steeple).toBeGreaterThanOrEqual(10);
    expect(steeple).toBeLessThanOrEqual(16);
    expect(steeple / c.steepleWidth).toBeGreaterThan(4);
    expect(c.naveRidge).toBeLessThan(steeple / 1.5);
    const dist = Math.hypot(c.steepleTip[0], c.steepleTip[2]);
    expect(dist).toBeGreaterThanOrEqual(VILLAGE_BAND.min);
    expect(dist).toBeLessThanOrEqual(VILLAGE_BAND.max);
    const tipU = projectToCanvas(c.steepleTip).uv?.[0] ?? -1;
    expect(tipU).toBeGreaterThan(0.49);
    expect(tipU).toBeLessThan(0.6);
  });

  it('tags every geometry with its world layer', () => {
    expect(village.geometries.building.userData.layer).toBe('building');
    expect(village.geometries.roof.userData.layer).toBe('roof');
    expect(village.geometries.window.userData.layer).toBe('window');
    expect(village.geometries.church.userData.layer).toBe('church');
    for (const k of ['building', 'roof', 'window', 'church'] as const) {
      const g = village.geometries[k];
      expect(g.getAttribute('position').count).toBeGreaterThan(0);
      expect(g.getAttribute('position').count % 3).toBe(0);
      expect(g.getAttribute('normal').count).toBe(g.getAttribute('position').count);
    }
  });

  it('builds emissive warm-yellow windows just outside their walls', () => {
    expect(village.windows.length).toBeGreaterThanOrEqual(HOUSE_COUNT);
    expect(village.geometries.window.userData.emissive).toBe(true);
    expect(village.geometries.window.userData.color).toEqual(WINDOW_COLOR);
    const [r, g, b] = WINDOW_COLOR;
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(village.geometries.window.getAttribute('position').count).toBe(
      village.windows.length * 6,
    );
    for (const w of village.windows) {
      const h = village.houses[w.house] as HouseRecord;
      // The window's offset along its outward normal from the house centre is half the wall span
      // plus WINDOW_OFFSET.
      const dx = w.center[0] - h.center[0];
      const dz = w.center[2] - h.center[2];
      const along = dx * w.normal[0] + dz * w.normal[2];
      const half = w.onGable ? h.width / 2 : h.depth / 2;
      expect(along).toBeCloseTo(half + WINDOW_OFFSET, 6);
      expect(Math.hypot(...(w.normal as Vec3))).toBeCloseTo(1, 9);
      // Fully above the ground at every footprint corner and below the eaves.
      const groundTop = Math.max(...corners(h).map(([x, z]) => terrain.heightAt(x, z)));
      expect(w.center[1] - w.height / 2).toBeGreaterThan(groundTop);
      expect(w.center[1] + w.height / 2).toBeLessThan(h.center[1] + h.eaveHeight);
    }
  });
});

describe('church bounds over seeds 1-30', () => {
  it('fits a 10-16 m steeple on the apex, within reach and barely buried, without fallback', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const terrain = createTerrain(seed);
      const c = createVillage(seed, terrain).church;
      expect(c.fitted, `seed ${seed}`).toBe(true);
      const steeple = c.steepleTip[1] - c.center[1];
      expect(steeple, `seed ${seed}`).toBeGreaterThanOrEqual(10);
      expect(steeple, `seed ${seed}`).toBeLessThanOrEqual(16);
      const [tu, tv] = projectToCanvas(c.steepleTip).uv as readonly [number, number];
      expect(Math.abs(tu - paintedApex[0]), `seed ${seed}`).toBeLessThanOrEqual(0.03);
      expect(Math.abs(tv - paintedApex[1]), `seed ${seed}`).toBeLessThanOrEqual(0.03);
      for (const [x, z] of c.outline) {
        expect(Math.hypot(x, z), `seed ${seed}`).toBeLessThanOrEqual(CHURCH_MAX_REACH);
      }
      expect(CHURCH_MAX_REACH).toBe(48);
      expect(CHURCH_MAX_BURIAL).toBe(1);
      for (const w of c.walls) {
        for (const [x, z] of [...grid(w, TERRAIN_CELL / 2), ...perimeter(w, TERRAIN_CELL / 2)]) {
          expect(terrain.heightAt(x, z) - c.center[1], `seed ${seed}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
