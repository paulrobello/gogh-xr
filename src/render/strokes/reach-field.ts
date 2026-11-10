/**
 * The stroke reach field: the distance from a point to the nearest stroke's drawn quad, out to a
 * hand's paint reach (`HAND_RADIUS`, 0.13 m). The hand orbs brighten by it and the stroke rustle
 * fires by it, so both follow exactly the strokes a hand pushes.
 *
 * Distance. The reactive shader's hand distance (reactiveMotion in motion.glsl, reactive.ts): q is
 * the length of the point's offset from the stroke's quad, with each half-size capped at
 * `HAND_HALF_SIZE_CAP`, at the stroke's rest centre. The field reads the same stored data the GPU
 * does (centre, octahedral normal, tangent and size), so q is the shader's own up to float
 * rounding while the shader's size scale (`sizeScale * uVtxSize`) is 1, as in the near band by
 * default. At scale m a half-size h draws as min(m·h, cap) against the field's min(h, cap), so the
 * field reads up to that difference far (m > 1: governor near sheds under the area law, higher
 * fixed levels, `?ab=vtx` sparse) or near (m < 1: `?ab=vtx` smaller). Strokes already at the cap
 * read exact at any m.
 *
 * Structure. Built once from the strokes' centres. A stroke whose quad lies within `reach` of the
 * point has its centre within reach plus its capped half-diagonal, so the strokes split into tiers
 * by that half-diagonal (`REACH_TIERS`), and each tier is a grid of cubic cells of about its own
 * span (its largest half-diagonal plus the reach): the cypress's small dense strokes are not
 * searched over the ground's 0.57 m half-diagonal. A cell holds the strokes whose centre is in
 * it, and the cells sort by a linear key (x fastest), so one row of x cells is a contiguous key
 * run. A query visits, in each tier, the rows within the tier's span of the point (3 × 3 rows of
 * at most 3 cells), finds each run by binary search, skips a cell whose box is farther than its
 * largest half-diagonal plus the best distance so far, and in a kept cell skips a stroke whose
 * centre is farther than that before decoding its axes. Nothing is allocated per query.
 *
 * Memory. The field holds no stroke data of its own: each entry names its source array and index
 * (4 bytes), and the sources are the batch's chunk attribute arrays, which the batch keeps for its
 * own CPU reads. Per occupied cell, a key, a start offset and a half-diagonal (16 bytes).
 */
import { HAND_HALF_SIZE_CAP, HAND_RADIUS } from '../../motion/reactive';
import { drain, type Steps } from '../../util/slicer';
import type { StrokeChunk } from './batch';

/** A stroke array the field reads: the batch chunks' attribute arrays have this shape. */
export interface StrokeSource {
  readonly count: number;
  /** Centre xyz, world metres. */
  readonly position: ArrayLike<number>;
  /** Octahedral normal, snorm16 × 2. */
  readonly normal: ArrayLike<number>;
  /** Long-axis angle about the normal, unorm16 of 2π. */
  readonly tangent: ArrayLike<number>;
  /** Quad length and width, metres. */
  readonly size: ArrayLike<number>;
}

export interface StrokeReachOptions {
  /** Metres: the farthest distance reported. Default `HAND_RADIUS`. */
  readonly reach?: number;
  /** Metres: the cap on each half-size. Default `HAND_HALF_SIZE_CAP`. */
  readonly halfSizeCap?: number;
  /** Ascending upper half-diagonals of every tier but the last, metres. Default `REACH_TIERS`. */
  readonly tiers?: readonly number[];
  /** Metres: one cell size for every tier, in place of each tier's span. */
  readonly cellSize?: number;
  /** Loop iterations (a stroke, an entry or a cell visited) between yields. */
  readonly stepUnits?: number;
  /** Called at each yield with the iterations since the last one. */
  readonly onYield?: (units: number) => void;
}

export interface StrokeReachStats {
  /** Strokes in the field. */
  readonly strokes: number;
  /** Occupied cells over every tier. */
  readonly cells: number;
  /** Per non-empty tier: its strokes, cells and cell size. */
  readonly tiers: readonly { strokes: number; cells: number; cellSize: number }[];
  /** Bytes of the field's own arrays. */
  readonly bytes: number;
}

