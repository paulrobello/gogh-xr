import {
  DataTexture,
  type InstancedBufferAttribute,
  type InstancedBufferGeometry,
  Object3D,
  Texture,
} from 'three';
import { BatchedText } from 'troika-three-text';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createArcMesh } from '../src/locomotion/arc-mesh.ts';
import { createArcResult, FLAT_WORLD, traceArc } from '../src/locomotion/teleport.ts';
import { createFlyStrokes, FLY_COUNT } from '../src/portal/fly-strokes.ts';
import {
  BACKDROP_DOME_RANKS,
  BACKDROP_FRONT_RANK_SHIFT,
  BACKDROP_RANK_SHIFT,
  DEPTH_BACKDROP_FLAG,
} from '../src/render/strokes/backdrop-depth.ts';
import { createStrokeBatch } from '../src/render/strokes/batch.ts';
import {
  DEPTH_RANKED_FLAG,
  DEPTH_TIE_BREAK_FRONT_FLAG,
  float32Bits,
  lowbias32,
} from '../src/render/strokes/depth-tie-break.ts';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_ATTRIBUTES,
  STROKE_LAYER,
  type StrokeBuffers,
} from '../src/render/strokes/instance.ts';
import { tieKeys } from '../src/render/strokes/tie-key.ts';
import { DEFAULT_SETTINGS } from '../src/settings/schema.ts';
import { createSettingsStore } from '../src/settings/store.ts';
import { createSettingsPanel } from '../src/ui/settings-panel.ts';
import { mulberry32 } from '../src/util/prng.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** What a stroke's depth reads from its key: the backdrop rank, else the clip-z share. */
type Depth = { rank: number } | { share: number };

const front = (layer: number): boolean =>
  layer === STROKE_LAYER.star || layer === STROKE_LAYER.moon;

/**
 * The TS mirror of the depth key stroke.vert.glsl hashed per vertex before the key moved to the CPU
 * (93fce70), line for line: h the position hash, u its share, replaced by the size hash's share on
 * a ranked stroke, then the backdrop rank from h or the share (1 for a lit window).
 */
function shaderDepth(b: StrokeBuffers, i: number): Depth {
  const p = b.position;
  const s = b.size;
  const flags = b.meta[i * 4 + 3];
  const layer = b.meta[i * 4 + 1];
  const h = lowbias32(
    float32Bits(p[i * 3]) ^
      lowbias32(float32Bits(p[i * 3 + 1]) ^ lowbias32(float32Bits(p[i * 3 + 2]))),
  );
  let u = (h >>> 8) * (1 / 16777216);
  if ((flags & DEPTH_RANKED_FLAG) !== 0) {
    const hs = lowbias32(float32Bits(s[i * 2]) ^ lowbias32(float32Bits(s[i * 2 + 1])));
    u = (hs >>> 8) * (1 / 16777216);
  }
  if ((flags & DEPTH_BACKDROP_FLAG) !== 0) {
    return {
      rank: front(layer)
        ? BACKDROP_DOME_RANKS + (h >>> BACKDROP_FRONT_RANK_SHIFT)
        : h >>> BACKDROP_RANK_SHIFT,
    };
  }
  return { share: (flags & DEPTH_TIE_BREAK_FRONT_FLAG) !== 0 ? 1 : u };
}

/** The same depth as the shader now reads it from `iTie`: h8 = iTie, u = iTie / 2^24. */
function keyDepth(b: StrokeBuffers, i: number, key: number): Depth {
  const flags = b.meta[i * 4 + 3];
  const layer = b.meta[i * 4 + 1];
  const h8 = Math.fround(key) >>> 0;
  const u = Math.fround(Math.fround(key) * Math.fround(1 / 16777216));
  if ((flags & DEPTH_BACKDROP_FLAG) !== 0) {
    return {
      rank: front(layer)
        ? BACKDROP_DOME_RANKS + (h8 >>> (BACKDROP_FRONT_RANK_SHIFT - 8))
        : h8 >>> (BACKDROP_RANK_SHIFT - 8),
    };
  }
  return { share: (flags & DEPTH_TIE_BREAK_FRONT_FLAG) !== 0 ? 1 : u };
}

/** Every flags byte on every layer, at random positions and sizes: every stroke class. */
function everyClass(): StrokeBuffers {
  const rand = mulberry32(11);
  const layers = Object.values(STROKE_LAYER);
  const buffers = createStrokeBuffers(256 * layers.length);
  let i = 0;
  for (const layer of layers) {
    for (let flags = 0; flags < 256; flags++) {
      packInstance(buffers, i++, {
        position: [(rand() - 0.5) * 120, rand() * 40 - 2, (rand() - 0.5) * 120],
        normal: [rand() - 0.5, rand() - 0.5, 0.2 + rand()],
        tangent: rand(),
        color: [200, 180, 40, 255],
        size: [0.02 + rand() * 3, 0.01 + rand()],
        brush: i % 16,
        layer,
        phase: 0,
        flags,
      });
    }
  }
  return buffers;
}

