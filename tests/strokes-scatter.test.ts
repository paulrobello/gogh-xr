import {
  BufferAttribute,
  BufferGeometry,
  PlaneGeometry,
  SphereGeometry,
  Triangle,
  Vector3,
} from 'three';
import { expect, test } from 'vitest';
import { type FlowField, type Raster, REGION, type RegionId } from '../src/demo/canvas/field.ts';
import { REGION_STYLES, strokeShade } from '../src/demo/canvas/placement.ts';
import {
  CANVAS_ASPECT,
  LAYER_REGION,
  PAINTER_EYE,
  projectToCanvas,
  type WorldLayer,
} from '../src/paintings/starry-night/canvas-camera.ts';
import {
  buildCanvasHistogram,
  type CanvasSource,
} from '../src/paintings/starry-night/canvas-histogram.ts';
import { DEPTH_BACKDROP_FLAG } from '../src/render/strokes/backdrop-depth.ts';
import { BRUSHES } from '../src/render/strokes/brush-atlas-data.ts';
import {
  DEPTH_RANKED_FLAG,
  DEPTH_TIE_BREAK_FRONT_FLAG,
  lowbias32,
  sizeShare,
} from '../src/render/strokes/depth-tie-break.ts';
import { BRUSH_FOOTPRINT } from '../src/render/strokes/face-clamp.ts';
import { strokeAxes, type Vec3 } from '../src/render/strokes/frame.ts';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  type StrokeBuffers,
  unpackInstance,
} from '../src/render/strokes/instance.ts';
import {
  FACE_CLAMPED_LAYERS,
  type GradedSize,
  LAYER_DENSITY,
  LAYER_SIZE,
  OUTLINE_DARKEN,
  SCATTER_DEPTH_JITTER,
  SCATTER_SIZE_JITTER,
  scatterDensityAt,
  scatterOverrides,
  scatterSurfaces,
  strokeSizeAt,
  surfaceArea,
  WORLD_LAYERS,
} from '../src/render/strokes/scatter.ts';
import { hashStrokeBuffers } from '../src/render/strokes/scatter-cache.ts';
import vertexShader from '../src/render/strokes/stroke.vert.glsl?raw';
import { tieKeys } from '../src/render/strokes/tie-key.ts';
import { createCypress } from '../src/world/cypress.ts';
import { createSkyDome } from '../src/world/sky.ts';
import { createTerrain } from '../src/world/terrain.ts';
import { createVillage, WINDOW_COLOR } from '../src/world/village.ts';

type Rgb = readonly [number, number, number];

/** A size that does not grade with distance, so the layer density is uniform. */
const flatSize = (length: number): GradedSize => ({ near: length, far: length, slope: 0 });
/** Flat sizes for `layers`, for tests that need a uniform density. */
const flat = (length: number, ...layers: WorldLayer[]): Record<string, GradedSize> =>
  Object.fromEntries(layers.map((l) => [l, flatSize(length)]));
const eyeDistance = (p: Vec3): number =>
  Math.hypot(p[0] - PAINTER_EYE[0], p[1] - PAINTER_EYE[1], p[2] - PAINTER_EYE[2]);

function raster(width: number, height: number, fill: (x: number, y: number) => Rgb): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set([...fill(x, y), 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

function constantFlow(angle: number): FlowField {
  return {
    width: 4,
    height: 4,
    angle: new Float32Array(16).fill(angle),
    coherence: new Float32Array(16).fill(1),
  };
}

function source(regions: Raster, flowAngle: number): CanvasSource {
  const image = raster(10, 8, (x) => [40 + x * 20, 90, 200 - x * 10]);
  const flow = constantFlow(flowAngle);
  return { image, regions, flow, histogram: buildCanvasHistogram(image, regions, flow) };
}

/** One region everywhere: every in-frame point reads the canvas for layers mapped to it. */
const single = (region: RegionId, angle: number): CanvasSource =>
  source(
    raster(4, 4, () => [region, 0, 0]),
    angle,
  );

/** Every mapped region in its own column, so extrapolation works for every layer. */
const MIXED = source(
  raster(5, 4, (x) => [
    [REGION.sky, REGION.hills, REGION.cypress, REGION.village, REGION.church][x] as number,
    0,
    0,
  ]),
  0.4,
);

function tagged(geometry: BufferGeometry, layer: WorldLayer): BufferGeometry {
  geometry.userData.layer = layer;
  return geometry;
}

/** Horizontal plane facing +Y, centred at (cx, y, cz). Indexed. */
function ground(
  size: number,
  cx: number,
  y: number,
  cz: number,
  layer: WorldLayer,
): BufferGeometry {
  const g = new PlaneGeometry(size, size, 8, 8);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, y, cz);
  return tagged(g, layer);
}

/** Upright plane facing +Z (towards the eye when in front of it). Indexed. */
function wall(width: number, height: number, centre: Vec3, layer: WorldLayer): BufferGeometry {
  const g = new PlaneGeometry(width, height, 4, 4);
  g.translate(centre[0], centre[1], centre[2]);
  return tagged(g, layer);
}

function triangleArea(g: BufferGeometry): number {
  const p = g.getAttribute('position');
  const index = g.getIndex();
  const n = index ? index.count : p.count;
  const tri = new Triangle();
  let total = 0;
  for (let t = 0; t < n; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => {
      const i = index ? index.getX(t + k) : t + k;
      return new Vector3().fromBufferAttribute(p, i);
    });
    total += tri.set(a, b, c).getArea();
  }
  return total;
}

