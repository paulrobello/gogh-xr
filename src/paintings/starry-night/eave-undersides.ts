/**
 * Underside copies of the roof strokes over the eave overhang. A roof slope is one single-sided
 * face, and so is every stroke on it, so from the ground near an eave, where the eye is below the
 * slope's plane, the slope's strokes face away and are culled, and the sky showed through the
 * overhang. The walls and gables hide every other part of the underside from an eye outside the
 * house, so only the overhang band past the wall line needs paint (`reachesOverhang`).
 *
 * Each roof stroke whose painted footprint (BRUSH_FOOTPRINT) reaches onto that band gets one copy
 * facing down: mirrored through the slope's plane, with its normal negated and its long axis kept,
 * so the shader's moonlight shades it as an underside. The base meshes close the band with a
 * matching soffit strip (`pushGableSoffit`), so every stroke chunk and base mesh stays front-face
 * only. Pure: it reads the scattered strokes and the village's roofs, and runs in unit tests.
 */
import { strokeShade } from '../../demo/canvas/placement';
import { BRUSHES } from '../../render/strokes/brush-atlas-data';
import { BRUSH_FOOTPRINT } from '../../render/strokes/face-clamp';
import { strokeAxes, surfaceBasis, type Vec3 } from '../../render/strokes/frame';
import {
  createStrokeBuffers,
  packInstance,
  STROKE_LAYER,
  type StrokeBuffers,
  type StrokeInstance,
  unpackInstance,
} from '../../render/strokes/instance';
import { drain, type Steps } from '../../util/slicer';
import {
  type GableRoof,
  gableRoofLines,
  gableSlopeNormal,
  reachesOverhang,
  toLocal,
  toLocalDir,
  toWorld,
} from '../../world/house-geometry';

/**
 * An underside shows at most this share of its top's brightness. The negated normal already
 * darkens a slope that faces the moon, by up to a quarter, but turns a slope facing away from it
 * slightly lighter, so a copy's colour is scaled to keep every underside at least this much darker.
 */
export const EAVE_UNDERSIDE_SHADE: number = 0.9;
/**
 * A stroke lies on a slope when its centre is within this of the slope's plane. The scatter lifts
 * a stroke off its face by at most SCATTER_DEPTH_JITTER of its length, under 3 cm on the village.
 */
const PLANE_TOLERANCE_M = 0.1;
/** A stroke lies on a slope when its decoded normal is within about 2.6° of the slope's. */
const NORMAL_TOLERANCE = 0.999;
/** Building-layer strokes examined between two yields. */
const SLICE = 1024;

interface Slope {
  readonly roof: GableRoof;
  readonly normal: Vec3;
  /** A point on the slope's plane: the ridge's midpoint. */
  readonly point: Vec3;
}

interface RoofBounds {
  readonly slopes: readonly Slope[];
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Each roof's slopes and its world xz bounds: the roof outline grown by a metre. */
function roofBounds(roofs: readonly GableRoof[]): RoofBounds[] {
  return roofs.map((roof) => {
    const { frame, box } = roof;
    const { hw, hd, ridge } = gableRoofLines(box);
    const corners = [
      toWorld(frame, -hw, 0, -hd),
      toWorld(frame, hw, 0, -hd),
      toWorld(frame, hw, 0, hd),
      toWorld(frame, -hw, 0, hd),
    ];
    const xs = corners.map((c) => c[0]);
    const zs = corners.map((c) => c[2]);
    const point = toWorld(frame, 0, ridge, 0);
    return {
      slopes: ([1, -1] as const).map((side) => ({
        roof,
        normal: gableSlopeNormal(frame, box, side),
        point,
      })),
      minX: Math.min(...xs) - 1,
      maxX: Math.max(...xs) + 1,
      minZ: Math.min(...zs) - 1,
      maxZ: Math.max(...zs) + 1,
    };
  });
}

/** The roof slope stroke `s` lies on, or null. */
function slopeOf(s: StrokeInstance, bounds: readonly RoofBounds[]): Slope | null {
  const [x, , z] = s.position;
  for (const b of bounds) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    for (const slope of b.slopes) {
      if (dot(s.normal, slope.normal) < NORMAL_TOLERANCE) continue;
      const p = s.position;
      const q = slope.point;
      const d = dot([p[0] - q[0], p[1] - q[1], p[2] - q[2]], slope.normal);
      if (Math.abs(d) <= PLANE_TOLERANCE_M) return slope;
    }
  }
  return null;
}

