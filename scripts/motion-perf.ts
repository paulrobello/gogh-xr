/**
 * The P4.6 desktop motion perf record (docs/perf.md, "Motion"): GPU frame time, draw calls and
 * drawn strokes of the Starry Night world at the painter view and the spot-ahead view, with motion
 * frozen, fully on and reactive-only, plus the IWER rows that count the strokes in the reactive
 * box with a controller inside the cypress.
 *
 *   bun scripts/motion-perf.ts [--base http://localhost:4253] [--seconds 4] [--repeats 1]
 *     [--out perf.json] [--only <config name part>]
 *
 * It needs a running `--mode e2e` build (`make preview`): `?iwer`, `?motionlayers` and the IWER
 * controller only exist there. GPU time comes from EXT_disjoint_timer_query_webgl2 TIME_ELAPSED
 * queries, one per animation frame, begun at the frame's first rAF callback and ended at the next
 * frame's, so it covers every GPU command of the frame; disjoint results are dropped. Without the
 * extension it records the rAF interval only. Each view is its own boot. `--repeats N` runs the
 * desktop configurations N times, interleaved (every configuration once per pass); the IWER rows
 * run on the first pass only, because their timings are not a cost. Every run follows the host
 * load rule: the 1-minute load average must be at most 15 before (waited for, bounded) and after,
 * else it is discarded and re-run.
 */

import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { chromium, type Page } from '@playwright/test';
import { CANVAS_ASPECT, CANVAS_PITCH } from '../src/paintings/starry-night/canvas-camera.ts';
import { gpuArgs } from '../tests/e2e/gpu.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const base = option('base', 'http://localhost:4253');
const seconds = Number(option('seconds', '4'));
const repeats = Math.max(1, Math.round(Number(option('repeats', '1'))));
const out = option('out', '');
const only = option('only', '');
const MAX_LOAD = 15;
const LOAD_WAIT_MS = 300_000;
const EYE_HEIGHT = 1.6;

type Vec3 = [number, number, number];
interface View {
  readonly name: string;
  /** Eye world position, yaw (0 faces -Z) and pitch. */
  readonly eye: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  /**
   * The desktop painter view boots with `?painter`, the 60° painter camera of the fidelity capture,
   * and is not posed. In XR the IWER head carries the pose and its own field of view.
   */
  readonly painterCamera: boolean;
}
/** The main cypress's axis ring 9 and its hull 1.29 m out towards the painter (seed 1). */
const AXIS_9: Vec3 = [-3.36, -1.55, -9.35];
const CYPRESS_OUT: Vec3 = [0.338, 0, 0.941];
const CYPRESS_HULL = 1.29;
const PAINTER: View = {
  name: 'painter',
  eye: [0, EYE_HEIGHT, 0],
  yaw: 0,
  pitch: CANVAS_PITCH,
  painterCamera: true,
};
const SPOT_AHEAD: View = {
  name: 'spot ahead',
  eye: [0, EYE_HEIGHT, 0],
  yaw: 0,
  pitch: 0,
  painterCamera: false,
};
/** The head 0.4 m out from the cypress hull, facing its axis, as in tests/e2e/reactive.spec.ts. */
const AT_CYPRESS: View = {
  name: 'at the cypress',
  eye: [
    AXIS_9[0] + (CYPRESS_HULL + 0.4) * CYPRESS_OUT[0],
    AXIS_9[1],
    AXIS_9[2] + (CYPRESS_HULL + 0.4) * CYPRESS_OUT[2],
  ],
  yaw: Math.atan2(CYPRESS_OUT[0], CYPRESS_OUT[2]),
  pitch: 0,
  painterCamera: false,
};

/** Where the right controller is, rig-local. */
type Hand =
  /** Parked 60 m under the floor, still tracked, like the left one. */
  | 'parked'
  /** Circling the far-reach centre, 9 m from a head at the painter's spot; the left one parked. */
  | 'far reach'
  /** Circling 0.6 m ahead of the head; the left controller disconnected (untracked). */
  | 'at reach';