function countByStrokeLayer(buffers: StrokeBuffers): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < buffers.count; i++) {
    const layer = buffers.meta[i * 4 + 1];
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
  }
  return counts;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Painting-space angle (aspect-corrected uv) of a small step from `p` along `dir`, mod π. */
function imageAngle(p: Vec3, dir: Vec3): number {
  const e = 1e-3;
  const a = projectToCanvas(p).uv;
  const b = projectToCanvas([p[0] + dir[0] * e, p[1] + dir[1] * e, p[2] + dir[2] * e]).uv;
  if (!a || !b) throw new Error('step left the frustum');
  const theta = Math.atan2(b[1] - a[1], (b[0] - a[0]) * CANVAS_ASPECT);
  return ((theta % Math.PI) + Math.PI) % Math.PI;
}

/** Smallest difference of two orientations mod π. */
function orientationGap(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

test('density tables are frozen and cover every world layer', () => {
  expect(Object.isFrozen(LAYER_DENSITY)).toBe(true);
  expect(Object.isFrozen(LAYER_SIZE)).toBe(true);
  for (const layer of WORLD_LAYERS) {
    expect(LAYER_DENSITY[layer]).toBeGreaterThanOrEqual(0);
    const size = LAYER_SIZE[layer];
    expect(Object.isFrozen(size)).toBe(true);
    expect(size.near).toBeGreaterThan(0);
    expect(size.far).toBeGreaterThanOrEqual(size.near);
    expect(size.slope).toBeGreaterThanOrEqual(0);
  }
  expect(new Set(WORLD_LAYERS)).toEqual(new Set(Object.keys(LAYER_REGION)));
  // The sky dome at 120 m needs large sparse strokes, the cypress at 10 m small dense ones.
  const sky = strokeSizeAt(LAYER_SIZE.sky, 119.5);
  const cypress = strokeSizeAt(LAYER_SIZE.cypress, 10);
  expect(sky).toBeGreaterThan(cypress * 5);
  expect(scatterDensityAt(LAYER_DENSITY.cypress, LAYER_SIZE.cypress, 10)).toBeGreaterThan(
    scatterDensityAt(LAYER_DENSITY.sky, LAYER_SIZE.sky, 119.5) * 50,
  );
});

test('graded size grows with distance inside its clamps, and density falls as 1 / size²', () => {
  const s: GradedSize = { near: 0.1, far: 2, slope: 0.02 };
  expect(strokeSizeAt(s, 1)).toBe(0.1);
  expect(strokeSizeAt(s, 50)).toBeCloseTo(1, 12);
  expect(strokeSizeAt(s, 500)).toBe(2);
  expect(scatterDensityAt(400, s, 1)).toBe(400);
  expect(scatterDensityAt(400, s, 50)).toBeCloseTo(4, 9);
  expect(scatterDensityAt(400, s, 500)).toBeCloseTo(1, 9);
});

test('surfaceArea sums triangle areas for indexed and non-indexed geometry', () => {
  const plane = ground(10, 0, 0, -20, 'terrain');
  expect(surfaceArea(plane)).toBeCloseTo(100, 6);
  const sphere = new SphereGeometry(3, 16, 12).toNonIndexed();
  expect(surfaceArea(sphere)).toBeCloseTo(triangleArea(sphere), 6);
});

test('stroke count per m² is within 5% of the target, per layer', () => {
  const plane = ground(20, 0, 0, -20, 'terrain');
  const sphere = tagged(new SphereGeometry(5, 24, 16).toNonIndexed(), 'cypress');
  sphere.translate(-6, 6, -15);
  const sky = wall(40, 30, [0, 30, -100], 'sky');
  const density = { terrain: 40, cypress: 30, sky: 6 };
  const buffers = scatterSurfaces([plane, sphere, sky], MIXED, {
    seed: 3,
    density,
    size: flat(0.2, 'terrain', 'cypress', 'sky'),
  });
  const counts = countByStrokeLayer(buffers);
  const cases: [BufferGeometry, number, number][] = [
    [plane, density.terrain, STROKE_LAYER.ground],
    [sphere, density.cypress, STROKE_LAYER.cypress],
    [sky, density.sky, STROKE_LAYER.sky],
  ];
  for (const [geometry, d, strokeLayer] of cases) {
    const expected = triangleArea(geometry) * d;
    expect(expected).toBeGreaterThan(4000);
    const got = counts.get(strokeLayer) ?? 0;
    expect(Math.abs(got / expected - 1)).toBeLessThanOrEqual(0.05);
  }
  expect(buffers.count).toBe([...counts.values()].reduce((a, b) => a + b, 0));
});

test('strokes lie on their surface with the surface normal', () => {
  const plane = ground(10, 2, -1, -20, 'terrain');
  const buffers = scatterSurfaces([plane], MIXED, {
    seed: 5,
    density: { terrain: 30 },
    size: flat(0.3, 'terrain'),
  });
  expect(buffers.count).toBeGreaterThan(2500);
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    expect(s.position[0]).toBeGreaterThanOrEqual(-3 - 1e-4);
    expect(s.position[0]).toBeLessThanOrEqual(7 + 1e-4);
    expect(s.position[2]).toBeGreaterThanOrEqual(-25 - 1e-4);
    expect(s.position[2]).toBeLessThanOrEqual(-15 + 1e-4);
    // Lifted along the normal by at most a small fraction of the stroke length.
    expect(s.position[1] + 1).toBeGreaterThanOrEqual(0);
    expect(s.position[1] + 1).toBeLessThanOrEqual(0.05 * s.size[0]);
    expect(dot(s.normal, [0, 1, 0])).toBeGreaterThan(0.9999);
  }
});

