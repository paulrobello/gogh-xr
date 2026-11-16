import { describe, expect, test } from 'vitest';
import { toCanvas } from '../src/paintings/cafe-terrace-at-night/canvas';
import { box, wall, wallFrame, wallPoint } from '../src/paintings/cafe-terrace-at-night/kit';
import { ID, SWATCH } from '../src/paintings/cafe-terrace-at-night/layout';
import {
  type Paint,
  type PaintBuilder,
  type PainterView,
  paintBuilder,
  painterView,
} from '../src/paintings/cafe-terrace-at-night/paint';
import { buildSet } from '../src/paintings/cafe-terrace-at-night/set';
import type { Vec3 } from '../src/render/strokes/frame';
import { mulberry32 } from '../src/util/prng';
import { drain } from '../src/util/slicer';

const WALL: Paint = { id: 2, swatch: SWATCH.wall, tint: 0x808080 };
const PANE: Paint = { id: 2, swatch: SWATCH.wall, tint: 0xffff00, lit: true };

/** Each triangle of a builder: its corners, centre and unit normal. */
function triangles(builder: PaintBuilder): { corners: Vec3[]; centre: Vec3; normal: Vec3 }[] {
  const { positions } = builder;
  const out: { corners: Vec3[]; centre: Vec3; normal: Vec3 }[] = [];
  for (let i = 0; i < positions.length; i += 9) {
    const corners: Vec3[] = [0, 3, 6].map((k) => [
      positions[i + k],
      positions[i + k + 1],
      positions[i + k + 2],
    ]);
    const [a, b, c] = corners;
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec3 = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const length = Math.hypot(...n);
    out.push({
      corners,
      centre: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
      normal: [n[0] / length, n[1] / length, n[2] / length],
    });
  }
  return out;
}

/** A view whose every canvas point is one colour and one id. */
function flatView(
  id: number,
  colour: Vec3,
  inside: (u: number, v: number) => boolean,
): PainterView {
  return {
    idAt: (u, v) => (u >= 0 && u < 1 && v >= 0 && v < 1 && inside(u, v) ? id : -1),
    setIdAt: (u, v) => (u >= 0 && u < 1 && v >= 0 && v < 1 && inside(u, v) ? id : -1),
    colourAt: (_u, _v, out) => {
      out[0] = colour[0];
      out[1] = colour[1];
      out[2] = colour[2];
    },
  };
}

function localColours(builder: PaintBuilder, view: PainterView): Float32Array {
  drain(builder.bake(view));
  return drain(builder.build()).getAttribute('aLocal').array as Float32Array;
}

describe('café kit', () => {
  test('a box faces outward on every side', () => {
    const builder = paintBuilder([]);
    box(builder, [1, 2, 3], [2, 0, 0], [0, 1, 0], [0, 0, 3], WALL);
    const faces = triangles(builder);
    expect(faces).toHaveLength(12);
    for (const { centre, normal } of faces) {
      const out: Vec3 = [centre[0] - 2, centre[1] - 2.5, centre[2] - 4.5];
      expect(normal[0] * out[0] + normal[1] * out[1] + normal[2] * out[2]).toBeGreaterThan(0);
    }
  });

  test('a wall faces out, and an opening is cut through it and built in depth', () => {
    const builder = paintBuilder([]);
    // Seen from +z, the wall runs left to right along +x.
    const frame = wallFrame([0, 0, 0], [6, 0, 0]);
    expect(frame.out).toEqual([0, 0, 1]);
    expect(wallPoint(frame, 2, 1, 0.5)).toEqual([2, 1, 0.5]);
    wall(builder, frame, 0, 4, [{ s0: 2, s1: 3, y0: 1, y1: 2.5, depth: 0.3, pane: PANE }], WALL, 1);
    const faces = triangles(builder);
    const within = ({ centre }: { centre: Vec3 }): boolean =>
      centre[0] > 2 && centre[0] < 3 && centre[1] > 1 && centre[1] < 2.5;
    // Nothing of the wall's own face covers the opening.
    expect(faces.filter((face) => within(face) && Math.abs(face.centre[2]) < 1e-9)).toHaveLength(0);
    // The pane stands 0.3 m back and faces out; the reveals join it to the wall's face.
    const pane = faces.filter((face) => within(face) && Math.abs(face.centre[2] + 0.3) < 1e-9);
    expect(pane.length).toBeGreaterThanOrEqual(2);
    for (const { normal } of pane) expect(normal[2]).toBeCloseTo(1);
    const reveals = faces.filter(({ centre }) => centre[2] < -0.01 && centre[2] > -0.29);
    expect(reveals).toHaveLength(8);
    // Each reveal faces into the opening.
    for (const { centre, normal } of reveals) {
      const inward: Vec3 = [2.5 - centre[0], 1.75 - centre[1], 0];
      expect(normal[0] * inward[0] + normal[1] * inward[1]).toBeGreaterThan(0);
    }
    // The wall's face covers its whole area less the opening.
    const area = faces
      .filter(({ centre }) => Math.abs(centre[2]) < 1e-9)
      .reduce((sum, { corners: [a, b, c] }) => {
        return sum + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      }, 0);
    expect(area).toBeCloseTo(6 * 4 - 1.5);
  });
});

