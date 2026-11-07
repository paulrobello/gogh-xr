/**
 * The sky dome and the star and moon anchors. Pure geometry and records: no materials, no scene
 * objects, so it runs in unit tests without WebGL.
 *
 * World: metres, +Y up, the painter's spot at the origin facing −Z. The dome is centred on
 * PAINTER_EYE, not the spot, so the anchors' reprojection through the painter's camera is exact.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import regionsJson from '../../assets/bake/starry-night/regions.json';
import {
  CANVAS_ASPECT,
  canvasRay,
  PAINTER_EYE,
  type Vec2,
  type WorldLayer,
} from '../paintings/starry-night/canvas-camera';
import type { Vec3 } from '../render/strokes/frame';

/** Dome radius, metres. */
export const SKY_DOME_RADIUS: number = 120;
/** Longitude segments of the dome. */
export const SKY_DOME_WIDTH_SEGMENTS: number = 32;
/** Latitude segments of the dome. Triangles: 32 × 16 × 2 − 2 × 32 = 960. */
export const SKY_DOME_HEIGHT_SEGMENTS: number = 16;
/** Layer tag the dome carries in `geometry.userData.layer`, as terrain does. */
export const SKY_LAYER: WorldLayer = 'sky';

/**
 * Inward-facing UV-sphere of radius SKY_DOME_RADIUS centred on PAINTER_EYE. Normals point at the
 * centre and the counter-clockwise face normal points inward. The pole rows are single points, so
 * the polar quads collapse to one triangle each. `userData.backdrop` is true.
 */
export function createSkyDome(): BufferGeometry {
  const w = SKY_DOME_WIDTH_SEGMENTS;
  const h = SKY_DOME_HEIGHT_SEGMENTS;
  const cols = w + 1;
  const position = new Float32Array(cols * (h + 1) * 3);
  const normal = new Float32Array(cols * (h + 1) * 3);
  for (let iy = 0; iy <= h; iy++) {
    const phi = (iy / h) * Math.PI;
    for (let ix = 0; ix <= w; ix++) {
      const theta = (ix / w) * 2 * Math.PI;
      const dx = Math.sin(phi) * Math.cos(theta);
      const dy = Math.cos(phi);
      const dz = Math.sin(phi) * Math.sin(theta);
      const o = (iy * cols + ix) * 3;
      position.set(
        [
          PAINTER_EYE[0] + dx * SKY_DOME_RADIUS,
          PAINTER_EYE[1] + dy * SKY_DOME_RADIUS,
          PAINTER_EYE[2] + dz * SKY_DOME_RADIUS,
        ],
        o,
      );
      normal.set([-dx, -dy, -dz], o);
    }
  }
  const index: number[] = [];
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const a = iy * cols + ix;
      const b = a + cols;
      // Degenerate pole triangles are skipped.
      if (iy !== 0) index.push(a, b, a + 1);
      if (iy !== h - 1) index.push(a + 1, b, b + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  geometry.setIndex(index);
  geometry.userData.layer = SKY_LAYER;
  // Strokes on it draw by rank behind the world (src/render/strokes/backdrop-depth.ts), and it has
  // no base mesh.
  geometry.userData.backdrop = true;
  return geometry;
}

export interface SkyAnchor {
  readonly kind: 'star' | 'moon';
  /** The region's note in regions.json. */
  readonly note: string;
  /** Canvas uv, v bottom to top (already flipped from regions.json). */
  readonly uv: Vec2;
  /** World position on the dome. */
  readonly position: Vec3;
  /** Half-angle the circle subtends at the eye, radians, measured along the canvas u axis. */
  readonly angularRadius: number;
  /** The circle's radius in regions.json, painting widths. */
  readonly radius: number;
}

interface CircleShape {
  readonly type: string;
  readonly note?: string;
  readonly center?: readonly number[];
  readonly radius?: number;
}
interface RegionsJson {
  readonly regions: readonly { readonly name: string; readonly shapes: readonly CircleShape[] }[];
}

/**
 * The 11 star circles and the moon circle of regions.json, projected onto the dome through the
 * painter's camera. regions.json has v pointing down: v = 1 − v_json. The circle radius is in
 * painting-width units, so its angle is the one between the rays through (u, v) and (u + r, v).
 */
export function skyAnchors(
  regions: RegionsJson = regionsJson as RegionsJson,
): readonly SkyAnchor[] {
  const anchors: SkyAnchor[] = [];
  for (const region of regions.regions) {
    const kind = region.name === 'stars' ? 'star' : region.name === 'moon' ? 'moon' : null;
    if (kind === null) continue;
    for (const shape of region.shapes) {
      if (shape.type !== 'circle' || !shape.center || shape.radius === undefined) continue;
      const u = shape.center[0];
      const v = 1 - shape.center[1];
      const ray = canvasRay(u, v);
      const edge = canvasRay(u + shape.radius, v);
      const cos = ray[0] * edge[0] + ray[1] * edge[1] + ray[2] * edge[2];
      anchors.push(
        Object.freeze({
          kind,
          note: shape.note ?? '',
          uv: Object.freeze([u, v]) as Vec2,
          position: Object.freeze([
            PAINTER_EYE[0] + ray[0] * SKY_DOME_RADIUS,
            PAINTER_EYE[1] + ray[1] * SKY_DOME_RADIUS,
            PAINTER_EYE[2] + ray[2] * SKY_DOME_RADIUS,
          ]) as Vec3,
          angularRadius: Math.acos(Math.min(1, cos)),
          radius: shape.radius,
        }),
      );
    }
  }
  return Object.freeze(anchors);
}

/**
 * A light's strokes reach out to this many anchor radii (src/world/sky-lights.ts). Inside one
 * radius they are at full density; from there to this radius their density eases to 0
 * (smoothstep), so the dome's own strokes show between them more and more and the disc has no
 * circular edge. The scan's halo rings around the moon and the stars lie in that band.
 */
export const SKY_LIGHT_RIM: number = 1.5;

/** Samples round the circle `anchorReach` measures. */
const REACH_SAMPLES = 32;

/**
 * The farthest dome point from `anchor.position`, metres, on the canvas circle `rho` anchor radii
 * round the anchor (v units CANVAS_ASPECT longer, as the moon and star strokes are placed), over
 * REACH_SAMPLES points: perspective stretches the circle most there. Every moon or star stroke
 * centred inside `rho` radii lies within it, up to the sampling. The haze cones (sky-lights.ts)
 * and the star and moon rings (src/motion/sky-rings.ts) read it.
 */
export function anchorReach(anchor: SkyAnchor, rho: number): number {
  const reach = rho * anchor.radius;
  let radius = 0;
  for (let k = 0; k < REACH_SAMPLES; k++) {
    const t = (k / REACH_SAMPLES) * 2 * Math.PI;
    const ray = canvasRay(
      anchor.uv[0] + reach * Math.cos(t),
      anchor.uv[1] + reach * Math.sin(t) * CANVAS_ASPECT,
    );
    radius = Math.max(
      radius,
      Math.hypot(
        PAINTER_EYE[0] + ray[0] * SKY_DOME_RADIUS - anchor.position[0],
        PAINTER_EYE[1] + ray[1] * SKY_DOME_RADIUS - anchor.position[1],
        PAINTER_EYE[2] + ray[2] * SKY_DOME_RADIUS - anchor.position[2],
      ),
    );
  }
  return radius;
}
