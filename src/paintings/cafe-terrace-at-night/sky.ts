/**
 * The café's sky: a dome in the night's own blues under the scan's brushwork, and each star built
 * as dabs of its own colours. None of the scan's picture lies on the dome, so no painted roof or
 * chimney shows in the sky from anywhere. Pure geometry, no WebGL.
 */
import { Color, Float32BufferAttribute, Matrix4, SphereGeometry } from 'three';
import type { Raster } from '../../demo/canvas/field';
import type { Vec3 } from '../../render/strokes/frame';
import type { Steps } from '../../util/slicer';
import { CANVAS_ASPECT, CANVAS_LENS, canvasRay, PAINTER_EYE, toCanvas } from './canvas';
import { ID, inPaintedSky, STARS, SWATCH } from './layout';
import type { Paint, PaintBuilder } from './paint';
import { scanSampler } from './scan';

export const SKY_RADIUS = 120;
/** The sky's deep and pale blues, the scan's own between its stars. */
const SKY_DEEP = 0x0c3f86;
const SKY_PALE = 0x1b5590;
/** Stars strewn over the sky the painting does not show, about half as thick as it paints them. */
export const STREWN_STARS = 2400;
/** Canvas heights. A star under the first is one dab; from the second it has two rings of petals. */
const SMALL = 0.0045;
const BIG = 0.0085;
/** Lowest strewn star, as the sine of its height above the level. */
const LOWEST = Math.sin((4 * Math.PI) / 180);
const TAPS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.5, 0],
  [-0.5, 0],
  [0, 0.5],
  [0, -0.5],
];

interface Dab {
  /** Corners in star radii: x right and y down the canvas. */
  readonly corners: readonly (readonly [number, number])[];
  readonly paint: Paint;
  /** 0 the outer petals, 2 the heart: a higher layer stands nearer the eye. */
  readonly layer: number;
}

/** A star's light on the scan, as against the blue round it. */
function lit([r, g, b]: readonly [number, number, number]): boolean {
  return r > 0.6 * b && 0.2126 * r + 0.7152 * g + 0.0722 * b > 95;
}

/** The dabs of the star the scan paints at canvas (u, v), `radius` canvas heights across. */
function dabsOf(
  u: number,
  v: number,
  radius: number,
  sample: (u: number, v: number) => readonly [number, number, number],
): Dab[] {
  const tintAt = (x: number, y: number, reach: number): number | null => {
    const sum = [0, 0, 0];
    let hits = 0;
    for (const [dx, dy] of TAPS) {
      const dab = sample(
        u + ((x + dx * reach) * radius) / CANVAS_ASPECT,
        v + (y + dy * reach) * radius,
      );
      if (!lit(dab)) continue;
      for (let k = 0; k < 3; k++) sum[k] += dab[k];
      hits++;
    }
    if (hits === 0) return null;
    return (
      (Math.round(sum[0] / hits) << 16) |
      (Math.round(sum[1] / hits) << 8) |
      Math.round(sum[2] / hits)
    );
  };
  // A star's heart is its warmest paint, lit or not: a small star is a pixel or two of the scan.
  const heartAt = (reach: number): number => {
    let best: readonly [number, number, number] = [0, 0, 0];
    for (const [dx, dy] of TAPS) {
      const dab = sample(u + (dx * reach * radius) / CANVAS_ASPECT, v + dy * reach * radius);
      if (dab[0] + dab[1] - dab[2] > best[0] + best[1] - best[2]) best = dab;
    }
    return (best[0] << 16) | (best[1] << 8) | best[2];
  };
  const dabs: Dab[] = [];
  const dab = (corners: Dab['corners'], tint: number | null, layer: number): void => {
    if (tint === null) return;
    dabs.push({
      corners,
      layer,
      paint: { id: ID.sky, swatch: SWATCH.sky, tint, painted: false, lit: true },
    });
  };
  const heart = (half: number, wide: number): Dab['corners'] => [
    [-wide, 0],
    [0, -half],
    [wide, 0],
    [0, half],
  ];
  if (radius < SMALL) {
    dab(heart(0.8, 1), heartAt(0.5), 2);
    return dabs;
  }
  dab(heart(0.42, 0.42), tintAt(0, 0, 0.3) ?? heartAt(0.3), 2);
  // Petals round the heart, each a wedge of its ring so none reaches its neighbour. One over blue
  // paint is left out, so the star keeps the ragged outline the scan gives it.
  const ring = (count: number, inner: number, outer: number, layer: number): void => {
    const half = (0.8 * Math.PI) / count;
    for (let k = 0; k < count; k++) {
      const angle = (2 * Math.PI * (k + 0.5 * layer)) / count;
      const at = (out: number, turn: number): [number, number] => [
        out * Math.cos(angle + turn),
        out * Math.sin(angle + turn),
      ];
      const [x, y] = at((inner + outer) / 2, 0);
      dab(
        [at(inner, -half), at(inner, half), at(outer, half), at(outer, -half)],
        tintAt(x, y, (outer - inner) / 2),
        layer,
      );
    }
  };
  if (radius < BIG) ring(6, 0.4, 1, 1);
  else {
    ring(6, 0.34, 0.78, 1);
    ring(10, 0.72, 1.2, 0);
  }
  return dabs;
}