test('tangents lie in the source surface plane', () => {
  const plane = ground(12, 0, 0, -18, 'terrain');
  const tilted = wall(8, 6, [3, 4, -12], 'building');
  tilted.rotateY(0.7);
  tilted.rotateX(-0.4);
  const sphere = tagged(new SphereGeometry(4, 20, 14), 'cypress');
  const centre: Vec3 = [-5, 5, -10];
  sphere.translate(...centre);
  const buffers = scatterSurfaces([plane, tilted, sphere], MIXED, {
    seed: 7,
    density: { terrain: 20, building: 40, cypress: 20 },
    size: flat(0.2, 'terrain', 'building', 'cypress'),
  });
  const tiltedNormal = new Vector3(0, 0, 1)
    .applyAxisAngle(new Vector3(0, 1, 0), 0.7)
    .applyAxisAngle(new Vector3(1, 0, 0), -0.4)
    .toArray() as Vec3;
  let checked = 0;
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    const { long } = strokeAxes(s.normal, s.tangent);
    let truth: Vec3;
    if (s.layer === STROKE_LAYER.ground) truth = [0, 1, 0];
    else if (s.layer === STROKE_LAYER.building) truth = tiltedNormal;
    else {
      const r = s.position.map((v, k) => v - centre[k]) as unknown as Vec3;
      const len = Math.hypot(...r);
      truth = [r[0] / len, r[1] / len, r[2] / len];
    }
    expect(Math.hypot(...long)).toBeCloseTo(1, 6);
    expect(Math.abs(dot(long, truth))).toBeLessThan(2e-3);
    checked++;
  }
  expect(checked).toBeGreaterThan(3000);
});