export interface StrokeReach {
  readonly reach: number;
  readonly stats: StrokeReachStats;
  /** Metres from (x, y, z) to the nearest stroke quad, or Infinity when none is within reach. */
  distance(x: number, y: number, z: number): number;
  /** Strokes the last `distance` call tested against their centre bound. */
  readonly lastVisited: number;
}

/**
 * Tier edges, metres of capped half-diagonal. Seed-1 Starry Night's reachable strokes: the cypress
 * reaches at most 0.262, the buildings have a median of 0.378, and the ground (median 0.498) and
 * the haze sit mostly at the 0.566 cap.
 */
export const REACH_TIERS: readonly number[] = Object.freeze([0.3, 0.45]);

/**
 * Loop iterations between yields. Every pass counts into one budget, so no step does more than
 * this many visits of a stroke, an entry or a cell.
 */
export const REACH_STEP_UNITS: number = 8192;

/** Radix digit bits for the cell-key sort: two passes cover a grid of up to 2^22 cells. */
const RADIX_BITS = 11;
const RADIX = 1 << RADIX_BITS;

const SNORM16 = 32767;
const TWO_PI_OVER_UNORM16 = (2 * Math.PI) / 65535;

/** One tier's grid. */
interface Grid {
  readonly cellSize: number;
  readonly span: number;
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Occupied cells' linear keys, ascending. */
  readonly keys: Uint32Array;
  /** Cell c's entries are entries[start[c]..start[c + 1]). */
  readonly start: Uint32Array;
  /** Cell c's largest capped half-diagonal. */
  readonly halfDiagonal: Float64Array;
  readonly entries: Uint32Array;
}

/** Bits of an entry that name the stroke's index in its source. */
function indexBits(sources: readonly StrokeSource[]): number {
  let max = 1;
  for (const s of sources) max = Math.max(max, s.count);
  return Math.max(1, Math.ceil(Math.log2(max + 1)));
}

function cappedHalfDiagonal(src: StrokeSource, i: number, cap: number): number {
  const hl = Math.min(0.5 * (src.size[2 * i] as number), cap);
  const hw = Math.min(0.5 * (src.size[2 * i + 1] as number), cap);
  return Math.sqrt(hl * hl + hw * hw);
}

/**
 * Builds the field over every stroke of `sources`, in steps. The sources must keep their arrays
 * unchanged for the field's lifetime.
 */
