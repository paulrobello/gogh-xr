/**
 * The painting registry (PRD D14). One live entry for now; P5.1 adds the coming-soon paintings and
 * the registry validation.
 */
import type { WorldModule } from './world-module';

export interface PaintingEntry {
  readonly id: string;
  readonly title: string;
  readonly year: number;
  readonly museum: string;
  /** Key of the painting's row in assets/PROVENANCE.md. */
  readonly scanProvenance: string;
  /** Framed scan under public/, relative to the base URL. */
  readonly frameImage: string;
  readonly status: 'live' | 'coming-soon';
  readonly world?: () => Promise<WorldModule>;
}

export const PAINTINGS: readonly PaintingEntry[] = Object.freeze([
  Object.freeze({
    id: 'starry-night',
    title: 'The Starry Night',
    year: 1889,
    museum: 'Museum of Modern Art, New York',
    scanProvenance: 'starry-night',
    frameImage: 'paintings/starry-night/frame.webp',
    status: 'live',
    world: () => import('./starry-night/index'),
  } satisfies PaintingEntry),
]);

/**
 * The live entry with a world for `id`. Null for no id; an unknown or coming-soon id also logs a
 * warning and returns null, so the caller boots the bare scene.
 */
export function livePainting(id: string | null): PaintingEntry | null {
  if (id === null) return null;
  const entry = PAINTINGS.find((p) => p.id === id);
  if (entry?.status === 'live' && entry.world) return entry;
  console.warn(`painting "${id}" is ${entry ? 'not live yet' : 'unknown'}; booting the bare scene`);
  return null;
}