/** Whether stroke `s`'s painted footprint, as the GPU draws it, reaches onto its roof's overhang. */
function onOverhang(s: StrokeInstance, slope: Slope): boolean {
  const { frame, box } = slope.roof;
  const { long, short } = strokeAxes(s.normal, s.tangent);
  const foot = BRUSH_FOOTPRINT[BRUSHES[s.brush].kind];
  const a = (s.size[0] * foot.length) / 2;
  const b = (s.size[1] * foot.width) / 2;
  const l = toLocalDir(frame, long);
  const w = toLocalDir(frame, short);
  const [lx, , lz] = toLocal(frame, s.position);
  const ex = Math.abs(l[0]) * a + Math.abs(w[0]) * b;
  const ez = Math.abs(l[2]) * a + Math.abs(w[2]) * b;
  return reachesOverhang(box, lx, lz, ex, ez);
}

const PROBE = createStrokeBuffers(1);

/**
 * The copy of stroke `s`, which lies on `slope`, facing down: centre mirrored through the slope's
 * plane, normal negated, tangent re-measured so the long axis is unchanged (the axis is taken from
 * the decoded normal and tangent, and the angle against the copy's own decoded normal, so the
 * quantised basis cannot turn it), colour scaled by EAVE_UNDERSIDE_SHADE where the flip alone
 * would not darken it that much. Size, brush, layer, phase and flags are the original's.
 */
function underside(s: StrokeInstance, slope: Slope): StrokeInstance {
  const n = slope.normal;
  const p = s.position;
  const q = slope.point;
  const d = dot([p[0] - q[0], p[1] - q[1], p[2] - q[2]], n);
  const normal: Vec3 = [-s.normal[0], -s.normal[1], -s.normal[2]];
  packInstance(PROBE, 0, { ...s, normal, tangent: 0 });
  const decoded = unpackInstance(PROBE, 0).normal;
  const { b1, b2 } = surfaceBasis(decoded);
  const { long } = strokeAxes(s.normal, s.tangent);
  const k = Math.min(1, (EAVE_UNDERSIDE_SHADE * strokeShade(s.normal)) / strokeShade(decoded));
  const c = s.color;
  return {
    ...s,
    position: [p[0] - 2 * d * n[0], p[1] - 2 * d * n[1], p[2] - 2 * d * n[2]],
    normal,
    tangent: Math.atan2(dot(long, b2), dot(long, b1)),
    color: [c[0] * k, c[1] * k, c[2] * k, c[3]],
  };
}

/** Indices of the strokes with an underside copy, and the copies, in stroke order. */
export interface EaveUndersides {
  readonly sources: readonly number[];
  readonly strokes: readonly StrokeInstance[];
}

/** The underside copies of `buffers`' roof strokes on `roofs`' overhang bands. */
export function eaveUndersides(
  buffers: StrokeBuffers,
  roofs: readonly GableRoof[],
): EaveUndersides {
  return drain(eaveUndersidesSteps(buffers, roofs));
}

/** `eaveUndersides` as steps: it runs on every world build, the scatter cache's hits included. */
export function* eaveUndersidesSteps(
  buffers: StrokeBuffers,
  roofs: readonly GableRoof[],
): Steps<EaveUndersides> {
  const bounds = roofBounds(roofs);
  const sources: number[] = [];
  const strokes: StrokeInstance[] = [];
  let examined = 0;
  for (let i = 0; i < buffers.count; i++) {
    if (buffers.meta[i * 4 + 1] !== STROKE_LAYER.building) continue;
    if (++examined % SLICE === 0) yield;
    const s = unpackInstance(buffers, i);
    const slope = slopeOf(s, bounds);
    if (!slope || !onOverhang(s, slope)) continue;
    sources.push(i);
    strokes.push(underside(s, slope));
  }
  return { sources, strokes };
}
