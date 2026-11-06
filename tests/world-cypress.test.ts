import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { projectToCanvas } from '../src/paintings/starry-night/canvas-camera';
import type { Vec3 } from '../src/render/strokes/frame';
import {
  CYPRESS_APEX_UV,
  CYPRESS_HEIGHT_ATTRIBUTE,
  CYPRESS_LAYER,
  CYPRESS_LOBE_ATTRIBUTE,
  CYPRESS_OUTLINE,
  type Cypress,
  type CypressMass,
  createCypress,
} from '../src/world/cypress';
import { createTerrain, TERRAIN_CELL, type Terrain } from '../src/world/terrain';

type P2 = readonly [number, number];

interface Shape {
  readonly type: string;
  readonly points: readonly P2[];
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

/** The painted cypress polygon, v up (v = 1 − v_json). */
const painted: readonly P2[] = (
  regions.find((r) => r.name === 'cypress')?.shapes[0]?.points ?? []
).map(([u, vDown]) => [u, 1 - vDown] as const);
/** The polygon's apex: its topmost vertex. */
const paintedApex = [...painted].sort((a, b) => b[1] - a[1])[0] as P2;

const SEEDS = [1, 7, 42] as const;
const DILATION = 0.03;
/** Coverage is measured against the polygon eroded by this much, in canvas units. */
const EROSION = 0.01;
/** Coverage raster cell, canvas units. */
const CELL = 0.0025;

const insidePolygon = (p: P2, poly: readonly P2[]): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as P2;
    const b = poly[j] as P2;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
};
const segmentDistance = (p: P2, a: P2, b: P2): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const edgeDistance = (p: P2, poly: readonly P2[]): number =>
  Math.min(...poly.map((a, i) => segmentDistance(p, a, poly[(i + 1) % poly.length] as P2)));
/** Inside the polygon grown by `pad`. */
const insideDilated = (p: P2, poly: readonly P2[], pad: number): boolean =>
  insidePolygon(p, poly) || edgeDistance(p, poly) <= pad;
/** Inside the polygon shrunk by `pad`. */
const insideEroded = (p: P2, poly: readonly P2[], pad: number): boolean =>
  insidePolygon(p, poly) && edgeDistance(p, poly) >= pad;

const vertex = (g: BufferGeometry, i: number): Vec3 => {
  const p = g.getAttribute('position');
  return [p.getX(i), p.getY(i), p.getZ(i)];
};
const vertices = (g: BufferGeometry): Vec3[] =>
  Array.from({ length: g.getAttribute('position').count }, (_, i) => vertex(g, i));
const massIds = (m: CypressMass): number[] =>
  Array.from({ length: m.vertexCount }, (_, k) => m.firstVertex + k);

/** A mass's horizontal rings, bottom to top, each a list of vertex indices sharing one y. */
const rings = (g: BufferGeometry, m: CypressMass): number[][] => {
  const byY = new Map<number, number[]>();
  for (const i of massIds(m)) {
    const y = vertex(g, i)[1];
    byY.set(y, [...(byY.get(y) ?? []), i]);
  }
  return [...byY.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ids]) => ids)
    .filter((ids) => ids.length > 1);
};

/**
 * Rasterises the projected triangles onto a canvas grid and returns the share of eroded-polygon
 * cells covered: over the whole in-frame polygon, and over its lower-right block (u > 0.3, v < 0.4).
 */
