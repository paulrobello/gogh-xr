import type { Vec3 } from '../render/strokes/frame';
import type { VolumeQuery } from './teleport';

const CONTACT_STEPS = 12;

type Position = [number, number, number];

/** Fraction of a segment that stays outside the solid. Reuse the teleport sweep to catch thin
 * walls even when both ends are outside. A placed pose inside a solid can still leave it. */
function travel(volumes: VolumeQuery, from: Vec3, dx: number, dy: number, dz: number): number {
  if (dx === 0 && dy === 0 && dz === 0) return 1;
  const [x, y, z] = from;
  volumes.begin(x, y, z);
  if (volumes.crossing(x, y, z, x + dx, y + dy, z + dz) < 0) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < CONTACT_STEPS; i += 1) {
    const mid = (low + high) / 2;
    if (volumes.crossing(x, y, z, x + dx * mid, y + dy * mid, z + dz * mid) < 0) low = mid;
    else high = mid;
  }
  return low;
}

/** Stop at first contact and use the remaining movement along any clear axes. */
export function constrainSolidMovement(volumes: VolumeQuery, from: Vec3, to: Position): void {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const fraction = travel(volumes, from, dx, dy, dz);
  if (fraction === 1) return;
  const remaining = 1 - fraction;
  to[0] = from[0] + dx * fraction;
  to[1] = from[1] + dy * fraction;
  to[2] = from[2] + dz * fraction;
  to[0] += dx * remaining * travel(volumes, to, dx * remaining, 0, 0);
  to[2] += dz * remaining * travel(volumes, to, 0, 0, dz * remaining);
  to[1] += dy * remaining * travel(volumes, to, 0, dy * remaining, 0);
}
