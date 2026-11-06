import { describe, expect, it } from 'vitest';
import { EYE_HEIGHT, PAINTER_SPOT } from '../src/paintings/starry-night/canvas-camera';
import { mulberry32 } from '../src/util/prng';
import { createValueNoise2D, fbm2 } from '../src/world/noise';
import {
  createTerrain,
  RIDGE_FOOT_Y,
  RIDGE_RADIUS,
  SPOT_CLEAR_RADIUS,
  TERRAIN_GRID,
  TERRAIN_LAYER,
  TERRAIN_SIZE,
} from '../src/world/terrain';

const terrain = createTerrain(7);
const pos = terrain.geometry.getAttribute('position').array as Float32Array;
const ridgePos = terrain.ridge.getAttribute('position').array as Float32Array;

describe('noise', () => {
  it('is deterministic per seed and bounded', () => {
    const a = createValueNoise2D(3);
    const b = createValueNoise2D(3);
    const c = createValueNoise2D(4);
    let differs = false;
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37;
      const y = i * 0.91;
      expect(a(x, y)).toBe(b(x, y));
      expect(Math.abs(a(x, y))).toBeLessThanOrEqual(1);
      expect(Math.abs(fbm2(a, x, y, 4))).toBeLessThanOrEqual(1);
      if (a(x, y) !== c(x, y)) differs = true;
    }
    expect(differs).toBe(true);
  });
});

describe('terrain geometry', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const again = createTerrain(7);
    expect(Array.from(again.geometry.getAttribute('position').array)).toEqual(Array.from(pos));
    expect(Array.from(again.ridge.getAttribute('position').array)).toEqual(Array.from(ridgePos));
    const other = createTerrain(8).geometry.getAttribute('position').array;
    expect(Array.from(other)).not.toEqual(Array.from(pos));
  });

  it('is a 128 x 128 grid over 120 m with position, normal and index attributes', () => {
    const count = TERRAIN_GRID * TERRAIN_GRID;
    expect(terrain.geometry.getAttribute('position').count).toBe(count);
    expect(terrain.geometry.getAttribute('normal').count).toBe(count);
    expect(terrain.geometry.index?.count).toBe((TERRAIN_GRID - 1) ** 2 * 6);
    expect(pos[0]).toBeCloseTo(-TERRAIN_SIZE / 2, 4);
    expect(pos[(count - 1) * 3]).toBeCloseTo(TERRAIN_SIZE / 2, 4);
    expect(pos[(count - 1) * 3 + 2]).toBeCloseTo(TERRAIN_SIZE / 2, 4);
  });

  it('tags both meshes with the terrain layer', () => {
    expect(TERRAIN_LAYER).toBe('terrain');
    expect(terrain.geometry.userData.layer).toBe('terrain');
    expect(terrain.ridge.userData.layer).toBe('terrain');
  });

  it('heightAt matches mesh vertices within 1 cm', () => {
    for (let k = 0; k < TERRAIN_GRID * TERRAIN_GRID; k += 7) {
      const x = pos[k * 3] as number;
      const y = pos[k * 3 + 1] as number;
      const z = pos[k * 3 + 2] as number;
      expect(Math.abs(terrain.heightAt(x, z) - y)).toBeLessThan(0.01);
    }
  });

  it('heightAt matches the mesh triangles at interior points within 1 cm', () => {
    const idx = terrain.geometry.index?.array as Uint32Array;
    const rand = mulberry32(99);
    const at = (q: number, o: number): number => pos[q * 3 + o] as number;
    for (let n = 0; n < 500; n++) {
      const t = Math.floor(rand() * (idx.length / 3)) * 3;
      const [ia, ib, ic] = [idx[t], idx[t + 1], idx[t + 2]] as [number, number, number];
      let u = rand();
      let v = rand();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      const lerp = (o: number): number =>
        at(ia, o) + u * (at(ib, o) - at(ia, o)) + v * (at(ic, o) - at(ia, o));
      expect(Math.abs(terrain.heightAt(lerp(0), lerp(2)) - lerp(1))).toBeLessThan(0.01);
    }
  });

  it('winds triangles upward', () => {
    const idx = terrain.geometry.index?.array as Uint32Array;
    const p = (q: number, o: number): number => pos[q * 3 + o] as number;
    for (let t = 0; t < idx.length; t += 3 * 211) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]] as [number, number, number];
      const e1x = p(b, 0) - p(a, 0);
      const e1z = p(b, 2) - p(a, 2);
      const e2x = p(c, 0) - p(a, 0);
      const e2z = p(c, 2) - p(a, 2);
      // The y component of e1 x e2 is e1z * e2x - e1x * e2z.
      expect(e1z * e2x - e1x * e2z).toBeGreaterThan(0);
    }
  });
});

