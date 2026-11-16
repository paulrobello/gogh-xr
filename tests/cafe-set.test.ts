import sharp from 'sharp';
import type { Texture } from 'three';
import { describe, expect, test } from 'vitest';
import { PAINTER_EYE, toCanvas } from '../src/paintings/cafe-terrace-at-night/canvas';
import { box, wall, wallFrame, wallPoint } from '../src/paintings/cafe-terrace-at-night/kit';
import { buildLantern } from '../src/paintings/cafe-terrace-at-night/lantern';
import {
  AWNING,
  awningOver,
  ID,
  inPaintedSky,
  LAMP,
  STARS,
  SWATCH,
} from '../src/paintings/cafe-terrace-at-night/layout';
import {
  createPaintMaterial,
  type Paint,
  type PaintBuilder,
  type PainterView,
  paintBuilder,
  painterView,
} from '../src/paintings/cafe-terrace-at-night/paint';
import { buildSet } from '../src/paintings/cafe-terrace-at-night/set';
import { buildSky, SKY_RADIUS, STREWN_STARS } from '../src/paintings/cafe-terrace-at-night/sky';
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

/** A builder that also notes each triangle's paint. */
function recording(builder: PaintBuilder): { builder: PaintBuilder; paints: Paint[] } {
  const paints: Paint[] = [];
  const note = (paint: Paint): void => {
    while (paints.length < builder.positions.length / 9) paints.push(paint);
  };
  return {
    paints,
    builder: {
      ...builder,
      get positions() {
        return builder.positions;
      },
      get ids() {
        return builder.ids;
      },
      quad(a, b, c, d, paint, options) {
        builder.quad(a, b, c, d, paint, options);
        note(paint);
      },
      triangle(a, b, c, paint, options) {
        builder.triangle(a, b, c, paint, options);
        note(paint);
      },
      mesh(source, matrix, paint, options) {
        builder.mesh(source, matrix, paint, options);
        note(paint);
      },
    },
  };
}

/**
 * Pairs of a builder's triangles in two different paints that share a plane and a facing and
 * overlap by more than `slack` metres: each pair's middle and tints, one per metre of the set.
 */
function coplanarOverlaps(
  builder: PaintBuilder,
  paints: readonly Paint[],
  slack = 0.004,
): { at: Vec3; tints: [number, number] }[] {
  const faces = triangles(builder);
  const groups = new Map<string, number[]>();
  for (const [i, { normal, corners }] of faces.entries()) {
    const offset =
      normal[0] * corners[0][0] + normal[1] * corners[0][1] + normal[2] * corners[0][2];
    const key = `${normal.map((n) => Math.round(n * 200)).join()}|${Math.round(offset * 500)}`;
    const group = groups.get(key);
    if (group) group.push(i);
    else groups.set(key, [i]);
  }
  const found = new Map<string, { at: Vec3; tints: [number, number] }>();
  for (const group of groups.values()) {
    if (new Set(group.map((i) => paints[i])).size < 2) continue;
    const { normal } = faces[group[0]];
    // The plane's own two axes.
    const drop = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
    const [p, q] = [0, 1, 2].filter((axis) => axis !== drop);
    const flat = group.map((i) => faces[i].corners.map((c) => [c[p], c[q]] as const));
    const cells = new Map<string, number[]>();
    for (const [k, corners] of flat.entries()) {
      const low = [0, 1].map((axis) => Math.floor(Math.min(...corners.map((c) => c[axis]))));
      const high = [0, 1].map((axis) => Math.floor(Math.max(...corners.map((c) => c[axis]))));
      for (let x = low[0]; x <= high[0]; x++) {
        for (let y = low[1]; y <= high[1]; y++) {
          const cell = cells.get(`${x},${y}`);
          if (!cell) {
            cells.set(`${x},${y}`, [k]);
            continue;
          }
          for (const other of cell) {
            const [mine, theirs] = [paints[group[k]], paints[group[other]]];
            if (mine === theirs || !overlap(flat[k], flat[other], slack)) continue;
            const at = faces[group[k]].centre;
            found.set(at.map(Math.round).join(), { at, tints: [mine.tint, theirs.tint] });
          }
          cell.push(k);
        }
      }
    }
  }
  return [...found.values()];
}

