/**
 * Which scene a boot builds (P5.4). In order of precedence:
 * 1. `?bench`: the stroke benchmark, which ignores every scene flag.
 * 2. `?painting=<id>`: that painting's world when it is live. An unknown or coming-soon id warns
 *    (in `livePainting`) and is otherwise ignored, so it falls through to the rest of this list:
 *    a stale or coming-soon link opens the gallery, where that painting hangs.
 * 3. `?strokesTest` or `?demo=canvas`: their test scenes, which main.ts starts itself.
 * 4. `?scene=bare`: the bare scene, placeholder ground and grid. The only way to reach it.
 * 5. Otherwise the gallery, the default entry scene.
 */
import type { Flags } from './diag/flags';
import type { PaintingEntry } from './paintings/registry';
import type { WorldModule } from './paintings/world-module';

export type BootMode =
  | { readonly kind: 'bench' }
  | { readonly kind: 'painting'; readonly entry: PaintingEntry }
  | { readonly kind: 'test-scene' }
  | { readonly kind: 'bare' }
  | { readonly kind: 'gallery' };

export type BootFlags = Pick<Flags, 'bench' | 'painting' | 'strokesTest' | 'demo' | 'scene'>;

/** A world main.ts boots: a live painting's, or the gallery. */
export interface BootWorld {
  readonly id: string;
  readonly world: () => Promise<WorldModule>;
}

export const GALLERY_WORLD: BootWorld = Object.freeze({
  id: 'gallery',
  world: () => import('./paintings/gallery/index'),
});

export function resolveBootMode(
  flags: BootFlags,
  livePainting: (id: string | null) => PaintingEntry | null,
): BootMode {
  if (flags.bench !== null) return { kind: 'bench' };
  const entry = flags.painting === null ? null : livePainting(flags.painting);
  if (entry) return { kind: 'painting', entry };
  if (flags.strokesTest || flags.demo !== null) return { kind: 'test-scene' };
  if (flags.scene === 'bare') return { kind: 'bare' };
  return { kind: 'gallery' };
}

/** The world a boot mode builds, or null for a scene without one. */
export function bootWorld(mode: BootMode): BootWorld | null {
  if (mode.kind === 'painting' && mode.entry.world) {
    return { id: mode.entry.id, world: mode.entry.world };
  }
  return mode.kind === 'gallery' ? GALLERY_WORLD : null;
}
