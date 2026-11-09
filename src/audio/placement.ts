/**
 * Where the positional cues sit (plans/phase-6-audio.md). Starry Night's anchors are the seed-1
 * generator output (tests/audio-placement.test.ts re-derives them from `createVillage` and
 * `createCypress`): the church and cypress are fitted to the painted apexes, so other seeds move
 * the steeple by about 2 m and leave the cypress's axis within 0.3 m. The crickets' heights come
 * from the built world's ground at bind time. The gallery has no positional beds.
 */
import type { WorldGround } from '../paintings/world-module';
import type { CueId } from './cues';

export type Vec3 = readonly [number, number, number];

/** Seed-1 spire tip of the church (`ChurchRecord.steepleTip`). */
export const STEEPLE_TIP: Vec3 = Object.freeze([3.66, 5.2, -37.32]) as Vec3;
/** The bell hangs this far below the spire tip, in the tower top. */
export const BELL_BELOW_TIP = 3;
/** Seed-1 base and tip of the main cypress mass (`CypressMass.base`, `.tip`). */
export const CYPRESS_BASE: Vec3 = Object.freeze([-2.99, -5.19, -9.35]) as Vec3;
export const CYPRESS_TIP: Vec3 = Object.freeze([-4.68, 9.42, -8.84]) as Vec3;
/** Seed-1 half of the main mass's widest ring (`CypressMass.maxDiameter / 2`), rounded up. */
export const CYPRESS_RADIUS = 1.47;
/** Seed-1 base, tip and half widest ring of the lower cypress mass, rounded up. */
export const CYPRESS_LOWER_BASE: Vec3 = Object.freeze([-1.5, -5.34, -9.86]) as Vec3;
export const CYPRESS_LOWER_TIP: Vec3 = Object.freeze([-2.99, 2.93, -9.54]) as Vec3;
export const CYPRESS_LOWER_RADIUS = 1.35;
/** The wind sits this far up the cypress axis, base 0 to tip 1: the hillside crown of the tree. */
export const WIND_AXIS_T = 0.5;
/** Cricket sources on the grass, world xz: around the painter's hill, short of the village. */
export const CRICKET_XZ: readonly (readonly [number, number])[] = Object.freeze([
  [-12, -7],
  [10, -6],
  [-5, 9],
  [8, 11],
  [-16, 3],
]);
/** Cricket height above the ground, metres. */
export const CRICKET_HEIGHT = 0.15;

/** A looped positional bed. */
export interface BedSpec {
  readonly cue: CueId;
  readonly position: Vec3;
}

/** A world's positional ambience: its looped beds and the bell's position, if it has one. */
export interface Ambience {
  readonly beds: readonly BedSpec[];
  readonly bell: Vec3 | null;
}

export function bellPosition(): Vec3 {
  return [STEEPLE_TIP[0], STEEPLE_TIP[1] - BELL_BELOW_TIP, STEEPLE_TIP[2]];
}

export function windPosition(): Vec3 {
  const t = WIND_AXIS_T;
  return [
    CYPRESS_BASE[0] + (CYPRESS_TIP[0] - CYPRESS_BASE[0]) * t,
    CYPRESS_BASE[1] + (CYPRESS_TIP[1] - CYPRESS_BASE[1]) * t,
    CYPRESS_BASE[2] + (CYPRESS_TIP[2] - CYPRESS_BASE[2]) * t,
  ];
}

/** The ambience of world `worldId` on its built `ground`; null for a world without one. */
export function ambienceFor(
  worldId: string | null,
  ground: Pick<WorldGround, 'heightAt'>,
): Ambience | null {
  if (worldId !== 'starry-night') return null;
  const beds: BedSpec[] = [{ cue: 'wind-hill', position: windPosition() }];
  for (const [x, z] of CRICKET_XZ) {
    beds.push({ cue: 'crickets', position: [x, ground.heightAt(x, z) + CRICKET_HEIGHT, z] });
  }
  return { beds, bell: bellPosition() };
}

/** A stroke mass the rustle tests against: points within `radius` of the segment `a`–`b`. */
export interface Capsule {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly radius: number;
}

/** The free-standing stroke masses of world `worldId` that its ground and walls do not cover. */
export function strokeMassesFor(worldId: string | null): readonly Capsule[] {
  if (worldId !== 'starry-night') return [];
  return [
    { a: CYPRESS_BASE, b: CYPRESS_TIP, radius: CYPRESS_RADIUS },
    { a: CYPRESS_LOWER_BASE, b: CYPRESS_LOWER_TIP, radius: CYPRESS_LOWER_RADIUS },
  ];
}