/** Whether two triangles in a plane overlap by more than `slack` along every separating axis. */
function overlap(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[],
  slack: number,
): boolean {
  for (const shape of [a, b]) {
    for (let i = 0; i < 3; i++) {
      const [x0, y0] = shape[i];
      const [x1, y1] = shape[(i + 1) % 3];
      const length = Math.hypot(x1 - x0, y1 - y0);
      if (length < 1e-9) return false;
      const axis = [(y1 - y0) / length, (x0 - x1) / length];
      const span = (points: typeof a): [number, number] => {
        const along = points.map(([x, y]) => x * axis[0] + y * axis[1]);
        return [Math.min(...along), Math.max(...along)];
      };
      const [a0, a1] = span(a);
      const [b0, b1] = span(b);
      if (Math.min(a1, b1) - Math.max(a0, b0) <= slack) return false;
    }
  }
  return true;
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

  test('the material lays the scan on nothing: it reads it only as swatch marks', () => {
    const scan = { image: { width: 8, height: 8 } } as unknown as Texture;
    const material = createPaintMaterial(
      scan,
      [SWATCH.wall],
      flatView(5, RED, () => true),
    );
    // No id map and no painter's camera: nothing to project the scan through.
    expect(Object.keys(material.uniforms).sort()).toEqual([
      'uGain',
      'uPatchMean',
      'uPatchRect',
      'uScan',
      'uScanSize',
    ]);
    material.dispose();
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
  const { builder: set, paints } = recording(paintBuilder([]));
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

  test('no two faces that face the same way lie over each other in one plane', () => {
    // Two such faces fight for the depth buffer and flicker, as a door's foot did on the ground.
    const fights = coplanarOverlaps(set, paints).map(
      ({ at, tints }) =>
        `${at.map((x) => x.toFixed(2)).join(' ')}: ${tints.map((t) => t.toString(16)).join(' on ')}`,
    );
    expect(fights).toEqual([]);
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

describe('café lantern', () => {
  const set = paintBuilder([]);
  drain(buildSet(set, mulberry32(8)));
  const lamp = paintBuilder([]);
  buildLantern(lamp);
  const parts = triangles(lamp).map(({ corners }) => corners.map((c) => c[1]));
  const top = Math.max(...parts.flat());

  /** Heights at which the plumb line through the lantern meets the set, lowest first. */
  const overhead = triangles(set)
    .flatMap(({ corners: [a, b, c] }) => {
      const area = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
      if (Math.abs(area) < 1e-9) return [];
      const u = ((LAMP[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (LAMP[2] - a[2])) / area;
      const v = ((b[0] - a[0]) * (LAMP[2] - a[2]) - (LAMP[0] - a[0]) * (b[2] - a[2])) / area;
      if (u < 0 || v < 0 || u + v > 1) return [];
      return [a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1])];
    })
    .filter((y) => y > LAMP[1])
    .sort((p, q) => p - q);

  test('hangs in one piece: its rod meets its cap', () => {
    const spans = parts.map((ys) => [Math.min(...ys), Math.max(...ys)]).sort((p, q) => p[0] - q[0]);
    let reached = spans[0][1];
    for (const [low, high] of spans) {
      expect(low).toBeLessThanOrEqual(reached + 1e-4);
      reached = Math.max(reached, high);
    }
  });

  test("its rod ends inside a rafter of the awning's frame, and never comes out above it", () => {
    // The first thing over the lantern is the rafter it hangs from, and the rod stops inside it.
    expect(overhead.length).toBeGreaterThan(3);
    expect(top).toBeGreaterThan(overhead[0]);
    expect(top).toBeLessThan(overhead[1]);
    expect(overhead[1] - overhead[0]).toBeLessThan(0.06);
  });

  test("the awning's height over a point is the canvas the set builds there", () => {
    const { y, along } = awningOver(LAMP[0], LAMP[2]);
    expect(Math.min(...overhead.map((hit) => Math.abs(hit - y)))).toBeLessThan(0.005);
    expect(along).toBeGreaterThan(0);
    expect(along).toBeLessThan(1);
    for (const [corner, far] of [
      [AWNING[0], 0],
      [AWNING[1], 0],
      [AWNING[2], 1],
      [AWNING[3], 1],
    ] as const) {
      const at = awningOver(corner[0], corner[2]);
      expect(at.y).toBeCloseTo(corner[1], 6);
      expect(at.along).toBeCloseTo(far, 6);
    }
  });
});

describe('café sky', async () => {
  const { data, info } = await sharp('public/paintings/cafe-terrace-at-night/frame.webp')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { builder: sky, paints } = recording(paintBuilder([]));
  const count = drain(
    buildSky(sky, { width: info.width, height: info.height, data }, mulberry32(3)),
  );
  const faces = triangles(sky);
  // The dome is the first mesh: everything after it is a star's dab.
  const dome = paints.indexOf(paints.find((paint) => paint !== paints[0]) as Paint);
  const dabs = faces.slice(dome).map(({ centre }) => toCanvas(centre));

  test('takes nothing from what the painter saw: no roof or chimney can be painted into it', () => {
    const local = localColours(
      sky,
      flatView(ID.sky, [0.8, 0.1, 0.05], () => true),
    );
    // Every point keeps its own colour, whatever the scan shows there: the dome its blues.
    for (let i = 0; i < local.length; i += 3) expect(local[i]).not.toBeCloseTo(0.8, 2);
    for (let i = 0; i < dome * 9; i += 3) expect(local[i + 2]).toBeGreaterThan(local[i] * 2);
  });

  test('builds every star the painting shows where it shows it', () => {
    expect(count).toBe(STARS.length / 3 + STREWN_STARS);
    for (let i = 0; i < STARS.length; i += 3) {
      const [u, v, radius] = [STARS[i], STARS[i + 1], STARS[i + 2]];
      expect(inPaintedSky(u, v)).toBe(true);
      const near = dabs.filter(
        (dab) => dab.depth > 0 && Math.hypot((dab.u - u) * (1280 / 1596), dab.v - v) < radius,
      );
      expect(near.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('strews the rest of the sky with stars, and none over the painted ones', () => {
    const strewn = dabs.filter((dab) => !(dab.depth > 0 && inPaintedSky(dab.u, dab.v)));
    expect(strewn.length).toBeGreaterThan(STREWN_STARS * 2);
    // Inside the painted sky every dab belongs to a painted star.
    for (const dab of dabs) {
      if (!(dab.depth > 0 && inPaintedSky(dab.u, dab.v))) continue;
      let owned = false;
      for (let i = 0; i < STARS.length && !owned; i += 3) {
        owned =
          Math.hypot((dab.u - STARS[i]) * (1280 / 1596), dab.v - STARS[i + 1]) < 1.4 * STARS[i + 2];
      }
      expect(owned).toBe(true);
    }
  });

  test('stands every star inside the dome, above the level, with no two faces in one plane', () => {
    for (const { corners } of faces.slice(dome)) {
      for (const [x, y, z] of corners) {
        const reach = Math.hypot(x - PAINTER_EYE[0], y - PAINTER_EYE[1], z - PAINTER_EYE[2]);
        // The dome's flat faces dip half a metre inside its radius.
        expect(reach).toBeLessThan(SKY_RADIUS - 0.6);
        expect(reach).toBeGreaterThan(SKY_RADIUS - 3);
        expect(y).toBeGreaterThan(PAINTER_EYE[1]);
      }
    }
    expect(coplanarOverlaps(sky, paints)).toEqual([]);
  });
});