test('in frame, a diagonal flow on the ground keeps its painted angle (perspective-correct)', () => {
  const theta = Math.PI / 4;
  const src = single(REGION.hills, theta);
  const plane = ground(8, 0, 0, -14, 'terrain');
  const buffers = scatterSurfaces([plane], src, {
    seed: 11,
    density: { terrain: 20 },
    size: flat(0.2, 'terrain'),
  });
  expect(buffers.count).toBeGreaterThan(1000);
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    expect(projectToCanvas(s.position).inFrustum).toBe(true);
    const { long } = strokeAxes(s.normal, s.tangent);
    expect(orientationGap(imageAngle(s.position, long), theta)).toBeLessThan(0.01);
  }
});

test('in frame, a wall facing the eye keeps the painted angle', () => {
  const theta = 2.2;
  const src = single(REGION.cypress, theta);
  const buffers = scatterSurfaces([wall(4, 6, [-2, 4, -10], 'cypress')], src, {
    seed: 2,
    density: { cypress: 100 },
    size: flat(0.1, 'cypress'),
  });
  expect(buffers.count).toBeGreaterThan(1500);
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    const { long } = strokeAxes(s.normal, s.tangent);
    expect(orientationGap(imageAngle(s.position, long), theta)).toBeLessThan(0.01);
  }
});

test('brush, stroke layer and size follow the layer region style', () => {
  const layers: WorldLayer[] = ['terrain', 'building', 'roof', 'church', 'cypress', 'sky'];
  const meshes = layers.map((layer, k) => wall(4, 4, [k * 5 - 12, 3, -20], layer));
  const density = Object.fromEntries(layers.map((l) => [l, 30]));
  const size = Object.fromEntries(layers.map((l, k) => [l, flatSize(0.1 + k * 0.05)]));
  const expectedLayer: Record<string, number> = {
    terrain: STROKE_LAYER.ground,
    building: STROKE_LAYER.building,
    roof: STROKE_LAYER.building,
    church: STROKE_LAYER.building,
    cypress: STROKE_LAYER.cypress,
    sky: STROKE_LAYER.sky,
  };
  for (const [k, mesh] of meshes.entries()) {
    const layer = layers[k];
    const buffers = scatterSurfaces([mesh], MIXED, { seed: 1, density, size });
    expect(buffers.count).toBeGreaterThan(300);
    const style = REGION_STYLES[LAYER_REGION[layer]];
    // A face-clamped stroke by the wall's edge may come out shorter or narrower (face-clamp.ts),
    // never longer or wider; one away from the edges is whole.
    const clamped = FACE_CLAMPED_LAYERS.includes(layer);
    const base = size[layer].near;
    let whole = 0;
    for (let i = 0; i < buffers.count; i++) {
      const s = unpackInstance(buffers, i);
      expect(s.layer).toBe(expectedLayer[layer]);
      expect(style.brushes).toContain(s.brush);
      const aspect = BRUSHES[s.brush].aspect;
      expect(s.size[0]).toBeLessThanOrEqual(base * (1 + SCATTER_SIZE_JITTER) + 1e-6);
      const isWhole =
        s.size[0] >= base * (1 - SCATTER_SIZE_JITTER) - 1e-6 &&
        Math.abs(s.size[1] - s.size[0] * aspect) < 1e-5;
      if (isWhole) whole++;
      if (clamped) {
        const foot = BRUSH_FOOTPRINT[BRUSHES[s.brush].kind];
        expect(s.size[1]).toBeLessThanOrEqual(base * (1 + SCATTER_SIZE_JITTER) * aspect + 1e-6);
        // The painted footprint is never wider than it is long.
        expect(s.size[1] * foot.width).toBeLessThanOrEqual(s.size[0] * foot.length + 1e-6);
      } else expect(isWhole).toBe(true);
    }
    expect(whole / buffers.count, layer).toBeGreaterThan(0.8);
  }
});

test('colours are the canvas colour with the stroke shade divided out', () => {
  const src = single(REGION.hills, 0.3);
  const buffers = scatterSurfaces([ground(6, 0, 0, -12, 'terrain')], src, {
    seed: 4,
    density: { terrain: 20 },
    size: flat(0.2, 'terrain'),
  });
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    // The test image is constant in g: 90.
    expect(Math.abs(s.color[1] - 90 / strokeShade(s.normal))).toBeLessThanOrEqual(1);
    expect(s.color[3]).toBe(255);
  }
});

