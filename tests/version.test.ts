import { expect, test } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { version } from '../src/version.ts';

test('version matches package.json', () => {
  expect(version).toBe(pkg.version);
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
});
