/**
 * Patches a copy of the source tree for the building z-fight probes (`scripts/zfight-density-probe.ts`,
 * docs/verification.md, residuals re-measured). Never run it on the working checkout.
 *
 * - Always: the stroke batch is exposed as `globalThis.__zfightBatch`, so a probe can set band
 *   densities.
 * - With `id`: every scattered stroke is coloured by its class and index instead of its paint. R is
 *   12 + 28 × class (ground 0, wall 1, roof 2, church 3, window 4, outline 5, cypress 6, sky 7), G and
 *   B a per-stroke hash, and the fragment shader drops tone and shade. A pixel's id then names the
 *   stroke that won it. Only the scatter's surface and outline strokes get ids. The moon and star
 *   strokes (sky lights), the boundary haze and the star and moon halos keep their paint colours,
 *   and the eave underside copies take their roof stroke's id scaled by the eave shade. Such a
 *   pixel can alias into a class whose R it lands within 3 of, so the class split is approximate
 *   for them. The magenta base test does not depend on R.
 *
 * It refuses a tree that holds `.git` (a checkout or worktree), so it can only patch an extract.
 *
 *   git archive --format=tar -o /tmp/zf.tar HEAD && mkdir /tmp/zf && tar -xf /tmp/zf.tar -C /tmp/zf
 *   ln -s "$PWD/node_modules" /tmp/zf/node_modules
 *   bun scripts/zfight-id-patch.ts /tmp/zf [id]
 *   (cd /tmp/zf && bunx vite build --outDir /tmp/zf-dist && bunx vite preview --outDir /tmp/zf-dist --port 4346)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, mode] = process.argv.slice(2);
if (!root) {
  console.error('usage: bun scripts/zfight-id-patch.ts <tree-root> [id]');
  process.exit(2);
}
if (existsSync(join(root, '.git'))) {
  console.error(`refusing ${root}: it is a git checkout. Patch a git archive extract instead.`);
  process.exit(2);
}

function patch(file: string, pairs: readonly (readonly [string, string])[]): void {
  const path = join(root as string, file);
  let text = readFileSync(path, 'utf8');
  for (const [from, to] of pairs) {
    if (text.split(from).length !== 2) throw new Error(`${file}: expected one ${from}`);
    text = text.replace(from, to);
  }
  writeFileSync(path, text);
}

patch('src/render/strokes/batch.ts', [
  [
    '\n  return batch;\n',
    '\n  (globalThis as unknown as { __zfightBatch?: StrokeBatch }).__zfightBatch = batch;\n  return batch;\n',
  ],
]);

if (mode === 'id') {
  patch('src/render/strokes/scatter.ts', [
    [
      'color: [rgb[0] / shade, rgb[1] / shade, rgb[2] / shade, alpha],',
      'color: [...zfightId(ZFIGHT_CLASS[layer] ?? 8, index).slice(0, 3), alpha] as [number, number, number, number],',
    ],
    ['color: [rgb[0], rgb[1], rgb[2], 255],', 'color: zfightId(5, index),'],
  ]);
  const path = join(root, 'src/render/strokes/scatter.ts');
  writeFileSync(
    path,
    `${readFileSync(path, 'utf8')}
const ZFIGHT_CLASS: Record<string, number> = {
  terrain: 0, building: 1, roof: 2, church: 3, window: 4, cypress: 6, sky: 7,
};
function zfightId(cls: number, i: number): [number, number, number, number] {
  const h = Math.imul(i + 1, 0x9e3779b1) >>> 0;
  return [12 + 28 * cls, (h >>> 24) & 255, (h >>> 16) & 255, 255];
}
`,
  );
  patch('src/render/strokes/stroke.frag.glsl', [
    [
      '  fragColor = vec4(vColor * tone * shade, alpha);',
      '  fragColor = vec4(vColor + 0.0 * vColor * tone * shade, alpha);',
    ],
  ]);
}
console.log(`patched ${root}${mode === 'id' ? ' (id)' : ''}`);