test('the lift takes the share of its quad size that the tie-break takes, so both order alike', () => {
  const src = single(REGION.hills, 0.3);
  const buffers = scatterSurfaces([ground(6, 0, 0, -12, 'terrain')], src, {
    seed: 4,
    density: { terrain: 20 },
    size: flat(0.2, 'terrain'),
  });
  const shares: number[] = [];
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    expect((s.flags ?? 0) & DEPTH_RANKED_FLAG).toBe(DEPTH_RANKED_FLAG);
    // Sizes come back from the float32 buffer, exactly as the shader reads them.
    const share = sizeShare(s.size[0], s.size[1]);
    shares.push(share);
    // Flat ground at y = 0 and a flat size: the lift is the height, from the graded length only.
    expect(s.position[1]).toBeCloseTo(SCATTER_DEPTH_JITTER * 0.2 * share, 6);
  }
  // The shares spread over the range, not onto a few values.
  shares.sort((a, b) => a - b);
  expect(new Set(shares).size).toBe(shares.length);
  expect(shares[Math.floor(shares.length * 0.1)]).toBeLessThan(0.15);
  expect(shares[Math.floor(shares.length * 0.9)]).toBeGreaterThan(0.85);
});

test('lowbias32 matches the GLSL uint hash on fixed inputs, and the share is the top 24 bits', () => {
  // Reference: the same steps in BigInt modulo 2^32, as GLSL uint arithmetic wraps.
  const ref = (x: number): number => {
    const m = 0xffffffffn;
    let h = BigInt(x >>> 0);
    h ^= h >> 16n;
    h = (h * 0x7feb352dn) & m;
    h ^= h >> 15n;
    h = (h * 0x846ca68bn) & m;
    h ^= h >> 16n;
    return Number(h);
  };
  for (const x of [0, 1, 2, 0x3e4ccccd, 0x7fffffff, 0x80000000, 0xdeadbeef, 0xffffffff]) {
    expect(lowbias32(x)).toBe(ref(x));
  }
  const bits = (v: number): number => new Uint32Array(new Float32Array([v]).buffer)[0];
  const length = Math.fround(0.237);
  const width = Math.fround(0.061);
  expect(sizeShare(length, width)).toBe((ref(bits(length) ^ ref(bits(width))) >>> 8) / 2 ** 24);
});

/**
 * The share stroke.vert.glsl reads, `u = iTie * (1.0 / S)`, over the CPU depth key `tieKeys`
 * writes (tie-key.ts): the size hash of a ranked stroke. Any other extraction throws, so a changed
 * shader fails here instead of drifting from the scatter's lift. tests/strokes-tie-key.test.ts
 * holds the key to the hash the shader computed before it read iTie.
 */
function shaderShare(buffers: StrokeBuffers): (i: number) => number {
  const extract = /^ {2}float u = iTie \* \(1\.0 \/ (\d+)\.0\);$/m.exec(vertexShader);
  if (!extract) throw new Error('the iTie share not found in stroke.vert.glsl');
  expect(Number(extract[1])).toBe(16777216);
  const keys = tieKeys(buffers);
  return (i) => keys[i] / Number(extract[1]);
}

/** One ranked stroke of quad size `length` × `width`, as the shader reads its share. */
function rankedShare(length: number, width: number): number {
  const buffers = createStrokeBuffers(1);
  packInstance(buffers, 0, {
    position: [1.5, 0.25, -7],
    normal: [0, 1, 0],
    tangent: 0,
    color: [200, 180, 40, 255],
    size: [length, width],
    brush: 0,
    layer: STROKE_LAYER.ground,
    phase: 0,
    flags: DEPTH_RANKED_FLAG,
  });
  return shaderShare(buffers)(0);
}

test('the scatter lift share equals the vertex shader share, read from its depth key', () => {
  for (const [length, width] of [
    [0.237, 0.061],
    [1.5, 0.41],
    [3.75, 0.9],
  ]) {
    const l = Math.fround(length);
    const w = Math.fround(width);
    expect(rankedShare(l, w)).toBe(sizeShare(l, w));
    // Swapping length and width gives another share, so an argument swap on either side fails.
    expect(rankedShare(w, l)).not.toBe(rankedShare(l, w));
  }
  // The scatter's lift on flat ground, against the shader's share of the stored size.
  const buffers = scatterSurfaces([ground(6, 0, 0, -12, 'terrain')], single(REGION.hills, 0.3), {
    seed: 4,
    density: { terrain: 20 },
    size: flat(0.2, 'terrain'),
  });
  const gpu = shaderShare(buffers);
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    expect(s.position[1]).toBeCloseTo(SCATTER_DEPTH_JITTER * 0.2 * gpu(i), 6);
  }
});

