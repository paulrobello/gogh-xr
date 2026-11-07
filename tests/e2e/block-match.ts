/**
 * Block matching over captured frames at CAPTURE_SIZE (motion.spec.ts, reactive.spec.ts): the luma
 * of a raw capture, and the sub-pixel shift that best maps a rest patch onto a moved frame.
 */
import { CAPTURE_SIZE } from '../../scripts/fidelity-io.ts';

export function luma(raw: Buffer): Float32Array {
  const { width, height } = CAPTURE_SIZE;
  const channels = raw.length / (width * height);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const k = i * channels;
    out[i] = 0.2126 * raw[k] + 0.7152 * raw[k + 1] + 0.0722 * raw[k + 2];
  }
  return out;
}

/**
 * The shift s, pixels, that best maps the rest patch at (cx, cy) onto the moved image: the
 * least squared difference of rest(x) against moved(x + s) over the (2 half + 1)² patch and integer
 * shifts up to `search`, refined to a
 * sub-pixel by a parabola through the neighbours. `sharpness` is the median error over the best:
 * a clear match reads well above 1.
 */
export function shiftAt(
  rest: Float32Array,
  moved: Float32Array,
  cx: number,
  cy: number,
  half: number,
  search: number,
): { dx: number; dy: number; sharpness: number } {
  const { width } = CAPTURE_SIZE;
  const side = 2 * search + 1;
  const error = new Float64Array(side * side);
  for (let sy = -search; sy <= search; sy++) {
    for (let sx = -search; sx <= search; sx++) {
      let sum = 0;
      for (let y = cy - half; y <= cy + half; y++) {
        const a = y * width;
        const b = (y + sy) * width + sx;
        for (let x = cx - half; x <= cx + half; x++) {
          const d = rest[a + x] - moved[b + x];
          sum += d * d;
        }
      }
      error[(sy + search) * side + sx + search] = sum;
    }
  }
  let best = 0;
  for (let i = 1; i < error.length; i++) if (error[i] < error[best]) best = i;
  const bx = best % side;
  const by = Math.floor(best / side);
  const at = (x: number, y: number): number => error[y * side + x];
  const refine = (m: number, z: number, p: number): number => {
    const curve = m - 2 * z + p;
    return curve > 0 ? (0.5 * (m - p)) / curve : 0;
  };
  const fx = bx > 0 && bx < side - 1 ? refine(at(bx - 1, by), at(bx, by), at(bx + 1, by)) : 0;
  const fy = by > 0 && by < side - 1 ? refine(at(bx, by - 1), at(bx, by), at(bx, by + 1)) : 0;
  const sorted = Float64Array.from(error).sort();
  return {
    dx: bx - search + fx,
    dy: by - search + fy,
    sharpness: sorted[sorted.length >> 1] / Math.max(error[best], 1e-9),
  };
}
