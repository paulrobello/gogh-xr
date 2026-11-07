/**
 * The gallery world module (P5.4): the default boot scene, a quiet room painted in strokes where
 * the seven paintings hang at true relative scale. It meets the same `WorldHandle` contract as
 * Starry Night: one governed stroke batch, a flat ground, a boundary that is 0 inside the room,
 * `blocked` for the walls and benches, and `walkBounds` so smooth movement and flight stay inside.
 *
 * The scans are images, not strokes: each `frame.webp` on a plane at the painting's true size,
 * cropped by UV to its true aspect, sRGB with mipmaps and anisotropy. The walls, floor, ceiling,
 * benches and frame mouldings are strokes over one flat base mesh.
 */
import {
  type BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Scene,
  SRGBColorSpace,
  Texture,
} from 'three';
import { registerDiag, unregisterDiag } from '../../diag/diag';
import { createStrokeBatchSteps, type StrokeBatch } from '../../render/strokes/batch';
import type { Vec3 } from '../../render/strokes/frame';
import {
  buildSteps,
  type PainterCamera,
  type WorldDeps,
  type WorldHandle,
  type WorldPose,
} from '../world-module';
import {
  CROP_BIAS,
  coverCrop,
  galleryBlocked,
  galleryBoundary,
  HANGINGS,
  type Hanging,
  ROOM,
  SCAN_DEPTH,
  type UvCrop,
  WALK_MARGIN,
  wallPoint,
} from './layout';
import { underpaint } from './palette';
import type { Plaques } from './plaques';
import {
  createBaseGeometry,
  DEFAULT_GALLERY_SEED,
  gallerySurfaces,
  scatterGallerySteps,
} from './surfaces';

export const PAINTING_ID = 'gallery';
/** Chunk grid edge, metres: a room's surfaces fall into a few dozen chunks. */
export const GALLERY_CELL_SIZE = 2.5;
const BARE_COLOR = 0xff00ff;
/**
 * Same as the Starry Night base meshes: drawn before the strokes under the default policy, pushed
 * back in depth.
 */
const BASE_MESH_RENDER_ORDER = 1_000_000;
/**
 * Depth priority of a scan over the wall strokes behind it: the stroke tie-break moves a stroke up
 * to 2048 depth steps toward the eye, which from across the room is more than the scan's 48 mm.
 */
const SCAN_DEPTH_UNITS = -2400;
/** The texture anisotropy wanted for a plaque-distance read; capped by the renderer. */
const SCAN_ANISOTROPY = 8;
const UP: Vec3 = Object.freeze([0, 1, 0]) as Vec3;

/** The fixed shot of the Starry Night wall (`?painter`), at a 16:9 capture. */
export const GALLERY_PAINTER_CAMERA: PainterCamera = Object.freeze({
  eye: Object.freeze([0, 1.6, 0]) as Vec3,
  yaw: 0,
  pitch: 0,
  fovYDeg: 46,
  aspect: 16 / 9,
});

export interface GalleryBuildTimes {
  /** Waiting for the seven scans after the scatter, ms (they load during it). */
  decodeMs: number;
  /** The surface list. */
  generateMs: number;
  scatterMs: number;
  /** `createStrokeBatch`, atlas excluded. */
  batchMs: number;
  buildMs: number;
}

/** One frame's scan in `__goghDiag().world.frames`. */
export interface FrameDiag {
  id: string;
  loaded: boolean;
  naturalWidth: number;
  naturalHeight: number;
  /** The share of the scan's width and height shown after the aspect crop. */
  keep: [number, number];
}

interface Built {
  readonly scene: Scene;
  readonly batch: StrokeBatch;
  readonly root: Group;
  readonly base: Mesh<BufferGeometry, MeshBasicMaterial>;
  readonly scans: Mesh<PlaneGeometry, MeshBasicMaterial>[];
  readonly textures: Texture[];
  readonly background: Scene['background'];
  plaques: Plaques | null;
  disposed: boolean;
}

let built: Built | null = null;

