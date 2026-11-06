import {
  DataTexture,
  type InstancedBufferAttribute,
  IntType,
  type Mesh,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
} from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createStrokeBatch, cullOnRender } from '../src/render/strokes/batch.ts';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  type StrokeBuffers,
} from '../src/render/strokes/instance.ts';

function tinyAtlas(): DataTexture {
  return new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
}

/** Strokes in a row along -z at x = 0, one per metre: 4 m cells give one chunk per 4 strokes. */
function row(count: number, zStart = -1): StrokeBuffers {
  const buffers = createStrokeBuffers(count);
  for (let i = 0; i < count; i++) {
    packInstance(buffers, i, {
      position: [0.5, 1.6, zStart - i],
      normal: [0, 0, 1],
      tangent: 0,
      color: [200, 180, 40, 255],
      size: [0.2, 0.1],
      brush: i % 16,
      layer: STROKE_LAYER.sky,
      phase: 0,
    });
  }
  return buffers;
}

function render(batch: ReturnType<typeof createStrokeBatch>, camera: PerspectiveCamera): void {
  camera.updateMatrixWorld();
  batch.update(camera);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createStrokeBatch', () => {
  test('builds one instanced chunk per grid cell sharing the material and atlas', () => {
    const atlas = tinyAtlas();
    const batch = createStrokeBatch(row(16, -0.5), { cellSize: 4, createAtlas: () => atlas });
    expect(batch.chunks).toHaveLength(4);
    expect(batch.group.children).toHaveLength(4);
    expect(batch.atlas).toBe(atlas);
    for (const chunk of batch.chunks) {
      expect(chunk.mesh.material).toBe(batch.material);
      expect(chunk.mesh.frustumCulled).toBe(false);
      expect(chunk.geometry.instanceCount).toBe(chunk.count);
      expect(chunk.drawCount).toBe(chunk.count);
      const meta = chunk.geometry.getAttribute('iMeta') as InstancedBufferAttribute;
      expect(meta.gpuType).toBe(IntType);
      expect(meta.normalized).toBe(false);
      expect(chunk.geometry.getAttribute('iNormal').normalized).toBe(true);
      expect(chunk.geometry.getAttribute('iTangent').normalized).toBe(true);
      expect(chunk.geometry.getAttribute('iColor').normalized).toBe(true);
    }
    expect(batch.chunks.reduce((sum, c) => sum + c.count, 0)).toBe(16);
    expect(batch.material.uniforms.uAtlas.value).toBe(atlas);
    expect(batch.material.alphaToCoverage).toBe(true);
    expect(batch.material.transparent).toBe(false);
    expect(batch.material.depthWrite).toBe(true);
    batch.dispose();
  });

  test('reports the atlas generation time', () => {
    const batch = createStrokeBatch(row(2), { createAtlas: tinyAtlas });
    expect(batch.stats().atlasMs).toBeGreaterThanOrEqual(0);
    batch.dispose();
  });

  test('setDrawCount clamps to the chunk and drives instanceCount', () => {
    const batch = createStrokeBatch(row(4), { cellSize: 100, createAtlas: tinyAtlas });
    const [chunk] = batch.chunks;
    chunk.setDrawCount(2);
    expect(chunk.geometry.instanceCount).toBe(2);
    chunk.setDrawCount(99);
    expect(chunk.drawCount).toBe(4);
    chunk.setDrawCount(-3);
    expect(chunk.drawCount).toBe(0);
    batch.dispose();
  });
});

describe('update', () => {
  test('culls chunks behind the camera and orders the rest front to back', () => {
    // Strokes from z = +7 to z = -8: four chunks, two behind a camera at the origin looking -z.
    const batch = createStrokeBatch(row(16, 7.5), { cellSize: 4, createAtlas: tinyAtlas });
    const camera = new PerspectiveCamera(70, 1, 0.05, 100);
    camera.position.set(0, 1.6, 0);
    render(batch, camera);

    const visible = batch.chunks.filter((c) => c.mesh.visible);
    const hidden = batch.chunks.filter((c) => !c.mesh.visible);
    expect(visible.length).toBeGreaterThan(0);
    expect(hidden.length).toBeGreaterThan(0);
    for (const chunk of hidden) expect(chunk.bounds.center.z).toBeGreaterThan(0);
    const byOrder = [...visible].sort((a, b) => a.mesh.renderOrder - b.mesh.renderOrder);
    const distances = byOrder.map((c) => c.bounds.center.distanceTo(camera.position));
    expect(distances).toEqual([...distances].sort((a, b) => a - b));

    const stats = batch.stats();
    expect(stats.chunks).toBe(4);
    expect(stats.total).toBe(16);
    expect(stats.visibleChunks).toBe(visible.length);
    expect(stats.visible).toBe(visible.reduce((sum, c) => sum + c.drawCount, 0));

    visible[0].setDrawCount(1);
    expect(batch.stats().visible).toBe(stats.visible - visible[0].count + 1);

    camera.rotation.set(0, Math.PI, 0);
    render(batch, camera);
    for (const chunk of hidden) expect(chunk.mesh.visible).toBe(true);
    batch.dispose();
  });

  test('cullOnRender culls with the camera three passes to scene.onBeforeRender', () => {
    const batch = createStrokeBatch(row(16, 7.5), { cellSize: 4, createAtlas: tinyAtlas });
    const scene = new Scene();
    const previous = vi.fn();
    scene.onBeforeRender = previous;
    const uninstall = cullOnRender(scene, batch);
    const camera = new PerspectiveCamera(70, 1, 0.05, 100);
    camera.position.set(0, 1.6, 20);
    camera.rotation.set(0, Math.PI, 0);
    camera.updateMatrixWorld();
    // Looking +z from z = 20: every chunk is behind.
    // three passes (renderer, scene, camera, renderTarget); the rest are unused here.
    const args = [{}, scene, camera, null] as unknown as Parameters<Scene['onBeforeRender']>;
    scene.onBeforeRender(...args);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(batch.stats().visibleChunks).toBe(0);
    expect(batch.stats().visible).toBe(0);
    uninstall();
    expect(scene.onBeforeRender).toBe(previous);
    batch.dispose();
  });
});

describe('dispose', () => {
  test('releases every chunk geometry, the material and the atlas', () => {
    const atlas = tinyAtlas();
    const batch = createStrokeBatch(row(16, -0.5), { cellSize: 4, createAtlas: () => atlas });
    const scene = new Scene();
    scene.add(batch.group);
    const geometrySpies = batch.chunks.map((c) => vi.spyOn(c.geometry, 'dispose'));
    const materialSpy = vi.spyOn(batch.material, 'dispose');
    const atlasSpy = vi.spyOn(atlas, 'dispose');
    const meshes: Mesh[] = batch.chunks.map((c) => c.mesh);

    batch.dispose();

    for (const spy of geometrySpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(materialSpy).toHaveBeenCalledTimes(1);
    expect(atlasSpy).toHaveBeenCalledTimes(1);
    expect(batch.group.parent).toBeNull();
    for (const mesh of meshes) expect(mesh.parent).toBeNull();
    expect(batch.chunks).toHaveLength(0);
    expect(batch.stats()).toMatchObject({ chunks: 0, visibleChunks: 0, total: 0, visible: 0 });
  });
});
