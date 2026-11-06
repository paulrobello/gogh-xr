import { expect, test } from 'vitest';
import {
  buildFlowField,
  type Raster,
  REGION,
  type RegionId,
  regionAt,
} from '../src/demo/canvas/field.ts';
import {
  buildCanvasStrokes,
  CANVAS_LAYOUT,
  type CanvasLayout,
  type CanvasSources,
  canvasTangent,
  decodedNormal,
  REGION_STYLES,
} from '../src/demo/canvas/placement.ts';
import { BRUSHES } from '../src/render/strokes/brush-atlas-data.ts';
import { strokeAxes, surfaceBasis, type Vec3 } from '../src/render/strokes/frame.ts';
import { type StrokeBuffers, unpackInstance } from '../src/render/strokes/instance.ts';

type Rgb = readonly [number, number, number];

function raster(width: number, height: number, fill: (u: number, v: number) => Rgb): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill((x + 0.5) / width, 1 - (y + 0.5) / height);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function flowBytes(theta: number, c: number): Rgb {
  return [
    Math.round((0.5 + 0.5 * Math.cos(2 * theta)) * 255),
    Math.round((0.5 + 0.5 * Math.sin(2 * theta)) * 255),
    Math.round(c * 255),
  ];
}

/** All seven regions as vertical stripes, u = 0 sky to u = 1 church. */
const STRIPES = (u: number): RegionId => Math.min(6, Math.floor(u * 7)) as RegionId;

function sources(opts: {
  flow?: (u: number, v: number) => Rgb;
  region?: (u: number, v: number) => RegionId;
  color?: (u: number, v: number) => Rgb;
}): CanvasSources {
  const region = opts.region ?? (() => REGION.sky);
  return {
    color: raster(64, 51, opts.color ?? (() => [60, 90, 160])),
    flow: buildFlowField(raster(64, 64, opts.flow ?? (() => flowBytes(Math.PI / 3, 1)))),
    regions: raster(64, 64, (u, v) => {
      const id = region(u, v);
      return [id, id, id];
    }),
  };
}