/** A plane at the painting's true size showing `crop` of its texture. */
function scanGeometry(h: Hanging, crop: UvCrop): PlaneGeometry {
  const geometry = new PlaneGeometry(h.width, h.height);
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      crop.u0 + uv.getX(i) * (crop.u1 - crop.u0),
      crop.v0 + uv.getY(i) * (crop.v1 - crop.v0),
    );
  }
  return geometry;
}

/**
 * A scan as an `ImageBitmap`, which the browser decodes off the main thread (P5.5), so a portal
 * transition's upload of it is the copy alone. WebGL ignores `flipY` for a bitmap, so the decode
 * flips it instead, which matches `TextureLoader`'s flipped image.
 */
async function loadScan(url: string, anisotropy: number): Promise<Texture | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob(), {
      imageOrientation: 'flipY',
      premultiplyAlpha: 'none',
    });
    const texture = new Texture(bitmap);
    texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
    return texture;
  } catch (error) {
    console.warn(`gallery: scan ${url} failed to load`, error);
    return null;
  }
}

export async function build(deps: WorldDeps): Promise<WorldHandle> {
  if (built) throw new Error('the gallery is already built; dispose it first');
  const seed = deps.seed ?? DEFAULT_GALLERY_SEED;
  const debug = deps.debug ?? null;
  const anisotropy = Math.max(1, Math.min(SCAN_ANISOTROPY, deps.maxAnisotropy ?? 1));
  const { run, nextFrame } = buildSteps(deps.slicer);
  const start = performance.now();
  const loads = HANGINGS.map((h) =>
    loadScan(`${import.meta.env.BASE_URL}${h.painting.frameImage}`, anisotropy),
  );

  const surfaces = gallerySurfaces();
  const generated = performance.now();
  const { buffers, counts } = await run(scatterGallerySteps(surfaces, seed));
  const scattered = performance.now();
  const batch = await run(
    createStrokeBatchSteps(buffers, { cellSize: GALLERY_CELL_SIZE, atlas: deps.atlas }),
  );
  const batched = performance.now();
  const atlasMs = batch.stats().atlasMs;
  const textures = await Promise.all(loads);
  const loaded = performance.now();
  const times: GalleryBuildTimes = {
    decodeMs: loaded - batched,
    generateMs: generated - start,
    scatterMs: scattered - generated,
    batchMs: batched - scattered - atlasMs,
    buildMs: loaded - start - atlasMs,
  };

  const { scene } = deps;
  const root = new Group();
  root.name = 'gallery';
  const base = new Mesh(
    createBaseGeometry(surfaces),
    new MeshBasicMaterial({
      color: debug ? BARE_COLOR : 0xffffff,
      vertexColors: debug === null,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 4,
    }),
  );
  base.name = 'gallery-base';
  base.renderOrder = BASE_MESH_RENDER_ORDER;
  base.matrixAutoUpdate = false;
  root.add(base);

  const frames: FrameDiag[] = [];
  const scans: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  HANGINGS.forEach((h, i) => {
    const texture = textures[i];
    const image = texture?.image as ImageBitmap | undefined;
    const naturalWidth = image?.width ?? 0;
    const naturalHeight = image?.height ?? 0;
    const crop = texture
      ? coverCrop(naturalWidth, naturalHeight, h.width, h.height, CROP_BIAS[h.painting.id] ?? 0)
      : { u0: 0, u1: 1, v0: 0, v1: 1 };
    // A scan that failed to load shows its wall's moulding gold as a flat placeholder.
    const placeholder = underpaint('moulding');
    const material = new MeshBasicMaterial({
      map: debug === 'bare' ? null : texture,
      color:
        debug === 'bare'
          ? new Color(BARE_COLOR)
          : texture
            ? new Color(0xffffff)
            : new Color().setRGB(
                placeholder[0] / 255,
                placeholder[1] / 255,
                placeholder[2] / 255,
                SRGBColorSpace,
              ),
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: SCAN_DEPTH_UNITS,
    });
    const mesh = new Mesh(scanGeometry(h, crop), material);
    mesh.name = `scan-${h.painting.id}`;
    mesh.position.set(...wallPoint(h.wall, h.s, h.y, SCAN_DEPTH));
    mesh.rotation.y = Math.atan2(h.wall.normal[0], h.wall.normal[2]);
    root.add(mesh);
    scans.push(mesh);
    frames.push({
      id: h.painting.id,
      loaded: texture !== null && naturalWidth > 0,
      naturalWidth,
      naturalHeight,
      keep: [crop.u1 - crop.u0, crop.v1 - crop.v0],
    });
  });

  const background = scene.background;
  const ceiling = underpaint('ceiling');
  scene.background = debug
    ? new Color(BARE_COLOR)
    : new Color().setRGB(ceiling[0] / 255, ceiling[1] / 255, ceiling[2] / 255, SRGBColorSpace);
  scene.add(root);
  batch.attach(scene);
  if (debug === 'bare') batch.group.visible = false;
  const state: Built = {
    scene,
    batch,
    root,
    base,
    scans,
    textures: textures.filter((t): t is Texture => t !== null),
    background,
    plaques: null,
    disposed: false,
  };
  built = state;

  // The plaques typeset after the build, off its critical path; `?bare` never builds them.
  let plaqueState: 'pending' | 'built' | 'failed' | 'skipped' =
    debug === 'bare' ? 'skipped' : 'pending';
  let plaqueMs = 0;
  let ready: Promise<void> = Promise.resolve();
  if (debug !== 'bare') {
    const plaqueStart = performance.now();
    ready = import('./plaques')
      .then(({ createPlaques }) => createPlaques(HANGINGS, deps.plaqueFrame ?? nextFrame))
      .then((plaques) => {
        if (state.disposed) {
          plaques.dispose();
          return;
        }
        state.plaques = plaques;
        root.add(plaques.group);
        plaqueMs = performance.now() - plaqueStart;
        plaqueState = 'built';
      })
      .catch((error: unknown) => {
        plaqueState = 'failed';
        console.warn('gallery: plaques failed to build', error);
      });
  }

  const total = buffers.count;
  registerDiag('world', () => ({
    painting: PAINTING_ID,
    seed,
    debug,
    counts,
    total,
    times,
    cache: 'bypass',
    strokes: batch.stats(),
    frames,
    plaques: {
      state: plaqueState,
      ms: plaqueMs,
      drawCallsPerPlaque: state.plaques?.drawCallsPerPlaque ?? 0,
      lines: state.plaques?.lines ?? 0,
      texts: state.plaques?.texts ?? [],
    },
  }));

  return {
    batch,
    ground: { heightAt: () => 0, normalAt: () => UP },
    boundaryFactor: galleryBoundary,
    blocked: galleryBlocked,
    walkBounds: {
      minX: ROOM.minX + WALK_MARGIN,
      maxX: ROOM.maxX - WALK_MARGIN,
      minZ: ROOM.minZ + WALK_MARGIN,
      maxZ: ROOM.maxZ - WALK_MARGIN,
      maxY: ROOM.height - WALK_MARGIN,
    },
    ready,
  };
}

/** Nothing in the room moves. */
export function update(_time: number, _dt: number): void {}

export function dispose(): void {
  if (!built) return;
  unregisterDiag('world');
  built.disposed = true;
  built.plaques?.dispose();
  built.batch.dispose();
  built.root.removeFromParent();
  built.base.geometry.dispose();
  built.base.material.dispose();
  for (const scan of built.scans) {
    scan.geometry.dispose();
    scan.material.dispose();
  }
  for (const texture of built.textures) {
    texture.dispose();
    (texture.image as ImageBitmap).close();
  }
  built.scene.background = built.background;
  built = null;
}

/** 4 m from the Starry Night wall, facing it. */
export function painterSpot(): WorldPose {
  return { position: [0, 0, 0], yaw: 0 };
}

export function painterCamera(): PainterCamera {
  return { ...GALLERY_PAINTER_CAMERA, eye: [...GALLERY_PAINTER_CAMERA.eye] };
}

export function spawnPose(): WorldPose {
  return painterSpot();
}
