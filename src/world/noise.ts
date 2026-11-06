import { mulberry32 } from '../util/prng';

export type Noise2D = (x: number, y: number) => number;

const TABLE = 256;

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Seeded 2D value noise on an integer lattice, quintic-interpolated. Output lies in [-1, 1] and has
 * a continuous first derivative. Pure: the same seed gives the same function.
 */
export function createValueNoise2D(seed: number): Noise2D {
  const rand = mulberry32(seed);
  const values = new Float64Array(TABLE);
  for (let i = 0; i < TABLE; i++) values[i] = rand() * 2 - 1;
  const perm = new Uint8Array(TABLE);
  for (let i = 0; i < TABLE; i++) perm[i] = i;
  for (let i = TABLE - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = perm[i] as number;
    perm[i] = perm[j] as number;
    perm[j] = t;
  }
  const lattice = (ix: number, iy: number): number =>
    values[(perm[(ix + (perm[iy & 255] as number)) & 255] as number) & 255] as number;

  return (x, y) => {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const tx = fade(x - fx);
    const ty = fade(y - fy);
    const a = lattice(fx, fy);
    const b = lattice(fx + 1, fy);
    const c = lattice(fx, fy + 1);
    const d = lattice(fx + 1, fy + 1);
    const top = a + (b - a) * tx;
    const bottom = c + (d - c) * tx;
    return top + (bottom - top) * ty;
  };
}

/**
 * Fractal Brownian motion over `noise`: `octaves` layers, each `lacunarity` times finer and `gain`
 * times weaker. Normalised by the summed amplitude, so the output stays within [-1, 1].
 */
export function fbm2(
  noise: Noise2D,
  x: number,
  y: number,
  octaves: number,
  lacunarity: number = 2,
  gain: number = 0.5,
): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    // The per-octave offset keeps the lattice origins from aligning across octaves.
    sum += amp * noise(x * freq + o * 17.3, y * freq - o * 31.7);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}
