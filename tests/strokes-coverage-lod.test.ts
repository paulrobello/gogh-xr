import { readFileSync } from 'node:fs';
import { DataTexture, PerspectiveCamera, RGBAFormat, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { loadRealSource } from '../scripts/scatter-time.ts';
import {
  createWorldGeometry,
  scatterWorld,
  worldSeeds,
} from '../src/paintings/starry-night/world.ts';
import {
  ATLAS_CELL_SIZE,
  ATLAS_GRID,
  ATLAS_SIZE,
  BRUSH_COUNT,
  generateBrushAtlas,
} from '../src/render/strokes/brush-atlas-data.ts';
import { unpackInstance } from '../src/render/strokes/instance.ts';
import { COVERAGE_MAX_LOD, createStrokeMaterial } from '../src/render/strokes/material.ts';
import { boundaryFactor } from '../src/world/boundary.ts';
import { createTerrain } from '../src/world/terrain.ts';
import { CREST_POSES } from './world-poses.ts';

/**
 * Per brush and mip level, how many of the brush's cell texels hold coverage 0.5 or more, under a
 * 2 × 2 box filter of the coverage channel (what `generateMipmap` usually does).
 */
function coverageTexels(): number[][] {
  const data = generateBrushAtlas(1);
  let size = ATLAS_SIZE;
  let cov = new Float64Array(size * size);
  for (let i = 0; i < size * size; i++) cov[i] = data[i * 4] / 255;
  const levels: number[][] = [];
  for (let level = 0; level <= 8; level++) {
    const cell = ATLAS_CELL_SIZE >> level;
    const counts: number[] = [];
    for (let b = 0; b < BRUSH_COUNT; b++) {
      const x0 = (b % ATLAS_GRID) * cell;
      const y0 = Math.floor(b / ATLAS_GRID) * cell;
      let over = 0;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) if (cov[(y0 + y) * size + x0 + x] >= 0.5) over++;
      }
      counts.push(over);
    }
    levels.push(counts);
    const next = size / 2;
    const down = new Float64Array(next * next);
    for (let y = 0; y < next; y++) {
      for (let x = 0; x < next; x++) {
        const i = 2 * y * size + 2 * x;
        down[y * next + x] = (cov[i] + cov[i + 1] + cov[i + size] + cov[i + size + 1]) / 4;
      }
    }
    cov = down;
    size = next;
  }
  return levels;
}

describe('the coverage mip cap', () => {
  test('every brush keeps its painted share at the cap, and none keeps any at mip 8', () => {
    const levels = coverageTexels();
    const cells = (level: number) => (ATLAS_CELL_SIZE >> level) ** 2;
    for (let b = 0; b < BRUSH_COUNT; b++) {
      const base = levels[0][b] / cells(0);
      const capped = levels[COVERAGE_MAX_LOD][b] / cells(COVERAGE_MAX_LOD);
      expect(capped / base, `brush ${b}`).toBeGreaterThan(0.7);
      expect(levels[8][b], `brush ${b}`).toBe(0);
    }
  });

  test('the shader retakes the coverage tap at the cap past it', () => {
    const material = createStrokeMaterial(new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat));
    expect(Number(material.defines.COVERAGE_MAX_LOD)).toBe(COVERAGE_MAX_LOD);
    expect(Number(material.defines.COVERAGE_MAX_RHO2)).toBe(4 ** COVERAGE_MAX_LOD);
    const frag = readFileSync('src/render/strokes/stroke.frag.glsl', 'utf8');
    expect(frag).toContain('textureLod(uAtlas, vUv, COVERAGE_MAX_LOD)');
    material.dispose();
  });
});

describe('the crest poses', () => {
  const terrain = createTerrain(1);

  test('stand 1.6 m above the flank, above the crest top, and look at it', () => {
    expect(CREST_POSES.length).toBeGreaterThanOrEqual(4);
    const crest = new Vector3(0, terrain.heightAt(0, 0), 0);
    for (const { name, position, yaw, pitch } of CREST_POSES) {
      const [x, y, z] = position;
      expect(Math.abs(y - terrain.heightAt(x, z) - 1.6), name).toBeLessThan(0.01);
      expect(boundaryFactor(position), name).toBe(0);
      expect(y, name).toBeGreaterThan(crest.y);
      const forward = new Vector3(
        -Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch),
      );
      const toCrest = crest
        .clone()
        .sub(new Vector3(x, y, z))
        .normalize();
      expect(forward.angleTo(toCrest), name).toBeLessThan((3 * Math.PI) / 180);
    }
  });

  test('without the cap, most crest strokes in view blend at least half of mip 8, where no brush keeps coverage', async () => {
    const source = await loadRealSource();
    const seeds = worldSeeds(1);
    const buffers = scatterWorld(createWorldGeometry(seeds), source, seeds);
    const crest: ReturnType<typeof unpackInstance>[] = [];
    for (let i = 0; i < buffers.count; i++) {
      const s = unpackInstance(buffers, i);
      if (Math.hypot(s.position[0], s.position[2]) < 1.5 && Math.abs(s.position[1]) < 0.1) {
        crest.push(s);
      }
    }
    const height = 720;
    for (const { name, position, yaw, pitch } of CREST_POSES) {
      const camera = new PerspectiveCamera(70, 16 / 9, 0.1, 1000);
      camera.rotation.order = 'YXZ';
      camera.position.set(...position);
      camera.rotation.set(pitch, yaw, 0);
      camera.updateMatrixWorld();
      const f = height / 2 / Math.tan((35 * Math.PI) / 180);
      const project = (p: Vector3): [number, number] => {
        const v = p.clone().applyMatrix4(camera.matrixWorldInverse);
        return [(f * v.x) / -v.z, (f * v.y) / -v.z];
      };
      const lods: number[] = [];
      for (const s of crest) {
        const c = new Vector3(...s.position);
        const n = new Vector3(...s.normal);
        if (n.dot(camera.position.clone().sub(c)) <= 0) continue;
        // The quad's axes as stroke.vert.glsl builds them (surfaceBasis, then the tangent).
        const sign = n.z >= 0 ? 1 : -1;
        const a = -1 / (sign + n.z);
        const b = n.x * n.y * a;
        const b1 = new Vector3(1 + sign * n.x * n.x * a, sign * b, -sign * n.x);
        const b2 = new Vector3(b, sign + n.y * n.y * a, -n.y);
        const long = b1
          .multiplyScalar(Math.cos(s.tangent))
          .add(b2.multiplyScalar(Math.sin(s.tangent)));
        const short = n.clone().cross(long);
        // One mip-0 texel along each axis: a brush rect spans 480 texels over the quad's length.
        const texel = s.size[0] / 480;
        const p = project(c);
        const pl = project(c.clone().addScaledVector(long, texel));
        const ps = project(c.clone().addScaledVector(short, texel));
        const [j00, j10, j01, j11] = [pl[0] - p[0], pl[1] - p[1], ps[0] - p[0], ps[1] - p[1]];
        const det = j00 * j11 - j01 * j10;
        if (Math.abs(det) < 1e-12) continue;
        const rx = Math.hypot(j11 / det, j10 / det);
        const ry = Math.hypot(j01 / det, j00 / det);
        lods.push(Math.log2(Math.max(rx, ry)));
      }
      lods.sort((p, q) => p - q);
      expect(lods.length, name).toBeGreaterThan(1000);
      expect(lods[Math.floor(lods.length / 2)], name).toBeGreaterThan(7.5);
    }
  });
});