interface Config {
  readonly name: string;
  readonly query: string;
  readonly xr: boolean;
  readonly hand: Hand;
  readonly views: readonly View[];
}
const CONFIGS: readonly Config[] = [
  { name: '(a) noanim', query: 'noanim', xr: false, hand: 'parked', views: [PAINTER, SPOT_AHEAD] },
  {
    name: '(b) motion, every layer',
    query: '',
    xr: false,
    hand: 'parked',
    views: [PAINTER, SPOT_AHEAD],
  },
  {
    name: '(c) motion, reactive only',
    query: 'motionlayers=reactive',
    xr: false,
    hand: 'parked',
    views: [PAINTER, SPOT_AHEAD],
  },
  // The motion A/B variants (src/motion/variants.ts), against (b): `--only "(v)"` runs them.
  ...(['wrap=base', 'wrap=fade', 'wrap=half', 'flame=wind'] as const).map((flag) => ({
    name: `(v) motion, ${flag}`,
    query: flag,
    xr: false,
    hand: 'parked' as const,
    views: [PAINTER, SPOT_AHEAD],
  })),
  {
    name: 'XR (a) noanim',
    query: 'noanim',
    xr: true,
    hand: 'parked',
    views: [PAINTER, SPOT_AHEAD],
  },
  {
    name: 'XR (b) motion, every layer',
    query: '',
    xr: true,
    hand: 'parked',
    views: [PAINTER, SPOT_AHEAD],
  },
  {
    name: 'XR (c) motion, reactive only',
    query: 'motionlayers=reactive',
    xr: true,
    hand: 'parked',
    views: [PAINTER, SPOT_AHEAD],
  },
  {
    name: 'XR (d1) far-reach union box',
    query: '',
    xr: true,
    hand: 'far reach',
    views: [PAINTER, SPOT_AHEAD],
  },
  {
    name: 'XR (d2) hand at reach in the cypress',
    query: '',
    xr: true,
    hand: 'at reach',
    views: [AT_CYPRESS],
  },
];

/** The far-reach circle's centre, 0.2 m inside the hull, rig-local with the rig at the origin. */
const FAR_CENTRE: Vec3 = [
  AXIS_9[0] + 1.09 * CYPRESS_OUT[0],
  AXIS_9[1],
  AXIS_9[2] + 1.09 * CYPRESS_OUT[2],
];
/** The at-reach circle's centre: 0.6 m ahead of the head, so 0.2 m inside the hull. */
const REACH_CENTRE: Vec3 = [0, EYE_HEIGHT, -0.6];

/** Counts GPU time per animation frame with TIME_ELAPSED queries; installed before the app runs. */
function installFrameTimer(): void {
  interface Ext {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  }
  const state = {
    available: null as boolean | null,
    on: false,
    gpu: [] as number[],
    intervals: [] as number[],
    disjoint: 0,
  };
  (window as unknown as { __perf: typeof state }).__perf = state;
  let gl: WebGL2RenderingContext | null = null;
  let ext: Ext | null = null;
  let active: WebGLQuery | null = null;
  const pending: WebGLQuery[] = [];
  let lastT = -1;
  const poll = (): void => {
    if (!gl || !ext) return;
    while (pending.length > 0) {
      const q = pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return;
      pending.shift();
      const disjoint = Boolean(gl.getParameter(ext.GPU_DISJOINT_EXT));
      if (disjoint) state.disjoint++;
      else if (state.on) state.gpu.push(Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6);
      gl.deleteQuery(q);
    }
  };
  const boundary = (t: number): void => {
    if (state.on && lastT >= 0) state.intervals.push(t - lastT);
    lastT = t;
    if (!gl) {
      const canvas = document.querySelector('canvas');
      // The app appends its canvas after three created the context, so this returns that one.
      if (!canvas) return;
      gl = canvas.getContext('webgl2');
      ext = (gl?.getExtension('EXT_disjoint_timer_query_webgl2') as Ext | null) ?? null;
      state.available = ext !== null;
    }
    if (!gl || !ext) return;
    if (active) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
    }
    poll();
    if (state.on) {
      active = gl.createQuery();
      if (active) gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    }
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    raf((t) => {
      if (t !== lastT) boundary(t);
      callback(t);
    });
}

