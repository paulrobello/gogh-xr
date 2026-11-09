/**
 * The served A-to-B update check (P7.1, P7-A1). It builds two genuinely different e2e bundles from
 * this tree (`GOGH_BUILD_SHA` differs, so chunk contents and names differ), serves A on one origin
 * like GitHub Pages (every response `Cache-Control: max-age=600`), then switches that origin to B:
 *
 * - Desktop: the page detects B on a real 30 s poll and reloads by itself, with no click, keeping
 *   its query and fragment, and comes back running B with no update notice.
 * - XR (IWER): the page shows the update notice with its Reload action, visible as computed on
 *   the HUD stack (the button and every ancestor visible) and on the page, and does not reload
 *   across further polls. Only a trigger on Reload ends the session and then navigates; it comes
 *   back running B, out of XR, with no notice.
 *
 * B is also served alone on a second port, to check its page embeds the id its manifest names.
 *
 *   bun scripts/update-ab.ts [--out dir]
 *
 * Ports: E2E_PORT (default 4298) and UPDATE_B_PORT (default 4299). Before each mode it waits up to
 * 15 minutes for the 1-minute load average to reach 15 and for any running `playwright test` to
 * finish, and it records the load before and after. Writes `result.json` and screenshots to --out.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { loadavg, tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';
import { gpuArgs } from '../tests/e2e/gpu.ts';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? (args[outIndex + 1] ?? '') : join(tmpdir(), 'gogh-update-ab');
const PORT = Number(process.env.E2E_PORT ?? 4298);
const B_PORT = Number(process.env.UPDATE_B_PORT ?? 4299);
const LOAD_LIMIT = 15;
const LOAD_WAIT_MS = 15 * 60_000;
/** The desktop reload must land within one 30 s interval plus the 5 s timeout and slack. */
const DESKTOP_DEADLINE_MS = 45_000;

mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'gogh-update-ab-'));

function fail(message: string): never {
  throw new Error(`update-ab: ${message}`);
}

function build(dir: string, sha: string): string {
  const run = spawnSync(
    'bunx',
    ['vite', 'build', '--mode', 'e2e', '--outDir', dir, '--emptyOutDir'],
    {
      env: { ...process.env, GOGH_BUILD_SHA: sha },
      encoding: 'utf8',
      timeout: 300_000,
    },
  );
  if (run.status !== 0) fail(`build ${sha} exited ${run.status}: ${run.stderr}`);
  const manifest = JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')) as {
    buildId: string;
  };
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  if (!html.includes(`content="${manifest.buildId}"`))
    fail(`build ${sha}: index.html lacks its id`);
  return manifest.buildId;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

/** A static server like Pages: every response may be cached for 10 minutes. */
async function serve(port: number, root: () => string): Promise<Server> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    const relative = normalize(path === '/' ? '/index.html' : path);
    if (relative.includes('..')) {
      response.writeHead(400).end('bad path');
      return;
    }
    readFile(join(root(), relative)).then(
      (body) => {
        response.writeHead(200, {
          'Content-Type': TYPES[extname(relative)] ?? 'application/octet-stream',
          'Cache-Control': 'max-age=600',
        });
        response.end(body);
      },
      () => response.writeHead(404).end('not found'),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const playwrightRunning = (): boolean =>
  spawnSync('pgrep', ['-f', 'node.*playwright test'], { encoding: 'utf8' }).status === 0;

async function waitForHost(): Promise<{ load: number; waitedMs: number; affected: boolean }> {
  const start = Date.now();
  while (Date.now() - start < LOAD_WAIT_MS) {
    if ((loadavg()[0] ?? 0) <= LOAD_LIMIT && !playwrightRunning()) break;
    await sleep(15_000);
  }
  const load = loadavg()[0] ?? 0;
  return { load, waitedMs: Date.now() - start, affected: load > LOAD_LIMIT };
}

interface UpdateDiag {
  running: string;
  available: string | null;
  reloading: boolean;
  checks: number;
}

interface NoticesDiag {
  queue: { kind: string; text: string }[];
  view: {
    visible: boolean;
    typeset: boolean;
    actions: {
      kind: string;
      label: string;
      center: number[];
      hovered: boolean;
      visible: boolean;
    }[];
  } | null;
}

interface PageDiag {
  update?: UpdateDiag;
  notices?: NoticesDiag;
  xr: { presenting: boolean };
  renderer: { frame: number };
}

const diag = (page: Page): Promise<PageDiag | null> =>
  page.evaluate(() => (window.__goghDiag?.() as unknown as PageDiag | undefined) ?? null);

/** Computed visibility of the page's update notice and its Reload button. */
const domNotice = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-notice-kind="update-ready"]');
    const reload = el?.querySelector<HTMLElement>('[data-notice-action="reload"]');
    return {
      present: el !== null && el !== undefined,
      visible: el?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ?? false,
      reloadVisible:
        reload?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ?? false,
      display: el ? getComputedStyle(el).display : null,
    };
  });

