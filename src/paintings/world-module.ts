/**
 * The contract every painting world implements (PRD D14). A registry entry's `world()` resolves to
 * one; the gallery (P5) and the boot path only ever see this interface.
 */
import type { Object3D, Scene, Texture } from 'three';
import type { Raster } from '../demo/canvas/field';
import type { WalkBounds } from '../locomotion/walk-bounds';
import type { StrokeBatch } from '../render/strokes/batch';
import type { Vec3 } from '../render/strokes/frame';
import { drain, type Slicer, type Steps } from '../util/slicer';

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
  /**
   * Spreads the build's CPU work over frames (P5.5), for a build behind a portal transition.
   * Omitted (the boot): the build runs its steps at once, with the same result.
   */
  readonly slicer?: Slicer;
  /**
   * The brush atlas the caller owns and shares across worlds (P5.5); the world's batch uses it and
   * never disposes it. Omitted: the batch builds and owns its own.
   */
  readonly atlas?: Texture;
  /**
   * Resolves at the next animation frame: the gallery typesets one plaque per frame on it (P5.5,
   * review M5), at boot too. Omitted: the slicer's frame, or no wait without one.
   */
  readonly plaqueFrame?: () => Promise<void>;
}

/** `deps.slicer`'s `step` and `run`, or the same work at once without one. */
export function buildSteps(slicer: Slicer | undefined): {
  step<T>(work: () => T, label?: string): Promise<T>;
  run<T>(steps: Steps<T>, label?: string): Promise<T>;
  nextFrame(): Promise<void>;
} {
  return {
    step: (work, label) => (slicer ? slicer.step(work, label) : Promise.resolve(work())),
    run: (steps, label) => (slicer ? slicer.run(steps, label) : Promise.resolve(drain(steps))),
    nextFrame: () => (slicer ? slicer.nextFrame() : Promise.resolve()),
  };
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
   * Shows or hides the halo pass at runtime, for the `halo` A/B group. The `?bare` and `?coverage`
   * debug paints keep it hidden. Omitted: a world without one.
   */
  setHalo?(on: boolean): void;
  /** The halo pass, so a hidden one can be precompiled before its first show. */
  readonly halo?: Object3D;
  /**
   * An indoor world's walls and ceiling: smooth movement and flight keep the head inside them
   * (src/locomotion/walk-bounds.ts). Omitted: an open world, never clamped.
   */
  readonly walkBounds?: WalkBounds;
  /**
   * Resolves once the parts the world adds after `build` resolves (the gallery's plaques) are in
   * the scene, or have failed or been skipped; never rejects. A portal transition waits on it to
   * compile them before the world shows. Omitted: nothing comes after the build.
   */
  readonly ready?: Promise<void>;
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
