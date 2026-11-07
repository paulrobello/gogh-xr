import { DataTexture, RGBAFormat } from 'three';
import { describe, expect, test } from 'vitest';
import { DEPTH_BACKDROP_FLAG } from '../src/render/strokes/backdrop-depth.ts';
import {
  ATLAS_SIZE,
  BRUSH_CHANNEL,
  BRUSH_COUNT,
  BRUSHES,
  brushTexelRect,
  generateBrushAtlas,
} from '../src/render/strokes/brush-atlas-data.ts';
import { DEPTH_TIE_BREAK_FRONT_FLAG } from '../src/render/strokes/depth-tie-break.ts';
import {
  BRUSH_FOOTPRINT,
  clampToFace,
  clampToFaceByWidth,
  encodeFitScale,
  type FacePolygon,
  FIT_SCALE_MASK,
  FIT_SCALE_MAX,
  FIT_SCALE_SHIFT,
  FIT_SCALE_STEP,
  facePolygons,
  fitScaleLimit,
  fitStrokeToFace,
} from '../src/render/strokes/face-clamp.ts';
import type { Vec3 } from '../src/render/strokes/frame.ts';
import { createStrokeMaterial } from '../src/render/strokes/material.ts';
import {
  createMeshBuilder,
  type LocalFrame,
  pushGableRoof,
  pushGableWalls,
  pushQuad,
  toGeometry,
} from '../src/world/house-geometry.ts';

/** A 4 × 2 m wall in the z = 0 plane facing +z, x in [-2, 2], y in [0, 2]. */
function wallFace(): FacePolygon {
  const m = createMeshBuilder();
  pushQuad(m, [-2, 0, 0], [2, 0, 0], [2, 2, 0], [-2, 2, 0], [0, 0, 1]);
  const { faces } = facePolygons(toGeometry(m, 'building'));
  expect(faces).toHaveLength(1);
  return faces[0];
}

/** How far the rectangle reaches outside the face, in its plane, metres (0 when inside). */
function overhang(face: FacePolygon, centre: Vec3, long: Vec3, length: number, width: number) {
  const short: Vec3 = [
    face.normal[1] * long[2] - face.normal[2] * long[1],
    face.normal[2] * long[0] - face.normal[0] * long[2],
    face.normal[0] * long[1] - face.normal[1] * long[0],
  ];
  let worst = 0;
  for (const [sa, sb] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]) {
    const p = [0, 1, 2].map(
      (k) => centre[k] + (sa * length * long[k]) / 2 + (sb * width * short[k]) / 2 - face.origin[k],
    );
    const x = p[0] * face.e1[0] + p[1] * face.e1[1] + p[2] * face.e1[2];
    const y = p[0] * face.e2[0] + p[1] * face.e2[1] + p[2] * face.e2[2];
    for (const e of face.edges) worst = Math.max(worst, e.nx * x + e.ny * y - e.d);
  }
  return worst;
}

/** Euclidean distance from each corner of the rectangle to the face's hull, worst corner, metres. */
function euclideanOverhang(
  face: FacePolygon,
  centre: Vec3,
  long: Vec3,
  length: number,
  width: number,
): number {
  const short: Vec3 = [
    face.normal[1] * long[2] - face.normal[2] * long[1],
    face.normal[2] * long[0] - face.normal[0] * long[2],
    face.normal[0] * long[1] - face.normal[1] * long[0],
  ];
  const vs = face.vertices;
  let worst = 0;
  for (const [sa, sb] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]) {
    const p = [0, 1, 2].map(
      (k) => centre[k] + (sa * length * long[k]) / 2 + (sb * width * short[k]) / 2 - face.origin[k],
    );
    const x = p[0] * face.e1[0] + p[1] * face.e1[1] + p[2] * face.e1[2];
    const y = p[0] * face.e2[0] + p[1] * face.e2[1] + p[2] * face.e2[2];
    let inside = true;
    let gap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < vs.length; i++) {
      const [ax, ay] = vs[i];
      const [bx, by] = vs[(i + 1) % vs.length];
      const ex = bx - ax;
      const ey = by - ay;
      if (ex * (y - ay) - ey * (x - ax) < 0) inside = false;
      const f = Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
      gap = Math.min(gap, Math.hypot(x - ax - f * ex, y - ay - f * ey));
    }
    if (!inside) worst = Math.max(worst, gap);
  }
  return worst;
}

