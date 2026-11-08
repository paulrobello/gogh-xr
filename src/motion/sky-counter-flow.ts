/**
 * The sky wrap's local counter-flow (src/motion/variants.ts, docs/verification.md): the share of
 * nearby sky stroke pairs whose velocities along their swirl arc have opposite signs, one stroke on
 * its way forward and the other on its way back. Under `pingpong` each stroke's phase byte sets its
 * loop, so about half of all pairs counter-flow. Under `wave` neighbours share a loop phase, so only
 * pairs that straddle a band edge do. `base` only ever moves forward, so it never counter-flows.
 *
 * Nearby is a centre separation, as seen from PAINTER_EYE, within SKY_COUNTER_FLOW_RADIUS. Each
 * stroke moves along its own `omega × d`, so the sign of its velocity along its arc is the sign of
 * its tau's rate, which is `returning` (skyWrapLoop).
 */

/** Nearby, for the counter-flow: 2° between centres from the eye, under one sky stroke's length. */
export const SKY_COUNTER_FLOW_RADIUS: number = (2 * Math.PI) / 180;

export interface SkyCounterFlow {
  /** Nearby (centre, neighbour) pairs counted. */
  readonly pairs: number;
  /** Of those, the pairs with one stroke forward and the other returning. */
  readonly opposed: number;
  /** opposed / pairs, 0 with no pairs. */
  readonly share: number;
}

/** A spatial hash of unit directions in cubes of the counter-flow radius, built once per stroke set. */
export interface SkyDirectionHash {
  /** The directions, xyz per stroke. */
  readonly directions: Float32Array;
  readonly radius: number;
  /** The strokes in each occupied cube. */
  readonly cells: ReadonlyMap<number, readonly number[]>;
}

const CELL_SPAN = 1024;
const cellKey = (x: number, y: number, z: number): number =>
  ((x + CELL_SPAN / 2) * CELL_SPAN + (y + CELL_SPAN / 2)) * CELL_SPAN + (z + CELL_SPAN / 2);

/**
 * Hashes `directions` (unit xyz per stroke) in cubes `radius` wide. A radius below 2 / CELL_SPAN
 * would overflow the key, so it is clamped there.
 */
export function hashSkyDirections(
  directions: Float32Array,
  radius: number = SKY_COUNTER_FLOW_RADIUS,
): SkyDirectionHash {
  const cell = Math.max(radius, 2 / CELL_SPAN);
  const cells = new Map<number, number[]>();
  for (let i = 0; i < directions.length / 3; i++) {
    const key = cellKey(
      Math.floor(directions[3 * i] / cell),
      Math.floor(directions[3 * i + 1] / cell),
      Math.floor(directions[3 * i + 2] / cell),
    );
    let list = cells.get(key);
    if (!list) {
      list = [];
      cells.set(key, list);
    }
    list.push(i);
  }
  return { directions, radius: cell, cells };
}

/**
 * The counter-flow of the strokes in `hash`, given each stroke's direction of travel along its arc:
 * `returning[i]` is 1 on the way back, 0 forward, and any other value leaves the stroke out (not
 * drawn). Every pair of a centre stroke and another stroke within the hash's radius (as a chord of
 * the unit sphere) counts, so a pair of two centres counts twice, which leaves the share unchanged.
 * `centres` lists the centre strokes (every stroke when omitted), so a caller can sample a large set.
 */
export function skyCounterFlow(
  hash: SkyDirectionHash,
  returning: Uint8Array,
  centres?: ArrayLike<number>,
): SkyCounterFlow {
  const { directions: dir, radius, cells } = hash;
  const r2 = radius * radius;
  const count = centres ? centres.length : dir.length / 3;
  let pairs = 0;
  let opposed = 0;
  for (let k = 0; k < count; k++) {
    const i = centres ? centres[k] : k;
    if (returning[i] > 1) continue;
    const x = dir[3 * i];
    const y = dir[3 * i + 1];
    const z = dir[3 * i + 2];
    const cx = Math.floor(x / radius);
    const cy = Math.floor(y / radius);
    const cz = Math.floor(z / radius);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          const list = cells.get(cellKey(cx + a, cy + b, cz + c));
          if (!list) continue;
          for (const j of list) {
            if (j === i || returning[j] > 1) continue;
            const dx = dir[3 * j] - x;
            const dy = dir[3 * j + 1] - y;
            const dz = dir[3 * j + 2] - z;
            if (dx * dx + dy * dy + dz * dz >= r2) continue;
            pairs++;
            if (returning[i] !== returning[j]) opposed++;
          }
        }
      }
    }
  }
  return { pairs, opposed, share: pairs > 0 ? opposed / pairs : 0 };
}
