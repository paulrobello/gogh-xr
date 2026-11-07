/**
 * The scatter cache (ruling P5): packed stroke buffers in IndexedDB, keyed by the build SHA plus a
 * hash of every scatter input. Storage is injected, so the tests run against an in-memory fake
 * (happy-dom has no IndexedDB). Any cache failure degrades to a re-scatter and never throws.
 */
import type { WorldLayer } from '../../paintings/starry-night/canvas-camera';
import { STROKE_ATTRIBUTES, type StrokeBuffers } from './instance';
import { type GradedSize, SCATTER_VERSION, type scatterOverrides } from './scatter';

/** Short git SHA of the build, injected by the vite and vitest `define`; 'dev' when git failed. */
export const BUILD_SHA: string = __BUILD_SHA__;

/** How long a cache read (IndexedDB open plus get) may take before it counts as a miss, ms. */
export const SCATTER_CACHE_TIMEOUT_MS: number = 2000;

export interface ScatterKeyInputs {
  readonly seed: number;
  readonly density: Readonly<Partial<Record<WorldLayer, number>>>;
  readonly size: Readonly<Partial<Record<WorldLayer, Partial<GradedSize>>>>;
  /** Per-mesh `userData.scatter` overrides: pass `scatterOverrides(meshes)`. */
  readonly overrides?: ReturnType<typeof scatterOverrides>;
  /** Seeds or versions of the geometry generators the scatter ran over, by name. */
  readonly generators: Readonly<Record<string, number | string>>;
  /**
   * The normal each stroke takes: the interpolated vertex normal, or the face normal when the
   * surfaces reach the scatter without a normal attribute. Defaults to 'vertex'.
   */
  readonly normals?: 'vertex' | 'face';
  /** Defaults to SCATTER_VERSION. */
  readonly version?: number;
}

export interface ScatterCacheStorage {
  /** The stored value, or undefined on a miss. May reject. */
  get(key: string): Promise<unknown>;
  /** May reject, for example on a quota error. */
  put(key: string, value: StrokeBuffers): Promise<void>;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnvBytes(hash: number, bytes: Uint8Array): number {
  let h = hash;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], FNV_PRIME);
  return h >>> 0;
}

function fnvString(hash: number, text: string): number {
  return fnvBytes(hash, new TextEncoder().encode(text));
}

const hex = (h: number): string => h.toString(16).padStart(8, '0');

/** JSON with object keys sorted at every level, so key order never changes the hash. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * 64-bit hex hash (two FNV-1a passes with different offsets) of the seed, the density and size
 * tables, the per-mesh overrides, the generator seeds, the normals mode and SCATTER_VERSION.
 */
export function scatterInputHash(inputs: ScatterKeyInputs): string {
  const text = stableJson({
    seed: inputs.seed,
    density: inputs.density,
    size: inputs.size,
    overrides: inputs.overrides ?? [],
    generators: inputs.generators,
    normals: inputs.normals ?? 'vertex',
    version: inputs.version ?? SCATTER_VERSION,
  });
  return hex(fnvString(FNV_OFFSET, text)) + hex(fnvString(FNV_OFFSET ^ 0x5bd1e995, text));
}

/** `<build sha>:<scatter input hash>`. */
export function scatterCacheKey(buildSha: string, inputs: ScatterKeyInputs): string {
  return `${buildSha}:${scatterInputHash(inputs)}`;
}

