/**
 * Where the build poller runs (P7.1). Only a build carries an id (`scripts/build-version.ts`), so
 * the dev server never polls. A production build polls unless `?update=0`. An e2e build polls
 * only with `?update`, so no other spec sees a reload when the served build changes under it.
 * The bench never polls.
 */
import { BUILD_ID_META } from './build-id';

const BUILD_ID = /^[a-f0-9]{64}$/;

/** The id index.html carries, or null in the dev server and in a page without one. */
export function readRunningBuildId(doc: Pick<Document, 'querySelector'> = document): string | null {
  const content = doc.querySelector(`meta[name="${BUILD_ID_META}"]`)?.getAttribute('content');
  return content && BUILD_ID.test(content) ? content : null;
}

export interface PollPolicy {
  runningBuildId: string | null;
  /** `?update`: true forces polling in an e2e build, false turns it off anywhere, null is the default. */
  flag: boolean | null;
  /** `?bench` is set. */
  bench: boolean;
  /** `import.meta.env.MODE`. */
  mode: string;
}

export function shouldPoll({ runningBuildId, flag, bench, mode }: PollPolicy): boolean {
  if (bench || runningBuildId === null || flag === false) return false;
  return flag === true || mode === 'production';
}

/**
 * A detected build reloads by itself only on the desktop: never in XR, and never while the page is
 * busy (an XR entry or a portal transition).
 */
export function shouldAutoReload(available: boolean, presenting: boolean, busy: boolean): boolean {
  return available && !presenting && !busy;
}
