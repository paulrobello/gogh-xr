/**
 * The positional cues' anchors (P6.5) against the Starry Night generators: the steeple and cypress
 * anchors are seed 1's own output, other seeds keep the bell within a few metres of their steeple,
 * and every cricket stands on open grass inside the world.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  CUE_IDS,
  cueUrl,
  parseManifest,
  pickFormat,
  SCORE_IDS,
  scoreFor,
} from '../src/audio/cues.ts';
import {
  ambienceFor,
  BELL_BELOW_TIP,
  bellPosition,
  CRICKET_HEIGHT,
  CRICKET_XZ,
  CYPRESS_BASE,
  CYPRESS_TIP,
  STEEPLE_TIP,
  windPosition,
} from '../src/audio/placement.ts';
import { createFootprintTest } from '../src/paintings/starry-night/footprints.ts';
import { boundaryFactor } from '../src/world/boundary.ts';
import { createCypress } from '../src/world/cypress.ts';
import { createTerrain } from '../src/world/terrain.ts';
import { createVillage } from '../src/world/village.ts';

const close = (a: readonly number[], b: readonly number[], tol: number): void => {
  expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(tol);
};

describe('Starry Night anchors', () => {
  const terrain = createTerrain(1);
  const village = createVillage(1, terrain);
  const cypress = createCypress(1, terrain);

  test('the steeple and cypress anchors are the seed-1 generator output', () => {
    close(STEEPLE_TIP, village.church.steepleTip, 0.01);
    close(CYPRESS_BASE, cypress.main.base, 0.01);
    close(CYPRESS_TIP, cypress.main.tip, 0.01);
  });

  test('the bell hangs in the tower under the spire tip, the wind halfway up the cypress', () => {
    const bell = bellPosition();
    expect(bell).toEqual([STEEPLE_TIP[0], STEEPLE_TIP[1] - BELL_BELOW_TIP, STEEPLE_TIP[2]]);
    expect(bell[1]).toBeGreaterThan(village.church.center[1]);
    const wind = windPosition();
    expect(wind[1]).toBeGreaterThan(cypress.main.base[1]);
    expect(wind[1]).toBeLessThan(cypress.main.tip[1]);
    // On the axis between the base and the tip.
    const mid = cypress.main.base.map((b, i) => (b + cypress.main.tip[i]) / 2);
    close(wind, mid, 0.05);
  });

  test.each([2, 3, 7])('seed %i keeps the bell within 2.5 m of its steeple', (seed) => {
    const t = createTerrain(seed);
    const tip = createVillage(seed, t).church.steepleTip;
    close(STEEPLE_TIP, tip, 2.5);
    const c = createCypress(seed, t);
    expect(
      Math.hypot(c.main.base[0] - CYPRESS_BASE[0], c.main.base[2] - CYPRESS_BASE[2]),
    ).toBeLessThan(0.5);
  });

  test('every cricket is on open grass inside the world, on the ground', () => {
    const blocked = createFootprintTest(village, 2);
    const ambience = ambienceFor('starry-night', terrain);
    expect(ambience).not.toBeNull();
    const crickets = ambience?.beds.filter((b) => b.cue === 'crickets') ?? [];
    expect(crickets).toHaveLength(CRICKET_XZ.length);
    for (const {
      position: [x, y, z],
    } of crickets) {
      expect(blocked(x, z)).toBe(false);
      expect(boundaryFactor([x, y, z])).toBe(0);
      expect(y).toBeCloseTo(terrain.heightAt(x, z) + CRICKET_HEIGHT, 6);
      // Clear of the cypress.
      expect(Math.hypot(x - CYPRESS_BASE[0], z - CYPRESS_BASE[2])).toBeGreaterThan(3);
    }
    expect(ambience?.beds.filter((b) => b.cue === 'wind-hill')).toHaveLength(1);
    expect(ambience?.bell).toEqual(bellPosition());
  });

  test('the gallery and the bare scene have no positional ambience', () => {
    expect(ambienceFor('gallery', terrain)).toBeNull();
    expect(ambienceFor(null, terrain)).toBeNull();
  });
});

describe('cues', () => {
  test('each world plays its score', () => {
    expect(scoreFor('gallery')).toBe('score-gallery');
    expect(scoreFor('starry-night')).toBe('score-night');
    expect(scoreFor(null)).toBeNull();
    expect(scoreFor('cafe-terrace')).toBeNull();
  });

  test('ogg where Opus plays, else mp3, each falling back to the other file', () => {
    expect(pickFormat((m) => (m.includes('opus') ? 'probably' : ''))).toBe('ogg');
    expect(pickFormat(() => '')).toBe('mp3');
    const parsed = parseManifest({
      version: 1,
      cues: [{ id: 'crickets', kind: 'sfx', loop: true, files: { mp3: 'c.mp3' } }],
    });
    const c = parsed?.cues[0];
    if (!c) throw new Error('no cue');
    // Relative to the manifest's own directory, under Vite's base.
    expect(cueUrl(c, 'ogg', '/base/')).toBe('/base/audio/c.mp3');
    expect(cueUrl(c, 'mp3', '/')).toBe('/audio/c.mp3');
  });

  test("P6.4's manifest, verbatim, parses to all seven cues the mixer plays", () => {
    const raw: unknown = JSON.parse(
      readFileSync(resolve(import.meta.dirname, 'fixtures/audio-manifest.json'), 'utf8'),
    );
    const m = parseManifest(raw);
    expect(m).not.toBeNull();
    expect(m?.cues.map((c) => c.id).sort()).toEqual([...CUE_IDS].sort());
    const night = m?.cues.find((c) => c.id === 'score-night');
    expect(night).toEqual({
      id: 'score-night',
      kind: 'music',
      loop: true,
      channels: 2,
      duration: 141,
      files: { ogg: 'score-night.ogg', mp3: 'score-night.mp3' },
    });
    for (const cue of m?.cues ?? []) {
      expect(cue.kind).toBe(SCORE_IDS.includes(cue.id as never) ? 'music' : 'sfx');
      expect(cueUrl(cue, 'ogg', '/')).toBe(`/audio/${cue.id}.ogg`);
      expect(cueUrl(cue, 'mp3', '/')).toBe(`/audio/${cue.id}.mp3`);
    }
    expect(m?.cues.find((c) => c.id === 'stroke-rustle')?.loop).toBe(false);
  });

  test('a malformed or unknown manifest is null; bad entries drop alone', () => {
    for (const bad of [null, {}, 'x', [], { cues: [] }, { version: 2, cues: [] }, { version: 1 }]) {
      expect(parseManifest(bad)).toBeNull();
    }
    const m = parseManifest({
      version: 1,
      cues: [
        { id: 'score-night', kind: 'music', loop: true, duration: 141, files: { ogg: 'n.ogg' } },
        { id: 'score-night', kind: 'music', files: { ogg: 'again.ogg' } },
        { id: 'unknown', kind: 'sfx', files: { ogg: 'a.ogg' } },
        { id: 'crickets', kind: 'sfx', files: {} },
        { id: 'wind-hill', kind: 'music', files: { ogg: 'w.ogg' } },
        { id: 'portal-whoosh', kind: 'sfx', files: { ogg: '../escape.ogg', mp3: '/abs.mp3' } },
        { id: 'stroke-rustle', kind: 'sfx', files: { ogg: 'https://x.test/r.ogg' } },
        { id: 'church-bell', kind: 'sfx', files: { ogg: 'b.ogg' }, duration: 'long', channels: -1 },
        7,
      ],
    });
    expect(m?.cues.map((c) => c.id)).toEqual(['score-night', 'church-bell']);
    expect(m?.cues[0].files).toEqual({ ogg: 'n.ogg' });
    expect(m?.cues[1]).toMatchObject({ duration: null, channels: null, loop: false });
  });
});