test('window strokes keep the emissive warm colour, sRGB encoded', () => {
  const glass = wall(3, 2, [0, 2, -15], 'window');
  glass.userData.emissive = true;
  glass.userData.color = WINDOW_COLOR;
  const buffers = scatterSurfaces([glass], MIXED, {
    seed: 6,
    density: { window: 100 },
    size: flat(0.2, 'window'),
  });
  expect(buffers.count).toBeGreaterThan(400);
  const srgb = WINDOW_COLOR.map((c) =>
    c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055,
  );
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    const shade = strokeShade(s.normal);
    for (let k = 0; k < 3; k++) {
      const expected = Math.min(255, (srgb[k] * 255) / shade);
      expect(Math.abs(s.color[k] - expected)).toBeLessThanOrEqual(1);
    }
    expect(s.layer).toBe(STROKE_LAYER.building);
  }
});

test('only emissive (window) strokes carry the depth tie-break front flag', () => {
  const glass = wall(3, 2, [0, 2, -15], 'window');
  glass.userData.emissive = true;
  glass.userData.color = WINDOW_COLOR;
  // The plaster wall stands 10 m to the right, so x tells the two meshes' strokes apart.
  const plaster = wall(3, 2, [10, 2, -15], 'building');
  const buffers = scatterSurfaces([glass, plaster], MIXED, {
    seed: 6,
    density: { window: 100, building: 100 },
    size: flat(0.2, 'window', 'building'),
  });
  let front = 0;
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    const onGlass = s.position[0] < 5;
    // Both are face-clamped layers, so the fit scale bits sit above the depth flags.
    expect((s.flags ?? 0) & (DEPTH_TIE_BREAK_FRONT_FLAG | DEPTH_BACKDROP_FLAG)).toBe(
      onGlass ? DEPTH_TIE_BREAK_FRONT_FLAG : 0,
    );
    if (onGlass) front++;
  }
  expect(front).toBeGreaterThan(400);
  expect(buffers.count - front).toBeGreaterThan(400);
});

test('a zero-area triangle on an outlined layer is skipped on its own and keeps every outline', () => {
  // One flat grey: plain strokes share one colour and outline strokes are OUTLINE_DARKEN of it.
  const grey = raster(10, 8, () => [120, 120, 120]);
  const regions = raster(4, 4, () => [REGION.village, 0, 0]);
  const flow = constantFlow(0);
  const uniform: CanvasSource = {
    image: grey,
    regions,
    flow,
    histogram: buildCanvasHistogram(grey, regions, flow),
  };
  const clean = wall(4, 3, [0, 2, -15], 'building');
  const broken = wall(4, 3, [0, 2, -15], 'building');
  const index = broken.getIndex();
  if (!index) throw new Error('wall() is indexed');
  // A repeated vertex: zero area, sharing an edge with the wall's first triangle.
  broken.setIndex([...Array.from(index.array), 0, 0, 1]);
  const options = { seed: 3, density: { building: 100 }, size: flat(0.3, 'building') };
  const a = scatterSurfaces([clean], uniform, options);
  const b = scatterSurfaces([broken], uniform, options);
  const outlines = (buffers: StrokeBuffers): number => {
    let brightest = 0;
    for (let i = 0; i < buffers.count; i++) {
      brightest = Math.max(brightest, buffers.color[i * 4]);
    }
    let dark = 0;
    for (let i = 0; i < buffers.count; i++) {
      if (buffers.color[i * 4] < brightest * ((1 + OUTLINE_DARKEN) / 2)) dark++;
    }
    return dark;
  };
  // One row along each of the wall's 4 sides.
  expect(outlines(a)).toBeGreaterThanOrEqual(4);
  expect(b.count).toBe(a.count);
  expect(outlines(b)).toBe(outlines(a));
  expect(hashStrokeBuffers(b)).toBe(hashStrokeBuffers(a));
});

test('only strokes on a backdrop surface carry the backdrop flag', () => {
  const dome = createSkyDome();
  // A plain sky-layer wall, as `?strokesTest` and the haze are: sky colours, normal depth.
  const skyWall = wall(3, 2, [0, 2, -15], 'sky');
  skyWall.userData.scatter = { density: 50 };
  const buffers = scatterSurfaces([dome, skyWall], MIXED, {
    seed: 7,
    density: { sky: 0.02 },
    size: flat(2, 'sky'),
  });
  let backdrop = 0;
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    const onDome = eyeDistance(s.position) > 100;
    expect(s.flags).toBe((onDome ? DEPTH_BACKDROP_FLAG : 0) | DEPTH_RANKED_FLAG);
    if (onDome) backdrop++;
  }
  expect(backdrop).toBeGreaterThan(1000);
  expect(buffers.count - backdrop).toBeGreaterThan(0);
});