const coverage = (g: BufferGeometry): { whole: number; lowerRight: number } => {
  const n = Math.round(1 / CELL);
  const hit = new Uint8Array(n * n);
  const index = Array.from(g.getIndex()?.array ?? []);
  for (let t = 0; t < index.length; t += 3) {
    const q = [0, 1, 2].map((k) => projectToCanvas(vertex(g, index[t + k] as number)).uv);
    if (q.some((uv) => uv === null)) continue;
    const [a, b, c] = q as [P2, P2, P2];
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (area === 0) continue;
    const us = [a[0], b[0], c[0]];
    const vs = [a[1], b[1], c[1]];
    const i0 = Math.max(0, Math.floor(Math.min(...us) / CELL));
    const i1 = Math.min(n - 1, Math.ceil(Math.max(...us) / CELL));
    const j0 = Math.max(0, Math.floor(Math.min(...vs) / CELL));
    const j1 = Math.min(n - 1, Math.ceil(Math.max(...vs) / CELL));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const x = (i + 0.5) * CELL;
        const y = (j + 0.5) * CELL;
        const w0 = ((b[0] - x) * (c[1] - y) - (b[1] - y) * (c[0] - x)) / area;
        const w1 = ((c[0] - x) * (a[1] - y) - (c[1] - y) * (a[0] - x)) / area;
        if (w0 >= 0 && w1 >= 0 && 1 - w0 - w1 >= 0) hit[i * n + j] = 1;
      }
    }
  }
  const us = painted.map(([u]) => u);
  let whole = 0;
  let wholeHit = 0;
  let block = 0;
  let blockHit = 0;
  for (let i = Math.floor(Math.min(...us) / CELL); i <= Math.ceil(Math.max(...us) / CELL); i++) {
    for (let j = 0; j < n; j++) {
      const p: P2 = [(i + 0.5) * CELL, (j + 0.5) * CELL];
      if (!insideEroded(p, painted, EROSION)) continue;
      const h = hit[i * n + j] as number;
      whole++;
      wholeHit += h;
      if (p[0] > 0.3 && p[1] < 0.4) {
        block++;
        blockHit += h;
      }
    }
  }
  return { whole: wholeHit / whole, lowerRight: blockHit / block };
};

const terrains = new Map<number, Terrain>();
const terrainFor = (seed: number): Terrain => {
  let t = terrains.get(seed);
  if (!t) {
    t = createTerrain(seed);
    terrains.set(seed, t);
  }
  return t;
};
const cypresses = new Map<number, Cypress>();
const cypressFor = (seed: number): Cypress => {
  let c = cypresses.get(seed);
  if (!c) {
    c = createCypress(seed, terrainFor(seed));
    cypresses.set(seed, c);
  }
  return c;
};
const masses = (c: Cypress): CypressMass[] => [c.main, c.lower];

describe('cypress outline constant', () => {
  it('is the regions.json cypress polygon with v up', () => {
    expect(CYPRESS_OUTLINE.length).toBe(painted.length);
    CYPRESS_OUTLINE.forEach((p, i) => {
      expect(p[0]).toBeCloseTo((painted[i] as P2)[0], 9);
      expect(p[1]).toBeCloseTo((painted[i] as P2)[1], 9);
    });
    expect(CYPRESS_APEX_UV[0]).toBeCloseTo(paintedApex[0], 9);
    expect(CYPRESS_APEX_UV[1]).toBeCloseTo(paintedApex[1], 9);
  });
});