function watch(page: Page) {
  const state = { navigations: 0, polls: 0, documents: [] as string[], errors: [] as string[] };
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) state.navigations += 1;
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/version.json') state.polls += 1;
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      state.documents.push(request.url());
  });
  page.on('console', (message) => {
    if (new URL(message.location().url || 'about:blank').pathname === '/favicon.ico') return;
    if (message.type() === 'error') state.errors.push(message.text());
  });
  page.on('pageerror', (error) => state.errors.push(error.message));
  return state;
}

/**
 * The reload's document request carries the start query byte for byte plus `_reload` (a request
 * URL has no fragment), and once booted the address bar is the start URL again: same query, same
 * fragment, `_reload` stripped.
 */
function checkUrl(start: string, requested: string | undefined, href: string) {
  const startUrl = new URL(start);
  const startQuery = startUrl.search;
  const reload = requested ? new URL(requested) : null;
  const requestKept = Boolean(
    reload && reload.search.startsWith(`${startQuery}&_reload=`) && reload.pathname === '/',
  );
  const addressBar = href === start;
  if (!requestKept || !addressBar)
    fail(`reload URL lost state: start ${start}, requested ${requested}, now ${href}`);
  return { requested, addressBar: href, requestKept, addressBarRestored: addressBar };
}

async function desktop(
  browser: Browser,
  ids: { a: string; b: string },
  use: (r: 'a' | 'b') => void,
) {
  use('a');
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ).newPage();
  const seen = watch(page);
  const start = `http://127.0.0.1:${PORT}/?diag&update&scene=bare&noanim#desk`;
  await page.goto(start);
  await page.waitForFunction(
    (a) => {
      const u = (window.__goghDiag?.() as { update?: UpdateDiag } | undefined)?.update;
      return u?.running === a && u.checks >= 1;
    },
    ids.a,
    { timeout: 60_000 },
  );
  if ((await domNotice(page)).present) fail('desktop: build A showed an update notice');
  const before = seen.navigations;
  const pollsBefore = seen.polls;
  use('b');
  const switched = Date.now();
  await page.waitForFunction(
    (b) => (window.__goghDiag?.() as { update?: UpdateDiag } | undefined)?.update?.running === b,
    ids.b,
    { timeout: DESKTOP_DEADLINE_MS, polling: 100 },
  );
  const reloadMs = Date.now() - switched;
  if (seen.navigations <= before) fail('desktop: no navigation');
  const url = checkUrl(start, seen.documents.at(-1), page.url());
  await page.waitForFunction(
    () =>
      ((window.__goghDiag?.() as { update?: UpdateDiag } | undefined)?.update?.checks ?? 0) >= 1,
    null,
    { timeout: 30_000 },
  );
  const after = await diag(page);
  const notice = await domNotice(page);
  if (notice.visible || after?.update?.available) fail('desktop: B still shows an update notice');
  await page.screenshot({ path: join(out, 'desktop-after-reload.png') });
  if (seen.errors.length) fail(`desktop: page errors: ${seen.errors.join(' | ')}`);
  await page.context().close();
  return {
    automaticReload: true,
    clicked: false,
    reloadMs,
    navigations: seen.navigations - before,
    pollsAfterSwitch: seen.polls - pollsBefore,
    url,
    after: { update: after?.update, notice },
  };
}

