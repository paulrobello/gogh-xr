/**
 * The boot's world start with its fallback (card 01a1c05452e4): a `?painting` world whose import
 * is bounded (`boundedImport`, so a stalled chunk fetch times out) and that cannot
 * be imported or built reports the failure and boots the gallery
 * instead, which is also where an unknown or coming-soon id lands (`boot-mode.ts`). A failing
 * gallery reports and stops: the scene stays empty, as before. Pure of three and the DOM.
 */
import type { BootWorld } from './boot-mode';
import { boundedImport } from './paintings/world-module';

export interface BootWorldDeps<M> {
  /** Imports `world`'s module and anything built beside it. The caller bounds it. */
  load(world: BootWorld): Promise<M>;
  /** Spawns into, builds and adopts the module. Disposes its own half-built world on a throw. */
  start(world: BootWorld, module: M): Promise<void>;
  /** A world failed to load or build: warn and tell the user. Called once per failed world. */
  failed(world: BootWorld, error: unknown): void;
}

export async function bootWorldWithFallback<M>(
  entry: BootWorld,
  gallery: BootWorld,
  deps: BootWorldDeps<M>,
): Promise<void> {
  const attempt = async (world: BootWorld): Promise<boolean> => {
    try {
      await deps.start(world, await boundedImport(deps.load(world)));
      return true;
    } catch (error) {
      deps.failed(world, error);
      return false;
    }
  };
  if ((await attempt(entry)) || entry.id === gallery.id) return;
  await attempt(gallery);
}