interface Diag {
  renderer: { frame: number; unmaskedRenderer: string | null };
  xr: { presenting: boolean };
  draw: { calls: number; visibleChunks: number };
  world?: { strokes: { visible: number } };
  motion: { layers: number; time: number };
  reactive?: {
    boxStrokes: number | null;
    box: { min: Vec3; max: Vec3 } | null;
    disturbers: { tracked: boolean; strength: number }[];
  };
}
const diag = (page: Page): Promise<Diag> =>
  page.evaluate(() => (window.__goghDiag as () => unknown)() as Diag);

async function waitFrames(page: Page, n: number): Promise<void> {
  const start = (await diag(page)).renderer.frame;
  const deadline = Date.now() + 30_000;
  while ((await diag(page)).renderer.frame < start + n) {
    if (Date.now() > deadline) throw new Error('frames stalled');
    await page.waitForTimeout(50);
  }
}

async function waitLoad(): Promise<number> {
  const deadline = Date.now() + LOAD_WAIT_MS;
  for (;;) {
    const load = loadavg()[0];
    if (load <= MAX_LOAD) return load;
    if (Date.now() > deadline) throw new Error(`load ${load.toFixed(2)} stayed above ${MAX_LOAD}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

interface Row {
  config: string;
  view: string;
  repeat: number;
  gpuMeanMs: number | null;
  gpuP95Ms: number | null;
  gpuFrames: number;
  frameMeanMs: number;
  drawCalls: number;
  drawn: number;
  visibleChunks: number;
  boxStrokes: number | null;
  /** The largest box stroke count read during the run. */
  boxStrokesMax: number | null;
  box: { min: Vec3; max: Vec3 } | null;
  /** Tracked flags of the head and both controller slots at the end of the run. */
  tracked: boolean[] | null;
  loadBefore: number;
  loadAfter: number;
}

const stats = (values: number[]): { mean: number; p95: number } => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: values.reduce((s, v) => s + v, 0) / values.length,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))],
  };
};

/** Poses the eye (desktop) or the rig, the IWER head and the controllers (XR) for `view`. */
async function pose(page: Page, config: Config, view: View): Promise<void> {
  if (!config.xr && view.painterCamera) return;
  await page.evaluate(
    ([x, y, z, yaw, pitch, xr]) => {
      if (!window.__goghPose) throw new Error('no __goghPose');
      // In XR the rig takes the position and yaw; the IWER head carries the pitch.
      window.__goghPose(x, y, z, yaw, xr ? 0 : pitch);
    },
    [...view.eye, view.yaw, view.pitch, config.xr] as const,
  );
  if (!config.xr) return;
  await page.evaluate(
    ([pitch, hand, far, reach, eyeHeight]) => {
      const device = window.__goghIwer;
      if (!device) throw new Error('no IWER');
      device.position.set(0, eyeHeight, 0);
      device.quaternion.set(Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
      const right = device.controllers.right;
      const left = device.controllers.left;
      if (!right || !left) throw new Error('no controllers');
      if (hand === 'at reach') left.connected = false;
      else left.position.set(0, -60, 0);
      if (hand === 'parked') {
        right.position.set(0, -60, 0);
        return;
      }
      const centre = hand === 'far reach' ? far : reach;
      // A 0.2 m circle at 1.5 m/s round the centre, driven from the page's own rAF.
      const t0 = performance.now();
      const step = (now: number): void => {
        const a = ((now - t0) / 1000) * (1.5 / 0.2);
        right.position.set(centre[0] + 0.2 * Math.cos(a), centre[1] + 0.2 * Math.sin(a), centre[2]);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    [view.pitch, config.hand, FAR_CENTRE, REACH_CENTRE, EYE_HEIGHT] as const,
  );
}

async function measure(
  page: Page,
  config: Config,
  view: View,
): Promise<Omit<Row, 'loadBefore' | 'loadAfter' | 'repeat'>> {
  await pose(page, config, view);
  await waitFrames(page, 30);
  await page.evaluate(() => {
    const perf = (
      window as unknown as { __perf: { on: boolean; gpu: number[]; intervals: number[] } }
    ).__perf;
    perf.gpu = [];
    perf.intervals = [];
    perf.on = true;
  });
  let boxStrokesMax: number | null = null;
  const end = Date.now() + seconds * 1000;
  // The box count walks every drawn stroke on the main thread, so only the IWER rows poll it.
  if (!config.xr) await page.waitForTimeout(seconds * 1000);
  while (Date.now() < end) {
    const n = (await diag(page)).reactive?.boxStrokes ?? null;
    if (n !== null) boxStrokesMax = Math.max(boxStrokesMax ?? 0, n);
    await page.waitForTimeout(250);
  }
  const perf = await page.evaluate(() => {
    const p = (window as unknown as { __perf: { on: boolean; gpu: number[]; intervals: number[] } })
      .__perf;
    p.on = false;
    return { gpu: [...p.gpu], intervals: [...p.intervals] };
  });
  const d = await diag(page);
  const gpu = perf.gpu.length > 0 ? stats(perf.gpu) : null;
  return {
    config: config.name,
    view: view.name,
    gpuMeanMs: gpu?.mean ?? null,
    gpuP95Ms: gpu?.p95 ?? null,
    gpuFrames: perf.gpu.length,
    frameMeanMs: stats(perf.intervals).mean,
    drawCalls: d.draw.calls,
    drawn: d.world?.strokes.visible ?? 0,
    visibleChunks: d.draw.visibleChunks,
    boxStrokes: d.reactive?.boxStrokes ?? null,
    boxStrokesMax,
    box: d.reactive?.box ?? null,
    tracked: d.reactive ? d.reactive.disturbers.map((t) => t.tracked) : null,
  };
}

const width = 1280;
const height = Math.round(width / CANVAS_ASPECT);
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: gpuArgs });
const rows: Row[] = [];
let renderer = '';
let timer: boolean | null = null;
try {
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const config of CONFIGS) {
      if (only && !config.name.includes(only)) continue;
      if (config.xr && repeat > 0) continue;
      for (const view of config.views) {
        for (let attempt = 1; ; attempt++) {
          const loadBefore = await waitLoad();
          const context = await browser.newContext({ viewport: { width, height } });
          const page = await context.newPage();
          await page.addInitScript(installFrameTimer);
          const query = [
            'iwer',
            'diag',
            'painting=starry-night',
            'seed=1',
            'nogov',
            !config.xr && view.painterCamera ? 'painter' : '',
            config.query,
          ]
            .filter(Boolean)
            .join('&');
          await page.goto(`${base}/?${query}`);
          const deadline = Date.now() + 120_000;
          while (!(await page.evaluate(() => Boolean(window.__goghDiag?.().world)))) {
            if (Date.now() > deadline) throw new Error('world did not build');
            await page.waitForTimeout(250);
          }
          if (config.xr) {
            await page.locator('#enter-vr').click();
            while (!(await diag(page)).xr.presenting) await page.waitForTimeout(100);
          }
          await waitFrames(page, 10);
          const r = await measure(page, config, view);
          renderer = (await diag(page)).renderer.unmaskedRenderer ?? '';
          timer = await page.evaluate(
            () => (window as unknown as { __perf: { available: boolean | null } }).__perf.available,
          );
          await context.close();
          const loadAfter = loadavg()[0];
          if (loadAfter > MAX_LOAD) {
            console.log(
              `${config.name} ${view.name}: discarded, load after ${loadAfter.toFixed(2)} (attempt ${attempt})`,
            );
            if (attempt >= 3) throw new Error(`${config.name}: load stayed above ${MAX_LOAD}`);
            continue;
          }
          const row = { ...r, repeat, loadBefore, loadAfter };
          rows.push(row);
          console.log(JSON.stringify(row));
          break;
        }
      }
    }
  }
} finally {
  await browser.close();
}
console.log(`renderer ${renderer}; EXT_disjoint_timer_query_webgl2 ${timer}`);
if (out) writeFileSync(out, JSON.stringify({ renderer, timer, rows }, null, 2));