async function waitFrames(page: Page, count: number): Promise<void> {
  const start = (await diag(page))?.renderer.frame ?? 0;
  await page.waitForFunction(
    (target) =>
      ((window.__goghDiag?.() as { renderer: { frame: number } } | undefined)?.renderer.frame ??
        0) >= target,
    start + count,
    { timeout: 10_000 },
  );
}

async function xr(browser: Browser, ids: { a: string; b: string }, use: (r: 'a' | 'b') => void) {
  use('a');
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ).newPage();
  const seen = watch(page);
  const start = `http://127.0.0.1:${PORT}/?iwer&diag&update&scene=bare&noanim#xr`;
  await page.goto(start);
  await page.waitForFunction(
    (a) => {
      const u = (window.__goghDiag?.() as { update?: UpdateDiag } | undefined)?.update;
      return Boolean(window.__goghIwer) && u?.running === a && u.checks >= 1;
    },
    ids.a,
    { timeout: 60_000 },
  );
  // Order evidence that survives the navigation: the session's end, then the page's hide.
  await page.evaluate(() => {
    sessionStorage.removeItem('ab.end');
    sessionStorage.removeItem('ab.hide');
    const system = navigator.xr;
    if (!system) throw new Error('no navigator.xr');
    const real = system.requestSession.bind(system);
    system.requestSession = async (...request) => {
      const session = await real(...request);
      session.addEventListener('end', () =>
        sessionStorage.setItem('ab.end', String(performance.now())),
      );
      return session;
    };
    addEventListener('pagehide', () =>
      sessionStorage.setItem('ab.hide', String(performance.now())),
    );
  });
  await page.locator('#enter-vr').click();
  await page.waitForFunction(
    () =>
      Boolean(
        (window.__goghDiag?.() as { xr: { presenting: boolean } } | undefined)?.xr.presenting,
      ),
    null,
    { timeout: 20_000 },
  );
  await waitFrames(page, 2);
  const before = seen.navigations;
  use('b');
  const switched = Date.now();
  await page.waitForFunction(
    () => {
      const d = window.__goghDiag?.() as unknown as PageDiag | undefined;
      if (!d) return false;
      const action = d.notices?.view?.actions.find((a) => a.kind === 'update-ready');
      return Boolean(d.notices?.view?.visible && d.notices.view.typeset && action?.visible);
    },
    null,
    { timeout: DESKTOP_DEADLINE_MS, polling: 100 },
  );
  const noticeMs = Date.now() - switched;
  const shown = await diag(page);
  const dom = await domNotice(page);
  if (!dom.visible || !dom.reloadVisible)
    fail(`xr: page notice not visible as computed ${JSON.stringify(dom)}`);
  await page.screenshot({ path: join(out, 'xr-update-notice.png') });
  // No reload by itself: a forced poll and one full interval later it is still A, in XR.
  const checksAtNotice = shown?.update?.checks ?? 0;
  await page.evaluate(() => window.__goghUpdateCheck?.());
  await page.waitForFunction(
    (n) =>
      ((window.__goghDiag?.() as { update?: UpdateDiag } | undefined)?.update?.checks ?? 0) >= n,
    checksAtNotice + 2,
    { timeout: 40_000 },
  );
  const held = await diag(page);
  if (seen.navigations !== before) fail('xr: reloaded without Reload');
  if (!held?.xr.presenting || held.update?.running !== ids.a)
    fail('xr: left XR or build without Reload');
  // Select Reload: aim the right controller at it from below and pull the trigger.
  const target = held.notices?.view?.actions.find((a) => a.kind === 'update-ready');
  if (!target) fail('xr: no Reload target');
  const [x, y, z] = target.center as [number, number, number];
  await page.evaluate(
    ([tx, ty, tz]) => {
      const device = window.__goghIwer;
      const right = device?.controllers.right;
      if (!right) throw new Error('no IWER right controller');
      const from = [tx, ty - 0.3, tz + 0.25];
      const dir = [tx - from[0], ty - from[1], tz - from[2]];
      const len = Math.hypot(dir[0], dir[1], dir[2]);
      const d = dir.map((v) => v / len);
      // The rotation that takes -Z onto d.
      const ax = d[1];
      const ay = -d[0];
      const w = 1 - d[2];
      const n = Math.hypot(ax, ay, 0, w);
      right.position.set(from[0], from[1], from[2]);
      right.quaternion.set(ax / n, ay / n, 0, w / n);
    },
    [x, y, z],
  );
  await page.waitForFunction(
    () =>
      Boolean(
        (window.__goghDiag?.() as unknown as PageDiag | undefined)?.notices?.view?.actions.find(
          (a) => a.kind === 'update-ready',
        )?.hovered,
      ),
    null,
    { timeout: 10_000 },
  );
  const selected = Date.now();
  await page.evaluate(() => window.__goghIwer?.controllers.right?.updateButtonValue('trigger', 1));
  await page.waitForFunction(
    (b) => (window.__goghDiag?.() as { update?: UpdateDiag } | undefined)?.update?.running === b,
    ids.b,
    { timeout: 30_000, polling: 100 },
  );
  const reloadMs = Date.now() - selected;
  const url = checkUrl(start, seen.documents.at(-1), page.url());
  const order = await page.evaluate(() => ({
    end: Number(sessionStorage.getItem('ab.end')),
    hide: Number(sessionStorage.getItem('ab.hide')),
  }));
  if (!(order.end > 0 && order.hide >= order.end))
    fail(`xr: navigated before the session ended ${JSON.stringify(order)}`);
  await page.waitForFunction(
    () =>
      ((window.__goghDiag?.() as { update?: UpdateDiag } | undefined)?.update?.checks ?? 0) >= 1,
    null,
    { timeout: 30_000 },
  );
  const after = await diag(page);
  const afterDom = await domNotice(page);
  if (after?.xr.presenting) fail('xr: still presenting after the reload');
  if (afterDom.visible || after?.update?.available) fail('xr: B still shows an update notice');
  await page.screenshot({ path: join(out, 'xr-after-reload.png') });
  if (seen.errors.length) fail(`xr: page errors: ${seen.errors.join(' | ')}`);
  await page.context().close();
  return {
    noticeMs,
    noticeOnHud: shown?.notices?.view?.actions,
    noticeOnPage: dom,
    heldChecks: (held.update?.checks ?? 0) - checksAtNotice,
    autoReloaded: false,
    reloadAfterSelectMs: reloadMs,
    navigations: seen.navigations - before,
    sessionEndedBeforeNavigation: { endMs: order.end, pagehideMs: order.hide },
    url,
    after: { update: after?.update, presenting: after?.xr.presenting, notice: afterDom },
  };
}

