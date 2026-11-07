/**
 * The live settings store (P5.3): the one copy of the stored settings that the XR panel, the DOM
 * panel and the HUD shortcuts all write. A change updates the stored settings, recomputes the
 * effective ones (the stored ones under this session's URL flags), tells every subscriber at once
 * (live apply), and saves through `saveSettings` after a quiet `delayMs`, or at once on `commit`
 * (a control's release). A field a URL flag decides is locked: an edit to it is refused, so a flag
 * value is never written back.
 */
import {
  applyUrlFlags,
  lockedSettings,
  type Settings,
  type SettingsFlags,
  type SettingsLocks,
  sanitizeSettings,
  saveSettings,
} from './schema';

/** A quiet period, ms, before a change saves on its own. */
export const SAVE_DELAY_MS = 500;

export type SettingsListener = (effective: Settings, key: keyof Settings) => void;

export interface SettingsStoreDeps {
  readonly stored: Settings;
  readonly flags: SettingsFlags;
  /** Writes the stored settings. Defaults to `saveSettings` on `localStorage`. */
  readonly save?: (settings: Settings) => boolean;
  /** The debounce timer. Default `setTimeout` and `clearTimeout`. */
  readonly schedule?: (callback: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
  readonly delayMs?: number;
}

export interface SettingsStore {
  /** What is saved: never holds a URL flag's value for a locked field. */
  readonly stored: Settings;
  /** What the session runs with. */
  readonly effective: Settings;
  readonly locks: SettingsLocks;
  isLocked(key: keyof Settings): boolean;
  /**
   * Sets a stored field (sanitized). False when the field is locked or the sanitized value is
   * unchanged; nothing is notified or scheduled then.
   */
  set<K extends keyof Settings>(key: K, value: Settings[K]): boolean;
  /** Saves a pending change now. Call on a control's release. */
  commit(): void;
  /** True while a change waits for its save. */
  readonly pending: boolean;
  /** Saves so far, for the e2e and the tests. */
  readonly saves: number;
  subscribe(listener: SettingsListener): () => void;
}

export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  const save = deps.save ?? ((settings: Settings) => saveSettings(settings));
  const schedule = deps.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const delayMs = deps.delayMs ?? SAVE_DELAY_MS;
  const locks = lockedSettings(deps.flags);
  const listeners = new Set<SettingsListener>();
  let stored = deps.stored;
  let effective = applyUrlFlags(stored, deps.flags);
  let timer: unknown = null;
  let pending = false;
  let saves = 0;

  function flush(): void {
    if (timer !== null) cancel(timer);
    timer = null;
    if (!pending) return;
    pending = false;
    saves += 1;
    save(stored);
  }

  return {
    get stored() {
      return stored;
    },
    get effective() {
      return effective;
    },
    locks,
    isLocked: (key) => locks[key] !== undefined,
    set(key, value) {
      if (locks[key] !== undefined) return false;
      const next = sanitizeSettings({ ...stored, [key]: value });
      if (next[key] === stored[key]) return false;
      stored = next;
      effective = applyUrlFlags(stored, deps.flags);
      pending = true;
      if (timer !== null) cancel(timer);
      timer = schedule(flush, delayMs);
      for (const listener of listeners) listener(effective, key);
      return true;
    },
    commit: flush,
    get pending() {
      return pending;
    },
    get saves() {
      return saves;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