describe('the painter spot', () => {
  it('pins the ground at the spot to exactly 0', () => {
    expect(PAINTER_SPOT).toEqual([0, 0, 0]);
    expect(EYE_HEIGHT).toBe(1.6);
    expect(terrain.heightAt(0, 0)).toBe(0);
    for (const seed of [1, 2, 3, 12345]) expect(createTerrain(seed).heightAt(0, 0)).toBe(0);
  });

  it('is the local maximum within 8 m, for vertices and samples', () => {
    for (const seed of [1, 7, 42, 999]) {
      const t = createTerrain(seed);
      const p = t.geometry.getAttribute('position').array as Float32Array;
      for (let k = 0; k < TERRAIN_GRID * TERRAIN_GRID; k++) {
        const r = Math.hypot(p[k * 3] as number, p[k * 3 + 2] as number);
        if (r <= SPOT_CLEAR_RADIUS) expect(p[k * 3 + 1]).toBeLessThanOrEqual(0);
      }
      for (let a = 0; a < 360; a += 5) {
        for (let r = 0; r <= SPOT_CLEAR_RADIUS; r += 0.25) {
          const rad = (a * Math.PI) / 180;
          expect(t.heightAt(r * Math.cos(rad), r * Math.sin(rad))).toBeLessThanOrEqual(1e-9);
        }
      }
    }
  });

  it('falls away ahead (-Z) onto a shallow terrace 15-40 m out', () => {
    expect(terrain.heightAt(0, -5)).toBeLessThan(0);
    expect(terrain.heightAt(0, -25)).toBeLessThan(terrain.heightAt(0, -5));
    for (const seed of [1, 7, 42]) {
      const s = createTerrain(seed);
      for (const z of [-15, -25, -35, -40]) {
        expect(s.heightAt(0, z)).toBeLessThan(-4);
        expect(s.heightAt(0, z)).toBeGreaterThan(-7);
      }
    }
  });

  it('keeps the village band in the painter frame below the spot', () => {
    for (const seed of [1, 7, 42, 999]) {
      const s = createTerrain(seed);
      for (let z = -15; z >= -40; z -= 0.5) {
        for (let x = 0.75 * z; x <= -0.75 * z; x += 0.5) {
          const r = Math.hypot(x, z);
          if (r >= 15 && r <= 40) expect(s.heightAt(x, z)).toBeLessThan(-1);
        }
      }
    }
  });

  it('keeps all ground below the 40 m altitude cap', () => {
    for (let k = 0; k < TERRAIN_GRID * TERRAIN_GRID; k++) {
      expect(pos[k * 3 + 1]).toBeLessThan(40);
    }
  });
});

