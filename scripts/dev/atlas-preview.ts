/**
 * Dev preview of the brush atlas: prints generation time and per-brush coverage, then writes
 * coverage, height, tone and a lit composite as PNGs (default /tmp/gogh-atlas-*.png).
 *
 *   bun scripts/dev/atlas-preview.ts [seed] [outDir]
 */
import sharp from 'sharp';
import {
  ATLAS_CELL_SIZE,
  ATLAS_GRID,
  ATLAS_SIZE,
  BRUSH_CHANNEL,
  BRUSH_COUNT,
  BRUSHES,
  DEFAULT_BRUSH_SEED,
  generateBrushAtlas,
} from '../../src/render/strokes/brush-atlas-data.ts';

const seed = Number(process.argv[2] ?? DEFAULT_BRUSH_SEED);
const outDir = process.argv[3] ?? '/tmp';

generateBrushAtlas(seed);
const started = performance.now();
const data = generateBrushAtlas(seed);
const elapsed = performance.now() - started;
console.log(
  `generateBrushAtlas(${seed}): ${elapsed.toFixed(1)} ms (warm, ${process.versions.bun ? 'bun' : 'node'})`,
);

const n = ATLAS_SIZE * ATLAS_SIZE;
for (let i = 0; i < BRUSH_COUNT; i++) {
  const cx = (i % ATLAS_GRID) * ATLAS_CELL_SIZE;
  const cy = Math.floor(i / ATLAS_GRID) * ATLAS_CELL_SIZE;
  let sum = 0;
  let nonZero = 0;
  let band = 0;
  for (let y = cy; y < cy + ATLAS_CELL_SIZE; y++) {
    for (let x = cx; x < cx + ATLAS_CELL_SIZE; x++) {
      const c = (data[(y * ATLAS_SIZE + x) * 4 + BRUSH_CHANNEL.coverage] ?? 0) / 255;
      sum += c;
      if (c > 0) nonZero++;
      if (c >= 0.1 && c <= 0.9) band++;
    }
  }
  const mean = sum / (ATLAS_CELL_SIZE * ATLAS_CELL_SIZE);
  const brush = BRUSHES[i];
  console.log(
    `${String(i).padStart(2)} ${brush?.kind.padEnd(8)} v${brush?.variant} coverage ${mean.toFixed(3)} band ${((100 * band) / nonZero).toFixed(1)}%`,
  );
}

function channel(index: number): Buffer {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = data[i * 4 + index] ?? 0;
  return out;
}

/** Sky-blue paint, tone multiplied in, lit from the upper left by the height gradient. */
function lit(): Buffer {
  const out = Buffer.alloc(n * 3);
  const h = (x: number, y: number): number =>
    (data[
      (Math.min(ATLAS_SIZE - 1, Math.max(0, y)) * ATLAS_SIZE +
        Math.min(ATLAS_SIZE - 1, Math.max(0, x))) *
        4 +
        BRUSH_CHANNEL.height
    ] ?? 0) / 255;
  const light = [-0.5, 0.5, 0.7];
  const len = Math.hypot(light[0] ?? 0, light[1] ?? 0, light[2] ?? 0);
  for (let y = 0; y < ATLAS_SIZE; y++) {
    for (let x = 0; x < ATLAS_SIZE; x++) {
      const i = y * ATLAS_SIZE + x;
      const c = (data[i * 4 + BRUSH_CHANNEL.coverage] ?? 0) / 255;
      const tone = (data[i * 4 + BRUSH_CHANNEL.tone] ?? 0) / 255;
      const dx = (h(x + 1, y) - h(x - 1, y)) * 6;
      const dy = (h(x, y + 1) - h(x, y - 1)) * 6;
      const nz = 1 / Math.hypot(dx, dy, 1);
      const lambert =
        Math.max(0, (-dx * (light[0] ?? 0) - dy * (light[1] ?? 0) + (light[2] ?? 0)) * nz) / len;
      const shade = (0.35 + 0.75 * lambert) * (0.6 + 0.8 * tone);
      const base = [0.3, 0.5, 0.85];
      const bg = 0.08;
      for (let k = 0; k < 3; k++) {
        const v = bg * (1 - c) + c * Math.min(1, (base[k] ?? 0) * shade);
        out[i * 3 + k] = Math.round(v * 255);
      }
    }
  }
  return out;
}

// Data row 0 is v = 0 (bottom in GL), so flip for a v-up view.
async function write(name: string, pixels: Buffer, channels: 1 | 3, scale: number): Promise<void> {
  const file = `${outDir}/gogh-atlas-${name}.png`;
  await sharp(pixels, { raw: { width: ATLAS_SIZE, height: ATLAS_SIZE, channels } })
    .flip()
    .resize(ATLAS_SIZE / scale)
    .png()
    .toFile(file);
  console.log(`wrote ${file}`);
}

await write('coverage', channel(BRUSH_CHANNEL.coverage), 1, 2);
await write('height', channel(BRUSH_CHANNEL.height), 1, 2);
await write('tone', channel(BRUSH_CHANNEL.tone), 1, 2);
await write('lit', lit(), 3, 2);
await write('lit-full', lit(), 3, 1);
