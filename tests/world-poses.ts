/**
 * The 24 Starry Night coverage poses (P2-A3), shared by the e2e coverage sweep and the unit budget
 * and pose checks. Eye positions are absolute world metres; ground poses stand 1.6 m above
 * `createTerrain(1).heightAt`, which tests/world-starry-night.test.ts checks. Yaw 0 faces -Z and
 * positive yaw turns left; pitch is up positive, ±π/2 straight up and down.
 */
export interface CoveragePose {
  readonly name: string;
  readonly position: readonly [number, number, number];
  readonly yaw: number;
  readonly pitch: number;
}

const HALF_PI = Math.PI / 2;

export const COVERAGE_POSES: readonly CoveragePose[] = Object.freeze([
  { name: 'spot ahead', position: [0, 1.6, 0], yaw: 0, pitch: 0 },
  { name: 'spot behind', position: [0, 1.6, 0], yaw: Math.PI, pitch: 0 },
  { name: 'spot left, raised', position: [0, 1.6, 0], yaw: HALF_PI, pitch: 0.25 },
  { name: 'spot right, lowered', position: [0, 1.6, 0], yaw: -HALF_PI, pitch: -0.2 },
  { name: 'spot straight down', position: [0, 1.6, 0], yaw: 0, pitch: -HALF_PI },
  { name: 'spot straight up', position: [0, 1.6, 0], yaw: 0, pitch: HALF_PI },
  { name: 'hill west', position: [-3, 1.02, 2], yaw: -HALF_PI, pitch: -0.15 },
  { name: 'hill east', position: [4, -0.21, 4], yaw: 0.75 * Math.PI, pitch: 0 },
  { name: 'hill slope', position: [2, -2.54, -8], yaw: 0, pitch: -0.3 },
  { name: 'under the cypress', position: [-6, -2.03, -5], yaw: -0.56, pitch: 0.4 },
  { name: 'hill bowl behind', position: [0, -3.39, 12], yaw: 0, pitch: 0.05 },
  { name: 'village street', position: [1, -3.25, -19], yaw: 0, pitch: 0 },
  { name: 'village west', position: [1, -2.97, -26], yaw: HALF_PI, pitch: 0.1 },
  { name: 'village church', position: [2, -2.49, -33], yaw: 0, pitch: 0.35 },
  { name: 'village uphill', position: [0, -2.81, -28], yaw: Math.PI, pitch: 0.1 },
  { name: 'village down', position: [1, -3.14, -22], yaw: 0, pitch: -HALF_PI },
  { name: 'boundary north', position: [0, -3.61, -44], yaw: 0, pitch: 0 },
  { name: 'boundary north-west', position: [-30, -2.88, -30], yaw: Math.PI / 4, pitch: 0 },
  { name: 'boundary north-east', position: [32, -2.52, -28], yaw: -Math.PI / 4, pitch: 0.1 },
  { name: 'boundary east', position: [40, 8.72, 10], yaw: -HALF_PI, pitch: -0.1 },
  { name: 'boundary west', position: [-42, 8.98, 8], yaw: HALF_PI, pitch: 0 },
  { name: 'boundary south', position: [0, 8.21, 44], yaw: Math.PI, pitch: 0 },
  { name: 'boundary 47 m inward', position: [0, -3.83, -47], yaw: Math.PI, pitch: 0.05 },
  { name: 'high over the valley', position: [0, 30, -10], yaw: 0, pitch: -0.6 },
] as const);

/**
 * Five poses on the painter's hill flank, 4.5-5 m from the spot, each looking up the hill at its
 * crest (2026-11-11). Each eye stands 1.6 m above `createTerrain(1).heightAt`, which puts it 0.25 to
 * 0.56 m above the crest's flat top, so the top's far half is seen 3-7° from edge-on. There its
 * small strokes took a brush mip with no coverage left and the crest drew bare (COVERAGE_MAX_LOD in
 * src/render/strokes/material.ts). Kept out of COVERAGE_POSES, whose 24 poses the unit budget and
 * sky river checks pin.
 */
export const CREST_POSES: readonly CoveragePose[] = Object.freeze([
  { name: 'crest from behind', position: [0, 0.56, 4.5], yaw: 0, pitch: -0.12 },
  { name: 'crest from behind, grazing', position: [0, 0.25, 5], yaw: 0, pitch: -0.05 },
  { name: 'crest from ahead', position: [0, 0.47, -4.5], yaw: Math.PI, pitch: -0.1 },
  { name: 'crest from the east', position: [4.5, 0.53, 0], yaw: HALF_PI, pitch: -0.12 },
  { name: 'crest from the west', position: [-4.5, 0.5, 0], yaw: -HALF_PI, pitch: -0.11 },
] as const);
