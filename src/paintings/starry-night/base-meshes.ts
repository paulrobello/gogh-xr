/**
 * Base meshes (ruling P8): the world surfaces drawn flat and unlit under the strokes, so a gap
 * between strokes shows under-paint rather than the clear colour. Each takes its layer's region
 * mean from the canvas histogram, darkened; emissive meshes (the windows) keep their colour. In
 * the debug paint every base mesh is flat magenta, which the coverage sweep counts.
 */
import {
  type BufferGeometry,
  Color,
  FrontSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
} from 'three';
import type { Vec3 } from '../../render/strokes/frame';
import { LAYER_REGION, type WorldLayer } from './canvas-camera';
import { type CanvasHistogram, COLOR_BITS } from './canvas-histogram';

/** The debug paint, and the clear colour in the debug modes. sRGB 1 and 0 survive the output encode. */
export const BARE_COLOR: number = 0xff00ff;
/** Under-paint is the region's mean colour times this. */
export const UNDERPAINT_SHADE: number = 0.6;
/**
 * Base meshes draw after every stroke chunk (whose render orders are the cull ranks), so early
 * depth rejects their hidden fragments.
 */
export const BASE_MESH_RENDER_ORDER: number = 1_000_000;

export type BaseMeshPaint = 'underpaint' | 'magenta';

const COLOR_LEVELS = 1 << COLOR_BITS;
const COLOR_STEP = 256 / COLOR_LEVELS;

/** The texel-weighted mean of a region's colour bins (bin centres), times UNDERPAINT_SHADE. */
export function underpaintColor(histogram: CanvasHistogram, layer: WorldLayer): Vec3 {
  const h = histogram.regions[LAYER_REGION[layer]];
  if (!h || h.count === 0) throw new Error(`no canvas texels for layer ${layer}`);
  const mask = COLOR_LEVELS - 1;
  const sum = [0, 0, 0];
  let previous = 0;
  for (let i = 0; i < h.colorBins.length; i++) {
    const weight = h.colorCdf[i] - previous;
    previous = h.colorCdf[i];
    const key = h.colorBins[i];
    sum[0] += weight * ((key >> (2 * COLOR_BITS)) * COLOR_STEP + COLOR_STEP / 2);
    sum[1] += weight * (((key >> COLOR_BITS) & mask) * COLOR_STEP + COLOR_STEP / 2);
    sum[2] += weight * ((key & mask) * COLOR_STEP + COLOR_STEP / 2);
  }
  return sum.map((s) => (s / h.count) * UNDERPAINT_SHADE) as unknown as Vec3;
}

function baseColor(geometry: BufferGeometry, histogram: CanvasHistogram): Color {
  const { emissive, color, layer } = geometry.userData;
  // Emissive colours are linear, the working colour space.
  if (emissive === true && color) return new Color().setRGB(color[0], color[1], color[2]);
  const rgb = underpaintColor(histogram, layer as WorldLayer);
  return new Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, SRGBColorSpace);
}

/**
 * One flat unlit mesh per surface, front faces only, pushed back in depth by a polygon offset so
 * strokes lying on the surface always win the depth test. Strokes are back-face culled, so a back
 * face is where no stroke can show: drawing it would only paint a gap. The world stays closed (the
 * dome faces inward all round, the terrain up), and the cypress's open base sits at or under the
 * ground.
 */
export function createBaseMeshes(
  surfaces: readonly BufferGeometry[],
  histogram: CanvasHistogram,
  paint: BaseMeshPaint,
): Group {
  const group = new Group();
  group.name = 'base-meshes';
  for (const geometry of surfaces) {
    const material = new MeshBasicMaterial({
      color: paint === 'magenta' ? new Color(BARE_COLOR) : baseColor(geometry, histogram),
      side: FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 4,
    });
    const mesh = new Mesh(geometry, material);
    mesh.name = `base-${String(geometry.userData.layer)}`;
    mesh.renderOrder = BASE_MESH_RENDER_ORDER;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  return group;
}

/** Releases the meshes' materials and geometries and detaches the group. */
export function disposeBaseMeshes(group: Group): void {
  group.removeFromParent();
  for (const child of group.children) {
    const mesh = child as Mesh<BufferGeometry, MeshBasicMaterial>;
    mesh.material.dispose();
    mesh.geometry.dispose();
  }
  group.clear();
}
