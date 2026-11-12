/**
 * Low-resolution coverage masks of the default-seed brushes, for CPU-side coverage checks (the
 * window hole fill in scatter.ts). Building the full atlas costs about 200 ms, so the masks are
 * committed: `bun scripts/brush-masks.ts` regenerates BRUSH_MASK_DATA from
 * `generateBrushAtlas(DEFAULT_BRUSH_SEED)`, and tests/brush-masks.test.ts checks it still matches.
 *
 * Each brush's texel rect (`brushTexelRect`) is split into BRUSH_MASK_SIZE × BRUSH_MASK_SIZE cells,
 * and a cell is covered only when every atlas texel it touches has coverage at least
 * BRUSH_MASK_THRESHOLD. So a point a mask calls covered is covered in the full atlas.
 */
import { ATLAS_SIZE, BRUSH_CHANNEL, BRUSH_COUNT, brushTexelRect } from './brush-atlas-data';

export const BRUSH_MASK_SIZE = 32;
export const BRUSH_MASK_THRESHOLD = 128;

/** BRUSH_COUNT masks of BRUSH_MASK_SIZE² bits, row-major (v then u), base64. */
export const BRUSH_MASK_DATA =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8P8AAPD/BwD4//8A+P//A/j//wf8//8P/P//H/z//x/8//8//P//P/z//z/8//8//P//H/z//x/8//8P/P//B/j//wP4/w8A+P8AAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAADgBwAA4H8AAPD//wPw//8H8P//B/D//w/w//8P+P//D/j//x/4//8f+P//H/j//w/w//8P8P//D/D//w/w//8H8P//A/D//wHg/x8A4P8DAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAADwAQAA+D8AAPj/gwD4//8H/P//D/z//x/8//8f/P//P/z//z/8//8//P//P/z//x/8//8f/P//D/j//w/4//8D+P8/APD/AQAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAPA/AAD4/x8A+P//APz//wP8//8H/P//D/z//x/8//8//P//P/z//z/8//8//P//H/z//w/8//8H/P//A/j/AQD4BwAA8AAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4QAAA+P8/HPj//w/4//8P+P//D/j//w/4//8P+P//D/j//w/4//8P+P//H/j//w/8//8H+P//B/j//wf4//8P+P//D/j//x/4//8f+D8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAPj//wD4//8B/P//Afz//wH8//8H+P//B/j/fwD4/38A+P9/APz//wD8//8A/P//APj//wD4//8B+P//D/j//w/8//8B+P//Afj//wP4HwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwAQAA8P//B/j//wf4//8H+P//D/j//w/4//8D+P//AfD//wHw//8D8P//A/D//wfw//8P8P//A/D//wDw//8A8P//APD//wP4//8H8P//D/D//w/w/zkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPABAADw//8D8P//A/D//wH4//8B+P//Afj//w/4//8P+P//B/j//wf4//8D+P//A/j//wP4//8f+P//H/j//x/4//8P+P//B/D//wPw//8B8P//AYD/OwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAD4HwAA/j8AAP5/AAD//wCA//8AgP//AcD//wHA//8DwP//A8D//wPA//8DwP//A8D//wPA//8DgP//AYD//wEA//8AAP9/AAD+HwAA8A8AACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOABAAD8BwAA/h8AAP9/AID//wCA//8BwP//AcD//wPA//8DwP//A8D//wPA//8DwP//A8D//wOA//8BgP//AAD//wAA/38AAP4fAAD8BwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAMgDAAD8DwAA/j8AAP9/AAD//wCA//8BgP//AYD//wHA//8DwP//A4D//wGA//8BgP//AQD//wAA/38AAP5/AAD8PwAA+B8AAIADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAA+AEAAP4PBwD//wcA//8DgP//A8D//wHA//8B4P//AOD/fwDg/z8A4P8fAOD/DwCA/wEAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP4AAMD/BwDg/x8A4P8/APD/fwDw//8A4P//AeD//wPA//8DwP//B4D//wcA/gEEAHwAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAP4BCAD/Bw+A//8HwP//B+D//wPg//8D8P//AfD//wDw/38A8P8/AOD/HwDA/w8AAP8DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAADvg/8B/4//8f+P//H/j//x/w//8P8P//D/D//w/g//8HwP//A8D//wOA//8BAP//AAD+PwAA+A8AAOADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAEAAOAPAAD8PwAA/n8AgP//AID//wHA//8D4P//B+D//wfw//8P8P//D/D//w/4//8f+P//H/D//w9gAIAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** The masks as bits from atlas RGBA data (ATLAS_SIZE², `BRUSH_CHANNEL.coverage`). */
export function buildBrushMasks(atlas: Uint8Array): Uint8Array {
  const n = BRUSH_MASK_SIZE;
  const bits = new Uint8Array((BRUSH_COUNT * n * n) / 8);
  for (let b = 0; b < BRUSH_COUNT; b++) {
    const rect = brushTexelRect(b);
    for (let j = 0; j < n; j++) {
      const y0 = Math.floor((j * rect.height) / n);
      const y1 = Math.ceil(((j + 1) * rect.height) / n);
      for (let i = 0; i < n; i++) {
        const x0 = Math.floor((i * rect.width) / n);
        const x1 = Math.ceil(((i + 1) * rect.width) / n);
        let covered = true;
        for (let y = y0; y < y1 && covered; y++) {
          for (let x = x0; x < x1; x++) {
            const at = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4 + BRUSH_CHANNEL.coverage;
            if (atlas[at] < BRUSH_MASK_THRESHOLD) {
              covered = false;
              break;
            }
          }
        }
        if (covered) {
          const bit = (b * n + j) * n + i;
          bits[bit >> 3] |= 1 << (bit & 7);
        }
      }
    }
  }
  return bits;
}

export function encodeBrushMasks(bits: Uint8Array): string {
  let s = '';
  for (const byte of bits) s += String.fromCharCode(byte);
  return btoa(s);
}

let decoded: Uint8Array | null = null;

function masks(): Uint8Array {
  if (!decoded) {
    const raw = atob(BRUSH_MASK_DATA);
    decoded = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) decoded[i] = raw.charCodeAt(i);
  }
  return decoded;
}

/** Whether brush `brush` covers quad uv (u, v), each in [0, 1), by its conservative mask. */
export function brushMaskCovered(brush: number, u: number, v: number): boolean {
  if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return false;
  const n = BRUSH_MASK_SIZE;
  const bit = (brush * n + Math.floor(v * n)) * n + Math.floor(u * n);
  return (masks()[bit >> 3] & (1 << (bit & 7))) !== 0;
}
