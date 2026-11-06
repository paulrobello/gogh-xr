/**
 * The stroke-flicker probe's pixel diff (`scripts/zfight-probe.ts`): the share of pixels whose
 * colour changes between two captures of the same view, over the whole frame and per screen third.
 * Pure maths over 8-bit RGB arrays, 3 bytes per pixel, row-major from the top-left.
 */

/** A pixel flips when its summed absolute R, G and B change exceeds this. */
export const FLIP_THRESHOLD = 24;

export interface FlipPercent {
  /** Flipped pixels as a percentage of the frame. */
  readonly all: number;
  /** Flipped pixels as a percentage of each third's own pixels; row y is in third floor(3y / h). */
  readonly top: number;
  readonly mid: number;
  readonly bottom: number;
}

export function flipPercent(
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): FlipPercent {
  const size = width * height * 3;
  if (a.length !== size || b.length !== size) {
    throw new RangeError(`flipPercent: buffers must hold ${size} bytes for ${width}x${height}`);
  }
  const flipped = [0, 0, 0];
  const pixels = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    const third = Math.min(2, Math.floor((3 * y) / height));
    pixels[third] += width;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const d =
        Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > FLIP_THRESHOLD) flipped[third]++;
    }
  }
  const pct = (n: number, of: number): number => (of === 0 ? 0 : (100 * n) / of);
  return {
    all: pct(flipped[0] + flipped[1] + flipped[2], width * height),
    top: pct(flipped[0], pixels[0]),
    mid: pct(flipped[1], pixels[1]),
    bottom: pct(flipped[2], pixels[2]),
  };
}
