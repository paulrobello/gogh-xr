/**
 * Scores a café painter-view capture against the scan.
 *
 *   bun scripts/cafe/fidelity.ts <capture.png>
 *
 * Capture at the scan's aspect, for example:
 *   bun scripts/capture-shot.ts "<url>/?painting=cafe-terrace-at-night&painter&diag&shot&noanim&nogov" \
 *     out.png --size 642x800 --wait world
 */
import { worstBlocks } from '../fidelity-lib.ts';
import { CAFE_DELTA_E_THRESHOLD, CAFE_SSIM_THRESHOLD, cafeFidelity } from './fidelity-lib.ts';

const capture = process.argv[2];
if (!capture) {
  console.error('usage: bun scripts/cafe/fidelity.ts <capture.png>');
  process.exit(2);
}
const result = await cafeFidelity(capture);
const worst = worstBlocks(result.blocks, 3)
  .map(({ col, row, deltaE }) => `(${col}, ${row}) ${deltaE.toFixed(2)}`)
  .join(' ');
console.log(
  `cafe-fidelity: SSIM ${result.ssim.toFixed(4)} (≥ ${CAFE_SSIM_THRESHOLD}), mean ΔE2000 ${result.meanDeltaE.toFixed(3)} (≤ ${CAFE_DELTA_E_THRESHOLD}), worst blocks ${worst}`,
);
process.exit(
  result.ssim >= CAFE_SSIM_THRESHOLD && result.meanDeltaE <= CAFE_DELTA_E_THRESHOLD ? 0 : 1,
);
