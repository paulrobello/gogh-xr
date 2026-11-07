/**
 * The gallery's interior palette (P5.4), sampled from the seven scans and muted so the room never
 * competes with them: each role mixes a few source tones, desaturated toward their luma and
 * darkened. The samples are the mean sRGB of a uv rect of one scan's `frame.webp`;
 * tests/gallery-palette.test.ts re-derives every one from the files, so the constants cannot drift
 * from the scans. Nothing is decoded at runtime.
 */

export type Rgb = readonly [number, number, number];

export interface PaletteSample {
  readonly painting: string;
  /** [u0, v0, u1, v1] of the scan, v down from the top row. */
  readonly rect: readonly [number, number, number, number];
  /** Mean sRGB over the rect, rounded. */
  readonly rgb: Rgb;
}

export const PALETTE_SAMPLES = Object.freeze({
  starrySky: { painting: 'starry-night', rect: [0.3, 0.05, 0.7, 0.3], rgb: [78, 98, 134] },
  rhoneSky: {
    painting: 'starry-night-over-the-rhone',
    rect: [0.1, 0.02, 0.9, 0.35],
    rgb: [55, 101, 134],
  },
  chestnutLeaves: {
    painting: 'chestnut-trees-in-blossom',
    rect: [0.05, 0.1, 0.5, 0.5],
    rgb: [62, 111, 98],
  },
  bedroomFloor: { painting: 'bedroom', rect: [0.15, 0.85, 0.6, 0.99], rgb: [137, 109, 65] },
  bedroomBed: { painting: 'bedroom', rect: [0.55, 0.45, 0.75, 0.6], rgb: [157, 119, 12] },
  alyscampsPath: { painting: 'les-alyscamps', rect: [0.2, 0.8, 0.8, 0.98], rgb: [175, 121, 37] },
  wheat: { painting: 'wheatfield-with-crows', rect: [0.05, 0.55, 0.95, 0.95], rgb: [144, 120, 39] },
  wheatfieldSky: {
    painting: 'wheatfield-with-crows',
    rect: [0.05, 0.02, 0.95, 0.3],
    rgb: [47, 85, 129],
  },
  cafeSky: { painting: 'cafe-terrace-at-night', rect: [0.55, 0.02, 0.95, 0.3], rgb: [28, 63, 97] },
} as const satisfies Record<string, PaletteSample>);

export type SampleName = keyof typeof PALETTE_SAMPLES;

/**
 * Each scan's median luma (`luma` of its frame.webp pixels), so the wash beside a dark painting stays
 * under it. tests/gallery-palette.test.ts re-derives every one from the files.
 */
export const SCAN_MEDIAN_LUMA: Readonly<Record<string, number>> = Object.freeze({
  'starry-night': 88,
  'chestnut-trees-in-blossom': 118,
  'les-alyscamps': 122,
  'cafe-terrace-at-night': 86,
  bedroom: 125,
  'wheatfield-with-crows': 109,
  'starry-night-over-the-rhone': 76,
});

/** sRGB luma, Rec. 709 weights on the encoded values: a cheap grey to desaturate toward. */
export function luma(rgb: Rgb): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** `rgb` with its chroma scaled by `saturation` about its luma, then scaled by `value`. */
export function mute(rgb: Rgb, saturation: number, value: number): Rgb {
  const grey = luma(rgb);
  const out = rgb.map((c) => Math.min(255, Math.max(0, (grey + (c - grey) * saturation) * value)));
  return [out[0], out[1], out[2]];
}

export type SurfaceRole = 'wall' | 'floor' | 'ceiling' | 'bench' | 'moulding';

interface RoleMix {
  readonly sources: readonly SampleName[];
  readonly saturation: number;
  readonly value: number;
}

/**
 * Each role's source tones and its muting. The walls are a deep slate from the night skies and the
 * chestnut leaves, the floor a dark umber from the Bedroom's boards and the Alyscamps path, the
 * ceiling the darkest night blue, the benches a darker umber and the mouldings an old gold from the
 * wheat: every one well under the scans' own brightness.
 */
const ROLE_MIX: Readonly<Record<SurfaceRole, RoleMix>> = Object.freeze({
  wall: { sources: ['starrySky', 'rhoneSky', 'chestnutLeaves'], saturation: 0.5, value: 0.56 },
  floor: { sources: ['bedroomFloor', 'alyscampsPath', 'bedroomBed'], saturation: 0.5, value: 0.42 },
  ceiling: { sources: ['cafeSky', 'wheatfieldSky', 'starrySky'], saturation: 0.4, value: 0.5 },
  bench: {
    sources: ['bedroomBed', 'alyscampsPath', 'bedroomFloor'],
    saturation: 0.45,
    value: 0.34,
  },
  moulding: { sources: ['wheat', 'bedroomBed', 'alyscampsPath'], saturation: 0.6, value: 0.62 },
});

/** Each role's muted tones, one per source: a stroke picks one and jitters it. */
export const ROLE_TONES: Readonly<Record<SurfaceRole, readonly Rgb[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ROLE_MIX).map(([role, mix]) => [
      role,
      mix.sources.map((name) => mute(PALETTE_SAMPLES[name].rgb, mix.saturation, mix.value)),
    ]),
  ) as unknown as Record<SurfaceRole, readonly Rgb[]>,
);

/** A role's under-paint: the mean of its tones, so a gap between strokes reads as the surface. */
export function underpaint(role: SurfaceRole): Rgb {
  const tones = ROLE_TONES[role];
  const sum = tones.reduce((a, t) => [a[0] + t[0], a[1] + t[1], a[2] + t[2]], [0, 0, 0]);
  return [sum[0] / tones.length, sum[1] / tones.length, sum[2] / tones.length];
}

/** Plaque colours. The card is a darker wall slate; the text is a warm off-white and its muted
 * second tone; the "Coming soon" line takes the wheat's gold, brightened. */
export const PLAQUE_COLORS = Object.freeze({
  card: mute(PALETTE_SAMPLES.starrySky.rgb, 0.35, 0.3),
  title: [236, 230, 216] as Rgb,
  detail: [190, 184, 170] as Rgb,
  accent: mute(PALETTE_SAMPLES.wheat.rgb, 0.85, 1.5),
});