describe('the CPU depth key', () => {
  test('gives every stroke class the depth the shader hashed: rank, share and lit window', () => {
    const buffers = everyClass();
    const keys = tieKeys(buffers);
    for (let i = 0; i < buffers.count; i++) {
      expect(Number.isInteger(keys[i])).toBe(true);
      expect(keys[i]).toBeLessThan(2 ** 24);
      expect(keyDepth(buffers, i, keys[i])).toEqual(shaderDepth(buffers, i));
    }
  });

  test('every batch chunk carries its strokes’ keys as iTie', () => {
    const buffers = everyClass();
    const all = tieKeys(buffers);
    const batch = createStrokeBatch(buffers, {
      cellSize: 100,
      createAtlas: () => new DataTexture(new Uint8Array(4), 1, 1),
    });
    const seen: number[] = [];
    for (const chunk of batch.chunks) {
      const tie = chunk.geometry.getAttribute('iTie') as InstancedBufferAttribute;
      expect(tie.itemSize).toBe(1);
      expect(tie.count).toBe(chunk.count);
      seen.push(...(tie.array as Float32Array));
    }
    expect(seen.sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));
    batch.dispose();
  });
});

/** The keys a lone mesh's attribute arrays hash to, for its first `count` instances. */
function keysOf(geometry: InstancedBufferGeometry, count: number): Float32Array {
  const buffers = createStrokeBuffers(count);
  for (const spec of STROKE_ATTRIBUTES) {
    const source = geometry.getAttribute(spec.name).array as ArrayLike<number>;
    const target = buffers[spec.key];
    for (let i = 0; i < count * spec.itemSize; i++) target[i] = source[i] as number;
  }
  return tieKeys(buffers);
}

const drawnKeys = (geometry: InstancedBufferGeometry, count: number): Float32Array =>
  (geometry.getAttribute('iTie').array as Float32Array).slice(0, count);

describe('the lone stroke meshes carry iTie and rehash it on every rewrite', () => {
  test('the teleport arc', () => {
    const arc = createArcMesh(new Object3D(), new DataTexture(new Uint8Array(4), 1, 1));
    for (const yaw of [0, 0.6]) {
      const aim = createArcResult();
      traceArc(aim, [0.25, 1.4, -0.4], [Math.sin(yaw), -0.3, -Math.cos(yaw)], FLAT_WORLD);
      arc.show(aim, [0, 1.6, 0]);
      const geometry = arc.mesh.geometry as InstancedBufferGeometry;
      const n = geometry.instanceCount;
      expect(n).toBeGreaterThan(0);
      expect(drawnKeys(geometry, n)).toEqual(keysOf(geometry, n));
    }
  });

  test('the portal fly strokes write their key once: with no depth test it cannot change pixels', () => {
    const fly = createFlyStrokes(new Object3D(), new DataTexture(new Uint8Array(4), 1, 1));
    expect(fly.mesh.material).toMatchObject({ depthTest: false, depthWrite: false });
    const created = drawnKeys(fly.mesh.geometry as InstancedBufferGeometry, FLY_COUNT);
    const rand = mulberry32(5);
    const fill = (k: number) => Float32Array.from({ length: FLY_COUNT * k }, () => rand() * 4);
    const bytes = () => Uint8Array.from({ length: FLY_COUNT * 3 }, () => (rand() * 255) | 0);
    const leg = {
      from: fill(3),
      to: fill(3),
      fromColor: bytes(),
      toColor: bytes(),
      fromSize: fill(2),
      toSize: fill(2),
      arc: fill(1),
    };
    for (const t of [0.3, 0.7]) {
      fly.draw(leg, t, [0, 1.6, 5], 0);
      const geometry = fly.mesh.geometry as InstancedBufferGeometry;
      expect(drawnKeys(geometry, FLY_COUNT)).toEqual(created);
    }
    fly.dispose();
  });

  test('the settings panel', () => {
    // Typesetting would fetch the font.
    vi.spyOn(BatchedText.prototype, 'sync').mockImplementation(() => undefined);
    const rig = new Object3D();
    const camera = new Object3D();
    rig.add(camera);
    const store = createSettingsStore({
      stored: DEFAULT_SETTINGS,
      flags: { beauty: false, hz: null, seated: null, turn: null, hud: null, calm: null },
      save: () => true,
      schedule: () => 0,
      cancel: () => undefined,
    });
    const panel = createSettingsPanel({
      rig,
      camera,
      controller: () => null,
      store,
      atlas: new Texture(),
      recenter: () => undefined,
      gallery: () => null,
      sessionQuality: () => 'adaptive-72',
      hud: { visible: () => false, setVisible: () => undefined },
    });
    panel.open();
    let mesh: Object3D | undefined;
    rig.traverse((o) => {
      if (o.name === 'settings-panel-strokes') mesh = o;
    });
    const geometry = (mesh as unknown as { geometry: InstancedBufferGeometry }).geometry;
    const n = geometry.instanceCount;
    expect(n).toBeGreaterThan(0);
    expect(drawnKeys(geometry, n)).toEqual(keysOf(geometry, n));
  });
});