/** A small deterministic generator for the fuzz cases. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];

describe('facePolygons', () => {
  test('the two triangles of a quad are one face, its rectangle', () => {
    const face = wallFace();
    expect(face.vertices).toHaveLength(4);
    expect(face.area).toBeCloseTo(8, 9);
    expect(face.hullArea).toBeCloseTo(8, 9);
    expect(face.normal[2]).toBeCloseTo(1, 9);
  });

  test('a gable end wall and its gable triangle are one pentagon; roofs stay separate', () => {
    const frame: LocalFrame = { cx: 3, cz: -20, base: -4, yaw: 0.4 };
    const box = { width: 4, depth: 3, eave: 2.8, rise: 1.5, overhang: 0.25 };
    const walls = createMeshBuilder();
    pushGableWalls(walls, frame, box);
    const roof = createMeshBuilder();
    pushGableRoof(roof, frame, box);
    const wallFaces = facePolygons(toGeometry(walls, 'building')).faces;
    // Two long walls (rectangles) and two gable ends (pentagons).
    expect(wallFaces.map((f) => f.vertices.length).sort()).toEqual([4, 4, 5, 5]);
    const roofFaces = facePolygons(toGeometry(roof, 'roof')).faces;
    expect(roofFaces.map((f) => f.vertices.length)).toEqual([4, 4]);
    for (const f of [...wallFaces, ...roofFaces]) expect(f.hullArea).toBeCloseTo(f.area, 6);
  });

  test('every triangle maps to the face that holds it', () => {
    const m = createMeshBuilder();
    pushQuad(m, [-2, 0, 0], [2, 0, 0], [2, 2, 0], [-2, 2, 0], [0, 0, 1]);
    // A separate quad facing +x: not coplanar, so its own face.
    pushQuad(m, [2, 0, 0], [2, 0, -3], [2, 2, -3], [2, 2, 0], [1, 0, 0]);
    const { faceOf, faces } = facePolygons(toGeometry(m, 'building'));
    expect(faces).toHaveLength(2);
    expect(Array.from(faceOf)).toEqual([0, 0, 1, 1]);
  });

  test('a zero-area triangle gets no face and leaves the others finite', () => {
    const m = createMeshBuilder();
    pushQuad(m, [-2, 0, 0], [2, 0, 0], [2, 2, 0], [-2, 2, 0], [0, 0, 1]);
    // A quad with a repeated vertex: one real triangle and one of zero area, on the first quad's edge.
    pushQuad(m, [2, 0, 0], [2, 0, -3], [2, 2, -3], [2, 2, -3], [1, 0, 0]);
    const { faceOf, faces } = facePolygons(toGeometry(m, 'building'));
    expect(Array.from(faceOf)).toEqual([0, 0, 1, -1]);
    expect(faces).toHaveLength(2);
    for (const f of faces) {
      for (const v of [...f.normal, ...f.vertices.flat()]) expect(Number.isFinite(v)).toBe(true);
      for (const e of f.edges)
        expect(Number.isFinite(e.nx + e.ny + e.d + e.marginScale)).toBe(true);
    }
  });
});

describe('clampToFace', () => {
  const margin = 0.02;

  test('a stroke inside its face is unchanged', () => {
    const face = wallFace();
    const r = clampToFace(face, { centre: [0, 1, 0], long: X, length: 1, width: 0.3 }, margin);
    expect(r.centre).toEqual([0, 1, 0]);
    expect(r.length).toBe(1);
    expect(r.width).toBe(0.3);
    expect(r.fitScale).toBeGreaterThan(1);
  });

  test('a stroke crossing the quad’s internal diagonal is unchanged', () => {
    const face = wallFace();
    const long: Vec3 = [Math.SQRT1_2, -Math.SQRT1_2, 0];
    const r = clampToFace(face, { centre: [0.1, 1, 0], long, length: 1.2, width: 0.3 }, margin);
    expect(r.length).toBe(1.2);
    expect(r.centre[0]).toBeCloseTo(0.1, 12);
    expect(r.centre[1]).toBeCloseTo(1, 12);
  });

  test('a stroke over an end slides inward along its axis and keeps its length', () => {
    const face = wallFace();
    const r = clampToFace(face, { centre: [1.8, 1, 0], long: X, length: 1, width: 0.3 }, margin);
    expect(r.length).toBe(1);
    expect(r.width).toBe(0.3);
    expect(r.centre[0]).toBeCloseTo(2 + margin - 0.5, 9);
    expect(r.centre[1]).toBeCloseTo(1, 9);
    expect(overhang(face, r.centre, X, r.length, r.width)).toBeLessThanOrEqual(margin + 1e-9);
  });

  test('a stroke longer than the room along its line shrinks to that room, centred in it', () => {
    const face = wallFace();
    // Vertical: 2 m of wall plus the margin each end, against a 3 m stroke.
    const r = clampToFace(face, { centre: [0, 0.5, 0], long: Y, length: 3, width: 0.3 }, margin);
    expect(r.length).toBeCloseTo(2 + 2 * margin, 9);
    expect(r.centre[1]).toBeCloseTo(1, 9);
    expect(overhang(face, r.centre, Y, r.length, r.width)).toBeLessThanOrEqual(margin + 1e-9);
  });

  test('a stroke over a side edge moves across by the overhang only', () => {
    const face = wallFace();
    const r = clampToFace(face, { centre: [0, 1.95, 0], long: X, length: 1, width: 0.3 }, margin);
    expect(r.width).toBe(0.3);
    expect(r.length).toBe(1);
    expect(r.centre[0]).toBeCloseTo(0, 9);
    expect(r.centre[1]).toBeCloseTo(2 + margin - 0.15, 9);
  });

  test('a face narrower than the stroke narrows it, never wider than it is long', () => {
    // A 0.2 m strip.
    const m = createMeshBuilder();
    pushQuad(m, [-2, 0, 0], [2, 0, 0], [2, 0.2, 0], [-2, 0.2, 0], [0, 0, 1]);
    const face = facePolygons(toGeometry(m, 'window')).faces[0];
    const r = clampToFace(face, { centre: [0, 0.1, 0], long: X, length: 1, width: 0.5 }, 0.01);
    expect(r.width).toBeCloseTo(0.22, 6);
    expect(overhang(face, r.centre, X, r.length, r.width)).toBeLessThanOrEqual(0.01 + 1e-6);
    // Pointing across the strip: the room along its line is 0.22 m, so it ends 0.22 × 0.22.
    const across = clampToFace(face, { centre: [0, 0.1, 0], long: Y, length: 1, width: 0.5 }, 0.01);
    expect(across.length).toBeCloseTo(0.22, 6);
    expect(across.width).toBeLessThanOrEqual(across.length + 1e-9);
    expect(overhang(face, across.centre, Y, across.length, across.width)).toBeLessThanOrEqual(
      0.01 + 1e-6,
    );
  });

  test('the fit scale is the largest scale about the centre that stays inside', () => {
    const face = wallFace();
    const r = clampToFace(face, { centre: [1.2, 1, 0], long: X, length: 1, width: 0.3 }, margin);
    const s = r.fitScale;
    expect(s).toBeGreaterThanOrEqual(1);
    expect(overhang(face, r.centre, X, r.length * s, r.width * s)).toBeCloseTo(margin, 9);
    // 1.2 + 0.5 s = 2.02 along x binds first.
    expect(s).toBeCloseTo((2 + margin - 1.2) / 0.5, 9);
  });
});

describe('clampToFaceByWidth', () => {
  test('a stroke narrowed by its face keeps the margin a share of its new width', () => {
    // A 0.2 m strip: the width w meets 0.2 + 2 × 0.1 × w, so w = 0.25.
    const m = createMeshBuilder();
    pushQuad(m, [-2, 0, 0], [2, 0, 0], [2, 0.2, 0], [-2, 0.2, 0], [0, 0, 1]);
    const face = facePolygons(toGeometry(m, 'window')).faces[0];
    const r = clampToFaceByWidth(
      face,
      { centre: [0, 0.1, 0], long: X, length: 1, width: 0.5 },
      0.1,
    );
    expect(r.width).toBeCloseTo(0.25, 5);
    expect(overhang(face, r.centre, X, r.length, r.width)).toBeLessThanOrEqual(
      0.1 * r.width + 1e-6,
    );
  });

  test('a stroke the face holds is clamped as by clampToFace at that margin', () => {
    const face = wallFace();
    const stroke = { centre: [1.8, 1, 0] as Vec3, long: X, length: 1, width: 0.3 };
    expect(clampToFaceByWidth(face, stroke, 0.1)).toEqual(clampToFace(face, stroke, 0.03));
  });

  test('no quad corner lands further than the margin from its face, even by a sharp vertex', () => {
    // A rectangle, and a spire face whose apex is 20 degrees.
    const rect = wallFace();
    const spire = createMeshBuilder();
    const h = 1 / Math.tan((10 * Math.PI) / 180);
    pushQuad(spire, [-1, 0, 0], [1, 0, 0], [0, h, 0], [0, h, 0], [0, 0, 1]);
    const spireFace = facePolygons(toGeometry(spire, 'church')).faces[0];
    expect(spireFace.vertices).toHaveLength(3);
    const rand = lcg(7);
    let checked = 0;
    for (const face of [rect, spireFace]) {
      for (let k = 0; k < 4000; k++) {
        // A point in the face: a random blend of its vertices.
        const w = face.vertices.map(() => rand() ** 3);
        const sw = w.reduce((a, b) => a + b, 0);
        const x = face.vertices.reduce((acc, p, i) => acc + (p[0] * w[i]) / sw, 0);
        const y = face.vertices.reduce((acc, p, i) => acc + (p[1] * w[i]) / sw, 0);
        const centre = [0, 1, 2].map(
          (q) => face.origin[q] + x * face.e1[q] + y * face.e2[q],
        ) as unknown as Vec3;
        const th = rand() * Math.PI * 2;
        const long = [0, 1, 2].map(
          (q) => Math.cos(th) * face.e1[q] + Math.sin(th) * face.e2[q],
        ) as unknown as Vec3;
        const length = 0.1 + rand() * 1.5;
        const rect = { centre, long, length, width: length * (0.2 + rand() * 0.8) };
        for (const r of [
          { ...clampToFaceByWidth(face, rect, 0.1), long },
          fitStrokeToFace(face, rect, 0.1),
        ]) {
          const limit = 0.1 * r.width + 1e-9;
          expect(euclideanOverhang(face, r.centre, r.long, r.length, r.width)).toBeLessThanOrEqual(
            limit,
          );
          // The fit scale holds the same bound at the margin of the unscaled width.
          const s = Math.min(r.fitScale, 3);
          expect(s).toBeGreaterThanOrEqual(1 - 1e-9);
          expect(
            euclideanOverhang(face, r.centre, r.long, r.length * s, r.width * s),
          ).toBeLessThanOrEqual(limit);
        }
        checked++;
      }
    }
    expect(checked).toBe(8000);
  });
});

describe('fitStrokeToFace', () => {
  test('a stroke inside its face keeps its axis', () => {
    const face = wallFace();
    const r = fitStrokeToFace(face, { centre: [0, 1, 0], long: X, length: 1, width: 0.3 }, 0.1);
    expect(r.aligned).toBe(false);
    expect(r.long).toEqual(X);
    expect(r.centre).toEqual([0, 1, 0]);
  });

  test('a stroke whose end reaches past a side turns to run along it, flush at the margin', () => {
    const face = wallFace();
    // Pointing +x and up a little, its end past the right side (x = 2).
    const long: Vec3 = [Math.cos(0.3), Math.sin(0.3), 0];
    const r = fitStrokeToFace(face, { centre: [1.8, 1, 0], long, length: 1, width: 0.3 }, 0.1);
    expect(r.aligned).toBe(true);
    // Along the side, still pointing up rather than down.
    expect(r.long[0]).toBeCloseTo(0, 9);
    expect(r.long[1]).toBeCloseTo(1, 9);
    expect(r.length).toBe(1);
    expect(r.width).toBe(0.3);
    // Its outer side on x = 2 plus 10% of its width; its height kept.
    expect(r.centre[0]).toBeCloseTo(2 + 0.03 - 0.15, 9);
    expect(r.centre[1]).toBeCloseTo(1, 9);
    expect(euclideanOverhang(face, r.centre, r.long, r.length, r.width)).toBeCloseTo(0.03, 9);
  });

  test('in a corner a stroke runs along the side it already runs most nearly along', () => {
    const face = wallFace();
    const r = fitStrokeToFace(face, { centre: [1.9, 1.9, 0], long: X, length: 1, width: 0.3 }, 0.1);
    expect(r.aligned).toBe(true);
    expect(r.long[0]).toBeCloseTo(1, 9);
    // Flush under the top side, slid back from the right one until the corner's bevel holds its
    // end corner: x + 0.5 + 2.03 ≤ 4 + 0.03.
    expect(r.centre[1]).toBeCloseTo(2 + 0.03 - 0.15, 9);
    expect(r.centre[0]).toBeCloseTo(1.5, 9);
    expect(euclideanOverhang(face, r.centre, r.long, r.length, r.width)).toBeLessThanOrEqual(
      0.03 + 1e-9,
    );
  });

  test('a turned stroke near a corner slides back along its new side to fit', () => {
    const face = wallFace();
    const long: Vec3 = [Math.cos(1.2), Math.sin(1.2), 0];
    const r = fitStrokeToFace(face, { centre: [1.9, 1.7, 0], long, length: 1, width: 0.3 }, 0.1);
    expect(r.aligned).toBe(true);
    expect(r.long[1]).toBeCloseTo(1, 9);
    expect(r.centre[0]).toBeCloseTo(2 + 0.03 - 0.15, 9);
    expect(r.centre[1]).toBeCloseTo(1.5, 9);
  });
});

describe('fit scale bits', () => {
  test('sit clear of the depth flags in the meta byte', () => {
    for (const fit of [1, 1.3, 5]) {
      const bits = encodeFitScale(fit);
      expect(bits & (DEPTH_TIE_BREAK_FRONT_FLAG | DEPTH_BACKDROP_FLAG)).toBe(0);
      expect(bits).toBeGreaterThan(0);
      expect(bits).toBeLessThan(256);
    }
  });

  test('no bits means no limit', () => {
    expect(fitScaleLimit(0)).toBe(Number.POSITIVE_INFINITY);
    expect(fitScaleLimit(DEPTH_TIE_BREAK_FRONT_FLAG | DEPTH_BACKDROP_FLAG)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test('the decoded limit never exceeds the fit and loses less than one step', () => {
    for (let fit = 1; fit < 2.5; fit += 0.013) {
      const limit = fitScaleLimit(encodeFitScale(fit));
      expect(limit).toBeLessThanOrEqual(fit + 1e-12);
      expect(limit).toBeGreaterThan(Math.min(fit, FIT_SCALE_MAX) - 1 / 16 - 1e-12);
      expect(limit).toBeGreaterThanOrEqual(1);
    }
    expect(fitScaleLimit(encodeFitScale(1))).toBe(1);
    expect(fitScaleLimit(encodeFitScale(100))).toBe(FIT_SCALE_MAX);
  });

  test('a fit below 1 still decodes to 1: the clamp has already made the quad fit at 1', () => {
    expect(fitScaleLimit(encodeFitScale(0.999999))).toBe(1);
  });
});

test('the stroke material carries the fit scale field as defines', () => {
  const material = createStrokeMaterial(new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat));
  const defines = material.defines as Record<string, string>;
  expect(defines.FIT_SCALE_SHIFT).toBe(`${FIT_SCALE_SHIFT}u`);
  expect(defines.FIT_SCALE_MASK).toBe(`${FIT_SCALE_MASK}u`);
  expect(Number(defines.FIT_SCALE_STEP)).toBe(FIT_SCALE_STEP);
  material.dispose();
});

/** Each brush's opaque mask as a symmetric share of its quad's length and width. */
function measuredFootprints(seed: number): { length: number; width: number }[] {
  const atlas = generateBrushAtlas(seed);
  return Array.from({ length: BRUSH_COUNT }, (_, i) => {
    const r = brushTexelRect(i);
    let halfU = 0;
    let halfV = 0;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) {
        if (atlas[(y * ATLAS_SIZE + x) * 4 + BRUSH_CHANNEL.coverage] < 128) continue;
        halfU = Math.max(halfU, Math.abs((x + 0.5 - r.x) / r.width - 0.5));
        halfV = Math.max(halfV, Math.abs((y + 0.5 - r.y) / r.height - 0.5));
      }
    }
    return { length: 2 * halfU, width: 2 * halfV };
  });
}

test('every brush paints inside its kind’s footprint, which is not much larger than the paint', () => {
  const seeds = [1, 2, 3].map(measuredFootprints);
  for (let i = 0; i < BRUSH_COUNT; i++) {
    const table = BRUSH_FOOTPRINT[BRUSHES[i].kind];
    for (const measured of seeds) {
      expect(measured[i].length, `brush ${i} length`).toBeLessThanOrEqual(table.length);
      expect(measured[i].width, `brush ${i} width`).toBeLessThanOrEqual(table.width);
    }
    // Looser than the paint by at most a few texels' share beyond the seed-to-seed spread.
    expect(table.length - seeds[0][i].length, `brush ${i} length`).toBeLessThan(0.12);
    expect(table.width - seeds[0][i].width, `brush ${i} width`).toBeLessThan(0.16);
  }
});
