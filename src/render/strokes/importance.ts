import { mulberry32 } from '../../util/prng';
import { drain, type Steps } from '../../util/slicer';

/** Target strokes per sub-cell when sizing the stratification grid. */
const STROKES_PER_BUCKET = 16;
/** Most sub-cells per axis: 32³ buckets at most. */
const MAX_BUCKETS_PER_AXIS = 32;

/**
 * Reorders a chunk's strokes so that every prefix is a stratified sample of the whole chunk: the
 * first `d·n` entries take about `d` of the strokes in every region, within one stroke per
 * sub-cell. A density scalar then draws a prefix and thins the chunk evenly.
 *
 * Strokes are bucketed into a sub-grid over the chunk's bounding box, sized for about 16 strokes
 * per sub-cell on a surface. Within a bucket of `n_b` strokes they are shuffled, and the stroke at
 * shuffled rank `j` gets the key `(j + u_b) / n_b` with one random offset `u_b` per bucket
 * (systematic sampling). The output is sorted by key. Keys proportional to each bucket's size keep
 * the chunk's density gradients at every prefix; round-robin across buckets would draw sparse
 * sub-cells in full while starving dense ones.
 *
 * `position` holds xyz per stroke; `indices` picks the chunk's strokes. Deterministic for `seed`.
 */
export function importanceOrder(
  position: Float32Array,
  indices: ArrayLike<number>,
  seed: number,
): Uint32Array {
  return drain(importanceOrderSteps(position, indices, seed));
}

/** Strokes of one pass handled between two yields of `importanceOrderSteps`. */
const IMPORTANCE_SLICE = 16_384;

/**
 * `importanceOrder` as steps (P5.5): the same draws in the same order, yielding every
 * IMPORTANCE_SLICE strokes of each pass, so a large chunk's order spans slicer steps.
 */
export function* importanceOrderSteps(
  position: Float32Array,
  indices: ArrayLike<number>,
  seed: number,
): Steps<Uint32Array> {
  const n = indices.length;
  const out = new Uint32Array(n);
  if (n === 0) return out;
  const rand = mulberry32(seed);
  const slice = IMPORTANCE_SLICE;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % slice === 0) yield;
    const p = indices[i] * 3;
    for (let k = 0; k < 3; k++) {
      const v = position[p + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const s = Math.min(
    MAX_BUCKETS_PER_AXIS,
    Math.max(1, Math.round(Math.sqrt(n / STROKES_PER_BUCKET))),
  );
  const scale = [0, 1, 2].map((k) => (max[k] > min[k] ? s / (max[k] - min[k]) : 0));

  // Counting sort of strokes by bucket.
  const bucketOf = new Uint32Array(n);
  const sizes = new Uint32Array(s * s * s);
  yield;
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % slice === 0) yield;
    const p = indices[i] * 3;
    let b = 0;
    for (let k = 0; k < 3; k++) {
      b = b * s + Math.min(s - 1, Math.floor((position[p + k] - min[k]) * scale[k]));
    }
    bucketOf[i] = b;
    sizes[b]++;
  }
  const starts = new Uint32Array(sizes.length + 1);
  for (let b = 0; b < sizes.length; b++) starts[b + 1] = starts[b] + sizes[b];
  const grouped = new Uint32Array(n);
  const cursor = starts.slice(0, sizes.length);
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % slice === 0) yield;
    grouped[cursor[bucketOf[i]]++] = indices[i];
  }

  // Shuffle each bucket (Fisher-Yates) and key its strokes by (j + u_b) / n_b. Buckets are visited
  // in a shuffled order, which only breaks ties between equal key slots.
  const occupied: number[] = [];
  for (let b = 0; b < sizes.length; b++) if (sizes[b] > 0) occupied.push(b);
  for (let i = occupied.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [occupied[i], occupied[j]] = [occupied[j], occupied[i]];
  }
  // Counting sort on slot floor(key * n): O(n) and stable, so the order stays deterministic.
  const slotOf = new Uint32Array(n);
  const slotSizes = new Uint32Array(n + 1);
  const keyed = new Uint32Array(n);
  let next = 0;
  let keyedSinceYield = 0;
  for (const b of occupied) {
    if (keyedSinceYield >= slice) {
      keyedSinceYield = 0;
      yield;
    }
    const start = starts[b];
    const size = sizes[b];
    keyedSinceYield += size;
    for (let i = size - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = grouped[start + i];
      grouped[start + i] = grouped[start + j];
      grouped[start + j] = t;
    }
    const u = rand();
    for (let j = 0; j < size; j++) {
      const slot = Math.min(n - 1, Math.floor(((j + u) / size) * n));
      keyed[next] = grouped[start + j];
      slotOf[next++] = slot;
      slotSizes[slot + 1]++;
    }
  }
  yield;
  for (let k = 0; k < n; k++) slotSizes[k + 1] += slotSizes[k];
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % slice === 0) yield;
    out[slotSizes[slotOf[i]]++] = keyed[i];
  }
  return out;
}
