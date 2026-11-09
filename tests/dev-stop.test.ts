import { expect, test } from 'vitest';
import { isViteCommand } from '../scripts/dev-stop.ts';

test('dev-stop recognises the vite dev server however it was started', () => {
  expect(isViteCommand('node /repo/node_modules/.bin/vite')).toBe(true);
  expect(isViteCommand('bun --bun /repo/node_modules/.bin/vite --host')).toBe(true);
  expect(isViteCommand('node /repo/node_modules/vite/bin/vite.js')).toBe(true);
  expect(isViteCommand('vite')).toBe(true);
});

test('dev-stop refuses a listener that is not vite', () => {
  expect(isViteCommand('')).toBe(false);
  expect(isViteCommand('python3 -m http.server 4252')).toBe(false);
  expect(isViteCommand('/usr/bin/ssh -L 4252:localhost:4252 host')).toBe(false);
  expect(isViteCommand('node /repo/node_modules/.bin/vitest')).toBe(false);
});