const SMALL: CanvasLayout = {
  center: [0, 1, -2],
  right: [1, 0, 0],
  up: [0, 1, 0],
  width: 1,
  height: 0.8,
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Canvas-plane (u, v) and offset along the normal of every stroke. */
function canvasCoords(buffers: StrokeBuffers, layout: CanvasLayout) {
  const normal = cross(layout.right, layout.up);
  const out: { u: number; v: number; offset: number }[] = [];
  for (let i = 0; i < buffers.count; i++) {
    const d = sub(unpackInstance(buffers, i).position, layout.center);
    out.push({
      u: dot(d, layout.right) / layout.width + 0.5,
      v: dot(d, layout.up) / layout.height + 0.5,
      offset: dot(d, normal),
    });
  }
  return out;
}

test('placement is deterministic per seed, and no seed means seed 1', () => {
  const src = sources({ region: STRIPES });
  const a = buildCanvasStrokes(src, { layout: SMALL, target: 2000, seed: 1 });
  expect(buildCanvasStrokes(src, { layout: SMALL, target: 2000, seed: 1 })).toEqual(a);
  expect(buildCanvasStrokes(src, { layout: SMALL, target: 2000 })).toEqual(a);
  expect(buildCanvasStrokes(src, { layout: SMALL, target: 2000, seed: null })).toEqual(a);
  const b = buildCanvasStrokes(src, { layout: SMALL, target: 2000, seed: 2 });
  expect(b.position).not.toEqual(a.position);
});

test('the stroke count lands near the target', () => {
  for (const region of [() => REGION.sky, STRIPES]) {
    const buffers = buildCanvasStrokes(sources({ region }), { layout: SMALL, target: 5000 });
    expect(buffers.count).toBeGreaterThan(4750);
    expect(buffers.count).toBeLessThan(5250);
  }
});

test('strokes stay on the canvas plane, a few millimetres in front of it', () => {
  const buffers = buildCanvasStrokes(sources({ region: STRIPES }), { layout: SMALL, target: 3000 });
  for (const { u, v, offset } of canvasCoords(buffers, SMALL)) {
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThanOrEqual(1);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(0.005);
  }
});

test('strokes cover the canvas with no holes, in every region and coherence', () => {
  // Coherent flow in the top half, flat (coherence 0) in the bottom half, all seven regions.
  const src = sources({
    region: STRIPES,
    flow: (u, v) => (v > 0.5 ? flowBytes(u * Math.PI, 1) : flowBytes(0, 0)),
  });
  const buffers = buildCanvasStrokes(src, { layout: SMALL, target: 4000 });
  const strokes = Array.from({ length: buffers.count }, (_, i) => {
    const s = unpackInstance(buffers, i);
    return { ...s, axes: strokeAxes(s.normal, s.tangent) };
  });
  // A probe counts as covered inside the stroke's inner ellipse: the brush masks do not fill
  // their quads, so the inner 70% of each axis stands in for the painted shape.
  const reach = 0.35;
  // Probes span the canvas less a 2% rim: strokes centre on the canvas, so its edge is ragged
  // within about one stroke spacing (1.6 cm here), like a painted edge.
  const rim = 0.02;
  const probes = 50;
  const holes: string[] = [];
  for (let py = 0; py < probes; py++) {
    for (let px = 0; px < probes; px++) {
      const pu = rim + ((px + 0.5) / probes) * (1 - 2 * rim);
      const pv = rim + ((py + 0.5) / probes) * (1 - 2 * rim);
      const p: Vec3 = [
        SMALL.center[0] + (pu - 0.5) * SMALL.width,
        SMALL.center[1] + (pv - 0.5) * SMALL.height,
        SMALL.center[2],
      ];
      const covered = strokes.some((s) => {
        const d = sub(p, s.position);
        const a = dot(d, s.axes.long) / (reach * s.size[0]);
        const b = dot(d, s.axes.short) / (reach * s.size[1]);
        return a * a + b * b <= 1;
      });
      if (!covered) holes.push(`(${pu.toFixed(3)}, ${pv.toFixed(3)})`);
    }
  }
  expect(holes).toEqual([]);
});

test('each region picks its own layer and brush kinds, layered back to front', () => {
  const src = sources({ region: STRIPES });
  const buffers = buildCanvasStrokes(src, { layout: SMALL, target: 4000 });
  const coords = canvasCoords(buffers, SMALL);
  const offsets = new Map<RegionId, number[]>();
  const kinds = new Map<RegionId, Set<string>>();
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    const region = regionAt(src.regions, coords[i].u, coords[i].v);
    const style = REGION_STYLES[region];
    expect(s.layer).toBe(style.layer);
    expect(style.brushes).toContain(s.brush);
    offsets.set(region, [...(offsets.get(region) ?? []), coords[i].offset]);
    kinds.set(region, (kinds.get(region) ?? new Set()).add(BRUSHES[s.brush].kind));
  }
  expect([...(kinds.get(REGION.cypress) ?? [])].sort()).toEqual(['bristle', 'ridge']);
  expect([...(kinds.get(REGION.church) ?? [])]).toEqual(['bristle']);
  // Sky at the back, then hills, village, church, cypress, stars, and the moon in front.
  const order = [
    REGION.sky,
    REGION.hills,
    REGION.village,
    REGION.church,
    REGION.cypress,
    REGION.stars,
    REGION.moon,
  ];
  for (let k = 0; k + 1 < order.length; k++) {
    expect(Math.max(...(offsets.get(order[k]) ?? []))).toBeLessThan(
      Math.min(...(offsets.get(order[k + 1]) ?? [])),
    );
  }
});

