import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFingerprint, versionManifestPlugin } from '../scripts/build-version';
import { BUILD_ID_META } from '../src/update/build-id';
import { readRunningBuildId } from '../src/update/policy';

function withPublic(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gogh-version-'));
  try {
    mkdirSync(join(dir, 'fonts'));
    writeFileSync(join(dir, 'fonts', 'a.ttf'), 'font-a');
    run(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

describe('build fingerprint', () => {
  it('is order-independent and changes with the code, the package version and public assets', () => {
    withPublic((dir) => {
      const entries: Array<[string, string]> = [
        ['assets/index.js', 'one'],
        ['index.html', '<html>'],
      ];
      const first = buildFingerprint(entries, '0.1.0', dir);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(buildFingerprint([...entries].reverse(), '0.1.0', dir)).toBe(first);
      expect(
        buildFingerprint(
          [['assets/index.js', 'two'], entries[1] as [string, string]],
          '0.1.0',
          dir,
        ),
      ).not.toBe(first);
      expect(buildFingerprint(entries, '0.1.1', dir)).not.toBe(first);
      writeFileSync(join(dir, 'fonts', 'a.ttf'), 'font-b');
      expect(buildFingerprint(entries, '0.1.0', dir)).not.toBe(first);
    });
  });
});

interface Emitted {
  type: string;
  fileName: string;
  source: string;
}

describe('version manifest plugin', () => {
  it('stamps index.html and emits version.json with the same id, skipping sourcemaps', () => {
    withPublic((dir) => {
      const plugin = versionManifestPlugin('0.1.0', dir);
      expect(plugin.apply).toBe('build');
      const bundle: Record<string, { type: string; code?: string; source?: string }> = {
        'index.html': { type: 'asset', source: '<html><head><title>x</title></head></html>' },
        'assets/index.js': { type: 'chunk', code: 'console.log(1)' },
        'assets/index.js.map': { type: 'asset', source: '{}' },
      };
      const emitted: Emitted[] = [];
      // Ordered after Vite's own generateBundle rewrites, so it hashes the final chunk bytes.
      const hook = plugin.generateBundle as unknown as {
        order: string;
        handler: (
          this: { emitFile(file: Emitted): void },
          options: unknown,
          bundle: unknown,
        ) => void;
      };
      expect(hook.order).toBe('post');
      hook.handler.call({ emitFile: (file) => emitted.push(file) }, {}, bundle);
      const manifest = JSON.parse(emitted[0]?.source ?? '{}') as {
        buildId: string;
        version: string;
      };
      expect(emitted[0]?.fileName).toBe('version.json');
      expect(manifest.version).toBe('0.1.0');
      expect(manifest.buildId).toBe(
        buildFingerprint(
          [
            ['index.html', '<html><head><title>x</title></head></html>'],
            ['assets/index.js', 'console.log(1)'],
          ],
          '0.1.0',
          dir,
        ),
      );
      const doc = new DOMParser().parseFromString(
        String(bundle['index.html']?.source),
        'text/html',
      );
      expect(doc.querySelector(`meta[name="${BUILD_ID_META}"]`)).not.toBeNull();
      expect(readRunningBuildId(doc)).toBe(manifest.buildId);
    });
  });
});
