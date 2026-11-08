import {
  ArrayCamera,
  InstancedBufferAttribute as Attribute,
  DataTexture,
  InstancedBufferGeometry,
  type Object3D,
  PerspectiveCamera,
  RGBAFormat,
} from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { skyOmega, skyWaveFade, skyWaveProductPhase } from '../src/motion/sky-swirl.ts';
import { PAINTER_EYE } from '../src/paintings/starry-night/canvas-camera.ts';
import { bandDrawCount, STROKE_BANDS } from '../src/render/strokes/bands.ts';
import { createStrokeBatch } from '../src/render/strokes/batch.ts';
import { FIT_SCALE_SHIFT, FIT_SCALE_STEP } from '../src/render/strokes/face-clamp.ts';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  unpackInstance,
} from '../src/render/strokes/instance.ts';
import { createStrokeMaterial, type StrokeMaterial } from '../src/render/strokes/material.ts';
import strokeVertexShader from '../src/render/strokes/stroke.vert.glsl?raw';
import {
  createVertexArms,
  skyStatic,
  VERTICES_PER_INSTANCE,
  VTX_FEWER_KEEP,
  VTX_HOIST_DEFINE,
  VTX_SMALLER_SCALE,
  VTX_SPARSE_SCALE,
  type VtxBatch,
  vertexArms,
} from '../src/render/strokes/vertex-arms.ts';
import { mulberry32 } from '../src/util/prng.ts';

function tinyAtlas(): DataTexture {
  return new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
}

const fakeMaterial = (): StrokeMaterial =>
  ({ defines: {}, needsUpdate: false }) as unknown as StrokeMaterial;

function fakeBatch(over: Partial<VtxBatch> = {}): VtxBatch {
  return {
    reapplyDensity: vi.fn(),
    visibleCount: () => 100,
    views: () => 1,
    drawnFootprint: () => ({ areaM2: 2, sr: 0.5, srViews: [0.5] }),
    setDensity: vi.fn(),
    setSizeMultiplier: vi.fn(),
    materials: { near: fakeMaterial(), mid: fakeMaterial(), far: fakeMaterial() },
    geometries: () => [],
    ...over,
  };
}

afterEach(() => {
  vertexArms.set('base');
});

