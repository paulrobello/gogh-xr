/**
 * Times the sky river bake over N random sky directions with random axes (default 300,000), in
 * blocks of `slice` strokes (default 256, the RIVER_SLICE of skyRiverInstancesSteps), and the
 * field build step by step (buildSkyRiverFieldSteps), printing the total and the longest step:
 *   bun scripts/sky-river/time-bake.ts [N] [slice]
 */
import { buildFlowField } from '../../src/demo/canvas/field';
import {
  buildSkyRiverFieldSteps,
  type SkyRiverField,
  skyRiverBake,
} from '../../src/motion/sky-river';
import { decode } from '../scatter-time';

const n = Number(process.argv[2] ?? 300_000);
const slice = Number(process.argv[3] ?? 256);
const flow = buildFlowField(await decode('flow.png'));
const steps = buildSkyRiverFieldSteps(flow);
const t0 = performance.now();
let fieldSteps = 0;
let fieldLongest = 0;
let field: SkyRiverField | undefined;
for (;;) {
  const s0 = performance.now();
  const r = steps.next();
  fieldLongest = Math.max(fieldLongest, performance.now() - s0);
  fieldSteps++;
  if (r.done) {
    field = r.value;
    break;
  }
}
const t1 = performance.now();
if (field === undefined) throw new Error('the field build returned nothing');
let seed = 1;
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
let sum = 0;
const blocks: number[] = [];
const t2 = performance.now();
for (let i = 0; i < n; i += slice) {
  const s0 = performance.now();
  for (let j = i; j < Math.min(n, i + slice); j++) {
    const y = rand() * 0.9 + 0.05;
    const a = rand() * 2 * Math.PI;
    const r = Math.sqrt(1 - y * y);
    const b = skyRiverBake(
      field,
      [r * Math.sin(a), y, -r * Math.cos(a)],
      [rand() - 0.5, rand() - 0.5, rand() - 0.5],
    );
    sum += b.amplitude;
  }
  blocks.push(performance.now() - s0);
}
const t3 = performance.now();
blocks.sort((a, b) => a - b);
const q = (f: number): string => blocks[Math.floor(f * (blocks.length - 1))].toFixed(2);
console.log(
  `field ${(t1 - t0).toFixed(0)} ms in ${fieldSteps} steps (longest ${fieldLongest.toFixed(2)} ms)`,
);
console.log(
  `bake ${n} in ${(t3 - t2).toFixed(0)} ms (${((1000 * (t3 - t2)) / n).toFixed(2)} us each), ` +
    `${blocks.length} steps of ${slice}: median ${q(0.5)} ms, p99 ${q(0.99)} ms, longest ${q(1)} ms, ` +
    `mean amp ${(sum / n).toFixed(3)}`,
);