export function* buildStrokeReachSteps(
  sources: readonly StrokeSource[],
  options: StrokeReachOptions = {},
): Steps<StrokeReach> {
  const reach = options.reach ?? HAND_RADIUS;
  const cap = options.halfSizeCap ?? HAND_HALF_SIZE_CAP;
  const edges = options.tiers ?? REACH_TIERS;
  const stepUnits = options.stepUnits ?? REACH_STEP_UNITS;
  const onYield = options.onYield;
  let work = 0;
  const bits = indexBits(sources);
  if (bits + Math.ceil(Math.log2(sources.length + 1)) > 32) {
    throw new RangeError('stroke reach field: too many strokes per source or too many sources');
  }
  const scale = 2 ** bits;
  const indexMask = scale - 1;
  const tierCount = edges.length + 1;
  const tierOf = (hd: number): number => {
    let t = 0;
    while (t < edges.length && hd > (edges[t] as number)) t += 1;
    return t;
  };

  // Pass 1: each stroke's tier, and each tier's count, bounds and largest half-diagonal.
  let total = 0;
  for (const s of sources) total += s.count;
  const tierOfStroke = new Uint8Array(total);
  const counts = new Array<number>(tierCount).fill(0);
  const lo = Array.from({ length: tierCount }, () => [Infinity, Infinity, Infinity]);
  const hi = Array.from({ length: tierCount }, () => [-Infinity, -Infinity, -Infinity]);
  const maxHd = new Array<number>(tierCount).fill(0);
  let g = 0;
  for (const s of sources) {
    const p = s.position;
    for (let i = 0; i < s.count; i += 1, g += 1) {
      const hd = cappedHalfDiagonal(s, i, cap);
      const t = tierOf(hd);
      tierOfStroke[g] = t;
      counts[t] = (counts[t] as number) + 1;
      if (hd > (maxHd[t] as number)) maxHd[t] = hd;
      const l = lo[t] as number[];
      const h = hi[t] as number[];
      for (let a = 0; a < 3; a += 1) {
        const v = p[3 * i + a] as number;
        if (v < (l[a] as number)) l[a] = v;
        if (v > (h[a] as number)) h[a] = v;
      }
      if (++work >= stepUnits) {
        onYield?.(work);
        work = 0;
        yield;
      }
    }
  }

  const grids: Grid[] = [];
  for (let t = 0; t < tierCount; t += 1) {
    const n = counts[t] as number;
    if (n === 0) continue;
    const span = reach + (maxHd[t] as number);
    const cellSize = options.cellSize ?? Math.ceil(span * 100) / 100;
    const l = lo[t] as number[];
    const h = hi[t] as number[];
    // One cell of padding on every side, so a row's x run never wraps into the next row.
    const ox = Math.floor((l[0] as number) / cellSize) * cellSize - cellSize;
    const oy = Math.floor((l[1] as number) / cellSize) * cellSize - cellSize;
    const oz = Math.floor((l[2] as number) / cellSize) * cellSize - cellSize;
    const nx = Math.floor(((h[0] as number) - ox) / cellSize) + 2;
    const ny = Math.floor(((h[1] as number) - oy) / cellSize) + 2;
    const nz = Math.floor(((h[2] as number) - oz) / cellSize) + 2;
    if (nx * ny * nz > 2 ** 32) throw new RangeError('stroke reach field: the grid is too large');

    // Pass 2: the tier's entries and their cell keys, in stroke order.
    let raw = new Uint32Array(n);
    let keys = new Uint32Array(n);
    let k = 0;
    g = 0;
    for (let si = 0; si < sources.length; si += 1) {
      const s = sources[si] as StrokeSource;
      const p = s.position;
      for (let i = 0; i < s.count; i += 1, g += 1) {
        if (tierOfStroke[g] === t) {
          const ix = Math.floor(((p[3 * i] as number) - ox) / cellSize);
          const iy = Math.floor(((p[3 * i + 1] as number) - oy) / cellSize);
          const iz = Math.floor(((p[3 * i + 2] as number) - oz) / cellSize);
          raw[k] = si * scale + i;
          keys[k] = ix + nx * (iy + ny * iz);
          k += 1;
        }
        if (++work >= stepUnits) {
          onYield?.(work);
          work = 0;
          yield;
        }
      }
    }

    // Pass 3: a stable LSD radix sort of the entries by cell key. A dense count over the grid
    // would be megabytes at a few percent occupancy.
    const keyBits = Math.max(1, Math.ceil(Math.log2(nx * ny * nz)));
    let sortedKeys = new Uint32Array(n);
    let sortedRaw = new Uint32Array(n);
    const bucket = new Uint32Array(RADIX + 1);
    for (let shift = 0; shift < keyBits; shift += RADIX_BITS) {
      bucket.fill(0);
      for (let j = 0; j < n; j += 1) {
        const d = ((keys[j] as number) >>> shift) & (RADIX - 1);
        bucket[d + 1] = (bucket[d + 1] as number) + 1;
        if (++work >= stepUnits) {
          onYield?.(work);
          work = 0;
          yield;
        }
      }
      for (let d = 0; d < RADIX; d += 1) {
        bucket[d + 1] = (bucket[d + 1] as number) + (bucket[d] as number);
      }
      for (let j = 0; j < n; j += 1) {
        const key = keys[j] as number;
        const d = (key >>> shift) & (RADIX - 1);
        const at = bucket[d] as number;
        bucket[d] = at + 1;
        sortedKeys[at] = key;
        sortedRaw[at] = raw[j] as number;
        if (++work >= stepUnits) {
          onYield?.(work);
          work = 0;
          yield;
        }
      }
      [keys, sortedKeys] = [sortedKeys, keys];
      [raw, sortedRaw] = [sortedRaw, raw];
    }
    const entries = raw;

    // Pass 4: the runs of equal keys are the cells, and each cell's largest half-diagonal.
    const runKeys = new Uint32Array(n);
    const runStart = new Uint32Array(n + 1);
    const runHd = new Float64Array(n);
    let cellsInTier = 0;
    for (let j = 0; j < n; j += 1) {
      const key = keys[j] as number;
      if (j === 0 || key !== keys[j - 1]) {
        runKeys[cellsInTier] = key;
        runStart[cellsInTier] = j;
        cellsInTier += 1;
      }
      const e = entries[j] as number;
      const hd = cappedHalfDiagonal(
        sources[Math.floor(e / scale)] as StrokeSource,
        e & indexMask,
        cap,
      );
      if (hd > (runHd[cellsInTier - 1] as number)) runHd[cellsInTier - 1] = hd;
      if (++work >= stepUnits) {
        onYield?.(work);
        work = 0;
        yield;
      }
    }
    runStart[cellsInTier] = n;
    const cellKeys = runKeys.slice(0, cellsInTier);
    const start = runStart.slice(0, cellsInTier + 1);
    const halfDiagonal = runHd.slice(0, cellsInTier);
    grids.push({
      cellSize,
      span,
      ox,
      oy,
      oz,
      nx,
      ny,
      nz,
      keys: cellKeys,
      start,
      halfDiagonal,
      entries,
    });
  }

  let strokes = 0;
  let cells = 0;
  let bytes = 0;
  for (const grid of grids) {
    strokes += grid.entries.length;
    cells += grid.keys.length;
    bytes +=
      grid.entries.byteLength +
      grid.keys.byteLength +
      grid.start.byteLength +
      grid.halfDiagonal.byteLength;
  }
  const stats: StrokeReachStats = {
    strokes,
    cells,
    tiers: grids.map((grid) => ({
      strokes: grid.entries.length,
      cells: grid.keys.length,
      cellSize: grid.cellSize,
    })),
    bytes,
  };

  const reach2 = reach * reach;
  const field = {
    reach,
    stats,
    lastVisited: 0,
    distance(x: number, y: number, z: number): number {
      let visited = 0;
      let best2 = reach2;
      let best = reach;
      for (let t = 0; t < grids.length; t += 1) {
        const grid = grids[t] as Grid;
        const { cellSize, span, ox, oy, oz, nx, ny, keys, start, halfDiagonal, entries } = grid;
        const cells = keys.length;
        const ix0 = Math.max(0, Math.floor((x - span - ox) / cellSize));
        const ix1 = Math.min(nx - 1, Math.floor((x + span - ox) / cellSize));
        const iy0 = Math.max(0, Math.floor((y - span - oy) / cellSize));
        const iy1 = Math.min(ny - 1, Math.floor((y + span - oy) / cellSize));
        const iz0 = Math.max(0, Math.floor((z - span - oz) / cellSize));
        const iz1 = Math.min(grid.nz - 1, Math.floor((z + span - oz) / cellSize));
        for (let iz = iz0; iz <= iz1; iz += 1) {
          const dz = axisGap(z, oz + iz * cellSize, cellSize);
          for (let iy = iy0; iy <= iy1; iy += 1) {
            const dy = axisGap(y, oy + iy * cellSize, cellSize);
            const row = nx * (iy + ny * iz);
            const first = row + ix0;
            const last = row + ix1;
            // The first cell key at or after `first`.
            let c = 0;
            let top = cells;
            while (c < top) {
              const mid = (c + top) >>> 1;
              if ((keys[mid] as number) < first) c = mid + 1;
              else top = mid;
            }
            for (; c < cells && (keys[c] as number) <= last; c += 1) {
              const ix = (keys[c] as number) - row;
              const dx = axisGap(x, ox + ix * cellSize, cellSize);
              const bound = (halfDiagonal[c] as number) + best;
              const bound2 = bound * bound;
              // Every centre in the cell is at least the box's distance away.
              if (dx * dx + dy * dy + dz * dz >= bound2) continue;
              const end = start[c + 1] as number;
              for (let k = start[c] as number; k < end; k += 1) {
                const e = entries[k] as number;
                const src = sources[Math.floor(e / scale)] as StrokeSource;
                const i = e & indexMask;
                const p = src.position;
                const ex = (p[3 * i] as number) - x;
                const ey = (p[3 * i + 1] as number) - y;
                const ez = (p[3 * i + 2] as number) - z;
                const e2 = ex * ex + ey * ey + ez * ez;
                visited += 1;
                if (e2 >= bound2) continue;
                const q2 = quadDistance2(src, i, ex, ey, ez, e2, cap);
                if (q2 < best2) {
                  best2 = q2;
                  best = Math.sqrt(q2);
                }
              }
            }
          }
        }
      }
      field.lastVisited = visited;
      return best2 < reach2 ? best : Infinity;
    },
  };
  return field;
}