describe('cypress generator', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = createCypress(7, terrainFor(7));
    const b = createCypress(7, terrainFor(7));
    for (const name of ['position', CYPRESS_HEIGHT_ATTRIBUTE, CYPRESS_LOBE_ATTRIBUTE]) {
      expect(Array.from(a.geometry.getAttribute(name).array)).toEqual(
        Array.from(b.geometry.getAttribute(name).array),
      );
    }
    expect(Array.from(a.geometry.getIndex()?.array ?? [])).toEqual(
      Array.from(b.geometry.getIndex()?.array ?? []),
    );
    const c = createCypress(8, terrainFor(7));
    expect(Array.from(c.geometry.getAttribute('position').array)).not.toEqual(
      Array.from(a.geometry.getAttribute('position').array),
    );
  });

  it('pins the seed 7 snapshot: counts and bounding box to 1 mm', () => {
    const { geometry } = cypressFor(7);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const mm = (x: number): number => Math.round(x * 1000) / 1000;
    expect(geometry.getAttribute('position').count).toBe(1370);
    expect((geometry.getIndex()?.count ?? 0) / 3).toBe(2688);
    expect([box?.min.x, box?.min.y, box?.min.z].map((x) => mm(x as number))).toEqual([
      -4.93, -5.096, -11.124,
    ]);
    expect([box?.max.x, box?.max.y, box?.max.z].map((x) => mm(x as number))).toEqual([
      -0.304, 9.38, -7.908,
    ]);
  });

  it('tags the geometry with the cypress layer and stays low-poly', () => {
    for (const seed of SEEDS) {
      const { geometry, main, lower } = cypressFor(seed);
      expect(geometry.userData.layer).toBe(CYPRESS_LAYER);
      expect(CYPRESS_LAYER).toBe('cypress');
      const index = geometry.getIndex();
      expect(index).not.toBeNull();
      const triangles = (index?.count ?? 0) / 3;
      expect(triangles).toBeGreaterThan(500);
      expect(triangles).toBeLessThan(3000);
      expect(geometry.getAttribute('normal')).toBeDefined();
      expect(main.firstVertex).toBe(0);
      expect(lower.firstVertex).toBe(main.vertexCount);
      expect(main.vertexCount + lower.vertexCount).toBe(geometry.getAttribute('position').count);
    }
  });

  it('winds every face outward from its mass axis', () => {
    for (const seed of SEEDS) {
      const cypress = cypressFor(seed);
      const { geometry } = cypress;
      const ids = Array.from(geometry.getIndex()?.array ?? []);
      for (let t = 0; t < ids.length; t += 3) {
        const first = ids[t] as number;
        const mass = first < cypress.lower.firstVertex ? cypress.main : cypress.lower;
        const [p, q, r] = [ids[t], ids[t + 1], ids[t + 2]].map((i) =>
          vertex(geometry, i as number),
        ) as [Vec3, Vec3, Vec3];
        const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]] as const;
        const e2 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]] as const;
        const nx = e1[1] * e2[2] - e1[2] * e2[1];
        const nz = e1[0] * e2[1] - e1[1] * e2[0];
        const cy = (p[1] + q[1] + r[1]) / 3;
        // The axis centre nearest the face's height.
        const centre = mass.axis.reduce((m, s) =>
          Math.abs(s[1] - cy) < Math.abs(m[1] - cy) ? s : m,
        );
        const out =
          nx * ((p[0] + q[0] + r[0]) / 3 - centre[0]) + nz * ((p[2] + q[2] + r[2]) / 3 - centre[2]);
        expect(out).toBeGreaterThan(0);
      }
    }
  });

  it('gives the main mass a height-to-width ratio of 4 to 6, measured on the mesh', () => {
    for (const seed of SEEDS) {
      const { geometry, main, lower } = cypressFor(seed);
      const ys = massIds(main).map((i) => vertex(geometry, i)[1]);
      const total = Math.max(...ys) - Math.min(...ys);
      // Maximum horizontal diameter: the longest chord of any horizontal ring.
      let widest = 0;
      for (const ids of rings(geometry, main)) {
        for (const i of ids) {
          for (const j of ids) {
            const a = vertex(geometry, i);
            const b = vertex(geometry, j);
            widest = Math.max(widest, Math.hypot(a[0] - b[0], a[2] - b[2]));
          }
        }
      }
      expect(total / widest).toBeGreaterThanOrEqual(4);
      expect(total / widest).toBeLessThanOrEqual(6);
      expect(main.height).toBeCloseTo(total, 4);
      expect(main.maxDiameter).toBeCloseTo(widest, 4);
      // The lower mass is a smaller flame below the main tip.
      expect(lower.height).toBeLessThan(main.height);
      expect(lower.tip[1]).toBeLessThan(main.tip[1]);
    }
  });

  it('writes a per-mass normalised height and an integer lobe id on every vertex', () => {
    for (const seed of SEEDS) {
      const cypress = cypressFor(seed);
      const { geometry, lobeCount, main, lower } = cypress;
      const n = geometry.getAttribute('position').count;
      const h = geometry.getAttribute(CYPRESS_HEIGHT_ATTRIBUTE);
      const lobe = geometry.getAttribute(CYPRESS_LOBE_ATTRIBUTE);
      expect(h.count).toBe(n);
      expect(h.itemSize).toBe(1);
      expect(h.array).toBeInstanceOf(Float32Array);
      expect(lobe.count).toBe(n);
      expect(lobe.itemSize).toBe(1);
      expect(lobe.normalized).toBe(false);
      expect(main.lobeCount).toBeGreaterThanOrEqual(3);
      expect(lower.lobeCount).toBeGreaterThanOrEqual(2);
      expect(main.firstLobe).toBe(0);
      expect(lower.firstLobe).toBe(main.lobeCount);
      expect(lobeCount).toBe(main.lobeCount + lower.lobeCount);

      const seen = new Set<number>();
      for (const mass of masses(cypress)) {
        const ids = massIds(mass);
        const ys = ids.map((i) => vertex(geometry, i)[1]);
        const y0 = Math.min(...ys);
        const y1 = Math.max(...ys);
        const hs = ids.map((i) => h.getX(i));
        expect(Math.min(...hs)).toBe(0);
        expect(Math.max(...hs)).toBe(1);
        ids.forEach((i, k) => {
          expect(h.getX(i)).toBeCloseTo(((ys[k] as number) - y0) / (y1 - y0), 4);
          const id = lobe.getX(i);
          expect(Number.isInteger(id)).toBe(true);
          expect(id).toBeGreaterThanOrEqual(mass.firstLobe);
          expect(id).toBeLessThan(mass.firstLobe + mass.lobeCount);
          seen.add(id);
        });
      }
      expect(seen.size).toBe(lobeCount);
    }
  });

  it('twists its lobes around the axis', () => {
    for (const seed of SEEDS) {
      const cypress = cypressFor(seed);
      const lobe = cypress.geometry.getAttribute(CYPRESS_LOBE_ATTRIBUTE);
      for (const mass of masses(cypress)) {
        expect(Math.abs(mass.twist)).toBeGreaterThanOrEqual(Math.PI / 2);
      }
      const rs = rings(cypress.geometry, cypress.main);
      // The lobe on the same angular segment changes between the lowest and highest rings.
      const bottom = (rs[0] as number[]).map((i) => lobe.getX(i));
      const top = (rs[rs.length - 1] as number[]).map((i) => lobe.getX(i));
      expect(bottom).not.toEqual(top);
    }
  });

  it('keeps the hull inside the painted silhouette through the painter camera', () => {
    for (const seed of SEEDS) {
      const cypress = cypressFor(seed);
      const { geometry } = cypress;
      const apex = projectToCanvas(cypress.main.tip).uv;
      expect(apex).not.toBeNull();
      expect(Math.abs((apex as P2)[0] - paintedApex[0])).toBeLessThanOrEqual(0.03);
      expect(Math.abs((apex as P2)[1] - paintedApex[1])).toBeLessThanOrEqual(0.03);

      let tested = 0;
      let inside = 0;
      for (const mass of masses(cypress)) {
        for (const ids of rings(geometry, mass)) {
          const projected = ids
            .map((i) => projectToCanvas(vertex(geometry, i)))
            .filter((p) => p.uv !== null)
            .map((p) => p.uv as P2);
          if (projected.length === 0) continue;
          const left = projected.reduce((a, b) => (b[0] < a[0] ? b : a));
          const right = projected.reduce((a, b) => (b[0] > a[0] ? b : a));
          for (const p of [left, right]) {
            if (p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1) continue;
            tested++;
            if (insideDilated(p, painted, DILATION)) inside++;
          }
        }
      }
      expect(tested).toBeGreaterThanOrEqual(40);
      expect(inside / tested).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('covers the painted silhouette, its lower-right block included', () => {
    for (const seed of SEEDS) {
      const { whole, lowerRight } = coverage(cypressFor(seed).geometry);
      expect(whole).toBeGreaterThanOrEqual(0.8);
      expect(lowerRight).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('seats each base on the terrain without floating or sinking past its footprint', () => {
    for (const seed of SEEDS) {
      const terrain = terrainFor(seed);
      const cypress = cypressFor(seed);
      const { geometry } = cypress;
      for (const mass of masses(cypress)) {
        const pts = (rings(geometry, mass)[0] as number[]).map((i) => vertex(geometry, i));
        const y = (pts[0] as Vec3)[1];
        expect(mass.base[1]).toBeCloseTo(y, 5);
        expect(y).toBeCloseTo(Math.min(...massIds(mass).map((i) => vertex(geometry, i)[1])), 6);
        // Every base vertex and every point along the base ring's edges is on or under the
        // ground, and the ring is no deeper than the lowest ground along it.
        let lowest = Number.POSITIVE_INFINITY;
        for (let k = 0; k < pts.length; k++) {
          const a = pts[k] as Vec3;
          const b = pts[(k + 1) % pts.length] as Vec3;
          const steps = Math.max(
            1,
            Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / (TERRAIN_CELL / 8)),
          );
          for (let s = 0; s <= steps; s++) {
            const g = terrain.heightAt(
              a[0] + ((b[0] - a[0]) * s) / steps,
              a[2] + ((b[2] - a[2]) * s) / steps,
            );
            lowest = Math.min(lowest, g);
            expect(y).toBeLessThanOrEqual(g + 0.05);
          }
        }
        expect(y).toBeGreaterThanOrEqual(lowest - 0.05);
      }
    }
  });

  it('stays clear of the flat top and the standing area at the spot', () => {
    for (const seed of SEEDS) {
      for (const [x, , z] of vertices(cypressFor(seed).geometry)) {
        expect(Math.hypot(x, z)).toBeGreaterThan(2);
      }
    }
  });
});