describe('café paint', () => {
  const RED: Vec3 = [0.8, 0.1, 0.05];

  test('a surface the painter sees takes the painting, and one behind the painter its tint', () => {
    const builder = paintBuilder([]);
    const seen: Paint = { id: 5, swatch: SWATCH.wall, tint: 0x0000ff };
    // Facing the painter, 10 m ahead, and the same wall 10 m behind.
    builder.quad([-1, 1, -10], [1, 1, -10], [1, 2, -10], [-1, 2, -10], seen);
    builder.quad([1, 1, 10], [-1, 1, 10], [-1, 2, 10], [1, 2, 10], seen);
    expect(toCanvas([0, 1.5, -10]).depth).toBeGreaterThan(0);
    const local = localColours(
      builder,
      flatView(5, RED, () => true),
    );
    // Six vertices a quad: the first quad is the painting's red, the second its own blue.
    for (let i = 0; i < 6; i++) {
      expect([...local.slice(i * 3, i * 3 + 3)]).toEqual([
        expect.closeTo(RED[0], 5),
        expect.closeTo(RED[1], 5),
        expect.closeTo(RED[2], 5),
      ]);
    }
    for (let i = 6; i < 12; i++) {
      expect(local[i * 3]).toBeCloseTo(0, 5);
      expect(local[i * 3 + 2]).toBeGreaterThan(0.5);
    }
  });

  test('a surface the painter did not paint keeps its tint, shaded by its facing', () => {
    const builder = paintBuilder([]);
    const plain: Paint = { id: 5, swatch: SWATCH.wall, tint: 0xffffff, painted: false };
    builder.quad([-1, 3, -10], [1, 3, -10], [1, 3, -12], [-1, 3, -12], plain, {
      toward: [0, 9, -11],
    });
    builder.quad([-1, 3, -10], [1, 3, -10], [1, 3, -12], [-1, 3, -12], plain, {
      away: [0, 9, -11],
    });
    const local = localColours(
      builder,
      flatView(5, RED, () => true),
    );
    const top = local[0];
    const under = local[6 * 3];
    expect(local[1]).toBeCloseTo(top, 6);
    expect(top).toBeGreaterThan(under);
    expect(under).toBeGreaterThan(0.3);
  });

  test('a grid carries its paint on past what the painter saw, fading into its tint', () => {
    const builder = paintBuilder([]);
    const floor: Paint = { id: 1, swatch: SWATCH.cobbles, tint: 0x000000 };
    // A strip of ground running away to the right of the canvas: seen only left of u = 0.75.
    builder.quad([0, 0, -8], [40, 0, -8], [40, 0, -9], [0, 0, -9], floor, {
      toward: [0, 9, -8],
      cell: 0.5,
    });
    const local = localColours(
      builder,
      flatView(1, RED, (u) => u < 0.75),
    );
    const { positions } = builder;
    const redAt = (x: number): number => {
      let best = -1;
      for (let i = 0; i < positions.length / 3; i++) {
        if (Math.abs(positions[i * 3] - x) < 0.01) best = local[i * 3];
      }
      return best;
    };
    const edge = 8 * ((0.75 - 0.5) / (0.866 / (1280 / 1596)));
    expect(redAt(0)).toBeCloseTo(RED[0], 4);
    // Just past the seen edge the paint carries on; far past it only the tint is left.
    expect(redAt(Math.ceil(edge * 2) / 2 + 1)).toBeGreaterThan(0.6 * RED[0]);
    expect(redAt(Math.ceil(edge * 2) / 2 + 4)).toBeLessThan(redAt(Math.ceil(edge * 2) / 2 + 1));
    expect(redAt(30)).toBeCloseTo(0, 5);
  });

  test('only a paint that asks for it shows the scan itself', () => {
    const builder = paintBuilder([]);
    const plain: Paint = { id: 5, swatch: SWATCH.wall, tint: 0xffffff };
    const corners: [Vec3, Vec3, Vec3, Vec3] = [
      [-1, 1, -10],
      [1, 1, -10],
      [1, 2, -10],
      [-1, 2, -10],
    ];
    builder.quad(...corners, plain);
    builder.quad(...corners, { ...plain, exact: true });
    builder.quad(...corners, { ...plain, raw: true });
    builder.quad(...corners, { ...plain, exact: true, painted: false });
    drain(builder.bake(flatView(5, RED, () => true)));
    const seen = drain(builder.build()).getAttribute('aSeen').array as Float32Array;
    // Six vertices a quad, two numbers each: the id, then 0 marks only, 1 the scan, 2 the swatch.
    expect([seen[1], seen[13], seen[25], seen[37]]).toEqual([0, 1, 2, 0]);
  });

  test("the set's walls take no paint from a prop, a margin round it, or a built item", () => {
    // An 8 × 8 id map: a wall (id 2) with a prop (id 21) on one texel.
    const ids = new Uint8Array(64).fill(2);
    ids[3 * 8 + 3] = 21;
    const raster = { width: 1, height: 1, data: [255, 255, 255, 255] };
    const view = painterView(raster, ids, 8, 8, {
      covers: (id) => id >= 20,
      ignore: [[0.75, 0.75, 0.25, 0.25]],
      grow: 1,
    });
    const at = (x: number, y: number): [number, number] => [(x + 0.5) / 8, (y + 0.5) / 8];
    expect(view.idAt(...at(3, 3))).toBe(21);
    expect(view.idAt(...at(4, 3))).toBe(2);
    // The prop's texel and the ring round it are closed to the wall; two texels off is open.
    for (const [x, y] of [
      [3, 3],
      [4, 3],
      [2, 3],
      [3, 4],
      [4, 4],
      [2, 2],
    ]) {
      expect(view.setIdAt(...at(x, y))).toBe(-1);
    }
    expect(view.setIdAt(...at(5, 3))).toBe(2);
    expect(view.setIdAt(...at(0, 0))).toBe(2);
    // The built item's rectangle is closed too, and off the canvas is -1 either way.
    expect(view.setIdAt(...at(7, 7))).toBe(-1);
    expect(view.setIdAt(...at(6, 6))).toBe(-1);
    expect(view.idAt(...at(7, 7))).toBe(2);
    expect(view.setIdAt(1.2, 0.5)).toBe(-1);
  });

  test('a prop wears its painted side on its far side too', () => {
    const builder = paintBuilder([]);
    const prop: Paint = { id: 21, swatch: SWATCH.wall, tint: 0x0000ff, round: true };
    // Facing away from the painter.
    builder.quad([1, 1, -10], [-1, 1, -10], [-1, 2, -10], [1, 2, -10], prop);
    const local = localColours(
      builder,
      flatView(21, RED, () => true),
    );
    expect(local[0]).toBeCloseTo(RED[0], 5);
  });
});

describe('café set', () => {
  const set = paintBuilder([]);
  drain(buildSet(set, mulberry32(8)));

  test('is built in depth: far more than a handful of flat panels, within a budget', () => {
    const count = set.positions.length / 9;
    expect(count).toBeGreaterThan(40_000);
    expect(count).toBeLessThan(140_000);
    for (const id of [
      ID.ground,
      ID.deck,
      ID.facade,
      ID.shopfront,
      ID.interior,
      ID.balcony,
      ID.upper,
      ID.carriage,
    ]) {
      expect(set.ids.includes(id)).toBe(true);
    }
  });

  test('builds the same set for the same seed', () => {
    const again = paintBuilder([]);
    drain(buildSet(again, mulberry32(8)));
    expect(again.positions).toEqual(set.positions);
  });

  test('yields between its parts, so no one step builds the whole street', () => {
    const steps = buildSet(paintBuilder([]), mulberry32(8));
    let count = 0;
    while (!steps.next().done) count++;
    expect(count).toBeGreaterThanOrEqual(15);
  });
});