/** The gap from `v` to the interval [lo, lo + size], 0 inside it. */
function axisGap(v: number, lo: number, size: number): number {
  return v < lo ? lo - v : v > lo + size ? v - lo - size : 0;
}

/** The chunks' own attribute arrays, which the batch keeps after upload. */
export function chunkSources(
  chunks: readonly Pick<StrokeChunk, 'geometry' | 'count'>[],
): StrokeSource[] {
  return chunks.map((chunk) => ({
    count: chunk.count,
    position: chunk.geometry.getAttribute('iPosition').array,
    normal: chunk.geometry.getAttribute('iNormal').array,
    tangent: chunk.geometry.getAttribute('iTangent').array,
    size: chunk.geometry.getAttribute('iSize').array,
  }));
}

/** `buildStrokeReachSteps` run to the end at once. */
export function buildStrokeReach(
  sources: readonly StrokeSource[],
  options?: StrokeReachOptions,
): StrokeReach {
  return drain(buildStrokeReachSteps(sources, options));
}

/**
 * q² of the offset e (stroke centre minus point, |e|² = e2) from stroke `i`'s capped quad, as
 * reactiveMotion in motion.glsl computes it: octDecode, surfaceBasis and the long and short axes
 * of stroke.vert.glsl, then e² less the parts of e inside the quad along each axis.
 */