test('sky dome strokes face the eye', () => {
  const buffers = scatterSurfaces([createSkyDome()], MIXED, {
    seed: 8,
    density: { sky: 0.02 },
    size: flat(2, 'sky'),
  });
  expect(buffers.count).toBeGreaterThan(3000);
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    const toEye = s.position.map((v, k) => PAINTER_EYE[k] - v) as unknown as Vec3;
    expect(dot(s.normal, toEye) / Math.hypot(...toEye)).toBeGreaterThan(0.99);
    expect(s.layer).toBe(STROKE_LAYER.sky);
  }
});

test('a fixed seed gives an identical batch hash, independent of layer order', () => {
  const make = (): BufferGeometry[] => [
    ground(10, 0, 0, -20, 'terrain'),
    wall(6, 4, [0, 20, -60], 'sky'),
    tagged(new SphereGeometry(2, 12, 8).translate(-4, 3, -10), 'cypress'),
  ];
  const opts = {
    density: { terrain: 10, sky: 4, cypress: 20 },
    size: flat(0.3, 'terrain', 'sky', 'cypress'),
  };
  const a = scatterSurfaces(make(), MIXED, { seed: 42, ...opts });
  const b = scatterSurfaces(make(), MIXED, { seed: 42, ...opts });
  const reversed = scatterSurfaces(make().reverse(), MIXED, { seed: 42, ...opts });
  const other = scatterSurfaces(make(), MIXED, { seed: 43, ...opts });
  expect(a.count).toBeGreaterThan(1000);
  expect(hashStrokeBuffers(a)).toBe(hashStrokeBuffers(b));
  expect(hashStrokeBuffers(reversed)).toBe(hashStrokeBuffers(a));
  expect(hashStrokeBuffers(other)).not.toBe(hashStrokeBuffers(a));
});

test('geometry without a known layer tag is rejected', () => {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  expect(() => scatterSurfaces([g], MIXED, { seed: 1 })).toThrow(TypeError);
  g.userData.layer = 'lava';
  expect(() => scatterSurfaces([g], MIXED, { seed: 1 })).toThrow(TypeError);
});

test('degenerate triangles and a zero density emit nothing', () => {
  const g = new BufferGeometry();
  g.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([0, 0, -5, 1, 0, -5, 2, 0, -5]), 3),
  );
  const buffers = scatterSurfaces([tagged(g, 'terrain'), ground(5, 0, 0, -10, 'haze')], MIXED, {
    seed: 1,
    density: { terrain: 1000, haze: 0 },
  });
  expect(buffers.count).toBe(0);
});

test('two meshes on one layer draw from their own streams, never replaying each other', () => {
  const options = { seed: 9, density: { terrain: 20 }, size: flat(0.2, 'terrain') };
  const buffers = scatterSurfaces(
    [ground(6, 0, 0, -15, 'terrain'), ground(6, 0, 0, -15, 'terrain')],
    MIXED,
    options,
  );
  const single = scatterSurfaces([ground(6, 0, 0, -15, 'terrain')], MIXED, options);
  expect(single.count).toBeGreaterThan(500);
  // The first mesh matches a lone run; the second does not repeat its positions.
  expect([...buffers.position.subarray(0, single.count * 3)]).toEqual([...single.position]);
  const second = buffers.position.subarray(single.count * 3, single.count * 6);
  expect([...second]).not.toEqual([...single.position]);
});

test('below one stroke per triangle the count still matches area × density within 5%', () => {
  const fine = tagged(
    new PlaneGeometry(20, 20, 200, 200).rotateX(-Math.PI / 2).translate(0, 0, -20),
    'terrain',
  );
  const density = 40;
  const perTriangle = (surfaceArea(fine) / (200 * 200 * 2)) * density;
  expect(perTriangle).toBeLessThan(0.25);
  const buffers = scatterSurfaces([fine], MIXED, {
    seed: 13,
    density: { terrain: density },
    size: flat(0.2, 'terrain'),
  });
  const expected = triangleArea(fine) * density;
  expect(Math.abs(buffers.count / expected - 1)).toBeLessThanOrEqual(0.05);
});