describe('normalAt', () => {
  it('returns unit, upward vectors', () => {
    const rand = mulberry32(5);
    for (let n = 0; n < 300; n++) {
      const [x, y, z] = terrain.normalAt(rand() * 120 - 60, rand() * 120 - 60);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
      expect(y).toBeGreaterThan(0);
    }
  });

  it('is the exact face normal of the triangle heightAt selects', () => {
    const idx = terrain.geometry.index?.array as Uint32Array;
    const rand = mulberry32(6);
    const p = (q: number, o: number): number => pos[q * 3 + o] as number;
    for (let n = 0; n < 300; n++) {
      const t = Math.floor(rand() * (idx.length / 3)) * 3;
      const [ia, ib, ic] = [idx[t], idx[t + 1], idx[t + 2]] as [number, number, number];
      let u = rand();
      let v = rand();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      const lerp = (o: number): number =>
        p(ia, o) + u * (p(ib, o) - p(ia, o)) + v * (p(ic, o) - p(ia, o));
      const e1 = [p(ib, 0) - p(ia, 0), p(ib, 1) - p(ia, 1), p(ib, 2) - p(ia, 2)] as const;
      const e2 = [p(ic, 0) - p(ia, 0), p(ic, 1) - p(ia, 1), p(ic, 2) - p(ia, 2)] as const;
      const cx = e1[1] * e2[2] - e1[2] * e2[1];
      const cy = e1[2] * e2[0] - e1[0] * e2[2];
      const cz = e1[0] * e2[1] - e1[1] * e2[0];
      const len = Math.hypot(cx, cy, cz);
      const nrm = terrain.normalAt(lerp(0), lerp(2));
      expect(Math.abs(nrm[0] - cx / len)).toBeLessThan(1e-5);
      expect(Math.abs(nrm[1] - cy / len)).toBeLessThan(1e-5);
      expect(Math.abs(nrm[2] - cz / len)).toBeLessThan(1e-5);
    }
  });

  it('is vertical on the flat top of the hill', () => {
    const [x, y, z] = terrain.normalAt(0, 0);
    expect(y).toBeGreaterThan(0.999);
    expect(Math.abs(x) + Math.abs(z)).toBeLessThan(0.05);
  });
});

describe('ridge', () => {
  const cols = 29;

  it('hides its foot behind the terrain skyline from the spot and from a raised eye', () => {
    const half = TERRAIN_SIZE / 2;
    for (const seed of [1, 7, 42, 999]) {
      const t = createTerrain(seed);
      const rp = t.ridge.getAttribute('position').array as Float32Array;
      for (const eye of [
        [0, 1.6, 0],
        [0, 20, 10],
      ] as const) {
        for (let j = 0; j < cols; j++) {
          const dx = (rp[j * 3] as number) - eye[0];
          const dz = (rp[j * 3 + 2] as number) - eye[2];
          const dist = Math.hypot(dx, dz);
          const footElev = Math.atan2((rp[j * 3 + 1] as number) - eye[1], dist);
          expect(rp[j * 3 + 1]).toBe(RIDGE_FOOT_Y);
          let skyline = -Infinity;
          for (let s = 0.25; s < dist; s += 0.25) {
            const x = eye[0] + (dx / dist) * s;
            const z = eye[2] + (dz / dist) * s;
            if (Math.abs(x) > half || Math.abs(z) > half) break;
            skyline = Math.max(skyline, Math.atan2(t.heightAt(x, z) - eye[1], s));
          }
          expect(footElev).toBeLessThanOrEqual(skyline);
        }
      }
    }
  });

  it('sits 70-110 m out, ahead of the viewer, below the altitude cap', () => {
    for (let k = 0; k < ridgePos.length / 3; k++) {
      const x = ridgePos[k * 3] as number;
      const z = ridgePos[k * 3 + 2] as number;
      const r = Math.hypot(x, z);
      expect(r).toBeGreaterThanOrEqual(RIDGE_RADIUS.min - 1e-3);
      expect(r).toBeLessThanOrEqual(RIDGE_RADIUS.max + 1e-3);
      expect(z).toBeLessThan(0);
      expect(ridgePos[k * 3 + 1]).toBeLessThan(40);
    }
  });

  it('rises toward the right edge', () => {
    const crest = (j: number): number => ridgePos[(2 * cols + j) * 3 + 1] as number;
    expect(crest(cols - 3)).toBeGreaterThan(crest(2));
    expect(ridgePos[(cols - 1) * 3]).toBeGreaterThan(0);
  });

  it('faces the viewer', () => {
    const nrm = terrain.ridge.getAttribute('normal').array as Float32Array;
    for (let k = 0; k < ridgePos.length / 3; k++) {
      const facing =
        -((ridgePos[k * 3] as number) * (nrm[k * 3] as number)) -
        (ridgePos[k * 3 + 2] as number) * (nrm[k * 3 + 2] as number);
      expect(facing).toBeGreaterThan(0);
    }
  });
});