test('coherent strokes follow the flow and grow longer than flat-area strokes', () => {
  const theta = Math.PI / 3;
  const src = sources({
    flow: (_u, v) => (v > 0.5 ? flowBytes(theta, 1) : flowBytes(theta, 0.05)),
  });
  const buffers = buildCanvasStrokes(src, { layout: SMALL, target: 3000 });
  const coords = canvasCoords(buffers, SMALL);
  const flowDir: Vec3 = [Math.cos(theta), Math.sin(theta), 0];
  const lengths = { top: 0, bottom: 0, nTop: 0, nBottom: 0 };
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    if (coords[i].v > 0.55) {
      expect(Math.abs(dot(strokeAxes(s.normal, s.tangent).long, flowDir))).toBeGreaterThan(0.9);
      lengths.top += s.size[0];
      lengths.nTop++;
    } else if (coords[i].v < 0.45) {
      lengths.bottom += s.size[0];
      lengths.nBottom++;
    }
  }
  expect(lengths.top / lengths.nTop).toBeGreaterThan((1.4 * lengths.bottom) / lengths.nBottom);
});

test('stroke colour comes from the painting under the stroke', () => {
  const src = sources({ color: (u) => (u < 0.5 ? [200, 40, 40] : [40, 40, 200]) });
  const buffers = buildCanvasStrokes(src, { layout: SMALL, target: 2000 });
  const coords = canvasCoords(buffers, SMALL);
  for (let i = 0; i < buffers.count; i++) {
    const [r, , b] = unpackInstance(buffers, i).color;
    if (coords[i].u < 0.4) expect(r).toBeGreaterThan(b);
    if (coords[i].u > 0.6) expect(b).toBeGreaterThan(r);
  }
});

test('the tangent is measured against the basis of the decoded normal', () => {
  // Source z is just below 0, but the oct-quantised normal decodes to z = 0 exactly, where Duff's
  // basis takes the other sign branch.
  const source: Vec3 = [1, 0, -1e-7];
  const decoded = decodedNormal(source);
  expect(decoded[2] >= 0).not.toBe(source[2] >= 0);
  const right: Vec3 = [0, 0, -1];
  const up: Vec3 = [0, 1, 0];
  for (const angle of [0, 0.7, 2, 4]) {
    const want: Vec3 = [
      Math.cos(angle) * right[0] + Math.sin(angle) * up[0],
      Math.cos(angle) * right[1] + Math.sin(angle) * up[1],
      Math.cos(angle) * right[2] + Math.sin(angle) * up[2],
    ];
    const tangent = canvasTangent(decoded, right, up, angle);
    expect(dot(strokeAxes(decoded, tangent).long, want)).toBeCloseTo(1, 6);
    // The source-normal basis would point the stroke the other way.
    const { b1, b2 } = surfaceBasis(source);
    const wrong = Math.atan2(dot(want, b2), dot(want, b1));
    expect(dot(strokeAxes(decoded, wrong).long, want)).toBeLessThan(0);
  }
});

test('a canvas facing +x (n.z = 0) keeps its strokes along the flow', () => {
  const theta = 0.5;
  const layout: CanvasLayout = { ...SMALL, center: [-2, 1, 0], right: [0, 0, -1], up: [0, 1, 0] };
  const buffers = buildCanvasStrokes(sources({ flow: () => flowBytes(theta, 1) }), {
    layout,
    target: 1000,
  });
  const flowDir: Vec3 = [0, Math.sin(theta), -Math.cos(theta)];
  for (let i = 0; i < buffers.count; i++) {
    const s = unpackInstance(buffers, i);
    expect(Math.abs(dot(strokeAxes(s.normal, s.tangent).long, flowDir))).toBeGreaterThan(0.9);
  }
});

test('the default canvas is 4 × 3.17 m, upright, facing the viewer at eye height', () => {
  expect(CANVAS_LAYOUT.width).toBe(4);
  expect(CANVAS_LAYOUT.height).toBe(3.17);
  expect(cross(CANVAS_LAYOUT.right, CANVAS_LAYOUT.up)).toEqual([0, 0, 1]);
  expect(CANVAS_LAYOUT.center[1] - CANVAS_LAYOUT.height / 2).toBeGreaterThan(0);
  expect(CANVAS_LAYOUT.center[2]).toBeLessThan(-2);
});
