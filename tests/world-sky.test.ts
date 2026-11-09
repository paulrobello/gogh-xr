import { expect, test } from 'vitest';
import {
  CANVAS_ASPECT,
  canvasRay,
  PAINTER_EYE,
  projectToCanvas,
} from '../src/paintings/starry-night/canvas-camera.ts';
import { createSkyDome, SKY_DOME_RADIUS, skyAnchors } from '../src/world/sky.ts';

test('11 stars and 1 moon are anchored', () => {
  const anchors = skyAnchors();
  expect(anchors.filter((a) => a.kind === 'star')).toHaveLength(11);
  expect(anchors.filter((a) => a.kind === 'moon')).toHaveLength(1);
  expect(Object.isFrozen(anchors[0])).toBe(true);
});

test('every anchor reprojects to its canvas uv within 0.5%', () => {
  for (const a of skyAnchors()) {
    const { uv } = projectToCanvas(a.position);
    expect(uv).not.toBeNull();
    expect(Math.abs((uv?.[0] ?? 9) - a.uv[0])).toBeLessThanOrEqual(0.005);
    expect(Math.abs((uv?.[1] ?? 9) - a.uv[1])).toBeLessThanOrEqual(0.005);
  }
});

test('anchors sit on the dome with v flipped from regions.json', () => {
  const moon = skyAnchors().find((a) => a.kind === 'moon');
  expect(moon?.uv[0]).toBeCloseTo(0.9137, 6);
  expect(moon?.uv[1]).toBeCloseTo(1 - 0.1677, 6);
  for (const a of skyAnchors()) {
    const d = a.position.map((p, i) => p - PAINTER_EYE[i]);
    expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(SKY_DOME_RADIUS, 6);
    expect(a.angularRadius).toBeGreaterThan(0.01);
    expect(a.angularRadius).toBeLessThan(0.2);
  }
  const ray = canvasRay(0.9137, 1 - 0.1677);
  const m = moon?.position ?? [0, 0, 0];
  expect(m[0]).toBeCloseTo(PAINTER_EYE[0] + ray[0] * SKY_DOME_RADIUS, 6);
});

test('dome is low-poly, inward facing, centred on the eye and tagged sky', () => {
  const g = createSkyDome();
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const index = g.getIndex();
  expect(g.userData.layer).toBe('sky');
  expect(index).not.toBeNull();
  const tris = (index?.count ?? 0) / 3;
  expect(tris).toBeGreaterThanOrEqual(200);
  expect(tris).toBeLessThanOrEqual(2000);
  for (let i = 0; i < pos.count; i++) {
    const p: number[] = [pos.getX(i), pos.getY(i) - PAINTER_EYE[1], pos.getZ(i)];
    expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(SKY_DOME_RADIUS, 4);
    const n = [nor.getX(i), nor.getY(i), nor.getZ(i)];
    expect(n[0] * p[0] + n[1] * p[1] + n[2] * p[2]).toBeCloseTo(-SKY_DOME_RADIUS, 4);
  }
  // Winding: every non-degenerate triangle's CCW face normal points toward the centre.
  const idx = index?.array ?? [];
  for (let t = 0; t < tris; t++) {
    const v = [0, 1, 2].map((k) => {
      const i = idx[t * 3 + k];
      return [pos.getX(i), pos.getY(i) - PAINTER_EYE[1], pos.getZ(i)];
    });
    const e1 = v[1].map((x, i) => x - v[0][i]);
    const e2 = v[2].map((x, i) => x - v[0][i]);
    const f = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const c = v[0].map((x, i) => x + v[1][i] + v[2][i]);
    const dot = f[0] * c[0] + f[1] * c[1] + f[2] * c[2];
    if (Math.hypot(f[0], f[1], f[2]) > 1e-9) expect(dot).toBeLessThan(0);
  }
});

const byNote = (note: string) => {
  const a = skyAnchors().find((x) => x.note === note);
  if (!a) throw new Error(`no anchor ${note}`);
  return a;
};

test('anchor uvs match regions.json literals with the v flip written out', () => {
  // [u_json, v_json] from assets/bake/starry-night/regions.json, v pointing down.
  const topLeft = byNote('top left');
  expect(topLeft.kind).toBe('star');
  expect(topLeft.uv[0]).toBeCloseTo(0.0976, 9);
  expect(topLeft.uv[1]).toBeCloseTo(1 - 0.0395, 9);
  const large = byNote('large, lower left of centre');
  expect(large.uv[0]).toBeCloseTo(0.3505, 9);
  expect(large.uv[1]).toBeCloseTo(1 - 0.5293, 9);
  const moon = byNote('crescent and inner glow');
  expect(moon.kind).toBe('moon');
  expect(moon.uv[0]).toBeCloseTo(0.9137, 9);
  expect(moon.uv[1]).toBeCloseTo(1 - 0.1677, 9);
});

test('angularRadius matches a small-angle estimate r * 2 * tan(hfov / 2)', () => {
  const tanHalfX = CANVAS_ASPECT * Math.tan((30 * Math.PI) / 180);
  const tanHalfY = Math.tan((30 * Math.PI) / 180);
  const radii: Record<string, number> = {
    'large, lower left of centre': 0.0666,
    'crescent and inner glow': 0.0696,
    'top left': 0.044,
    'mid left, small': 0.0307,
  };
  for (const [note, r] of Object.entries(radii)) {
    const a = byNote(note);
    const est = r * 2 * tanHalfX;
    // Off-axis, a tangent-plane length subtends less, by up to (1 + rho^2) to the power -1.5.
    const rho2 = ((2 * a.uv[0] - 1) * tanHalfX) ** 2 + ((2 * a.uv[1] - 1) * tanHalfY) ** 2;
    expect(a.angularRadius).toBeLessThanOrEqual(est * 1.02);
    expect(a.angularRadius).toBeGreaterThanOrEqual(est * (1 + rho2) ** -1.5 * 0.98);
  }
  // Near the optical axis the estimate holds within 6%.
  const large = byNote('large, lower left of centre');
  expect(Math.abs(large.angularRadius / (0.0666 * 2 * tanHalfX) - 1)).toBeLessThan(0.06);
});