describe('createVertexArms', () => {
  test('starts at base: size 1, keep 1, sparse scale 1, and inactive', () => {
    const arms = createVertexArms();
    expect(arms.arm()).toBe('base');
    expect(arms.uniforms.uVtxSize.value).toBe(1);
    expect(arms.keep()).toBe(1);
    expect(arms.active()).toBe(false);
    expect(VTX_FEWER_KEEP).toBeCloseTo(0.7, 12);
    expect(VTX_SMALLER_SCALE ** 2).toBeCloseTo(0.7, 12);
    expect(VTX_SPARSE_SCALE ** 2 * VTX_FEWER_KEEP).toBeCloseTo(1, 12);
    expect(arms.sizeScale()).toBe(1);
  });

  test('each arm sets its own lever: the size uniform, the keep share or the hoist define', () => {
    const arms = createVertexArms();
    const batch = fakeBatch();
    arms.register(batch);
    arms.activate();
    arms.prepare(batch, vi.fn());
    const hoisted = () => STROKE_BANDS.map((b) => VTX_HOIST_DEFINE in batch.materials[b].defines);
    arms.set('smaller');
    expect(arms.uniforms.uVtxSize.value).toBe(VTX_SMALLER_SCALE);
    expect(batch.reapplyDensity).not.toHaveBeenCalled();
    arms.set('fewer');
    expect(arms.uniforms.uVtxSize.value).toBe(1);
    expect(arms.keep()).toBe(VTX_FEWER_KEEP);
    expect(batch.reapplyDensity).toHaveBeenCalledTimes(1);
    arms.set('sparse');
    expect([arms.keep(), arms.sizeScale()]).toEqual([VTX_FEWER_KEEP, VTX_SPARSE_SCALE]);
    expect(batch.reapplyDensity).toHaveBeenCalledTimes(2);
    expect(hoisted()).toEqual([false, false, false]);
    arms.set('hoist');
    expect(hoisted()).toEqual([true, true, true]);
    expect(batch.materials.near.needsUpdate).toBe(true);
    expect([arms.keep(), arms.sizeScale(), arms.uniforms.uVtxSize.value]).toEqual([1, 1, 1]);
    expect(batch.reapplyDensity).toHaveBeenCalledTimes(3);
    // A batch that registers under hoist keeps its base program until it has prepared.
    const late = fakeBatch();
    arms.register(late);
    expect(VTX_HOIST_DEFINE in late.materials.far.defines).toBe(false);
    arms.set('hoist');
    expect(VTX_HOIST_DEFINE in late.materials.far.defines).toBe(false);
    arms.prepare(late, vi.fn());
    expect(VTX_HOIST_DEFINE in late.materials.far.defines).toBe(true);
    arms.set('base');
    expect(hoisted()).toEqual([false, false, false]);
    arms.unregister(batch);
    arms.set('fewer');
    expect(batch.reapplyDensity).toHaveBeenCalledTimes(3);
  });

  test('prepare runs once per batch while active: sky attributes, then both programs compiled', () => {
    const arms = createVertexArms();
    const buffers = createStrokeBuffers(2);
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('iPosition', new Attribute(buffers.position, 3));
    geometry.setAttribute('iNormal', new Attribute(buffers.normal, 2));
    geometry.setAttribute('iMeta', new Attribute(buffers.meta, 4));
    const batch = fakeBatch({ geometries: () => [geometry] });
    arms.register(batch);
    expect(arms.needsPrepare(batch)).toBe(false);
    arms.activate();
    expect(arms.needsPrepare(batch)).toBe(true);
    const states: boolean[][] = [];
    const compile = vi.fn((object: Object3D) => {
      expect(object.children).toHaveLength(3);
      states.push(STROKE_BANDS.map((b) => VTX_HOIST_DEFINE in batch.materials[b].defines));
    });
    arms.prepare(batch, compile);
    expect(states).toEqual([
      [true, true, true],
      [false, false, false],
    ]);
    expect(geometry.getAttribute('iSkyField').itemSize).toBe(4);
    expect(geometry.getAttribute('iSkyWave').itemSize).toBe(2);
    expect(arms.needsPrepare(batch)).toBe(false);
    arms.prepare(batch, compile);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(arms.diag()).toMatchObject({ prepared: true, program: 'base' });
    arms.set('hoist');
    expect(arms.diag().program).toBe('hoist');
  });

  test('diag sums the batches: invocations are instances × 4 × views, footprints add', () => {
    const arms = createVertexArms();
    arms.register(
      fakeBatch({
        visibleCount: () => 100,
        views: () => 2,
        drawnFootprint: () => ({ areaM2: 3, sr: 0.5, srViews: [0.2, 0.3] }),
      }),
    );
    arms.register(
      fakeBatch({
        visibleCount: () => 50,
        drawnFootprint: () => ({ areaM2: 1, sr: 1, srViews: [1] }),
      }),
    );
    expect(arms.diag()).toEqual({
      arm: 'base',
      keep: 1,
      scale: 1,
      prepared: false,
      program: 'base',
      verticesPerInstance: VERTICES_PER_INSTANCE,
      views: 2,
      instances: 150,
      vertexInvocations: 150 * 4 * 2,
      drawnAreaM2: 4,
      drawnSr: 1.5,
      drawnSrViews: [1.2, 0.3],
    });
    arms.set('smaller');
    expect(arms.diag().scale).toBe(VTX_SMALLER_SCALE);
  });

  test('the footprint is reused within 1 s, but a view change (entering XR) walks it again', () => {
    const arms = createVertexArms();
    let views = 1;
    const walk = vi.fn(() =>
      views === 1
        ? { areaM2: 1, sr: 1, srViews: [1] }
        : { areaM2: 1, sr: 1.8, srViews: [0.9, 0.9] },
    );
    arms.register(fakeBatch({ views: () => views, drawnFootprint: walk }));
    expect(arms.diag().drawnSrViews).toEqual([1]);
    expect(arms.diag().drawnSrViews).toEqual([1]);
    expect(walk).toHaveBeenCalledTimes(1);
    views = 2;
    expect(arms.diag()).toMatchObject({ views: 2, drawnSr: 1.8, drawnSrViews: [0.9, 0.9] });
    expect(walk).toHaveBeenCalledTimes(2);
  });

  test('setBands sets every band density and size multiplier on every batch', () => {
    const arms = createVertexArms();
    const batch = fakeBatch();
    arms.register(batch);
    const density = { near: 0.5, mid: 0.4, far: 0.3 };
    const size = { near: 1.2, mid: 1.3, far: 1.4 };
    arms.setBands({ density, size });
    for (const band of STROKE_BANDS) {
      expect(batch.setDensity).toHaveBeenCalledWith(band, density[band]);
      expect(batch.setSizeMultiplier).toHaveBeenCalledWith(band, size[band]);
    }
  });
});

