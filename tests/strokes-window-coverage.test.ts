/**
 * Every lit window pane at seed 1, rasterised from its strokes' real brush masks (the default-seed
 * atlas, coverage at least 128) at the near band's size, on a 400-column grid over the pane. A
 * pane's bare cells are grouped into 4-connected holes. Two bars:
 *
 * - No hole near a pane's diagonal: the share of the pane within SEAM_BAND_M of the diagonal that
 *   is bare. With a lattice per triangle the two halves fell out of step there, and house 7's pane
 *   left a 13.4 cm² hole 3 cm off it (0.62% of the frame 0.25 m away). One lattice per face
 *   (FACE_LATTICE_LAYERS) removes it: the worst pane's band went from 2.12% bare (house 6 window
 *   21) to 0.44% (house 13 window 40), what the brushes' own shapes leave near the diagonal.
 * - The largest interior hole (touching no pane edge) stays under MAX_INTERIOR_HOLE_CM2. Such holes
 *   come from the brushes' shapes and angles, which no lattice spacing rules out (card
 *   01a1d18370b0, a fill-in pass from the brush masks); the bar keeps them from growing.
 */
import { BufferAttribute } from 'three';
import { beforeAll, describe, expect, test } from 'vitest';
import { loadRealSource } from '../scripts/scatter-time.ts';
import {
  createWorldGeometry,
  scatterWorld,
  type WorldGeometry,
  worldSeeds,
} from '../src/paintings/starry-night/world.ts';
import {
  ATLAS_SIZE,
  BRUSH_CHANNEL,
  brushTexelRect,
  DEFAULT_BRUSH_SEED,
  generateBrushAtlas,
} from '../src/render/strokes/brush-atlas-data.ts';
import { DEPTH_TIE_BREAK_FRONT_FLAG } from '../src/render/strokes/depth-tie-break.ts';
import { fitScaleLimit } from '../src/render/strokes/face-clamp.ts';
import { strokeAxes, type Vec3 } from '../src/render/strokes/frame.ts';
import {
  STROKE_LAYER,
  type StrokeBuffers,
  unpackInstance,
} from '../src/render/strokes/instance.ts';

/** Grid columns over a pane's width; rows keep the cells square. */
const GRID = 400;
const SEAM_BAND_M = 0.04;
const MAX_SEAM_BARE_SHARE = 0.006;
const MAX_INTERIOR_HOLE_CM2 = 13;

const dot = (a: readonly number[], b: readonly number[]): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface PaneCoverage {
  readonly id: string;
  readonly seamBareShare: number;
  readonly interiorHoleCm2: number;
}

let world: WorldGeometry;
let scattered: StrokeBuffers;
let atlas: Uint8Array;

beforeAll(async () => {
  const source = await loadRealSource();
  const seeds = worldSeeds(1);
  world = createWorldGeometry(seeds);
  scattered = scatterWorld(world, source, seeds);
  atlas = generateBrushAtlas(DEFAULT_BRUSH_SEED);
}, 300_000);