test('graded strokes grow with distance and the count follows the graded density', () => {
  const plane = tagged(
    new PlaneGeometry(10, 60, 10, 60).rotateX(-Math.PI / 2).translate(0, 0, -33),
    'terrain',
  );
  const buffers = scatterSurfaces([plane], MIXED, { seed: 21 });
  const size = LAYER_SIZE.terrain;
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    const ratio = s.size[0] / strokeSizeAt(size, eyeDistance(s.position));
    expect(ratio).toBeGreaterThanOrEqual(1 - SCATTER_SIZE_JITTER - 1e-3);
    expect(ratio).toBeLessThanOrEqual(1 + SCATTER_SIZE_JITTER + 1e-3);
  }
  // Expected count: the graded density at each triangle centroid, times its area.
  const p = plane.getAttribute('position');
  const index = plane.getIndex();
  if (!index) throw new Error('indexed plane');
  const tri = new Triangle();
  let expected = 0;
  for (let t = 0; t < index.count; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => new Vector3().fromBufferAttribute(p, index.getX(t + k)));
    const centroid = new Vector3().add(a).add(b).add(c).divideScalar(3).toArray() as Vec3;
    expected +=
      tri.set(a, b, c).getArea() *
      scatterDensityAt(LAYER_DENSITY.terrain, size, eyeDistance(centroid));
  }
  expect(expected).toBeGreaterThan(4000);
  expect(Math.abs(buffers.count / expected - 1)).toBeLessThanOrEqual(0.05);
});

/** The default world's surfaces at generator seed 1, ground and ridge first. */
function defaultWorld(): BufferGeometry[] {
  const terrain = createTerrain(1);
  const village = createVillage(1, terrain);
  return [
    terrain.geometry,
    terrain.ridge,
    ...Object.values(village.geometries),
    createCypress(1, terrain).geometry,
    createSkyDome(),
  ];
}

test('near-ground strokes span about 2-4 degrees at the painter eye', () => {
  const buffers = scatterSurfaces([createTerrain(1).geometry], MIXED, { seed: 1 });
  let near = 0;
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    if (Math.hypot(s.position[0], s.position[2]) > 5) continue;
    near++;
    const degrees = (2 * Math.atan(s.size[0] / 2 / eyeDistance(s.position)) * 180) / Math.PI;
    expect(degrees).toBeGreaterThanOrEqual(2);
    expect(degrees).toBeLessThanOrEqual(4);
  }
  expect(near).toBeGreaterThan(5000);
});

test('the default world stores at most 900k strokes and the ridge takes a small share', () => {
  const world = defaultWorld();
  const total = scatterSurfaces(world, MIXED, { seed: 1 }).count;
  const ridge = scatterSurfaces([world[1]], MIXED, { seed: 1 }).count;
  expect(total).toBeLessThanOrEqual(900_000);
  expect(total).toBeGreaterThan(300_000);
  expect(ridge / total).toBeLessThan(0.05);
});

test('a per-mesh userData.scatter override applies to that mesh only and is listed for the key', () => {
  const near = ground(6, 0, 0, -15, 'terrain');
  const far = ground(6, 0, 0, -40, 'terrain');
  far.userData.scatter = { density: 50, size: { near: 0.4, far: 0.4, slope: 0 } };
  const options = { seed: 4, density: { terrain: 20 }, size: flat(0.2, 'terrain') };
  const buffers = scatterSurfaces([near, far], MIXED, options);
  const lone = scatterSurfaces([near], MIXED, options);
  const farCount = buffers.count - lone.count;
  expect(Math.abs(farCount / (36 * 50) - 1)).toBeLessThan(0.1);
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    const base = i < lone.count ? 0.2 : 0.4;
    expect(s.size[0]).toBeGreaterThanOrEqual(base * (1 - SCATTER_SIZE_JITTER) - 1e-6);
    expect(s.size[0]).toBeLessThanOrEqual(base * (1 + SCATTER_SIZE_JITTER) + 1e-6);
  }
  expect(scatterOverrides([near, far])).toEqual([
    { layer: 'terrain', mesh: 1, override: far.userData.scatter },
  ]);
  far.userData.scatter = { size: { near: -1 } };
  expect(() => scatterSurfaces([far], MIXED, options)).toThrow(RangeError);
});
