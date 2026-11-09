/**
 * Placement and ray math for the XR notice stack (P5.6), three math only, no rendering.
 *
 * The stack is parented to the camera like the perf HUD, so it follows the head. It sits above the
 * eye line, clear of the HUD (below it) and of the settings panel's default spawn (ahead and a
 * little below the eye, `DEFAULT_OFFSET`), and grows upward from its bottom edge. When an open
 * panel would sit behind the stack, the stack lifts above the panel's top edge, or, when that
 * would pass `MAX_ELEVATION`, drops below the panel's bottom edge.
 *
 * Angles are the ones the stack is placed by. Elevation is the pitch about X, `atan2(y, -z)`:
 * every point of the stack's bottom edge has the same one, since the stack is pitched about X.
 * Azimuth is `atan2(x, -z)`. Both change monotonically along a straight edge, so a panel's
 * corners bound its whole rectangle.
 */
import { type Matrix4, Vector3 } from 'three';

/** From the eye to the stack, metres, along its elevation. The HUD is 0.6 m away too. */
export const NOTICE_DISTANCE = 0.6;
/** One notice's width, metres, like the HUD's panel. */
export const NOTICE_W = 0.3;
/** The stack's bottom edge, above the eye line: the default panel's top edge is near 10.2°. */
export const BASE_ELEVATION = (13 * Math.PI) / 180;
/** How far from an open panel's edge a moved stack sits. */
export const LIFT_MARGIN = (2 * Math.PI) / 180;
/** The stack's bottom edge never lifts past this. */
export const MAX_ELEVATION = (40 * Math.PI) / 180;
/** A stack dropped below a panel keeps its bottom edge above this, clear of the perf HUD (-11.3°). */
export const MIN_ELEVATION = (-8 * Math.PI) / 180;

/**
 * The stack's half width as an azimuth, for a stack whose top edge is at `top`. Its nearest
 * points in depth are on the top edge, at least `NOTICE_DISTANCE * cos(top)` ahead, so this bounds
 * every point of it.
 */
export function noticeHalfAzimuth(top: number): number {
  return Math.atan2(NOTICE_W / 2, NOTICE_DISTANCE * Math.cos(Math.min(top, Math.PI / 2 - 1e-3)));
}

/**
 * The stack's bottom-edge elevation, radians. `corners` are the open panel's corners in camera
 * space (the camera looks down -Z), or null with the panel closed. A corner behind the eye is
 * ignored. `stackAngle` is the stack's angular height above its bottom edge.
 *
 * At the base the stack stays unless the panel overlaps it in both azimuth and elevation. Then it
 * lifts to `LIFT_MARGIN` above the panel's top edge if that is within `MAX_ELEVATION`, else drops
 * so its top edge is `LIFT_MARGIN` below the panel's bottom edge if that keeps it above
 * `MIN_ELEVATION`. When neither fits, it stays at `MAX_ELEVATION` and may cover the panel, which
 * still owns the trigger there.
 */
export function noticeElevation(corners: readonly Vector3[] | null, stackAngle: number): number {
  if (!corners) return BASE_ELEVATION;
  let minAz = Number.POSITIVE_INFINITY;
  let maxAz = Number.NEGATIVE_INFINITY;
  let minEl = Number.POSITIVE_INFINITY;
  let maxEl = Number.NEGATIVE_INFINITY;
  let ahead = 0;
  for (const c of corners) {
    if (c.z >= 0) continue;
    ahead += 1;
    const forward = -c.z;
    const az = Math.atan2(c.x, forward);
    const el = Math.atan2(c.y, forward);
    minAz = Math.min(minAz, az);
    maxAz = Math.max(maxAz, az);
    minEl = Math.min(minEl, el);
    maxEl = Math.max(maxEl, el);
  }
  if (ahead === 0) return BASE_ELEVATION;
  const half = noticeHalfAzimuth(BASE_ELEVATION + stackAngle);
  const overlapsAz = maxAz > -half && minAz < half;
  const overlapsEl = maxEl > BASE_ELEVATION && minEl < BASE_ELEVATION + stackAngle;
  if (!overlapsAz || !overlapsEl) return BASE_ELEVATION;
  const above = maxEl + LIFT_MARGIN;
  if (above <= MAX_ELEVATION) return above;
  const below = minEl - LIFT_MARGIN - stackAngle;
  if (below >= MIN_ELEVATION) return below;
  return MAX_ELEVATION;
}

/** The stack root's camera-local position for a bottom-edge `elevation`, written into `out`. */
export function noticeAnchor(elevation: number, out: Vector3 = new Vector3()): Vector3 {
  return out.set(0, NOTICE_DISTANCE * Math.sin(elevation), -NOTICE_DISTANCE * Math.cos(elevation));
}

const localOrigin = new Vector3();
const localEnd = new Vector3();

/**
 * Where a ray meets a `w` by `h` rectangle centred on the local XY plane of `inverseWorld`'s
 * object, from its front (+Z) side: the distance along the unit `direction`, or null on a miss.
 * `origin` and `direction` are world space. The map is affine, so the ray parameter, and with it
 * the distance, is the same in both spaces, and a scaled unit plane works with `w` and `h` of 1.
 */
export function rayRectDistance(
  origin: Vector3,
  direction: Vector3,
  inverseWorld: Matrix4,
  w: number,
  h: number,
): number | null {
  localOrigin.copy(origin).applyMatrix4(inverseWorld);
  localEnd.copy(origin).add(direction).applyMatrix4(inverseWorld);
  const dz = localEnd.z - localOrigin.z;
  if (dz >= 0) return null;
  const t = -localOrigin.z / dz;
  if (t <= 0) return null;
  const x = localOrigin.x + (localEnd.x - localOrigin.x) * t;
  const y = localOrigin.y + (localEnd.y - localOrigin.y) * t;
  return Math.abs(x) <= w / 2 && Math.abs(y) <= h / 2 ? t : null;
}