const dirs = { a: join(work, 'a'), b: join(work, 'b') };
let served: 'a' | 'b' = 'a';
const use = (r: 'a' | 'b') => {
  served = r;
};
let main: Server | null = null;
let alone: Server | null = null;
let browser: Browser | null = null;
let exitCode = 0;
const result: Record<string, unknown> = { ports: { served: PORT, b: B_PORT } };
try {
  const ids = { a: build(dirs.a, 'update-a'), b: build(dirs.b, 'update-b') };
  if (ids.a === ids.b) fail('builds A and B have the same id');
  result.ids = ids;
  main = await serve(PORT, () => dirs[served]);
  alone = await serve(B_PORT, () => dirs.b);
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });

  const probe = await browser.newPage();
  await probe.goto(`http://127.0.0.1:${B_PORT}/?diag&update&scene=bare&noanim`);
  await probe.waitForFunction(() => Boolean(window.__goghDiag?.().update), null, {
    timeout: 60_000,
  });
  const bAlone = (await diag(probe))?.update;
  if (bAlone?.running !== ids.b) fail('B alone does not embed its manifest id');
  result.bAlone = bAlone;
  await probe.close();

  for (const [name, run] of [
    ['desktop', desktop],
    ['xr', xr],
  ] as const) {
    const host = await waitForHost();
    const started = Date.now();
    const outcome = await run(browser, ids, use);
    result[name] = {
      ...outcome,
      load: {
        before: host.load,
        after: loadavg()[0],
        waitedMs: host.waitedMs,
        affected: host.affected,
      },
      durationMs: Date.now() - started,
    };
  }
  result.status = 'pass';
} catch (error) {
  exitCode = 1;
  result.status = 'fail';
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  await browser?.close();
  main?.closeAllConnections();
  main?.close();
  alone?.closeAllConnections();
  alone?.close();
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
  writeFileSync(join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
process.exit(exitCode);