function quadDistance2(
  src: StrokeSource,
  i: number,
  ex: number,
  ey: number,
  ez: number,
  e2: number,
  cap: number,
): number {
  // octDecode (instance.ts), from the snorm16 normal as WebGL normalises it.
  const u = Math.max(-1, (src.normal[2 * i] as number) / SNORM16);
  const v = Math.max(-1, (src.normal[2 * i + 1] as number) / SNORM16);
  let nx = u;
  let ny = v;
  const nz0 = 1 - Math.abs(u) - Math.abs(v);
  if (nz0 < 0) {
    nx = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
    ny = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
  }
  const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz0 * nz0);
  nx *= inv;
  ny *= inv;
  const nz = nz0 * inv;
  // surfaceBasis (frame.ts).
  const sign = nz >= 0 ? 1 : -1;
  const a = -1 / (sign + nz);
  const b = nx * ny * a;
  const b1x = 1 + sign * nx * nx * a;
  const b1y = sign * b;
  const b1z = -sign * nx;
  const b2x = b;
  const b2y = sign + ny * ny * a;
  const b2z = -ny;
  const theta = (src.tangent[i] as number) * TWO_PI_OVER_UNORM16;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const lx = c * b1x + s * b2x;
  const ly = c * b1y + s * b2y;
  const lz = c * b1z + s * b2z;
  // The short axis, n × long.
  const sx = ny * lz - nz * ly;
  const sy = nz * lx - nx * lz;
  const sz = nx * ly - ny * lx;
  const hl = Math.min(0.5 * (src.size[2 * i] as number), cap);
  const hw = Math.min(0.5 * (src.size[2 * i + 1] as number), cap);
  const al = Math.abs(ex * lx + ey * ly + ez * lz);
  const as = Math.abs(ex * sx + ey * sy + ez * sz);
  const el = Math.max(al - hl, 0);
  const es = Math.max(as - hw, 0);
  return Math.max(e2 - (al - el) * (al + el) - (as - es) * (as + es), 0);
}
