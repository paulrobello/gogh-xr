import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkAssets } from './asset-lib.ts';

const root = process.env.ASSET_ROOT ?? resolve(import.meta.dirname, '..');
const markdown = readFileSync(resolve(root, 'assets/PROVENANCE.md'), 'utf8');
const { failures, checked } = checkAssets(root, markdown);

if (failures.length > 0) {
  for (const failure of failures) console.error(`asset-check: FAIL ${failure}`);
  process.exit(1);
}
console.log(`asset-check: ${checked} files verified`);
