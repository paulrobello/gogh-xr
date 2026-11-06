import { expect, test } from 'vitest';
import { parseFlags } from '../src/diag/flags.ts';
import { createStrokeBuffers, type StrokeBuffers } from '../src/render/strokes/instance.ts';
import { LAYER_DENSITY, LAYER_SIZE, SCATTER_VERSION } from '../src/render/strokes/scatter.ts';
import {
  BUILD_SHA,
  hashStrokeBuffers,
  loadOrScatter,
  SCATTER_CACHE_TIMEOUT_MS,
  type ScatterCacheStorage,
  type ScatterKeyInputs,
  scatterCacheKey,
  scatterInputHash,
  shouldBypassScatterCache,
} from '../src/render/strokes/scatter-cache.ts';

const INPUTS: ScatterKeyInputs = {
  seed: 1,
  density: LAYER_DENSITY,
  size: LAYER_SIZE,
  generators: { terrain: 1, village: 1, cypress: 1 },
};

function sample(count: number, fill: number): StrokeBuffers {
  const b = createStrokeBuffers(count);
  b.position.fill(fill);
  b.color.fill(fill);
  b.meta.fill(1);
  return b;
}

/** In-memory storage with a call log; `fail` makes the named operation reject. */
function memoryStorage(fail: { get?: boolean; put?: boolean } = {}) {
  const map = new Map<string, unknown>();
  const log: string[] = [];
  const storage: ScatterCacheStorage = {
    async get(key) {
      log.push(`get ${key}`);
      if (fail.get) throw new Error('unavailable');
      return map.get(key);
    },
    async put(key, value) {
      log.push(`put ${key}`);
      if (fail.put) throw new Error('quota');
      map.set(key, value);
    },
  };
  return { storage, map, log };
}

test('the build sha is defined for tests', () => {
  expect(typeof BUILD_SHA).toBe('string');
  expect(BUILD_SHA.length).toBeGreaterThan(0);
});

test('the key is the build sha plus a stable scatter-input hash', () => {
  const hash = scatterInputHash(INPUTS);
  expect(hash).toMatch(/^[0-9a-f]{8,}$/);
  expect(scatterInputHash({ ...INPUTS })).toBe(hash);
  // Key order of the tables does not matter.
  const reordered = Object.fromEntries(Object.entries(LAYER_DENSITY).reverse());
  expect(scatterInputHash({ ...INPUTS, density: reordered })).toBe(hash);
  expect(scatterCacheKey('abc1234', INPUTS)).toBe(`abc1234:${hash}`);
  // Omitting the version means the current SCATTER_VERSION, omitting normals means vertex normals.
  expect(scatterInputHash({ ...INPUTS, version: SCATTER_VERSION })).toBe(hash);
  expect(scatterInputHash({ ...INPUTS, normals: 'vertex' })).toBe(hash);
});

test('every scatter input changes the key', () => {
  const base = scatterInputHash(INPUTS);
  const variants: ScatterKeyInputs[] = [
    { ...INPUTS, seed: 2 },
    { ...INPUTS, density: { ...LAYER_DENSITY, sky: LAYER_DENSITY.sky + 0.1 } },
    { ...INPUTS, size: { ...LAYER_SIZE, cypress: { ...LAYER_SIZE.cypress, near: 0.3 } } },
    { ...INPUTS, overrides: [{ layer: 'terrain', mesh: 1, override: { density: 3 } }] },
    { ...INPUTS, generators: { ...INPUTS.generators, village: 2 } },
    { ...INPUTS, normals: 'face' },
    { ...INPUTS, version: SCATTER_VERSION + 1 },
  ];
  const hashes = variants.map(scatterInputHash);
  for (const h of hashes) expect(h).not.toBe(base);
  expect(new Set(hashes).size).toBe(hashes.length);
  expect(scatterCacheKey('aaaaaaa', INPUTS)).not.toBe(scatterCacheKey('bbbbbbb', INPUTS));
});

const PROD = { mode: 'production', prod: true, sha: 'abc1234' } as const;
const DEV = { mode: 'development', prod: false, sha: 'abc1234' } as const;

test('a production build uses the cache unless e2e mode, an explicit seed or nocache', () => {
  expect(shouldBypassScatterCache(PROD, parseFlags(''))).toBe(false);
  expect(shouldBypassScatterCache(PROD, parseFlags('?diag'))).toBe(false);
  // `vite build --mode e2e` is a production build too.
  expect(shouldBypassScatterCache({ ...PROD, mode: 'e2e' }, parseFlags(''))).toBe(true);
  expect(shouldBypassScatterCache(PROD, parseFlags('?seed=3'))).toBe(true);
  expect(shouldBypassScatterCache(PROD, parseFlags('?nocache'))).toBe(true);
  expect(shouldBypassScatterCache(PROD, parseFlags('?nocache=0'))).toBe(false);
});

test('the dev fallback sha always bypasses, even with cache', () => {
  expect(shouldBypassScatterCache({ ...PROD, sha: 'dev' }, parseFlags(''))).toBe(true);
  expect(shouldBypassScatterCache({ ...DEV, sha: 'dev' }, parseFlags('?cache'))).toBe(true);
});