/** FNV-1a over the count and every packed array's bytes, in STROKE_ATTRIBUTES order. */
export function hashStrokeBuffers(buffers: StrokeBuffers): string {
  let h = fnvString(FNV_OFFSET, String(buffers.count));
  for (const spec of STROKE_ATTRIBUTES) {
    const array = buffers[spec.key];
    h = fnvBytes(h, new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  return hex(h);
}

/** The build a scatter cache decision is made in: `import.meta.env.MODE` and `.PROD`, and BUILD_SHA. */
export interface ScatterCacheBuild {
  readonly mode: string;
  readonly prod: boolean;
  readonly sha: string;
}

/**
 * The cache is skipped for e2e builds (`mode === 'e2e'`), an explicit `?seed` (its scatter is a
 * one-off), `?nocache` and the 'dev' fallback SHA, which never changes. A non-production build
 * (the dev server) skips it too unless `?cache` opts back in: vite evaluates `define` once at
 * server start, so its SHA goes stale across commits while a cache hit would pair new base meshes
 * with old strokes.
 */
export function shouldBypassScatterCache(
  build: ScatterCacheBuild,
  flags: { readonly seed: number | null; readonly nocache: boolean; readonly cache: boolean },
): boolean {
  if (build.mode === 'e2e' || build.sha === 'dev' || flags.seed !== null || flags.nocache) {
    return true;
  }
  return !build.prod && !flags.cache;
}

const ARRAY_TYPES = {
  position: Float32Array,
  normal: Int16Array,
  tangent: Uint16Array,
  color: Uint8Array,
  size: Float32Array,
  meta: Uint8Array,
} as const;

/** The value as StrokeBuffers when every array has its packed type and length, else null. */
function validEntry(value: unknown): StrokeBuffers | null {
  if (value === null || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const count = entry.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
  for (const spec of STROKE_ATTRIBUTES) {
    const array = entry[spec.key];
    if (!(array instanceof ARRAY_TYPES[spec.key])) return null;
    if (array.length !== count * spec.itemSize) return null;
  }
  return entry as unknown as StrokeBuffers;
}

export interface ScatterLoad {
  readonly buffers: StrokeBuffers;
  /** Read from the cache rather than scattered. */
  readonly hit: boolean;
  /** Resolves true once a fresh scatter is stored, false when skipped or the write failed. */
  readonly saved: Promise<boolean>;
}

export interface LoadOrScatterOptions {
  /** null when IndexedDB is unavailable. */
  readonly storage: ScatterCacheStorage | null;
  readonly key: string;
  readonly bypass: boolean;
  readonly scatter: () => StrokeBuffers | Promise<StrokeBuffers>;
  /** Read timeout; defaults to SCATTER_CACHE_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/** `promise`, or a rejection once `ms` pass without it settling. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`scatter cache read timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Cached buffers for `key`, or a fresh `scatter()` stored under it. A read that has not settled
 * within the timeout counts as a miss. The write runs in the background (`saved`), so a slow store
 * never delays the load. Never rejects for a cache fault.
 */
export async function loadOrScatter(options: LoadOrScatterOptions): Promise<ScatterLoad> {
  const { storage, key, bypass, scatter } = options;
  if (storage && !bypass) {
    try {
      const read = Promise.resolve().then(() => storage.get(key));
      const cached = validEntry(
        await withTimeout(read, options.timeoutMs ?? SCATTER_CACHE_TIMEOUT_MS),
      );
      if (cached) return { buffers: cached, hit: true, saved: Promise.resolve(false) };
    } catch {
      // Unavailable or failed read: scatter instead.
    }
  }
  const buffers = await scatter();
  const saved =
    storage && !bypass
      ? Promise.resolve()
          .then(() => storage.put(key, buffers))
          .then(
            () => true,
            () => false,
          )
      : Promise.resolve(false);
  return { buffers, hit: false, saved };
}

const DB_NAME = 'gogh-xr-scatter';
const STORE = 'strokes';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * IndexedDB storage, one object store of structured-cloned StrokeBuffers. Entries of older keys
 * are cleared on each write, so only the current build's scatter stays on disk. Null when
 * IndexedDB is unavailable.
 */
export function createIndexedDbStorage(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): ScatterCacheStorage | null {
  if (!factory) return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return db;
  };
  return {
    async get(key) {
      const store = (await open()).transaction(STORE, 'readonly').objectStore(STORE);
      return request(store.get(key));
    },
    async put(key, value) {
      const tx = (await open()).transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.clear();
      store.put(value, key);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
  };
}
