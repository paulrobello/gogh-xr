/**
 * Times the café build's slicer steps without a renderer, to keep any one step short.
 *
 *   bun scripts/cafe/time-build.ts
 *
 * Prints the step count, the total, and the longest steps with their position in the build.
 */
import sharp from 'sharp';
import type { Texture } from 'three';
import { buildCafeScene } from '../../src/paintings/cafe-terrace-at-night/scene.ts';

const { data, info } = await sharp('public/paintings/cafe-terrace-at-night/frame.webp')
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const scan = { image: { width: 1280, height: 1596 } } as unknown as Texture;
const steps = buildCafeScene(1, scan, { width: info.width, height: info.height, data });
const times: number[] = [];
let result = steps.next();
for (;;) {
  const start = performance.now();
  result = steps.next();
  times.push(performance.now() - start);
  if (result.done) break;
}
const total = times.reduce((sum, ms) => sum + ms, 0);
const worst = times
  .map((ms, index) => ({ ms, index }))
  .sort((a, b) => b.ms - a.ms)
  .slice(0, 8);
console.log(`cafe-build: ${times.length} steps, ${total.toFixed(0)} ms in all`);
for (const { ms, index } of worst) {
  console.log(`  step ${index} of ${times.length}: ${ms.toFixed(1)} ms`);
}
if (result.done) console.log(`cafe-build: counts ${JSON.stringify(result.value.counts)}`);