function paneCoverage(index: number): PaneCoverage {
  const w = world.village.windows[index];
  const n = w.normal;
  const tl = Math.hypot(n[0], n[2]);
  const right: Vec3 = [n[2] / tl, 0, -n[0] / tl];
  const local = (p: readonly number[]): [number, number, number] => {
    const d = [p[0] - w.center[0], p[1] - w.center[1], p[2] - w.center[2]];
    return [dot(d, right), d[1], dot(d, n)];
  };
  const inPane = (l: readonly number[], slack: number): boolean =>
    Math.abs(l[0]) <= w.width / 2 + slack && Math.abs(l[1]) <= w.height / 2 + slack;

  // The pane's internal edges: triangle sides that are not on its rim.
  const pos = world.village.geometries.window.getAttribute('position') as BufferAttribute;
  const seams: [number, number, number, number][] = [];
  for (let t = 0; t < pos.count; t += 3) {
    const vs = [0, 1, 2].map((q) => local([pos.getX(t + q), pos.getY(t + q), pos.getZ(t + q)]));
    if (!vs.every((v) => Math.abs(v[2]) < 0.01 && inPane(v, 0.01))) continue;
    for (let e = 0; e < 3; e++) {
      const [a, b] = [vs[e], vs[(e + 1) % 3]];
      const onRim =
        (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(Math.abs(a[0]) - w.width / 2) < 1e-4) ||
        (Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(Math.abs(a[1]) - w.height / 2) < 1e-4);
      if (!onRim) seams.push([a[0], a[1], b[0], b[1]]);
    }
  }

  const cols = GRID;
  const rows = Math.round((GRID * w.height) / w.width);
  const cell = w.width / cols;
  const covered = new Uint8Array(cols * rows);
  for (let i = 0; i < scattered.count; i++) {
    if (scattered.meta[i * 4 + 1] !== STROKE_LAYER.building) continue;
    const s = unpackInstance(scattered, i);
    if (((s.flags ?? 0) & DEPTH_TIE_BREAK_FRONT_FLAG) === 0 || dot(s.normal, n) < 0.999) continue;
    const c = local(s.position);
    if (Math.abs(c[2]) > 0.05 || !inPane(c, 0.01)) continue;
    const { long, short } = strokeAxes(s.normal, s.tangent);
    const k = Math.min(1, fitScaleLimit(s.flags ?? 0));
    const [length, width] = [s.size[0] * k, s.size[1] * k];
    const rect = brushTexelRect(s.brush);
    const reach = Math.hypot(length, width) / 2;
    const i0 = Math.max(0, Math.floor((c[0] - reach + w.width / 2) / cell));
    const i1 = Math.min(cols - 1, Math.ceil((c[0] + reach + w.width / 2) / cell));
    const j0 = Math.max(0, Math.floor((c[1] - reach + w.height / 2) / cell));
    const j1 = Math.min(rows - 1, Math.ceil((c[1] + reach + w.height / 2) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let col = i0; col <= i1; col++) {
        const x = (col + 0.5) * cell - w.width / 2;
        const y = (j + 0.5) * cell - w.height / 2;
        const p = [
          w.center[0] + right[0] * x - s.position[0],
          w.center[1] + y - s.position[1],
          w.center[2] + right[2] * x - s.position[2],
        ];
        const u = dot(p, long) / length + 0.5;
        const v = dot(p, short) / width + 0.5;
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        const tx = rect.x + Math.floor(u * rect.width);
        const ty = rect.y + Math.floor(v * rect.height);
        if (atlas[(ty * ATLAS_SIZE + tx) * 4 + BRUSH_CHANNEL.coverage] >= 128) {
          covered[j * cols + col] = 1;
        }
      }
    }
  }

  const seamDistance = (x: number, y: number): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const [ax, ay, bx, by] of seams) {
      const [dx, dy] = [bx - ax, by - ay];
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return best;
  };
  let seamCells = 0;
  let seamBare = 0;
  for (let j = 0; j < rows; j++) {
    for (let col = 0; col < cols; col++) {
      const x = (col + 0.5) * cell - w.width / 2;
      const y = (j + 0.5) * cell - w.height / 2;
      if (seamDistance(x, y) > SEAM_BAND_M) continue;
      seamCells++;
      if (!covered[j * cols + col]) seamBare++;
    }
  }

  const seen = new Uint8Array(cols * rows);
  let interior = 0;
  for (let start = 0; start < cols * rows; start++) {
    if (covered[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let size = 0;
    let rim = false;
    while (stack.length > 0) {
      const at = stack.pop() as number;
      size++;
      const col = at % cols;
      const j = (at - col) / cols;
      if (col === 0 || j === 0 || col === cols - 1 || j === rows - 1) rim = true;
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const [ni, nj] = [col + di, j + dj];
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const next = nj * cols + ni;
        if (!covered[next] && !seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    if (!rim) interior = Math.max(interior, size);
  }
  return {
    id: `house ${w.house} window ${index}`,
    seamBareShare: seamCells > 0 ? seamBare / seamCells : 0,
    interiorHoleCm2: interior * cell * cell * 1e4,
  };
}

describe('window pane coverage at seed 1', () => {
  test('no pane leaves a hole along its diagonal, and no interior hole grows past the bar', () => {
    const panes = world.village.windows.map((_, i) => paneCoverage(i));
    expect(panes.length).toBeGreaterThan(50);
    const seam = panes.reduce((a, b) => (b.seamBareShare > a.seamBareShare ? b : a));
    const hole = panes.reduce((a, b) => (b.interiorHoleCm2 > a.interiorHoleCm2 ? b : a));
    console.log(
      `window coverage: worst seam band ${(100 * seam.seamBareShare).toFixed(3)}% (${seam.id}), largest interior hole ${hole.interiorHoleCm2.toFixed(2)} cm² (${hole.id})`,
    );
    expect(seam.seamBareShare, seam.id).toBeLessThanOrEqual(MAX_SEAM_BARE_SHARE);
    expect(hole.interiorHoleCm2, hole.id).toBeLessThanOrEqual(MAX_INTERIOR_HOLE_CM2);
  }, 300_000);
});
