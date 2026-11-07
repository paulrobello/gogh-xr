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

export interface TemporalFlicker {
  /** Pixels that change by more than FLIP_THRESHOLD between any two consecutive frames, % of frame. */
  readonly flicker: number;
  /** Mean share of the frame that changes between consecutive frames, %. */
  readonly perFrame: number;
  /**
   * Flickering pixels with at least 4 of their 8 neighbours flickering too, % of frame: a depth
   * fight flips patches, edge parallax 1 px lines.
   */
  readonly clustered: number;
}

/**
 * Per-pixel temporal flicker over a sequence of captures of one view (the shimmer probe,
 * `scripts/shimmer-probe.ts`). Same layout as `flipPercent`: 8-bit RGB, 3 bytes per pixel.
 */
export function temporalFlicker(
  frames: readonly (Uint8Array | Uint8ClampedArray)[],
  width: number,
  height: number,
): TemporalFlicker {
  const size = width * height * 3;
  if (frames.length < 2) throw new RangeError('temporalFlicker: needs at least two frames');
  for (const f of frames) {
    if (f.length !== size) {
      throw new RangeError(
        `temporalFlicker: buffers must hold ${size} bytes for ${width}x${height}`,
      );
    }
  }
  const pixels = width * height;
  const mask = new Uint8Array(pixels);
  let changes = 0;
  for (let k = 1; k < frames.length; k++) {
    const a = frames[k - 1];
    const b = frames[k];
    for (let p = 0; p < pixels; p++) {
      const i = p * 3;
      const d =
        Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > FLIP_THRESHOLD) {
        changes++;
        mask[p] = 1;
      }
    }
  }
  let flicker = 0;
  let clustered = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      flicker++;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height && mask[yy * width + xx]) n++;
        }
      }
      if (n >= 4) clustered++;
    }
  }
  return {
    flicker: (100 * flicker) / pixels,
    perFrame: (100 * changes) / (pixels * (frames.length - 1)),
    clustered: (100 * clustered) / pixels,
  };
}
