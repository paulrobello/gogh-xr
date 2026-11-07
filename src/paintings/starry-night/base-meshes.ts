/**
 * Base meshes (ruling P8): the world surfaces drawn flat and unlit under the strokes, so a gap
 * between strokes shows under-paint rather than the clear colour. Each takes its layer's region
 * mean from the canvas histogram, darkened; emissive meshes (the windows) keep their colour; a
 * tinted village mesh (`userData.tint`) takes each triangle's house tint, darkened less. In the
 * debug paint every base mesh is flat magenta, which the coverage sweep counts.
 */
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  FrontSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
} from 'three';
import type { Vec3 } from '../../render/strokes/frame';
import { WORLD_LAYERS } from '../../render/strokes/scatter';
import { LAYER_REGION, type WorldLayer } from './canvas-camera';
import { type CanvasHistogram, COLOR_BITS } from './canvas-histogram';
import {
  pickTint,
  splitTintBands,
  type TintBands,
  type TintRole,
  type TintTags,
  tintSeed,
} from './village-tint';

/** The debug paint, and the clear colour in the debug modes. sRGB 1 and 0 survive the output encode. */
export const BARE_COLOR: number = 0xff00ff;
/** Under-paint is the region's mean colour times this. */
export const UNDERPAINT_SHADE: number = 0.6;
/**
 * Under-paint on a tinted village triangle is its owner's tint (the strokes' own colour) times this,
 * so a gap between pale wall strokes reads as a slightly deeper wall, not a dark hole.
 */
export const TINT_UNDERPAINT_SHADE: number = 0.85;
/**
 * Base meshes draw before the stroke chunks under the default policy, whose render orders start at
 * STROKES_AFTER_BASE (src/render/strokes/batch.ts), so the strokes test against the depth they
 * write. Under `?zdiag=write` the chunks draw first, from 0, and early depth rejects the base
 * meshes' hidden fragments instead.
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
 * A tinted village mesh with a per-vertex under-paint colour: each triangle its owner's tint for its
 * role, picked as the scatter picks it (`tintSeed` with the scatter seed and the layer's
 * WORLD_LAYERS index), times TINT_UNDERPAINT_SHADE. The position attribute is shared, not copied.
 * Null for an untagged or indexed geometry.
 */
function tintedUnderpaint(
  geometry: BufferGeometry,
  bands: TintBands,
  seed: number,
): BufferGeometry | null {
  const tags = geometry.userData.tint as TintTags | undefined;
  if (!(tags?.owner instanceof Uint16Array && tags.role instanceof Uint8Array)) return null;
  if (geometry.index) return null;
  const position = geometry.getAttribute('position');
  const layer = WORLD_LAYERS.indexOf(geometry.userData.layer as WorldLayer);
  const colors = new Float32Array(position.count * 3);
  const picked = new Map<number, Color>();
  const color = new Color();
  for (let t = 0; t * 3 < position.count; t++) {
    const owner = tags.owner[t];
    const role = tags.role[t] as TintRole;
    const key = owner * 4 + role;
    let c = picked.get(key);
    if (!c) {
      const rgb = pickTint(bands[role], tintSeed(seed, layer, owner, role)).rgb;
      const k = TINT_UNDERPAINT_SHADE / 255;
      c = color.setRGB(rgb[0] * k, rgb[1] * k, rgb[2] * k, SRGBColorSpace).clone();
      picked.set(key, c);
    }
    for (let v = 0; v < 3; v++) colors.set([c.r, c.g, c.b], (t * 3 + v) * 3);
  }
  const tinted = new BufferGeometry();
  tinted.setAttribute('position', position);
  tinted.setAttribute('color', new Float32BufferAttribute(colors, 3));
  tinted.userData = geometry.userData;
  return tinted;
}

/**
 * One flat unlit mesh per surface, front faces only, pushed back in depth by a polygon offset so
 * strokes lying on the surface always win the depth test. Strokes are back-face culled, so a back
 * face is where no stroke can show: drawing it would only paint a gap. The world stays closed (the
 * dome faces inward all round, the terrain up), and the cypress's open base sits at or under the
 * ground. A backdrop surface (`userData.backdrop`, the sky dome) gets no mesh: its strokes draw by
 * rank just in front of the far plane (src/render/strokes/backdrop-depth.ts), where a base mesh at
 * its true depth would cover them, and the scene's clear colour is its under-paint (magenta in the
 * debug paint, index.ts), so a gap between them shows the same colour. With the scatter's `seed`, a
 * tinted village mesh takes its triangles' house tints (`tintedUnderpaint`) instead of the region
 * mean.
 */
export function createBaseMeshes(
  surfaces: readonly BufferGeometry[],
  histogram: CanvasHistogram,
  paint: BaseMeshPaint,
  seed?: number,
): Group {
  const group = new Group();
  group.name = 'base-meshes';
  let bands: TintBands | null = null;
  for (const geometry of surfaces) {
    if (geometry.userData.backdrop === true) continue;
    let tinted: BufferGeometry | null = null;
    if (paint === 'underpaint' && seed !== undefined && geometry.userData.tint) {
      bands ??= splitTintBands(histogram);
      tinted = tintedUnderpaint(geometry, bands, seed);
    }
    const material = new MeshBasicMaterial({
      color: tinted
        ? new Color(1, 1, 1)
        : paint === 'magenta'
          ? new Color(BARE_COLOR)
          : baseColor(geometry, histogram),
      vertexColors: tinted !== null,
      side: FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 4,
    });
    const mesh = new Mesh(tinted ?? geometry, material);
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
