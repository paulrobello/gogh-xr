/**
 * The painter's-spot fidelity metric (P2.8): compares a painter-camera capture with the scan and
 * writes a side-by-side PNG (downsampled scan, downsampled capture, ΔE2000 heat map per block).
 *
 *   bun scripts/fidelity.ts <capture.png> [--out docs/shots/p2-fidelity.png]
 *   bun scripts/fidelity.ts --url <url> [--capture <out.png>] [--out <side-by-side.png>]
 *
 * With `--url` it first captures through scripts/capture-shot.ts at the canvas aspect. The url must
 * carry `diag`, `shot` and `painter`, for example
 * `http://localhost:PORT/?painting=starry-night&diag&shot&noanim&seed=1&painter`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { CAPTURE_SIZE, loadCapture, loadScanReference } from './fidelity-io.ts';
import {
  type BlockDelta,
  blockEdges,
  compareFidelity,
  DELTA_E_THRESHOLD,
  FIDELITY_HEIGHT,
  FIDELITY_WIDTH,
  GRID_COLS,
  GRID_ROWS,
  type RgbImage,
  SSIM_THRESHOLD,
  worstBlocks,
} from './fidelity-lib.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const url = option('url');
const out = option('out') ?? 'docs/shots/p2-fidelity.png';
let capturePath = option('capture') ?? args[0];

if (url) {
  const params = new URL(url).searchParams;
  for (const key of ['diag', 'shot', 'painter']) {
    if (!params.has(key)) throw new Error(`--url must carry ?${key}`);
  }
  capturePath ??= join(mkdtempSync(join(tmpdir(), 'gogh-fidelity-')), 'capture.png');
  const size = `${CAPTURE_SIZE.width}x${CAPTURE_SIZE.height}`;
  const shot = spawnSync(
    'bun',
    ['scripts/capture-shot.ts', url, capturePath, '--size', size, '--wait', 'world'],
    { stdio: 'inherit' },
  );
  if (shot.status !== 0) process.exit(shot.status ?? 1);
}
if (!capturePath) {
  console.error(
    'usage: bun scripts/fidelity.ts <capture.png> | --url <url> [--capture p] [--out p]',
  );
  process.exit(2);
}

const scan = await loadScanReference();
const capture = await loadCapture(capturePath);
const result = compareFidelity(scan, capture);

console.log(`fidelity: capture ${capturePath}`);
console.log(
  `fidelity: SSIM ${result.ssim.toFixed(4)} (Rec. 709 luma, ${FIDELITY_WIDTH} × ${FIDELITY_HEIGHT}), threshold ≥ ${SSIM_THRESHOLD}`,
);
console.log(
  `fidelity: mean ΔE2000 ${result.meanDeltaE.toFixed(4)} over ${GRID_COLS} × ${GRID_ROWS} blocks, threshold ≤ ${DELTA_E_THRESHOLD}`,
);
for (const block of worstBlocks(result.blocks, 5)) {
  console.log(
    `fidelity:   block col ${block.col} row ${block.row} (from the top-left) ΔE ${block.deltaE.toFixed(2)}`,
  );
}

/** Black at 0, red at 10, yellow at 20 and above. */
function heat(deltaE: number): [number, number, number] {
  const t = Math.min(1, deltaE / 20);
  return t < 0.5 ? [Math.round(510 * t), 0, 0] : [255, Math.round(510 * (t - 0.5)), 0];
}

function heatMap(blocks: readonly BlockDelta[], width: number, height: number): RgbImage {
  const xs = blockEdges(width, GRID_COLS);
  const ys = blockEdges(height, GRID_ROWS);
  const data = new Uint8Array(width * height * 3);
  for (const block of blocks) {
    const colour = heat(block.deltaE);
    for (let y = ys[block.row]; y < ys[block.row + 1]; y++) {
      for (let x = xs[block.col]; x < xs[block.col + 1]; x++) data.set(colour, (y * width + x) * 3);
    }
  }
  return { width, height, data };
}

/** Each panel at 2× with nearest-neighbour, 8 px apart on a dark grey ground. */
const SCALE = 2;
const GAP = 8;
const panels = [scan, capture, heatMap(result.blocks, scan.width, scan.height)];
const pw = scan.width * SCALE;
const ph = scan.height * SCALE;
const composites = await Promise.all(
  panels.map(async (panel, i) => ({
    input: await sharp(Buffer.from(panel.data), {
      raw: { width: panel.width, height: panel.height, channels: 3 },
    })
      .resize(pw, ph, { kernel: 'nearest' })
      .png()
      .toBuffer(),
    left: i * (pw + GAP),
    top: 0,
  })),
);
await sharp({
  create: {
    width: 3 * pw + 2 * GAP,
    height: ph,
    channels: 3,
    background: { r: 32, g: 32, b: 32 },
  },
})
  .composite(composites)
  .png({ compressionLevel: 9 })
  .toFile(out);
console.log(
  `fidelity: wrote ${out} (scan | capture | ΔE heat map, black 0, red 10, yellow 20 and above)`,
);
