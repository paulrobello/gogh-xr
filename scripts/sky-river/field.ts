/**
 * Samples the sky river (src/motion/sky-river.ts) for docs/shots/sky-river-field.png and
 * sky-river-field-around.png: the signed river velocity on a canvas-uv grid over the sky and on an
 * azimuth-elevation grid over the dome, Paul's guide polylines, and the kept wheels' rims. Writes
 * JSON for scripts/sky-river/draw.py.
 *
 *   bun scripts/sky-river/field.ts build/sky-river/field.json
 *   python3 scripts/sky-river/draw.py build/sky-river/field.json docs/shots
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildFlowField } from '../../src/demo/canvas/field';
import {
  buildSkyRiverField,
  SKY_RIVER_PATHS,
  SKY_RIVER_SPEED,
  SKY_RIVER_WHEELS,
  skyRiverBake,
} from '../../src/motion/sky-river';
import { skyWheelAt, skyWheelEdge } from '../../src/motion/sky-swirl';
import {
  canvasRay,
  PAINTER_EYE,
  projectToCanvas,
} from '../../src/paintings/starry-night/canvas-camera';
import type { Vec3 } from '../../src/render/strokes/frame';
import { decode } from '../scatter-time';

const out = process.argv[2] ?? 'build/sky-river/field.json';
const DEG = 180 / Math.PI;

const flow = buildFlowField(await decode('flow.png'));
const field = buildSkyRiverField(flow);

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const proj = (d: Vec3): readonly [number, number] | null =>
  projectToCanvas([
    PAINTER_EYE[0] + 100 * d[0],
    PAINTER_EYE[1] + 100 * d[1],
    PAINTER_EYE[2] + 100 * d[2],
  ]).uv;

/** The motion at d: the kept wheel's turn for a member, else the baked river. deg/s. */
function velocity(d: Vec3): { v: Vec3; member: boolean } {
  const i = skyWheelAt(d, SKY_RIVER_WHEELS);
  if (i >= 0) {
    const w = SKY_RIVER_WHEELS[i];
    const rate = 2 * Math.PI * w.rate;
    return { v: cross([w.axis[0] * rate, w.axis[1] * rate, w.axis[2] * rate], d), member: true };
  }
  const bake = skyRiverBake(field, d);
  return { v: cross(bake.omega, d), member: false };
}

const arrows: number[][] = [];
for (let v = 0.3; v <= 0.99; v += 0.025) {
  for (let u = 0.01; u <= 0.99; u += 0.02) {
    const p = canvasRay(u, v);
    const { v: w, member } = velocity(p);
    const s = Math.hypot(...w);
    const e = 0.01 / Math.max(s, 1e-9);
    const q: Vec3 = [p[0] + e * w[0], p[1] + e * w[1], p[2] + e * w[2]];
    const n = Math.hypot(...q);
    const uv = proj([q[0] / n, q[1] / n, q[2] / n]);
    if (!uv) continue;
    arrows.push([u, v, uv[0] - u, uv[1] - v, s * DEG, member ? 1 : 0]);
  }
}

/** Azimuth from −Z towards +X and elevation, degrees, of unit d. */
const azel = (d: Vec3): [number, number] => [
  Math.atan2(d[0], -d[2]) * DEG,
  Math.asin(Math.max(-1, Math.min(1, d[1]))) * DEG,
];
const fromAzel = (az: number, el: number): Vec3 => {
  const a = az / DEG;
  const e = el / DEG;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)];
};

const around: number[][] = [];
for (let el = -6; el <= 84; el += 4) {
  for (let az = -178; az <= 178; az += 4) {
    const d = fromAzel(az, el);
    const { v: w, member } = velocity(d);
    const s = Math.hypot(...w);
    const e = 0.01 / Math.max(s, 1e-9);
    const q: Vec3 = [d[0] + e * w[0], d[1] + e * w[1], d[2] + e * w[2]];
    const n = Math.hypot(...q);
    const [az2, el2] = azel([q[0] / n, q[1] / n, q[2] / n]);
    let daz = az2 - az;
    if (daz > 180) daz -= 360;
    if (daz < -180) daz += 360;
    around.push([az, el, daz, el2 - el, s * DEG, member ? 1 : 0]);
  }
}

/** Each kept wheel's members' rim, as canvas uv and as azimuth-elevation. */
function rim(axis: Vec3, angle: number): Vec3[] {
  const a: Vec3 = [axis[1], -axis[0], 0];
  const an = Math.hypot(...a);
  const t1: Vec3 = [a[0] / an, a[1] / an, a[2] / an];
  const t2 = cross(axis, t1);
  const pts: Vec3[] = [];
  for (let k = 0; k < 64; k++) {
    const th = (2 * Math.PI * k) / 64;
    pts.push(
      [0, 1, 2].map(
        (i) =>
          Math.cos(angle) * axis[i] +
          Math.sin(angle) * (Math.cos(th) * t1[i] + Math.sin(th) * t2[i]),
      ) as unknown as Vec3,
    );
  }
  return pts;
}
const wheels = SKY_RIVER_WHEELS.map((w) => {
  const pts = rim(w.axis, skyWheelEdge(w));
  return {
    note: w.note,
    rim: pts.map(proj).filter((p) => p !== null),
    rimAzel: pts.map(azel),
  };
});

const paths = SKY_RIVER_PATHS.map((p) => ({ note: p.note, uv: p.uv, azel: p.points.map(azel) }));
const frame: [number, number][] = [];
for (let k = 0; k <= 40; k++) frame.push(azel(canvasRay(k / 40, 0)));
for (let k = 0; k <= 40; k++) frame.push(azel(canvasRay(1, k / 40)));
for (let k = 40; k >= 0; k--) frame.push(azel(canvasRay(k / 40, 1)));
for (let k = 40; k >= 0; k--) frame.push(azel(canvasRay(0, k / 40)));

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ speed: SKY_RIVER_SPEED * DEG, arrows, around, wheels, paths, frame }),
);
console.log(`wrote ${out}: ${arrows.length} canvas arrows, ${around.length} dome arrows`);
