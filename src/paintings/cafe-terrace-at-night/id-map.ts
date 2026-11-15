/**
 * The painter's id map: for each canvas point, the id of the nearest surface the painter sees
 * there. The paint material projects the scan onto a surface only where the map names it, so paint
 * never lands on what stands behind. Rasterised on the CPU with a depth buffer, so a build needs no
 * renderer and yields the same map everywhere.
 */
import type { Steps } from '../../util/slicer';
import { CAMERA_FORWARD, CAMERA_RIGHT, CAMERA_UP, CANVAS_LENS, PAINTER_EYE } from './canvas';

/** Nearer than this along the optical axis is clipped, metres. */
const NEAR = 0.05;
/** Pixels tested between two yields. */
const SLICE = 60_000;

/**
 * `positions` holds triangles as nine numbers each, and `ids` one id per vertex (a triangle takes
 * its first vertex's). Pixels no triangle covers keep `clear`.
 */
export function* rasterizeIds(
  positions: ArrayLike<number>,
  ids: ArrayLike<number>,
  width: number,
  height: number,
  clear = 0,
): Steps<Uint8Array> {
  const map = new Uint8Array(width * height).fill(clear);
  const nearness = new Float32Array(width * height);
  // Camera space: x right, y up, z the depth along the optical axis.
  const corner = new Float64Array(9);
  const clipped = new Float64Array(12);
  let tested = 0;
  for (let t = 0; t < positions.length / 9; t++) {
    for (let k = 0; k < 3; k++) {
      const x = positions[t * 9 + k * 3] - PAINTER_EYE[0];
      const y = positions[t * 9 + k * 3 + 1] - PAINTER_EYE[1];
      const z = positions[t * 9 + k * 3 + 2] - PAINTER_EYE[2];
      corner[k * 3] = x * CAMERA_RIGHT[0] + y * CAMERA_RIGHT[1] + z * CAMERA_RIGHT[2];
      corner[k * 3 + 1] = x * CAMERA_UP[0] + y * CAMERA_UP[1] + z * CAMERA_UP[2];
      corner[k * 3 + 2] = x * CAMERA_FORWARD[0] + y * CAMERA_FORWARD[1] + z * CAMERA_FORWARD[2];
    }
    let count = 0;
    for (let k = 0; k < 3; k++) {
      const a = k * 3;
      const b = ((k + 1) % 3) * 3;
      const da = corner[a + 2] - NEAR;
      const db = corner[b + 2] - NEAR;
      if (da >= 0) {
        clipped.set(corner.subarray(a, a + 3), count * 3);
        count++;
      }
      if (da >= 0 !== db >= 0) {
        const s = da / (da - db);
        for (let i = 0; i < 3; i++)
          clipped[count * 3 + i] = corner[a + i] + (corner[b + i] - corner[a + i]) * s;
        count++;
      }
    }
    const id = ids[t * 3];
    // Fan the clipped outline: one triangle, or two where the near plane cut a corner off.
    for (let f = 1; f + 1 < count; f++) {
      const px: number[] = [];
      const py: number[] = [];
      const pw: number[] = [];
      for (const k of [0, f, f + 1]) {
        const depth = clipped[k * 3 + 2];
        px.push((0.5 + (clipped[k * 3] / depth) * CANVAS_LENS[0]) * width);
        py.push((0.5 - (clipped[k * 3 + 1] / depth) * CANVAS_LENS[1]) * height);
        pw.push(1 / depth);
      }
      const area = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0]);
      if (Math.abs(area) < 1e-9) continue;
      const minX = Math.max(0, Math.floor(Math.min(px[0], px[1], px[2])));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(px[0], px[1], px[2])));
      const minY = Math.max(0, Math.floor(Math.min(py[0], py[1], py[2])));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(py[0], py[1], py[2])));
      for (let row = minY; row <= maxY; row++) {
        const y = row + 0.5;
        for (let col = minX; col <= maxX; col++) {
          const x = col + 0.5;
          const w0 = ((px[1] - x) * (py[2] - y) - (px[2] - x) * (py[1] - y)) / area;
          const w1 = ((px[2] - x) * (py[0] - y) - (px[0] - x) * (py[2] - y)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const near = w0 * pw[0] + w1 * pw[1] + w2 * pw[2];
          const index = row * width + col;
          if (near > nearness[index]) {
            nearness[index] = near;
            map[index] = id;
          }
        }
        tested += maxX - minX + 1;
        if (tested >= SLICE) {
          tested = 0;
          yield;
        }
      }
    }
  }
  return map;
}
