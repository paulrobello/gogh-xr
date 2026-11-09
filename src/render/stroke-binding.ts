/**
 * The stroke batch the app currently governs and counts on the HUD. `bind` swaps it: the old
 * batch's governor is disposed before anything else, so neither the governor nor the HUD count
 * touches a batch after it is released, and a new governor starts against the new batch from full
 * quality. World switching (P2, PRD D14) calls `bind` with the next world's batch, or null.
 *
 * The governor module loads lazily. A bind made while an earlier one is still loading wins, and
 * the earlier one starts nothing.
 */
import type { GovernorMode } from './governor';
import type { GovernedBatch, GovernorDiag, GovernorRuntime } from './governor-runtime';
import type { StrokeBatch } from './strokes/batch';

export type BoundBatch = GovernedBatch &
  Pick<StrokeBatch, 'visibleCount' | 'visibleChunkCount'> &
  Partial<Pick<StrokeBatch, 'drawOrder'>>;

/** Starts the quality governor for one batch. */
export type GovernorStarter = (batch: GovernedBatch) => GovernorRuntime;

export interface StrokeBindingDeps {
  /** Loads the governor; null keeps it off (`?nogov`, the bench). */
  loadGovernor: (() => Promise<GovernorStarter>) | null;
}

export interface StrokeBinding {
  readonly batch: BoundBatch | null;
  /**
   * Releases the current batch's governor, then binds `batch`, or nothing for null. Resolves once
   * its governor runs, or failed to start (logged).
   */
  bind(batch: BoundBatch | null): Promise<void>;
  /** Drives the governor, if one runs; call once per animation frame before rendering. */
  frame(time: number): void;
  governorDiag(): GovernorDiag | null;
  /** The running governor's mode, or null with none running. */
  governorMode(): GovernorMode | null;
  /** The bound batch's drawn strokes, or null with no batch bound. */
  visibleCount(): number | null;
  /** The bound batch's chunks that passed the last cull, or null with no batch bound. */
  visibleChunkCount(): number | null;
}

export function createStrokeBinding(deps: StrokeBindingDeps): StrokeBinding {
  let current: BoundBatch | null = null;
  let governor: GovernorRuntime | null = null;
  let generation = 0;

  return {
    get batch() {
      return current;
    },
    async bind(batch: BoundBatch | null) {
      const token = ++generation;
      governor?.dispose();
      governor = null;
      current = batch;
      if (!batch || !deps.loadGovernor) return;
      try {
        const start = await deps.loadGovernor();
        if (token !== generation) return;
        governor = start(batch);
      } catch (error) {
        console.warn('quality governor failed to start', error);
      }
    },
    frame(time: number) {
      governor?.frame(time);
    },
    governorDiag() {
      return governor?.diag() ?? null;
    },
    governorMode() {
      return governor?.mode ?? null;
    },
    visibleCount() {
      return current?.visibleCount() ?? null;
    },
    visibleChunkCount() {
      return current?.visibleChunkCount() ?? null;
    },
  };
}