function unit([x, y, z]: Vec3): Vec3 {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

/**
 * Builds the dome and its stars into `sky`: the painting's own where it paints them, and others
 * like them over the rest of the sky. Returns how many stars it built.
 */
export function* buildSky(sky: PaintBuilder, raster: Raster, random: () => number): Steps<number> {
  const dome = new SphereGeometry(SKY_RADIUS, 48, 24);
  const position = dome.getAttribute('position');
  const blues = new Float32Array(position.count * 3);
  const deep = new Color(SKY_DEEP);
  const pale = new Color(SKY_PALE);
  const blue = new Color();
  for (let i = 0; i < position.count; i++) {
    const turn = Math.atan2(position.getX(i), -position.getZ(i));
    const rise = Math.asin(Math.min(1, Math.max(-1, position.getY(i) / SKY_RADIUS)));
    // Broad upright swathes of the paler blue, evened out toward the poles where they would meet.
    const wave = Math.sin(5 * turn + 2.1 * Math.sin(3 * turn + 1.3) + 4 * rise);
    blue.lerpColors(deep, pale, 0.5 + 0.5 * wave * Math.cos(rise)).toArray(blues, i * 3);
  }
  dome.setAttribute('color', new Float32BufferAttribute(blues, 3));
  sky.mesh(
    dome,
    new Matrix4().makeTranslation(...PAINTER_EYE),
    { id: ID.sky, swatch: SWATCH.sky, tint: SKY_DEEP, painted: false, lit: true },
    { own: true, uvScale: [96, 48] },
  );
  dome.dispose();
  yield;

  const sample = scanSampler(raster);
  const placed: { at: Vec3; reach: number }[] = [];
  const emit = (dabs: readonly Dab[], place: (x: number, y: number) => Vec3): void => {
    // Each star on a shell of its own inside the dome, its heart nearest the eye.
    const shell = SKY_RADIUS - 1 - 1.2 * random();
    for (const { corners, paint, layer } of dabs) {
      const [a, b, c, d] = corners.map(([x, y]): Vec3 => {
        const [dx, dy, dz] = place(x, y);
        const r = shell - 0.15 * layer;
        return [PAINTER_EYE[0] + dx * r, PAINTER_EYE[1] + dy * r, PAINTER_EYE[2] + dz * r];
      });
      sky.quad(a, b, c, d, paint, { toward: PAINTER_EYE });
    }
  };

  const painted: { dabs: Dab[]; radius: number }[] = [];
  for (let i = 0; i < STARS.length; i += 3) {
    const [u, v, radius] = [STARS[i], STARS[i + 1], STARS[i + 2]];
    const dabs = dabsOf(u, v, radius, sample);
    painted.push({ dabs, radius });
    emit(dabs, (x, y) => unit(canvasRay(u + (x * radius) / CANVAS_ASPECT, v + y * radius)));
    placed.push({ at: unit(canvasRay(u, v)), reach: (1.3 * radius) / CANVAS_LENS[1] });
  }
  yield;

  let strewn = 0;
  for (let tries = 0; strewn < STREWN_STARS && tries < STREWN_STARS * 4; tries++) {
    const y = LOWEST + (1 - LOWEST) * random();
    const turn = 2 * Math.PI * random();
    const level = Math.sqrt(1 - y * y);
    const at: Vec3 = [level * Math.sin(turn), y, -level * Math.cos(turn)];
    const { dabs, radius } = painted[Math.floor(random() * painted.length)];
    const size = (radius * (0.8 + 0.4 * random())) / CANVAS_LENS[1];
    const roll = 2 * Math.PI * random();
    const reach = 1.3 * size;
    const right = unit(Math.abs(at[1]) > 0.9 ? [0, at[2], -at[1]] : [at[2], 0, -at[0]]);
    const up: Vec3 = [
      at[1] * right[2] - at[2] * right[1],
      at[2] * right[0] - at[0] * right[2],
      at[0] * right[1] - at[1] * right[0],
    ];
    // The painting's own stars fill the sky it shows: no other reaches into it.
    const shown = (p: number, q: number): boolean => {
      const hit = toCanvas([
        PAINTER_EYE[0] + at[0] + p * right[0] + q * up[0],
        PAINTER_EYE[1] + at[1] + p * right[1] + q * up[1],
        PAINTER_EYE[2] + at[2] + p * right[2] + q * up[2],
      ]);
      return hit.depth > 0 && inPaintedSky(hit.u, hit.v);
    };
    if (shown(0, 0) || shown(reach, 0) || shown(-reach, 0) || shown(0, reach) || shown(0, -reach)) {
      continue;
    }
    if (
      placed.some(
        (other) =>
          at[0] * other.at[0] + at[1] * other.at[1] + at[2] * other.at[2] >
          Math.cos(reach + other.reach),
      )
    ) {
      continue;
    }
    placed.push({ at, reach });
    const [c, s] = [Math.cos(roll) * size, Math.sin(roll) * size];
    emit(dabs, (x, y2) => {
      const [p, q] = [x * c - y2 * s, x * s + y2 * c];
      return unit([
        at[0] + p * right[0] + q * up[0],
        at[1] + p * right[1] + q * up[1],
        at[2] + p * right[2] + q * up[2],
      ]);
    });
    strewn++;
    if (strewn % 200 === 0) yield;
  }
  return painted.length + strewn;
}
