/**
 * The update reload (P7.1), after mux-xr's `reload.ts`: the page URL with a fresh `_reload` query,
 * so a cached index.html cannot serve the old build again, keeping every other query parameter
 * byte for byte (`?hud` stays `?hud`) and the fragment. The new page strips `_reload` again.
 */

/** The query parameter the reload sets. The flags parser ignores it. */
export const RELOAD_PARAM = '_reload';

/** `href` split into the part before the query, the query's parts, and the fragment. */
function split(href: string): { base: string; parts: string[]; hash: string } {
  const hashAt = href.indexOf('#');
  const hash = hashAt >= 0 ? href.slice(hashAt) : '';
  const rest = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const queryAt = rest.indexOf('?');
  const base = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
  const query = queryAt >= 0 ? rest.slice(queryAt + 1) : '';
  const parts = query
    .split('&')
    .filter((part) => part !== '' && part.split('=')[0] !== RELOAD_PARAM);
  return { base, parts, hash };
}

function join(base: string, parts: string[], hash: string): string {
  return `${base}${parts.length ? `?${parts.join('&')}` : ''}${hash}`;
}

export function reloadUrl(href: string, now: number): string {
  const { base, parts, hash } = split(href);
  return join(base, [...parts, `${RELOAD_PARAM}=${now}`], hash);
}

/** `href` without its `_reload` parameter; unchanged when it has none. */
export function stripReloadParam(href: string): string {
  const { base, parts, hash } = split(href);
  return join(base, parts, hash);
}

/**
 * Waits for `exitXR` (which resolves at once outside XR), runs `beforeNavigate` (the settings
 * flush), then replaces the page with `reloadUrl`. A failed exit rejects and never navigates.
 */
export async function reloadAfterXR(
  exitXR: () => Promise<void>,
  location: Pick<Location, 'href' | 'replace'>,
  beforeNavigate: () => void = () => {},
  now: () => number = Date.now,
): Promise<void> {
  await exitXR();
  beforeNavigate();
  location.replace(reloadUrl(location.href, now()));
}
