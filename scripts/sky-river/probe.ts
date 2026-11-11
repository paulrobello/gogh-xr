/**
 * Prints the sky river's guide and bake at canvas uv points given on the command line:
 *   bun scripts/sky-river/probe.ts 0.54,0.44 0.6,0.4
 */
import { buildFlowField } from '../../src/demo/canvas/field';
import {
  buildSkyRiverField,
  SKY_RIVER_PATHS,
  skyRiverBake,
  skyRiverGuide,
  skyRiverNearest,
} from '../../src/motion/sky-river';
import {
  canvasRay,
  PAINTER_EYE,
  projectToCanvas,
} from '../../src/paintings/starry-night/canvas-camera';
import { decode } from '../scatter-time';

const field = buildSkyRiverField(buildFlowField(await decode('flow.png')));
const uvOf = (d: readonly number[]) =>
  projectToCanvas([PAINTER_EYE[0] + d[0], PAINTER_EYE[1] + d[1], PAINTER_EYE[2] + d[2]]).uv;
const screen = (d: readonly number[], v: readonly number[]): string => {
  const a = uvOf(d);
  const b = uvOf([d[0] + 1e-3 * v[0], d[1] + 1e-3 * v[1], d[2] + 1e-3 * v[2]]);
  if (!a || !b) return 'n/a';
  return `${((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI).toFixed(0)}°`;
};
for (const arg of process.argv.slice(2)) {
  const [u, v] = arg.split(',').map(Number);
  const d = canvasRay(u, v);
  const g = skyRiverGuide(d);
  const b = skyRiverBake(field, d);
  const vel = [
    b.omega[1] * d[2] - b.omega[2] * d[1],
    b.omega[2] * d[0] - b.omega[0] * d[2],
    b.omega[0] * d[1] - b.omega[1] * d[0],
  ];
  console.log(
    `uv ${u},${v}: guide ${screen(d, g.heading)} agree ${g.agreement.toFixed(2)}; motion ${screen(d, vel)} amp ${b.amplitude.toFixed(2)} sign ${b.sign} coh ${b.coherence.toFixed(2)} kappa ${b.curvature.toFixed(1)}`,
  );
  for (const p of SKY_RIVER_PATHS) {
    const n = skyRiverNearest(p, d);
    console.log(
      `  ${p.note.slice(0, 2)} ${((n.distance * 180) / Math.PI).toFixed(1)}° ${screen(d, n.tangent)}`,
    );
  }
}
