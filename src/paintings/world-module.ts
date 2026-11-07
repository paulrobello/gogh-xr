/**
 * The contract every painting world implements (PRD D14). A registry entry's `world()` resolves to
 * one; the gallery (P5) and the boot path only ever see this interface.
 */
import type { Scene } from 'three';
import type { Raster } from '../demo/canvas/field';
import type { WalkBounds } from '../locomotion/walk-bounds';
import type { StrokeBatch } from '../render/strokes/batch';
import type { Vec3 } from '../render/strokes/frame';

/** A standing pose: a floor position and a heading. Yaw 0 faces -Z, positive turns left. */
export interface WorldPose {
  readonly position: Vec3;
  readonly yaw: number;
}

/** The painter camera: the eye, heading and lens whose frame is exactly canvas uv [0, 1]². */
export interface PainterCamera {
  readonly eye: Vec3;
  /** Yaw 0 faces -Z, positive turns left. */
  readonly yaw: number;
  /** Radians, positive looks up. */
  readonly pitch: number;
  readonly fovYDeg: number;
  /** Width over height of the canvas. */
  readonly aspect: number;
}

/** Fetches and decodes an image to RGBA8; `data` images skip colour-space conversion. */
export type RasterLoader = (url: string, data: boolean) => Promise<Raster>;

/**
 * Base-mesh debug paint, honoured with `?diag` only. 'bare' paints every base mesh and the clear
 * colour magenta and hides the strokes; 'coverage' does the same but keeps the strokes, so any
 * magenta left on screen is a gap.
 */
export type WorldDebug = 'bare' | 'coverage';

export interface WorldDeps {
  readonly scene: Scene;
  /** `?seed`; null means the world's default seed. */
  readonly seed: number | null;
  readonly loadRaster: RasterLoader;
  /** `?nocache`: skip any build cache. */
  readonly nocache?: boolean;
  /** `?cache`: use the build cache in a non-production build. `nocache` wins over it. */
  readonly cache?: boolean;
  readonly debug?: WorldDebug | null;
  /** `?nohalo` clears it: the world draws no halo pass. Default true. */
  readonly halo?: boolean;
  /** The renderer's texture anisotropy cap, for a world's image textures. Default 1. */
  readonly maxAnisotropy?: number;
}

/** The walkable ground: the surface a viewer stands on. */
export interface WorldGround {
  /** Ground height at (x, z), metres. */
  heightAt(x: number, z: number): number;
  /** Unit upward normal of the ground at (x, z). */
  normalAt(x: number, z: number): Vec3;
}

export interface WorldHandle {
  /** The world's one stroke batch, already attached; the caller binds the governor to it. */
  readonly batch: StrokeBatch;
  /** The built world's ground, for locomotion (P3). */
  readonly ground: WorldGround;
  /** 0 inside the world, 1 at and beyond its edge, smooth between: locomotion pushes back on it. */
  boundaryFactor(position: Vec3): number;
  /**
   * True where (x, z) is inside a building's footprint or within a small margin of its walls:
   * no teleport lands there (P3.4). Omitted: a world without buildings.
   */
  blocked?(x: number, z: number): boolean;
  /**
   * Thickens the boundary haze, 0-1, 0 being the world as built. Flight drives it near the edge
   * (P3.5). Omitted: a world without haze.
   */
  setHaze?(thickness: number): void;
  /**
   * An indoor world's walls and ceiling: smooth movement and flight keep the head inside them
   * (src/locomotion/walk-bounds.ts). Omitted: an open world, never clamped.
   */
  readonly walkBounds?: WalkBounds;
}

export interface WorldModule {
  /** Builds the world into `deps.scene`. One world at a time: dispose before building again. */
  build(deps: WorldDeps): Promise<WorldHandle>;
  /** Per-frame hook, seconds since start and since the last frame. */
  update(time: number, dt: number): void;
  /** Removes the built world from its scene and releases its GPU resources. */
  dispose(): void;
  /** Where a viewer starts. */
  spawnPose(): WorldPose;
  /** The vantage that reproduces the painting's framing. */
  painterSpot(): WorldPose;
  /** The camera at the painter's spot that frames exactly the canvas (`?painter`). */
  painterCamera(): PainterCamera;
}
