/**
 * The gallery's portals (P5.5), pure so the unit tests check them without WebGL. A live frame's
 * plane is a portal: walking through it, or teleporting into its threshold volume, the 0.6 m slab
 * in front of it, enters its painting's world. Coming-soon frames are not portals.
 *
 * The gallery's walk bounds keep the head 0.3 m off the walls, so a walk never reaches the frame's
 * own plane: it enters the threshold volume first, and that entry is the crossing. The volume is
 * the frame's outer rectangle (scan plus moulding) extruded `PORTAL_DEPTH` into the room and
 * everything behind the plane within that rectangle, so a segment crossing the plane always counts.
 * Vertically it reaches `PORTAL_VERTICAL_MARGIN` past the moulding, so a seated or a tall viewer's
 * head counts; a teleport lands on the floor and is tested in plan view only.
 *
 * After a trigger a portal disarms until the head has been seen outside its volume again, so a
 * viewer who arrives standing in it (or never leaves it) does not re-trigger.
 */
import {
  HANGINGS,
  type Hanging,
  MOULDING_WIDTH,
  SCAN_DEPTH,
  wallPoint,
} from '../paintings/gallery/layout';
import type { WorldPose } from '../paintings/world-module';
import type { Vec3 } from '../render/strokes/frame';

/** The threshold volume's depth in front of the frame plane, metres (the plan's 0.6 m). */
export const PORTAL_DEPTH = 0.6;
/** How far the volume reaches above and below the frame's moulding, metres. */
export const PORTAL_VERTICAL_MARGIN = 0.4;
/** Where a return from a world stands: this far in front of the frame plane, facing it. */
export const RETURN_DISTANCE = 1.2;

export interface Portal {
  /** The painting it enters. */
  readonly id: string;
  /** The centre of the frame plane: the scan's centre. */
  readonly centre: Vec3;
  /** Horizontal unit normal, into the room. */
  readonly normal: Vec3;
  /** Horizontal unit vector along the wall, the viewer's right facing the frame. */
  readonly right: Vec3;
  /** Half the moulding's outer width, metres. */
  readonly halfWidth: number;
  /** The volume's vertical extent, metres. */
  readonly y0: number;
  readonly y1: number;
  readonly depth: number;
}

/** The portal of a hanging, whatever its status; `livePortals` keeps the live ones. */
export function portalOf(h: Hanging): Portal {
  return Object.freeze({
    id: h.painting.id,
    centre: wallPoint(h.wall, h.s, h.y, SCAN_DEPTH),
    normal: h.wall.normal,
    right: h.wall.right,
    halfWidth: h.width / 2 + MOULDING_WIDTH,
    y0: h.outer.y0 - PORTAL_VERTICAL_MARGIN,
    y1: h.outer.y1 + PORTAL_VERTICAL_MARGIN,
    depth: PORTAL_DEPTH,
  });
}

/** The portals of every live hanging with a world. */
export function livePortals(hangings: readonly Hanging[] = HANGINGS): Portal[] {
  return hangings
    .filter((h) => h.painting.status === 'live' && h.painting.world !== undefined)
    .map(portalOf);
}

/** `p` in the portal's frame: along `right`, along `normal` from the plane, and height. */
function local(portal: Portal, p: Vec3): [number, number, number] {
  const dx = p[0] - portal.centre[0];
  const dz = p[2] - portal.centre[2];
  return [
    dx * portal.right[0] + dz * portal.right[2],
    dx * portal.normal[0] + dz * portal.normal[2],
    p[1],
  ];
}

/** True when `p` is inside the threshold volume; `planOnly` ignores its height. */
export function insidePortal(portal: Portal, p: Vec3, planOnly = false): boolean {
  const [s, d, y] = local(portal, p);
  if (Math.abs(s) > portal.halfWidth || d > portal.depth) return false;
  return planOnly || (y >= portal.y0 && y <= portal.y1);
}

/**
 * True when the segment `from` → `to` meets the threshold volume (the slab test in the portal's
 * frame, the volume unbounded behind the plane).
 */
export function segmentMeetsPortal(portal: Portal, from: Vec3, to: Vec3): boolean {
  const a = local(portal, from);
  const b = local(portal, to);
  const lo = [-portal.halfWidth, Number.NEGATIVE_INFINITY, portal.y0];
  const hi = [portal.halfWidth, portal.depth, portal.y1];
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 3; k++) {
    const delta = b[k] - a[k];
    if (Math.abs(delta) < 1e-12) {
      if (a[k] < lo[k] || a[k] > hi[k]) return false;
      continue;
    }
    let near = (lo[k] - a[k]) / delta;
    let far = (hi[k] - a[k]) / delta;
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return false;
  }
  return true;
}

/** One frame's head movement as the detector sees it. */
export interface PortalFrame {
  /** The head's world position this frame. */
  readonly head: Vec3;
  /** A teleport's landing this frame (`lastTeleport.to`), or null. */
  readonly teleportTo: Vec3 | null;
  /**
   * A discontinuous move of the head this frame that is not a teleport (a placed pose, a spawn, a
   * reference-space reset). A turn about the head is not one: its frame tests as a walk.
   */
  readonly jumped: boolean;
}

export interface PortalDetector {
  /** One frame; returns the portal entered, or null. */
  frame(input: PortalFrame): Portal | null;
  /** Forgets the last head position; the next frame only re-arms. */
  reset(): void;
  /** Whether each portal is armed, by id (`portal` diag). */
  armed(): Record<string, boolean>;
}

/**
 * Detects entries into `portals`. A walk enters when the head moves from outside a volume along a
 * segment that meets it; a teleport enters when its landing is inside a volume in plan view. A
 * jump that is not a teleport tests nothing. Only an armed portal triggers.
 */
export function createPortalDetector(portals: readonly Portal[]): PortalDetector {
  let previous: Vec3 | null = null;
  const armed = new Map<string, boolean>(portals.map((p) => [p.id, false]));

  function rearm(head: Vec3): void {
    for (const portal of portals) {
      if (!insidePortal(portal, head)) armed.set(portal.id, true);
    }
  }

  return {
    frame({ head, teleportTo, jumped }) {
      const from = previous;
      previous = [head[0], head[1], head[2]];
      let hit: Portal | null = null;
      if (from !== null) {
        for (const portal of portals) {
          if (!armed.get(portal.id)) continue;
          const entered = teleportTo
            ? insidePortal(portal, teleportTo, true)
            : !jumped && !insidePortal(portal, from) && segmentMeetsPortal(portal, from, head);
          if (entered) {
            hit = portal;
            break;
          }
        }
      }
      if (hit) {
        armed.set(hit.id, false);
        return hit;
      }
      rearm(head);
      return null;
    },
    reset() {
      previous = null;
    },
    armed: () => Object.fromEntries(armed),
  };
}

/**
 * Where a return to the gallery stands: `RETURN_DISTANCE` in front of `portal`'s plane on its
 * centre line, on the floor, facing the frame. Outside the threshold volume, so it does not
 * re-trigger.
 */
export function returnPose(portal: Portal): WorldPose {
  const d = RETURN_DISTANCE;
  return {
    position: [portal.centre[0] + portal.normal[0] * d, 0, portal.centre[2] + portal.normal[2] * d],
    // Yaw 0 faces -Z: facing the frame is facing along -normal.
    yaw: Math.atan2(portal.normal[0], portal.normal[2]),
  };
}
