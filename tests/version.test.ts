import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { buildDiagPayload } from '../src/diag/diag.ts';
import { version } from '../src/version.ts';
import { createXrState } from '../src/xr/session.ts';

test('version is a semver string read from package.json and reported as the diag build', () => {
  const raw = readFileSync(resolve('package.json'), 'utf8');
  const onDisk = (JSON.parse(raw) as { version: string }).version;
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(version).toBe(onDisk);
  const payload = buildDiagPayload({
    build: version,
    renderer: {
      info: {
        render: { calls: 0, triangles: 0, points: 0, lines: 0, frame: 0 },
        memory: { geometries: 0, textures: 0 },
      },
      getContext: () => ({ getExtension: () => null, getParameter: () => null }),
      xr: { isPresenting: false },
    },
    camera: { position: { toArray: () => [0, 0, 0] }, quaternion: { toArray: () => [0, 0, 0, 1] } },
    getXrState: createXrState,
  });
  expect(payload.build).toBe(onDisk);
});
