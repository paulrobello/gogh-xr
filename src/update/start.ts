/**
 * Boot wiring for the update flow (P7.1): reads the running build id, applies the poll policy and
 * starts polling `version.json` next to index.html. Null where the policy says no poller runs.
 * Whatever the policy, an update reload's `_reload` parameter leaves the address bar.
 */
import { readRunningBuildId, shouldPoll } from './policy';
import { stripReloadParam } from './reload';
import { createUpdates, type Updates, type UpdatesDeps } from './updates';

declare global {
  interface Window {
    /** `?diag` with a poller only: one poll now, resolved once it settles. */
    __goghUpdateCheck?: () => Promise<void>;
  }
}

export interface StartUpdatesOptions
  extends Omit<UpdatesDeps, 'runningBuildId' | 'url' | 'location'> {
  flag: boolean | null;
  bench: boolean;
  mode: string;
  /** `import.meta.env.BASE_URL`: the manifest sits beside index.html. */
  base: string;
}

export function startUpdates(options: StartUpdatesOptions): Updates | null {
  const clean = stripReloadParam(window.location.href);
  if (clean !== window.location.href) window.history.replaceState(window.history.state, '', clean);
  const runningBuildId = readRunningBuildId();
  const { flag, bench, mode, base, ...deps } = options;
  if (runningBuildId === null || !shouldPoll({ runningBuildId, flag, bench, mode })) return null;
  const updates = createUpdates({
    ...deps,
    runningBuildId,
    url: new URL(`${base}version.json`, window.location.href).href,
    location: window.location,
  });
  // A page kept in the back-forward cache comes back still polling.
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) updates.dispose();
  });
  updates.start();
  return updates;
}