describe('skyStatic', () => {
  test('is the swirl field motion.glsl computes at rest, and zero off the sky', () => {
    const rand = mulberry32(9);
    const buffers = createStrokeBuffers(40);
    for (let i = 0; i < buffers.count; i++) {
      const theta = rand() * Math.PI * 2;
      const up = 0.1 + rand() * 1.2;
      packInstance(buffers, i, {
        position: [
          PAINTER_EYE[0] + 40 * Math.cos(up) * Math.sin(theta),
          PAINTER_EYE[1] + 40 * Math.sin(up),
          PAINTER_EYE[2] - 40 * Math.cos(up) * Math.cos(theta),
        ],
        normal: [rand() - 0.5, rand() - 0.5, 1],
        tangent: 0,
        color: [200, 180, 40, 255],
        size: [1, 0.5],
        brush: 0,
        layer: i % 4 === 0 ? STROKE_LAYER.ground : STROKE_LAYER.sky,
        phase: 0,
      });
    }
    const { field, wave } = skyStatic(
      buffers.position,
      buffers.normal,
      buffers.meta,
      buffers.count,
      3,
    );
    for (let i = 0; i < buffers.count; i++) {
      const got = [...field.slice(i * 4, i * 4 + 4), ...wave.slice(i * 2, i * 2 + 2)];
      if (i % 4 === 0) {
        expect(got).toEqual([0, 0, 0, 0, 0, 0]);
        continue;
      }
      const s = unpackInstance(buffers, i);
      const d = s.position.map((v, k) => v - PAINTER_EYE[k]) as [number, number, number];
      const len = Math.hypot(...d);
      const dir = d.map((v) => v / len) as [number, number, number];
      const w = skyOmega(dir);
      const phase = skyWaveProductPhase(dir, 3);
      const want = [
        w[1] * d[2] - w[2] * d[1],
        w[2] * d[0] - w[0] * d[2],
        w[0] * d[1] - w[1] * d[0],
        w[0] * s.normal[0] + w[1] * s.normal[1] + w[2] * s.normal[2],
        phase - Math.floor(phase),
        skyWaveFade(dir),
      ];
      got.forEach((v, k) => {
        expect(v).toBeCloseTo(want[k], 5);
      });
    }
  });
});

/** 200 strokes in one 4 m cell, 2 m ahead of the origin: one near-band chunk. */
function nearCluster(): ReturnType<typeof createStrokeBuffers> {
  const rand = mulberry32(3);
  const buffers = createStrokeBuffers(200);
  for (let i = 0; i < buffers.count; i++) {
    packInstance(buffers, i, {
      position: [0.5 + rand() * 0.8, 0.5 + rand() * 0.8, -2 - rand() * 0.8],
      normal: [0, 0, 1],
      tangent: 0,
      color: [200, 180, 40, 255],
      size: [0.1 + rand() * 0.1, 0.05],
      brush: i % 16,
      layer: STROKE_LAYER.ground,
      phase: 0,
    });
  }
  return buffers;
}

function originCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(90, 1, 0.05, 1000);
  camera.updateMatrixWorld();
  return camera;
}

describe('stroke materials', () => {
  test('the band materials share the size uniform; a lone material keeps a private 1', () => {
    const batch = createStrokeBatch(nearCluster(), { createAtlas: tinyAtlas });
    for (const band of STROKE_BANDS) {
      expect(batch.materials[band].uniforms.uVtxSize).toBe(vertexArms.uniforms.uVtxSize);
      expect(VTX_HOIST_DEFINE in batch.materials[band].defines).toBe(false);
    }
    const lone = createStrokeMaterial(tinyAtlas());
    expect(lone.uniforms.uVtxSize).not.toBe(vertexArms.uniforms.uVtxSize);
    vertexArms.set('smaller');
    expect(lone.uniforms.uVtxSize.value).toBe(1);
    expect(batch.materials.near.uniforms.uVtxSize.value).toBe(VTX_SMALLER_SCALE);
    lone.dispose();
    batch.dispose();
  });

  test('the default program carries no arm code but the exact multiply by uVtxSize', () => {
    const body = strokeVertexShader.replace(/#ifdef VTX_HOIST[\s\S]*?#(else|endif)/g, '');
    expect(body).not.toMatch(/uVtxArm|uTieKey|lowbias32|VTX_ARM/);
    expect(body).toContain('vec2 size = iSize * sizeScale * uVtxSize;');
    expect(body).toContain('uint h8 = uint(iTie);');
  });
});

describe('the batch under the vtx arms', () => {
  test('fewer draws the keep share of the unpinned strokes, without growing them', () => {
    const batch = createStrokeBatch(nearCluster(), { cellSize: 4, createAtlas: tinyAtlas });
    batch.update(originCamera());
    const [chunk] = batch.chunks;
    expect(chunk.band).toBe('near');
    batch.setDensity('near', 0.8);
    const unpinned = chunk.count - chunk.pinned;
    expect(chunk.drawCount).toBe(chunk.pinned + bandDrawCount(0.8, unpinned));
    const sizeBefore = batch.materials.near.uniforms.uSizeScale.value;
    vertexArms.set('fewer');
    expect(chunk.drawCount).toBe(chunk.pinned + bandDrawCount(0.8 * VTX_FEWER_KEEP, unpinned));
    expect(batch.materials.near.uniforms.uSizeScale.value).toBe(sizeBefore);
    batch.setDensity('near', 1);
    expect(chunk.drawCount).toBe(chunk.pinned + bandDrawCount(VTX_FEWER_KEEP, unpinned));
    vertexArms.set('smaller');
    expect(chunk.drawCount).toBe(chunk.pinned + bandDrawCount(1, unpinned));
    vertexArms.set('base');
    expect(chunk.drawCount).toBe(chunk.count);
    batch.dispose();
  });

  test('sparse draws fewer’s strokes grown through the band size, so the drawn area holds', () => {
    const batch = createStrokeBatch(nearCluster(), { cellSize: 4, createAtlas: tinyAtlas });
    batch.update(originCamera());
    const [chunk] = batch.chunks;
    batch.setSizeMultiplier('near', 1.25);
    const area = batch.drawnFootprint().areaM2;
    vertexArms.set('sparse');
    const unpinned = chunk.count - chunk.pinned;
    expect(chunk.drawCount).toBe(chunk.pinned + bandDrawCount(VTX_FEWER_KEEP, unpinned));
    expect(batch.materials.near.uniforms.uSizeScale.value).toBeCloseTo(1.25 * VTX_SPARSE_SCALE, 12);
    expect(batch.sizeMultiplier('near')).toBe(1.25);
    // The strokes are in random order, so the kept prefix's mean area is near, not at, the whole's.
    expect(batch.drawnFootprint().areaM2 / area).toBeCloseTo(1, 1);
    // A size change under sparse keeps the factor; leaving it restores the plain band size.
    batch.setSizeMultiplier('near', 1.5);
    expect(batch.materials.near.uniforms.uSizeScale.value).toBeCloseTo(1.5 * VTX_SPARSE_SCALE, 12);
    vertexArms.set('base');
    expect(batch.materials.near.uniforms.uSizeScale.value).toBe(1.5);
    expect(chunk.drawCount).toBe(chunk.count);
    batch.dispose();
  });

  test('the footprint caps each stroke at its fit level, and scales by uVtxSize²', () => {
    const buffers = createStrokeBuffers(2);
    for (const [i, level] of [
      [0, 0],
      [1, 2],
    ] as const) {
      packInstance(buffers, i, {
        position: [0, 0, -2],
        normal: [0, 0, 1],
        tangent: 0,
        color: [200, 180, 40, 255],
        size: [0.2, 0.1],
        brush: 0,
        layer: STROKE_LAYER.ground,
        phase: 0,
        flags: level << FIT_SCALE_SHIFT,
      });
    }
    const batch = createStrokeBatch(buffers, { cellSize: 100, createAtlas: tinyAtlas });
    batch.update(originCamera());
    batch.setSizeMultiplier('near', 2);
    const cap = 1 + FIT_SCALE_STEP;
    expect(cap).toBeLessThan(2);
    const area = 0.2 * 0.1 * (2 * 2 + cap * cap);
    expect(batch.drawnFootprint().areaM2).toBeCloseTo(area, 6);
    expect(batch.drawnFootprint().sr).toBeCloseTo(area / 4, 6);
    vertexArms.set('smaller');
    expect(batch.drawnFootprint().areaM2).toBeCloseTo(area * 0.7, 6);
    batch.dispose();
  });

  test('the solid angle counts only strokes inside the frustum, and each XR view once', () => {
    const buffers = createStrokeBuffers(3);
    const at = (i: number, position: [number, number, number]) =>
      packInstance(buffers, i, {
        position,
        normal: [0, 0, 1],
        tangent: 0,
        color: [200, 180, 40, 255],
        size: [0.2, 0.1],
        brush: 0,
        layer: STROKE_LAYER.ground,
        phase: 0,
      });
    // Ahead at 2 m, ahead and off to the side outside the 90° frustum, and behind the eye.
    at(0, [0, 0, -2]);
    at(1, [3, 0, -1]);
    at(2, [0, 0, 1]);
    vertexArms.activate();
    const batch = createStrokeBatch(buffers, { cellSize: 100, createAtlas: tinyAtlas });
    batch.update(originCamera());
    batch.setSizeMultiplier('near', 1);
    expect(batch.views()).toBe(1);
    expect(batch.drawnFootprint().sr).toBeCloseTo((0.2 * 0.1) / 4, 7);
    const left = originCamera();
    const right = originCamera();
    const xr = new ArrayCamera([left, right]);
    xr.projectionMatrix.copy(left.projectionMatrix);
    xr.updateMatrixWorld();
    batch.update(xr);
    expect(batch.views()).toBe(2);
    expect(batch.drawnFootprint().sr).toBeCloseTo((2 * (0.2 * 0.1)) / 4, 7);
    for (const view of batch.drawnFootprint().srViews) expect(view).toBeCloseTo((0.2 * 0.1) / 4, 7);
    batch.dispose();
  });

  test('a disposed batch leaves the arms', () => {
    const batch = createStrokeBatch(nearCluster(), { cellSize: 4, createAtlas: tinyAtlas });
    batch.update(originCamera());
    const before = vertexArms.diag().instances;
    batch.dispose();
    expect(vertexArms.diag().instances).toBe(before - 200);
  });
});
