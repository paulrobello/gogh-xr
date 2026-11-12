/**
 * Regenerates BRUSH_MASK_DATA in src/render/strokes/brush-masks.ts from the default-seed atlas.
 * Run after any change to the brush generator: `bun scripts/brush-masks.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_BRUSH_SEED, generateBrushAtlas } from '../src/render/strokes/brush-atlas-data.ts';
import { buildBrushMasks, encodeBrushMasks } from '../src/render/strokes/brush-masks.ts';

const path = new URL('../src/render/strokes/brush-masks.ts', import.meta.url);
const data = encodeBrushMasks(buildBrushMasks(generateBrushAtlas(DEFAULT_BRUSH_SEED)));
const source = readFileSync(path, 'utf8');
const next = source.replace(
  /export const BRUSH_MASK_DATA =\n\s*'[^']*';/,
  `export const BRUSH_MASK_DATA =\n  '${data}';`,
);
if (next === source && !source.includes(data)) throw new Error('BRUSH_MASK_DATA not found');
writeFileSync(path, next);
console.log(`BRUSH_MASK_DATA: ${data.length} characters`);
