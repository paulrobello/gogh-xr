/**
 * 8-bit sRGB to CIELAB (D65) and the CIEDE2000 colour difference, shared by the scatter's region
 * palette check (src/paintings/starry-night/canvas-histogram.ts) and the fidelity metric
 * (scripts/fidelity-lib.ts).
 */

export type Lab = readonly [number, number, number];

/** sRGB (IEC 61966-2-1) linear RGB to XYZ, D65. */
const M = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
] as const;
/** The D65 white as the matrix maps linear (1, 1, 1), so sRGB white is exactly L* 100, a* b* 0. */
const WHITE = M.map((row) => row[0] + row[1] + row[2]);

/** Decodes one 8-bit sRGB channel to linear light in [0, 1]. */
export function srgbToLinear(value8: number): number {
  const c = value8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** `srgbToLinear` of every 8-bit value. */
export const SRGB8_LINEAR: Float64Array = Float64Array.from({ length: 256 }, (_, i) =>
  srgbToLinear(i),
);

function labF(t: number): number {
  const e = 216 / 24389;
  return t > e ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116;
}

/** Linear-light sRGB in [0, 1] to CIELAB, D65. */
export function linearToLab(r: number, g: number, b: number): Lab {
  const fx = labF((M[0][0] * r + M[0][1] * g + M[0][2] * b) / WHITE[0]);
  const fy = labF((M[1][0] * r + M[1][1] * g + M[1][2] * b) / WHITE[1]);
  const fz = labF((M[2][0] * r + M[2][1] * g + M[2][2] * b) / WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Integer 8-bit sRGB channels to CIELAB. A fractional channel reads NaN: round first. */
export function srgb8ToLab(r: number, g: number, b: number): Lab {
  return linearToLab(SRGB8_LINEAR[r], SRGB8_LINEAR[g], SRGB8_LINEAR[b]);
}

const DEG = Math.PI / 180;

function hueDeg(b: number, a: number): number {
  if (a === 0 && b === 0) return 0;
  const h = Math.atan2(b, a) / DEG;
  return h < 0 ? h + 360 : h;
}

/** CIEDE2000 colour difference, kL = kC = kH = 1 (Sharma, Wu and Dalal 2005). */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [l1, a1, b1] = lab1;
  const [l2, a2, b2] = lab2;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const cBar7 = cBar ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);
  const hp1 = hueDeg(b1, ap1);
  const hp2 = hueDeg(b2, ap2);

  const dL = l2 - l1;
  const dC = cp2 - cp1;
  const chromaProduct = cp1 * cp2;
  let dh = 0;
  if (chromaProduct !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(chromaProduct) * Math.sin((dh / 2) * DEG);

  const lBar = (l1 + l2) / 2;
  const cpBar = (cp1 + cp2) / 2;
  let hBar = hp1 + hp2;
  if (chromaProduct !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hBar /= 2;
    else hBar = hBar < 360 ? (hBar + 360) / 2 : (hBar - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * DEG) +
    0.24 * Math.cos(2 * hBar * DEG) +
    0.32 * Math.cos((3 * hBar + 6) * DEG) -
    0.2 * Math.cos((4 * hBar - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const cpBar7 = cpBar ** 7;
  const rC = 2 * Math.sqrt(cpBar7 / (cpBar7 + 25 ** 7));
  const lBar50 = (lBar - 50) ** 2;
  const sL = 1 + (0.015 * lBar50) / Math.sqrt(20 + lBar50);
  const sC = 1 + 0.045 * cpBar;
  const sH = 1 + 0.015 * cpBar * t;
  const rT = -Math.sin(2 * dTheta * DEG) * rC;
  const kl = dL / sL;
  const kc = dC / sC;
  const kh = dH / sH;
  return Math.sqrt(kl * kl + kc * kc + kh * kh + rT * kc * kh);
}