test('a non-production build bypasses unless cache opts back in; nocache wins over cache', () => {
  expect(shouldBypassScatterCache(DEV, parseFlags(''))).toBe(true);
  expect(shouldBypassScatterCache(DEV, parseFlags('?cache=0'))).toBe(true);
  expect(shouldBypassScatterCache(DEV, parseFlags('?cache'))).toBe(false);
  expect(shouldBypassScatterCache(DEV, parseFlags('?cache&nocache'))).toBe(true);
  expect(shouldBypassScatterCache(DEV, parseFlags('?cache&seed=3'))).toBe(true);
  expect(shouldBypassScatterCache({ ...DEV, mode: 'e2e' }, parseFlags('?cache'))).toBe(true);
  expect(shouldBypassScatterCache(PROD, parseFlags('?cache&nocache'))).toBe(true);
});

test('a miss scatters and stores, then the same key hits without scattering', async () => {
  const { storage, map } = memoryStorage();
  let scatters = 0;
  const scatter = (): StrokeBuffers => {
    scatters++;
    return sample(5, 3);
  };
  const first = await loadOrScatter({ storage, key: 'k1', bypass: false, scatter });
  expect(first.hit).toBe(false);
  expect(await first.saved).toBe(true);
  expect(map.has('k1')).toBe(true);
  const second = await loadOrScatter({ storage, key: 'k1', bypass: false, scatter });
  expect(second.hit).toBe(true);
  expect(scatters).toBe(1);
  expect(hashStrokeBuffers(second.buffers)).toBe(hashStrokeBuffers(first.buffers));
});

test('a key change misses', async () => {
  const { storage } = memoryStorage();
  let scatters = 0;
  const scatter = (): StrokeBuffers => {
    scatters++;
    return sample(4, scatters);
  };
  await (await loadOrScatter({ storage, key: 'old', bypass: false, scatter })).saved;
  const next = await loadOrScatter({ storage, key: 'new', bypass: false, scatter });
  expect(next.hit).toBe(false);
  expect(scatters).toBe(2);
});

test('bypass never reads or writes the storage', async () => {
  const { storage, log } = memoryStorage();
  const result = await loadOrScatter({
    storage,
    key: 'k',
    bypass: true,
    scatter: () => sample(2, 1),
  });
  expect(result.hit).toBe(false);
  expect(await result.saved).toBe(false);
  expect(log).toEqual([]);
});

test('no storage (IndexedDB unavailable) degrades to a scatter', async () => {
  const result = await loadOrScatter({
    storage: null,
    key: 'k',
    bypass: false,
    scatter: () => sample(2, 1),
  });
  expect(result.hit).toBe(false);
  expect(result.buffers.count).toBe(2);
  expect(await result.saved).toBe(false);
});

test('read and write failures degrade to a re-scatter and never throw', async () => {
  for (const fail of [{ get: true }, { put: true }, { get: true, put: true }]) {
    const { storage } = memoryStorage(fail);
    const result = await loadOrScatter({
      storage,
      key: 'k',
      bypass: false,
      scatter: () => sample(3, 2),
    });
    expect(result.hit).toBe(false);
    expect(result.buffers.count).toBe(3);
    expect(await result.saved).toBe(fail.put !== true);
  }
});

test('a storage that throws synchronously still degrades to a scatter', async () => {
  const storage = {
    get(): Promise<unknown> {
      throw new Error('sync get');
    },
    put(): Promise<void> {
      throw new Error('sync put');
    },
  };
  const result = await loadOrScatter({
    storage,
    key: 'k',
    bypass: false,
    scatter: () => sample(1, 1),
  });
  expect(result.hit).toBe(false);
  expect(await result.saved).toBe(false);
});

test('a read that never settles times out to a miss and a scatter', async () => {
  const storage: ScatterCacheStorage = {
    get: () => new Promise(() => {}),
    put: async () => {},
  };
  const started = Date.now();
  const result = await loadOrScatter({
    storage,
    key: 'k',
    bypass: false,
    scatter: () => sample(2, 1),
    timeoutMs: 30,
  });
  expect(result.hit).toBe(false);
  expect(result.buffers.count).toBe(2);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(SCATTER_CACHE_TIMEOUT_MS).toBe(2000);
});

test('a corrupt entry is ignored and overwritten', async () => {
  const good = sample(3, 9);
  const corrupt: unknown[] = [
    null,
    'garbage',
    { count: 3 },
    { ...good, count: 4 },
    { ...good, position: new Float32Array(2) },
    { ...good, normal: new Uint16Array(6) },
    { ...good, count: -1 },
  ];
  for (const entry of corrupt) {
    const { storage, map } = memoryStorage();
    map.set('k', entry);
    let scatters = 0;
    const result = await loadOrScatter({
      storage,
      key: 'k',
      bypass: false,
      scatter: () => {
        scatters++;
        return good;
      },
    });
    expect(result.hit).toBe(false);
    expect(scatters).toBe(1);
    expect(await result.saved).toBe(true);
    expect(map.get('k')).toBe(good);
  }
});

test('the batch hash covers every packed array', () => {
  const a = sample(3, 1);
  const base = hashStrokeBuffers(a);
  for (const key of ['position', 'normal', 'tangent', 'color', 'size', 'meta'] as const) {
    const b = sample(3, 1);
    b[key][b[key].length - 1] += 1;
    expect(hashStrokeBuffers(b)).not.toBe(base);
  }
  expect(hashStrokeBuffers(sample(4, 1))).not.toBe(base);
});
